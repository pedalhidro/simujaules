#!/usr/bin/env bash
# deploy-orchestrator.sh — builds + deploys o orquestrador do Simujaules no
# Cloud Run (plano de controle PÚBLICO e autenticado da VM de cálculo).
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │  ATENÇÃO: isto cria um serviço Cloud Run PÚBLICO que pode CRIAR/DELETAR   │
# │  uma VM cobrada. A barreira é o token compartilhado (Secret Manager). NÃO │
# │  rode sem os secrets criados e a service account com o papel mínimo.      │
# └─────────────────────────────────────────────────────────────────────────┘
#
# Pré-requisitos (uma vez — ver vm/README.md / orchestrator/README.md):
#   1. Secrets no Secret Manager:
#        simu-cloud-token   (token compartilhado app↔orquestrador↔Caddy)
#        simu-cf-dns-token  (token Cloudflare DNS:Edit na zona pedalhidrografi.co)
#        simu-reap-token    (token de admin só pro Cloud Scheduler chamar /reap)
#   2. Service account `simu-orchestrator@PROJECT.iam.gserviceaccount.com` com um
#      papel custom mínimo: compute.instances.{get,start,stop,create,delete},
#      compute.disks.create, compute.firewalls.{get,update},
#      iam.serviceAccounts.actAs na SA da VM, e secretAccessor nos 3 secrets.
#   3. O startup-script da VM publicado em gs://simujaules/vm/startup-script.sh
#      (a SA da VM precisa de storage.objectViewer nesse bucket).
#
# Uso:
#   GCP_PROJECT=pedal-hidrografico CF_ZONE_ID=<id> ./deploy-orchestrator.sh

set -euo pipefail
cd "$(dirname "$0")"

GCP_PROJECT="${GCP_PROJECT:-pedal-hidrografico}"
REGION="${REGION:-southamerica-east1}"
SERVICE="${SERVICE:-simu-orchestrator}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-simu-orchestrator@${GCP_PROJECT}.iam.gserviceaccount.com}"
CF_ZONE_ID="${CF_ZONE_ID:?defina CF_ZONE_ID (id da zona pedalhidrografi.co no Cloudflare)}"

# Variáveis de ambiente não-secretas do serviço.
ENV_VARS="GCP_PROJECT=${GCP_PROJECT}"
ENV_VARS="${ENV_VARS},GCP_ZONE=${GCP_ZONE:-southamerica-east1-a}"
ENV_VARS="${ENV_VARS},INSTANCE_NAME=${INSTANCE_NAME:-simu-compute}"
ENV_VARS="${ENV_VARS},DATA_HOST=${DATA_HOST:-compute.simujaules.pedalhidrografi.co}"
ENV_VARS="${ENV_VARS},APP_ORIGIN=${APP_ORIGIN:-https://simujaules.pedalhidrografi.co}"
ENV_VARS="${ENV_VARS},FIREWALL_RULE=${FIREWALL_RULE:-simu-compute-allow-443}"
ENV_VARS="${ENV_VARS},CF_ZONE_ID=${CF_ZONE_ID}"
ENV_VARS="${ENV_VARS},STARTUP_SCRIPT_URL=${STARTUP_SCRIPT_URL:-gs://simujaules/vm/startup-script.sh}"
ENV_VARS="${ENV_VARS},REAP_IDLE_DAYS=${REAP_IDLE_DAYS:-30}"
# Repassa SÓ um valor explicitamente fornecido pelo chamador — NÃO tem default
# aqui (ao contrário das outras vars acima). Um default apontando pra um objeto
# GCS que ninguém publicou faria vm/startup-script.sh tentar baixá-lo; o script
# agora tolera isso (fail-open: cai pro binário em cache ou build do fonte —
# ver vm/startup-script.sh), mas é melhor o operador saber que precisa publicar
# o binário pra evitar o build de ~10 min em toda VM recriada do zero.
ENV_VARS="${ENV_VARS},BACKEND_BINARY_URL=${BACKEND_BINARY_URL:-}"

if [[ -z "${BACKEND_BINARY_URL:-}" ]]; then
  echo ">> AVISO: BACKEND_BINARY_URL não definido." >&2
  echo "   VMs recriadas pelo orquestrador (após /cloud/delete ou o reaper de" >&2
  echo "   30 dias) vão compilar o backend do fonte no boot (~10 min) em vez de" >&2
  echo "   baixar um binário pronto. Publique-o uma vez com:" >&2
  echo "     gsutil cp backend/target/release/simujoules-backend gs://simujaules/vm/simujoules-backend" >&2
  echo "   e rode este script de novo com:" >&2
  echo "     BACKEND_BINARY_URL=https://storage.googleapis.com/simujaules/vm/simujoules-backend" >&2
  echo >&2
fi

# Secrets montados como variáveis de ambiente (lidos do Secret Manager).
SECRETS="CLOUD_AUTH_TOKEN=simu-cloud-token:latest"
SECRETS="${SECRETS},CF_API_TOKEN=simu-cf-dns-token:latest"
SECRETS="${SECRETS},REAP_TOKEN=simu-reap-token:latest"

echo ">> Deploying ${SERVICE} to Cloud Run (${REGION}, project ${GCP_PROJECT})…"
# --allow-unauthenticated: o app no navegador não apresenta token OIDC do Google;
# a auth é em nível de app (Bearer compartilhado), verificada por _require().
# --max-instances=1 / --min-instances=0: escala a zero (custo ocioso ~0).
gcloud run deploy "$SERVICE" \
  --project="$GCP_PROJECT" \
  --region="$REGION" \
  --source=. \
  --service-account="$SERVICE_ACCOUNT" \
  --allow-unauthenticated \
  --max-instances=1 \
  --min-instances=0 \
  --cpu=1 --memory=512Mi \
  --set-env-vars="$ENV_VARS" \
  --set-secrets="$SECRETS"

URL="$(gcloud run services describe "$SERVICE" --project="$GCP_PROJECT" \
  --region="$REGION" --format='value(status.url)')"
echo
echo ">> Deployed. Orchestrator URL: ${URL}"
echo "   Aponte 'orch.simujaules.pedalhidrografi.co' (CNAME/domain-mapping) pra ele,"
echo "   ou use a URL .run.app direto no campo de URL do orquestrador no app."
echo "   Daily reaper (Cloud Scheduler, uma vez):"
echo "     gcloud scheduler jobs create http simu-reap \\"
echo "       --location=${REGION} --schedule='17 4 * * *' \\"
echo "       --uri='${URL}/cloud/reap' --http-method=POST \\"
echo "       --headers=\"Authorization=Bearer \$(gcloud secrets versions access latest --secret=simu-reap-token)\""
