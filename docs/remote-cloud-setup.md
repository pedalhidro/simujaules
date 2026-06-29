# Setup runbook — `simujaules.pedalhidrografi.co` + remote cloud compute

End-to-end provisioning for (A) hosting the static app on its own subdomain and
(B) running the "Nuvem (VM orquestrada)" compute feature when the app is accessed
**remotely** (not just localhost).

> **These commands create BILLABLE resources** (a GCS bucket, a Cloud Run
> service, a spot VM, Cloud Scheduler). Run them yourself, aware of cost. The
> code (this branch) is already done; this is the infra it expects. Defaults:
> project `pedal-hidrografico`, region `southamerica-east1`, zone
> `southamerica-east1-a`. Cloudflare fronts the `pedalhidrografi.co` zone.

```sh
export PROJECT=pedal-hidrografico
export REGION=southamerica-east1
export ZONE=southamerica-east1-a
gcloud config set project "$PROJECT"
```

---

## Part A — static site on the new domain

### A1. Bucket + data

```sh
gcloud storage buckets create gs://simujaules --location=$REGION --uniform-bucket-level-access
# Public read (it's a public site; Cloudflare fronts it):
gcloud storage buckets add-iam-policy-binding gs://simujaules \
  --member=allUsers --role=roles/storage.objectViewer

# Copy the census FlatGeobuf (NOT shipped by deploy.sh) to the new bucket:
gcloud storage cp gs://telhas/simujoules/census/setores_br_pop.fgb \
  gs://simujaules/census/setores_br_pop.fgb
# Its CORS (HTTP Range from the browser) — reuse the telhas config or set:
printf '[{"origin":["*"],"method":["GET","HEAD"],"responseHeader":["Content-Type","Range"],"maxAgeSeconds":3600}]' > /tmp/cors.json
gcloud storage buckets update gs://simujaules --cors-file=/tmp/cors.json
```

### A2. Deploy the app

```sh
# From the repo root. (CF_API_TOKEN/CF_ZONE_ID optional — enables cache purge.)
export CF_ZONE_ID=<zone id for pedalhidrografi.co>
export CF_API_TOKEN=<token with Zone > Cache Purge>
./deploy.sh
```

### A3. Cloudflare (dashboard)

`telhas` is fronted by a Cloudflare **Cloud Connector** (Rules → Cloud Connector)
that routes the host to the GCS bucket — that's the load-bearing piece, NOT an
Origin/Page Rule (telhas has none). The Connector issues the GCS request so the
bucket serves; a plain proxied CNAME alone gives `NoSuchBucket`, because
Cloudflare forwards `Host: telhas.pedalhidrografi.co`, which GCS reads as a
bucket name. Mirror telhas:

1. **DNS**: add a **proxied** (orange-cloud) record for `simujaules` — a CNAME to
   `simujaules.storage.googleapis.com` (same as telhas).
