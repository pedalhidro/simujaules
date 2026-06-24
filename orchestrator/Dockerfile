# Imagem do orquestrador do Simujaules para Cloud Run.
# Serviço Flask pequeno (plano de controle da VM de cálculo). Roda com gunicorn,
# UM worker (estado mínimo em memória; várias instâncias seriam inofensivas, mas
# mantemos --max-instances=1 no deploy). Cloud Run injeta $PORT.
FROM python:3.12-slim

WORKDIR /app

# Dependências primeiro (camada cacheável).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV PORT=8080
# --threads: o /cloud/start pode bloquear alguns segundos no insert/start do
# GCP; threads deixam /status e preflights responderem em paralelo.
CMD exec gunicorn --bind "0.0.0.0:${PORT}" --workers 1 --threads 8 --timeout 120 main:app
