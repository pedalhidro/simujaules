#!/usr/bin/env python3
"""Orquestrador local do Simujoules — plano de controle + proxy de compute.

Serviço Flask PEQUENO que roda na MÁQUINA DO USUÁRIO (não na nuvem). Ele:

  1. controla uma VM do GCP pré-assada (start/stop/lease) usando as
     Application Default Credentials do próprio usuário
     (`gcloud auth application-default login`) — sem service account, sem
     segredo, sem token; e
  2. faz proxy TRANSPARENTE (stream, sem bufferizar o corpo inteiro) das
     requisições de compute do navegador para o backend Rust que roda na VM.

Por que existe: o applet roda em `http://localhost:8000` e NÃO consegue falar
com `http://IP_PUBLICO_DA_VM` (conteúdo misto — a página é http e o IP também,
mas o navegador bloqueia POSTs cross-origin pra um IP público sem TLS). Ele
CONSEGUE, porém, falar com `http://127.0.0.1`. Então este orquestrador é o
ÚNICO plano de controle+proxy local: o navegador só fala com ele.

Liga só em 127.0.0.1 — nunca exponha isto na rede; ele tem as suas credenciais.

Modelo de processo: UM processo, várias THREADS (igual ao backend amora com
`--workers 1`). O estado do lease é compartilhado em memória; rodar com vários
workers quebraria o controle de tempo. Não suba o número de workers.

A importação do `google-cloud-compute` é PREGUIÇOSA (dentro do caminho GCP), pra
que `DRY_RUN=1 python main.py` funcione sem o pacote instalado — útil pra testar
o fluxo inteiro contra um backend Rust local.
"""

import logging
import os
import sys
import threading
import time
import zlib

import requests
from flask import Flask, Response, jsonify, request, stream_with_context

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
VM_PORT = _env_int("VM_PORT", 8077)
FIREWALL_RULE = _env("FIREWALL_RULE", "simu-compute-allow-8077")
IDLE_MAX_S = _env_int("IDLE_MAX_S", 900)
HARD_CAP_S = _env_int("HARD_CAP_S", 7200)
ORCH_PORT = _env_int("ORCH_PORT", 8079)
LEASE_S = _env_int("LEASE_S", 900)

DRY_RUN = _truthy(_env("DRY_RUN", "0")) or ("--dry-run" in sys.argv)
DRY_RUN_VM_URL = _env("DRY_RUN_VM_URL", "http://127.0.0.1:8077").rstrip("/")

# Quanto tempo esperar a VM ficar saudável depois de um start (s).
HEALTH_WAIT_S = _env_int("HEALTH_WAIT_S", 180)
# Intervalo entre polls do /health da VM durante a espera (s).
HEALTH_POLL_INTERVAL_S = 3
# Intervalo do varredor de lease/idle/hard-cap (s).
SWEEP_INTERVAL_S = 30

log = logging.getLogger("orchestrator")

# ---------------------------------------------------------------------------
# Strings de estado do contrato (camelCase no /cloud/status; STATE em caixa
# alta no /cloud/start|stop). Mapeamos o status do GCP pra estes.
# ---------------------------------------------------------------------------

STATE_STOPPED = "STOPPED"
STATE_PROVISIONING = "PROVISIONING"
STATE_RUNNING = "RUNNING"
STATE_STOPPING = "STOPPING"
STATE_ERROR = "ERROR"

# Mapa status do GCP -> STATE do contrato.
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


# vmState minúsculo usado no /health quando a VM não está pronta.
def _vm_state_lower(state):
    return {
        STATE_STOPPED: "stopped",
        STATE_PROVISIONING: "provisioning",
        STATE_RUNNING: "running",
        STATE_STOPPING: "stopping",
        STATE_ERROR: "error",
    }.get(state, "error")


# ---------------------------------------------------------------------------
# Estado de lease/idle compartilhado em processo (protegido por _state_lock).
# Toda mutação no GCP também passa por _state_lock — assunção de instância
# única (só INSTANCE_NAME é tocado).
# ---------------------------------------------------------------------------

_state_lock = threading.Lock()
_lease_expires_at = None  # unix seconds; None = sem lease ativo
_started_at = None  # unix seconds do último start bem-sucedido

# Estado fake p/ DRY_RUN (máquina de estados em memória).
_dry_state = {
    "status": "TERMINATED",  # status estilo GCP
    "external_ip": "127.0.0.1",
    "transition_at": 0.0,  # quando a transição pendente "completa"
    "transition_to": None,  # status alvo
}