2. **Cloud Connector (the fix)**: Rules → **Cloud Connector** → add a connector
   for `simujaules.pedalhidrografi.co` → the `gs://simujaules` bucket (mirror
   telhas's connector). Without it: `NoSuchBucket`; with it the bucket serves
   (verified: `/index.html`, `/sw.js`, … → 200).
3. **Root → `index.html`**: GCS's `mainPageSuffix` is NOT honored over the
   Connector path (the bucket root returns the XML object listing), so map the
   bare `/` Cloudflare-side — the Connector's default/index-document option if it
   has one, or a **Transform Rule → Rewrite URL**: *when* URI Path equals `/`,
   *rewrite* path to `/index.html`. (Explicit `/index.html` already serves.) The
   bucket also has `--web-main-page-suffix=index.html` set (mirrors telhas;
   harmless even though the Connector path ignores it).
4. **Cache rule**: bypass cache for URI path ending `/sw.js` on the new host
   (and Browser Cache TTL = "Respect Existing Headers") — or SW updates stall.
5. **Redirect (keeps old bundles working)**: 301
   `telhas.pedalhidrografi.co/simujoules/*` → `simujaules.pedalhidrografi.co/$1`.
   The RDF `@vocab` IRI deliberately stays on telhas and resolves via this
   redirect — **do not** delete `gs://telhas/simujoules/` until it's verified.

Verify: load `https://simujaules.pedalhidrografi.co/`, install the PWA, confirm
example DEMs/census load, and that the old `/simujoules/` URL 301s.

---

## Part B — remote cloud compute

### B1. Secrets (Secret Manager)

```sh
# Shared app/cloud password (app field + orchestrator + Caddy on the VM):
printf '%s' "$(openssl rand -base64 24)" | gcloud secrets create simu-cloud-token --data-file=-
# Cloudflare API token, scoped to DNS:Edit on the pedalhidrografi.co zone
# (create it in the Cloudflare dashboard → My Profile → API Tokens):
printf '%s' "<cloudflare-dns-edit-token>" | gcloud secrets create simu-cf-dns-token --data-file=-
# Admin token for the daily reaper (Cloud Scheduler only):
printf '%s' "$(openssl rand -base64 24)" | gcloud secrets create simu-reap-token --data-file=-
```

Note the `simu-cloud-token` value — it's the **Cloud password** users type in the
app. Distribute it to trusted members only.

### B2. Service accounts + IAM

```sh
PNUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

# (a) VM runtime SA — only needs to read the startup-script from GCS.
gcloud iam service-accounts create simu-compute --display-name="Simujaules compute VM"
VM_SA="simu-compute@${PROJECT}.iam.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding gs://simujaules \
  --member="serviceAccount:${VM_SA}" --role=roles/storage.objectViewer

# (b) Orchestrator SA — custom role for the VM lifecycle + firewall.
gcloud iam service-accounts create simu-orchestrator --display-name="Simujaules orchestrator (Cloud Run)"
ORCH_SA="simu-orchestrator@${PROJECT}.iam.gserviceaccount.com"
gcloud iam roles create simu_orchestrator --project="$PROJECT" \
  --title="Simujaules orchestrator" \
  --permissions=compute.instances.get,compute.instances.start,compute.instances.stop,compute.instances.create,compute.instances.delete,compute.instances.setMetadata,compute.disks.create,compute.firewalls.get,compute.firewalls.update,compute.zoneOperations.get,compute.zones.get,compute.machineTypes.get,compute.images.useReadOnly,compute.subnetworks.use,compute.subnetworks.useExternalIp,compute.networks.use
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${ORCH_SA}" --role="projects/${PROJECT}/roles/simu_orchestrator"
# actAs the VM SA (needed to CREATE the instance with that SA):
gcloud iam service-accounts add-iam-policy-binding "$VM_SA" \
  --member="serviceAccount:${ORCH_SA}" --role=roles/iam.serviceAccountUser
# Read the 3 secrets:
for s in simu-cloud-token simu-cf-dns-token simu-reap-token; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${ORCH_SA}" --role=roles/secretmanager.secretAccessor
done
```

### B3. Cloudflare DNS records (dashboard)

- `compute.simujaules.pedalhidrografi.co` — **A record, DNS-only (grey cloud)**,
  TTL 60s, placeholder content `192.0.2.1`. The orchestrator rewrites it to the
  VM's ephemeral IP on each start. **Grey cloud is required** — compute payloads
  (>1 GB) must not traverse Cloudflare's proxy.
- `orch.simujaules.pedalhidrografi.co` — points at the Cloud Run service (set up
  after B6 via a Cloud Run domain mapping, or proxied CNAME to the `.run.app`
  host). Tiny payloads, so proxied (orange) is fine. (Or skip and just paste the
  `.run.app` URL into the app's Orchestrator URL field.)

### B4. Publish the startup-script to GCS (for create-when-missing)

```sh
gcloud storage cp vm/startup-script.sh gs://simujaules/vm/startup-script.sh
# Re-run this whenever vm/startup-script.sh changes.
```

### B5. (Optional) Bake the VM once, or let the orchestrator create it

The orchestrator **creates the VM on demand** if it's absent, so baking is
optional. To pre-bake (faster first run), pass the tokens so Caddy is configured:

```sh
CLOUD_AUTH_TOKEN="$(gcloud secrets versions access latest --secret=simu-cloud-token)" \
CF_API_TOKEN="$(gcloud secrets versions access latest --secret=simu-cf-dns-token)" \
  ./vm/bake-instance.sh --dry-run   # inspect first; drop --dry-run to run (BILLABLE)
```

Tip: build a release backend binary once and host it (e.g. `gs://simujaules/vm/`)
so cold creates skip the ~10-min Rust compile — set `BACKEND_BINARY_URL`.

### B6. Deploy the orchestrator (Cloud Run)

```sh
cd orchestrator
CF_ZONE_ID=<zone id> SERVICE_ACCOUNT="$ORCH_SA" VM_SERVICE_ACCOUNT="$VM_SA" \
  ./deploy-orchestrator.sh
```

This sets `--allow-unauthenticated` (auth is the app-level Bearer token) and
mounts the 3 secrets as env. Note the printed URL; map
`orch.simujaules.pedalhidrografi.co` to it (B3) or use the URL directly.

### B7. Daily reaper (Cloud Scheduler) — delete the VM after 30 days idle

```sh
ORCH_URL=$(gcloud run services describe simu-orchestrator --region=$REGION --format='value(status.url)')
gcloud scheduler jobs create http simu-reap --location=$REGION \
  --schedule='17 4 * * *' --uri="${ORCH_URL}/cloud/reap" --http-method=POST \
  --headers="Authorization=Bearer $(gcloud secrets versions access latest --secret=simu-reap-token)"
```

### B8. Billing budget alert (recommended backstop)

Create a budget + threshold alert on the project in the Billing console — the
last line of defense if everything else fails to stop the VM.

### B9. Verify

1. App `Set the orchestrator URL` (Cloud Run URL or `orch.…`) + the **Cloud
   password** (`simu-cloud-token` value), select **Nuvem**, run a small DEM:
   boot → DNS updates to the VM IP → firewall tightens to your browser IP →
   compute streams direct over HTTPS → result → VM stops after the run.
2. Wrong password → falls back to browser with "senha incorreta".
3. Delete the VM (`/cloud/delete` or console), run again → it recreates from
   scratch (longer "Criando…" ETA, fresh DNS-01 cert).
4. Reaper: temporarily set `REAP_IDLE_DAYS` low to confirm `/cloud/reap` deletes
   a stopped VM, then restore 30.

---

## Cost summary

- Static site: GCS + Cloudflare (cents).
- Cloud Run orchestrator: ~$0 idle (scales to zero).
- Compute VM: billed only while RUNNING (spot). Stopped = boot disk (~$2/mo)
  until the 30-day reaper **deletes** it → ~$0. Recreated on demand.
- Guardrails: spot + firewall-/32 + shared password + in-VM idle-watchdog
  (+ max-uptime cap) + 30-day reaper + billing alert.
