#!/usr/bin/env bash
# bake-instance.sh — provisiona (uma vez) a VM de cálculo do Simujoules no GCP.
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │  ATENÇÃO: ISTO CRIA UMA VM **COBRADA** (billable). Rode você mesmo, com   │
# │  consciência do custo. NADA aqui roda automaticamente. Use --dry-run     │
# │  primeiro pra ver exatamente quais comandos `gcloud` seriam executados.   │
# └─────────────────────────────────────────────────────────────────────────┘
#
# O que faz, em ordem (tudo idempotente — pode rodar de novo sem estragar):
#   1. Cria a regra de firewall que libera a porta do backend (tcp:VM_PORT)
#      pra uma tag de rede. A faixa de origem aqui é um PLACEHOLDER amplo; o
#      orquestrador (no laptop) aperta ela pro IP de quem está rodando, logo
#      antes de ligar a VM (e reaperta se o IP mudar). A regra fica escopada
#      nesse /32 mesmo com a VM parada — mais seguro que reabrir, e a VM parada
#      nem escuta na porta.
#   2. Cria a instância no modo PROVISIONING_MODEL (default SPOT). Em SPOT usa
#      --instance-termination-action=STOP — preempção/“shutdown -h” PARAM a VM
#      (não destroem), então o disco e a configuração sobrevivem. Use
#      PROVISIONING_MODEL=STANDARD (sob demanda) se a quota PREEMPTIBLE_CPUS da
#      região for 0 e o Spot for recusado. A
#      startup-script.sh é injetada via --metadata-from-file.
#   3. Espera a instância existir e PARA ela (`gcloud compute instances stop`),
#      deixando-a STOPPED — o orquestrador é quem dá o START quando precisa
#      computar, e a VM volta já com o backend pronto (systemd na boot).
#
# Modelo de custo: Spot (barato, pode ser preemptado) + idle-watchdog dentro da
# VM (desliga sozinha após ociosidade) + teto rígido do orquestrador (ele PARA a
# VM ao terminar / num timeout). Ver vm/README.md.
#
# Parametrizado por variáveis de ambiente (defaults batem com o orquestrador):
#   GCP_PROJECT, GCP_ZONE, INSTANCE_NAME, MACHINE_TYPE, VM_PORT,
#   FIREWALL_RULE, NETWORK_TAG, IMAGE_FAMILY, IMAGE_PROJECT, BOOT_DISK_SIZE,
#   FW_SOURCE_RANGE, BACKEND_BINARY_URL (repassado à VM via metadata).
#
# Uso:
#   ./bake-instance.sh            # cria de verdade (COBRADO)
#   ./bake-instance.sh --dry-run  # só imprime os comandos gcloud

set -euo pipefail

# --- Parâmetros (defaults = contrato com o orquestrador) --------------------
GCP_PROJECT="${GCP_PROJECT:-pedal-hidrografico}"
GCP_ZONE="${GCP_ZONE:-southamerica-east1-a}"
INSTANCE_NAME="${INSTANCE_NAME:-simu-compute}"
MACHINE_TYPE="${MACHINE_TYPE:-c4-standard-96}"
VM_PORT="${VM_PORT:-8077}"
FIREWALL_RULE="${FIREWALL_RULE:-simu-compute-allow-8077}"
NETWORK_TAG="${NETWORK_TAG:-simu-compute}"

# Modelo de provisionamento: SPOT (barato, preemptável → STOP) ou STANDARD (sob
# demanda, não preemptável). Use STANDARD se a quota PREEMPTIBLE_CPUS da região
# for 0 e o Spot for recusado na criação.
PROVISIONING_MODEL="${PROVISIONING_MODEL:-SPOT}"

# Teto de memória do backend (--max-mem-gb), repassado à VM via metadata. Vazio
# = usa o default da startup-script (320). Dimensione p/ ~0,8× a RAM caber em
# slices sem OOM (n2-standard-128 = 512 GB → 320 é seguro/conservador, ~34
# slices; ~480 usa mais núcleos). Cada slice round = 55·N bytes.
MAX_MEM_GB="${MAX_MEM_GB:-}"

# Imagem base e disco. Debian 12 traz ferramentas recentes; o disco precisa de
# folga pra toolchain do Rust + build (a VM de cálculo não guarda estado).
IMAGE_FAMILY="${IMAGE_FAMILY:-debian-12}"
IMAGE_PROJECT="${IMAGE_PROJECT:-debian-cloud}"
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-50GB}"

# Faixa de origem do firewall: PLACEHOLDER amplo. Deixe assim — o orquestrador
# reescreve esta regra pro IP de origem na hora de ligar a VM e abre o mínimo.
FW_SOURCE_RANGE="${FW_SOURCE_RANGE:-0.0.0.0/0}"

# URL opcional de um binário pré-compilado; se setada, a startup-script baixa
# em vez de compilar do zero. Repassada à VM como metadata `backend-binary-url`.
BACKEND_BINARY_URL="${BACKEND_BINARY_URL:-}"

# Caminho da startup-script ao lado deste arquivo (independe do cwd).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STARTUP_SCRIPT="${SCRIPT_DIR}/startup-script.sh"

# --- --dry-run --------------------------------------------------------------
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

# run: executa, ou só imprime quando --dry-run. Usa printf %q pra escapar.
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+ '; printf '%q ' "$@"; printf '\n'
  else
    "$@"
  fi
}