def _now():
    return time.time()


# ---------------------------------------------------------------------------
# Camada de controle do GCP (preguiçosa: importa compute_v1 só aqui).
# ---------------------------------------------------------------------------


class _GcpClients:
    """Singleton preguiçoso dos clients do compute_v1."""

    instances = None
    firewalls = None


def _gcp():
    if _GcpClients.instances is None:
        from google.cloud import compute_v1  # import preguiçoso

        _GcpClients.instances = compute_v1.InstancesClient()
        _GcpClients.firewalls = compute_v1.FirewallsClient()
    return _GcpClients.instances, _GcpClients.firewalls


def _gcp_get_instance():
    """Retorna (status_str, external_ip_or_None) da instância real."""
    instances, _ = _gcp()
    inst = instances.get(
        project=GCP_PROJECT, zone=GCP_ZONE, instance=INSTANCE_NAME
    )
    status = inst.status  # ex.: "RUNNING", "TERMINATED"
    ip = None
    for iface in inst.network_interfaces or []:
        for ac in iface.access_configs or []:
            if ac.nat_i_p:  # external NAT IP
                ip = ac.nat_i_p
                break
        if ip:
            break
    return status, ip


def _gcp_start_instance():
    instances, _ = _gcp()
    instances.start(
        project=GCP_PROJECT, zone=GCP_ZONE, instance=INSTANCE_NAME
    )


def _gcp_stop_instance():
    instances, _ = _gcp()
    instances.stop(
        project=GCP_PROJECT, zone=GCP_ZONE, instance=INSTANCE_NAME
    )


def _detect_egress_ip():
    """IP público de saída deste orquestrador (best-effort)."""
    try:
        return requests.get("https://api.ipify.org", timeout=5).text.strip()
    except Exception as e:  # noqa: BLE001
        log.warning("não consegui detectar IP de saída: %s", e)
        return None


def _gcp_tighten_firewall(egress_ip):
    """Aperta o FIREWALL_RULE pro /32 do egress_ip em tcp:VM_PORT.

    Best-effort: loga e segue em caso de falha (o start não pode falhar por
    causa disso).
    """
    if not egress_ip:
        return
    # Cacheia o último IP apertado (atributo da função, sem global novo): permite
    # chamar isto a cada /cloud/start sem um patch GCP por run quando o IP não
    # mudou — só reaperta quando o laptop troca de rede.
    if getattr(_gcp_tighten_firewall, "last_ip", None) == egress_ip:
        return
    try:
        from google.cloud import compute_v1  # import preguiçoso

        _, firewalls = _gcp()
        rule = firewalls.get(project=GCP_PROJECT, firewall=FIREWALL_RULE)
        rule.source_ranges = [f"{egress_ip}/32"]
        allowed = compute_v1.Allowed()
        allowed.I_p_protocol = "tcp"
        allowed.ports = [str(VM_PORT)]
        rule.allowed = [allowed]
        firewalls.patch(
            project=GCP_PROJECT, firewall=FIREWALL_RULE, firewall_resource=rule
        )
        _gcp_tighten_firewall.last_ip = egress_ip
        log.info("firewall %s apertado p/ %s/32 tcp:%d",
                 FIREWALL_RULE, egress_ip, VM_PORT)
    except Exception as e:  # noqa: BLE001
        log.warning("não consegui apertar o firewall %s: %s", FIREWALL_RULE, e)


# ---------------------------------------------------------------------------
# DRY_RUN: máquina de estados fake em memória (mesma assinatura dos helpers).
# ---------------------------------------------------------------------------

_DRY_PROVISION_S = 4.0  # tempo fake até "RUNNING"
_DRY_STOP_S = 3.0  # tempo fake até "TERMINATED"


def _dry_advance():
    """Avança a transição fake pendente se já passou o tempo."""
    t = _dry_state
    if t["transition_to"] and _now() >= t["transition_at"]:
        t["status"] = t["transition_to"]
        t["transition_to"] = None


def _dry_get_instance():
    _dry_advance()
    return _dry_state["status"], _dry_state["external_ip"]


def _dry_start_instance():
    _dry_advance()
    if _dry_state["status"] in ("TERMINATED", "STOPPED", "SUSPENDED"):
        _dry_state["status"] = "STAGING"
        _dry_state["transition_to"] = "RUNNING"
        _dry_state["transition_at"] = _now() + _DRY_PROVISION_S


