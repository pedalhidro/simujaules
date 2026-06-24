#!/usr/bin/env python3
"""Orquestrador do Simujaules — plano de CONTROLE da VM de cálculo (Cloud Run).

Diferente da versão local original, este serviço roda na NUVEM (Cloud Run,
escala-a-zero) e é o plano de controle PÚBLICO e AUTENTICADO que o app servido
em https://simujaules.pedalhidrografi.co usa pra ligar/criar a VM de cálculo
sob demanda. Ele NÃO faz proxy do compute: os corpos de /density e /single têm
centenas de MB (> limite de 32 MiB do Cloud Run), então o navegador fala
DIRETO com a VM por HTTPS (Caddy na VM, ver vm/startup-script.sh). Este serviço
só cuida do ciclo de vida:

  • POST /cloud/start      — cria (se não existir) OU liga a VM; aperta o
                             firewall pro IP do navegador; aponta o DNS pro IP
                             efêmero atual. Idempotente.
  • GET  /cloud/status     — estado (do GCP) + dataUrl + IP externo.
  • POST /cloud/stop       — para a VM agora.
  • POST /cloud/keepalive  — no-op (compat. com o app; o custo é contido pelo
                             idle-watchdog DENTRO da VM, não por lease aqui).
  • POST /cloud/create     — cria a VM explicitamente (raro; /start já cria).
  • POST /cloud/delete     — deleta a VM explicitamente.
  • POST /cloud/reap       — (Cloud Scheduler) deleta a VM se parada há mais de
                             REAP_IDLE_DAYS (default 30) → custo ocioso → ~0.

Autenticação: todas as rotas /cloud/* (menos /reap) exigem
`Authorization: Bearer <CLOUD_AUTH_TOKEN>` — o MESMO token que o navegador
manda no plano de dados (Caddy o exige na VM). Sem ele, qualquer um ligaria
uma VM de 96 vCPUs na conta do Danilo. /cloud/reap usa um token de ADMIN
separado (REAP_TOKEN), mandado só pelo Cloud Scheduler.

DNS dinâmico (substitui o IP estático): a VM usa IP EFÊMERO (de graça parada).
A cada start o orquestrador reescreve o registro A de
`compute.simujaules.pedalhidrografi.co` (DNS-only no Cloudflare) pro IP atual,
via API do Cloudflare. O certificado TLS da VM é emitido por DNS-01 (Caddy),
então independe do IP — ver vm/.

Credenciais: roda com a service account do Cloud Run (ADC automático). O
`google-cloud-compute` é importado PREGUIÇOSAMENTE pra que `DRY_RUN=1` rode sem
o pacote e sem tocar a nuvem (testes locais).

Estado: praticamente SEM estado em memória (o Cloud Run escala a zero e pode ter
várias instâncias). Cada chamada lê o estado da VM do GCP. O backstop de custo
mora na VM (idle-watchdog + teto de uptime) e no reaper de 30 dias — não há
mais lease/sweeper de processo aqui.
"""

import hmac
import logging
import os
import sys
import time

import requests
from flask import Flask, jsonify, request

# ---------------------------------------------------------------------------
# Configuração (via variáveis de ambiente, com defaults sensatos)
# ---------------------------------------------------------------------------


def _env(name, default):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def _env_int(name, default):
    try:
        return int(_env(name, default))
    except (TypeError, ValueError):
        return int(default)


def _truthy(v):
    return str(v).strip().lower() in ("1", "true", "yes", "on")


GCP_PROJECT = _env("GCP_PROJECT", "pedal-hidrografico")
GCP_ZONE = _env("GCP_ZONE", "southamerica-east1-a")
INSTANCE_NAME = _env("INSTANCE_NAME", "simu-compute")
VM_PORT = _env_int("VM_PORT", 8077)            # porta interna do backend Rust
DATA_PORT = _env_int("DATA_PORT", 443)         # porta pública (Caddy/TLS)
FIREWALL_RULE = _env("FIREWALL_RULE", "simu-compute-allow-443")
NETWORK_TAG = _env("NETWORK_TAG", "simu-compute")

