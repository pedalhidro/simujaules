#!/usr/bin/env bash
# startup-script.sh — roda na VM a CADA boot (injetada via metadata pelo
# bake-instance.sh). É idempotente: numa VM já preparada ela só (re)garante o
# systemd unit + timer e segue. Não cria nada cobrado por si só — o custo é a VM
# estar LIGADA.
#
# O que faz:
#   1. Instala dependências de build + Rust (ou baixa um binário pré-compilado
#      se a metadata `backend-binary-url` estiver setada).
#   2. Compila/instala o backend simujoules em /opt/simujoules/simujoules-backend.
#   3. Escreve o systemd unit `simujoules-backend.service` (backend em
#      0.0.0.0:VM_PORT com --max-mem-gb dimensionado pra c4-standard-96).
#   4. Instala o idle-watchdog como timer systemd
#      (`simujoules-watchdog.timer`, dispara a cada 1 min).
#   5. Habilita + inicia serviço e timer.

set -euo pipefail
exec > >(tee -a /var/log/simujoules-startup.log) 2>&1
echo "== simujoules startup-script :: $(date -u +%FT%TZ) =="

# --- Metadata da instância ---------------------------------------------------
# A porta e a URL opcional do binário vêm do --metadata do bake-instance.sh.
META_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
metadata() {
  curl -fsS -H "Metadata-Flavor: Google" "${META_URL}/$1" 2>/dev/null || true
}
VM_PORT="$(metadata vm-port)"; VM_PORT="${VM_PORT:-8077}"
BACKEND_BINARY_URL="$(metadata backend-binary-url)"
MAX_MEM_GB_META="$(metadata max-mem-gb)"

# Configuração do watchdog (default: desliga após 15 min ociosa).
IDLE_MAX_S="${IDLE_MAX_S:-900}"

INSTALL_DIR="/opt/simujoules"
BIN_PATH="${INSTALL_DIR}/simujoules-backend"
SRC_DIR="${INSTALL_DIR}/src"
mkdir -p "$INSTALL_DIR"

# --- 1) Dependências ---------------------------------------------------------
echo "-- instalando dependências de sistema --"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates git build-essential pkg-config python3

# --- 2) Obter o binário ------------------------------------------------------
if [[ -n "$BACKEND_BINARY_URL" ]]; then
  # Caminho rápido: binário pré-compilado (evita instalar a toolchain Rust).
  echo "-- baixando binário pré-compilado de: $BACKEND_BINARY_URL --"
  curl -fSL "$BACKEND_BINARY_URL" -o "$BIN_PATH"
  chmod +x "$BIN_PATH"
elif [[ -x "$BIN_PATH" ]]; then
  # Cache do disco de boot: o binário persiste entre stop/start, então só o
  # PRIMEIRO boot compila. Sem este atalho, cada start recompilaria (~10 min) e
  # estouraria o HEALTH_WAIT_S do orquestrador a CADA run — a nuvem nunca subiria.
  echo "-- binário já compilado ($BIN_PATH) — pulando clone+build --"
else
  # Caminho do build: instala Rust e compila o backend a partir do fonte.
  # O fonte é clonado do repo público; ajuste SIMU_REPO/SIMU_REF se precisar.
  SIMU_REPO="${SIMU_REPO:-https://github.com/pedalhidro/simujaules.git}"
  SIMU_REF="${SIMU_REF:-main}"
  # Instala o Rust LIMPO. Um rustup-init interrompido de um build anterior deixa
  # o proxy `cargo` em /root/.cargo/bin SEM toolchain default — aí um guard tipo
  # `command -v cargo` pula a instalação e o build morre com "could not choose a
  # version of cargo ... no default is configured" (ou, ao reinstalar por cima,
  # "detected conflict: bin/cargo"). Como o branch de build só roda UMA vez (depois
  # o binário fica em cache no disco via o elif lá em cima), apagar e reinstalar do
  # zero é barato e à prova de corrupção. --default-toolchain stable garante um
  # toolchain instalado E setado como default.
  echo "-- instalando Rust (rustup, limpo) --"
  rm -rf /root/.rustup /root/.cargo
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
  export PATH="/root/.cargo/bin:${PATH}"

  echo "-- clonando fonte ($SIMU_REPO @ $SIMU_REF) --"
  rm -rf "$SRC_DIR"
  git clone --depth 1 --branch "$SIMU_REF" "$SIMU_REPO" "$SRC_DIR"

  echo "-- compilando (cargo build --release) --"
  ( cd "${SRC_DIR}/backend" && cargo build --release )
  cp "${SRC_DIR}/backend/target/release/simujoules-backend" "$BIN_PATH"
  chmod +x "$BIN_PATH"
