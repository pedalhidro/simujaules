# VM de cálculo do Simujoules (`vm/`)

Scripts para provisionar e operar uma **VM Spot no Google Cloud** que roda o
backend nativo do Simujoules (`backend/`) quando você quer jogar o cálculo do
campo de energia numa máquina **muito maior** que o laptop (uma
`n2-standard-128`: 128 vCPUs, 512 GB de RAM — a família C4 tem quota 0 no
projeto em southamerica-east1, por isso N2).

> **⚠️ ATENÇÃO: estes comandos criam e ligam uma VM COBRADA (billable).**
> **Nada aqui roda automaticamente — VOCÊ é quem executa, com consciência do
> custo. Os scripts NÃO são chamados pelo app nem pelo CI. Sempre use
> `--dry-run` primeiro pra ver exatamente o que vai acontecer.**

O app continua funcionando 100% sem nada disto — o backend nativo é opcional e
fica DESLIGADO por padrão no painel de parâmetros. Esta VM só entra quando você
liga o backend nativo e aponta o orquestrador pra ela.

## Arquivos

- **`bake-instance.sh`** — provisiona a VM **uma vez**: cria a regra de firewall,
  cria a instância Spot já com a `startup-script.sh` na metadata, e a deixa
  **PARADA** (STOPPED). Idempotente.
- **`startup-script.sh`** — roda na VM a cada boot: instala dependências + Rust
  (ou baixa um binário pré-compilado), compila/instala o backend, escreve o
  `systemd` unit do serviço e instala o idle-watchdog como timer. Idempotente.
- **`idle-watchdog.sh`** — roda dentro da VM (timer systemd, ~1/min): lê
  `idle_seconds` do `/health` do backend e **desliga a VM** se ela ficou ociosa
  além do limite. É o backstop de custo pra "fechei o laptop e esqueci".

## Fluxo de bake (uma vez só)

```sh
cd vm/
export CLOUD_AUTH_TOKEN=algum-valor  # obrigatório mesmo em --dry-run (o bake recusa rodar sem ele)

# 1. Veja o que seria executado (NÃO cobra nada):
./bake-instance.sh --dry-run

# 2. Provisione de verdade (CRIA a VM — começa a poder cobrar quando ligada):
CLOUD_AUTH_TOKEN=<o token real de produção> ./bake-instance.sh
```

Ao final a VM `simu-compute` existe e está **STOPPED**. O bake imprime os
próximos passos (que são do **orquestrador**, não seus):

- aperta a faixa de origem do firewall pro seu IP;
- liga a VM (`gcloud compute instances start simu-compute …`);
- a VM sobe sozinha o backend em `0.0.0.0:8077` via systemd;
- ao terminar, o orquestrador **para** a VM (a regra de firewall fica escopada no
  último /32 — a VM parada não escuta, então não há o que reabrir).

### Binário pré-compilado (opcional, mais rápido)

Por padrão a `startup-script.sh` instala o Rust e compila o backend na primeira
boot. Pra pular a compilação, exporte `BACKEND_BINARY_URL` apontando pra um
binário Linux já compilado — o bake repassa isso à VM via metadata e a
startup-script baixa em vez de compilar:

```sh
BACKEND_BINARY_URL="https://…/simujoules-backend" ./bake-instance.sh
```

## Modelo de custo / segurança

Três camadas, em ordem de defesa:

1. **Spot (`--provisioning-model=SPOT`)** — instância barata (muito mais que
   on-demand), com `--instance-termination-action=STOP`: preempção do GCP
   **para** a VM (não destrói); o disco e a config sobrevivem pro próximo start.
2. **Idle-watchdog (dentro da VM)** — timer systemd consulta o `/health` a cada
   ~1 min; se `idle_seconds > IDLE_MAX_S` (default **900 s = 15 min**) ele roda
   `shutdown -h now`, que com a termination-action=STOP **para** a instância.
   É a rede pra "fechei o laptop / o orquestrador morreu sem parar a VM".
3. **Teto rígido do orquestrador** — quem liga a VM é responsável por
   pará-la ao terminar (e num timeout). É a camada primária; o watchdog é só o
   backstop.

