// PT/EN STRINGS table, t(), applyTranslations(), setLang().
import { map } from "./map.js";
import { state } from "./state.js";
import { updateBridgeMeta } from "./bridges.js";
import { updateImpassableMeta } from "./water.js";
import { syncRefDisplay } from "./points.js";
import { estimateRunTime } from "./estimate.js";

// ============================================================================
// i18n
// ============================================================================
// Tiny translation layer: a single STRINGS dict, plus three hooks:
//   t(key, ...args)     — look up the current-language string, optional
//                          {0}/{1} placeholder substitution.
//   applyTranslations() — walks the DOM and substitutes textContent /
//                          innerHTML / title for every [data-i18n*] element.
//   setLang(lang)       — flips the active language (persists in localStorage)
//                          and re-applies.
//
// HTML elements opt in via:
//   data-i18n="key"       → textContent
//   data-i18n-html="key"  → innerHTML  (use for strings with markup)
//   data-i18n-title="key" → title attribute
//   data-i18n-aria="key"  → aria-label (controls with no visible label)
//
// JS-set strings (status messages, computed labels) call t("key") directly.

const STRINGS = {
  // ---- Header / chrome --------------------------------------------------
  "title":               { pt: "Simujaules",       en: "Simujaules" },
  "subtitle":            { pt: "Imaginador de caminhos fáceis para o encontro", en: "Imagining easy paths to the gathering" },
  "lang.toggle.title":   { pt: "Idioma — clique para alternar PT/EN", en: "Language — click to switch PT/EN" },
  // (engine.* strings removed along with the engine-tag pill.)
  "locate.title":        { pt: "Centralizar na minha localização",     en: "Center on my location" },
  "map.zoom_in":         { pt: "Aproximar",                             en: "Zoom in" },
  "map.zoom_out":        { pt: "Afastar",                               en: "Zoom out" },
  "locate.requesting":   { pt: "Buscando localização…",                 en: "Locating…" },
  "locate.centered":     { pt: "Centralizado em {0}, {1}.",             en: "Centred at {0}, {1}." },
  "locate.denied":       { pt: "Acesso à localização negado.",          en: "Location access denied." },
  // Busca de endereços (🔍 geocoding via Photon; ver o bloco geo-search).
  "geosearch.title":       { pt: "Buscar endereço ou lugar",  en: "Search address or place" },
  "geosearch.placeholder": { pt: "Buscar endereço ou lugar…", en: "Search an address or place…" },
  "geosearch.results":     { pt: "Resultados da busca",       en: "Search results" },
  "geosearch.searching":   { pt: "Buscando…",                 en: "Searching…" },
  "geosearch.none":        { pt: "Nenhum resultado — tente incluir bairro ou cidade", en: "No results — try adding a neighbourhood or city" },
  "geosearch.net_error":   { pt: "Erro de rede na busca",     en: "Search network error" },
  "geosearch.attrib":      { pt: "busca <a href=\"https://photon.komoot.io/\" target=\"_blank\" rel=\"noopener\">Photon</a> · dados © colaboradores do <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noopener\">OpenStreetMap</a>", en: "search <a href=\"https://photon.komoot.io/\" target=\"_blank\" rel=\"noopener\">Photon</a> · data © <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noopener\">OpenStreetMap</a> contributors" },
  // ---- Status / feedback line (#status) ---------------------------------
  // High-frequency lifecycle + validation messages and the FABDEM loader
  // (which was written in PT, so EN users saw stray Portuguese). {0}-style
  // placeholders are filled by t(); user-derived text is escaped by callers.
  "status.loading_dem":      { pt: "Carregando DEM…",                                  en: "Loading DEM…" },
  "status.computing":        { pt: "Calculando…",                                      en: "Computing…" },
  "status.done_ms":          { pt: "Concluído em {0} ms.",                             en: "Done in {0} ms." },
  "status.engine_wasm":      { pt: " (motor WebAssembly)",                             en: " (WebAssembly engine)" },
  "status.network_loaded":   { pt: "Rede carregada.",                                  en: "Network loaded." },
  "status.load_dem_first":   { pt: "Carregue um DEM primeiro.",                        en: "Load a DEM first." },
  "status.src_set":          { pt: "Origem definida. Clique de novo para o destino, ou rode.", en: "Source set. Click again to set destination, or run." },
  "status.both_set":         { pt: "Os dois pontos definidos. Rode para calcular.",    en: "Both points set. Run to compute." },
  "status.src_replaced":     { pt: "Origem substituída. Clique para o destino, ou rode.", en: "Source replaced. Click to set destination, or run." },
  "status.density_needs_ref":{ pt: "O modo densidade precisa de ao menos um ponto de referência — clique no mapa ou use \"Distribuir aleatórias\".", en: "Density mode needs at least one reference point — click on the map or use \"Place random\"." },
  "status.topn_needs_dst":   { pt: "Top-N de rotas exige um ponto de destino.",        en: "Top-N routes requires a destination point." },
  "status.fabdem_too_large": { pt: "Janela ~{0} MB ({1}×{2} células), acima do limite de {3} MB. Aproxime o zoom.", en: "Viewport ~{0} MB ({1}×{2} cells), over the {3} MB limit. Zoom in." },
  "status.fabdem_none":      { pt: "Nenhum tile FABDEM encontrado para esta janela (provavelmente oceano ou fora da cobertura ±60° lat).", en: "No FABDEM tiles found for this viewport (likely ocean or outside ±60° lat coverage)." },
  "status.fabdem_fetching":  { pt: "Buscando {0} tile(s) FABDEM…",                     en: "Fetching {0} FABDEM tile(s)…" },
  "status.fabdem_mosaic":    { pt: "Mosaico: tile {0}/{1}…",                           en: "Mosaicking: tile {0}/{1}…" },
  "status.fabdem_all_failed":{ pt: "FABDEM: todos os tiles falharam na leitura (rede?). Tente novamente.", en: "FABDEM: all tile reads failed (network?). Try again." },
  "status.fabdem_partial":   { pt: "Atenção: {0} de {1} tiles FABDEM falharam na leitura — o DEM tem lacunas (nodata). Recarregue para tentar de novo.", en: "Warning: {0} of {1} FABDEM tiles failed to read — the DEM has gaps (nodata). Reload to retry." },
  "status.fabdem_failed":    { pt: "Falha ao carregar FABDEM: {0}",                  en: "FABDEM load failed: {0}" },
  // DEM loading
  "status.fetching":         { pt: "Buscando {0}…",                                  en: "Fetching {0}…" },
  "status.loading_label":    { pt: "Carregando {0}…",                                en: "Loading {0}…" },
  "status.error_generic":    { pt: "Erro: {0}",                                      en: "Error: {0}" },
  "status.dem_lonlat":       { pt: "DEM em lon/lat — distâncias aproximadas pela latitude (boas a ~0,3% em extensões < ~50 km).", en: "DEM is in lon/lat — distances approximated from latitude (good to ~0.3% under ~50 km extent)." },
  "status.dem_no_geotransform":{ pt: "O GeoTIFF não tem metadados de georreferenciamento (ModelPixelScale/tie points). Use um GeoTIFF georreferenciado.", en: "The GeoTIFF lacks geotransform metadata (ModelPixelScale/tie points). Use a properly georeferenced GeoTIFF." },
  "status.mask_no_geotransform":{ pt: "O GeoTIFF de máscara não tem metadados de georreferenciamento (ModelPixelScale/tie points).", en: "Mask GeoTIFF lacks geotransform metadata (ModelPixelScale / tie points)." },
  "status.dem_loaded":       { pt: "{0} carregado. Clique no mapa para definir o ponto de origem.", en: "{0} loaded. Click on the map to set source point." },
  "status.dem_projected":    { pt: "{0} carregado, mas o CRS é projetado/desconhecido — o mapa é só lon/lat (EPSG:4326), então cliques e camadas não estão disponíveis. Reprojete o DEM para EPSG:4326 para interagir no mapa.", en: "{0} loaded, but its CRS is projected/unknown — the map is lon/lat (EPSG:4326) only, so click-to-pick and overlays are unavailable. Reproject the DEM to EPSG:4326 to interact on the map." },
  "status.map_not_ready":    { pt: "Mapa não está pronto.",                          en: "Map not ready." },
  "status.map_bounds_failed":{ pt: "Não foi possível ler os limites do mapa.",       en: "Couldn't read map bounds." },
  "status.compute_failed":   { pt: "Falha inesperada no cálculo — {0}. Tente de novo (um DEM ou orçamento menor se foi memória).", en: "Compute failed unexpectedly — {0}. Try again (a smaller DEM or budget if it was memory)." },
  // Network (.gpkg / OSM)
  "status.gpkg_failed":      { pt: "Falha ao carregar .gpkg: {0}",                   en: ".gpkg load failed: {0}" },
  "status.net_zero_cells":   { pt: "Rede rasterizada para 0 células neste DEM — não aplicada. Verifique o CRS do .gpkg e se contém geometria LineString sobrepondo a extensão do DEM.", en: "Network rasterised to 0 cells on this DEM — not applied. Check the .gpkg CRS and that it contains LineString geometry overlapping the DEM extent." },
  "status.net_zero_cells_src":{ pt: "{0}: rasterizado para 0 células neste DEM — não aplicado.", en: "{0}: rasterised to 0 cells on this DEM — not applied." },
  "status.net_too_large":    { pt: "Rede grande demais para renderização vetorial (máscara raster ainda ativa).", en: "Network too large for vector rendering (raster mask still active)." },
  "status.osm_no_intersect": { pt: "A vista atual do mapa não intersecta o DEM — vá até o DEM primeiro.", en: "The current map view doesn't intersect the DEM — pan to the DEM first." },
  "status.osm_net_geographic":{ pt: "A busca OSM precisa de um DEM geográfico (EPSG:4326) — o DEM atual está projetado.", en: "The OSM pull needs a geographic DEM (EPSG:4326) — the current DEM is projected." },
  "status.osm_querying":     { pt: "Consultando OSM (Overpass) por highway=* …",     en: "Querying OSM (Overpass) for highway=* …" },
  "status.osm_parsing":      { pt: "Lendo resposta do OSM…",                         en: "Parsing OSM response…" },
  "status.osm_rasterising":  { pt: "Rasterizando {0} vias do OSM…",                  en: "Rasterising {0} OSM ways…" },
  "status.osm_failed":       { pt: "Falha ao puxar a rede do OSM: {0}",              en: "OSM network pull failed: {0}" },
  "status.osm_no_ways":      { pt: "O Overpass não retornou vias highway=* nesta extensão.", en: "Overpass returned no highway=* ways in this extent." },
  "status.water_geographic": { pt: "Puxar água do OSM precisa de um DEM geográfico (lon/lat).", en: "OSM water pull needs a geographic (lon/lat) DEM." },
  "status.water_querying":   { pt: "Consultando OSM (Overpass) por água…",          en: "Querying OSM (Overpass) for water…" },
  "status.water_parsing":    { pt: "Lendo água do OSM…",                            en: "Parsing OSM water…" },
  "status.water_rasterising":{ pt: "Rasterizando {0} feições de água…",             en: "Rasterising {0} water features…" },
  "status.water_none":       { pt: "Nenhuma água encontrada na extensão do DEM.",   en: "No water found in the DEM extent." },
  "status.water_done":       { pt: "Água do OSM: {0} células barradas.",            en: "OSM water: {0} impassable cells." },
  "status.water_failed":     { pt: "Falha ao puxar água do OSM: {0}",               en: "OSM water pull failed: {0}" },
  "status.overpass_http":    { pt: "Overpass HTTP {0} (ocupado? tente de novo em um minuto)", en: "Overpass HTTP {0} (busy? try again in a minute)" },
  "status.vec_reading":      { pt: "Lendo {0} ({1} MB)…",                            en: "Reading {0} ({1} MB)…" },
  "status.vec_init_sql":     { pt: "Inicializando sql.js…",                          en: "Initializing sql.js…" },
  "status.sqljs_unavailable":{ pt: "sql.js não carregou (CDN bloqueado, ou offline antes do primeiro uso?)", en: "sql.js didn't load (CDN blocked, or offline before it was ever fetched?)" },
  "status.vec_rasterising_of":   { pt: "Rasterizando… <span class=\"v\">{0}</span>/{1} ({2} desenhadas)", en: "Rasterising… <span class=\"v\">{0}</span>/{1} ({2} drawn)" },
  "status.vec_rasterising_scan": { pt: "Rasterizando… <span class=\"v\">{0}</span> varridas, {1} desenhadas", en: "Rasterising… <span class=\"v\">{0}</span> scanned, {1} drawn" },
  "status.net_meta_drawn":   { pt: "<span class=\"v\">{0}</span> linhas desenhadas<br/><span class=\"v\">{1}</span> células de rede ({2}% da grade)", en: "<span class=\"v\">{0}</span> lines drawn<br/><span class=\"v\">{1}</span> network cells ({2}% of grid)" },
  "status.net_meta_zero":    { pt: "EPSG:{0} · varridas <span class=\"v\">{1}</span> feições, desenhadas {2} — <span style=\"color:#ff6b6b\">0 células neste DEM</span>", en: "EPSG:{0} · scanned <span class=\"v\">{1}</span> features, drew {2} — <span style=\"color:#ff6b6b\">0 cells on this DEM</span>" },
  "status.load_superseded":  { pt: "Carregamento cancelado — o DEM mudou durante a operação.", en: "Load cancelled — the DEM changed during the operation." },
  // Point picking / snapping
  "status.click_outside":    { pt: "Clique fora do DEM, ou DEM em CRS não geográfico (este protótipo só suporta DEMs EPSG:4326 — veja as notas).", en: "Click is outside the DEM, or DEM is in a non-geographic CRS (this prototype supports EPSG:4326 DEMs only — see notes)." },
  "status.click_nodata":     { pt: "A célula clicada é nodata.",                     en: "Clicked cell is nodata." },
  "status.net_no_snap_click":{ pt: "A rede carregada não tem células úteis neste DEM (verifique CRS/geometria) — não dá para agarrar cliques. Desmarque \"Restringir cálculo à rede\" ou limpe a rede para continuar.", en: "The loaded network has no usable cells on this DEM (check its CRS/geometry) — clicks can't be snapped. Untick \"Constrain compute to network\" or clear the network to continue." },
  "status.snap_failed_label":{ pt: "{0} não pode ser agarrado — a rede carregada não tem células úteis neste DEM (verifique CRS/geometria), ou desmarque \"Restringir cálculo à rede\".", en: "{0} can't be snapped — the loaded network has no usable cells on this DEM (check its CRS/geometry), or untick \"Constrain compute to network\"." },
  "status.refs_no_snap":     { pt: "Os pontos de referência não podem ser agarrados — a rede carregada não tem células úteis neste DEM, ou desmarque \"Restringir cálculo à rede\".", en: "Reference points can't be snapped — the loaded network has no usable cells on this DEM, or untick \"Constrain compute to network\"." },
  // Compute progress / backend / interp / graph
  "status.worker_error":     { pt: "Erro no worker: {0}",                            en: "Worker error: {0}" },
  "status.density_progress": { pt: "Calculando densidade: ref {0}/{1} ({2}%)",       en: "Computing density: ref {0}/{1} ({2}%)" },
  "status.computing_pct":    { pt: "Calculando… {0}%",                               en: "Computing… {0}%" },
  "status.time_left":        { pt: "{0} — faltam {1}",                               en: "{0} — {1} left" },
  "status.interpolating_net":   { pt: "Interpolando pela rede…",                     en: "Interpolating across the network…" },
  "status.interpolating_energy":{ pt: "Interpolando o campo de energia…",            en: "Interpolating energy field…" },
  "status.backend_computing":   { pt: "Calculando no backend nativo…",              en: "Computing on native backend…" },
  "status.backend_computing_elapsed":{ pt: "Calculando no backend nativo… {0} decorridos", en: "Computing on native backend… {0} elapsed" },
  "cloud.machine":         { pt: "Máquina da nuvem", en: "Cloud machine" },
  // Preços de referência ON-DEMAND em southamerica-east1 (jul/2026, ~R$5,50/US$;
  // N vCPUs ≈ N·US$0,068/h). A VM roda SPOT (60–90% mais barato, flutua) — os
  // rótulos são teto aproximado, não fatura. Recalcule se mover de região.
  "cloud.m8":              { pt: "8 vCPUs · 32 GB — ~R$ 3/h",    en: "8 vCPUs · 32 GB — ~R$3/h (~US$0.55)" },
  "cloud.m32":             { pt: "32 vCPUs · 128 GB — ~R$ 12/h", en: "32 vCPUs · 128 GB — ~R$12/h (~US$2.20)" },
  "cloud.m128":            { pt: "128 vCPUs · 512 GB — ~R$ 48/h", en: "128 vCPUs · 512 GB — ~R$48/h (~US$8.70)" },
  "status.cloud_computing":     { pt: "Calculando na nuvem…",                        en: "Computing in the cloud…" },
  "status.cloud_computing_elapsed":{ pt: "Calculando na nuvem… {0} decorridos",      en: "Computing in the cloud… {0} elapsed" },
  "status.backend_fallback": { pt: "Backend nativo indisponível — usando workers do navegador… (motivo: {0})", en: "Native backend unavailable — using browser workers… (reason: {0})" },
  "status.building_graph":   { pt: "Construindo o grafo da rede…",                   en: "Building network graph…" },
  "status.graph_done":       { pt: "Concluído em {0} ms (grafo: {1} nós, {2} arestas){3}.", en: "Done in {0} ms (graph: {1} nodes, {2} edges){3}." },
  "status.graph_route_note": { pt: " · {0} rota(s)",                                 en: " · {0} route(s)" },
  // Bundle / export
  "status.nothing_rendered": { pt: "Nada renderizado ainda — rode um cálculo primeiro.", en: "Nothing rendered yet — run a compute first." },
  "status.no_layers_export": { pt: "Nenhuma camada renderizada para exportar.",      en: "No rendered layers to export." },
  "status.exported_layers":  { pt: "Exportadas {0} camada(s) renderizada(s) ({1} MB).", en: "Exported {0} rendered layer(s) ({1} MB)." },
  "status.export_failed":    { pt: "Falha ao exportar: {0}",                         en: "Export failed: {0}" },
  "status.download_need_dem":{ pt: "Carregue um DEM, rode o Compute e então baixe.", en: "Load a DEM first, then run Compute, then download." },
  "status.download_need_compute":{ pt: "Nada para baixar ainda — clique em Compute primeiro.", en: "Nothing to download yet — click Compute first." },
  "status.jszip_failed":     { pt: "JSZip não carregou — verifique a rede/console.", en: "JSZip didn't load — check the network/console." },
  "status.building_bundle":  { pt: "Montando o bundle…",                            en: "Building bundle…" },
  "status.bundle_saved":     { pt: "Bundle salvo ({0} MB).",                         en: "Saved bundle ({0} MB)." },
  "status.download_failed":  { pt: "Falha ao baixar: {0}",                           en: "Download failed: {0}" },
  "status.reload_failed":    { pt: "Falha ao recarregar: {0}",                       en: "Reload failed: {0}" },
  "status.bundle_restored":  { pt: "Bundle restaurado do cache — todas as camadas salvas re-renderizadas. Sem recálculo.", en: "Bundle restored from cache — all saved layers re-rendered. No recompute needed." },
  "status.bundle_dem_mismatch":{ pt: "Tamanho do DEM não bate — o bundle era para {0}×{1}, o DEM carregado é {2}×{3}. Parâmetros aplicados; saídas binárias ignoradas. Carregue o DEM correspondente para restaurar as camadas.", en: "DEM size mismatch — bundle was for {0}×{1}, loaded DEM is {2}×{3}. Parameters applied; binary outputs skipped. Load the matching DEM to restore overlays." },
  "status.bundle_dem_mismatch_pending":{ pt: "DEM carregado ({0}×{1}) não corresponde ao bundle pendente ({2}×{3}) — carregue o DEM correspondente para restaurá-lo.", en: "DEM loaded ({0}×{1}) doesn't match the pending bundle ({2}×{3}) — load the matching DEM to restore it." },
  "status.bundle_dem_extent_mismatch":{ pt: "DEM tem o mesmo tamanho ({0}×{1}) do bundle, mas é de outra área — provavelmente outro recorte. Parâmetros aplicados; saídas binárias ignoradas. Carregue o DEM correto para restaurar as camadas.", en: "DEM matches the bundle's size ({0}×{1}) but covers a different area — likely a different tile. Parameters applied; binary outputs skipped. Load the correct DEM to restore overlays." },
  "status.bundle_params_loaded":{ pt: "Parâmetros do bundle carregados. Clique em Compute para reproduzir.", en: "Bundle parameters loaded. Click Compute to reproduce." },
  "status.bundle_need_dem":  { pt: "Bundle carregado. Agora carregue o DEM correspondente{0} e clique em Compute.", en: "Bundle loaded. Now load the matching DEM{0} and click Compute." },
  "status.bundle_loaded":    { pt: "Bundle carregado. Clique no mapa para definir o ponto de origem.", en: "Bundle loaded. Click on the map to set source point." },
  "status.bundle_graph_not_restored":{ pt: "Bundle de modo grafo: o resultado (graph_edges.geojson) não é restaurável e a rede vetorial não viaja no bundle — recarregue a rede (.gpkg/OSM) antes de recalcular, senão o Compute usa o motor raster.", en: "Graph-mode bundle: the result (graph_edges.geojson) can't be restored and the vector network doesn't travel with the bundle — reload the network (.gpkg/OSM) before recomputing, or Compute will silently fall back to the raster engine." },
  "locate.unavailable":  { pt: "Localização indisponível.",             en: "Location unavailable." },
  "locate.timeout":      { pt: "Tempo esgotado ao buscar localização.", en: "Location lookup timed out." },
  "locate.error":        { pt: "Erro ao buscar localização.",           en: "Location lookup failed." },
  "locate.unsupported":  { pt: "Geolocalização não suportada.",         en: "Geolocation not supported." },
  "help.title":          { pt: "Como funciona", en: "How it works" },

  // ---- Group: Load DEM --------------------------------------------------
  "group.io":            { pt: "0. Importar / Exportar dados", en: "0. Import / Export data" },
  "group.inputs":        { pt: "1. Dados de entrada", en: "1. Input data" },
  "group.compute":       { pt: "2. Configuração do cálculo", en: "2. Compute setup" },
  "group.execution":     { pt: "2C. Execução", en: "2C. Execution" },
  "config.hint":         { pt: "Configuração (todos os controles):", en: "Settings (all toggles & values):" },
  "config.export":       { pt: "Exportar config", en: "Export config" },
  "config.import":       { pt: "Importar config", en: "Import config" },
  "config.reset":        { pt: "Restaurar padrões", en: "Reset to defaults" },
  "config.imported":     { pt: "Configuração importada.", en: "Config imported." },
  "config.import_error": { pt: "Falha ao importar a configuração", en: "Failed to import config" },
  "config.reset_confirm":{ pt: "Restaurar todas as configurações para os padrões? A página será recarregada.", en: "Reset all settings to defaults? The page will reload." },
  "group.load_dem":      { pt: "1A. Carregar DEM", en: "1A. Load DEM" },
  "examples.heading":    { pt: "ou baixar (localmente) um exemplo:", en: "or download (locally) an example:" },
  "ex.aguapreta":        { pt: "Entorno da Água Preta", en: "Água Preta surroundings" },
  "ex.centro":           { pt: "Sampa Centro Expandido", en: "São Paulo central area" },
  "ex.geral":            { pt: "Sampa Sítio Urbano",    en: "São Paulo urban site" },
  "ex.fabdem":           { pt: "Carregar FABDEM para a janela atual", en: "Load FABDEM for current viewport" },
  "ex.tag.aguapreta":    { pt: "~2 MB · imediato",      en: "~2 MB · instant" },
  "ex.tag.centro":       { pt: "~34 MB · rápido",       en: "~34 MB · fast" },
  "ex.tag.geral":        { pt: "~540 MB · lento",       en: "~540 MB · slow" },
  "ex.tag.fabdem":       { pt: "≤ ~500 MB",              en: "≤ ~500 MB" },
  "dem.no_dem":          { pt: "Nenhum DEM carregado.", en: "No DEM loaded." },
  "dem.meta_size":       { pt: "<span class=\"v\">{0} × {1}</span> células, célula {2}", en: "<span class=\"v\">{0} × {1}</span> cells, cell {2}" },
  "dem.meta_origin":     { pt: "origem <span class=\"v\">{0}</span>", en: "origin <span class=\"v\">{0}</span>" },
  "dem.meta_coverage":   { pt: "{0} de cobertura", en: "{0} coverage" },
  "bundle.reload_hint":  { pt: "Restaurar bundle (.zip) ou .jsonld:", en: "Reload a saved bundle (.zip) or .jsonld:" },

  // ---- Group: Vector network -------------------------------------------
  "group.network":       { pt: "1B. Rede vetorial opcional (.gpkg)", en: "1B. Optional vector network (.gpkg)" },
  "net.line_width":      { pt: "largura da linha (células)", en: "line width (cells)" },
  "net.snap_radius":     { pt: "raio de snap (células)", en: "snap radius (cells)" },
  "net.clear":           { pt: "Limpar rede",  en: "Clear network" },
  "net.render_width":    { pt: "largura da linha (m)", en: "line width (m)" },
  "net.constrain":       { pt: "Restringir cálculo à rede", en: "Constrain compute to network" },
  "net.graph_mode":      { pt: "Usar grafo viário ao invés de rasterizado", en: "Use road graph instead of rasterized" },
  "net.junctions":       { pt: "junções", en: "junctions" },
  "net.junctions_crossings": { pt: "nos cruzamentos", en: "at crossings" },
  "net.junctions_shared":    { pt: "extremos comuns", en: "shared endpoints" },
  "net.osm":             { pt: "Puxar ruas do OSM (highway=*)", en: "Pull streets from OSM (highway=*)" },
  "net.fgb":             { pt: "Puxar viário do FGB (América do Sul · nuvem)", en: "Pull streets from FGB (South America · cloud)" },
  "status.fgb_querying": { pt: "Consultando o FGB do viário (só os bytes da janela, via HTTP Range)…", en: "Querying the road FGB (only the view's bytes, via HTTP Range)…" },
  "status.fgb_progress": { pt: "FGB: {0} vias lidas…", en: "FGB: {0} ways read…" },
  "status.fgb_no_ways":  { pt: "Nenhuma via do FGB na janela.", en: "No FGB ways in the view." },
  "status.fgb_failed":   { pt: "Consulta ao FGB falhou: {0}", en: "FGB query failed: {0}" },
  "status.fgb_too_big":  { pt: "Janela grande demais pro FGB (~{0}×{1} km; teto ~10°², o mesmo do FABDEM) — aproxime o zoom.", en: "View too large for the FGB pull (~{0}×{1} km; cap ~10°², same as FABDEM) — zoom in." },
  "imp.fgb":             { pt: "Puxar água do FGB (América do Sul · nuvem)", en: "Pull water from FGB (South America · cloud)" },
  "imp.fgb.title":       { pt: "As mesmas áreas d'água (natural=water / reservoir / riverbank) e rios (waterway=river) do pull do OSM, servidos do FlatGeobuf do projeto via HTTP Range — sem Overpass. SEM litoral: o mar não é preenchido (em DEM costeiro use o pull do OSM); rios em túnel não são filtrados (o FGB não traz a tag tunnel).", en: "The same water areas (natural=water / reservoir / riverbank) and rivers (waterway=river) as the OSM pull, served from the project's FlatGeobuf via HTTP Range — no Overpass. NO coastline: the open sea is not filled (use the OSM pull on coastal DEMs); tunnelled rivers are not filtered out (the FGB carries no tunnel tag)." },
  "bridge.fgb":          { pt: "Puxar do FGB (América do Sul · nuvem)", en: "Pull from FGB (South America · cloud)" },
  "bridge.fgb.title":    { pt: "As mesmas pontes/túneis de VIAS (highway=* com bridge/tunnel) do pull do OSM, servidas do FlatGeobuf via HTTP Range — sem Overpass. Sem elevações `ele` mapeadas (os apoios caem no DEM); estruturas ferroviárias não entram (o FGB só tem vias).", en: "The same ROAD bridges/tunnels (highway=* with bridge/tunnel) as the OSM pull, served from the FlatGeobuf via HTTP Range — no Overpass. No mapped `ele` elevations (abutments fall back to the DEM); railway structures are absent (the FGB is highway-only)." },
  "bridges.none_fgb":    { pt: "Nenhuma ponte/túnel de via no FGB na janela.", en: "No road bridges/tunnels in the FGB view." },
  "net.example_viario":  { pt: "Viário RMSampa", en: "RMSampa road network" },
  "net.example_viario_tag": { pt: "~145 MB · nuvem · dados © OpenStreetMap, ODbL", en: "~145 MB · cloud · data © OpenStreetMap, ODbL" },
  "help.p.network_osm":  { pt: "Consulta o Overpass sobre a vista atual ∩ extensão do DEM. Áreas grandes podem demorar ou estourar limites do Overpass — aproxime o zoom primeiro.", en: "Queries Overpass over the current map view ∩ DEM extent. Large areas can take a while or hit Overpass limits — zoom in first." },
  "net.compare":         { pt: "Comparar com cenário sem rede", en: "Compare with unconstrained" },
  "net.graph_constrain_locked": { pt: "No modo grafo o cálculo é sempre sobre a rede — \"restringir\" fica sempre ativo. \"Comparar\" continua disponível: compara com o cenário em raster sem a rede.", en: "In graph mode the compute is always on the network — \"constrain\" stays on. \"Compare\" is still available: it compares against the raster scenario without the network." },
  "layer.energy_source": { pt: "Cenário exibido (energia e passagens)", en: "Displayed scenario (energy & passes)" },
  "esrc.constrained":    { pt: "restrito à rede", en: "network-constrained" },
  "esrc.unconstrained":  { pt: "sem restrição", en: "unconstrained" },
  "esrc.difference":     { pt: "diferença (custo da rede)", en: "difference (network cost)" },
  "route.network":       { pt: "rota na rede", en: "network route" },
  "route.terrain":       { pt: "rota no terreno", en: "terrain route" },
  "route.delta":         { pt: "Δ rede − terreno", en: "Δ network − terrain" },
  "route.terrain_meta":  { pt: "rota no terreno E: <span class=\"v\">{0}</span>, L=<span class=\"v\">{1} km</span>", en: "terrain route E: <span class=\"v\">{0}</span>, L=<span class=\"v\">{1} km</span>" },
  "route.round_note":    { pt: "energia das rotas alternativas: apenas o trecho de ida", en: "alternative-route energies: outbound leg only" },
  "warn.dp_skipped":     { pt: "Caminho de comprimento restrito não calculado ({0}). Mostrando o caminho da Dijkstra invertida — tente um L maior (no mínimo ~a distância de Chebyshev entre origem e destino).", en: "Length-constrained DP did not run ({0}). Showing the inverted-Dijkstra path instead — try a larger L (at minimum ~Chebyshev distance between src and dst)." },
  "route.compare_metric_note": { pt: "Nota: a rota de terreno segue a grade 8-conectada (comprimento até ~8% acima do geométrico) e alturas por célula; a rota da rede usa o comprimento real das polilinhas — Δ pequenos ficam dentro dessa diferença metodológica.", en: "Note: the terrain route follows the 8-connected grid (length up to ~8% above the geometric path) and cell-centre heights; the network route uses true polyline lengths — small Δ values sit within that methodological difference." },
  // ---- ColorCET colormap dropdown optgroup labels ------------------------
  "cmap.grp.linear":       { pt: "Linear", en: "Linear" },
  "cmap.grp.diverging":    { pt: "Divergente", en: "Diverging" },
  "cmap.grp.rainbow":      { pt: "Arco-íris", en: "Rainbow" },
  "cmap.grp.isoluminant":  { pt: "Isoluminante", en: "Isoluminant" },
  "cmap.grp.cyclic":       { pt: "Cíclico", en: "Cyclic" },
  "cmap.grp.cb_linear":    { pt: "Segura p/ daltonismo, linear", en: "Colour-blind safe linear" },
  "cmap.grp.cb_diverging": { pt: "Segura p/ daltonismo, divergente", en: "Colour-blind safe diverging" },
  "cmap.grp.cb_cyclic":    { pt: "Segura p/ daltonismo, cíclica", en: "Colour-blind safe cyclic" },
  "cmap.grp.tritan_linear":    { pt: "Segura p/ tritanopia, linear", en: "Tritan-safe linear" },
  "cmap.grp.tritan_diverging": { pt: "Segura p/ tritanopia, divergente", en: "Tritan-safe diverging" },
  "cmap.grp.tritan_cyclic":    { pt: "Segura p/ tritanopia, cíclica", en: "Tritan-safe cyclic" },
  // ---- Stats panel (renderResult) + route/marker tooltips ---------------
  "stats.max_e":         { pt: "E máx: <span class=\"v\">{0}</span>", en: "max E: <span class=\"v\">{0}</span>" },
  "stats.time":          { pt: "tempo: <span class=\"v\">{0} ms</span>", en: "time: <span class=\"v\">{0} ms</span>" },
  "stats.max_passes":    { pt: "passes máx: <span class=\"v\">{0}</span>", en: "max passes: <span class=\"v\">{0}</span>" },
  "stats.routes_count":  { pt: "<span class=\"v\">{0}</span> rota(s):", en: "<span class=\"v\">{0}</span> route(s):" },
  "stats.shared":        { pt: ", compartilhada <span class=\"v\">{0}</span>", en: ", shared <span class=\"v\">{0}</span>" },
  "stats.path_e":        { pt: "E da rota: <span class=\"v\">{0}</span>", en: "path E: <span class=\"v\">{0}</span>" },
  "stats.length":        { pt: "distância: <span class=\"v\">{0} km</span>", en: "length: <span class=\"v\">{0} km</span>" },
  "stats.route_tooltip": { pt: "rota {0} · E {1} · {2} km", en: "route {0} · E {1} · {2} km" },
  "marker.src":          { pt: "Origem", en: "Source" },
  "marker.dst":          { pt: "Destino", en: "Destination" },
  // ---- Accessibility KPIs (pairwise ref↔ref matrix, density runs) --------
  "group.kpi":           { pt: "3B. Acessibilidade (KPIs 300 kJ)", en: "3B. Accessibility (300 kJ KPIs)" },
  "kpi.intro":           { pt: "Cada referência representa uma fração igual da população amostrada. Os KPIs leem a matriz de energia par-a-par do último cálculo de densidade — editar os limiares reavalia na hora, sem recalcular.", en: "Each reference stands for an equal share of the sampled population. The KPIs read the last density run's pairwise energy matrix — editing the thresholds re-evaluates instantly, no recompute." },
  "kpi.ek":              { pt: "E₁ (kJ)", en: "E₁ (kJ)" },
  "kpi.k":               { pt: "pessoas alcançáveis ≥", en: "reachable people ≥" },
  "kpi.ej":              { pt: "E₂ (kJ)", en: "E₂ (kJ)" },
  "kpi.j":               { pt: "% da população ≥", en: "% of population ≥" },
  "kpi.pop":             { pt: "população total M", en: "total population M" },
  "kpi.pop_census":      { pt: "população total M (do censo)", en: "total population M (from census)" },
  "kpi.out1":            { pt: "KPI 1 — <span class=\"v\">{0}%</span> da população alcança ≥ {1} pessoas com ≤ {2} kJ", en: "KPI 1 — <span class=\"v\">{0}%</span> of the population can access ≥ {1} people within ≤ {2} kJ" },
  "kpi.out1_need_pop":   { pt: "KPI 1 — informe a população total M (amostragem não-censitária)", en: "KPI 1 — enter the total population M (non-census sampling)" },
  "kpi.out2":            { pt: "KPI 2 — <span class=\"v\">{0}%</span> da população alcança ≥ {1}% da população com ≤ {2} kJ", en: "KPI 2 — <span class=\"v\">{0}%</span> of the population can access ≥ {1}% of the population within ≤ {2} kJ" },
  "kpi.meta":            { pt: "{0} referências · modo {1} · orçamento do cálculo: {2}", en: "{0} references · mode {1} · run budget: {2}" },
  "kpi.meta_no_budget":  { pt: "∞ (sem orçamento)", en: "∞ (no budget)" },
  "kpi.warn_budget":     { pt: "Atenção: limiar acima do orçamento do cálculo ({0} kJ) — além dele a matriz é truncada, então os KPIs são um piso (subestimam). Recalcule com orçamento ≥ ao maior limiar para valores exatos.", en: "Warning: threshold above the run's energy budget ({0} kJ) — the matrix is truncated beyond it, so the KPIs are a lower bound (underestimate). Re-run with a budget ≥ the largest threshold for exact values." },
  "kpi.backend_no_matrix": { pt: "Backend nativo desatualizado — sem matriz de acessibilidade nesta resposta. Atualize o backend ou use o cálculo no navegador.", en: "Native backend outdated — no accessibility matrix in this response. Update the backend or compute in the browser." },
  "kpi.refs_changed":    { pt: "As referências mudaram desde o cálculo — os marcadores não foram recoloridos (os KPIs abaixo valem para as referências do cálculo).", en: "References changed since the run — markers were not recolored (the KPIs below refer to the run's references)." },
  "kpi.marker_tooltip":  { pt: "ref {0} · alcança {1} pessoas (≤ {2} kJ)", en: "ref {0} · reaches {1} people (≤ {2} kJ)" },
  "kpi.marker_tooltip_frac": { pt: "ref {0} · alcança {1}% das referências (≤ {2} kJ)", en: "ref {0} · reaches {1}% of references (≤ {2} kJ)" },
  "btn.kpi_csv":         { pt: "Exportar CSV por referência", en: "Export per-reference CSV" },
  "btn.kpi_matrix_csv":  { pt: "Exportar matriz CSV", en: "Export matrix CSV" },
  "kpi.corr":            { pt: "correção de grade ×c", en: "grid correction ×c" },
  "kpi.corr.title":      { pt: "Infla os limiares E₁/E₂ por c para compensar a sobre-estimativa da grade de 8 direções (≈1,09–1,12 medido). 1,00 = desligada (piso conservador). Desnecessária com ≥16 direções.", en: "Inflates the E₁/E₂ thresholds by c to offset the 8-direction grid's overestimate (≈1.09–1.12 measured). 1.00 = off (conservative floor). Unnecessary with ≥16 directions." },
  "kpi.corr_note":       { pt: "Correção de grade ×{0} aplicada aos limiares — estimativa centrada: a garantia de piso conservador NÃO vale mais.", en: "Grid correction ×{0} applied to the thresholds — centered estimate: the conservative-floor guarantee NO longer holds." },
  // ---- Move directions + string pulling ----------------------------------
  "param.ndirs":         { pt: "Direções de movimento", en: "Move directions" },
  "param.ndirs.title":   { pt: "8 = grade clássica (padrão). Mais direções reduzem a sobre-estimativa de energia por serrilhado das rotas (≈⅔ a menos com 16), a custo de cálculo proporcional. Servido também pelo backend nativo/nuvem a partir da versão 0.2.0 (backends antigos calculam no navegador).", en: "8 = the classic grid (default). More directions shrink the route-jaggedness energy overestimate (≈⅔ less at 16) at proportional compute cost. Also served by the native/cloud backend from version 0.2.0 (older backends compute in-browser)." },
  "param.string_pull":   { pt: "Suavizar rotas exibidas (string pulling)", en: "Smooth displayed routes (string pulling)" },
  "param.string_pull.title": { pt: "Encurta pós-cálculo a rota exibida (e as top-N) ligando vértices por segmentos retos custeados pelo mesmo modelo — a energia mostrada é a soma integrada da própria linha. Ida-e-volta fica de fora.", en: "Post-hoc shortens the displayed route (and top-N) by joining vertices with straight segments costed by the same model — the shown energy is the line's own integrated sum. Round-trip is excluded." },
  "stats.pulled":        { pt: "rota suavizada (string pulling) — energia = soma integrada da linha exibida", en: "route smoothed (string pulling) — energy = the displayed line's own integrated sum" },
  "net.interp":          { pt: "Interpolar campo de energia", en: "Interpolate energy field" },
  "net.max_distance":    { pt: "distância máx (células)", en: "max distance (cells)" },
  "net.smoothing":       { pt: "suavizações", en: "smoothing iters" },
  "net.no_network":      { pt: "Nenhuma rede carregada.", en: "No network loaded." },

  // ---- Group: Impassable mask ------------------------------------------
  "group.impassable":    { pt: "1C. Máscara de barreira opcional (água)", en: "1C. Optional impassable mask (water)" },
  "imp.enabled":         { pt: "Aplicar ao cálculo", en: "Apply to compute" },
  "imp.invert":          { pt: "Inverter (raster marca células passáveis)", en: "Invert (raster marks passable cells)" },
  "imp.osm":             { pt: "Puxar água do OSM", en: "Pull water from OSM" },
  "imp.example_water":   { pt: "Águas RMSampa", en: "RMSampa water mask" },
  "imp.example_water_tag": { pt: "~2,4 MB · nuvem", en: "~2.4 MB · cloud" },
  "imp.rivers":          { pt: "Rios (linhas) intransponíveis", en: "Rivers (lines) impassable" },
  "imp.corridor":        { pt: "Rede abre corredores passáveis sobre a máscara", en: "Network carves passable corridors across the mask" },
  "imp.offset":          { pt: "deslocamento no centro da ponte (m, −5…+15)", en: "bridge centre offset (m, −5…+15)" },
  "imp.none":            { pt: "Nenhuma máscara carregada.", en: "No impassable mask loaded." },
  "imp.meta.cells":      { pt: "{0} células barradas ({1}% da grade)", en: "{0} impassable cells ({1}% of grid)" },
  "imp.meta.corridor":   { pt: "{0} células de corredor (pontes)", en: "{0} bridge-corridor cells" },
  "imp.cell_blocked":    { pt: "Célula intransponível (máscara de barreira) — escolha outra.", en: "Impassable cell (barrier mask) — pick another." },
  "help.h.impassable":   { pt: "Máscara de barreira", en: "Impassable mask" },

  // ---- Group: Bridges & tunnels ----------------------------------------
  "group.bridges":       { pt: "1D. Pontes e túneis opcionais (OSM)", en: "1D. Optional bridges & tunnels (OSM)" },
  "bridge.enabled":      { pt: "Aplicar ao cálculo", en: "Apply to compute" },
  "bridge.osm":          { pt: "Puxar pontes e túneis do OSM", en: "Pull bridges & tunnels from OSM" },
  "bridge.from_network": { pt: "Extrair da rede carregada", en: "Extract from loaded network" },
  "bridge.no_candidates":{ pt: "A rede carregada não tem pontes/túneis marcados (tags bridge/tunnel).", en: "The loaded network has no bridge/tunnel tags." },
  "bridge.tunnels":      { pt: "Incluir túneis (tunnel=yes)", en: "Include tunnels (tunnel=yes)" },
  "bridge.clear":        { pt: "Limpar portais", en: "Clear portals" },
  "draw.barrier":        { pt: "Desenhar barreira", en: "Draw barrier" },
  "draw.corridor":       { pt: "Desenhar corredor", en: "Draw corridor" },
  "draw.portal":         { pt: "Desenhar portal", en: "Draw portal" },
  "imp.erase_all":       { pt: "Apagar máscara e desenhos", en: "Erase mask & drawings" },
  "draw.erase_portal":   { pt: "Apagar portais desenhados", en: "Erase drawn portals" },
  "draw.need_dem":       { pt: "Carregue um DEM geográfico (lon/lat) antes de desenhar.", en: "Load a geographic (lon/lat) DEM before drawing." },
  "draw.drawing":        { pt: "Desenhando… clique para adicionar vértices, duplo-clique para concluir.", en: "Drawing… click to add vertices, double-click to finish." },
  "draw.barrier_added":  { pt: "Barreira adicionada ({0} no total).", en: "Barrier added ({0} total)." },
  "draw.corridor_added": { pt: "Corredor passável adicionado ({0} no total).", en: "Passable corridor added ({0} total)." },
  "draw.portal_added":   { pt: "Portal adicionado ({0} no total).", en: "Portal added ({0} total)." },
  "draw.portal_invalid": { pt: "Portal inválido (extremos fora do DEM, sobre nodata ou coincidentes).", en: "Invalid portal (endpoints off-DEM, on nodata, or coincident)." },
  "draw.cleared":        { pt: "Desenhos apagados.", en: "Drawings erased." },
  "draw.imp_meta":       { pt: "{0} barreira(s), {1} corredor(es) desenhado(s)", en: "{0} barrier(s), {1} corridor(s) drawn" },
  "draw.portal_meta":    { pt: "{0} portal(is) desenhado(s)", en: "{0} portal(s) drawn" },
  "draw.delete_this":    { pt: "Apagar este desenho", en: "Delete this drawing" },
  "bridge.none":         { pt: "Nenhuma ponte carregada.", en: "No bridges loaded." },
  "bridge.meta.count":   { pt: "{0} tabuleiros de ponte/túnel", en: "{0} bridge/tunnel decks" },
  "bridge.meta.skipped": { pt: "{0} ignorados (fora do DEM ou apoio sem dado)", en: "{0} skipped (off-DEM or nodata abutment)" },
  "help.h.bridges":      { pt: "Pontes e túneis", en: "Bridges & tunnels" },
  "help.p.bridges":      { pt: "Puxa pontes (bridge=*) e, opcionalmente, túneis (tunnel=yes) do OpenStreetMap sobre a extensão do DEM, ou extrai-os da rede vetorial já carregada (1b) que tenha tags bridge/tunnel (coluna ou other_tags). Cada estrutura é modelada como um tabuleiro plano entre seus dois apoios no solo: no cálculo em raster ela vira uma \"aresta-portal\" entre as células das pontas, com o custo do tabuleiro plano, sem alterar as células por baixo — então tanto a rota POR CIMA da ponte quanto a rota POR BAIXO ficam corretas. Pressupõe um DEM de terreno nu (sem o tabuleiro). No modo \"seguir os vetores\" (grafo), as pontes/túneis da própria rede (puxada do OSM) são achatadas e os cruzamentos em níveis diferentes não se conectam.", en: "Pulls bridges (bridge=*) and, optionally, tunnels (tunnel=yes) from OpenStreetMap over the DEM extent, or extracts them from the already-loaded vector network (1b) when it carries bridge/tunnel tags (a column or other_tags). Each structure is modelled as a level deck between its two ground abutments: in the raster compute it becomes a \"portal edge\" between the end cells at the flat-deck cost, without altering the cells underneath — so both the route OVER the bridge and the route UNDER it stay correct. Assumes a bare-earth DEM (deck not in the terrain). In \"follow the vectors\" (graph) mode, the network's own bridges/tunnels (pulled from OSM) are flattened and crossings at different layers don't connect." },
  "help.p.impassable":   { pt: "Suba um GeoTIFF binário (1=intransponível, p.ex. corpos d'água). É reamostrado para a grade do DEM por maioria de área (≥50% intransponível ⇒ célula barrada); fora da extensão da máscara assume-se passável. Pode estar em extensão/resolução/CRS diferentes do DEM. Opcionalmente, a rede vetorial (1b) abre corredores passáveis (pontes) sobre a máscara, com um deslocamento suave de elevação que sobe linearmente das margens até o centro da ponte.", en: "Upload a binary GeoTIFF (1=impassable, e.g. water bodies). It is resampled onto the DEM grid by area-coverage majority (≥50% impassable ⇒ blocked cell); outside the mask extent cells are assumed passable. It may have a different extent/resolution/CRS than the DEM. Optionally the vector network (1b) carves passable corridors (bridges) across the mask, with a smooth elevation offset that ramps linearly from the shores up to the bridge centre." },

  // ---- Group: Pick points ----------------------------------------------
  "group.pick_points":   { pt: "2B. Pontos e referências", en: "2B. Points & references" },
  "pts.click_map":       { pt: "— clicar mapa —", en: "— click map —" },
  "pts.optional":        { pt: "— opcional —",  en: "— optional —" },
  "pts.click_again":     { pt: "— clicar novamente —", en: "— click again —" },
  "pts.density":         { pt: "— densidade —", en: "— density —" },
  "pts.clear":           { pt: "Limpar pontos", en: "Clear points" },

  // ---- Group: Parameters -----------------------------------------------
  "group.parameters":    { pt: "2A. Parâmetros", en: "2A. Parameters" },
  "param.mode":          { pt: "Modo", en: "Mode" },
  "mode.from":           { pt: "Saindo da fonte",     en: "From source" },
  "mode.to":             { pt: "Vindo até a fonte",  en: "To source point" },
  "mode.round":          { pt: "Ida e volta",         en: "Round trip" },
  "param.mass":          { pt: "Massa (kg)", en: "Mass (kg)" },
  "param.crr":           { pt: "Resistência ao rolamento (Crr)", en: "Rolling resistance (Crr)" },
  "param.cda":           { pt: "Área de arrasto (CdA, m²)", en: "Drag area (CdA, m²)" },
  "param.rho":           { pt: "Densidade do ar (ρ, kg/m³)", en: "Air density (ρ, kg/m³)" },
  "param.keff":          { pt: "Eficiência da transmissão", en: "Drivetrain efficiency" },
  "param.pflat":         { pt: "Potência no plano (W)", en: "Power on the flat (W)" },
  "param.climbthr":      { pt: "Limiar de subida (%)", en: "Climb threshold (%)" },
  "param.ksmooth":       { pt: "Suavização k_s", en: "Smoothing k_s" },
  "param.deadband":      { pt: "Deadband de elev. (m)", en: "Elev. deadband (m)" },
  "param.alphar":        { pt: "α_r rolamento (kJ/m)", en: "α_r rolling (kJ/m)" },
  "param.alphaa":        { pt: "α_a arrasto, plano (kJ/m)", en: "α_a aero, flat (kJ/m)" },
  "param.betaro":        { pt: "β subida (kJ/m)", en: "β climb (kJ/m)" },
  "param.budget":        { pt: "Orçamento de energia (kJ)", en: "Energy budget (kJ)" },
  "param.budget_mode":   { pt: "Orçamento aplica-se a", en: "Budget applies to" },
  "budget.leg":          { pt: "por perna", en: "each leg" },
  "budget.total":        { pt: "ida e volta", en: "round trip" },
  "help.p.budget_mode":  { pt: "Só no modo ida-e-volta. \"Cada perna\": célula visível se ida ≤ orçamento E volta ≤ orçamento (total pode chegar a 2×). \"Total\": ida + volta ≤ orçamento. A contagem de passagens conta apenas trajetos até células exibidas (dentro do orçamento); células-corredor ainda acumulam os trajetos que passam por elas. Perto da fronteira do orçamento as subárvores ficam truncadas e a contagem fica sistematicamente mais baixa ali; células cuja alcançabilidade é cortada pela borda do DEM sofrem o mesmo viés — compare corredores só bem dentro do orçamento e longe das bordas.", en: 'Round-trip mode only. "Each leg": a cell is shown if out ≤ budget AND back ≤ budget (totals can reach 2×). "Total": out + back ≤ budget. The passes count only counts trajectories to displayed (within-budget) cells; corridor cells still accumulate the trajectories passing through them. Near the budget frontier subtrees are truncated and the count is systematically lower there; cells whose reachability is clipped by the DEM border carry the same bias — compare corridors only well inside the budget and away from the edges.' },
  "param.want_topn":     { pt: "Calcular top-N rotas", en: "Compute top-N routes" },
  "param.want_density":  { pt: "Calcular densidade multi-referência", en: "Compute multi-reference density" },
  "param.backend_url":   { pt: "URL do backend", en: "Backend URL" },
  // ---- Compute source (three-way: navegador / localhost / nuvem) --------
  "param.compute_source":  { pt: "Fonte de cálculo", en: "Compute source" },
  "cs.browser":            { pt: "Navegador (workers na página)", en: "Browser (in-page workers)" },
  "cs.localhost":          { pt: "Localhost (Rust nativo)", en: "Localhost (native Rust)" },
  "cs.cloud":              { pt: "Nuvem (VM orquestrada)", en: "Cloud (orchestrated VM)" },
  "param.orchestrator_url":{ pt: "URL do orquestrador", en: "Orchestrator URL" },
  "param.cloud_token":     { pt: "Senha da nuvem", en: "Cloud password" },
  "cloud.idle":            { pt: "VM da nuvem parada.", en: "Cloud VM stopped." },
  "cloud.starting":        { pt: "Iniciando a VM da nuvem… (~{0})", en: "Starting cloud VM… (~{0})" },
  "cloud.ready":           { pt: "VM da nuvem pronta ({0} núcleos).", en: "Cloud VM ready ({0} cores)." },
  "cloud.stopping":        { pt: "Parando a VM da nuvem…", en: "Stopping cloud VM…" },
  "cloud.stopped_after":   { pt: "VM da nuvem parada após o cálculo.", en: "Cloud VM stopped after the run." },
  "cloud.stop_skipped":    { pt: "VM da nuvem mantida ligada — outra sessão está usando.", en: "Cloud VM kept running — another session is using it." },
  "cloud.orch_unreachable":{ pt: "Orquestrador inacessível — usando workers do navegador…", en: "Orchestrator unreachable — using browser workers…" },
  "cloud.boot_failed":     { pt: "Falha ao iniciar a VM da nuvem — usando workers do navegador…", en: "Cloud VM failed to start — using browser workers…" },
  "cloud.preempted":       { pt: "Nuvem indisponível — recalculando no navegador… (motivo: {0})", en: "Cloud unavailable — recomputing in the browser… (reason: {0})" },
  "cloud.transfer":        { pt: "Transferência: ↑ {0} · ↓ {1} · ~{2}", en: "Transfer: ↑ {0} up · ↓ {1} down · ~{2}" },
  "cloud.need_orch_url":   { pt: "Informe a URL do orquestrador para usar a nuvem.", en: "Enter the orchestrator URL to use Cloud." },
  "cloud.need_password":   { pt: "Informe a senha da nuvem para usar a nuvem.", en: "Enter the cloud password to use Cloud." },
  "cloud.auth_failed":     { pt: "Senha da nuvem incorreta — usando workers do navegador…", en: "Wrong cloud password — using browser workers…" },
  "cloud.creating":        { pt: "Criando a VM da nuvem… (~{0})", en: "Creating cloud VM… (~{0})" },
  "cloud.keep_warm":       { pt: "Manter VM ligada entre cálculos", en: "Keep VM warm between runs" },
  "cloud.warm":            { pt: "VM ligada — esfria após ~15 min de ócio (watchdog na VM).", en: "VM kept warm — auto-stops after ~15 min idle (in-VM watchdog)." },
  "cloud.size_mismatch":   { pt: "VM pronta com {0} vCPUs — a seleção de {1} vCPUs só vale no próximo boot (desligue a VM pra aplicar já).", en: "VM ready with {0} vCPUs — the {1}-vCPU selection only applies on the next boot (stop the VM to apply it now)." },
  "cloud.stop_now":        { pt: "Desligar VM agora", en: "Stop VM now" },
  "cloud.no_fallback":     { pt: "Falhar em vez de cair pro navegador", en: "Fail instead of falling back to browser" },
  "cloud.backend_old_ndirs": { pt: "backend {0} não serve direções ≠ 8 (precisa ≥ 0.2.0; pedido: {1})", en: "backend {0} doesn't serve directions ≠ 8 (needs ≥ 0.2.0; requested: {1})" },
  "cloud.failed_hard":     { pt: "cálculo na nuvem falhou (fallback desligado): {0}", en: "cloud compute failed (fallback disabled): {0}" },
  "cloud.stopping_manual": { pt: "Desligando a VM… o próximo cálculo religa no tamanho selecionado.", en: "Stopping the VM… the next compute boots the selected size." },
  "help.p.backend":      { pt: "Fonte de cálculo: três opções (2C). <em>Navegador</em> (padrão) roda em Web Workers na própria aba. <em>Localhost</em> fala com um servidor Rust opcional (backend/ no repositório, cargo run --release) na máquina do usuário. <em>Nuvem</em> aciona sob demanda uma VM no orquestrador — um serviço Cloud Run público, alcançável de qualquer origem —, protegida pela \"senha da nuvem\" compartilhada; \"Manter VM ligada entre cálculos\" evita religá-la a cada cálculo, mas ela desliga sozinha após ~15 min de ócio (watchdog dentro da própria VM), e cada cálculo com ela ligada é cobrado na conta do mantenedor. O seletor <em>\"Máquina da nuvem\"</em> escolhe o tamanho da VM (8/32/128 vCPUs, com preço de referência por hora — a VM roda em modo spot, tipicamente 60–90% mais barato que o valor mostrado); o tamanho é aplicado ao criar/religar a VM (uma VM já ligada mantém o tamanho até o próximo desligamento — o aviso de estado indica quando a seleção difere da VM ligada, e <em>\"Desligar VM agora\"</em> força a troca no próximo cálculo) e a estimativa de tempo modela o tamanho selecionado. Localhost e Nuvem aceleram tanto a densidade multi-referência (uma Dijkstra por referência, em todos os núcleos) quanto o campo de energia de fonte única (de/para/ida-e-volta); rotas (top-N), caminho até o destino e o modo grafo continuam sempre no navegador (nenhum backend produz rotas). Se o servidor ou a VM ficarem inacessíveis, o app volta para os workers do navegador, dizendo o motivo na linha de status — a menos que <em>\"Falhar em vez de cair pro navegador\"</em> esteja marcado, caso em que o cálculo aborta com o erro (útil pra não mascarar problemas da nuvem nem recomputar um DEM enorme no laptop sem querer).", en: "Compute source: three options (2C). <em>Browser</em> (default) runs in in-page Web Workers. <em>Localhost</em> talks to an optional Rust server (backend/ in the repo, cargo run --release) on the user's own machine. <em>Cloud</em> boots a VM on demand via the orchestrator — a public Cloud Run service, reachable from any origin — gated by the shared \"cloud password\"; \"Keep VM warm between runs\" avoids rebooting it on every run, but it still auto-stops after ~15 min idle (a watchdog inside the VM), and every run while it's up is billed to the maintainer's account. The <em>\"Cloud machine\"</em> selector picks the VM size (8/32/128 vCPUs, with a per-hour reference price — the VM runs as spot, typically 60–90% cheaper than shown); the size applies when the VM is created/restarted (a running VM keeps its size until the next stop — the status hint flags when the selection differs from the running VM, and <em>\"Stop VM now\"</em> forces the switch on the next compute) and the time estimate models the selected size. Localhost and Cloud both accelerate multi-reference density (one Dijkstra per reference, across all cores) AND the single-source energy field (from/to/round). Top-N routes, the destination path, and graph mode always stay in the browser (no backend produces routes). If the server or VM is unreachable, the app falls back to the in-browser workers, stating the reason in the status line — unless <em>\"Fail instead of falling back to browser\"</em> is ticked, in which case the run aborts with the error (useful to not mask cloud problems or accidentally recompute a huge DEM on the laptop)." },
  "param.max_workers":   { pt: "Máx. de workers de cálculo (0 = auto)", en: "Max compute workers (0 = auto)" },
  "param.use_wasm":      { pt: "Motor WebAssembly nos workers (mais rápido)", en: "WebAssembly engine in the workers (faster)" },
  "help.p.wasm":         { pt: "<em>Motor WebAssembly</em> (2C, ligado por padrão): os workers do navegador rodam a densidade multi-referência e o campo de energia de fonte única (de/para/ida-e-volta, sem destino/top-N) no <strong>mesmo motor do backend nativo</strong>, compilado para WebAssembly — o código de <code>backend/src/main.rs</code>, então os números são os do Localhost/Nuvem. Medido: ~2× mais rápido que o motor JS na densidade com 8 direções, ~1,5× com 16, e ~1,3–1,5× na fonte única. Usa mais memória por worker (o pool pode ficar menor num DEM grande — o app só troca de motor quando o ganho compensa) e fica com o motor JS em DEMs acima do orçamento de memória do navegador, a menos que \"Máx. de workers\" esteja definido. Até 4 GiB por worker (wasm32); acima disso, Chrome ≥ 133 e Firefox ≥ 143 usam a versão de 64 bits (até 16 GiB). Rotas, caminho até o destino e o modo grafo seguem no motor JS; qualquer falha do WebAssembly refaz o mesmo cálculo no JS. A passagem (<em>passes</em>) pode diferir do motor JS só em empates exatos de custo — mesmo comportamento do backend nativo.", en: "<em>WebAssembly engine</em> (2C, on by default): the browser workers run multi-reference density and the single-source energy field (from/to/round, no destination/top-N) on the <strong>native backend's own engine</strong>, compiled to WebAssembly — the code in <code>backend/src/main.rs</code>, so the numbers are Localhost/Cloud's. Measured: ~2× faster than the JS engine for density with 8 directions, ~1.5× with 16, and ~1.3–1.5× for single source. It uses more memory per worker (the pool can shrink on a big DEM — the app only switches engine when it pays off) and keeps the JS engine on DEMs above the browser's memory budget unless \"Max workers\" is set. Up to 4 GiB per worker (wasm32); beyond that, Chrome ≥ 133 and Firefox ≥ 143 use the 64-bit build (up to 16 GiB). Routes, the destination path and graph mode stay on the JS engine; any WebAssembly failure reruns the same compute on JS. Passes may differ from the JS engine only on exact cost ties — the same as the native backend." },
  "help.p.workers":      { pt: "Avançado: paraleliza a densidade entre este número de Web Workers. 0 = auto (dimensionado pelos núcleos e memória disponível). Só aumente se sua máquina tiver mais RAM do que o navegador reporta — cada worker usa cerca de 5 GB em um DEM grande, então exceder pode travar a aba.", en: "Advanced: parallelise density across this many Web Workers. 0 = auto (sized to cores and available memory). Only raise it if your machine has more RAM than the browser reports — each worker needs roughly 5 GB on a large DEM, so over-committing can crash the tab." },
  "param.n_refs":        { pt: "N referências", en: "N references" },
  "help.p.ref_direction": { pt: "A direção segue o Modo acima.", en: "Direction follows the Mode above." },
  "ref.place_random":    { pt: "Distribuir aleatórias", en: "Place random" },
  "param.sampling":      { pt: "Estratégia de amostragem", en: "Sampling strategy" },
  "sampling.uniform":    { pt: "uniforme (pseudoaleatória)", en: "uniform (pseudo-random)" },
  "sampling.sobol":      { pt: "Sobol (quase-aleatória)", en: "Sobol (quasi-random)" },
  "sampling.census":     { pt: "Censo IBGE 2022 (densidade populacional)", en: "IBGE 2022 census (population density)" },
  "help.p.sampling":     { pt: "Sequências quase-aleatórias (QMC) cobrem a área uniformemente sem aglomerados nem vazios — melhor convergência da densidade com menos referências. Cliques sucessivos continuam a sequência em vez de repeti-la. <strong>Censo IBGE 2022</strong> amostra as referências por densidade populacional (onde as pessoas moram): busca os setores censitários dentro do DEM na nuvem e sorteia pontos ponderados pela população — só funciona para DEMs no Brasil e exige internet.", en: "Quasi-random (QMC) sequences cover the area evenly, without the clumps and gaps of pseudo-random — the density converges with fewer references. Successive clicks continue the sequence rather than repeat it. <strong>IBGE 2022 census</strong> samples references by population density (where people actually live): it fetches the census sectors inside the DEM from the cloud and draws population-weighted points — Brazil-only DEMs, and it needs a network connection." },
  "census.fetching":     { pt: "Buscando setores censitários…", en: "Fetching census sectors…" },
  "census.placed":       { pt: "{0} referências distribuídas por população (Censo 2022).", en: "{0} references placed by population (2022 census)." },
  "census.placed.skipped": { pt: "{0} referências distribuídas por população ({1} fora do DEM ignoradas).", en: "{0} references placed by population ({1} skipped outside the DEM)." },
  "census.no_dem":       { pt: "Carregue um DEM antes de amostrar pelo censo.", en: "Load a DEM before census sampling." },
  "census.geographic":   { pt: "A amostragem por censo exige um DEM geográfico (lon/lat).", en: "Census sampling requires a geographic (lon/lat) DEM." },
  "census.outside_brazil": { pt: "O DEM está fora da cobertura do censo (Brasil).", en: "The DEM is outside census coverage (Brazil)." },
  "census.no_setores":   { pt: "Nenhum setor censitário com população na extensão do DEM.", en: "No populated census sectors in the DEM extent." },
  "census.no_points":    { pt: "Os pontos do censo caíram fora do DEM ou em células sem dado.", en: "The census points fell outside the DEM or on nodata cells." },
  "census.fetch_failed": { pt: "Falha ao buscar setores censitários: {0}", en: "Failed to fetch census sectors: {0}" },
  "census.lib_missing":  { pt: "Biblioteca FlatGeobuf indisponível (offline?). Reconecte e recarregue.", en: "FlatGeobuf library unavailable (offline?). Reconnect and reload." },
  "ref.clear":           { pt: "Limpar referências", en: "Clear refs" },
  // Per-marker popup (click a reference on the map) + undo/redo of the set.
  "ref.delete_this":     { pt: "Remover esta referência", en: "Remove this reference" },
  "ref.deleted":         { pt: "Referência {0} removida.", en: "Reference {0} removed." },
  "ref.undo.title":      { pt: "Desfazer (referências) — Ctrl+Z", en: "Undo (reference points) — Ctrl+Z" },
  "ref.redo.title":      { pt: "Refazer (referências) — Ctrl+Shift+Z", en: "Redo (reference points) — Ctrl+Shift+Z" },
  "ref.undo.done":       { pt: "Referências: desfeito.", en: "References: undone." },
  "ref.redo.done":       { pt: "Referências: refeito.", en: "References: redone." },
  "ref.none":            { pt: "nenhuma referência marcada", en: "no references placed" },
  "ref.count":           { pt: "{0} referência(s) marcada(s)", en: "{0} reference(s) placed" },
  "ref.show_markers":    { pt: "Mostrar marcadores de referência", en: "Show reference markers" },
  "ref.load_file":       { pt: "Carregar referências (GeoJSON)", en: "Load reference points (GeoJSON)" },
  "help.p.ref_file":     { pt: "Carregue um GeoJSON de pontos (Point), ex.: census/points.geojson. Cada ponto vira uma referência; pontos fora do DEM são ignorados. Substitui as referências atuais; limite de 2000.", en: "Load a GeoJSON of Point features (e.g. census/points.geojson). Each point becomes a reference; points outside the DEM are skipped. Replaces the current references; capped at 2000." },
  "ref.loaded":          { pt: "{0} referências carregadas de {1}.", en: "Loaded {0} reference points from {1}." },
  "ref.loaded.skipped":  { pt: "{0} referências carregadas de {1} ({2} fora do DEM ignoradas).", en: "Loaded {0} reference points from {1} ({2} skipped outside the DEM)." },
  "ref.load.no_dem":     { pt: "Carregue um DEM antes de carregar referências.", en: "Load a DEM before loading reference points." },
  "ref.load.geographic": { pt: "Carregar referências por arquivo exige um DEM geográfico (lon/lat).", en: "Loading reference points requires a geographic (lon/lat) DEM." },
  "ref.load.no_points":  { pt: "Nenhum ponto válido dentro do DEM em {0}.", en: "No valid points inside the DEM in {0}." },
  "ref.load.parse_error":{ pt: "Falha ao ler o GeoJSON: {0}", en: "Could not read the GeoJSON: {0}" },
  "param.n_routes":      { pt: "N (1–20)", en: "N (1–20)" },
  "param.penalty":       { pt: "penalidade / força", en: "penalty / strength" },
  "param.repulsion":     { pt: "Modo de repulsão", en: "Repulsion mode" },
  // Screen-reader names for the opacity sliders (no visible label of their
  // own — they sit beside the layer checkbox). Applied via data-i18n-aria.
  "rep.per_cell":        { pt: "por célula (penalidade^usadas)", en: "per-cell (penalty^used)" },
  "rep.linear":          { pt: "linear 1/(d+1)", en: "linear 1/(d+1)" },
  "rep.square":          { pt: "quadrática 1/(d²+1)", en: "square 1/(d²+1)" },
  "param.routes_cmap":   { pt: "Colormap das rotas", en: "Routes colormap" },
  "param.field_cmap":    { pt: "Colormap do campo", en: "Field colormap" },

  // ---- Compute -----------------------------------------------------------
  "btn.compute":         { pt: "Calcular", en: "Compute" },

  // ---- Group: Result ----------------------------------------------------
  "group.result":        { pt: "3. Resultados", en: "3. Results" },
  "group.result_stats":          { pt: "3A. Estatísticas", en: "3A. Statistics" },
  "group.result_energy":         { pt: "3B. Campo de energia", en: "3B. Energy field" },
  "group.result_density":        { pt: "3C. Densidade de trajetos", en: "3C. Trajectory density" },
  "group.result_density_net":    { pt: "3C.a. Densidade de trajetos na rede vetorial", en: "3C.a. Trajectory density on the vector network" },
  "group.result_density_terrain":{ pt: "3C.b. Densidade de trajetos no terreno", en: "3C.b. Trajectory density on the terrain" },
  "group.result_maxseg":         { pt: "3C.c. Segmento de densidade máxima", en: "3C.c. Max-density segment" },
  "group.result_legend":         { pt: "3D. Legenda", en: "3D. Legend" },
  // ---- Max-density segment (3C.c) ----------------------------------------
  "maxseg.hint":         { pt: "Encontra um caminho contínuo simples (que não se cruza) de ~L km maximizando a soma de densidade (∑ densidade·metro) do último cálculo — busca heurística (gulosa auto-evitante, multi-início, com lookahead) numa grade engrossada automaticamente; um ótimo global não é garantido.", en: "Finds a continuous simple (non-self-crossing) path of ~L km maximising the density sum (∑ density·metre) of the last run — a heuristic search (multi-start self-avoiding greedy with lookahead) on an automatically coarsened grid; a global optimum is not guaranteed." },
  "maxseg.need_geo":     { pt: "o segmento só é desenhado em DEMs geográficos (lat/long) — como as demais rotas", en: "the segment is only drawn on geographic (lat/long) DEMs — like the other routes" },
  "maxseg.len":          { pt: "comprimento alvo (km)", en: "target length (km)" },
  "btn.maxseg_run":      { pt: "Buscar segmento", en: "Find segment" },
  "btn.maxseg_clear":    { pt: "Remover segmento", en: "Remove segment" },
  "maxseg.need_passes":  { pt: "calcule um campo de densidade/passagens primeiro", en: "compute a density/passes field first" },
  "maxseg.too_short":    { pt: "comprimento alvo curto demais para este DEM (grade engrossada não o resolve)", en: "target length too short for this DEM (the coarsened grid can't resolve it)" },
  "maxseg.progress":     { pt: "buscando segmento… {0}%", en: "finding segment… {0}%" },
  "maxseg.result":       { pt: "L = {0} km · densidade média {1} ({2}× a média do campo) · retidão {4} · células de ~{3} m", en: "L = {0} km · mean density {1} ({2}× the field mean) · straightness {4} · ~{3} m cells" },
  "maxseg.turn":         { pt: "suavidade de curvas (expoente)", en: "turn smoothness (exponent)" },
  "maxseg.turn.title":   { pt: "Penaliza mudanças de direção passo a passo: cada passo é pontuado × ((1+cos Δθ)/2)^expoente contra a direção anterior. 0 desliga; maior = trajeto mais suave. Só guia a busca — a soma exibida é sempre a integral bruta da linha.", en: "Penalises step-by-step direction changes: each step is scored × ((1+cos Δθ)/2)^exponent against the previous direction. 0 disables; higher = smoother path. Steers the search only — the displayed sum is always the line's raw integral." },
  "maxseg.elong":        { pt: "retidão / anti-ida-e-volta (expoente)", en: "straightness / anti-round-trip (exponent)" },
  "maxseg.elong.title":  { pt: "Penaliza formas de ida-e-volta e incentiva segmentos alongados: cada passo é pontuado pela variação da distância às duas referências (a outra ponta do trajeto e uma âncora na janela local), e entre as sementes vence a corrida com maior recompensa × retidão^expoente (retidão = corda/comprimento = 1 − variância circular dos rumos). 0 desliga.", en: "Penalises round-trip shapes and rewards elongated segments: each step is scored by its change of distance to two references (the path's other end and a trailing anchor within the local window), and across seeds the run with the highest reward × straightness^exponent wins (straightness = chord/length = 1 − circular variance of the headings). 0 disables." },
  "maxseg.cmap":         { pt: "paleta (densidade relativa ao campo)", en: "palette (density relative to the field)" },
  "maxseg.cmap.title":   { pt: "Cor de cada segmento pela sua densidade média relativa à média do campo, proporcional ao melhor segmento da rodada (t = razão ÷ razão máxima; o melhor fica no topo da paleta). Trocar a paleta recolore na hora, sem recalcular. Os números exatos (×N da média) ficam no tooltip e na linha de resultado.", en: "Each segment coloured by its mean density relative to the field mean, proportional to the run's best segment (t = ratio ÷ max ratio; the best sits at the palette top). Changing the palette recolours instantly, no recompute. The exact numbers (×N of the mean) are in the tooltip and the result line." },
  "maxseg.nseg":         { pt: "nº de segmentos", en: "number of segments" },
  "maxseg.nseg.title":   { pt: "Segmentos consecutivos não-sobrepostos (até 100): depois de cada segmento encontrado, a densidade é zerada num tubo de ~2 células ao redor dele e a busca roda de novo no que sobrou. As células continuam transitáveis — um segmento posterior pode CRUZAR um anterior perpendicular (só não coleta nada ali), mas não pode repassar o mesmo corredor nem a pista vizinha. O custo é ~linear no número de segmentos; num campo sem densidade restante a busca para antes (retorna menos segmentos). Os últimos segmentos de uma lista longa tendem a caçar ruído — leia a densidade média de cada um.", en: "Consecutive non-overlapping segments (up to 100): after each found segment, the density is zeroed in a ~2-cell tube around it and the search re-runs on what is left. Cells stay traversable — a later segment may CROSS an earlier one perpendicular (it just collects nothing there), but cannot re-harvest the same corridor or its adjacent lane. Cost is ~linear in the segment count; on an exhausted field the search stops early (returns fewer segments). The last segments of a long list tend to chase noise — read each one's mean density." },
  "maxseg.lookback":     { pt: "janela anti-ida-e-volta local (km)", en: "local anti-round-trip window (km)" },
  "maxseg.lookback.title": { pt: "Distância da âncora local: passos que voltam em direção a onde o trajeto estava há essa distância são penalizados — mata idas-e-voltas locais (sair e voltar pela pista vizinha) que a referência global (outra ponta) não enxerga. Vazio = automático (L/8); 0 = desliga o termo local.", en: "Trailing-anchor distance: steps moving back toward where the path was this far back get penalised — kills local out-and-backs (out one lane, back the adjacent one) that the global (other-end) reference can't see. Blank = auto (L/8); 0 = disable the local term." },
  "maxseg.failed":       { pt: "busca falhou: {0}", en: "search failed: {0}" },
  "btn.refresh_style":   { pt: "Atualizar estilo", en: "Refresh style" },
  "result.empty":        { pt: "—", en: "—" },
  "layer.tiles":         { pt: "rmsampa-v2 tiles", en: "rmsampa-v2 tiles" },
  "layer.bridges":       { pt: "Pontes e túneis", en: "Bridges & tunnels" },
  "help.p.tiles":        { pt: '<a href="https://telhas.pedalhidrografi.co/rmsampa-v2/" target="_blank" rel="noopener" style="color: var(--accent-2);">Tiles XYZ</a> de pedalhidrografi.co.', en: '<a href="https://telhas.pedalhidrografi.co/rmsampa-v2/" target="_blank" rel="noopener" style="color: var(--accent-2);">XYZ tiles</a> from pedalhidrografi.co.' },
  "help.p.relief":       { pt: "Camada de relevo do DEM: cmocean.phase, p5–p80 · declividade 0–p80 (γ=1.2) multiplicada.", en: "DEM relief layer: cmocean.phase, p5–p80 · slope 0–p80 (γ=1.2) multiplied." },
  "vmin.label":          { pt: "min (auto = p1)", en: "min (auto = p1)" },
  "vmax.label":          { pt: "max (auto = p80)", en: "max (auto = p80)" },
  "vmin.passes":         { pt: "min (auto = p10)", en: "min (auto = p10)" },
  "vmax.passes":         { pt: "max (auto = p90)", en: "max (auto = p90)" },
  "help.p.energy_range": { pt: "Faixa da energia: Auto = recorte por percentil (p1–p80) mapeado linearmente para as cores. Fixar min e/ou max substitui o limite automático correspondente (clamping) — o mapeamento continua linear, só muda onde ele recorta.", en: "Energy range: Auto = percentile clip (p1–p80) mapped linearly to colour. Pinning min and/or max replaces the corresponding automatic bound (clamping) — the mapping stays linear, only the clip point changes." },
  "layer.basemap":       { pt: "Mapa base", en: "Basemap" },
  "basemap.osm":         { pt: "OSM (padrão)", en: "OSM (default)" },
  "basemap.dark":        { pt: "OSM minimalista preto", en: "OSM minimalist black" },
  "basemap.light":       { pt: "OSM minimalista branco", en: "OSM minimalist white" },
  "basemap.black":       { pt: "sem mapa base (tudo preto)", en: "no basemap (all black)" },
  "basemap.white":       { pt: "sem mapa base (tudo branco)", en: "no basemap (all white)" },
  "basemap.gray":        { pt: "sem mapa base (tudo cinza)", en: "no basemap (all gray)" },
  "basemap.satellite":   { pt: "Satélite (Esri)", en: "Satellite (Esri)" },
  "order.title":         { pt: "Controle de camadas", en: "Layer control" },
  "layer.ctrl_open":     { pt: "Controle de camadas", en: "Layer control" },
  "resizer.title":       { pt: "Arraste para 1–4 colunas (duplo-clique alterna)", en: "Drag to set 1–4 columns (double-click cycles)" },
  "status.dismiss":      { pt: "Dispensar", en: "Dismiss" },
  // Accessible names / tooltips (icon buttons, file pickers, layer rows) + a few
  // strings that used to be hardcoded (calibration, gate reasons, budget hint).
  "drawer.toggle":       { pt: "Mostrar/ocultar painel", en: "Show/hide panel" },
  "sheet.handle":        { pt: "Expandir/recolher painel", en: "Expand/collapse panel" },
  "lang.toggle.aria":    { pt: "Mudar idioma", en: "Switch language" },
  "modal.close":         { pt: "Fechar", en: "Close" },
  "aria.dem_file":       { pt: "Carregar DEM", en: "Load DEM" },
  "aria.vector_file":    { pt: "Carregar rede vetorial", en: "Load vector network" },
  "aria.mask_file":      { pt: "Carregar máscara de barreira", en: "Load barrier mask" },
  "aria.bundle_file":    { pt: "Importar bundle", en: "Import bundle" },
  "layer.opacity":       { pt: "opacidade", en: "opacity" },
  "order.move_up":       { pt: "Mover para cima", en: "Move up" },
  "order.move_down":     { pt: "Mover para baixo", en: "Move down" },
  "estimate.calibrating":{ pt: "≈ estimando…", en: "≈ estimating…" },
  "param.budget.title":  { pt: "≤0 = ∞ (sem orçamento)", en: "≤0 = ∞ (no budget)" },
  "compute.need_dem":    { pt: "Carregue um DEM primeiro", en: "Load a DEM first" },
  "compute.need_src":    { pt: "Clique no mapa para definir a origem", en: "Click the map to set the source" },
  "compute.need_ref":    { pt: "Defina ao menos 1 ponto de referência", en: "Place at least 1 reference point" },
  "help.modal_title":    { pt: "Simulador bici-geo-energético", en: "Bike-geo-energy simulator" },
  "order.hint":          { pt: "O topo da lista é desenhado por cima. Marcadores e tooltips ficam sempre acima. Aplicado na hora; lembrado neste dispositivo.", en: "Top of the list is drawn on top. Markers and tooltips always stay above. Applied immediately; remembered on this device." },
  "order.reset":         { pt: "Restaurar padrão", en: "Reset to default" },
  "order.relief":        { pt: "Relevo (DEM)", en: "Relief (DEM)" },
  "order.impassable":    { pt: "Máscara de barreira", en: "Impassable mask" },
  "order.energy":        { pt: "Energia", en: "Energy" },
  "order.network":       { pt: "Rede vetorial (linhas)", en: "Vector network (lines)" },
  "order.passes":        { pt: "Passagens", en: "Passes" },
  "order.refgeom":       { pt: "Geometria de referência", en: "Reference geometry" },
  "order.routes":        { pt: "Rotas / caminho", en: "Routes / path" },
  "layer.refgeom":       { pt: "Geometria de referência", en: "Reference geometry" },
  "refgeom.upload":      { pt: "Carregar trilha GPX", en: "Upload GPX track" },
  "refgeom.distance":    { pt: "Distância", en: "Distance" },
  "refgeom.energy":      { pt: "Energia total", en: "Total energy" },
  "refgeom.ascent":      { pt: "Subida total", en: "Total ascent" },
  "refgeom.descent":     { pt: "Descida total", en: "Total descent" },
  "refgeom.no_elevation":{ pt: "Sem dados de elevação (a trilha não traz elevação e não há DEM sob ela).", en: "No elevation data (the track carries no elevation and there's no DEM under it)." },
  "refgeom.loading":     { pt: "Lendo trilha GPX…", en: "Reading GPX track…" },
  "refgeom.loaded":      { pt: "Geometria de referência: {0} ({1} km).", en: "Reference geometry: {0} ({1} km)." },
  "refgeom.parse_error": { pt: "Arquivo GPX inválido.", en: "Invalid GPX file." },
  "refgeom.too_short":   { pt: "A trilha GPX precisa de ao menos 2 pontos.", en: "The GPX track needs at least 2 points." },
  "passes.gamma":        { pt: "γ gama (1 = sem mudança)", en: "γ gamma (1 = no change)" },
  "passes.mean_window":  { pt: "filtro média N", en: "mean filter N" },
  "passes.blend":        { pt: "Blend", en: "Blend" },
  "blend.add":           { pt: "soma de cores (plus-lighter)", en: "add colors (plus-lighter)" },
  "blend.sum_data":      { pt: "soma de dados (A+B numa paleta)", en: "data sum (A+B, one palette)" },
  "blend.normal":        { pt: "normal", en: "normal" },
  "blend.screen":        { pt: "screen", en: "screen" },
  "blend.multiply":      { pt: "multiply", en: "multiply" },
  "blend.overlay":       { pt: "overlay", en: "overlay" },
  "blend.energy":        { pt: "cor da energia (passagens = opacidade)", en: "energy color (passes = opacity)" },
  "help.p.compare":      { pt: "<em>\"Comparar com cenário sem rede\"</em> (1B) roda o cálculo duas vezes: uma restrita à rede (ou ao grafo), outra livre no raster sem restrição — e o seletor <em>\"Cenário exibido\"</em> (painel de camadas, 3B) escolhe qual energia/passagens aparecem: <em>restrito à rede</em>, <em>sem restrição</em>, ou <em>diferença</em> (custo da rede, com as passagens dos dois cenários sobrepostas — ver abaixo). A rota/energia de terreno usa a grade 8-conectada (comprimento até ~8% acima do geométrico) — Δ pequenos na diferença ficam dentro dessa diferença metodológica, não são necessariamente um custo físico real de ficar na rede.", en: "<em>\"Compare with unconstrained\"</em> (1B) runs the compute twice: once constrained to the network (or graph), once free on the unconstrained raster — and the <em>\"Displayed scenario\"</em> picker (layer panel, 3B) chooses which energy/passes are shown: <em>network-constrained</em>, <em>unconstrained</em>, or <em>difference</em> (network cost, with both scenarios' passes overlaid — see below). The terrain route/energy comes from the 8-connected grid (length up to ~8% above the geometric path) — small Δ values in the difference view sit within that methodological gap, not necessarily a real physical cost of staying on the network." },
  "help.p.passes_dual":  { pt: "Vista de diferença: o canal AZUL (terreno, cenário sem restrição) — deixar em branco usa o mesmo valor do canal LARANJA (rede, cenário com restrição). As duas cores são complementares aditivas (somam branco), então onde os dois cenários passam juntos o brilho é máximo; cada cor sozinha fica no eixo azul–amarelo, discriminável mesmo com daltonismo vermelho-verde.", en: "Difference view: the BLUE channel (terrain, unconstrained scenario) — leave blank to use the same value as the ORANGE channel (network, constrained). The two colours are additive complements (they sum to white), so where both scenarios route together brightness is maximal; each colour alone sits on the blue–yellow axis, discriminable even with red–green colour-blindness." },
  "help.p.passes_blend": { pt: "Mistura das passagens: rampa cinza; com \"soma de cores\" (plus-lighter), células de alta passagem clareiam o que está pintado abaixo — é uma soma de CORES contra todo o fundo (basemap incluso), escalada pela opacidade, então satura pro branco sobre mapa claro. \"Soma de dados\" soma os CAMPOS célula a célula (na vista de diferença: com rede + sem rede) e pinta a soma numa paleta só, em composição normal — escala honesta, independente do basemap (indisponível no modo grafo, onde um canal é vetorial). \"Cor da energia\" pinta os corredores com o colormap do campo de energia e usa as passagens como opacidade — min/max/γ moldam a rampa de alfa. Mesmo comportamento auto/pinado da Energia.", en: 'Greyscale ramp; with "add colors" (plus-lighter) high-pass cells brighten whatever is painted beneath — it adds COLORS against the whole backdrop (basemap included), scaled by opacity, so it saturates to white over a light basemap. "Data sum" adds the FIELDS cell by cell (in the difference view: constrained + unconstrained) and paints the sum on one palette with normal compositing — honest scale, basemap-independent (unavailable in graph mode, where one channel is vector). "Energy color" paints corridors with the energy field\'s colormap and uses passes for opacity — min/max/γ shape the alpha ramp. Same auto / pinned-range behaviour as Energy.' },
  "btn.range_reset":     { pt: "Reset auto", en: "Reset ranges to auto" },
  "btn.download_bundle": { pt: "Baixar bundle (.zip)", en: "Download bundle (.zip)" },
  "btn.export_rendered": { pt: "Exportar imagens renderizadas (.zip)", en: "Export rendered images (.zip)" },
  "btn.export_refs":     { pt: "Exportar referências (GeoJSON)", en: "Export references (GeoJSON)" },
  "ref.export_empty":    { pt: "Nenhuma referência para exportar.", en: "No references to export." },
  "io.inputs_hint":      { pt: "Dados de entrada (1A–1D), mesmo formato na ida e volta:", en: "Input datasets (1A–1D), same format both ways:" },
  "io.export_dem":       { pt: "Exportar DEM (.tif)", en: "Export DEM (.tif)" },
  "io.import_dem":       { pt: "Importar DEM (.tif)", en: "Import DEM (.tif)" },
  "io.export_network":   { pt: "Exportar rede (.gpkg)", en: "Export network (.gpkg)" },
  "io.import_network":   { pt: "Importar rede (.gpkg)", en: "Import network (.gpkg)" },
  "io.export_mask":      { pt: "Exportar máscara (.tif)", en: "Export mask (.tif)" },
  "io.import_mask":      { pt: "Importar máscara (.tif)", en: "Import mask (.tif)" },
  "io.export_bridges":   { pt: "Exportar pontes (.gpkg)", en: "Export bridges (.gpkg)" },
  "io.import_bridges":   { pt: "Importar pontes (.gpkg)", en: "Import bridges (.gpkg)" },
  "io.exported":         { pt: "{0} exportado.", en: "{0} exported." },
  "io.no_dem":           { pt: "Nenhum DEM carregado para exportar.", en: "No DEM loaded to export." },
  "io.no_mask":          { pt: "Nenhuma máscara carregada para exportar.", en: "No mask loaded to export." },
  "io.no_network":       { pt: "Nenhuma rede carregada para exportar.", en: "No network loaded to export." },
  "io.no_bridges":       { pt: "Nenhuma ponte carregada para exportar.", en: "No bridges loaded to export." },
  "io.no_dem_first":     { pt: "Carregue um DEM antes de importar pontes.", en: "Load a DEM before importing bridges." },
  "io.gpkg_invalid":     { pt: "Arquivo .gpkg inválido (sem gpkg_geometry_columns).", en: "Invalid .gpkg (no gpkg_geometry_columns)." },
  "io.gpkg_no_lines":    { pt: "Nenhuma linha encontrada no .gpkg.", en: "No line features found in the .gpkg." },
  "bridges.need_geographic": { pt: "As pontes precisam de um DEM geográfico (lon/lat).", en: "Bridges need a geographic (lon/lat) DEM." },
  "bridges.osm_need_geographic": { pt: "Puxar pontes do OSM precisa de um DEM geográfico (lon/lat).", en: "OSM bridge pull needs a geographic (lon/lat) DEM." },
  "bridges.pull_failed":     { pt: "Falha ao puxar pontes do OSM: {0}", en: "OSM bridge pull failed: {0}" },
  "bridges.none_overpass":   { pt: "O Overpass não retornou pontes/túneis nesta extensão.", en: "Overpass returned no bridges/tunnels in this extent." },
  "bridges.none_usable":     { pt: "{0}: nenhuma ponte/túnel utilizável neste DEM.", en: "{0}: no usable bridges/tunnels on this DEM." },
  "bridges.loaded":          { pt: "{0} tabuleiro(s) de ponte/túnel carregado(s).", en: "{0} bridge/tunnel deck(s) loaded." },
  "ref.export_done":     { pt: "{0} referência(s) exportada(s).", en: "Exported {0} reference(s)." },
  "credit":              { pt: "feito por Cláudio e dirigido pelos neogeógrafos geomorfológicos", en: "made by Cláudio, directed by the geomorphological neo-geographers" },

  // ---- Help modal -------------------------------------------------------
  "help.usage_heading":  { pt: "Como usar", en: "How to use" },
  "help.theory_heading": { pt: "O que estamos fazendo", en: "What we're doing" },
  "help.h.load_dem":     { pt: "Carregar um DEM", en: "Load a DEM" },
  "help.p.load_dem":     { pt: "Use o seletor para abrir um GeoTIFF local, clique num exemplo hospedado, ou aperte <em>Carregar FABDEM para a janela atual</em> (puxa tiles FABDEM 1°×1° pela extensão visível, limite de ~500 MB ≈ 10°²). O DEM aparece como retângulo tracejado e o mapa centra automaticamente. Com um DEM carregado, <em>Recortar à janela atual</em> extrai só a extensão visível (menos memória, cálculo mais rápido) e <em>Reduzir resolução</em> faz média de blocos N×N — num MDT de 5 m, 6× ≈ 30 m, o regime onde o modelo é mais preciso. Ambos passam pelo mesmo caminho de carga de um DEM novo (máscara, suavização, sondagem de tempo).", en: 'Use the file picker to open a local GeoTIFF, click a hosted example, or press <em>Load FABDEM for current viewport</em> (pulls FABDEM 1°×1° tiles for the visible extent, ~500 MB ≈ 10°² cap). The DEM is shown as a dashed rectangle and the map auto-centres. With a DEM loaded, <em>Crop to current view</em> extracts just the visible extent (less memory, faster computes) and <em>Downsample</em> does N×N block averaging — on a 5 m DTM, 6× ≈ 30 m, the regime where the model is most accurate. Both go through the same load path as a fresh DEM (mask, smoothing, timing probe).' },
  "help.h.points":       { pt: "Marcar pontos", en: "Pick points" },
  "help.p.points":       { pt: "<strong>Modo padrão:</strong> clique no mapa para o ponto-fonte (<code>src</code>). Um segundo clique marca o destino (<code>dst</code>) — necessário para \"até a fonte\", \"ida e volta\" e \"top-N rotas\".", en: '<strong>Default mode:</strong> click the map for the source (<code>src</code>). A second click sets the destination (<code>dst</code>) — required for "to source point", "round trip", and "top-N routes".' },
  "help.p.density_pts":  { pt: "<strong>Densidade multi-referência:</strong> ative <em>Calcular densidade multi-referência</em>. Os cliques agora adicionam pontos numerados. Use \"Distribuir aleatórias\" ou ajuste <em>N referências</em>. Política FIFO: ao exceder N, o mais antigo é descartado.", en: '<strong>Multi-reference density:</strong> turn on <em>Compute multi-reference density</em>. Clicks now add numbered reference points. Use "Place random" or adjust <em>N references</em>. FIFO policy: above N, the oldest is dropped.' },
  "help.h.params":       { pt: "Parâmetros", en: "Parameters" },
  "help.p.params":       { pt: "Modelo de energia v2: <em>massa</em>, <em>Crr</em> (rolamento), <em>CdA</em> (arrasto), <em>ρ</em> (densidade do ar), <em>eficiência da transmissão</em> e <em>potência no plano</em> (que fixa a velocidade de plano) definem o custo por metro; o <em>limiar de subida</em> separa onde o arrasto deixa de ser cobrado. <em>Orçamento</em> poda caminhos acima de um limiar (≤0 = sem orçamento).", en: 'v2 energy model: <em>mass</em>, <em>Crr</em> (rolling), <em>CdA</em> (drag), <em>ρ</em> (air density), <em>drivetrain efficiency</em> and <em>power on the flat</em> (which sets the flat speed) define the cost per metre; the <em>climb threshold</em> marks where aero stops being charged. <em>Budget</em> prunes paths above a threshold (≤0 = no budget).' },
  "help.h.compute":      { pt: "Calcular", en: "Compute" },
  "help.p.compute":      { pt: "Aperte <em>Calcular</em>. Habilitado quando há fonte (modo padrão) ou pelo menos uma referência (modo densidade). Estimativa de tempo aparece antes; durante a execução, a barra mostra o tempo restante.", en: 'Hit <em>Compute</em>. Enabled when a source is set (default mode) or at least one reference (density mode). A time estimate appears beforehand; during the run, the bar shows time remaining.' },
  "help.h.viz":          { pt: "Visualização", en: "Visualisation" },
  "help.p.viz":          { pt: "As camadas <em>Energia</em> e <em>Passagens</em> têm visibilidade, opacidade e blend independentes. Mudanças de colormap, range, gamma, filtro média e blend ficam pendentes até <em>Atualizar estilo</em> — evita re-renderizar a cada digitação em DEMs grandes.", en: 'The <em>Energy</em> and <em>Passes</em> layers have independent visibility, opacity, and blend. Changes to colormap, range, gamma, mean filter, and blend stay pending until you click <em>Refresh style</em> — saves re-rendering on every keystroke for large DEMs.' },
  "help.h.bundle":       { pt: "Salvar / restaurar", en: "Save / reload" },
  "help.p.bundle":       { pt: "<em>Baixar bundle (.zip)</em> empacota um <code>metadata.jsonld</code> com todos os parâmetros, mais GeoTIFFs georeferenciados (energy.tif, passes.tif, network.tif, impassable.tif) que abrem direto no QGIS. Para reproduzir: carregue o mesmo DEM, depois leia o JSON-LD ou ZIP. No modo \"até\", as rotas/caminho exportados (routes.geojson, path.geojson) têm coordenadas escritas origem→destino, mas a energia foi pontuada destino→referência — cada feição traz uma propriedade <code>direction</code> explicando isso.", en: '<em>Download bundle (.zip)</em> packs a <code>metadata.jsonld</code> with every parameter, plus georeferenced GeoTIFFs (energy.tif, passes.tif, network.tif, impassable.tif) that open directly in QGIS. To reproduce: load the same DEM, then read the JSON-LD or ZIP back. In "to" mode, the exported routes/path (routes.geojson, path.geojson) have coordinates written source→destination, but the energy was scored destination→reference — each feature carries a <code>direction</code> property spelling this out.' },
  "help.p.io_group":     { pt: "O grupo <em>\"0. Importar / Exportar dados\"</em> guarda três coisas separadas do bundle acima: <em>Exportar/Importar config</em> troca um JSON só com os parâmetros e toggles (sem dados geográficos) — útil para replicar a configuração noutro DEM; <em>Resetar para padrões</em> descarta esses ajustes; e, por dataset, <em>exportar/importar</em> o DEM (.tif), a rede (.gpkg), a máscara de barreira (.tif) e as pontes (.gpkg) — o mesmo formato usado para carregar cada um em 1A–1D, então o que sai daqui recarrega direto ali.", en: "The <em>\"0. Import / Export data\"</em> group holds three things separate from the bundle above: <em>Export/Import config</em> swaps a JSON with just the parameters and toggles (no geographic data) — handy for replaying the same setup on a different DEM; <em>Reset to defaults</em> discards those tweaks; and, per dataset, <em>export/import</em> the DEM (.tif), network (.gpkg), impassable mask (.tif), and bridges (.gpkg) — the same format used to load each one in 1A–1D, so what comes out here reloads straight back in there." },
  "help.h.cost":         { pt: "Modelo de custo assimétrico", en: "Asymmetric cost model" },
  "help.p.cost":         { pt: "Cada movimento entre células adjacentes (4 cardeais + 4 diagonais) custa em kJ, pelo modelo v2: os parâmetros físicos (massa total <em>m</em>, <em>Crr</em>, <em>CdA</em>, <em>ρ</em>, eficiência <em>k_eff</em>, potência de cruzeiro no plano, limiar de subida, suavização) são reduzidos uma vez ao pacote <code>{a_rol, a_aero, β, limiar, α/β, ε_offset}</code> (kJ/m e kJ). Com <code>Δh = h_v − h_u</code> e <code>d</code> a distância no chão:", en: 'Each move between adjacent cells (4 cardinal + 4 diagonal) costs kJ, per the v2 model: the physical parameters (total mass <em>m</em>, <em>Crr</em>, <em>CdA</em>, <em>ρ</em>, efficiency <em>k_eff</em>, cruise power on the flat, climb threshold, smoothing) are folded once into the bundle <code>{a_roll, a_aero, β, threshold, α/β, ε_offset}</code> (kJ/m and kJ). With <code>Δh = h_v − h_u</code> and <code>d</code> the ground distance:' },
  "help.formula":        { pt: "subida (Δh ≥ 0):  a_rol·d + (a_aero·d se rampa < limiar) + β·Δh\ndescida (Δh < 0): max(0, a_rol·d + a_aero·d − ε·β·|Δh|)\nε = clamp₀₁(min(1, (α/β)·d/|Δh|) − 0.13)",
                           en: "uphill (Δh ≥ 0):   a_roll·d + (a_aero·d if grade < threshold) + β·Δh\ndownhill (Δh < 0): max(0, a_roll·d + a_aero·d − ε·β·|Δh|)\nε = clamp₀₁(min(1, (α/β)·d/|Δh|) − 0.13)" },
  "help.p.cost_extra":   { pt: "Nos padrões (75 kg, Crr 0.008, CdA 0.45, ρ 1.1, k_eff 0.97, 80 W no plano), <code>β = m·g/k_eff ≈ 0.76 kJ/m</code> de subida — com <code>g = 9,7864 m/s²</code>, a gravidade <em>local</em> de São Paulo (gravimetria absoluta do IAG-USP), não os 9,81 de livro-texto; o arrasto (<code>a_aero</code>) só é cobrado abaixo do <em>limiar de subida</em> (2%) — subindo forte a velocidade cai e o arrasto some. Na descida a recuperação <code>ε</code> depende da rampa: descidas suaves devolvem quase todo o custo de resistência, descidas íngremes não devolvem nada (nunca abaixo de zero).", en: 'At the defaults (75 kg, Crr 0.008, CdA 0.45, ρ 1.1, k_eff 0.97, 80 W on the flat), <code>β = m·g/k_eff ≈ 0.76 kJ/m</code> of climb — with <code>g = 9.7864 m/s²</code>, São Paulo\'s <em>local</em> gravity (IAG-USP absolute gravimetry), not the textbook 9.81; aero (<code>a_aero</code>) is only charged below the <em>climb threshold</em> (2%) — on a steep climb speed drops and drag vanishes. Downhill the recovery <code>ε</code> depends on grade: gentle descents refund most of the resistance cost, steep ones refund nothing (never below zero).' },
  "help.p.cost_resolution": { pt: "O modelo v2 funciona melhor sobre relevo <em>tratado</em>. Em MDTs crus a energia lida sai conservadoramente ALTA e rotas com muita descida acabam relativamente mais penalizadas, porque a recuperação <code>ε</code> é calculada por rampa local e o ruído do relevo fabrica micro-descidas íngremes que a política grade-local se recusa a creditar. Desde a v64 o app aplica, ao carregar <em>qualquer</em> MDT (fino ou grosso, FABDEM incluso), uma <em>suavização</em> gaussiana estática (σ = 30 m, controlável em 1A) — a prática recomendada validada no journal do bicycling-energy-model (Entry 74: nos mapas σ30-tratados o ε grade-local vence toda célula do contraste de políticas; era σ = 10 m só em MDTs finos desde a v55/Entry 20). A precisão fina vem de <em>calibrar os parâmetros</em> (CdA, Crr, k_s) nos seus próprios percursos: com calibração, o erro validado fica abaixo de ±5% com viés < ±2% (procedimento no journal).", en: 'The v2 model behaves best on <em>treated</em> terrain. On raw DTMs energies read conservatively HIGH, and descent-heavy routes end up relatively over-charged, because the <code>ε</code> recovery is computed per local grade and terrain noise manufactures steep micro-descents the grade-local policy refuses to credit. Since v64 the app applies, when loading <em>any</em> DTM (fine or coarse, FABDEM included), a static Gaussian <em>smoothing</em> (σ = 30 m, controllable in 1A) — the recommended practice validated in the bicycling-energy-model journal (Entry 74: on σ30-treated maps the grade-local ε wins every cell of the policy contest; it was σ = 10 m on fine DTMs only since v55/Entry 20). Fine accuracy comes from <em>calibrating the parameters</em> (CdA, Crr, k_s) on your own rides: calibrated, the validated error is under ±5% with bias < ±2% (procedure in the journal).' },
  "param.dem_smooth":    { pt: "Suavização do MDT", en: "DEM smoothing" },
  "demsmooth.auto":      { pt: "auto (σ = 30 m em todas as fontes)", en: "auto (σ = 30 m on all sources)" },
  "demsmooth.off":       { pt: "desligada", en: "off" },
  "status.dem_smoothing": { pt: "Suavizando MDT (σ = {0} m)…", en: "Smoothing DEM (σ = {0} m)…" },
  "dem.crop":            { pt: "Recortar DEM à janela atual", en: "Crop DEM to current view" },
  "dem.crop_label":      { pt: "{0} · recorte {1}×{2}", en: "{0} · crop {1}×{2}" },
  "status.crop_need_geo": { pt: "Recorte só funciona em DEMs geográficos (lon/lat) — este DEM é projetado.", en: "Crop only works on geographic (lon/lat) DEMs — this DEM is projected." },
  "status.crop_no_overlap": { pt: "A janela atual não intersecta o DEM.", en: "The current view doesn't intersect the DEM." },
  "status.crop_noop":    { pt: "A janela atual cobre o DEM inteiro — nada a recortar.", en: "The current view covers the whole DEM — nothing to crop." },
  "status.crop_too_small": { pt: "Recorte pequeno demais (mínimo 2×2 células) — aproxime menos.", en: "Crop too small (minimum 2×2 cells) — zoom out a little." },
  "dem.downsample":      { pt: "Reduzir resolução", en: "Downsample" },
  "dem.downsample_label": { pt: "{0} · média {1}× {2}×{3}", en: "{0} · {1}× avg {2}×{3}" },
  "aria.downsample_factor": { pt: "Fator de redução de resolução", en: "Downsample factor" },
  "status.downsampling": { pt: "Reduzindo resolução (média {0}×)…", en: "Downsampling ({0}× block average)…" },
  "status.downsample_too_small": { pt: "Resultado pequeno demais ({0}×{1} células) — use um fator menor.", en: "Result too small ({0}×{1} cells) — use a smaller factor." },
  "help.h.field":        { pt: "Campo de energia", en: "Energy field" },
  "help.p.field":        { pt: "Dijkstra sobre todas as células passáveis a partir do ponto-fonte (ou para o ponto-destino, com arestas reversas) dá o custo mínimo de chegar a cada célula. É isso que a camada <em>Energia</em> renderiza.", en: 'Dijkstra over all passable cells starting from the source (or terminating at the destination, with reversed edges) gives the minimum cost to reach each cell. That\'s what the <em>Energy</em> layer renders.' },
  "help.h.modes":        { pt: "Modos", en: "Modes" },
  "help.p.modes":        { pt: "<em>Saindo da fonte</em>: campo direto a partir de <code>src</code>. <em>Vindo até a fonte</em>: campo reverso para <code>dst</code> — útil em terreno assimétrico (subir é mais caro que descer). <em>Ida e volta</em>: soma ida + volta, custo total de \"ir e voltar\" passando por cada célula.", en: '<em>From source</em>: forward field from <code>src</code>. <em>To source point</em>: reverse field arriving at <code>dst</code> — useful on asymmetric terrain (climbing costs more than descending). <em>Round trip</em>: forward + reverse summed, the total cost of going there and back through each cell.' },
  "help.h.passes":       { pt: "Contagem de passagens", en: "Passes count" },
  "help.p.passes":       { pt: "Para cada célula <code>c</code>, quantos caminhos ótimos passam por <code>c</code> — o tamanho da subárvore enraizada em <code>c</code> na árvore de caminhos mínimos. Destaca corredores naturais (\"autoestradas\") da paisagem energética. Em empates exatos de custo, qual dos caminhos empatados é creditado é um artefato da ordem de busca — a densidade e o backend nativo desempatam de forma idêntica, mas os modos de ponto único podem escolher diferente; em terreno plano e simétrico, corredores podem mudar entre execuções/motores sem que isso signifique nada sobre a topografia.", en: 'For each cell <code>c</code>, how many optimal paths pass through it — the size of the subtree rooted at <code>c</code> in the shortest-path tree. Highlights the natural corridors ("highways") of the energy landscape. On exactly-tied optimal costs, which of the tied paths gets credited is a search-order artefact — density and the native backend break ties identically, but the single-point modes may pick differently; on flat, symmetric terrain corridors can shift between runs/engines without meaning anything about the topography.' },
  "help.h.topn":         { pt: "Top-N rotas", en: "Top-N routes" },
  "help.p.topn":         { pt: "A* com penalização iterativa: encontra a rota ótima, multiplica o componente de custo por distância (<code>a_rol·d + a_aero·d</code>) das células reusadas por uma penalidade, repete N vezes. Modos de repulsão: <em>por célula</em> (penaliza só células reusadas, bordas duras), <em>linear</em> (1/(d+1), suave e ampla), <em>quadrática</em> (1/(d²+1), suave e local).", en: 'A* with iterative penalisation: find the optimal route, multiply the distance-cost component (<code>a_roll·d + a_aero·d</code>) of its cells by a penalty, repeat N times. Repulsion modes: <em>per-cell</em> (only re-used cells get penalised, sharp), <em>linear</em> (1/(d+1), soft and wide), <em>square</em> (1/(d²+1), soft and local).' },
  "help.h.density":      { pt: "Densidade multi-referência", en: "Multi-reference density" },
  "help.h.maxseg":       { pt: "Segmento de densidade máxima", en: "Max-density segment" },
  "help.p.maxseg":       { pt: "Análise pós-cálculo (3C.c): encontra um caminho contínuo <em>simples</em> (sem repassar células) de ~L km que maximiza a soma de densidade (<code>∑ densidade·metro</code>) sobre o campo de passagens/densidade já calculado. É o problema de <em>orienteering</em> (NP-difícil), então a busca é heurística: partidas múltiplas em células de alta densidade bem espaçadas, crescimento auto-evitante pelas duas pontas, lookahead guloso por candidato e penalizações de forma com knobs no painel — suavidade de curvas (sem ela o objetivo bruto premia serpentear dentro de corredores largos) e retidão/anti-ida-e-volta (referência na outra ponta + âncora local + halo de proximidade, que impede sair e voltar pela pista vizinha; a retidão ρ = corda/comprimento = 1 − variância circular dos rumos aparece no resultado). As penalizações guiam só a busca — a soma exibida é sempre a integral bruta da própria linha desenhada — sem garantia de ótimo global, mas com o caminho sempre simples por construção (uma DP exata sobre <em>passeios</em> foi testada e descartada: ela degenerava em vaivém sobre o trecho mais quente). O campo é engrossado automaticamente (média por bloco) até caber num teto fixo de células. Com <em>nº de segmentos</em> &gt; 1, os próximos segmentos são buscados com a densidade zerada num tubo de ±2 células ao redor dos anteriores — não-sobrepostos por construção (cruzamentos perpendiculares continuam possíveis; as células seguem transitáveis, só não rendem nada). Camada de exibição/análise apenas: nunca recalcula o campo, só desenha em DEMs geográficos (como as demais rotas), e as linhas somem quando o resultado que as originou é invalidado.", en: "Post-compute analysis (3C.c): finds a continuous <em>simple</em> path (no cell revisited) of ~L km that maximises the density sum (<code>∑ density·metre</code>) over the already-computed passes/density field. This is the <em>orienteering</em> problem (NP-hard), so the search is heuristic: multiple starts at well-separated high-density cells, two-ended self-avoiding growth, a greedy lookahead per candidate, and shape penalties with panel knobs — turn smoothness (without it the raw objective rewards snaking inside wide corridors) and straightness/anti-round-trip (other-end reference + local trailing anchor + a proximity halo that stops going out one lane and back the next; straightness ρ = chord/length = 1 − circular variance of the headings, shown in the result). The penalties steer the search only — the displayed sum is always the drawn line's own raw integral — no global-optimum guarantee, but the path is always simple by construction (an exact DP over <em>walks</em> was tried and dropped: it degenerated into shuttling over the single hottest stretch). The field is coarsened automatically (block mean) to a fixed cell budget. With <em>number of segments</em> &gt; 1, later segments are searched with the density zeroed in a ±2-cell tube around the earlier ones — non-overlapping by construction (perpendicular crossings remain possible; cells stay traversable, they just yield nothing). Display/analysis layer only: it never recomputes the field, draws only on geographic DEMs (like the other routes), and the lines are cleared when the result they derive from is invalidated." },
  "help.p.density":      { pt: "Para K pontos de referência: para cada um, computa as passagens, normaliza por <code>H·W</code>, soma; depois divide por <code>H·W</code> de novo. O resultado destaca corredores comuns entre múltiplas origens — útil para mapear \"onde a topografia força a passagem\". A camada de energia neste modo é a média por célula sobre as referências que conseguem alcançá-la. Perto da fronteira do orçamento (quando houver) ou da borda do DEM, o alcance de cada referência é cortado e as passagens ficam sistematicamente mais baixas ali; quando o orçamento (ou a borda) satura a maioria das referências, a densidade tende à uniformidade e as diferenças se achatam.", en: 'For K reference points: for each one, compute passes, normalise by <code>H·W</code>, sum; then divide by <code>H·W</code> again. The output highlights corridors common across multiple sources — useful for mapping "where topography forces traffic to converge". The energy layer in this mode is the per-cell mean across the references that can reach it. Near the budget frontier (when set) or the DEM border, each reference\'s reach is clipped and passes are systematically lower there; when the budget (or the border) saturates most references, density flattens toward uniform and differences wash out.' },
  "help.h.network":      { pt: "Restrição por rede vetorial (.gpkg)", en: "Vector network constraint (.gpkg)" },
  "help.p.network":      { pt: "Quando um arquivo de linhas vetoriais é carregado, toda a análise fica restrita às células tocadas por essas linhas — Dijkstra ignora qualquer célula fora da rede, e cliques no mapa \"agarram\" para a célula de rede mais próxima dentro do raio de snap configurado. O exemplo \"Viário RMSampa\" é dado © OpenStreetMap, licença ODbL.", en: 'When a vector-line file is loaded, the analysis is constrained to cells touched by those lines — Dijkstra ignores any cell outside the network, and map clicks "snap" to the nearest network cell within the configured snap radius. The "Viário RMSampa" example is data © OpenStreetMap, ODbL licence.' },
  "help.p.network_extra":{ pt: "<strong>Largura da linha</strong> (em células) controla a espessura do carimbo durante a rasterização. <strong>Raio de snap</strong> é a distância máxima (em células) que o clique procura uma célula de rede antes de desistir. As coordenadas das linhas são reprojetadas via <code>proj4js</code> para o CRS do DEM antes da rasterização.", en: '<strong>Line width</strong> (in cells) controls the stamp thickness during rasterisation. <strong>Snap radius</strong> is the maximum distance (in cells) a click searches for a network cell before giving up. Line coordinates are reprojected via <code>proj4js</code> to the DEM CRS before rasterising.' },
  "help.h.graph":        { pt: "Grafo da rede (seguir os vetores)", en: "Network graph (follow the vectors)" },
  "help.p.graph":        { pt: "Com <em>\"Usar grafo viário ao invés de rasterizado\"</em> (1B) ligado, o cálculo troca de motor: em vez do raster 8-conectado, roda sobre o grafo das próprias linhas vetoriais — nós nos vértices e nas junções, arestas custadas pelo mesmo modelo assimétrico ao longo de cada segmento. \"Restringir\" fica sempre ligado e travado (o cálculo já é só sobre a rede); \"comparar com cenário sem rede\" continua disponível. <strong>Junções</strong> controla como cruzamentos viram nós: <em>nos cruzamentos</em> também conecta interseções geométricas calculadas (viadutos coplanares se conectam, cruzamentos em nível diferente não); <em>extremos comuns</em> só conecta onde as linhas já compartilham um vértice coincidente. Pontes/túneis da própria rede (puxados do OSM) são achatados a um tabuleiro reto entre seus apoios — mesmos dados do 1D, mas sem aresta-portal. O snap de clique no grafo usa um raio fixo de 15 m, independente do \"raio de snap\" (em células) do 1B, que só vale no modo raster.", en: "With <em>\"Use road graph instead of rasterized\"</em> (1B) on, the compute switches engines: instead of the 8-connected raster, it runs over the graph of the vector lines themselves — nodes at vertices and junctions, edges costed by the same asymmetric model along each segment. \"Constrain\" is forced on and locked (the compute is already network-only); \"compare with unconstrained\" is still available. <strong>Junctions</strong> controls how crossings become nodes: <em>at crossings</em> also connects computed geometric intersections (co-planar overpasses connect, different-level crossings don't); <em>shared endpoints</em> only connects where lines already share a coincident vertex. The network's own bridges/tunnels (pulled from OSM) are flattened to a straight deck between their abutments — same 1D data, but no portal edge. Click-snapping on the graph uses a fixed 15 m radius, independent of 1B's \"snap radius\" (in cells), which only applies to the raster mode." },
  "help.h.interp":       { pt: "Interpolação fora da rede", en: "Off-network interpolation" },
  "help.p.interp":       { pt: "Visualização opcional: preenche células fora da rede com a média dos valores da rede em redor, usando o mesmo algoritmo do GDAL <code>fillnodata</code>. Para cada célula vazia, busca em 8 direções até achar uma célula de rede dentro de <strong>distância máx</strong> (em células); calcula a média ponderada por <code>1/d²</code> dos acertos. Em seguida, aplica <strong>suavizações</strong> passes de média 3×3 sobre o preenchimento — preservando os valores originais da rede.", en: 'Optional visualisation: fills off-network cells with a weighted mean of nearby on-network values, using the same algorithm as GDAL <code>fillnodata</code>. For each empty cell, scan 8 directions for a network cell within <strong>max distance</strong> (cells); compute a <code>1/d²</code>-weighted mean of the hits. Then apply <strong>smoothing iters</strong> 3×3 mean passes over the fill, preserving the original network values.' },
  "help.p.interp_only":  { pt: "Apenas para visualização; a análise (Dijkstra, top-N, densidade) continua estritamente sobre a rede.", en: 'For visualisation only; the analysis (Dijkstra, top-N, density) stays strictly on the network.' },
  "help.h.changelog":    { pt: "Histórico de versões (changelog)", en: "Changelog" },
  "help.changelog.loading": { pt: "Carregando o histórico…", en: "Loading the changelog…" },
  "help.changelog.error":   { pt: "Não foi possível carregar o histórico. Veja o <a href='./CHANGELOG.md' target='_blank' rel='noopener'>CHANGELOG.md</a>.", en: "Could not load the changelog. See <a href='./CHANGELOG.md' target='_blank' rel='noopener'>CHANGELOG.md</a>." },
  "help.changelog.full":    { pt: "<a href='./CHANGELOG.md' target='_blank' rel='noopener'>Changelog técnico completo</a>", en: "<a href='./CHANGELOG.md' target='_blank' rel='noopener'>Full technical changelog</a>" },
  "help.h.impl":         { pt: "Implementação", en: "Implementation" },
  "help.p.impl":         { pt: "JS puro, em Web Worker: Dijkstra 8-conectada com heap binária sobre arrays tipados (<code>Float64Array</code> de prioridades + <code>Int32Array</code> de payloads). Tudo o que precisa de Δh assimétrico, passes count, top-N e densidade roda no mesmo motor.", en: 'Pure JS in a Web Worker: 8-connected Dijkstra on a binary heap over typed arrays (<code>Float64Array</code> for priorities + <code>Int32Array</code> for payloads). Everything — asymmetric Δh, passes count, top-N, density — runs on the same engine.' },
  "help.h.attribution":  { pt: "Atribuições", en: "Attributions" },
  "help.p.attribution":  { pt: "Mapa com <a href='https://leafletjs.com' target='_blank' rel='noopener'>Leaflet</a> e <a href='https://github.com/geoman-io/leaflet-geoman' target='_blank' rel='noopener'>Leaflet-Geoman</a>. Camadas base: © <a href='https://www.openstreetmap.org/copyright' target='_blank' rel='noopener'>OpenStreetMap</a> contribuidores, © <a href='https://carto.com/attributions' target='_blank' rel='noopener'>CARTO</a>, © Esri — Maxar, Earthstar Geographics. Hidrografia soterrada (rmsampa-v2): <a href='https://pedalhidrografi.co' target='_blank' rel='noopener'>pedalhidrografi.co</a>.", en: "Map with <a href='https://leafletjs.com' target='_blank' rel='noopener'>Leaflet</a> and <a href='https://github.com/geoman-io/leaflet-geoman' target='_blank' rel='noopener'>Leaflet-Geoman</a>. Base layers: © <a href='https://www.openstreetmap.org/copyright' target='_blank' rel='noopener'>OpenStreetMap</a> contributors, © <a href='https://carto.com/attributions' target='_blank' rel='noopener'>CARTO</a>, © Esri — Maxar, Earthstar Geographics. Buried hydrography (rmsampa-v2): <a href='https://pedalhidrografi.co' target='_blank' rel='noopener'>pedalhidrografi.co</a>." },
};

