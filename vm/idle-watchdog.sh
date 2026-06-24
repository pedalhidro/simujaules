#!/usr/bin/env bash
# idle-watchdog.sh — backstop de custo que roda DENTRO da VM (via timer systemd,
# a cada ~1 min; ver startup-script.sh). Consulta o /health do backend local,
# lê `idle_seconds` e, se a VM passou do limite de ociosidade, desliga.
#
# Com a instância criada com --instance-termination-action=STOP, um
# `shutdown -h now` convidado PARA a instância (não destrói). Isso é a rede de
# segurança pra quando o laptop é fechado / o orquestrador morre sem parar a VM:
# ela se desliga sozinha em vez de queimar dinheiro à toa.
#
# Falha do curl == "não ocioso": logo após o boot o backend ainda não responde,
# e não queremos desligar uma VM que acabou de subir. Só desligamos com uma
# leitura BOA de idle_seconds acima do teto.
#
# NOTA DE PARIDADE: a startup-script.sh embute uma CÓPIA INLINE deste watchdog
# (porque no caminho do binário pré-compilado o repo não é clonado). Mantenha os
# dois em sincronia ao mexer na lógica.
#
# Variáveis de ambiente:
#   VM_PORT       porta do backend local (default 8077)
#   IDLE_MAX_S    ociosidade máxima em segundos antes de desligar (default 900)
#   MAX_UPTIME_S  teto rígido de tempo ligado em segundos (default 7200 = 2 h)

set -euo pipefail

VM_PORT="${VM_PORT:-8077}"
IDLE_MAX_S="${IDLE_MAX_S:-900}"
MAX_UPTIME_S="${MAX_UPTIME_S:-7200}"
HEALTH_URL="http://127.0.0.1:${VM_PORT}/health"

# Teto rígido de uptime: para a VM mesmo se parecer ocupada (ex.: compute travado
# que nunca fica ocioso), limitando o pior caso de custo.
uptime_s="$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)"
if [[ "$uptime_s" =~ ^[0-9]+$ ]] && (( uptime_s > MAX_UPTIME_S )); then
  echo "watchdog: uptime ${uptime_s}s > ${MAX_UPTIME_S}s (teto) — DESLIGANDO (→ STOP)."
  shutdown -h now
  exit 0
fi

# Consulta o /health. Se o curl falhar (backend não pronto / sem resposta),
# trata como NÃO ocioso e sai sem desligar.
if ! body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
  echo "watchdog: /health indisponível — backend não pronto; tratando como ocupado."
  exit 0
fi

# Extrai idle_seconds do JSON com python3 (sempre presente; jq como fallback).
idle=""
if command -v python3 >/dev/null 2>&1; then
  idle="$(printf '%s' "$body" | python3 -c \
    'import sys,json; print(int(json.load(sys.stdin).get("idle_seconds", -1)))' \
    2>/dev/null || true)"
elif command -v jq >/dev/null 2>&1; then
  idle="$(printf '%s' "$body" | jq -r '.idle_seconds // -1' 2>/dev/null || true)"
fi

# Sem leitura válida (parse falhou ou campo ausente) → não arrisca desligar.
if [[ -z "$idle" || ! "$idle" =~ ^[0-9]+$ ]]; then
  echo "watchdog: não consegui ler idle_seconds (corpo: $body) — tratando como ocupado."
  exit 0
fi

echo "watchdog: idle_seconds=${idle} (limite=${IDLE_MAX_S}s)"

if (( idle > IDLE_MAX_S )); then
  echo "watchdog: VM ociosa há ${idle}s (> ${IDLE_MAX_S}s) — DESLIGANDO (shutdown -h now → STOP)."
  shutdown -h now
fi
