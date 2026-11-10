// The Leaflet map: panes + layer order, address search, basemaps.
import "./boot.js"; // evaluation order — see ../app.js
import { currentLang, t } from "./i18n.js";
import { state } from "./state.js";
import { refRedo, refUndo } from "./points.js";

// attributionControl:false — the on-map attribution strip is removed; the same
// credits live in the help modal instead (the per-layer `attribution:` strings
// below are kept for the record / in case the control is ever re-enabled).
export const map = L.map("map", { preferCanvas: true, attributionControl: false }).setView([-23.55, -46.63], 12);
// Leaflet-Geoman's own draw-hint tooltips ("Click to place first vertex", …)
// are English by default and ignore our STRINGS/t() pipeline — set its
// locale to match ours (setLang() re-applies this on toggle).
if (map.pm) map.pm.setLang(currentLang === "pt" ? "pt_br" : "en");

// Explicit stacking for the analysis layers, between Leaflet's default
// overlayPane (z 400) and markerPane (z 600). Without dedicated panes all
// of these share overlayPane and the z-order is whatever DOM order the
// rebuilds produce — notably the drawn vector network used to land above
// or below the passes overlay depending on which was refreshed last.
// The order is user-editable via the "Layer stacking order" modal and
// persisted to localStorage. Default, bottom → top:
// relief < energy < network lines < passes < routes/path.
const LAYER_PANES = {
  relief:     "reliefPane",
  impassable: "impassablePane",
  energy:     "energyPane",
  network:    "networkPane",
  passes:     "passesPane",
  refgeom:    "refgeomPane",
  routes:     "routesPane",
};
export const DEFAULT_LAYER_ORDER = ["relief", "impassable", "energy", "network", "passes", "refgeom", "routes"]; // bottom → top
export let layerOrder = DEFAULT_LAYER_ORDER.slice();
export function setLayerOrder(order) { layerOrder = order; }
try {
  const saved = JSON.parse(localStorage.getItem("simu-layer-order") || "null");
  if (
    Array.isArray(saved) &&
    saved.length === DEFAULT_LAYER_ORDER.length &&
    DEFAULT_LAYER_ORDER.every((k) => saved.includes(k))
  ) {
    layerOrder = saved;
  }
} catch {}
for (const pane of Object.values(LAYER_PANES)) map.createPane(pane);

export function applyLayerOrder() {
  layerOrder.forEach((key, i) => {
    const pane = map.getPane(LAYER_PANES[key]);
    if (pane) pane.style.zIndex = String(401 + i);
  });
  try { localStorage.setItem("simu-layer-order", JSON.stringify(layerOrder)); } catch {}
}
applyLayerOrder();

// ------- Busca de endereços (geocoding) -------
// Botão 🔍 estacionado na coluna de controles top-left do Leaflet (abaixo do
// zoom +/−), com typeahead via Photon (komoot) — feito pra autocomplete, ao
// contrário do Nominatim, cuja política de uso PROÍBE typeahead. Mesma
// implementação da amora, REDUZIDA de propósito: escolher um resultado APENAS
// voa até o lugar (flyTo) — sem pino, sem waypoint, sem estado persistido.
// Infra que acompanha: photon.komoot.io no connect-src do CSP (index.html) e
// isento do runtime-cache do sw.js (cache-first congelaria cada consulta).
const geoSearchBtn = document.getElementById("geo-search-btn");
const geoSearchPanel = document.getElementById("geo-search-panel");
const geoSearchInput = document.getElementById("geo-search-input");
const geoSearchList = document.getElementById("geo-search-results");
const geoSearchStatus = document.getElementById("geo-search-status");
let geoSearchTimer = null;
let geoSearchAbort = null;     // AbortController da busca em voo (latest-wins)
let geoSearchResults = [];
let geoSearchLastQuery = "";   // query dos resultados exibidos (p/ Enter direto)
let geoSearchActiveIdx = -1;   // item destacado via ↑/↓