# Plano de dados: hostname estável que o Caddy serve (TLS por DNS-01). O app
# manda /density|/single|/health pra cá, não pra este orquestrador.
DATA_HOST = _env("DATA_HOST", "compute.simujaules.pedalhidrografi.co")
DATA_URL = _env("DATA_URL", f"https://{DATA_HOST}")

# Origem do app (para CORS). O plano de controle só responde a esta origem.
APP_ORIGIN = _env("APP_ORIGIN", "https://simujaules.pedalhidrografi.co")

# Auth: token compartilhado (mesmo do plano de dados) + token de reaper (admin).
CLOUD_AUTH_TOKEN = _env("CLOUD_AUTH_TOKEN", "")
REAP_TOKEN = _env("REAP_TOKEN", "")

# Cloudflare (DNS dinâmico): token escopado em DNS:Edit na zona + id da zona.
CF_API_TOKEN = _env("CF_API_TOKEN", "")
CF_ZONE_ID = _env("CF_ZONE_ID", "")
DNS_TTL = _env_int("DNS_TTL", 60)
# IP-placeholder (TEST-NET-1) pro qual o registro A aponta quando a VM está
# parada — evita deixar o DNS apontando pra um IP efêmero já reciclado pelo GCP.
DNS_PLACEHOLDER_IP = _env("DNS_PLACEHOLDER_IP", "192.0.2.1")

# Reaper: deleta a instância parada há mais de tantos dias.
REAP_IDLE_DAYS = _env_int("REAP_IDLE_DAYS", 30)

# --- Spec da instância (espelha vm/bake-instance.sh — manter em sincronia) ---
MACHINE_TYPE = _env("MACHINE_TYPE", "c4-standard-96")
PROVISIONING_MODEL = _env("PROVISIONING_MODEL", "SPOT")
IMAGE_FAMILY = _env("IMAGE_FAMILY", "debian-12")
IMAGE_PROJECT = _env("IMAGE_PROJECT", "debian-cloud")
BOOT_DISK_GB = _env_int("BOOT_DISK_GB", 50)
MAX_MEM_GB = _env("MAX_MEM_GB", "320")
BACKEND_BINARY_URL = _env("BACKEND_BINARY_URL", "")
# startup-script.sh lido de um objeto GCS (a SA da VM precisa de objectViewer).
STARTUP_SCRIPT_URL = _env("STARTUP_SCRIPT_URL", "gs://simujaules/vm/startup-script.sh")
# SA da VM (vazio = SA default do projeto). Precisa só de storage.objectViewer no
# bucket do startup-script; os tokens vão por metadata (não via Secret Manager).
VM_SERVICE_ACCOUNT = _env("VM_SERVICE_ACCOUNT", "")

ORCH_PORT = _env_int("PORT", 8079)             # Cloud Run injeta $PORT

DRY_RUN = _truthy(_env("DRY_RUN", "0")) or ("--dry-run" in sys.argv)

log = logging.getLogger("orchestrator")

# ---------------------------------------------------------------------------
# Strings de estado do contrato (mapeadas do status do GCP).
# ---------------------------------------------------------------------------

STATE_ABSENT = "ABSENT"            # a instância não existe (deletada/nunca criada)
STATE_STOPPED = "STOPPED"
STATE_PROVISIONING = "PROVISIONING"
STATE_RUNNING = "RUNNING"
STATE_STOPPING = "STOPPING"
STATE_ERROR = "ERROR"

_GCP_STATUS_MAP = {
    "TERMINATED": STATE_STOPPED,
    "STOPPED": STATE_STOPPED,
    "PROVISIONING": STATE_PROVISIONING,
    "STAGING": STATE_PROVISIONING,
    "RUNNING": STATE_RUNNING,
    "STOPPING": STATE_STOPPING,
    "SUSPENDING": STATE_STOPPING,
    "SUSPENDED": STATE_STOPPED,
    "REPAIRING": STATE_ERROR,
}


def _map_gcp_status(status):
    return _GCP_STATUS_MAP.get((status or "").upper(), STATE_ERROR)


def _now():
    return time.time()


# ---------------------------------------------------------------------------
# Autenticação (comparação em tempo constante).
# ---------------------------------------------------------------------------