> A VM **só custa enquanto está LIGADA** (running). Parada (STOPPED) você paga
> apenas o disco (centavos). Confira no console que ela voltou a STOPPED quando
> o trabalho acabar.

### Como o watchdog enxerga ociosidade

O backend mantém um carimbo global da **última requisição** (qualquer
método/path) e expõe no `/health`:

```json
{"ok":true,"version":"…","cores":96,"mem_budget_bytes":…,"idle_seconds":N}
```

`idle_seconds` = `agora − última_requisição` (≥ 0). Como o orquestrador bate
no backend pra computar, qualquer atividade zera a ociosidade; só depois de
`IDLE_MAX_S` sem nenhuma requisição o watchdog desliga.

## Contrato de variáveis de ambiente

Os defaults batem com o orquestrador — só sobrescreva se souber o que está
fazendo.

| Variável             | Default                  | Onde            | Para quê |
|----------------------|--------------------------|-----------------|----------|
| `GCP_PROJECT`        | `pedal-hidrografico`     | bake            | projeto GCP |
| `GCP_ZONE`           | `southamerica-east1-a`   | bake            | zona da VM |
| `INSTANCE_NAME`      | `simu-compute`           | bake            | nome da instância |
| `MACHINE_TYPE`       | `n2-standard-128`        | bake            | tipo de máquina |
| `VM_PORT`            | `8077`                   | bake/startup/watchdog | porta do backend |
| `FIREWALL_RULE`      | `simu-compute-allow-8077`| bake            | nome da regra de firewall |
| `NETWORK_TAG`        | `simu-compute`           | bake            | tag de rede da regra |
| `FW_SOURCE_RANGE`    | `0.0.0.0/0` (placeholder)| bake            | origem do firewall (o orquestrador aperta) |
| `IMAGE_FAMILY`       | `debian-12`              | bake            | imagem base |
| `IMAGE_PROJECT`      | `debian-cloud`           | bake            | projeto da imagem |
| `BOOT_DISK_SIZE`     | `50GB`                   | bake            | tamanho do disco de boot |
| `BACKEND_BINARY_URL` | *(vazio → compila)*      | bake→startup    | binário pré-compilado opcional |
| `MAX_MEM_GB`         | `460`                    | startup         | `--max-mem-gb` do backend (ver abaixo) |
| `IDLE_MAX_S`         | `900`                    | startup→watchdog| ociosidade máx. antes de desligar |
| `SIMU_REPO`/`SIMU_REF` | repo `pedalhidro/simujaules` @ `main` | startup | fonte pra compilar |

### Por que `--max-mem-gb 460`

O pior caso (round mode) gasta por slice concorrente:

```
per_slice = 2·Scratch + Acc + include = 2·(17·N) + 20·N + 1·N = 55·N bytes
```

onde `N` é o nº de células do DEM. O nº de slices concorrentes é
`min(refs, cores, orçamento / per_slice)`, e
`density_mem_budget_bytes()` usa `orçamento_efetivo = max_mem_gb · 1e9 · 0.8`.

A `n2-standard-128` tem 512 GB; reservando ~50 GB pro corpo da requisição +
cópias do DEM + buffers de saída, `--max-mem-gb 460` dá
`orçamento_efetivo = 460·0,8e9 = 368e9 bytes`. Aí cabem os **128 slices** (um
por core) enquanto `N ≤ 368e9 / (55·128) ≈ 52 M células` (~7200×7200) —
folgado pros DEMs do app. DEMs maiores rodam menos slices (mais refs em série
por slice): a **saída é a mesma**, só o tempo cresce.

## Notas

- O orquestrador alcança a VM **diretamente** pelo IP público na porta
  `VM_PORT` — **não** há `cloudflared`/túnel. O acesso é controlado pelo
  firewall, que o orquestrador aperta pro IP de origem antes de ligar a VM.
- Sem auth no backend (mesma decisão do resto do ecossistema): o firewall é a
  barreira. Não reintroduza tokens.
- Para deletar a VM de vez (parar de pagar até o disco):
  `gcloud compute instances delete simu-compute --zone=southamerica-east1-a`
  — **deixado pra você rodar**, é destrutivo.
