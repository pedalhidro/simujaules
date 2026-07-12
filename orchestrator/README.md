# Orquestrador do Simujaules (Cloud Run)

Serviço **Flask pequeno no Cloud Run** (escala-a-zero) que é o plano de
**controle PÚBLICO e AUTENTICADO** da VM de cálculo no GCP. Ele liga/cria/para/
deleta a VM sob demanda pro app servido em `https://simujaules.pedalhidrografi.co`
— inclusive quando acessado **remotamente** (não só localhost).

> Versão anterior: um Flask **local** em `127.0.0.1` que também fazia **proxy**
> do compute. Foi substituído por este modelo de nuvem porque o app agora roda
> num domínio público e o proxy não cabe no Cloud Run (limite de 32 MiB por
> requisição; um upload de DEM tem centenas de MB).

## Arquitetura (dois planos)

```
navegador (simujaules.pedalhidrografi.co, HTTPS)
  ├─ CONTROLE: POST /cloud/start|status|stop|keepalive|create|delete   → este serviço (Cloud Run)  +Bearer token
  │                                                                       → API do GCP: cria/liga/para/deleta a VM,
  │                                                                         aperta o firewall pro /32 do navegador,
  │                                                                         reescreve o DNS pro IP efêmero atual
  └─ DADOS:    POST /density|/single, GET /health (centenas de MB)       → https://compute.simujaules.pedalhidrografi.co
                                                                            (Caddy na VM: TLS + token + CORS) +Bearer token
                                                                            → 127.0.0.1:8077 backend Rust (intocado)
```

O compute NÃO passa por aqui — o navegador fala **direto** com a VM por HTTPS.
Este serviço só cuida do ciclo de vida.

## Por que cada peça

- **Cloud Run, escala-a-zero**: a VM grande fica PARADA entre runs, então algo
  sempre-ligado e barato precisa ligá-la. Custo ocioso ~0.
- **IP efêmero + DNS dinâmico**: a VM não tem IP estático (cobrado parado). A
  cada start o orquestrador aponta o registro A de
  `compute.simujaules.pedalhidrografi.co` (DNS-only no Cloudflare, TTL 60s) pro
  IP atual. O cert TLS da VM é por **DNS-01** (independe do IP).
- **Firewall pro /32 do navegador**: lido do `X-Forwarded-For` (no Cloud Run, o
  **último** item é o IP real do cliente — os anteriores, se houver, vêm do
  próprio navegador e são forjáveis; o Cloud Run sempre acrescenta o IP real
  como o hop final). Só o navegador que pediu alcança a porta 443.
- **Token compartilhado**: a barreira contra qualquer um ligar uma VM de 96
  vCPUs. O MESMO token vale no controle (aqui) e nos dados (Caddy).

## Autenticação

- Todas as rotas `/cloud/*` (menos `/reap`) exigem
  `Authorization: Bearer <CLOUD_AUTH_TOKEN>`. Sem token configurado, o serviço
  recusa tudo (**fail-closed**).
- `/cloud/reap` usa um token de ADMIN separado (`REAP_TOKEN`), mandado só pelo
  Cloud Scheduler.
- O serviço sobe com `--allow-unauthenticated` no Cloud Run **de propósito**: o
  navegador não apresenta token OIDC do Google; a auth é em nível de app.

## Endpoints

- `POST /cloud/start` → `{"state","etaSeconds","dataUrl"}` — **cria se ausente**,
  liga se parada; aperta firewall; aponta DNS. Idempotente. Body JSON opcional
  `{"machineType":"n2-standard-8|32|128"}` (o seletor "Máquina da nuvem" do
  app): validado contra a allowlist e aplicado no create / no start-de-parada,
  junto com a metadata `max-mem-gb` da tabela; uma VM já RUNNING mantém o
  tamanho até o próximo stop. Todas na plataforma mínima Ice Lake (binário
  cacheado é `target-cpu=native` — ver "Limitações conhecidas").
- `GET  /cloud/status` → `{"state","dataUrl","externalIp","leaseExpiresAt":null}`
  — estado do GCP. A **saúde** é confirmada pelo navegador batendo direto em
  `dataUrl/health` (o firewall já libera o /32 dele).
- `POST /cloud/stop` → `{"state"}` ou `{"state","skipped":"active-lease"}` — para
  a VM agora e aponta o DNS pro placeholder, A MENOS que outro `client_id`
  (header `X-Simu-Client`) tenha uma lease válida (keepalive há < `LEASE_TTL_S`)
  — nesse caso pula o stop e devolve o estado real da VM, sem parar (ver
  LEASES no código). Sem o header, é o comportamento antigo (para sempre).
- `POST /cloud/keepalive` → `{"ok":true,"leaseExpiresAt":null}` — registra/renova
  a lease do `client_id` (header `X-Simu-Client`), se mandado — protege o
  `/cloud/stop` de um SEGUNDO cliente contra o "parar após cada cálculo" do
  primeiro. Sem o header, é um no-op puro (compat. com clientes antigos). O
  custo real ainda é contido pelo idle-watchdog DENTRO da VM, não por esta lease.
- `POST /cloud/create` / `POST /cloud/delete` → ciclo de vida explícito.
- `POST /cloud/reap` (admin) → deleta a VM se PARADA há mais de `REAP_IDLE_DAYS`
  (default 30), via `lastStopTimestamp`. Custo ocioso de longo prazo → ~0.
- `GET  /healthz` → liveness do próprio serviço (sem auth).

`STATE` ∈ `{ABSENT, STOPPED, PROVISIONING, RUNNING, STOPPING, ERROR}`.

## Variáveis de ambiente (principais)