def _bearer():
    h = request.headers.get("Authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return ""


def _require(token_expected):
    """True se o Bearer bate com token_expected (não-vazio). Constant-time.

    Sem token configurado ⇒ recusa tudo (fail-closed): nunca exponha sem auth.
    """
    if not token_expected:
        return False
    return hmac.compare_digest(_bearer(), token_expected)


# ---------------------------------------------------------------------------
# Camada de controle do GCP (importa compute_v1 só aqui — preguiçoso).
# ---------------------------------------------------------------------------


class _GcpClients:
    instances = None
    firewalls = None


def _gcp():
    if _GcpClients.instances is None:
        from google.cloud import compute_v1  # import preguiçoso

        _GcpClients.instances = compute_v1.InstancesClient()
        _GcpClients.firewalls = compute_v1.FirewallsClient()
    return _GcpClients.instances, _GcpClients.firewalls


def _gcp_get_instance():
    """Retorna (status_str_ou_None, external_ip_ou_None, last_stop_ts_ou_None).

    status_str None ⇒ a instância NÃO existe (404). last_stop_ts é o
    lastStopTimestamp do GCP (RFC3339) — usado pelo reaper.
    """
    from google.api_core.exceptions import NotFound

    instances, _ = _gcp()
    try:
        inst = instances.get(
            project=GCP_PROJECT, zone=GCP_ZONE, instance=INSTANCE_NAME
        )
    except NotFound:
        return None, None, None
    ip = None
    for iface in inst.network_interfaces or []:
        for ac in iface.access_configs or []:
            if ac.nat_i_p:
                ip = ac.nat_i_p
                break
        if ip:
            break
    return inst.status, ip, (inst.last_stop_timestamp or None)


def _gcp_start_instance():
    instances, _ = _gcp()
    instances.start(project=GCP_PROJECT, zone=GCP_ZONE, instance=INSTANCE_NAME)


def _gcp_stop_instance():
    instances, _ = _gcp()
    instances.stop(project=GCP_PROJECT, zone=GCP_ZONE, instance=INSTANCE_NAME)


def _gcp_delete_instance():
    instances, _ = _gcp()
    instances.delete(project=GCP_PROJECT, zone=GCP_ZONE, instance=INSTANCE_NAME)


def _gcp_create_instance():
    """Cria a VM de cálculo (espelha vm/bake-instance.sh). IP efêmero, SPOT.

    O startup-script vem de STARTUP_SCRIPT_URL (objeto GCS). Segredos do Caddy
    (auth + token DNS) são lidos pela PRÓPRIA VM do Secret Manager no boot — não
    passam por metadata. A VM NÃO é parada aqui; quem chama espera ela ficar
    saudável (o app faz polling do /health do plano de dados).
    """
    from google.cloud import compute_v1

    inst = compute_v1.Instance()
    inst.name = INSTANCE_NAME
    inst.machine_type = f"zones/{GCP_ZONE}/machineTypes/{MACHINE_TYPE}"
    inst.tags = compute_v1.Tags(items=[NETWORK_TAG])

    # Scheduling: SPOT + STOP-on-preempt (igual ao bake). STANDARD não leva
    # instance_termination_action.
    sched = compute_v1.Scheduling()
    sched.provisioning_model = PROVISIONING_MODEL
    if PROVISIONING_MODEL == "SPOT":
        sched.instance_termination_action = "STOP"
        sched.automatic_restart = False
    inst.scheduling = sched

    # Disco de boot a partir da família de imagem.
    boot = compute_v1.AttachedDisk()
    boot.boot = True
    boot.auto_delete = True
    init = compute_v1.AttachedDiskInitializeParams()
    init.source_image = (
        f"projects/{IMAGE_PROJECT}/global/images/family/{IMAGE_FAMILY}"
    )
    init.disk_size_gb = BOOT_DISK_GB
    boot.initialize_params = init
    inst.disks = [boot]

    # Interface de rede com IP externo EFÊMERO (access_config sem nat_i_p fixo).
    nic = compute_v1.NetworkInterface()
    nic.network = "global/networks/default"
    ac = compute_v1.AccessConfig()
    ac.name = "External NAT"
    ac.type_ = "ONE_TO_ONE_NAT"
    nic.access_configs = [ac]
    inst.network_interfaces = [nic]

    # SA opcional + escopo de leitura do bucket (startup-script em GCS).
    if VM_SERVICE_ACCOUNT:
        sa = compute_v1.ServiceAccount()
        sa.email = VM_SERVICE_ACCOUNT
        sa.scopes = ["https://www.googleapis.com/auth/devstorage.read_only"]
        inst.service_accounts = [sa]

    # Metadata: startup-script-url + parâmetros + tokens do Caddy (auth do plano
    # de dados + token DNS do Cloudflare pra DNS-01). Tokens via metadata (não
    # Secret Manager): mais simples, e o projeto é privado (modelo de confiança
    # de projeto, igual aos outros serviços self-hosted do Pedal).
    items = {
        "startup-script-url": STARTUP_SCRIPT_URL,
        "vm-port": str(VM_PORT),
        "data-port": str(DATA_PORT),
        "data-host": DATA_HOST,
        "app-origin": APP_ORIGIN,
        "max-mem-gb": str(MAX_MEM_GB),
        "backend-binary-url": BACKEND_BINARY_URL,
        "auth-token": CLOUD_AUTH_TOKEN,
        "cf-api-token": CF_API_TOKEN,
    }
    md = compute_v1.Metadata()
    md.items = [compute_v1.Items(key=k, value=v) for k, v in items.items()]
    inst.metadata = md

    instances, _ = _gcp()
    instances.insert(project=GCP_PROJECT, zone=GCP_ZONE, instance_resource=inst)


def _gcp_tighten_firewall(client_ip):
    """Aperta FIREWALL_RULE pro /32 do client_ip em tcp:DATA_PORT (443).

    Best-effort: loga e segue em caso de falha. Cacheia o último IP pra não
    repatchar quando não mudou.
    """
    if not client_ip:
        return
    if getattr(_gcp_tighten_firewall, "last_ip", None) == client_ip:
        return
    try:
        from google.cloud import compute_v1

        _, firewalls = _gcp()
        rule = firewalls.get(project=GCP_PROJECT, firewall=FIREWALL_RULE)
        rule.source_ranges = [f"{client_ip}/32"]
        allowed = compute_v1.Allowed()
        allowed.I_p_protocol = "tcp"
        allowed.ports = [str(DATA_PORT)]
        rule.allowed = [allowed]
        firewalls.patch(
            project=GCP_PROJECT, firewall=FIREWALL_RULE, firewall_resource=rule
        )
        _gcp_tighten_firewall.last_ip = client_ip
        log.info("firewall %s apertado p/ %s/32 tcp:%d",
                 FIREWALL_RULE, client_ip, DATA_PORT)
    except Exception as e:  # noqa: BLE001
        log.warning("não consegui apertar o firewall %s: %s", FIREWALL_RULE, e)


# ---------------------------------------------------------------------------
# Cloudflare: DNS dinâmico (registro A do plano de dados → IP efêmero atual).
# ---------------------------------------------------------------------------

_CF_API = "https://api.cloudflare.com/client/v4"


def _cf_headers():
    return {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }


def _cf_record_id():
    """Acha (e cacheia) o id do registro A de DATA_HOST na zona."""
    cached = getattr(_cf_set_a_record, "record_id", None)
    if cached:
        return cached
    r = requests.get(
        f"{_CF_API}/zones/{CF_ZONE_ID}/dns_records",
        headers=_cf_headers(), params={"type": "A", "name": DATA_HOST},
        timeout=10,
    )
    r.raise_for_status()
    res = r.json().get("result") or []
    if res:
        _cf_set_a_record.record_id = res[0]["id"]
        return res[0]["id"]
    return None


def _cf_set_a_record(ip):
    """Aponta o registro A de DATA_HOST pra `ip` (TTL baixo, DNS-only/proxied=False).

    Best-effort: loga e segue. Idempotente via cache do último IP setado.
    Cria o registro se ainda não existir.
    """
    if not ip or not CF_API_TOKEN or not CF_ZONE_ID:
        return
    if getattr(_cf_set_a_record, "last_ip", None) == ip:
        return
    body = {"type": "A", "name": DATA_HOST, "content": ip,
            "ttl": DNS_TTL, "proxied": False}
    try:
        rec_id = _cf_record_id()
        if rec_id:
            r = requests.put(
                f"{_CF_API}/zones/{CF_ZONE_ID}/dns_records/{rec_id}",
                headers=_cf_headers(), json=body, timeout=10,
            )
        else:
            r = requests.post(
                f"{_CF_API}/zones/{CF_ZONE_ID}/dns_records",
                headers=_cf_headers(), json=body, timeout=10,
            )
            r.raise_for_status()
            _cf_set_a_record.record_id = r.json()["result"]["id"]
        r.raise_for_status()
        _cf_set_a_record.last_ip = ip
        log.info("DNS %s → %s (ttl %ds)", DATA_HOST, ip, DNS_TTL)
    except Exception as e:  # noqa: BLE001
        log.warning("não consegui apontar o DNS %s p/ %s: %s", DATA_HOST, ip, e)


# ---------------------------------------------------------------------------
# DRY_RUN: máquina de estados fake (inclui ABSENT/create/delete + lastStop).
# ---------------------------------------------------------------------------

_DRY_PROVISION_S = 4.0
_DRY_STOP_S = 3.0

_dry = {
    "status": None,            # None = ABSENT (não existe)
    "external_ip": "203.0.113.7",
    "transition_at": 0.0,
    "transition_to": None,
    "last_stop_ts": None,      # epoch (float) p/ simular lastStopTimestamp
}


def _dry_advance():
    if _dry["transition_to"] and _now() >= _dry["transition_at"]:
        if _dry["transition_to"] == "TERMINATED":
            _dry["last_stop_ts"] = _now()
        _dry["status"] = _dry["transition_to"]
        _dry["transition_to"] = None


def _dry_get():
    _dry_advance()
    if _dry["status"] is None:
        return None, None, None
    ts = None
    if _dry["last_stop_ts"]:
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                            time.gmtime(_dry["last_stop_ts"]))
    return _dry["status"], _dry["external_ip"], ts


