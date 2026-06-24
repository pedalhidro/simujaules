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
# Plano de dados (Caddy/TLS): hostname estável, origem do app pra CORS e os
# tokens (auth do plano de dados + token DNS Cloudflare pra DNS-01). Os tokens
# chegam por metadata (o orquestrador os repassa); não há Secret Manager aqui.
DATA_HOST="$(metadata data-host)"; DATA_HOST="${DATA_HOST:-compute.simujaules.pedalhidrografi.co}"
DATA_PORT="$(metadata data-port)"; DATA_PORT="${DATA_PORT:-443}"
APP_ORIGIN="$(metadata app-origin)"; APP_ORIGIN="${APP_ORIGIN:-https://simujaules.pedalhidrografi.co}"
CLOUD_AUTH_TOKEN="$(metadata auth-token)"
CF_API_TOKEN="$(metadata cf-api-token)"

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
# Bind em 127.0.0.1: o backend NÃO é mais exposto direto. O Caddy (porta 443,
# TLS + token + CORS) é a única porta pública e faz proxy pra cá. O firewall só
# libera a 443 pro /32 do navegador. Defesa em profundidade: mesmo com firewall
# mal configurado, o backend não escuta externamente.
ExecStart=${BIN_PATH} 127.0.0.1:${VM_PORT} --max-mem-gb ${MAX_MEM_GB}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

# --- 3b) Caddy: TLS (DNS-01) + auth (token) + CORS pro plano de dados --------
# O navegador (página HTTPS) não pode falar com http://IP:8077 (conteúdo misto),
# então o Caddy termina TLS em https://DATA_HOST e faz proxy pro backend local.
# Ele exige o Bearer token (mesmo do app) e injeta os headers de CORS pra origem
# do app; o preflight OPTIONS passa SEM token. O cert é emitido por DNS-01 via
# Cloudflare (não precisa de porta 80 aberta) e fica em cache no disco (sobrevive
# stop/start — não re-emite a cada boot, evitando rate-limit do Let's Encrypt).
CADDY_BIN="/usr/local/bin/caddy"
if [[ ! -x "$CADDY_BIN" ]]; then
  # Build oficial customizado COM o módulo DNS da Cloudflare (a stable padrão
  # não traz). Em cache no disco como o binário do backend.
  echo "-- baixando Caddy (com módulo caddy-dns/cloudflare) --"
  curl -fsSL -o "$CADDY_BIN" \
    "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/cloudflare"
  chmod +x "$CADDY_BIN"
fi

echo "-- escrevendo /etc/caddy/Caddyfile ($DATA_HOST → 127.0.0.1:$VM_PORT) --"
mkdir -p /etc/caddy
# Heredoc QUOTED: nada de expansão do shell — os {env.*} ficam literais pro
# Caddy resolver em runtime. Os placeholders __X__ são trocados por sed depois.
cat > /etc/caddy/Caddyfile <<'CADDY'
{
	email admin@pedalhidrografi.co
}

__DATA_HOST__:__DATA_PORT__ {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}

	# Preflight CORS: responde OPTIONS sem exigir token (o navegador não manda
	# Authorization no preflight).
	@preflight method OPTIONS
	handle @preflight {
		header Access-Control-Allow-Origin "__APP_ORIGIN__"
		header Access-Control-Allow-Methods "GET, POST, OPTIONS"
		header Access-Control-Allow-Headers "Authorization, Content-Type, X-Simu-Gzip"
		header Access-Control-Max-Age "3600"
		respond 204
	}

	# Auth: tudo que não for preflight precisa do Bearer token exato.
	@unauth not header Authorization "Bearer {env.CLOUD_AUTH_TOKEN}"
	handle @unauth {
		respond "unauthorized" 401
	}

	# Autorizado: injeta CORS pra origem do app e faz proxy pro backend local.
	# Remove o Access-Control-Allow-Origin "*" do backend pra não duplicar (dois
	# valores quebram o CORS no navegador).
	handle {
		header Access-Control-Allow-Origin "__APP_ORIGIN__"
		header Vary Origin
		reverse_proxy 127.0.0.1:__VM_PORT__ {
			header_down -Access-Control-Allow-Origin
			header_down -Access-Control-Allow-Methods
			header_down -Access-Control-Allow-Headers
		}
	}
}
CADDY
sed -i \
  -e "s|__DATA_HOST__|${DATA_HOST}|g" \
  -e "s|__DATA_PORT__|${DATA_PORT}|g" \
  -e "s|__APP_ORIGIN__|${APP_ORIGIN}|g" \
  -e "s|__VM_PORT__|${VM_PORT}|g" \
  /etc/caddy/Caddyfile