if [[ ! -f "$STARTUP_SCRIPT" ]]; then
  echo "ERRO: não achei a startup-script em $STARTUP_SCRIPT" >&2
  exit 1
fi

echo "== Simujoules :: bake-instance =="
echo "  projeto=$GCP_PROJECT zona=$GCP_ZONE instância=$INSTANCE_NAME"
echo "  máquina=$MACHINE_TYPE porta=$VM_PORT firewall=$FIREWALL_RULE tag=$NETWORK_TAG"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  (--dry-run: apenas imprimindo os comandos gcloud)"
fi
echo

# --- 1) Firewall (idempotente) ----------------------------------------------
# Cria a regra só se ela ainda não existir (`describe` falha → criamos).
echo "-- [1/3] regra de firewall ($FIREWALL_RULE) --"
if gcloud compute firewall-rules describe "$FIREWALL_RULE" \
    --project="$GCP_PROJECT" >/dev/null 2>&1; then
  echo "  já existe — mantendo (o orquestrador aperta a faixa de origem)."
else
  run gcloud compute firewall-rules create "$FIREWALL_RULE" \
    --project="$GCP_PROJECT" \
    --direction=INGRESS \
    --action=ALLOW \
    --rules="tcp:${VM_PORT}" \
    --target-tags="$NETWORK_TAG" \
    --source-ranges="$FW_SOURCE_RANGE" \
    --description="Simujoules compute backend (porta ${VM_PORT}); origem apertada pelo orquestrador"
fi
echo

# --- 2) Instância (idempotente) ---------------------------------------------
echo "-- [2/3] instância ($INSTANCE_NAME, $MACHINE_TYPE, $PROVISIONING_MODEL) --"
if gcloud compute instances describe "$INSTANCE_NAME" \
    --project="$GCP_PROJECT" --zone="$GCP_ZONE" >/dev/null 2>&1; then
  echo "  já existe — pulando criação."
else
  # --provisioning-model aceita SPOT ou STANDARD; --instance-termination-action
  # só é válido p/ SPOT (preempção/shutdown PARAM a VM, não a deletam).
  TERMINATION_FLAG=""
  if [ "$PROVISIONING_MODEL" = "SPOT" ]; then
    TERMINATION_FLAG="--instance-termination-action=STOP"
  fi
  # --metadata leva porta, backend-binary-url (vazio = compila na boot) e
  # max-mem-gb (vazio = default 320 na startup-script), lidos pra montar o unit.
  run gcloud compute instances create "$INSTANCE_NAME" \
    --project="$GCP_PROJECT" \
    --zone="$GCP_ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --provisioning-model="$PROVISIONING_MODEL" \
    $TERMINATION_FLAG \
    --image-family="$IMAGE_FAMILY" \
    --image-project="$IMAGE_PROJECT" \
    --boot-disk-size="$BOOT_DISK_SIZE" \
    --tags="$NETWORK_TAG" \
    --metadata="vm-port=${VM_PORT},backend-binary-url=${BACKEND_BINARY_URL},max-mem-gb=${MAX_MEM_GB}" \
    --metadata-from-file="startup-script=${STARTUP_SCRIPT}"
fi
echo

# --- 3) Deixa a VM PARADA ----------------------------------------------------
# Espera ela aparecer (no dry-run não há nada esperando) e PARA — o
# orquestrador é quem liga sob demanda.
echo "-- [3/3] parando a instância (fica STOPPED, pronta pro orquestrador) --"
if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '+ '; printf '%q ' gcloud compute instances stop "$INSTANCE_NAME" \
    --project="$GCP_PROJECT" --zone="$GCP_ZONE"; printf '\n'
else
  # Pequena espera pra instância terminar de ser criada antes do stop.
  for _ in $(seq 1 30); do
    state="$(gcloud compute instances describe "$INSTANCE_NAME" \
      --project="$GCP_PROJECT" --zone="$GCP_ZONE" \
      --format='value(status)' 2>/dev/null || true)"
    [[ -n "$state" ]] && break
    sleep 2
  done
  run gcloud compute instances stop "$INSTANCE_NAME" \
    --project="$GCP_PROJECT" --zone="$GCP_ZONE"
fi
echo

# --- Próximos passos ---------------------------------------------------------
cat <<EOF
== Pronto ==
A VM '$INSTANCE_NAME' foi provisionada como SPOT e deixada PARADA (STOPPED).

Próximos passos (feitos pelo ORQUESTRADOR, não aqui):
  • Apertar a faixa de origem do firewall '$FIREWALL_RULE' pro IP atual:
      gcloud compute firewall-rules update $FIREWALL_RULE \\
        --project=$GCP_PROJECT --source-ranges=<SEU_IP>/32
  • Ligar a VM pra computar:
      gcloud compute instances start $INSTANCE_NAME \\
        --project=$GCP_PROJECT --zone=$GCP_ZONE
  • A VM sobe o backend (systemd 'simujoules-backend.service') em
    0.0.0.0:$VM_PORT e o idle-watchdog a desliga sozinha após ociosidade.
  • Ao terminar, o orquestrador PARA a VM (a regra de firewall fica escopada no
    último /32 — a VM parada não escuta, então não há o que reabrir).

LEMBRE: a VM custa enquanto estiver LIGADA. Confira no console que ela voltou a
STOPPED quando o trabalho acabar. Ver vm/README.md.
EOF