def _dry_create():
    _dry_advance()
    if _dry["status"] is None:
        _dry["status"] = "STAGING"
        _dry["transition_to"] = "RUNNING"
        _dry["transition_at"] = _now() + _DRY_PROVISION_S
        _dry["last_stop_ts"] = None


def _dry_start():
    _dry_advance()
    if _dry["status"] in ("TERMINATED", "STOPPED", "SUSPENDED"):
        _dry["status"] = "STAGING"
        _dry["transition_to"] = "RUNNING"
        _dry["transition_at"] = _now() + _DRY_PROVISION_S


def _dry_stop():
    _dry_advance()
    if _dry["status"] in ("RUNNING", "STAGING", "PROVISIONING"):
        _dry["status"] = "STOPPING"
        _dry["transition_to"] = "TERMINATED"
        _dry["transition_at"] = _now() + _DRY_STOP_S


def _dry_delete():
    _dry["status"] = None
    _dry["transition_to"] = None
    _dry["last_stop_ts"] = None


# ---------------------------------------------------------------------------
# Dispatch unificado: DRY_RUN vs GCP real.
# ---------------------------------------------------------------------------


def get_instance():
    """Retorna (STATE_do_contrato, external_ip_ou_None, last_stop_ts_ou_None)."""
    if DRY_RUN:
        status, ip, ts = _dry_get()
    else:
        status, ip, ts = _gcp_get_instance()
    if status is None:
        return STATE_ABSENT, None, None
    return _map_gcp_status(status), ip, ts


