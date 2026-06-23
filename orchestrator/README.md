# Orquestrador do Simujoules

Serviço **Flask pequeno e LOCAL** — você roda na sua máquina, ele NÃO vai pra
nuvem. Ele é o único plano de **controle + proxy** entre o applet do Simujoules
(no navegador) e uma VM de compute no GCP:

1. **controla a VM** (liga/desliga, lease, firewall) com as **suas próprias**
   Application Default Credentials do `gcloud` — sem service account, sem
   segredo, sem token; e
2. faz **proxy transparente** (stream, sem bufferizar o corpo inteiro) das
   requisições pesadas de compute do navegador pro backend Rust que roda na VM.

## Por que existe

O applet roda em `http://localhost:8000` (ou similar). O navegador **bloqueia**
um POST dali pra `http://IP_PUBLICO_DA_VM` (conteúdo misto / cross-origin pra um
IP público sem TLS). Mas ele **aceita** falar com `http://127.0.0.1`. Então o
navegador só fala com este orquestrador — que liga a VM sob demanda e repassa os
bytes. Os caminhos de compute (`/health`, `/density`, `/single`) são um
**pass-through opaco** que espelha o backend Rust byte a byte; o frontend nem
sabe que tem uma VM no meio.

Ele liga só em `127.0.0.1` e usa as **suas** credenciais. **Nunca exponha isto
na rede.**

## Pré-requisitos

- Python 3 e as dependências:
  ```sh
  pip install -r requirements.txt
  ```
- Credenciais do GCP (ADC) com permissão pra ligar/parar a instância e editar a
  regra de firewall:
  ```sh
  gcloud auth application-default login
  ```
- Uma **VM pré-assada e PARADA** (criada por `../vm/bake-instance.sh`) com o
  backend Rust instalado como serviço escutando em `:8077`, e a **regra de
  firewall** `simu-compute-allow-8077` (tcp:8077). O orquestrador aperta o
  `source_ranges` dessa regra pro IP público de saída dele a cada start.

## Como rodar

Produção (controla a VM real do GCP):

```sh
python main.py
```

Teste local (sem GCP — não importa nem chama nada da nuvem): finja a máquina de
estados da VM em memória e faça proxy dos computes pra um backend Rust local
(suba `cargo run --release` em `../backend`, que escuta em `:8077`):

```sh
DRY_RUN=1 python main.py
```

No `DRY_RUN` o ciclo de vida (`/cloud/start` → `provisioning` → `running` →
`/cloud/stop`) é simulado com pequenos atrasos, e `/health`, `/density`,
`/single` viram proxy pro `DRY_RUN_VM_URL` (default `http://127.0.0.1:8077`).
Dá pra exercitar o fluxo inteiro do frontend sem gastar nada na nuvem.

## Variáveis de ambiente

| Variável         | Default                  | O que é                                                            |
|------------------|--------------------------|--------------------------------------------------------------------|
| `ORCH_PORT`      | `8079`                   | Porta local (liga só em `127.0.0.1`).                              |
| `GCP_PROJECT`    | `pedal-hidrografico`     | Projeto do GCP.                                                    |
| `GCP_ZONE`       | `southamerica-east1-a`   | Zona da instância.                                                |
| `INSTANCE_NAME`  | `simu-compute`           | Nome da VM pré-assada (a ÚNICA tocada).                            |
| `VM_PORT`        | `8077`                   | Porta do backend Rust na VM.                                      |
| `FIREWALL_RULE`  | `simu-compute-allow-8077`| Regra de firewall apertada pro IP de saída no start.             |
| `LEASE_S`        | `900`                    | Duração do lease (s); cada keepalive/uso renova.                  |
| `IDLE_MAX_S`     | `900`                    | Teto de ociosidade (s) — o lease implementa isto.                 |
| `HARD_CAP_S`     | `7200`                   | Teto absoluto ligado (s); o lease nunca passa de `started+cap`.  |
| `HEALTH_WAIT_S`  | `180`                    | Tempo máximo esperando a VM ficar saudável após start (s).        |
| `DRY_RUN`        | `0`                      | `1`/`true` (ou `--dry-run`) → modo local sem GCP.                 |
| `DRY_RUN_VM_URL` | `http://127.0.0.1:8077`  | Pra onde o proxy aponta no `DRY_RUN`.                             |

## Endpoints

**Proxy de compute** (espelham o backend Rust byte a byte):

- `GET /health` — quando a VM está pronta, repassa o `/health` da VM e mescla
  `idle_seconds`: `{"ok":true,"version":..,"cores":INT,"mem_budget_bytes":INT,"idle_seconds":INT}`.
  Quando não está pronta, responde na hora `{"ok":false,"vmState":"stopped|provisioning|running|stopping|error"}`
  (não dispara start — é uma sonda leve).
- `POST /density` — stream-proxy pro `/density` da VM (auto-start + espera saúde
  se estiver desligada).
- `POST /single` — idem, pro `/single`.

**Ciclo de vida da VM** (consumidos pela máquina de estados de nuvem do frontend):

- `POST /cloud/start` → `{"state":STATE,"etaSeconds":INT}` — idempotente (volta
  rápido se já `RUNNING`); liga a VM parada, aperta o firewall, fixa o lease.
- `GET /cloud/status` → `{"state":STATE,"healthy":BOOL,"cores":INT_OR_NULL,"memBudgetBytes":INT_OR_NULL,"leaseExpiresAt":UNIXSECONDS_OR_NULL,"externalIp":STRING_OR_NULL}`.
- `POST /cloud/keepalive` → `{"leaseExpiresAt":UNIXSECONDS}` — estende o lease.
- `POST /cloud/stop` → `{"state":STATE}` — para a instância agora.

`STATE` ∈ `{STOPPED, PROVISIONING, RUNNING, STOPPING, ERROR}`.

## Streaming (sem bufferizar)

Um campo de energia de DEM grande é volumoso (centenas de MB subindo, mais de
1 GB descendo). O proxy **nunca** segura o corpo inteiro em memória: lê o upload
de `request.stream` e o passa como `data=` do `requests`; abre a resposta com
`stream=True` e devolve um `Response(iter_content(1 MiB), ...)`. O timeout de
leitura é `None` (compute pode demorar), só o connect tem timeout.

## Lease / ociosidade / hard-cap

O estado de lease vive **em memória, num único processo** (várias threads, igual
ao backend amora com `--workers 1`). Uma thread varredora roda a cada ~30 s e
**para a VM** quando o lease vence (ociosidade) ou quando o tempo ligado passa
do `HARD_CAP_S`. Cada keepalive/uso interativo renova o lease (nunca além de
`started_at + HARD_CAP_S`). Não suba o número de workers do gunicorn — quebraria
o controle de tempo compartilhado.

## Segurança

- Liga **só em `127.0.0.1`** — não tem autenticação por design (acesso local
  confiável, igual aos outros serviços self-hosted do Pedal Hidrográfico).
- Usa **as suas** credenciais ADC. Qualquer um que alcance a porta pode ligar e
  comandar a VM. **Não exponha na rede nem faça port-forward.**