| Variável            | Default                                  | O que é                                   |
|---------------------|------------------------------------------|-------------------------------------------|
| `CLOUD_AUTH_TOKEN`  | (secret)                                 | Token compartilhado (controle + dados).   |
| `REAP_TOKEN`        | (secret)                                 | Token de admin do `/cloud/reap`.          |
| `CF_API_TOKEN`      | (secret)                                 | Cloudflare DNS:Edit (registro A + DNS-01).|
| `CF_ZONE_ID`        | —                                        | Id da zona `pedalhidrografi.co`.          |
| `DATA_HOST`         | `compute.simujaules.pedalhidrografi.co`  | Hostname do plano de dados (Caddy).       |
| `APP_ORIGIN`        | `https://simujaules.pedalhidrografi.co`  | Origem do app (CORS).                     |
| `GCP_PROJECT/ZONE`  | `pedal-hidrografico` / `southamerica-east1-a` | Projeto/zona da VM.                  |
| `INSTANCE_NAME`     | `simu-compute`                           | Nome da VM (a ÚNICA tocada).              |
| `FIREWALL_RULE`     | `simu-compute-allow-443`                 | Regra apertada pro /32 do navegador.      |
| `STATIC_IP`         | — (vazio = IP efêmero)                   | IP reservado da VM (`simu-compute-ip`): recriações reclamam o mesmo endereço; sete `DNS_PLACEHOLDER_IP` com o MESMO valor pro registro A nunca mudar (fim do DNS podre no navegador). |
| `STARTUP_SCRIPT_URL`| `gs://simujaules/vm/startup-script.sh`   | Startup-script (create-when-missing).     |
| `BACKEND_BINARY_URL`| — (vazio)                                | Binário pré-compilado (vazio = compila do fonte no boot, ~10 min). |
| `REAP_IDLE_DAYS`    | `30`                                     | Dias parada até o reaper deletar.         |
| `DRY_RUN`           | `0`                                      | `1` → máquina de estados fake, sem GCP.   |

## Teste local (sem GCP, sem gastar nada)

```sh
pip install -r requirements.txt
DRY_RUN=1 CLOUD_AUTH_TOKEN=segredo REAP_TOKEN=admin python main.py
# noutro terminal:
curl -s -XPOST -H 'Authorization: Bearer segredo' localhost:8079/cloud/start
curl -s     -H 'Authorization: Bearer segredo' localhost:8079/cloud/status
```

No `DRY_RUN` o ciclo (`ABSENT → create → PROVISIONING → RUNNING → stop →
STOPPED → reap → ABSENT`) é simulado em memória; nada do GCP/Cloudflare é
chamado. (Ver o smoke test em `../` durante o desenvolvimento.)

## Deploy

```sh
CF_ZONE_ID=<id-da-zona> ./deploy-orchestrator.sh
```

Pré-requisitos (uma vez): os 3 secrets no Secret Manager (`simu-cloud-token`,
`simu-cf-dns-token`, `simu-reap-token`), a service account `simu-orchestrator`
com o papel mínimo (start/stop/create/delete de instância, disks.create,
firewalls.get/update, `actAs` na SA da VM, `secretAccessor` nos 3 secrets), e o
`startup-script.sh` publicado em `gs://simujaules/vm/`. Detalhes no header do
`deploy-orchestrator.sh` e em `vm/README.md`.

## Custo

- Cloud Run: ~0 ocioso (escala a zero).
- VM parada (até 30 dias): só o disco de boot (~US$ 2/mês por 50 GB).
- **Após 30 dias parada**: o reaper deleta a instância → ~0 (recriada sob
  demanda no próximo `/cloud/start`).
- Defesa de custo em camadas: SPOT + firewall-/32 + token + idle-watchdog na VM
  (+ teto de uptime) + reaper. Recomenda-se também um **alerta de orçamento** no
  Billing.

## Segurança

O SA do orquestrador pode **criar/deletar** VMs — o endpoint público é alvo de
valor. As barreiras são o token compartilhado + firewall-/32 por requisição + o
token de admin do reaper. Garanta os 3 antes de o serviço ficar acessível.

## Limitações conhecidas

- **Clientes IPv6 não abrem o firewall do plano de dados.** O navegador fala
  com o Cloud Run pelo AAAA do `run.app` (macOS/redes v6 preferem IPv6), o
  orquestrador só sabe apertar `/32` IPv4 (`_client_ip` ignora v6 com um
  warning), e a VM só tem IPv4 — então o `/cloud/start` de um cliente IPv6
  liga a VM mas **não** libera a porta 443 pro IPv4 que o mesmo navegador vai
  usar no plano de dados. Funciona hoje por acaso quando o IPv4 do usuário já
  está na janela de IPs recentes (ex.: um `curl -4` anterior da mesma rede).
  Conserto real: correlacionar o IPv4 (um preflight autenticado no plano de
  dados que reporte o IP ao orquestrador), ou aceitar `/128` v6 quando a VM
  tiver AAAA. Até lá: rode `curl -4 -X POST …/cloud/start` uma vez da mesma
  rede pra semear o firewall.
- **O binário do backend é preso à microarquitetura da CPU** (`target-cpu=native`
  no `backend/.cargo/config.toml`): compilado na `n2-standard-128` (Ice Lake),
  ele **SIGILL-a** em E2 e até em N2 menores agendadas em Cascade Lake — às
  vezes só no caminho de CÁLCULO (o `/health` serve normal e o crash aparece
  como 502 no meio do `/density`). Se trocar o `MACHINE_TYPE` de família ou
  tamanho, fixe a plataforma (`gcloud compute instances update … --min-cpu-platform
  "Intel Ice Lake"`) ou delete o binário em `/opt/simujoules` pra recompilar.