def ensure_up(client_ip):
    """Garante a VM ligada (cria se ausente, liga se parada), aperta firewall e
    aponta o DNS pro IP atual. Retorna (STATE, eta_seconds)."""
    state, ip, _ = get_instance()

    if state == STATE_ABSENT:
        if DRY_RUN:
            _dry_create()
        else:
            _gcp_create_instance()
        eta = 240  # cria do zero: startup-script + cert DNS-01
    elif state in (STATE_STOPPED, STATE_ERROR):
        if DRY_RUN:
            _dry_start()
        else:
            _gcp_start_instance()
        eta = 60
    elif state == STATE_RUNNING:
        eta = 0
    else:  # PROVISIONING / STOPPING — transição em curso
        eta = 30

    if not DRY_RUN:
        _gcp_tighten_firewall(client_ip)

    # Aponta o DNS assim que houver IP (pode só aparecer no PROVISIONING).
    _, ip, _ = get_instance()
    if ip:
        _cf_set_a_record(ip)
    return get_instance()[0], eta


def stop_instance():
    if DRY_RUN:
        _dry_stop()
    else:
        _gcp_stop_instance()
    # Tira o DNS do IP que vai ser reciclado (aponta pro placeholder).
    _cf_set_a_record.last_ip = None  # força o próximo set
    _cf_set_a_record(DNS_PLACEHOLDER_IP)
    return get_instance()[0]