echo "-- escrevendo caddy.service (tokens via Environment; certs em /var/lib/caddy) --"
cat > /etc/systemd/system/caddy.service <<UNIT
[Unit]
Description=Caddy TLS/auth/CORS para o plano de dados do Simujaules
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Tokens vêm do metadata (acima) pro ambiente do Caddy: o token DNS da Cloudflare
# (DNS-01) e o token de auth do plano de dados (o @unauth compara com ele).
Environment=CF_API_TOKEN=${CF_API_TOKEN}
Environment=CLOUD_AUTH_TOKEN=${CLOUD_AUTH_TOKEN}
# Cert/estado no disco (persiste entre stop/start → não re-emite o cert).
Environment=XDG_DATA_HOME=/var/lib/caddy
ExecStart=${CADDY_BIN} run --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=2
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /var/lib/caddy

# --- 4) Idle-watchdog como timer systemd ------------------------------------
# Escrito INLINE (não copiado do fonte): no caminho do binário pré-compilado o
# repo NÃO é clonado, então depender de ${SRC_DIR}/vm/idle-watchdog.sh deixaria a
# VM SEM o backstop de custo. Mantém paridade com vm/idle-watchdog.sh (que é a
# cópia canônica/documentada, usada fora deste fluxo). MAX_UPTIME_S é o teto
# rígido de tempo ligado (substitui o HARD_CAP_S do antigo orquestrador local).
WATCHDOG_PATH="${INSTALL_DIR}/idle-watchdog.sh"
cat > "$WATCHDOG_PATH" <<'WATCHDOG'
#!/usr/bin/env bash
# Backstop de custo DENTRO da VM (timer systemd, ~1/min). Desliga a VM (→ STOP,
# por causa do --instance-termination-action=STOP) se: (a) ociosa demais
# (idle_seconds do /health do backend > IDLE_MAX_S) OU (b) ligada além do teto
# rígido (uptime > MAX_UPTIME_S). Cópia em paridade com vm/idle-watchdog.sh.
set -euo pipefail
VM_PORT="${VM_PORT:-8077}"
IDLE_MAX_S="${IDLE_MAX_S:-900}"
MAX_UPTIME_S="${MAX_UPTIME_S:-7200}"
HEALTH_URL="http://127.0.0.1:${VM_PORT}/health"

# (b) Teto rígido de uptime: para a VM mesmo que pareça "ocupada", limitando o
# pior caso de custo (ex.: um compute travado que nunca fica ocioso).
uptime_s="$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)"
if [[ "$uptime_s" =~ ^[0-9]+$ ]] && (( uptime_s > MAX_UPTIME_S )); then
  echo "watchdog: uptime ${uptime_s}s > ${MAX_UPTIME_S}s (teto) — DESLIGANDO."
  shutdown -h now
  exit 0
fi

# (a) Ociosidade: falha do curl == "não ocioso" (backend ainda subindo).
if ! body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
  echo "watchdog: /health indisponível — backend não pronto; tratando como ocupado."
  exit 0
fi
idle=""
if command -v python3 >/dev/null 2>&1; then
  idle="$(printf '%s' "$body" | python3 -c \
    'import sys,json; print(int(json.load(sys.stdin).get("idle_seconds", -1)))' \
    2>/dev/null || true)"
fi
if [[ -z "$idle" || ! "$idle" =~ ^[0-9]+$ ]]; then
  echo "watchdog: não consegui ler idle_seconds (corpo: $body) — tratando como ocupado."
  exit 0
fi
echo "watchdog: idle_seconds=${idle} (limite=${IDLE_MAX_S}s), uptime=${uptime_s}s"
if (( idle > IDLE_MAX_S )); then
  echo "watchdog: VM ociosa há ${idle}s (> ${IDLE_MAX_S}s) — DESLIGANDO (→ STOP)."
  shutdown -h now
fi
WATCHDOG

# Teto rígido de uptime (s) — default 2 h. Configurável via metadata.
MAX_UPTIME_S="$(metadata max-uptime-s)"; MAX_UPTIME_S="${MAX_UPTIME_S:-7200}"

if [[ -f "$WATCHDOG_PATH" ]]; then
  chmod +x "$WATCHDOG_PATH"
  echo "-- escrevendo simujoules-watchdog.service + .timer (a cada 1 min) --"
  cat > /etc/systemd/system/simujoules-watchdog.service <<UNIT
[Unit]
Description=Simujoules idle watchdog (desliga a VM se ociosa ou no teto de uptime)

[Service]
Type=oneshot
# VM_PORT, IDLE_MAX_S e MAX_UPTIME_S vêm do ambiente; o watchdog desliga via
# shutdown -h now (com instance-termination-action=STOP, isso PARA — backstop).
Environment=VM_PORT=${VM_PORT}
Environment=IDLE_MAX_S=${IDLE_MAX_S}
Environment=MAX_UPTIME_S=${MAX_UPTIME_S}
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
systemctl enable --now caddy.service
if [[ -f /etc/systemd/system/simujoules-watchdog.timer ]]; then
  systemctl enable --now simujoules-watchdog.timer
fi

echo "== startup-script concluída :: backend 127.0.0.1:${VM_PORT}, Caddy ${DATA_HOST}:${DATA_PORT} =="