def _dry_stop_instance():
    _dry_advance()
    if _dry_state["status"] in ("RUNNING", "STAGING", "PROVISIONING"):
        _dry_state["status"] = "STOPPING"
        _dry_state["transition_to"] = "TERMINATED"
        _dry_state["transition_at"] = _now() + _DRY_STOP_S


# ---------------------------------------------------------------------------
# Dispatch unificado: escolhe DRY_RUN vs GCP real.
# ---------------------------------------------------------------------------


def get_instance():
    """Retorna (STATE_do_contrato, external_ip_or_None)."""
    if DRY_RUN:
        status, ip = _dry_get_instance()
    else:
        status, ip = _gcp_get_instance()
    return _map_gcp_status(status), ip


def vm_base_url():
    """URL base do backend de compute na VM (ou o DRY_RUN_VM_URL)."""
    if DRY_RUN:
        return DRY_RUN_VM_URL
    _, ip = get_instance()
    if not ip:
        return None
    return f"http://{ip}:{VM_PORT}"


def start_instance_locked():
    """Liga a VM se parada, aperta o firewall, fixa o lease. Sob _state_lock."""
    global _started_at, _lease_expires_at
    state, _ = get_instance()
    if state == STATE_RUNNING:
        # Já rodando: renova o lease e retorna rápido (idempotente). Reaperta o
        # firewall pro IP de saída atual caso o laptop tenha trocado de rede
        # desde o start — senão os proxies /density|/single bateriam num /32
        # velho e seriam bloqueados na borda do GCP. No-op se o IP não mudou.
        if not DRY_RUN:
            _gcp_tighten_firewall(_detect_egress_ip())
        _renew_lease_locked()
        return state
    if state in (STATE_PROVISIONING, STATE_STOPPING):
        # Transição em curso: não dispara de novo, só garante o lease.
        if _started_at is None:
            _started_at = _now()
        _renew_lease_locked()
        return state

    # Parada (ou erro): liga.
    if DRY_RUN:
        _dry_start_instance()
    else:
        _gcp_start_instance()
        egress = _detect_egress_ip()
        _gcp_tighten_firewall(egress)

    _started_at = _now()
    _renew_lease_locked()
    state, _ = get_instance()
    return state


def stop_instance_locked():
    """Desliga a VM agora e zera o lease. Sob _state_lock."""
    global _started_at, _lease_expires_at
    if DRY_RUN:
        _dry_stop_instance()
    else:
        _gcp_stop_instance()
    _lease_expires_at = None
    _started_at = None
    state, _ = get_instance()
    return state


def _renew_lease_locked():
    """Define lease = now+LEASE_S, sem ultrapassar started_at+HARD_CAP_S."""
    global _lease_expires_at
    now = _now()
    deadline = now + LEASE_S
    if _started_at is not None:
        hard = _started_at + HARD_CAP_S
        if deadline > hard:
            deadline = hard
    _lease_expires_at = deadline
    return _lease_expires_at


def idle_seconds():
    """Segundos desde o último start (proxy do tempo ligado); 0 se parada."""
    if _started_at is None:
        return 0
    return max(0, int(_now() - _started_at))


# ---------------------------------------------------------------------------
# Varredor: para a VM por idle (lease vencido) ou hard-cap.
# ---------------------------------------------------------------------------


def _sweeper():
    while True:
        time.sleep(SWEEP_INTERVAL_S)
        try:
            with _state_lock:
                if _started_at is None:
                    continue
                now = _now()
                lease_done = _lease_expires_at is not None and now > _lease_expires_at
                hard_done = (now - _started_at) > HARD_CAP_S
                if lease_done or hard_done:
                    reason = "hard-cap" if hard_done else "lease vencido"
                    log.info("varredor parando a VM (%s)", reason)
                    try:
                        stop_instance_locked()
                    except Exception as e:  # noqa: BLE001
                        log.warning("falha ao parar no varredor: %s", e)
        except Exception as e:  # noqa: BLE001
            log.warning("erro no varredor: %s", e)


# ---------------------------------------------------------------------------
# Espera a VM ficar saudável (poll do /health) — usado pelo proxy de compute.
# ---------------------------------------------------------------------------


def _vm_health_once(base):
    """Tenta GET base/health; retorna o dict do JSON ou None."""
    try:
        r = requests.get(f"{base}/health", timeout=(5, 8))
        if r.status_code == 200:
            return r.json()
    except Exception:  # noqa: BLE001
        return None
    return None