// localStorage access can throw in iOS Safari Private Browsing — feature
// detection via `typeof` isn't enough, since the object exists but the
// getter throws SecurityError.
export let currentLang = "pt";
try {
  const saved = localStorage.getItem("simu-lang");
  if (saved === "pt" || saved === "en") currentLang = saved;
} catch {}

// Hook the language toggle uses to rebuild the layer-order panel's rows in
// place when it's open — the panel is a non-blocking corner panel that
// commonly stays open (it hosts the 3B-3D styling controls) across a
// language switch. Assigned inside the DOMContentLoaded closure (the panel's
// renderOrderList is a closure-scoped const, not a top-level function).
let refreshLayerOrderList = null;
export function setRefreshLayerOrderList(fn) { refreshLayerOrderList = fn; }

// Same idea for the two colormap <select>s' optgroup labels — assigned once
// both exist (DOMContentLoaded), called from applyTranslations().
let refreshColormapLabels = null;
export function setRefreshColormapLabels(fn) { refreshColormapLabels = fn; }

export function t(key, ...args) {
  const entry = STRINGS[key];
  if (!entry) return key;            // unknown keys surface verbatim — easy to spot
  let s = entry[currentLang] ?? entry.en ?? key;
  if (args.length) {
    s = s.replace(/\{(\d+)\}/g, (_, i) => args[+i] ?? "");
  }
  return s;
}