// Estaciona o botão na coluna do Leaflet — só aí ele ganha display (o CSS
// esconde .geo-search-btn fora de .leaflet-control-container, então um erro
// antes deste ponto nunca deixa um botão órfão no fluxo do <body>).
{
  const leafletTopLeft = document.querySelector(".leaflet-top.leaflet-left");
  if (geoSearchBtn && leafletTopLeft) {
    leafletTopLeft.appendChild(geoSearchBtn);
    L.DomEvent.disableClickPropagation(geoSearchBtn);
    L.DomEvent.disableScrollPropagation(geoSearchBtn);
  }
  // Undo/redo of the reference set: a zoom-style bar parked right under 🔍
  // (same hide-outside-the-Leaflet-container rule). Buttons are disabled
  // while their stack is empty (updateRefHistoryButtons).
  const refHistoryBar = document.getElementById("ref-history-bar");
  if (refHistoryBar && leafletTopLeft) {
    leafletTopLeft.appendChild(refHistoryBar);
    L.DomEvent.disableClickPropagation(refHistoryBar);
    L.DomEvent.disableScrollPropagation(refHistoryBar);
    document.getElementById("ref-undo-btn")?.addEventListener("click", refUndo);
    document.getElementById("ref-redo-btn")?.addEventListener("click", refRedo);
    // (Both start `disabled` in the markup; `state` is declared further down,
    // so the first updateRefHistoryButtons() runs on the first push.)
  }
  // Ctrl/⌘+Z undoes, Ctrl/⌘+Shift+Z or Ctrl/⌘+Y redoes — only outside text
  // inputs (their native undo must keep working) and only when there is a
  // step to take, so the browser default is otherwise untouched.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) return;
    const key = e.key.toLowerCase();
    const redo = (key === "z" && e.shiftKey) || key === "y";
    const undo = key === "z" && !e.shiftKey;
    if (redo && state.refHistory.future.length) { e.preventDefault(); refRedo(); }
    else if (undo && state.refHistory.past.length) { e.preventDefault(); refUndo(); }
  });
}