def ensure_running_and_healthy(deadline_s=HEALTH_WAIT_S):
    """Garante VM RUNNING + /health ok, ligando se preciso. Bloqueia até ~deadline_s.

    Retorna (base_url, health_dict) em sucesso, ou (None, None) se estourou.
    """
    # Auto-start (idempotente) sob o lock.
    with _state_lock:
        state = start_instance_locked()

    start = _now()
    while (_now() - start) < deadline_s:
        base = vm_base_url()
        if base:
            h = _vm_health_once(base)
            if h and h.get("ok"):
                # Renova o lease a cada compute proxied bem-sucedido.
                with _state_lock:
                    _renew_lease_locked()
                return base, h
        time.sleep(HEALTH_POLL_INTERVAL_S)
        # Re-verifica o estado (pode ter virado RUNNING durante a espera).
        with _state_lock:
            start_instance_locked()
    return None, None


# ---------------------------------------------------------------------------
# Flask
# ---------------------------------------------------------------------------

app = Flask(__name__)


@app.after_request
def _cors(resp):
    # CORS permissivo: o applet em http://localhost:* é outra origem (porta).
    origin = request.headers.get("Origin", "*")
    resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/<path:_any>", methods=["OPTIONS"])
@app.route("/", methods=["OPTIONS"])
def _preflight(_any=None):
    # Preflight: o after_request já põe os headers de CORS.
    return ("", 204)


# ----- Proxy de compute (espelha o backend Rust byte a byte) -----------------


def _gzip_stream(src, chunk=1 << 20):
    """Comprime `src` (file-like com .read) em gzip, em streaming — encolhe o
    upload do DEM (~675 MB) no caminho caro laptop→VM sem bufferizar o corpo
    inteiro. Nível 1 (rápido); o backend Rust descomprime (Content-Encoding: gzip).
    """
    co = zlib.compressobj(1, zlib.DEFLATED, 16 + zlib.MAX_WBITS)  # 16+ = formato gzip
    while True:
        buf = src.read(chunk)
        if not buf:
            break
        out = co.compress(buf)
        if out:
            yield out
    tail = co.flush()
    if tail:
        yield tail


def _stream_proxy(path):
    """Proxy de stream bidirecional p/ VM_IP:VM_PORT/<path>. Não bufferiza."""
    base, _ = ensure_running_and_healthy()
    if not base:
        # Não conseguiu subir/ficar saudável a tempo.
        state, _ = get_instance()
        return jsonify({"ok": False, "vmState": _vm_state_lower(state)}), 503

    try:
        # Upload: gzip em streaming (encolhe o hop caro laptop→VM). Download:
        # X-Simu-Gzip faz a VM gzipar a resposta; Accept-Encoding faz o requests
        # DESCOMPRIMIR no iter_content => o navegador recebe bytes crus (sem mudar
        # o parser). stream=True => nada bufferizado inteiro. read timeout=None
        # pois um compute grande demora.
        upstream = requests.post(
            f"{base}{path}",
            data=_gzip_stream(request.stream),
            headers={
                "Content-Type": request.headers.get(
                    "Content-Type", "application/octet-stream"
                ),
                "Content-Encoding": "gzip",  # comprimimos o upload; a VM descomprime
                "X-Simu-Gzip": "1",          # opta a VM por gzipar a resposta
                "Accept-Encoding": "gzip",   # requests descomprime o download sozinho
            },
            stream=True,
            timeout=(10, None),
        )
    except Exception as e:  # noqa: BLE001
        log.warning("falha no proxy p/ %s%s: %s", base, path, e)
        state, _ = get_instance()
        return jsonify({"ok": False, "vmState": _vm_state_lower(state)}), 502

    ctype = upstream.headers.get("Content-Type", "application/octet-stream")

    def _gen():
        try:
            for chunk in upstream.iter_content(chunk_size=1 << 20):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(
        stream_with_context(_gen()),
        status=upstream.status_code,
        content_type=ctype,
    )


@app.route("/health", methods=["GET"])
def health():
    """Proxy do /health da VM + idle_seconds. Resposta rápida quando não pronta.

    Quando pronta: {"ok":true,"version":..,"cores":INT,"mem_budget_bytes":INT,
                    "idle_seconds":INT}
    Quando não:    {"ok":false,"vmState":"stopped|provisioning|running|stopping|error"}
    """
    state, _ = get_instance()
    if state != STATE_RUNNING:
        # GET /health rápido: não auto-start aqui, devolve o estado na hora.
        return jsonify({"ok": False, "vmState": _vm_state_lower(state)})

    base = vm_base_url()
    h = _vm_health_once(base) if base else None
    if not h or not h.get("ok"):
        # RUNNING mas /health ainda não responde (boot do backend).
        return jsonify({"ok": False, "vmState": "provisioning"})

    # Mescla idle_seconds no health proxied (snake_case — campo do backend Rust).
    h = dict(h)
    h["idle_seconds"] = idle_seconds()
    # Renova lease ao confirmar saúde por uso interativo.
    with _state_lock:
        _renew_lease_locked()
    return jsonify(h)