// Structured worker warnings ({kind:"warning", key, args, message}) route
// through STRINGS/t() when a key is present; `message` (plain English) is the
// fallback for node harnesses / a cached pre-i18n worker that has no key.
export function workerWarningText(m) {
  return m.key ? t(m.key, ...(m.args || [])) : m.message;
}

export function applyTranslations() {
  document.documentElement.lang = currentLang === "pt" ? "pt-BR" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
    // #refresh-style also carries data-i18n="btn.refresh_style", so the
    // generic textContent set above would silently erase markStyleDirty()'s
    // " ●" pending-style cue (dataset.dirty stays "1" — only the visible
    // marker was lost) on every language toggle.
    if (el.id === "refresh-style" && el.dataset.dirty === "1") el.textContent += " ●";
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  // placeholder dos inputs de texto (hoje só a busca de endereços).
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  // aria-label for controls with no visible label of their own (e.g. the
  // layer opacity sliders) — kept in sync with the language toggle.
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  // The lang pill displays the OTHER language (the one a click would switch to)
  // — clearer affordance than showing the current language.
  const pill = document.getElementById("lang-tag");
  if (pill) pill.textContent = currentLang === "pt" ? "EN" : "PT";
  // Update <title> on the document so the OS / tab bar reflects the choice.
  document.title = t("title");
  // Leaflet's default zoom control renders its own hardcoded English
  // title/aria-label — retitle its buttons here so the toggle keeps them
  // in sync too (simpler than replacing the control with a custom one).
  const zoomIn  = document.querySelector(".leaflet-control-zoom-in");
  const zoomOut = document.querySelector(".leaflet-control-zoom-out");
  if (zoomIn)  { zoomIn.title  = t("map.zoom_in");  zoomIn.setAttribute("aria-label", t("map.zoom_in")); }
  if (zoomOut) { zoomOut.title = t("map.zoom_out"); zoomOut.setAttribute("aria-label", t("map.zoom_out")); }
}