def delete_instance():
    if DRY_RUN:
        _dry_delete()
    else:
        _gcp_delete_instance()
    _cf_set_a_record.last_ip = None
    _cf_set_a_record(DNS_PLACEHOLDER_IP)
    return get_instance()[0]


def _stopped_seconds(last_stop_ts):
    """Segundos desde o lastStopTimestamp (RFC3339), ou None se não der pra ler."""
    if not last_stop_ts:
        return None
    try:
        from datetime import datetime, timezone

        s = last_stop_ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return (datetime.now(timezone.utc) - dt).total_seconds()
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# Flask
# ---------------------------------------------------------------------------

app = Flask(__name__)


@app.after_request
def _cors(resp):
    # CORS restrito à origem do app (auth é por token, mas restringir a origem
    # é defesa-em-profundidade). Authorization precisa estar nos headers
    # permitidos pro preflight do navegador deixar passar o Bearer.
    resp.headers["Access-Control-Allow-Origin"] = APP_ORIGIN
    resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
    resp.headers["Access-Control-Max-Age"] = "3600"
    return resp


@app.route("/<path:_any>", methods=["OPTIONS"])
@app.route("/", methods=["OPTIONS"])
def _preflight(_any=None):
    return ("", 204)


def _client_ip():
    """IP real do navegador. No Cloud Run vem como 1º item do X-Forwarded-For."""
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.remote_addr or ""


def _deny():
    return jsonify({"error": "unauthorized"}), 401


@app.route("/cloud/start", methods=["POST"])
def cloud_start():
    """Cria (se ausente) ou liga a VM; aperta firewall; aponta DNS. Idempotente.

    {"state":STATE,"etaSeconds":INT,"dataUrl":STR}
    """
    if not _require(CLOUD_AUTH_TOKEN):
        return _deny()
    state, eta = ensure_up(_client_ip())
    return jsonify({"state": state, "etaSeconds": eta, "dataUrl": DATA_URL})


@app.route("/cloud/status", methods=["GET"])
def cloud_status():
    """Estado (do GCP) + plano de dados. O navegador confirma a SAÚDE batendo
    direto em dataUrl/health (o firewall já libera o /32 dele).

    {"state":STATE,"dataUrl":STR,"externalIp":STR_OR_NULL,"leaseExpiresAt":null}
    """
    if not _require(CLOUD_AUTH_TOKEN):
        return _deny()
    state, ip, _ = get_instance()
    # Reaperta firewall + DNS em status também (o IP do navegador pode mudar
    # entre polls; o IP da VM aparece durante o provisioning).
    if state in (STATE_RUNNING, STATE_PROVISIONING):
        if not DRY_RUN:
            _gcp_tighten_firewall(_client_ip())
        if ip:
            _cf_set_a_record(ip)
    return jsonify({
        "state": state,
        "dataUrl": DATA_URL,
        "externalIp": ip,
        "leaseExpiresAt": None,
    })


@app.route("/cloud/keepalive", methods=["POST"])
def cloud_keepalive():
    """No-op (compat). O custo é contido pelo idle-watchdog DA VM, não por lease."""
    if not _require(CLOUD_AUTH_TOKEN):
        return _deny()
    return jsonify({"ok": True, "leaseExpiresAt": None})