@app.route("/density", methods=["POST"])
def density():
    return _stream_proxy("/density")


@app.route("/single", methods=["POST"])
def single():
    return _stream_proxy("/single")


# ----- Ciclo de vida da VM (consumido pela máquina de estados do frontend) ---


@app.route("/cloud/start", methods=["POST"])
def cloud_start():
    """Liga a instância pré-assada, aperta o firewall, fixa o lease. Idempotente.

    Retorna {"state":STATE,"etaSeconds":INT}.
    """
    with _state_lock:
        prev_state, _ = get_instance()
        state = start_instance_locked()

    if state == STATE_RUNNING:
        eta = 0
    elif prev_state in (STATE_STOPPED, STATE_ERROR):
        eta = 45  # estimativa de boot a frio (VM + backend)
    else:
        eta = 30  # já provisionando
    return jsonify({"state": state, "etaSeconds": eta})


@app.route("/cloud/status", methods=["GET"])
def cloud_status():
    """Retorna estado + saúde + recursos + lease + IP externo.

    {"state":STATE,"healthy":BOOL,"cores":INT_OR_NULL,
     "memBudgetBytes":INT_OR_NULL,"leaseExpiresAt":UNIXSECONDS_OR_NULL,
     "externalIp":STRING_OR_NULL}
    """
    state, ip = get_instance()
    healthy = False
    cores = None
    mem_budget = None
    if state == STATE_RUNNING:
        base = vm_base_url()
        h = _vm_health_once(base) if base else None
        if h and h.get("ok"):
            healthy = True
            c = h.get("cores")
            cores = int(c) if isinstance(c, (int, float)) else None
            mb = h.get("mem_budget_bytes")
            mem_budget = int(mb) if isinstance(mb, (int, float)) else None

    lease = int(_lease_expires_at) if _lease_expires_at is not None else None
    return jsonify({
        "state": state,
        "healthy": healthy,
        "cores": cores,
        "memBudgetBytes": mem_budget,
        "leaseExpiresAt": lease,
        "externalIp": ip,
    })


@app.route("/cloud/keepalive", methods=["POST"])
def cloud_keepalive():
    """Estende o lease. Retorna {"leaseExpiresAt":UNIXSECONDS}."""
    global _started_at
    with _state_lock:
        if _started_at is None:
            # Sem VM ligada: ancora started_at agora p/ o hard-cap valer.
            _started_at = _now()
        lease = _renew_lease_locked()
    return jsonify({"leaseExpiresAt": int(lease)})


@app.route("/cloud/stop", methods=["POST"])
def cloud_stop():
    """Para a instância agora. Retorna {"state":STATE}."""
    with _state_lock:
        state = stop_instance_locked()
    return jsonify({"state": state})


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------


def _log_config():
    log.info("Orquestrador Simujoules — plano de controle+proxy local")
    log.info("  bind            : 127.0.0.1:%d", ORCH_PORT)
    log.info("  DRY_RUN         : %s", DRY_RUN)
    if DRY_RUN:
        log.info("  DRY_RUN_VM_URL  : %s", DRY_RUN_VM_URL)
    else:
        log.info("  GCP_PROJECT     : %s", GCP_PROJECT)
        log.info("  GCP_ZONE        : %s", GCP_ZONE)
        log.info("  INSTANCE_NAME   : %s", INSTANCE_NAME)
        log.info("  FIREWALL_RULE   : %s", FIREWALL_RULE)
    log.info("  VM_PORT         : %d", VM_PORT)
    log.info("  LEASE_S         : %d", LEASE_S)
    log.info("  IDLE_MAX_S      : %d", IDLE_MAX_S)
    log.info("  HARD_CAP_S      : %d", HARD_CAP_S)


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    _log_config()
    # Varredor de lease/idle/hard-cap.
    threading.Thread(target=_sweeper, name="sweeper", daemon=True).start()
    # threaded=True: várias threads, UM processo (estado de lease compartilhado).
    app.run(host="127.0.0.1", port=ORCH_PORT, threaded=True)


if __name__ == "__main__":
    main()