fi

# --- 3) Dimensionar --max-mem-gb e escrever o systemd unit -------------------
# Matemática do orçamento de memória (round mode é o pior caso):
#   per_slice = 2·Scratch + Acc + include = 2·(17·N) + 20·N + 1·N = 55·N bytes,
#   onde N = nº de células do DEM (ver density_mem_budget_bytes / compute_density
#   em backend/src/main.rs). O nº de slices concorrentes é
#     n_slices = min(refs, cores, orçamento / per_slice).
#   density_mem_budget_bytes() usa orçamento_efetivo = max_mem_gb · 1e9 · 0.8.
#
#   A c4-standard-96 tem 96 vCPUs e ~360 GB de RAM. Pra dar cores-many (96)
#   slices num DEM grande sem OOM, reservamos ~40 GB pro corpo da requisição +
#   cópias do DEM + buffers de saída e damos o resto ao orçamento:
#     --max-mem-gb 320  →  orçamento_efetivo = 320·0.8e9 = 256e9 bytes.
#   Aí cabem 96 slices enquanto  N ≤ 256e9 / (55·96) ≈ 48,5 M células
#   (~7000×7000) — confortável pros DEMs do app. DEMs maiores rodam menos
#   slices (mais refs em série por slice): a saída é a MESMA, só o tempo cresce.
# Precedência: metadata `max-mem-gb` (do bake-instance.sh) > default 320. Não há
# MAX_MEM_GB no ambiente da VM; o valor chega só via metadata.
MAX_MEM_GB="${MAX_MEM_GB_META:-320}"

echo "-- escrevendo systemd unit simujoules-backend.service (porta $VM_PORT, --max-mem-gb $MAX_MEM_GB) --"
cat > /etc/systemd/system/simujoules-backend.service <<UNIT
[Unit]
Description=Simujoules native compute backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Bind em 0.0.0.0 pro orquestrador alcançar de fora (cloudflared NÃO é usado).
# O firewall (apertado pelo orquestrador) é a barreira de acesso.
ExecStart=${BIN_PATH} 0.0.0.0:${VM_PORT} --max-mem-gb ${MAX_MEM_GB}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

# --- 4) Idle-watchdog como timer systemd ------------------------------------
# Copia o idle-watchdog.sh pro disco da VM. Numa VM provisionada pelo
# bake-instance, o script foi clonado junto com o fonte; senão, este é
# escrito inline a partir do que existir no INSTALL_DIR.
WATCHDOG_SRC=""
if [[ -f "${SRC_DIR}/vm/idle-watchdog.sh" ]]; then
  WATCHDOG_SRC="${SRC_DIR}/vm/idle-watchdog.sh"
fi
WATCHDOG_PATH="${INSTALL_DIR}/idle-watchdog.sh"
if [[ -n "$WATCHDOG_SRC" ]]; then
  cp "$WATCHDOG_SRC" "$WATCHDOG_PATH"
else
  echo "AVISO: idle-watchdog.sh não encontrado no fonte; o watchdog não será instalado." >&2
fi

if [[ -f "$WATCHDOG_PATH" ]]; then
  chmod +x "$WATCHDOG_PATH"
  echo "-- escrevendo simujoules-watchdog.service + .timer (a cada 1 min) --"
  cat > /etc/systemd/system/simujoules-watchdog.service <<UNIT
[Unit]
Description=Simujoules idle watchdog (desliga a VM se ociosa demais)

[Service]
Type=oneshot
# VM_PORT e IDLE_MAX_S vêm do ambiente; o watchdog desliga via shutdown -h now
# (com instance-termination-action=STOP, isso PARA a instância — backstop de custo).
Environment=VM_PORT=${VM_PORT}
Environment=IDLE_MAX_S=${IDLE_MAX_S}
ExecStart=${WATCHDOG_PATH}
UNIT

  cat > /etc/systemd/system/simujoules-watchdog.timer <<'UNIT'
[Unit]
Description=Dispara o idle-watchdog do Simujoules periodicamente

[Timer]
# Primeira checagem 2 min após o boot (dá tempo do backend subir), depois a
# cada 1 min. AccuracySec baixo pra não atrasar o desligamento.
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT
fi

# --- 5) Habilitar + iniciar --------------------------------------------------
echo "-- habilitando e iniciando serviços --"
systemctl daemon-reload
systemctl enable --now simujoules-backend.service
if [[ -f /etc/systemd/system/simujoules-watchdog.timer ]]; then
  systemctl enable --now simujoules-watchdog.timer
fi

echo "== startup-script concluída :: backend em 0.0.0.0:${VM_PORT} =="