async function photonGeocode(query) {
  geoSearchAbort?.abort();
  const ctrl = new AbortController();
  geoSearchAbort = ctrl;
  const c = map.getCenter();
  // lat/lon + location_bias_scale puxam o ranking pro que está na tela (São
  // Paulo na prática) sem excluir o resto; sem `lang` — o Photon só tem
  // en/de/fr e resultados BR já vêm em português por padrão.
  const url = "https://photon.komoot.io/api/?" + new URLSearchParams({
    q: query,
    limit: "6",
    lat: c.lat.toFixed(5),
    lon: c.lng.toFixed(5),
    location_bias_scale: "0.4",
    zoom: String(Math.min(16, Math.round(map.getZoom()))),
  });
  const resp = await fetch(url, { signal: ctrl.signal });
  if (!resp.ok) throw new Error(`Photon HTTP ${resp.status}`);
  const data = await resp.json();
  const seen = new Set();
  const items = [];
  for (const f of data.features || []) {
    const p = f.properties || {};
    const [lng, lat] = f.geometry?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = p.osm_id != null ? `${p.osm_type || ""}/${p.osm_id}` : `${lat},${lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = p.name || [p.street, p.housenumber].filter(Boolean).join(", ");
    if (!label) continue;
    const detail = [p.district, p.city, p.state].filter(Boolean).join(", ");
    items.push({ label, detail, lat, lng });
  }
  return items;
}

// O painel é position:fixed — ancora direto no rect (viewport) do botão na
// hora de abrir (a posição varia com zoom control oculto no mobile etc.).
function positionGeoSearchPanel() {
  const btnRect = geoSearchBtn.getBoundingClientRect();
  if (window.innerWidth <= 600) {
    // Tela estreita: largura (quase) toda, abaixo do botão. width:auto
    // libera o esticamento left+right (o CSS fixa 320px pro desktop).
    geoSearchPanel.style.top = `${Math.round(btnRect.bottom + 6)}px`;
    geoSearchPanel.style.left = "8px";
    geoSearchPanel.style.right = "8px";
    geoSearchPanel.style.width = "auto";
  } else {
    geoSearchPanel.style.top = `${Math.round(btnRect.top)}px`;
    geoSearchPanel.style.left = `${Math.round(btnRect.right + 8)}px`;
    geoSearchPanel.style.right = "auto";
    geoSearchPanel.style.width = "";
  }
}

function setGeoSearchStatus(msg) {
  geoSearchStatus.textContent = msg;
  geoSearchStatus.hidden = !msg;
}

function openGeoSearch() {
  positionGeoSearchPanel();
  geoSearchPanel.hidden = false;
  geoSearchBtn.setAttribute("aria-pressed", "true");
  geoSearchInput.focus();
  geoSearchInput.select();
}

function closeGeoSearch() {
  clearTimeout(geoSearchTimer);
  geoSearchAbort?.abort();
  geoSearchPanel.hidden = true;
  geoSearchBtn.setAttribute("aria-pressed", "false");
  setGeoSearchStatus("");
  renderGeoSearchResults([]);
}

function renderGeoSearchResults(items) {
  geoSearchResults = items;
  geoSearchActiveIdx = -1;
  geoSearchInput.removeAttribute("aria-activedescendant");
  geoSearchList.textContent = "";
  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.id = `geo-search-opt-${i}`;
    li.setAttribute("role", "option");
    const label = document.createElement("span");
    label.className = "geo-search-label";
    label.textContent = item.label;   // textContent — nunca innerHTML (dado externo)
    li.appendChild(label);
    if (item.detail) {
      const detail = document.createElement("span");
      detail.className = "geo-search-detail";
      detail.textContent = item.detail;
      li.appendChild(detail);
    }
    li.addEventListener("click", () => pickGeoSearchResult(item));
    geoSearchList.appendChild(li);
  });
}

function setGeoSearchActive(idx) {
  const rows = geoSearchList.children;
  if (!rows.length) return;
  geoSearchActiveIdx = ((idx % rows.length) + rows.length) % rows.length;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle("is-active", i === geoSearchActiveIdx);
  }
  const active = rows[geoSearchActiveIdx];
  geoSearchInput.setAttribute("aria-activedescendant", active.id);
  active.scrollIntoView({ block: "nearest" });
}

async function runGeoSearch() {
  const q = geoSearchInput.value.trim();
  if (q.length < 3) {
    geoSearchAbort?.abort();
    renderGeoSearchResults([]);
    setGeoSearchStatus("");
    return;
  }
  setGeoSearchStatus(t("geosearch.searching"));
  try {
    const items = await photonGeocode(q);
    geoSearchLastQuery = q;
    renderGeoSearchResults(items);
    setGeoSearchStatus(items.length ? "" : t("geosearch.none"));
  } catch (err) {
    if (err.name === "AbortError") return; // superada por uma busca mais nova
    console.warn("[geo-search]", err);
    renderGeoSearchResults([]);
    setGeoSearchStatus(t("geosearch.net_error"));
  }
}

// A única ação: fechar o painel e voar até o lugar. Nada de pino/marcador —
// requisito do recurso; o mapa aqui é palco de campos de energia, não de POIs.
function pickGeoSearchResult(item) {
  closeGeoSearch();
  map.flyTo(L.latLng(item.lat, item.lng), Math.max(map.getZoom(), 15));
}

geoSearchBtn?.addEventListener("click", () => {
  if (geoSearchPanel.hidden) openGeoSearch();
  else closeGeoSearch();
});
geoSearchInput?.addEventListener("input", () => {
  clearTimeout(geoSearchTimer);
  geoSearchTimer = setTimeout(runGeoSearch, 350);
});
geoSearchInput?.addEventListener("keydown", (e) => {
  // Nada daqui deve vazar pros handlers globais (Esc fecha modais).
  e.stopPropagation();
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setGeoSearchActive(geoSearchActiveIdx + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setGeoSearchActive(geoSearchActiveIdx - 1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const q = geoSearchInput.value.trim();
    if (geoSearchActiveIdx >= 0 && geoSearchResults[geoSearchActiveIdx]) {
      pickGeoSearchResult(geoSearchResults[geoSearchActiveIdx]);
    } else if (geoSearchResults.length && q === geoSearchLastQuery) {
      pickGeoSearchResult(geoSearchResults[0]);
    } else {
      clearTimeout(geoSearchTimer);
      runGeoSearch();
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeGeoSearch();
  }
});

// ------- Basemap -------
// Selectable via the #basemap-select dropdown. Tile entries swap the base
// tile layer; "none-*" entries remove it and paint the map container a
// solid colour (overlays, markers and the optional rmsampa-v2 tiles are
// unaffected — they live in higher panes).
const BASEMAPS = {
  "osm": {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: { attribution: "© OpenStreetMap contributors", maxZoom: 19 },
  },
  "carto-dark": {
    url: "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
    options: {
      attribution: "© OpenStreetMap contributors © CARTO",
      subdomains: "abcd",
      maxZoom: 20,
    },
  },
  "carto-light": {
    url: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
    options: {
      attribution: "© OpenStreetMap contributors © CARTO",
      subdomains: "abcd",
      maxZoom: 20,
    },
  },
  "esri-satellite": {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: { attribution: "© Esri, Maxar, Earthstar Geographics", maxZoom: 19 },
  },
  "none-black": { color: "#000000" },
  "none-white": { color: "#ffffff" },
  "none-gray":  { color: "#808080" },
};

let baseTileLayer = null;
export function applyBasemap(key) {
  const def = BASEMAPS[key] || BASEMAPS.osm;
  if (baseTileLayer) { baseTileLayer.remove(); baseTileLayer = null; }
  const container = document.getElementById("map");
  if (def.url) {
    // zIndex 0 keeps the basemap UNDER the rmsampa hydrography overlay (z 10).
    baseTileLayer = L.tileLayer(def.url, { ...def.options, zIndex: 0 }).addTo(map);
    if (container) container.style.background = "";
  } else if (container) {
    container.style.background = def.color;
  }
}
applyBasemap("osm");
