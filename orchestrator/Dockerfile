# Imagem do orquestrador do Simujaules para Cloud Run.
# Serviço Flask pequeno (plano de controle da VM de cálculo). Roda com gunicorn,
# UM worker (estado mínimo em memória; várias instâncias seriam inofensivas, mas
# mantemos --max-instances=1 no deploy). Cloud Run injeta $PORT.
#
# Imagem base fixada por DIGEST (não só a tag mutável) — este serviço guarda os
# tokens que criam/deletam VMs de 96 vCPUs e editam o DNS de pedalhidrografi.co,
# então um rebuild não deve puxar silenciosamente uma versão nova/comprometida.
# Pra atualizar: `docker pull python:3.12-slim && docker inspect --format='{{index .RepoDigests 0}}' python:3.12-slim`,
# revisar o changelog do Python 3.12 e colar o novo digest aqui.
FROM python:3.12-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf

WORKDIR /app

# Dependências primeiro (camada cacheável).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV PORT=8080
# --threads: o /cloud/start pode bloquear alguns segundos no insert/start do
# GCP; threads deixam /status e preflights responderem em paralelo.
CMD exec gunicorn --bind "0.0.0.0:${PORT}" --workers 1 --threads 8 --timeout 120 main:app