@app.route("/cloud/stop", methods=["POST"])
def cloud_stop():
    """Para a instância agora. {"state":STATE}."""
    if not _require(CLOUD_AUTH_TOKEN):
        return _deny()
    return jsonify({"state": stop_instance()})


@app.route("/cloud/create", methods=["POST"])
def cloud_create():
    """Cria a VM explicitamente (raro — /cloud/start já cria se ausente)."""
    if not _require(CLOUD_AUTH_TOKEN):
        return _deny()
    state, eta = ensure_up(_client_ip())
    return jsonify({"state": state, "etaSeconds": eta, "dataUrl": DATA_URL})


@app.route("/cloud/delete", methods=["POST"])
def cloud_delete():
    """Deleta a instância (custo ocioso → 0; é recriada sob demanda no /start)."""
    if not _require(CLOUD_AUTH_TOKEN):
        return _deny()
    return jsonify({"state": delete_instance()})


@app.route("/cloud/reap", methods=["POST"])
def cloud_reap():
    """(Cloud Scheduler) deleta a instância se PARADA há mais de REAP_IDLE_DAYS.

    Token de ADMIN separado (REAP_TOKEN). Só deleta um estado TERMINATED — uma
    VM ligada/provisionando nunca é tocada (o watchdog a para primeiro).

    {"deleted":BOOL,"state":STATE,"stoppedDays":FLOAT_OR_NULL,"reason":STR}
    """
    if not _require(REAP_TOKEN):
        return _deny()
    state, _, last_stop = get_instance()
    if state == STATE_ABSENT:
        return jsonify({"deleted": False, "state": state,
                        "stoppedDays": None, "reason": "absent"})
    if state != STATE_STOPPED:
        return jsonify({"deleted": False, "state": state,
                        "stoppedDays": None, "reason": "not-stopped"})
    secs = _stopped_seconds(last_stop)
    if secs is None:
        return jsonify({"deleted": False, "state": state,
                        "stoppedDays": None, "reason": "no-timestamp"})
    days = secs / 86400.0
    if secs > REAP_IDLE_DAYS * 86400:
        new_state = delete_instance()
        log.info("reaper deletou %s (parada há %.1f dias)", INSTANCE_NAME, days)
        return jsonify({"deleted": True, "state": new_state,
                        "stoppedDays": days, "reason": "idle-expired"})
    return jsonify({"deleted": False, "state": state,
                    "stoppedDays": days, "reason": "within-window"})


@app.route("/healthz", methods=["GET"])
def healthz():
    """Liveness do PRÓPRIO orquestrador (não da VM). Sem auth."""
    return jsonify({"ok": True, "service": "simujaules-orchestrator"})


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------


def _log_config():
    log.info("Orquestrador Simujaules (Cloud Run) — plano de controle")
    log.info("  bind          : 0.0.0.0:%d", ORCH_PORT)
    log.info("  DRY_RUN       : %s", DRY_RUN)
    log.info("  GCP_PROJECT   : %s", GCP_PROJECT)
    log.info("  GCP_ZONE      : %s", GCP_ZONE)
    log.info("  INSTANCE_NAME : %s", INSTANCE_NAME)
    log.info("  FIREWALL_RULE : %s (tcp:%d)", FIREWALL_RULE, DATA_PORT)
    log.info("  DATA_HOST     : %s", DATA_HOST)
    log.info("  APP_ORIGIN    : %s", APP_ORIGIN)
    log.info("  CF_ZONE_ID    : %s", "set" if CF_ZONE_ID else "UNSET")
    log.info("  auth token    : %s", "set" if CLOUD_AUTH_TOKEN else "UNSET (fail-closed)")
    log.info("  reap token    : %s", "set" if REAP_TOKEN else "UNSET (fail-closed)")
    log.info("  REAP_IDLE_DAYS: %d", REAP_IDLE_DAYS)


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    _log_config()
    # Cloud Run usa gunicorn (ver Dockerfile); este run() é só pra DRY_RUN local.
    app.run(host="0.0.0.0", port=ORCH_PORT, threaded=True)


if __name__ == "__main__":
    main()