export function setLang(lang) {
  if (lang !== "pt" && lang !== "en") return;
  currentLang = lang;
  try { localStorage.setItem("simu-lang", lang); } catch {}
  // setLang is defined before `map` (const, further down the file) but only
  // ever CALLED after the whole script — and so `map` — has finished
  // initialising, so this is safe; the guard just documents that ordering.
  if (typeof map !== "undefined" && map.pm) map.pm.setLang(currentLang === "pt" ? "pt_br" : "en");
  applyTranslations();
  // applyTranslations() blindly re-applies each [data-i18n] element's EMPTY-state
  // string, which clobbers any live dynamic content. Re-render the dynamic metas
  // from state in the new language so loaded data / counts / picked points
  // survive a language toggle. (dem/vec/result metas drop their data-i18n on
  // write, so applyTranslations already leaves those alone.)
  if (typeof updateBridgeMeta === "function") updateBridgeMeta();
  if (typeof updateImpassableMeta === "function") updateImpassableMeta();
  if (typeof syncRefDisplay === "function") syncRefDisplay();
  if (typeof syncPointDisplays === "function") syncPointDisplays();
  // The cloud transfer line is set imperatively via t() (no data-i18n), so
  // re-render it after a language switch.
  if (typeof estimateRunTime === "function") estimateRunTime();
  // The layer-order panel builds its rows imperatively via t() only when
  // (re)opened — if it's currently open, rebuild it now so row labels,
  // aria-labels, and the GPX-upload tooltip follow the toggle without
  // requiring a close/reopen.
  if (refreshLayerOrderList && document.getElementById("layer-order-modal")?.classList.contains("active")) {
    refreshLayerOrderList();
  }
  if (refreshColormapLabels) refreshColormapLabels();
}

// Re-derive the src/dst point displays from state (density mode / src / dst), in
// the current language. Called on language toggle so picked coordinates and the
// correct prompt survive (applyTranslations would otherwise reset them).
function syncPointDisplays() {
  const srcDisp = document.getElementById("src-display");
  const dstDisp = document.getElementById("dst-display");
  if (!srcDisp || !dstDisp) return;
  if (document.getElementById("want-density")?.checked) {
    srcDisp.textContent = t("pts.density"); srcDisp.classList.remove("set");
    dstDisp.textContent = t("pts.density"); dstDisp.classList.remove("set");
    return;
  }
  if (state.src) { srcDisp.textContent = `r=${state.src[0]}, c=${state.src[1]}`; srcDisp.classList.add("set"); }
  else { srcDisp.textContent = t("pts.click_map"); srcDisp.classList.remove("set"); }
  if (state.dst) { dstDisp.textContent = `r=${state.dst[0]}, c=${state.dst[1]}`; dstDisp.classList.add("set"); }
  else { dstDisp.textContent = state.src ? t("pts.click_again") : t("pts.optional"); dstDisp.classList.remove("set"); }
}
