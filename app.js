// app.js — wires up DEM loading, map UI, worker dispatch, result overlay

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
  "title":               { pt: "Simulador bici-geo-energético",       en: "Bicycling Energy Field Simulator" },
  "lang.toggle.title":   { pt: "Idioma — clique para alternar PT/EN", en: "Language — click to switch PT/EN" },
  // (engine.* strings removed along with the engine-tag pill.)
  "locate.title":        { pt: "Centralizar na minha localização",     en: "Center on my location" },
  "locate.requesting":   { pt: "Buscando localização…",                 en: "Locating…" },
  "locate.centered":     { pt: "Centralizado em {0}, {1}.",             en: "Centred at {0}, {1}." },
  "locate.denied":       { pt: "Acesso à localização negado.",          en: "Location access denied." },
  // ---- Status / feedback line (#status) ---------------------------------
  // High-frequency lifecycle + validation messages and the FABDEM loader
  // (which was written in PT, so EN users saw stray Portuguese). {0}-style
  // placeholders are filled by t(); user-derived text is escaped by callers.
  "status.loading_dem":      { pt: "Carregando DEM…",                                  en: "Loading DEM…" },
  "status.computing":        { pt: "Calculando…",                                      en: "Computing…" },
  "status.done_ms":          { pt: "Concluído em {0} ms.",                             en: "Done in {0} ms." },
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
  "status.fabdem_failed":    { pt: "Falha ao carregar FABDEM: {0}",                  en: "FABDEM load failed: {0}" },
  // DEM loading
  "status.fetching":         { pt: "Buscando {0}…",                                  en: "Fetching {0}…" },
  "status.loading_label":    { pt: "Carregando {0}…",                                en: "Loading {0}…" },
  "status.error_generic":    { pt: "Erro: {0}",                                      en: "Error: {0}" },
  "status.dem_lonlat":       { pt: "DEM em lon/lat — distâncias aproximadas pela latitude (boas a ~0,3% em extensões < ~50 km).", en: "DEM is in lon/lat — distances approximated from latitude (good to ~0.3% under ~50 km extent)." },
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
  "status.osm_querying":     { pt: "Consultando OSM (Overpass) por highway=* …",     en: "Querying OSM (Overpass) for highway=* …" },
  "status.osm_parsing":      { pt: "Lendo resposta do OSM…",                         en: "Parsing OSM response…" },
  "status.osm_rasterising":  { pt: "Rasterizando {0} vias do OSM…",                  en: "Rasterising {0} OSM ways…" },
  "status.osm_failed":       { pt: "Falha ao puxar a rede do OSM: {0}",              en: "OSM network pull failed: {0}" },
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
  "status.vec_rasterising_of":   { pt: "Rasterizando… <span class=\"v\">{0}</span>/{1} ({2} desenhadas)", en: "Rasterising… <span class=\"v\">{0}</span>/{1} ({2} drawn)" },
  "status.vec_rasterising_scan": { pt: "Rasterizando… <span class=\"v\">{0}</span> varridas, {1} desenhadas", en: "Rasterising… <span class=\"v\">{0}</span> scanned, {1} drawn" },
  "status.net_meta_drawn":   { pt: "<span class=\"v\">{0}</span> linhas desenhadas<br/><span class=\"v\">{1}</span> células de rede ({2}% da grade)", en: "<span class=\"v\">{0}</span> lines drawn<br/><span class=\"v\">{1}</span> network cells ({2}% of grid)" },
  "status.net_meta_zero":    { pt: "EPSG:{0} · varridas <span class=\"v\">{1}</span> feições, desenhadas {2} — <span style=\"color:#ff6b6b\">0 células neste DEM</span>", en: "EPSG:{0} · scanned <span class=\"v\">{1}</span> features, drew {2} — <span style=\"color:#ff6b6b\">0 cells on this DEM</span>" },
  // Point picking / snapping
  "status.click_outside":    { pt: "Clique fora do DEM, ou DEM em CRS não geográfico (este protótipo só suporta DEMs EPSG:4326 — veja as notas).", en: "Click is outside the DEM, or DEM is in a non-geographic CRS (this prototype supports EPSG:4326 DEMs only — see notes)." },
  "status.click_nodata":     { pt: "A célula clicada é nodata.",                     en: "Clicked cell is nodata." },
  "status.net_no_snap_click":{ pt: "A rede carregada não tem células úteis neste DEM (verifique CRS/geometria) — não dá para agarrar cliques. Desmarque \"Restringir cálculo à rede\" ou limpe a rede para continuar.", en: "The loaded network has no usable cells on this DEM (check its CRS/geometry) — clicks can't be snapped. Untick \"Constrain compute to network\" or clear the network to continue." },
  "status.ref_random_mode":  { pt: "A colocação de referências está em \"aleatória\" — use \"Distribuir aleatórias\" ou mude para cliques.", en: "Ref placement is set to \"random\" — use \"Place random\" or switch placement to clicks." },
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
  "status.backend_fallback": { pt: "Backend nativo indisponível — usando workers do navegador…", en: "Native backend unavailable — using browser workers…" },
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
  "status.bundle_params_loaded":{ pt: "Parâmetros do bundle carregados. Clique em Compute para reproduzir.", en: "Bundle parameters loaded. Click Compute to reproduce." },
  "status.bundle_need_dem":  { pt: "Bundle carregado. Agora carregue o DEM correspondente{0} e clique em Compute.", en: "Bundle loaded. Now load the matching DEM{0} and click Compute." },
  "status.bundle_loaded":    { pt: "Bundle carregado. Clique no mapa para definir o ponto de origem.", en: "Bundle loaded. Click on the map to set source point." },
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
  "group.load_dem":      { pt: "1A. Carregar DEM", en: "1A. Load DEM" },
  "examples.heading":    { pt: "ou baixar (localmente) um exemplo:", en: "or download (locally) an example:" },
  "ex.aguapreta":        { pt: "Entorno da Água Preta", en: "Água Preta surroundings" },
  "ex.centro":           { pt: "Sampa Centro Expandido", en: "São Paulo central area" },
  "ex.geral":            { pt: "Sampa Sítio Urbano",    en: "São Paulo urban site" },
  "ex.fabdem":           { pt: "Carregar FABDEM para a janela atual", en: "Load FABDEM for current viewport" },
  "ex.tag.aguapreta":    { pt: "~2 MB · imediato",      en: "~2 MB · instant" },
  "ex.tag.centro":       { pt: "~34 MB · rápido",       en: "~34 MB · fast" },
  "ex.tag.geral":        { pt: "~540 MB · lento",       en: "~540 MB · slow" },
  "ex.tag.fabdem":       { pt: "≤ 50 MB",                en: "≤ 50 MB" },
  "dem.no_dem":          { pt: "Nenhum DEM carregado.", en: "No DEM loaded." },
  "bundle.reload_hint":  { pt: "Restaurar bundle (.zip) ou .jsonld:", en: "Reload a saved bundle (.zip) or .jsonld:" },

  // ---- Group: Vector network -------------------------------------------
  "group.network":       { pt: "1B. Rede vetorial opcional (.gpkg)", en: "1B. Optional vector network (.gpkg)" },
  "net.line_width":      { pt: "largura da linha (células)", en: "line width (cells)" },
  "net.snap_radius":     { pt: "raio de snap (células)", en: "snap radius (cells)" },
  "net.clear":           { pt: "Limpar rede",  en: "Clear network" },
  "net.render":          { pt: "Desenhar rede (linhas pretas)", en: "Draw network (black lines)" },
  "net.render_width":    { pt: "largura da linha (m)", en: "line width (m)" },
  "net.render_opacity":  { pt: "opacidade da linha", en: "line opacity" },
  "net.constrain":       { pt: "Restringir cálculo à rede", en: "Constrain compute to network" },
  "net.graph_mode":      { pt: "Calcular sobre o grafo da rede (seguir os vetores)", en: "Compute on network graph (follow vectors)" },
  "net.junctions":       { pt: "junções", en: "junctions" },
  "net.junctions_crossings": { pt: "também nos cruzamentos", en: "also at crossings" },
  "net.junctions_shared":    { pt: "só em extremos compartilhados", en: "only shared endpoints" },
  "net.osm":             { pt: "Puxar ruas do OSM (highway=*)", en: "Pull streets from OSM (highway=*)" },
  "help.p.network_osm":  { pt: "Consulta o Overpass sobre a vista atual ∩ extensão do DEM. Áreas grandes podem demorar ou estourar limites do Overpass — aproxime o zoom primeiro.", en: "Queries Overpass over the current map view ∩ DEM extent. Large areas can take a while or hit Overpass limits — zoom in first." },
  "net.compare":         { pt: "Comparar com cenário sem rede", en: "Compare with unconstrained" },
  "net.graph_constrain_locked": { pt: "No modo grafo o cálculo é sempre sobre a rede — \"restringir\" fica sempre ativo. \"Comparar\" continua disponível: compara com o cenário em raster sem a rede.", en: "In graph mode the compute is always on the network — \"constrain\" stays on. \"Compare\" is still available: it compares against the raster scenario without the network." },
  "layer.energy_source": { pt: "Cenário exibido (energia e passagens)", en: "Displayed scenario (energy & passes)" },
  "esrc.constrained":    { pt: "restrito à rede", en: "network-constrained" },
  "esrc.unconstrained":  { pt: "sem restrição", en: "unconstrained" },
  "esrc.difference":     { pt: "diferença (custo da rede)", en: "difference (network cost)" },
  "net.interp":          { pt: "Interpolar entre células fora da rede", en: "Interpolate across non-network cells" },
  "net.max_distance":    { pt: "distância máx (células)", en: "max distance (cells)" },
  "net.smoothing":       { pt: "suavizações", en: "smoothing iters" },
  "net.no_network":      { pt: "Nenhuma rede carregada.", en: "No network loaded." },

  // ---- Group: Impassable mask ------------------------------------------
  "group.impassable":    { pt: "1C. Máscara de barreira opcional (água)", en: "1C. Optional impassable mask (water)" },
  "imp.enabled":         { pt: "Aplicar ao cálculo", en: "Apply to compute" },
  "imp.invert":          { pt: "Inverter (raster marca células passáveis)", en: "Invert (raster marks passable cells)" },
  "imp.clear":           { pt: "Limpar máscara", en: "Clear mask" },
  "imp.osm":             { pt: "Puxar água do OSM", en: "Pull water from OSM" },
  "imp.rivers":          { pt: "Rios (linhas) intransponíveis", en: "Rivers (lines) impassable" },
  "imp.corridor":        { pt: "Rede abre corredores passáveis sobre a máscara", en: "Network carves passable corridors across the mask" },
  "imp.offset":          { pt: "deslocamento no centro da ponte (m, −5…+15)", en: "bridge centre offset (m, −5…+15)" },
  "imp.show":            { pt: "Mostrar máscara + corredores no mapa", en: "Show mask + corridors on map" },
  "imp.opacity":         { pt: "opacidade da camada", en: "overlay opacity" },
  "imp.none":            { pt: "Nenhuma máscara carregada.", en: "No impassable mask loaded." },
  "imp.meta.cells":      { pt: "{0} células barradas ({1}% da grade)", en: "{0} impassable cells ({1}% of grid)" },
  "imp.meta.corridor":   { pt: "{0} células de corredor (pontes)", en: "{0} bridge-corridor cells" },
  "imp.cell_blocked":    { pt: "Célula intransponível (máscara de barreira) — escolha outra.", en: "Impassable cell (barrier mask) — pick another." },
  "aria.opacity_impassable": { pt: "opacidade da máscara de barreira", en: "impassable mask opacity" },
  "help.h.impassable":   { pt: "1c · Máscara de barreira", en: "1c · Impassable mask" },

  // ---- Group: Bridges & tunnels ----------------------------------------
  "group.bridges":       { pt: "1D. Pontes e túneis opcionais (OSM)", en: "1D. Optional bridges & tunnels (OSM)" },
  "bridge.enabled":      { pt: "Aplicar ao cálculo", en: "Apply to compute" },
  "bridge.osm":          { pt: "Puxar pontes e túneis do OSM", en: "Pull bridges & tunnels from OSM" },
  "bridge.from_network": { pt: "Extrair da rede carregada", en: "Extract from loaded network" },
  "bridge.no_candidates":{ pt: "A rede carregada não tem pontes/túneis marcados (tags bridge/tunnel).", en: "The loaded network has no bridge/tunnel tags." },
  "bridge.tunnels":      { pt: "Incluir túneis (tunnel=yes)", en: "Include tunnels (tunnel=yes)" },
  "bridge.clear":        { pt: "Limpar pontes", en: "Clear bridges" },
  "bridge.show":         { pt: "Mostrar tabuleiros no mapa", en: "Show decks on map" },
  "bridge.opacity":      { pt: "opacidade do tabuleiro", en: "deck opacity" },
  "bridge.none":         { pt: "Nenhuma ponte carregada.", en: "No bridges loaded." },
  "bridge.meta.count":   { pt: "{0} tabuleiros de ponte/túnel", en: "{0} bridge/tunnel decks" },
  "bridge.meta.skipped": { pt: "{0} ignorados (fora do DEM ou apoio sem dado)", en: "{0} skipped (off-DEM or nodata abutment)" },
  "aria.opacity_bridge": { pt: "opacidade dos tabuleiros de ponte", en: "bridge deck opacity" },
  "help.h.bridges":      { pt: "1d · Pontes e túneis", en: "1d · Bridges & tunnels" },
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
  "param.alpha":         { pt: "α (por metro plano)", en: "α (per metre flat)" },
  "param.beta":          { pt: "β (por metro de subida)", en: "β (per metre uphill)" },
  "param.eta":           { pt: "η (recuperação descida)", en: "η (downhill recovery)" },
  "param.budget":        { pt: "Orçamento de energia (≤0 = ∞)", en: "Energy budget (≤0 = ∞)" },
  "param.budget_mode":   { pt: "Orçamento aplica-se a", en: "Budget applies to" },
  "budget.leg":          { pt: "cada perna (ida OU volta)", en: "each leg (out OR back)" },
  "budget.total":        { pt: "ida e volta (total)", en: "round trip (total)" },
  "help.p.budget_mode":  { pt: "Só no modo ida-e-volta. \"Cada perna\": célula visível se ida ≤ orçamento E volta ≤ orçamento (total pode chegar a 2×). \"Total\": ida + volta ≤ orçamento. A contagem de passagens conta apenas trajetos até células exibidas (dentro do orçamento); células-corredor ainda acumulam os trajetos que passam por elas.", en: 'Round-trip mode only. "Each leg": a cell is shown if out ≤ budget AND back ≤ budget (totals can reach 2×). "Total": out + back ≤ budget. The passes count only counts trajectories to displayed (within-budget) cells; corridor cells still accumulate the trajectories passing through them.' },
  "param.want_passes":   { pt: "Calcular contagem de passagens", en: "Compute passes count (route density)" },
  "param.want_topn":     { pt: "Calcular top-N rotas", en: "Compute top-N routes" },
  "param.want_density":  { pt: "Calcular densidade multi-referência", en: "Compute multi-reference density" },
  "param.use_backend":   { pt: "Usar backend nativo (Rust)", en: "Use native backend (Rust)" },
  "param.backend_url":   { pt: "URL do backend", en: "Backend URL" },
  // ---- Compute source (three-way: navegador / localhost / nuvem) --------
  "param.compute_source":  { pt: "Fonte de cálculo", en: "Compute source" },
  "cs.browser":            { pt: "Navegador (workers na página)", en: "Browser (in-page workers)" },
  "cs.localhost":          { pt: "Localhost (Rust nativo)", en: "Localhost (native Rust)" },
  "cs.cloud":              { pt: "Nuvem (VM orquestrada)", en: "Cloud (orchestrated VM)" },
  "param.orchestrator_url":{ pt: "URL do orquestrador", en: "Orchestrator URL" },
  "cloud.local_only":      { pt: "A nuvem só está disponível quando o app é servido localmente (o orquestrador escuta em loopback).", en: "Cloud is only available when the app is served locally (the orchestrator listens on loopback)." },
  "cloud.idle":            { pt: "VM da nuvem parada.", en: "Cloud VM stopped." },
  "cloud.starting":        { pt: "Iniciando a VM da nuvem… (~{0})", en: "Starting cloud VM… (~{0})" },
  "cloud.ready":           { pt: "VM da nuvem pronta ({0} núcleos).", en: "Cloud VM ready ({0} cores)." },
  "cloud.stopping":        { pt: "Parando a VM da nuvem…", en: "Stopping cloud VM…" },
  "cloud.stopped_after":   { pt: "VM da nuvem parada após o cálculo.", en: "Cloud VM stopped after the run." },
  "cloud.orch_unreachable":{ pt: "Orquestrador inacessível — usando workers do navegador…", en: "Orchestrator unreachable — using browser workers…" },
  "cloud.boot_failed":     { pt: "Falha ao iniciar a VM da nuvem — usando workers do navegador…", en: "Cloud VM failed to start — using browser workers…" },
  "cloud.preempted":       { pt: "VM da nuvem interrompida — recalculando no navegador…", en: "Cloud VM dropped — recomputing in the browser…" },
  "cloud.transfer":        { pt: "Transferência: ↑ {0} · ↓ {1} · ~{2}", en: "Transfer: ↑ {0} up · ↓ {1} down · ~{2}" },
  "cloud.need_orch_url":   { pt: "Informe a URL do orquestrador para usar a nuvem.", en: "Enter the orchestrator URL to use Cloud." },
  "cloud.keep_warm":       { pt: "Manter VM ligada entre cálculos", en: "Keep VM warm between runs" },
  "cloud.warm":            { pt: "VM ligada — esfria após ~15 min de ócio (lease + watchdog).", en: "VM kept warm — auto-stops after ~15 min idle (lease + watchdog)." },
  "help.p.backend":      { pt: "Servidor local opcional (backend/ no repositório, cargo run --release). Acelera tanto a densidade multi-referência (uma Dijkstra por referência, em todos os núcleos) quanto o campo de energia de fonte única (de/para/ida-e-volta). Rotas (top-N), caminho até o destino e \"maximizar\" continuam no navegador (o backend não produz rotas). Se inacessível, o app volta silenciosamente para os workers do navegador.", en: "Optional local server (backend/ in the repo, cargo run --release). Accelerates both multi-reference density (one Dijkstra per reference, across all cores) AND the single-source energy field (from/to/round). Top-N routes, the destination path, and \"maximize\" stay in the browser (the backend produces no routes). If unreachable, the app silently falls back to the in-browser workers." },
  "param.max_workers":   { pt: "Máx. de workers de cálculo (0 = auto)", en: "Max compute workers (0 = auto)" },
  "help.p.workers":      { pt: "Avançado: paraleliza a densidade entre este número de Web Workers. 0 = auto (dimensionado pelos núcleos e memória disponível). Só aumente se sua máquina tiver mais RAM do que o navegador reporta — cada worker usa cerca de 5 GB em um DEM grande, então exceder pode travar a aba.", en: "Advanced: parallelise density across this many Web Workers. 0 = auto (sized to cores and available memory). Only raise it if your machine has more RAM than the browser reports — each worker needs roughly 5 GB on a large DEM, so over-committing can crash the tab." },
  "param.maximize":      { pt: "Maximizar energia (inverter otimização)", en: "Maximize energy (reverse optimization)" },
  "param.max_length":    { pt: "Comprimento L (arestas, 0 = sem restrição)", en: "Path length L (edges, 0 = unconstrained)" },
  "help.p.maximize":     { pt: "0: Dijkstra invertido (geometricamente curto, custo denso). L>0: DP em camadas encontra o caminho de custo máximo com exatamente L arestas entre src e dst. Limite de memória ≈ 256 MB ⇒ L·H·W precisa caber; DEMs grandes limitam L a poucas dezenas.", en: "0: inverted Dijkstra (geometrically short, cost-dense). L>0: layered DP finds the max-cost path of exactly L edges from src to dst. Memory cap ≈ 256 MB ⇒ L·H·W must fit; large DEMs limit L to a few dozen." },
  "param.n_refs":        { pt: "N referências", en: "N references" },
  "param.ref_source":    { pt: "Origem das referências", en: "Reference source" },
  "ref.click":           { pt: "clicar no mapa", en: "click on map" },
  "ref.random":          { pt: "aleatórias", en: "random" },
  "help.p.ref_direction": { pt: "A direção segue o Modo acima.", en: "Direction follows the Mode above." },
  "ref.place_random":    { pt: "Distribuir aleatórias", en: "Place random" },
  "param.sampling":      { pt: "Estratégia de amostragem", en: "Sampling strategy" },
  "sampling.random":     { pt: "pseudoaleatória", en: "pseudo-random" },
  "sampling.uniform":    { pt: "uniforme (pseudoaleatória)", en: "uniform (pseudo-random)" },
  "sampling.sobol":      { pt: "Sobol (quase-aleatória)", en: "Sobol (quasi-random)" },
  "sampling.halton":     { pt: "Halton (quase-aleatória)", en: "Halton (quasi-random)" },
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
  "ref.none":            { pt: "nenhuma referência marcada", en: "no references placed" },
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
  "aria.opacity_tiles":  { pt: "Opacidade da camada de tiles", en: "Tile layer opacity" },
  "aria.opacity_relief": { pt: "Opacidade da camada de relevo", en: "Relief layer opacity" },
  "aria.opacity_energy": { pt: "Opacidade da camada de energia", en: "Energy layer opacity" },
  "aria.opacity_passes": { pt: "Opacidade da camada de passagens", en: "Passes layer opacity" },
  "rep.per_cell":        { pt: "por célula (penalidade^usadas)", en: "per-cell (penalty^used)" },
  "rep.linear":          { pt: "linear 1/(d+1)", en: "linear 1/(d+1)" },
  "rep.square":          { pt: "quadrática 1/(d²+1)", en: "square 1/(d²+1)" },
  "param.routes_cmap":   { pt: "Colormap das rotas", en: "Routes colormap" },
  "param.field_cmap":    { pt: "Colormap do campo", en: "Field colormap" },

  // ---- Compute -----------------------------------------------------------
  "btn.compute":         { pt: "Calcular", en: "Compute" },

  // ---- Group: Result ----------------------------------------------------
  "group.result":        { pt: "3. Resultados", en: "3. Results" },
  "btn.refresh_style":   { pt: "Atualizar estilo", en: "Refresh style" },
  "result.empty":        { pt: "—", en: "—" },
  "layer.tiles":         { pt: "rmsampa-v2 tiles", en: "rmsampa-v2 tiles" },
  "help.p.tiles":        { pt: '<a href="https://telhas.pedalhidrografi.co/rmsampa-v2/" target="_blank" rel="noopener" style="color: var(--accent-2);">Tiles XYZ</a> de pedalhidrografi.co.', en: '<a href="https://telhas.pedalhidrografi.co/rmsampa-v2/" target="_blank" rel="noopener" style="color: var(--accent-2);">XYZ tiles</a> from pedalhidrografi.co.' },
  "layer.relief":        { pt: "Relevo (DEM)", en: "Relief (DEM)" },
  "help.p.relief":       { pt: "Camada de relevo do DEM: cmocean.phase, p5–p80 · declividade 0–p80 (γ=1.2) multiplicada.", en: "DEM relief layer: cmocean.phase, p5–p80 · slope 0–p80 (γ=1.2) multiplied." },
  "layer.energy":        { pt: "Energia", en: "Energy" },
  "vmin.label":          { pt: "min (auto = p1)", en: "min (auto = p1)" },
  "vmax.label":          { pt: "max (auto = p80)", en: "max (auto = p80)" },
  "vmin.passes":         { pt: "min (auto = p10)", en: "min (auto = p10)" },
  "vmax.passes":         { pt: "max (auto = p90)", en: "max (auto = p90)" },
  "help.p.energy_range": { pt: "Faixa da energia: Auto = esticada por raiz quadrada; fixe qualquer limite (min/max) para escala linear com clamping.", en: "Energy range: Auto = sqrt-stretched; pin either bound (min/max) for a linear scale with clamping." },
  "layer.passes":        { pt: "Passagens (overlay)", en: "Passes (overlay)" },
  "layer.basemap":       { pt: "Mapa base", en: "Basemap" },
  "basemap.osm":         { pt: "OSM (padrão)", en: "OSM (default)" },
  "basemap.dark":        { pt: "OSM minimalista preto", en: "OSM minimalist black" },
  "basemap.light":       { pt: "OSM minimalista branco", en: "OSM minimalist white" },
  "basemap.black":       { pt: "sem mapa base (tudo preto)", en: "no basemap (all black)" },
  "basemap.white":       { pt: "sem mapa base (tudo branco)", en: "no basemap (all white)" },
  "basemap.gray":        { pt: "sem mapa base (tudo cinza)", en: "no basemap (all gray)" },
  "basemap.satellite":   { pt: "Satélite (Esri)", en: "Satellite (Esri)" },
  "order.open":          { pt: "Controle de camadas…", en: "Layer control…" },
  "order.title":         { pt: "Controle de camadas", en: "Layer control" },
  "layer.ctrl_open":     { pt: "Controle de camadas", en: "Layer control" },
  "resizer.title":       { pt: "Arraste para 1–4 colunas", en: "Drag to set 1–4 columns" },
  "status.dismiss":      { pt: "Dispensar", en: "Dismiss" },
  "order.hint":          { pt: "O topo da lista é desenhado por cima. Marcadores e tooltips ficam sempre acima. Aplicado na hora; lembrado neste dispositivo.", en: "Top of the list is drawn on top. Markers and tooltips always stay above. Applied immediately; remembered on this device." },
  "order.reset":         { pt: "Restaurar padrão", en: "Reset to default" },
  "order.relief":        { pt: "Relevo (DEM)", en: "Relief (DEM)" },
  "order.impassable":    { pt: "Máscara de barreira", en: "Impassable mask" },
  "order.energy":        { pt: "Energia", en: "Energy" },
  "order.network":       { pt: "Rede vetorial (linhas)", en: "Vector network (lines)" },
  "order.passes":        { pt: "Passagens", en: "Passes" },
  "order.routes":        { pt: "Rotas / caminho", en: "Routes / path" },
  "passes.gamma":        { pt: "γ gama (1 = sem mudança)", en: "γ gamma (1 = no change)" },
  "passes.mean_window":  { pt: "filtro média N", en: "mean filter N" },
  "passes.blend":        { pt: "Blend", en: "Blend" },
  "blend.add":           { pt: "soma (plus-lighter)", en: "add (plus-lighter)" },
  "blend.normal":        { pt: "normal", en: "normal" },
  "blend.screen":        { pt: "screen", en: "screen" },
  "blend.multiply":      { pt: "multiply", en: "multiply" },
  "blend.overlay":       { pt: "overlay", en: "overlay" },
  "blend.energy":        { pt: "cor da energia (passagens = opacidade)", en: "energy color (passes = opacity)" },
  "help.p.passes_dual":  { pt: "Vista de diferença: o canal AZUL (terreno, cenário sem restrição) — deixar em branco usa o mesmo valor do canal LARANJA (rede, cenário com restrição). As duas cores são complementares aditivas (somam branco), então onde os dois cenários passam juntos o brilho é máximo; cada cor sozinha fica no eixo azul–amarelo, discriminável mesmo com daltonismo vermelho-verde.", en: "Difference view: the BLUE channel (terrain, unconstrained scenario) — leave blank to use the same value as the ORANGE channel (network, constrained). The two colours are additive complements (they sum to white), so where both scenarios route together brightness is maximal; each colour alone sits on the blue–yellow axis, discriminable even with red–green colour-blindness." },
  "passes.chan_net":     { pt: "Rede (com restrição)", en: "Network (constrained)" },
  "passes.chan_terrain": { pt: "Terreno (livre)", en: "Terrain (unconstrained)" },
  "help.p.passes_blend": { pt: "Mistura das passagens: rampa cinza; com modo \"soma\", células de alta passagem clareiam o campo de energia abaixo. \"Cor da energia\" pinta os corredores com o colormap do campo de energia e usa as passagens como opacidade — min/max/γ moldam a rampa de alfa. Mesmo comportamento auto/pinado da Energia.", en: 'Greyscale ramp; with "add" mode high-pass cells brighten the energy field beneath. "Energy color" paints corridors with the energy field\'s colormap and uses passes for opacity — min/max/γ shape the alpha ramp. Same auto / pinned-range behaviour as Energy.' },
  "btn.range_reset":     { pt: "Reset auto", en: "Reset ranges to auto" },
  "btn.download_bundle": { pt: "Baixar bundle (.zip)", en: "Download bundle (.zip)" },
  "btn.export_rendered": { pt: "Exportar imagens renderizadas (.zip)", en: "Export rendered images (.zip)" },
  "btn.export_refs":     { pt: "Exportar referências (GeoJSON)", en: "Export references (GeoJSON)" },
  "credit":              { pt: "feito por Cláudio e dirigido pelos neogeógrafos geomorfológicos", en: "made by Cláudio, directed by the geomorphological neo-geographers" },

  // ---- Help modal -------------------------------------------------------
  "help.usage_heading":  { pt: "Como usar", en: "How to use" },
  "help.theory_heading": { pt: "O que estamos fazendo", en: "What we're doing" },
  "help.h.load_dem":     { pt: "1 · Carregar um DEM", en: "1 · Load a DEM" },
  "help.p.load_dem":     { pt: "Use o seletor para abrir um GeoTIFF local, clique num exemplo hospedado, ou aperte <em>Carregar FABDEM para a janela atual</em> (puxa tiles FABDEM 1°×1° pela extensão visível, limite de 50 MB). O DEM aparece como retângulo tracejado e o mapa centra automaticamente.", en: 'Use the file picker to open a local GeoTIFF, click a hosted example, or press <em>Load FABDEM for current viewport</em> (pulls FABDEM 1°×1° tiles for the visible extent, 50 MB cap). The DEM is shown as a dashed rectangle and the map auto-centres.' },
  "help.h.points":       { pt: "2 · Marcar pontos", en: "2 · Pick points" },
  "help.p.points":       { pt: "<strong>Modo padrão:</strong> clique no mapa para o ponto-fonte (<code>src</code>). Um segundo clique marca o destino (<code>dst</code>) — necessário para \"até a fonte\", \"ida e volta\" e \"top-N rotas\".", en: '<strong>Default mode:</strong> click the map for the source (<code>src</code>). A second click sets the destination (<code>dst</code>) — required for "to source point", "round trip", and "top-N routes".' },
  "help.p.density_pts":  { pt: "<strong>Densidade multi-referência:</strong> ative <em>Calcular densidade multi-referência</em>. Os cliques agora adicionam pontos numerados. Use \"Distribuir aleatórias\" ou ajuste <em>N referências</em>. Política FIFO: ao exceder N, o mais antigo é descartado.", en: '<strong>Multi-reference density:</strong> turn on <em>Compute multi-reference density</em>. Clicks now add numbered reference points. Use "Place random" or adjust <em>N references</em>. FIFO policy: above N, the oldest is dropped.' },
  "help.h.params":       { pt: "3 · Parâmetros", en: "3 · Parameters" },
  "help.p.params":       { pt: "<code>α</code> custo por metro horizontal · <code>β</code> custo por metro de subida · <code>η</code> fração da subida recuperada na descida (0–1) · <em>Orçamento</em> para podar caminhos acima de um limiar (≤0 = sem orçamento).", en: '<code>α</code> cost per horizontal metre · <code>β</code> cost per metre uphill · <code>η</code> fraction of the climb recovered on descent (0–1) · <em>Budget</em> prunes paths above a threshold (≤0 = no budget).' },
  "help.h.maximize":     { pt: "Maximizar energia", en: "Maximize energy" },
  "help.h.compute":      { pt: "4 · Calcular", en: "4 · Compute" },
  "help.p.compute":      { pt: "Aperte <em>Calcular</em>. Habilitado quando há fonte (modo padrão) ou pelo menos uma referência (modo densidade). Estimativa de tempo aparece antes; durante a execução, a barra mostra o tempo restante.", en: 'Hit <em>Compute</em>. Enabled when a source is set (default mode) or at least one reference (density mode). A time estimate appears beforehand; during the run, the bar shows time remaining.' },
  "help.h.viz":          { pt: "5 · Visualização", en: "5 · Visualisation" },
  "help.p.viz":          { pt: "As camadas <em>Energia</em> e <em>Passagens</em> têm visibilidade, opacidade e blend independentes. Mudanças de colormap, range, gamma, filtro média e blend ficam pendentes até <em>Atualizar estilo</em> — evita re-renderizar a cada digitação em DEMs grandes.", en: 'The <em>Energy</em> and <em>Passes</em> layers have independent visibility, opacity, and blend. Changes to colormap, range, gamma, mean filter, and blend stay pending until you click <em>Refresh style</em> — saves re-rendering on every keystroke for large DEMs.' },
  "help.h.bundle":       { pt: "6 · Salvar / restaurar", en: "6 · Save / reload" },
  "help.p.bundle":       { pt: "<em>Baixar bundle (.zip)</em> empacota um <code>metadata.jsonld</code> com todos os parâmetros, mais GeoTIFFs georeferenciados (energy.tif, passes.tif, network.tif, impassable.tif) que abrem direto no QGIS. Para reproduzir: carregue o mesmo DEM, depois leia o JSON-LD ou ZIP.", en: '<em>Download bundle (.zip)</em> packs a <code>metadata.jsonld</code> with every parameter, plus georeferenced GeoTIFFs (energy.tif, passes.tif, network.tif, impassable.tif) that open directly in QGIS. To reproduce: load the same DEM, then read the JSON-LD or ZIP back.' },
  "help.h.cost":         { pt: "Modelo de custo assimétrico", en: "Asymmetric cost model" },
  "help.p.cost":         { pt: "Cada movimento entre células adjacentes (4 cardeais + 4 diagonais) tem custo em \"joules normalizados\". Com <code>Δh = h_v − h_u</code>:", en: 'Each move between adjacent cells (4 cardinal + 4 diagonal) costs "normalised joules". With <code>Δh = h_v − h_u</code>:' },
  "help.formula":        { pt: "subida (Δh ≥ 0):  α·dist + β·Δh\ndescida (Δh < 0): max(0, α·dist − η·β·|Δh|)",
                           en: "uphill (Δh ≥ 0):   α·dist + β·Δh\ndownhill (Δh < 0): max(0, α·dist − η·β·|Δh|)" },
  "help.p.cost_extra":   { pt: "Padrão <code>α = 0.008</code> (8 mJ/m horizontal), <code>β = 1</code> (1 J/m de subida), <code>η = 0.1</code> (10% da descida vira recuperação). Modelo grosseiro de ciclista: andar no plano custa pouco, subir custa muito, descer pode até <em>devolver</em> energia até zero.", en: 'Default <code>α = 0.008</code> (8 mJ/m horizontal), <code>β = 1</code> (1 J/m climbing), <code>η = 0.1</code> (10% of the climb is recovered). A rough cyclist model: flat is cheap, climbing is expensive, descending can <em>refund</em> down to zero.' },
  "help.h.field":        { pt: "Campo de energia", en: "Energy field" },
  "help.p.field":        { pt: "Dijkstra sobre todas as células passáveis a partir do ponto-fonte (ou para o ponto-destino, com arestas reversas) dá o custo mínimo de chegar a cada célula. É isso que a camada <em>Energia</em> renderiza.", en: 'Dijkstra over all passable cells starting from the source (or terminating at the destination, with reversed edges) gives the minimum cost to reach each cell. That\'s what the <em>Energy</em> layer renders.' },
  "help.h.modes":        { pt: "Modos", en: "Modes" },
  "help.p.modes":        { pt: "<em>Saindo da fonte</em>: campo direto a partir de <code>src</code>. <em>Vindo até a fonte</em>: campo reverso para <code>dst</code> — útil em terreno assimétrico (subir é mais caro que descer). <em>Ida e volta</em>: soma ida + volta, custo total de \"ir e voltar\" passando por cada célula.", en: '<em>From source</em>: forward field from <code>src</code>. <em>To source point</em>: reverse field arriving at <code>dst</code> — useful on asymmetric terrain (climbing costs more than descending). <em>Round trip</em>: forward + reverse summed, the total cost of going there and back through each cell.' },
  "help.h.passes":       { pt: "Contagem de passagens", en: "Passes count" },
  "help.p.passes":       { pt: "Para cada célula <code>c</code>, quantos caminhos ótimos passam por <code>c</code> — o tamanho da subárvore enraizada em <code>c</code> na árvore de caminhos mínimos. Destaca corredores naturais (\"autoestradas\") da paisagem energética.", en: 'For each cell <code>c</code>, how many optimal paths pass through it — the size of the subtree rooted at <code>c</code> in the shortest-path tree. Highlights the natural corridors ("highways") of the energy landscape.' },
  "help.h.topn":         { pt: "Top-N rotas", en: "Top-N routes" },
  "help.p.topn":         { pt: "A* com penalização iterativa: encontra a rota ótima, multiplica o termo <code>α·dist</code> em suas células por uma penalidade, repete N vezes. Modos de repulsão: <em>por célula</em> (penaliza só células reusadas, bordas duras), <em>linear</em> (1/(d+1), suave e ampla), <em>quadrática</em> (1/(d²+1), suave e local).", en: 'A* with iterative penalisation: find the optimal route, multiply the <code>α·dist</code> term over its cells by a penalty, repeat N times. Repulsion modes: <em>per-cell</em> (only re-used cells get penalised, sharp), <em>linear</em> (1/(d+1), soft and wide), <em>square</em> (1/(d²+1), soft and local).' },
  "help.h.density":      { pt: "Densidade multi-referência", en: "Multi-reference density" },
  "help.p.density":      { pt: "Para K pontos de referência: para cada um, computa as passagens, normaliza por <code>H·W</code>, soma; depois divide por <code>H·W</code> de novo. O resultado destaca corredores comuns entre múltiplas origens — útil para mapear \"onde a topografia força a passagem\". A camada de energia neste modo é a média por célula sobre as referências que conseguem alcançá-la.", en: 'For K reference points: for each one, compute passes, normalise by <code>H·W</code>, sum; then divide by <code>H·W</code> again. The output highlights corridors common across multiple sources — useful for mapping "where topography forces traffic to converge". The energy layer in this mode is the per-cell mean across the references that can reach it.' },
  "help.h.network":      { pt: "Restrição por rede vetorial (.gpkg)", en: "Vector network constraint (.gpkg)" },
  "help.p.network":      { pt: "Quando um arquivo de linhas vetoriais é carregado, toda a análise fica restrita às células tocadas por essas linhas — Dijkstra ignora qualquer célula fora da rede, e cliques no mapa \"agarram\" para a célula de rede mais próxima dentro do raio de snap configurado.", en: 'When a vector-line file is loaded, the analysis is constrained to cells touched by those lines — Dijkstra ignores any cell outside the network, and map clicks "snap" to the nearest network cell within the configured snap radius.' },
  "help.p.network_extra":{ pt: "<strong>Largura da linha</strong> (em células) controla a espessura do carimbo durante a rasterização. <strong>Raio de snap</strong> é a distância máxima (em células) que o clique procura uma célula de rede antes de desistir. As coordenadas das linhas são reprojetadas via <code>proj4js</code> para o CRS do DEM antes da rasterização.", en: '<strong>Line width</strong> (in cells) controls the stamp thickness during rasterisation. <strong>Snap radius</strong> is the maximum distance (in cells) a click searches for a network cell before giving up. Line coordinates are reprojected via <code>proj4js</code> to the DEM CRS before rasterising.' },
  "help.h.interp":       { pt: "Interpolação fora da rede", en: "Off-network interpolation" },
  "help.p.interp":       { pt: "Visualização opcional: preenche células fora da rede com a média dos valores da rede em redor, usando o mesmo algoritmo do GDAL <code>fillnodata</code>. Para cada célula vazia, busca em 8 direções até achar uma célula de rede dentro de <strong>distância máx</strong> (em células); calcula a média ponderada por <code>1/d²</code> dos acertos. Em seguida, aplica <strong>suavizações</strong> passes de média 3×3 sobre o preenchimento — preservando os valores originais da rede.", en: 'Optional visualisation: fills off-network cells with a weighted mean of nearby on-network values, using the same algorithm as GDAL <code>fillnodata</code>. For each empty cell, scan 8 directions for a network cell within <strong>max distance</strong> (cells); compute a <code>1/d²</code>-weighted mean of the hits. Then apply <strong>smoothing iters</strong> 3×3 mean passes over the fill, preserving the original network values.' },
  "help.p.interp_only":  { pt: "Apenas para visualização; a análise (Dijkstra, top-N, densidade) continua estritamente sobre a rede.", en: 'For visualisation only; the analysis (Dijkstra, top-N, density) stays strictly on the network.' },
  "help.h.changelog":    { pt: "Histórico de versões (changelog)", en: "Changelog" },
  "help.h.impl":         { pt: "Implementação", en: "Implementation" },
  "help.p.impl":         { pt: "JS puro, em Web Worker: Dijkstra 8-conectada com heap binária sobre arrays tipados (<code>Float64Array</code> de prioridades + <code>Int32Array</code> de payloads). Tudo o que precisa de Δh assimétrico, passes count, top-N e densidade roda no mesmo motor.", en: 'Pure JS in a Web Worker: 8-connected Dijkstra on a binary heap over typed arrays (<code>Float64Array</code> for priorities + <code>Int32Array</code> for payloads). Everything — asymmetric Δh, passes count, top-N, density — runs on the same engine.' },
};

// localStorage access can throw in iOS Safari Private Browsing — feature
// detection via `typeof` isn't enough, since the object exists but the
// getter throws SecurityError.
let currentLang = "pt";
try {
  const saved = localStorage.getItem("simu-lang");
  if (saved === "pt" || saved === "en") currentLang = saved;
} catch {}

function t(key, ...args) {
  const entry = STRINGS[key];
  if (!entry) return key;            // unknown keys surface verbatim — easy to spot
  let s = entry[currentLang] ?? entry.en ?? key;
  if (args.length) {
    s = s.replace(/\{(\d+)\}/g, (_, i) => args[+i] ?? "");
  }
  return s;
}

function applyTranslations() {
  document.documentElement.lang = currentLang === "pt" ? "pt-BR" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
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
}

function setLang(lang) {
  if (lang !== "pt" && lang !== "en") return;
  currentLang = lang;
  try { localStorage.setItem("simu-lang", lang); } catch {}
  applyTranslations();
  // The cloud transfer line is set imperatively via t() (no data-i18n), so
  // re-render it after a language switch.
  if (typeof estimateRunTime === "function") estimateRunTime();
}

// ---- Loaded-group highlight (style only — never affects compute) --------
// Lights up the whole "Load DEM" / "vector network" group while its data is
// present. There is no central state-change event in this app — DOM is
// driven off polled state — so this is called at every DEM/network load and
// clear site. `.toggle(..., bool)` makes the clear paths self-heal.
// Set exactly one status colour (or none) on a group's <details>/<summary>.
function setGroupStatus(id, status) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("st-green", "st-orange", "st-yellow", "st-red", "loaded");
  if (status) el.classList.add("st-" + status);
}

// Open/expand a collapsible group (and any ancestor <details>) so a nested
// group becomes visible. Used by the auto-expand hooks (DEM/network/mask/
// compute/bundle). Collapse state is not persisted — it follows these rules.
function setGroupOpen(id, open) {
  const el = document.getElementById(id);
  if (!el) return;
  el.open = !!open;
  if (open) {
    let p = el.parentElement;
    while (p) { if (p.tagName === "DETAILS") p.open = true; p = p.parentElement; }
  }
}

// Per-group status colours (style-only). Loaded inputs (1A-1D) go green when
// applied-to-compute, orange when loaded-but-not-applied. 3B/3C/4 reflect
// whether there are enough points, the run state, and a ready result.
function syncLoadedHighlights() {
  setGroupStatus("load-dem-group", state.dem ? "green" : "");
  const apply = (loaded, id) => loaded ? (document.getElementById(id)?.checked ? "green" : "orange") : "";
  setGroupStatus("network-group", apply(!!state.networkMask, "vec-constrain"));
  setGroupStatus("impassable-group", apply(!!state.impassable, "imp-enabled"));
  setGroupStatus("bridges-group", apply(!!(state.bridges && state.bridges.length), "bridge-enabled"));

  // 3B — points & references: red = can't compute, orange = partial, green = complete.
  let pts = "";
  if (state.dem) {
    if (document.getElementById("want-density")?.checked) {
      const n = state.refPoints ? state.refPoints.length : 0;
      const target = Math.max(1, parseInt(document.getElementById("n-refs")?.value, 10) || 1);
      pts = n <= 0 ? "red" : (n >= target ? "green" : "orange");
    } else {
      pts = !state.src ? "red" : (state.dst ? "green" : "orange");
    }
  }
  setGroupStatus("pick-points-group", pts);

  // 3C — execution: orange running, green succeeded, yellow runnable-idle.
  const runBtnEl = document.getElementById("run");
  let exec = "";
  if (state.computeStartedAt) exec = "orange";
  else if (state.lastResult) exec = "green";
  else if (state.dem && runBtnEl && !runBtnEl.disabled) exec = "yellow";
  setGroupStatus("execution-group", exec);

  // 4 — results: orange if a result is ready.
  // 4 — results: orange while a compute is running, green once it finished.
  setGroupStatus("result-group", state.computeStartedAt ? "orange" : (state.lastResult ? "green" : ""));
}

// ---- Accessible names for standalone labels -----------------------------
// Most numeric/select fields are labelled by a sibling <label> with no `for`,
// so assistive tech reads them as unnamed. Associate each orphan label with
// the form control immediately after it (those controls all carry ids).
// Labels that WRAP their control (the checkbox rows) already name it — skip.
// Run once after the DOM is ready; the associations don't change with language.
function associateOrphanLabels() {
  document.querySelectorAll("label:not([for])").forEach((lab) => {
    if (lab.querySelector("input, select, textarea")) return; // wrapping label
    const ctrl = lab.nextElementSibling;
    if (ctrl && /^(INPUT|SELECT|TEXTAREA)$/.test(ctrl.tagName) && ctrl.id) {
      lab.htmlFor = ctrl.id;
    }
  });
}

// ---- Parameter persistence (remember choices across reloads) ------------
// Saves the parameter / network / visualization control values to
// localStorage and restores them on load, so the user's knob settings
// survive a page reload. Deliberately EXCLUDES session data (the loaded DEM,
// src/dst, reference points — those ride in bundles) and `max-workers`
// (already persisted separately as simu-max-workers).
const PERSIST_KEY = "simu-params";
const PERSIST_IDS = [
  // Parameters
  "mode", "alpha", "beta", "eta", "e-max", "e-max-mode",
  "want-passes", "want-topn", "want-density", "maximize", "maximize-length",
  "n-refs", "ref-source", "ref-sampling", "refs-visible",
  "backend-url", "orchestrator-url", "cloud-keep-warm", "n-routes", "penalty", "repulsion-mode",
  "routes-colormap", "colormap",
  // Vector network
  "vec-width", "vec-snap", "vec-constrain", "vec-graph-mode", "vec-junction-mode",
  "vec-compare", "vec-render", "vec-render-width", "vec-render-opacity",
  "net-interp", "net-interp-max-dist", "net-interp-smoothing",
  // Visualization
  "basemap-select", "tile-visible", "tile-opacity", "relief-visible", "relief-opacity",
  "energy-visible", "energy-opacity", "vmin", "vmax",
  "passes-visible", "passes-opacity", "passes-vmin", "passes-vmax",
  "passes-gamma", "passes-mean-window", "passes-blend",
  "passes-vmin-b", "passes-vmax-b", "passes-gamma-b", "passes-mean-window-b",
];
// Restored controls whose change must re-fire dependent UI (sub-panel
// show/hide, basemap swap). We dispatch a synthetic change after restoring so
// the existing sync handlers reconcile the panel. Deliberately EXCLUDES the
// colormap selects — their change handler calls markStyleDirty(), which would
// flag a bogus "● refresh" on load; the legend is reconciled directly via the
// activeColormap assignment + applyColormapToLegend() call below instead.
const PERSIST_REFIRE = [
  "mode", "want-density", "want-topn", "maximize", "basemap-select",
  "vec-graph-mode",
];
// The compute-source selector is a radiogroup (no single element to dispatch a
// change on), so its restore + UI reconcile is handled inline in
// setupParamPersistence via syncComputeSourceUI(). Persisted under this key.
const COMPUTE_SOURCE_KEY = "compute-source";

function savePersistedParams() {
  const out = {};
  for (const id of PERSIST_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    out[id] = el.type === "checkbox" ? !!el.checked : el.value;
  }
  // The compute-source radiogroup persists as its checked value (not by id).
  out[COMPUTE_SOURCE_KEY] = computeMode();
  try { localStorage.setItem(PERSIST_KEY, JSON.stringify(out)); } catch {}
}

// Restore saved values, reconcile dependent UI, then wire change→save.
// Call LATE in init (after colormap selects are populated and the sub-panel
// sync handlers are wired) so dispatched changes find their listeners.
function setupParamPersistence() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PERSIST_KEY) || "null"); } catch {}
  if (saved && typeof saved === "object") {
    for (const id of PERSIST_IDS) {
      if (!(id in saved)) continue;
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = !!saved[id];
      else {
        el.value = saved[id];
        if (id === "colormap" && COLORMAPS[saved[id]]) activeColormap = saved[id];
      }
    }
    for (const id of PERSIST_REFIRE) {
      document.getElementById(id)?.dispatchEvent(new Event("change"));
    }
    // Restore the compute-source selection. Prefer the new radiogroup key;
    // MIGRATE the old "use-backend" boolean: true → Localhost, false/absent →
    // Browser (Cloud is opt-in, never auto-selected on migration).
    let csVal = saved[COMPUTE_SOURCE_KEY];
    if (csVal == null && ("use-backend" in saved)) csVal = saved["use-backend"] ? "localhost" : "browser";
    if (csVal === "browser" || csVal === "localhost" || csVal === "cloud") {
      const radio = document.getElementById(
        csVal === "localhost" ? "cs-localhost" : csVal === "cloud" ? "cs-cloud" : "cs-browser");
      // Don't restore a disabled (non-local origin) Cloud radio — fall to Browser.
      if (radio && !radio.disabled) radio.checked = true;
    }
    applyColormapToLegend();
    applyLayerControls();
  }
  // Reconcile the compute-source sub-panels to whatever ended up selected
  // (always — even with no saved state, so the local-only gating note shows).
  syncComputeSourceUI();
  for (const id of PERSIST_IDS) {
    document.getElementById(id)?.addEventListener("change", savePersistedParams);
  }
  // The radios live under name="compute-source", not in PERSIST_IDS — wire
  // their change to persist too.
  document.querySelectorAll('input[name="compute-source"]').forEach((el) => {
    el.addEventListener("change", savePersistedParams);
  });
}

// ------- Compute workers -------
// All compute runs in energy-worker.js instances: one worker for regular
// runs, a pool of them for multi-reference density (each ref's Dijkstra is
// independent — see the density pool in the Compute handler). An optional
// native Rust backend (backend/ in the repo, OFF by default) can take over
// density runs; everything else always stays in-browser.
const WORKER_URL = "./energy-worker.js";

// ------- Map setup -------
// "Refresh style" dirty bookkeeping.
//
// Why a snapshot rather than a plain dirty flag: in some browsers the
// blur-fired `change` event on a focused input fires AFTER a click event
// on a different element. With a plain flag, that ordering re-marks the
// state dirty *after* the Refresh handler cleared it, leading to the
// "needs a second click" symptom. With a snapshot, markStyleDirty
// compares current values against what was last rendered — if nothing
// actually differs it stays clean, regardless of event ordering.
function styleSnapshot() {
  return JSON.stringify({
    cm:  activeColormap,
    rcm: document.getElementById("routes-colormap")?.value || "",
    vm:  document.getElementById("vmin")?.value || "",
    vM:  document.getElementById("vmax")?.value || "",
    pvm: document.getElementById("passes-vmin")?.value || "",
    pvM: document.getElementById("passes-vmax")?.value || "",
    g:   document.getElementById("passes-gamma")?.value || "",
    w:   document.getElementById("passes-mean-window")?.value || "",
    b:   document.getElementById("passes-blend")?.value || "",
    pbm: document.getElementById("passes-vmin-b")?.value || "",
    pbM: document.getElementById("passes-vmax-b")?.value || "",
    gb:  document.getElementById("passes-gamma-b")?.value || "",
    wb:  document.getElementById("passes-mean-window-b")?.value || "",
  });
}
function markStyleDirty() {
  // Skip if nothing actually changed since the last render — guards
  // against late blur/change events re-marking after a refresh click.
  if (state.lastStyleSnapshot === styleSnapshot()) return;
  const btn = document.getElementById("refresh-style");
  if (btn) {
    btn.dataset.dirty = "1";
    btn.textContent = `${t("btn.refresh_style")} ●`;
  }
}
function clearStyleDirty() {
  state.lastStyleSnapshot = styleSnapshot();
  const btn = document.getElementById("refresh-style");
  if (btn) {
    btn.dataset.dirty = "";
    btn.textContent = t("btn.refresh_style");
  }
}

// (Engine-tag pill removed — JS is the only compute engine now.)

// Wire the colormap selector and the manual range inputs. Any change
// re-renders the cached energy field — no recompute needed.
document.addEventListener("DOMContentLoaded", () => {
  // Apply translations as soon as the DOM is ready, BEFORE any other UI
  // wiring that might read element text. This populates static labels,
  // option text in select elements, etc.
  applyTranslations();
  // Give every standalone field label an accessible association (for=…).
  associateOrphanLabels();
  // Language toggle pill — flips PT ↔ EN, persists to localStorage.
  const langPill = document.getElementById("lang-tag");
  if (langPill) {
    langPill.addEventListener("click", () => {
      setLang(currentLang === "pt" ? "en" : "pt");
    });
  }
  // Populate the colormap dropdown with all CET maps, grouped by class.
  const sel = document.getElementById("colormap");
  if (sel) {
    sel.innerHTML = "";
    for (const grp of COLORCET_GROUPS) {
      const og = document.createElement("optgroup");
      og.label = grp.label;
      for (const k of grp.keys) {
        if (!COLORMAPS[k]) continue;
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = k === "cmo_phase" ? "cmocean.phase" : k.replace("CET_", "CET-");
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
    sel.value = activeColormap;
    // Live-update the swatch (cheap CSS) but DEFER the canvas re-render to
    // the explicit Refresh-style button — re-rendering on every keystroke
    // gets laggy on large DEMs.
    sel.addEventListener("change", () => {
      activeColormap = sel.value;
      applyColormapToLegend();
      markStyleDirty();
    });
  }
  // Numeric range / gamma / mean-window inputs only mark "dirty"; the
  // canvas redraws on Refresh-style click.
  for (const id of [
    "vmin", "vmax",
    "passes-vmin", "passes-vmax",
    "passes-gamma", "passes-mean-window",
    "passes-vmin-b", "passes-vmax-b",
    "passes-gamma-b", "passes-mean-window-b",
    "passes-blend",
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", markStyleDirty);
    el.addEventListener("change", markStyleDirty);
  }
  // Refresh-style commits whatever's marked dirty. We force-blur any
  // focused input first so the input's blur-fired `change` event (which
  // calls markStyleDirty) runs BEFORE we render+clear, not after — that
  // ordering quirk previously left the dirty bullet on after a single
  // click and made it look like a second click was needed.
  const refreshBtn = document.getElementById("refresh-style");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
      rerenderCachedResult();
      clearStyleDirty();
    });
  }
  const reset = document.getElementById("range-reset");
  if (reset) {
    reset.addEventListener("click", () => {
      for (const id of ["vmin", "vmax", "passes-vmin", "passes-vmax"]) {
        const el = document.getElementById(id);
        if (el) el.value = "";
      }
      rerenderCachedResult();
      clearStyleDirty();
    });
  }
  // Per-layer visibility / opacity controls — pure live updates (no
  // canvas re-render).
  for (const id of [
    "tile-visible",   "tile-opacity",
    "relief-visible", "relief-opacity",
    "energy-visible", "energy-opacity",
    "passes-visible", "passes-opacity",
    "refs-visible",
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", applyLayerControls);
    el.addEventListener("change", applyLayerControls);
  }
  // (Passes blend mode used to fire its own re-render here; that path
  // is now folded into the Refresh-style button along with all the
  // other heavy controls. The dirty-marker loop above already wires
  // passes-blend to markStyleDirty, so changes show up on next refresh.)
  // Routes-colormap selector — populate from CET maps and re-draw routes
  // (without recomputing) on change.
  const routesSel = document.getElementById("routes-colormap");
  if (routesSel) {
    routesSel.innerHTML = "";
    for (const grp of COLORCET_GROUPS) {
      const og = document.createElement("optgroup");
      og.label = grp.label;
      for (const k of grp.keys) {
        if (!COLORMAPS[k]) continue;
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = k === "cmo_phase" ? "cmocean.phase" : k.replace("CET_", "CET-");
        og.appendChild(opt);
      }
      routesSel.appendChild(og);
    }
    routesSel.value = "CET_R2"; // perceptually uniform rainbow — good for ranks
    // Recolour only the route polylines — no full raster re-render of the
    // energy/passes canvases (which the field-colormap inputs defer behind
    // the Refresh-style button anyway).
    routesSel.addEventListener("change", recolorRouteLines);
  }
  // Top-N toggle reveals N + penalty + repulsion inputs
  const topnCheck = document.getElementById("want-topn");
  // Maximise toggle reveals the L-length input. Sync once on load so the
  // panel state matches the checkbox after a bundle reload too.
  const maxCheck = document.getElementById("maximize");
  const maxExtra = document.getElementById("maximize-extra");
  if (maxCheck && maxExtra) {
    const sync = () => { maxExtra.style.display = maxCheck.checked ? "" : "none"; estimateRunTime(); };
    maxCheck.addEventListener("change", sync);
    sync();
  }
  const topnExtra = document.getElementById("topn-extra");
  if (topnCheck && topnExtra) {
    const sync = () => { topnExtra.style.display = topnCheck.checked ? "" : "none"; estimateRunTime(); };
    topnCheck.addEventListener("change", sync);
    sync();
  }
  // Budget-mode select is only meaningful in round-trip mode (a single leg
  // IS the total in from/to) — hide it elsewhere.
  const modeSel = document.getElementById("mode");
  const budgetModeRow = document.getElementById("e-max-mode-row");
  if (modeSel && budgetModeRow) {
    const syncBudgetMode = () => {
      budgetModeRow.style.display = modeSel.value === "round" ? "" : "none";
    };
    modeSel.addEventListener("change", syncBudgetMode);
    syncBudgetMode();
  }
  // Basemap selector — swaps the base tile layer / solid background.
  const basemapSel = document.getElementById("basemap-select");
  if (basemapSel) {
    basemapSel.addEventListener("change", () => applyBasemap(basemapSel.value));
  }
  // Vector-network rendering toggle — pure overlay add/remove, no recompute.
  document.getElementById("vec-render")?.addEventListener("change", applyNetworkLinesOverlay);
  // Width/opacity restyle the existing polylines in place (live).
  for (const id of ["vec-render-width", "vec-render-opacity"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", updateNetworkLineStyle);
    el.addEventListener("change", updateNetworkLineStyle);
  }
  // Compute-source selector (Browser / Localhost / Cloud — a top-level compute
  // option). Each radio's change reconciles the sub-panels (Localhost URL /
  // Cloud orchestrator) and gates Cloud to local origins. Browser is the
  // default and the always-available fallback. syncComputeSourceUI also runs in
  // setupParamPersistence after the persisted selection is restored.
  document.querySelectorAll('input[name="compute-source"]').forEach((el) => {
    el.addEventListener("change", syncComputeSourceUI);
  });
  syncComputeSourceUI();
  // Persist the advanced max-workers override per device (like the lang /
  // layer-order prefs) — power users on big-RAM machines set it once.
  const maxWorkersEl = document.getElementById("max-workers");
  if (maxWorkersEl) {
    try { const v = localStorage.getItem("simu-max-workers"); if (v != null) maxWorkersEl.value = v; } catch {}
    maxWorkersEl.addEventListener("change", () => {
      try { localStorage.setItem("simu-max-workers", maxWorkersEl.value); } catch {}
    });
  }
  // Density toggle reveals the multi-ref controls and locks out the
  // single-source toggles (wantPasses / wantTopN) that don't compose
  // with multi-reference density.
  const densCheck = document.getElementById("want-density");
  const densExtra = document.getElementById("density-extra");
  if (densCheck && densExtra) {
    const sync = () => {
      const on = densCheck.checked;
      densExtra.style.display = on ? "" : "none";

      const passesCheck = document.getElementById("want-passes");
      const passesLabel = passesCheck?.closest("label");
      if (passesCheck) {
        if (on) { passesCheck.checked = false; passesCheck.disabled = true; }
        else passesCheck.disabled = false;
      }
      if (passesLabel) passesLabel.style.opacity = on ? "0.5" : "1";

      const topnCheck = document.getElementById("want-topn");
      const topnLabel = topnCheck?.closest("label");
      const topnExtra = document.getElementById("topn-extra");
      if (topnCheck) {
        if (on) { topnCheck.checked = false; topnCheck.disabled = true; }
        else topnCheck.disabled = false;
      }
      if (topnLabel) topnLabel.style.opacity = on ? "0.5" : "1";
      if (on && topnExtra) topnExtra.style.display = "none";

      // Drop any source/destination state when entering density mode —
      // it's not used and the leftover markers / UI labels are confusing.
      // Fade ONLY the src/dst picker (references replace it); the reference-
      // action buttons clustered below it must stay live in density mode.
      const srcdst = document.getElementById("pick-points-srcdst");
      if (srcdst) {
        srcdst.style.opacity = on ? "0.45" : "1";
        srcdst.style.pointerEvents = on ? "none" : "";
      }
      // The "Place random" / "Clear refs" cluster only applies in density mode.
      const refActions = document.getElementById("ref-actions-row");
      if (refActions) refActions.style.display = on ? "" : "none";
      if (on) {
        state.src = null;
        state.dst = null;
        if (state.srcMarker) { state.srcMarker.remove(); state.srcMarker = null; }
        if (state.dstMarker) { state.dstMarker.remove(); state.dstMarker = null; }
        if (state.pathLine)  { state.pathLine.remove();  state.pathLine = null; }
        const srcDisp = document.getElementById("src-display");
        const dstDisp = document.getElementById("dst-display");
        if (srcDisp) { srcDisp.textContent = "— density —"; srcDisp.classList.remove("set"); }
        if (dstDisp) { dstDisp.textContent = "— density —"; dstDisp.classList.remove("set"); }
      } else {
        const srcDisp = document.getElementById("src-display");
        const dstDisp = document.getElementById("dst-display");
        if (srcDisp && !state.src) srcDisp.textContent = "— click map —";
        if (dstDisp && !state.dst) dstDisp.textContent = "— optional —";
      }

      // Energy layer stays available in density mode — when refs > 0 the
      // worker returns the per-cell mean energy across all refs, so the
      // user can read the average as well as the density.
      applyLayerControls();
      // Re-render any cached result (so a leftover energy overlay clears).
      rerenderCachedResult();

      // Compute button gate flips between src-required and refs-required.
      updateRunButtonState();
      estimateRunTime();
    };
    densCheck.addEventListener("change", sync);
    sync();
  }
  document.getElementById("ref-place-random")?.addEventListener("click", () => {
    const n = parseInt(document.getElementById("n-refs")?.value, 10) || 10;
    placeRandomRefPoints(n);
  });
  document.getElementById("ref-clear")?.addEventListener("click", clearRefPoints);
  document.getElementById("ref-file")?.addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (f) await loadRefPointsFromFile(f);
    ev.target.value = "";   // let the same file be re-loaded
  });
  // Anything that affects the time estimate
  // Inputs that move the (now budget- and engine-aware) time estimate.
  // `alpha` scales the explored region (flat reach ∝ eMax/alpha); the
  // compute-source selector switches the engine model (handled below with the
  // radios, since they share a name rather than a single id).
  for (const id of ["mode", "want-passes", "want-topn", "n-routes", "want-density",
                    "n-refs", "e-max", "alpha", "max-workers",
                    // Network/graph + interpolation controls — they move the
                    // estimate now that interp is a separate phase and graph
                    // mode has its own (much cheaper) compute model.
                    "net-interp", "net-interp-max-dist", "net-interp-smoothing",
                    "vec-graph-mode", "vec-constrain", "vec-compare"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", estimateRunTime);
  }
  // Graph mode supersedes the raster constrain/compare toggles in the run
  // dispatch — grey them out when it's on so the precedence is visible. Fires
  // on toggle AND on load (vec-graph-mode is in PERSIST_REFIRE → synthetic
  // change after restore). See syncGraphModeUI.
  document.getElementById("vec-graph-mode")?.addEventListener("change", syncGraphModeUI);
  syncGraphModeUI();
  // Compute-source / URL changes refresh the cached /health core count (used by
  // the estimate's backend-parallelism model) AND re-estimate (engine model +
  // transfer line). The radios share name="compute-source"; the two URL fields
  // (backend / orchestrator) feed the same /health probe via effectiveBackendUrl.
  const onComputeSourceChange = () => { refreshBackendCores(); estimateRunTime(); };
  document.querySelectorAll('input[name="compute-source"]').forEach((el) => {
    el.addEventListener("change", onComputeSourceChange);
  });
  for (const id of ["backend-url", "orchestrator-url"]) {
    const el = document.getElementById(id);
    if (el) { el.addEventListener("change", onComputeSourceChange); el.addEventListener("input", estimateRunTime); }
  }
  // Example DEM loader links — populated declaratively in HTML, wired here.
  for (const ex of DEM_EXAMPLES) {
    const a = document.getElementById(ex.id);
    if (!a) continue;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      loadDemFromUrl(ex.url, ex.label);
    });
  }
  // FABDEM-for-current-viewport. Sized at click time from map.getBounds()
  // so the user can zoom around before clicking; capped at 50 MB inside
  // loadFabdemForView().
  const fabBtn = document.getElementById("ex-fabdem-view");
  if (fabBtn) {
    fabBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      loadFabdemForView();
    });
  }
  // Locate-me floating button. Lives on the map (not in the drawer),
  // so it's reachable on mobile without opening the controls panel.
  document.getElementById("locate-btn")?.addEventListener("click", centerOnUserLocation);
  // Vector-network upload + clear.
  const vecFile = document.getElementById("vector-file");
  if (vecFile) {
    vecFile.addEventListener("change", async (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      try {
        await loadVectorNetwork(f);
      } catch (err) {
        console.error(err);
        progress.classList.remove("active");
        status.innerHTML = `<span style="color:#ff6b6b">${t("status.gpkg_failed", escapeHtml(err.message))}</span>`;
      }
      // Reset the input so re-picking the same file fires `change` again.
      ev.target.value = "";
    });
  }
  const vecClearBtn = document.getElementById("vec-clear");
  if (vecClearBtn) vecClearBtn.addEventListener("click", clearVectorNetwork);
  document.getElementById("vec-osm")?.addEventListener("click", loadOsmNetwork);

  // --- Impassable mask (group 1c) ---
  const impFile = document.getElementById("impassable-file");
  if (impFile) {
    impFile.addEventListener("change", async (ev) => {
      const f = ev.target.files[0];
      if (f) await loadImpassableMaskFromFile(f);
      ev.target.value = ""; // re-picking the same file fires change again
    });
  }
  document.getElementById("impassable-clear")?.addEventListener("click", clearImpassableMask);
  document.getElementById("impassable-osm")?.addEventListener("click", loadOsmWater);
  document.getElementById("imp-rivers")?.addEventListener("change", rebuildOsmWaterMask);
  document.getElementById("imp-enabled")?.addEventListener("change", () => markImpassableDirty(true));
  // 1B "Aplicar ao cálculo" toggle updates its green/orange status.
  document.getElementById("vec-constrain")?.addEventListener("change", syncLoadedHighlights);
  document.getElementById("impassable-invert")?.addEventListener("change", () => {
    // Re-resample the cached source with the flipped convention (no re-upload).
    if (state.impassableRaster) applyImpassableRaster(state.impassableRaster, state.impassableMeta?.name);
  });
  document.getElementById("imp-corridor")?.addEventListener("change", (ev) => {
    const row = document.getElementById("imp-offset-row");
    if (row) row.style.display = ev.target.checked ? "" : "none";
    recomputeCorridors();   // corridors appear/disappear → geometry change
    updateImpassableMeta();
    markImpassableDirty(true);
  });
  document.getElementById("imp-offset")?.addEventListener("change", () => {
    // Offset shifts corridor heights only (geometry unchanged) → no reprobe;
    // buildComputeGrid re-applies the offset to the cached corridor base/ramp.
    markImpassableDirty(false);
  });
  document.getElementById("imp-show")?.addEventListener("change", (ev) => {
    const row = document.getElementById("imp-opacity-row");
    if (row) row.style.display = ev.target.checked ? "" : "none";
    applyImpassableOverlay();
  });
  document.getElementById("imp-opacity")?.addEventListener("input", () => {
    if (state.impassableOverlay) state.impassableOverlay.setOpacity(impassableOverlayOpacity());
  });

  // --- Bridges & tunnels (group 1d) ---
  document.getElementById("bridge-osm")?.addEventListener("click", loadOsmBridges);
  document.getElementById("bridge-from-network")?.addEventListener("click", () => {
    const c = state.networkBridgeCandidates;
    if (!c || !c.length) { status.innerHTML = `<span style="color:#ff6b6b">${t("bridge.no_candidates")}</span>`; return; }
    const withTunnels = !!document.getElementById("bridge-tunnels")?.checked;
    const ways = withTunnels ? c : c.filter((w) => w.kind !== "tunnel");
    installBridgesFromWays(ways, "network");
  });
  document.getElementById("bridge-clear")?.addEventListener("click", clearBridges);
  document.getElementById("bridge-enabled")?.addEventListener("change", () => markBridgesDirty(true));
  document.getElementById("bridge-show")?.addEventListener("change", (ev) => {
    const row = document.getElementById("bridge-opacity-row");
    if (row) row.style.display = ev.target.checked ? "" : "none";
    applyBridgeOverlay();
  });
  document.getElementById("bridge-opacity")?.addEventListener("input", () => {
    // In-place opacity — don't rebuild every polyline on each slider tick.
    if (state.bridgesLayer) state.bridgesLayer.eachLayer((l) => l.setStyle({ opacity: bridgeOverlayOpacity() }));
  });
  // Switching the displayed energy field (constrained / unconstrained /
  // difference) re-renders cached arrays — never recomputes.
  document.getElementById("energy-source")?.addEventListener("change", () => {
    rerenderCachedResult();
    clearStyleDirty();
  });

  // Bundle download / reload
  const dlBtn = document.getElementById("download-bundle");
  if (dlBtn) dlBtn.addEventListener("click", downloadBundle);
  const exportImgBtn = document.getElementById("export-rendered");
  if (exportImgBtn) exportImgBtn.addEventListener("click", exportRenderedImages);
  const reloadInput = document.getElementById("bundle-file");
  if (reloadInput) {
    reloadInput.addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (f) loadBundleFile(f);
      // Reset the input so the same filename re-triggers `change` if picked again.
      ev.target.value = "";
    });
  }
  applyColormapToLegend();
  // Apply initial layer controls so the rmsampa-v2 tile layer (default ON)
  // gets added to the map without waiting for a Compute.
  applyLayerControls();

  // Help modal: open via the "?" button, close via × / backdrop click /
  // Escape key. Body scroll-lock isn't needed since the panel doesn't
  // scroll behind the modal.
  const helpBtn = document.getElementById("help-btn");
  const helpModal = document.getElementById("help-modal");
  const helpClose = document.getElementById("help-close");
  const openHelp  = () => helpModal?.classList.add("active");
  const closeHelp = () => helpModal?.classList.remove("active");
  helpBtn?.addEventListener("click", openHelp);
  helpClose?.addEventListener("click", closeHelp);
  helpModal?.addEventListener("click", (e) => {
    // Click on the backdrop (not on the modal body itself) closes.
    if (e.target === helpModal) closeHelp();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && helpModal?.classList.contains("active")) closeHelp();
  });

  // Layer-stacking-order modal: list rendered top-of-screen-first, rows
  // moved with ↑/↓, applied immediately to the pane z-indices and
  // persisted. Rebuilt on every open so labels follow the language toggle.
  const orderModal = document.getElementById("layer-order-modal");
  const orderList = document.getElementById("layer-order-list");
  // Per-layer visibility/opacity input ids the modal rows PROXY (the real
  // inputs live in a hidden store, or in groups 1B/1C for network/impassable).
  // `opApply: true` flags a slider with no native listener (network opacity),
  // so we call applyNetworkLinesOverlay() explicitly.
  const LAYER_VIS = {
    relief:     { vis: "relief-visible",  op: "relief-opacity"  },
    impassable: { vis: "imp-show",        op: "imp-opacity"     },
    energy:     { vis: "energy-visible",  op: "energy-opacity"  },
    network:    { vis: "vec-render",      op: "vec-render-opacity", opApply: true },
    passes:     { vis: "passes-visible",  op: "passes-opacity"  },
    routes:     { vis: null,              op: null              },
  };
  // Fixed (non-reorderable) layers shown after the stacking list.
  const FIXED_ROWS = [
    { labelKey: "layer.tiles",      vis: "tile-visible", op: "tile-opacity" },
    { labelKey: "ref.show_markers", vis: "refs-visible", op: null },
  ];
  const fireInput = (el) => {
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const buildLayerRow = ({ labelKey, reorder, vis, op, opApply }) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:4px 6px;" +
      "border:1px solid var(--border);border-radius:4px;margin-top:4px;";
    // Ordering arrows on the LEFT (or a same-width spacer for fixed rows).
    const arrows = document.createElement("div");
    arrows.style.cssText = "display:flex;gap:2px;flex:none;width:50px;";
    if (reorder) {
      const mkBtn = (label, disabled, delta) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "secondary"; b.textContent = label;
        b.disabled = disabled; b.style.cssText = "width:23px;padding:2px 0;margin:0;";
        b.addEventListener("click", () => {
          // Visually "up" = drawn on top = later in the bottom→top layerOrder.
          const i = layerOrder.indexOf(reorder.key);
          const j = i + delta;
          if (j < 0 || j >= layerOrder.length) return;
          [layerOrder[i], layerOrder[j]] = [layerOrder[j], layerOrder[i]];
          applyLayerOrder();
          renderOrderList();
        });
        return b;
      };
      arrows.appendChild(mkBtn("↑", reorder.di === 0, +1));
      arrows.appendChild(mkBtn("↓", reorder.di === reorder.last, -1));
    }
    row.appendChild(arrows);
    // Visibility checkbox (proxies the real input).
    const realVis = vis ? document.getElementById(vis) : null;
    if (realVis) {
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.style.flex = "none";
      cb.checked = realVis.checked;
      cb.addEventListener("change", () => { realVis.checked = cb.checked; fireInput(realVis); });
      row.appendChild(cb);
    } else {
      const sp = document.createElement("span"); sp.style.cssText = "width:13px;flex:none;";
      row.appendChild(sp);
    }
    // Name.
    const name = document.createElement("span");
    name.style.cssText = "flex:1;font-size:12px;"; name.textContent = t(labelKey);
    row.appendChild(name);
    // Opacity slider (proxies the real input).
    const realOp = op ? document.getElementById(op) : null;
    if (realOp) {
      const r = document.createElement("input");
      r.type = "range"; r.min = "0"; r.max = "1"; r.step = "0.05"; r.value = realOp.value;
      r.style.cssText = "flex:none;width:64px;";
      r.addEventListener("input", () => {
        realOp.value = r.value; fireInput(realOp);
        if (opApply) applyNetworkLinesOverlay();
      });
      row.appendChild(r);
    }
    return row;
  };
  const renderOrderList = () => {
    if (!orderList) return;
    orderList.innerHTML = "";
    const topToBottom = layerOrder.slice().reverse();
    topToBottom.forEach((key, di) => {
      const v = LAYER_VIS[key] || {};
      orderList.appendChild(buildLayerRow({
        labelKey: `order.${key}`,
        reorder: { key, di, last: topToBottom.length - 1 },
        vis: v.vis, op: v.op, opApply: v.opApply,
      }));
    });
    FIXED_ROWS.forEach((f) => orderList.appendChild(buildLayerRow({
      labelKey: f.labelKey, reorder: null, vis: f.vis, op: f.op,
    })));
  };
  const layerCtrlBtns = ["layer-ctrl-open", "layer-ctrl-btn"]
    .map((id) => document.getElementById(id)).filter(Boolean);
  const markLayerBtns = (on) => layerCtrlBtns.forEach((b) => b.classList.toggle("active", on));
  const openOrder = () => { renderOrderList(); orderModal?.classList.add("active"); markLayerBtns(true); };
  const closeOrder = () => { orderModal?.classList.remove("active"); markLayerBtns(false); };
  // Non-blocking corner panel: the buttons TOGGLE it (re-click to dismiss).
  const toggleOrder = () => orderModal?.classList.contains("active") ? closeOrder() : openOrder();
  layerCtrlBtns.forEach((b) => b.addEventListener("click", toggleOrder));
  document.getElementById("layer-order-close")?.addEventListener("click", closeOrder);
  orderModal?.addEventListener("click", (e) => {
    if (e.target === orderModal) closeOrder();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && orderModal?.classList.contains("active")) closeOrder();
  });
  document.getElementById("layer-order-reset")?.addEventListener("click", () => {
    layerOrder = DEFAULT_LAYER_ORDER.slice();
    applyLayerOrder();
    renderOrderList();
  });

  // Restore saved parameter/viz choices and start persisting future edits.
  // Last so the colormap selects are populated and every sub-panel sync
  // handler is already wired (restore dispatches synthetic change events).
  setupParamPersistence();
});

const map = L.map("map", { preferCanvas: true }).setView([-23.55, -46.63], 12);

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
  routes:     "routesPane",
};
const DEFAULT_LAYER_ORDER = ["relief", "impassable", "energy", "network", "passes", "routes"]; // bottom → top
let layerOrder = DEFAULT_LAYER_ORDER.slice();
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

function applyLayerOrder() {
  layerOrder.forEach((key, i) => {
    const pane = map.getPane(LAYER_PANES[key]);
    if (pane) pane.style.zIndex = String(401 + i);
  });
  try { localStorage.setItem("simu-layer-order", JSON.stringify(layerOrder)); } catch {}
}
applyLayerOrder();

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
function applyBasemap(key) {
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

// ------- State -------
const state = {
  dem: null, // { height, mask, H, W, dx, dy, bbox, originX, originY }
  src: null, // [r, c]
  dst: null, // [r, c]
  // All live compute workers (1 for regular runs, N for the density pool).
  // computeGen is bumped on every run start AND every cancellation — a
  // worker message whose captured generation doesn't match is stale (the
  // user loaded a new DEM / network mid-compute) and must be dropped, not
  // rendered against the new grid.
  workers: [],
  computeGen: 0,
  // Compute-time calibration, learned by a one-shot probe at DEM load (see
  // startCalibrationProbe). null until the probe lands. calibrationGen is
  // bumped on every DEM load so a stale in-flight probe's result is dropped.
  // backendCores: cached {url, cores} from a /health ping, for the estimate.
  calibration: null,
  calibrationGen: 0,
  probeWorker: null,
  backendCores: null,
  // Snapshot of the last compute's config (engine, refs, budget, mode), taken
  // at run start so the post-compute online correction can compare the
  // estimate it would have made against the real elapsed time.
  lastRun: null,
  // Cloud compute-source state machine (see computeMode()/ensureCloudVm()):
  //   mode           — last computeMode() resolved at run start ("cloud" arms it)
  //   orchestratorUrl — base URL of the local orchestrator (loopback)
  //   vmState        — last STATE seen from /cloud/status (STOPPED/PROVISIONING/
  //                    RUNNING/STOPPING/ERROR)
  //   keepaliveTimer — interval extending the VM lease while a compute runs
  //   pollTimer      — interval polling /cloud/status while booting (unused as a
  //                    stored handle; the boot loop awaits inline, kept for clarity)
  cloud: { mode: "browser", orchestratorUrl: "", vmState: "STOPPED", keepaliveTimer: null, pollTimer: null },
  // Stacked overlays — z-order from bottom up:
  //   OSM basemap → tileOverlay (rmsampa-v2) → energyOverlay → passesOverlay
  tileOverlay: null,
  energyOverlay: null,
  passesOverlay: null,
  pathLine: null,
  routeLines: [],
  srcMarker: null,
  dstMarker: null,
  // Optional XYZ tile overlay (rmsampa-v2). Initialised below.
  tileOverlayActive: false,
  // Outline rectangle drawn to show the loaded DEM's extent.
  demRect: null,
  // Optional rasterised vector network. When non-null, AND'd with the
  // DEM mask before every compute so analysis is constrained to network
  // cells. networkSrsId stamps the source CRS so we can warn on DEM swap.
  networkMask: null,
  networkSrsId: null,
  networkFeatureCount: 0,
  // Parsed network geometry in WGS84 ([[lat,lng], …] per line), kept so the
  // optional "draw network" toggle can render true vector lines at a fixed
  // ground width. null when over the vertex cap (drawing disabled).
  networkLines: null,
  // Per-network-way { deck, layer } tags (parallel to networkLines), captured
  // from the OSM streets pull, for graph-mode bridge/tunnel handling (Phase C:
  // layer-aware junctions + deck flattening). null for .gpkg networks (no tags).
  networkLinesMeta: null,
  // Bridge/tunnel ways extracted from the loaded network (gpkg tags or OSM
  // tags) as [{ latlngs, kind, layer, name }] — fed to the 1d "extract bridges
  // from the loaded network" button (installBridgesFromWays). null if none.
  networkBridgeCandidates: null,
  networkLinesLayer: null,
  // "Follow the vectors" graph mode: the routable graph built from
  // networkLines (cached, keyed by networkGraphToken so a network/junction-mode/
  // DEM change rebuilds it), the last per-edge result, and its map layer.
  networkGraph: null,
  networkGraphToken: null,
  lastGraphResult: null,
  // Graph mode renders as TWO pane-integrated vector layers (energy on
  // energyPane, passes on passesPane) so the existing Energy/Passes visibility
  // + opacity controls drive them, plus a routes/path layer on routesPane.
  graphEnergyLayer: null,
  graphPassesLayer: null,
  graphRoutesLayer: null,
  // Graph energy is shown as an interpolated RASTER (like grid), not vector
  // edges — rasterised from the graph then IDW-filled. Cached for restyle.
  graphEnergyRaster: null,
  // Optional impassable mask (water, etc.). `impassable` is resampled to the
  // DEM grid (1 = impassable); `impassableRaster` keeps the parsed source so
  // the Invert toggle re-resamples without a re-upload. The vector network can
  // carve bridge corridors across it: corridorCells/Base/Ramp cache the
  // reopened cells and their smooth bridge-elevation profile (see
  // recomputeCorridors / buildComputeGrid). impassableToken is bumped on any
  // mask/corridor/offset/invert change so the cached network graph rebuilds.
  impassable: null,
  impassableRaster: null,
  impassableMeta: null,
  corridorCells: null,
  corridorBase: null,
  corridorRamp: null,
  corridorSet: null, // Set of corridor cell indices, for O(1) click-validity lookup
  osmWaterGeom: null, // cached parsed OSM water geometry (grid coords) for re-rasterising on the #imp-rivers toggle
  impassableToken: 0,
  impassableOverlay: null,
  // Optional OSM bridges & tunnels modelled as level "decks". Each is a span
  // between two ground abutment cells (endA/endB). In the raster compute they
  // become PORTAL EDGES — a shortcut between the end cells at the flat-deck cost
  // — so the route OVER the bridge and the ground route UNDER it both stay
  // correct (the grid keeps ground elevation everywhere; nothing is overwritten).
  // bridgesToken is bumped on any bridge change so the cached graph + estimate
  // rebuild. See loadOsmBridges / buildPortals / buildComputeGrid.
  bridges: null,       // [{ latlngs, endA, endB, deckLenM, kind, layer, name }]
  bridgesMeta: null,   // { source, count, skipped }
  bridgesToken: 0,
  bridgesLayer: null,  // Leaflet polyline group overlay
  // Multi-reference density: list of [r, c] pixel coords plus their map markers.
  refPoints: [],
  refMarkers: [],
  // Position in the quasi-random (Sobol/Halton) sequence used by "Place
  // random". Persists across clicks so each batch continues the sequence;
  // reset whenever the refs are cleared or the DEM changes.
  qmcIndex: 0,
  // Guards the async "census" sampler so a double-click can't fire two
  // overlapping cloud queries that both clear + re-add reference points.
  censusInFlight: false,
  // Live-ETA bookkeeping (set on Compute, cleared on done/error).
  computeStartedAt: 0,
  estimatedTotalMs: 0,
  // Bundle loaded before (or against the wrong) DEM: held here — including
  // its binary rasters — and re-applied by loadDemFromArrayBuffer once a
  // DEM with matching dimensions arrives. Without this, loading the DEM
  // second wiped everything the bundle had just restored (src/dst, refs)
  // and the rasters were lost, making bundle-then-DEM order useless.
  pendingBundle: null,
};

// Escape user-derived text (file parse errors, worker messages, …) before
// it's interpolated into status.innerHTML — bundles and DEMs are shareable
// artifacts, so error strings echoing their content are attacker-reachable.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

// ---- Compute-source indirection (Browser / Localhost / Cloud) -----------
// The single source of truth for which engine a run uses. `computeMode()`
// reads the selector radios; `effectiveBackendUrl()` maps Localhost→backend
// URL and Cloud→orchestrator URL (both trimmed, trailing slashes stripped).
// Everything downstream (startDensityBackend / startSingleBackend / the binary
// frame builders / the /health probe) is engine-agnostic — it just receives
// the right base URL. The orchestrator mirrors the Rust backend's /density,
// /single, /health byte-for-byte, so Cloud is an opaque pass-through.
function computeMode() {
  return document.querySelector('input[name="compute-source"]:checked')?.value || "browser";
}
function effectiveBackendUrl() {
  const cloud = computeMode() === "cloud";
  // Localhost keeps the historical default (an empty field → the standard
  // backend port). Cloud has no safe default — an empty orchestrator URL blocks
  // the run with cloud.need_orch_url rather than guessing.
  const id = cloud ? "orchestrator-url" : "backend-url";
  const raw = (document.getElementById(id)?.value || "").trim();
  const val = (!cloud && !raw) ? "http://127.0.0.1:8077" : raw;
  return val.replace(/\/+$/, "");
}
// Cloud is only meaningful when the orchestrator (loopback-only) is reachable —
// i.e. the applet itself is served locally. Same-origin fetches to 127.0.0.1
// from a public-origin page would be blocked anyway.
function isLocalOrigin() {
  if (location.protocol === "file:") return true;
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

// Terminate every in-flight compute worker and invalidate their pending
// messages via the generation bump. Safe to call when idle. Must run before
// anything that changes the grid a result would be rendered against (DEM
// load, network load/clear) — see state.computeGen above.
function cancelActiveCompute() {
  state.computeGen++;
  for (const w of state.workers) w.terminate();
  state.workers = [];
  // A superseded cloud run must stop extending the VM lease; the orchestrator's
  // own lease deadline (or the next run's stop) reaps the VM.
  stopCloudKeepalive();
  if (state.computeStartedAt) {
    state.computeStartedAt = 0;
    progress.classList.remove("active");
    updateRunButtonState();
  }
}

// Last-resort safety net for the async compute dispatch. A SYNCHRONOUS throw
// inside the dispatch bodies (e.g. an OOM allocating buildComputeGrid()/the
// DEM payload on a 135 M-cell grid) escapes as an unhandled rejection that
// would otherwise leave the progress bar spinning, the Run button disabled,
// and "Computing…" stuck — forcing a manual reload. Only act when a compute
// is actually in flight, so unrelated errors don't clobber the UI.
function handleWedgedCompute(detail) {
  if (!state.computeStartedAt) return;
  console.error("[compute] unhandled failure while running:", detail);
  cancelActiveCompute();
  // Run encalhado na nuvem: libera a VM (cancelActiveCompute só corta o
  // keepalive, não desliga a instância).
  if (state.cloud.mode === "cloud" && state.cloud.orchestratorUrl) {
    stopCloudVm(state.cloud.orchestratorUrl);
  }
  const msg = (detail && detail.message) || String(detail || "unknown error");
  status.innerHTML =
    `<span style="color:#ff6b6b">${t("status.compute_failed", escapeHtml(msg))}</span>`;
}
window.addEventListener("unhandledrejection", (e) => handleWedgedCompute(e.reason));
window.addEventListener("error", (e) => handleWedgedCompute(e.error || e.message));

// Cloud: if the tab is hidden or unloaded while a cloud VM is up AND IDLE, stop
// it now (default-ON "stop after each run", extended to the leave-the-page case)
// via a fire-and-forget sendBeacon — a normal fetch wouldn't survive the unload.
// NEVER stop a VM that's mid-compute: visibilitychange→hidden fires on an
// ordinary tab switch / minimize / screen lock, and stopping then would abort
// the in-flight remote run (the stream-proxy fetch drops → it falls back to the
// far slower / OOM-prone browser pool, losing the whole run). keepaliveTimer is
// the precise "a run is in flight" signal. If the tab truly dies mid-run, the
// orchestrator lease + hard-cap + in-VM idle-watchdog are the backstops.
function beaconStopCloudVm() {
  if (state.cloud.keepaliveTimer) return; // a compute is running — leave the VM alone
  if (state.cloud.mode === "cloud" && state.cloud.orchestratorUrl) {
    stopCloudVm(state.cloud.orchestratorUrl, { beacon: true });
  }
}
document.addEventListener("visibilitychange", () => {
  // Em modo "manter VM ligada", trocar/esconder a aba NÃO desliga a VM (o lease
  // do orquestrador + o idle-watchdog cuidam do ócio); só um unload real
  // (pagehide) desliga. Sem keep-warm, esconder a aba desliga a VM ociosa
  // (economia padrão).
  if (document.visibilityState === "hidden"
      && !document.getElementById("cloud-keep-warm")?.checked) {
    beaconStopCloudVm();
  }
});
window.addEventListener("pagehide", beaconStopCloudVm);

// ------- DEM loading -------
const demFile = document.getElementById("dem-file");
const demMeta = document.getElementById("dem-meta");
const status = document.getElementById("status");
const runBtn = document.getElementById("run");
const progress = document.getElementById("progress");
const progressBar = progress.querySelector(".bar");
const resultMeta = document.getElementById("result-meta");

// Construct the rmsampa-v2 XYZ tile layer once. Add/remove on visibility
// toggle so we don't pay tile fetches when it's hidden.
const RMSAMPA_URL = "https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png";
state.tileOverlay = L.tileLayer(RMSAMPA_URL, {
  maxZoom: 19,
  opacity: 0.85,
  // Keep the hydrography overlay ABOVE the basemap within the tile pane,
  // regardless of add order (the basemap is re-added on the persistence
  // refire AFTER this layer, which would otherwise bury it until toggled).
  zIndex: 10,
  attribution: 'pedalhidrografi.co',
});

demFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  status.textContent = t("status.loading_dem");
  try {
    const buf = await file.arrayBuffer();
    state.demSourceUrl = null;
    await loadDemFromArrayBuffer(buf, file.name);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.error_generic", escapeHtml(err.message))}</span>`;
  }
});

// Three example DEMs hosted alongside the rmsampa-v2 tiles. Wired below.
const DEM_EXAMPLES = [
  { id: "ex-aguapreta", label: "Entorno da Água Preta", size: "instantâneo",
    url: "https://telhas.pedalhidrografi.co/simujoules/dem/sampa_aguapreta.tif" },
  { id: "ex-centro",    label: "Sampa Centro Expandido", size: "rápido",
    url: "https://telhas.pedalhidrografi.co/simujoules/dem/sampa_centro.tif" },
  { id: "ex-geral",     label: "Sampa Sítio Urbano",    size: "lento",
    url: "https://telhas.pedalhidrografi.co/simujoules/dem/sampa_geral.tif" },
];

async function loadDemFromUrl(url, label) {
  status.textContent = t("status.fetching", label);
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const buf = await resp.arrayBuffer();
    state.demSourceUrl = url;
    await loadDemFromArrayBuffer(buf, label);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.error_generic", escapeHtml(err.message))}</span>`;
  }
}

// ------- FABDEM viewport loader -------
// Pulls FABDEM 1°×1° tiles that intersect the current map viewport,
// crops each to the visible extent, and stitches them into a single
// in-memory GeoTIFF that we hand to loadDemFromArrayBuffer. Tiles are
// COGs hosted at https://telhas.pedalhidrografi.co/fabdem/ and named
// in the original Bristol convention `{LAT}{NS}{LON}{EW}_FABDEM_V1-2.tif`
// keyed by the SW corner. geotiff.js's fromUrl uses HTTP Range requests
// so we never download more than the visible cells (the 50 MB cap is
// enforced as decompressed pixel-bytes, since that's what we allocate).

const FABDEM_BASE_URL = "https://telhas.pedalhidrografi.co/fabdem/";
const FABDEM_TILE_DEG = 1;          // 1° per tile, keyed by SW corner
const FABDEM_ARCSEC = 1 / 3600;     // ~30 m at the equator
const FABDEM_MAX_BYTES = 50 * 1024 * 1024;

function fabdemTileName(lat, lon) {
  // Naming convention used by this deploy: hemisphere prefix BEFORE digits,
  // e.g. S24W047_FABDEM_V1-2.tif for the tile keyed by SW corner -24, -47.
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${ns}${String(Math.abs(lat)).padStart(2, "0")}${ew}${String(Math.abs(lon)).padStart(3, "0")}_FABDEM_V1-2.tif`;
}

// Browser geolocation → pan the map to the user's coordinates without
// touching the zoom. The user typically frames their area before
// clicking, so we respect whatever zoom they're already at.
function centerOnUserLocation() {
  // Trace point for the "nothing happens when I click" reports — a single
  // log here isolates click-routing problems from geolocation failures.
  console.info("[locate] click handler invoked");
  if (!navigator.geolocation) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("locate.unsupported")}</span>`;
    return;
  }
  status.textContent = t("locate.requesting");
  const btn = document.getElementById("locate-btn");
  if (btn) btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (btn) btn.disabled = false;
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      // panTo keeps the current zoom; setView would force a zoom change.
      map.panTo([lat, lng]);
      status.textContent = t("locate.centered", lat.toFixed(4), lng.toFixed(4));
    },
    (err) => {
      if (btn) btn.disabled = false;
      // err.code: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
      let key = "locate.error";
      if (err.code === 1) key = "locate.denied";
      else if (err.code === 2) key = "locate.unavailable";
      else if (err.code === 3) key = "locate.timeout";
      status.innerHTML = `<span style="color:#ff6b6b">${t(key)}</span>`;
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
  );
}

async function loadFabdemForView() {
  if (!map) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.map_not_ready")}</span>`;
    return;
  }
  const bounds = map.getBounds();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west  = bounds.getWest();
  const east  = bounds.getEast();
  if (!Number.isFinite(south) || north <= south || east <= west) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.map_bounds_failed")}</span>`;
    return;
  }

  // Snap the output extent to FABDEM's 1-arcsec grid so the synthetic
  // GeoTIFF we hand off has integer-cell origin and dimensions.
  const outWest  = Math.floor(west  * 3600) / 3600;
  const outEast  = Math.ceil (east  * 3600) / 3600;
  const outSouth = Math.floor(south * 3600) / 3600;
  const outNorth = Math.ceil (north * 3600) / 3600;
  const outW = Math.round((outEast  - outWest)  * 3600);
  const outH = Math.round((outNorth - outSouth) * 3600);

  // Cap by allocated pixel-bytes (Float32). 50 MB / 4 = 12.5 M cells, which
  // is roughly a 0.98° × 0.98° square at 1 arcsec — about 110 km on a side
  // at the equator. Beyond that we ask the user to zoom in.
  const estBytes = outW * outH * 4;
  if (estBytes > FABDEM_MAX_BYTES) {
    status.innerHTML =
      `<span style="color:#ff6b6b">${t("status.fabdem_too_large", (estBytes / 1024 / 1024).toFixed(0), outW, outH, FABDEM_MAX_BYTES / 1024 / 1024)}</span>`;
    return;
  }

  // Enumerate 1° tiles whose SW corner lat ∈ [floor(south)..ceil(north)-1]
  // and lon ∈ [floor(west)..ceil(east)-1]. The tiny epsilon on the upper
  // bounds avoids fetching an extra tile when the viewport edge sits
  // exactly on an integer degree.
  const eps = 1e-9;
  const latLo = Math.floor(south);
  const latHi = Math.floor(north - eps);
  const lonLo = Math.floor(west);
  const lonHi = Math.floor(east - eps);
  const tileSpecs = [];
  for (let lat = latLo; lat <= latHi; lat++) {
    for (let lon = lonLo; lon <= lonHi; lon++) {
      tileSpecs.push({
        lat, lon,
        url: FABDEM_BASE_URL + fabdemTileName(lat, lon),
      });
    }
  }

  status.textContent = t("status.fabdem_fetching", tileSpecs.length);
  progress.classList.add("active");
  progressBar.style.width = "0%";

  try {
    // Open each tile (small IFD fetch only — geotiff.js doesn't pull pixels
    // until readRasters is called). 404s are common: oceans and polar
    // strips fall outside FABDEM coverage. We log and skip.
    const opened = [];
    for (let i = 0; i < tileSpecs.length; i++) {
      const tile = tileSpecs[i];
      try {
        const tiff = await GeoTIFF.fromUrl(tile.url);
        const image = await tiff.getImage();
        opened.push({ ...tile, image });
      } catch (e) {
        console.info(`[fabdem] skipping ${tile.url}: ${e.message}`);
      }
      progressBar.style.width = `${((i + 1) / tileSpecs.length * 30).toFixed(1)}%`;
    }

    if (!opened.length) {
      status.innerHTML =
        `<span style="color:#ff6b6b">${t("status.fabdem_none")}</span>`;
      return;
    }

    // Allocate the mosaic. NaN-fill so unwritten cells (gaps between tiles
    // or outside FABDEM coverage) read as nodata in the downstream mask
    // construction (Number.isFinite check in loadDemFromArrayBuffer).
    const mosaic = new Float32Array(outW * outH);
    mosaic.fill(NaN);

    // Read each tile's intersection with the viewport. readRasters({bbox})
    // fetches only the relevant strips/tiles within the COG over HTTP
    // Range requests — that's where the bandwidth saving comes from.
    let placed = 0; // tiles successfully read into the mosaic
    for (let i = 0; i < opened.length; i++) {
      const tile = opened[i];
      const tileSouth = tile.lat;
      const tileNorth = tile.lat + FABDEM_TILE_DEG;
      const tileWest  = tile.lon;
      const tileEast  = tile.lon + FABDEM_TILE_DEG;

      // Snap the intersection to the same arcsec grid as the mosaic so
      // pixel offsets line up exactly.
      const interWest  = Math.max(outWest,  tileWest);
      const interEast  = Math.min(outEast,  tileEast);
      const interSouth = Math.max(outSouth, tileSouth);
      const interNorth = Math.min(outNorth, tileNorth);
      if (interEast <= interWest || interNorth <= interSouth) continue;

      // A single tile's range-read can fail (transient network / partial COG);
      // skip just that tile instead of letting the whole mosaic abort.
      try {
      // Per-tile nodata sentinel — FABDEM uses GDAL_NODATA, varies by tile.
      const nodataRaw = tile.image.fileDirectory.getValue("GDAL_NODATA");
      const nodata = nodataRaw ? parseFloat(nodataRaw) : null;

      // Convert the geographic intersection to a pixel window. NB:
      // image.readRasters({bbox}) does NOT exist on GeoTIFFImage — only
      // the top-level tiff.readRasters supports bbox. Passing it to the
      // image-level call silently falls back to "read full image", which
      // would blow the 50 MB cap AND scramble the mosaic placement below.
      // We compute the pixel window ourselves from the source's origin
      // and resolution so geotiff.js issues Range requests for just the
      // strips overlapping the viewport.
      const [oX, oY] = tile.image.getOrigin();
      const [rX, rY] = tile.image.getResolution(); // rX > 0 east, rY < 0 down
      const wnd = [
        Math.round((interWest  - oX) / rX),
        Math.round((interNorth - oY) / rY),
        Math.round((interEast  - oX) / rX),
        Math.round((interSouth - oY) / rY),
      ];
      const raster = await tile.image.readRasters({
        window: wnd,
        interleave: true,
      });
      const rW = wnd[2] - wnd[0];
      const rH = wnd[3] - wnd[1];

      // Place into mosaic. Mosaic origin is (outWest, outNorth) at row 0,
      // col 0; rows count southward.
      const colOffset = Math.round((interWest - outWest)  * 3600);
      const rowOffset = Math.round((outNorth - interNorth) * 3600);
      for (let r = 0; r < rH; r++) {
        const mr = rowOffset + r;
        if (mr < 0 || mr >= outH) continue;
        for (let c = 0; c < rW; c++) {
          const mc = colOffset + c;
          if (mc < 0 || mc >= outW) continue;
          const v = raster[r * rW + c];
          if (Number.isFinite(v) && (nodata === null || v !== nodata)) {
            mosaic[mr * outW + mc] = v;
          }
        }
      }
      placed++;
      } catch (err) {
        console.warn(`[fabdem] tile ${fabdemTileName(tile.lat, tile.lon)} read failed — skipping:`, err);
      }
      progressBar.style.width = `${(30 + (i + 1) / opened.length * 70).toFixed(1)}%`;
      status.textContent = t("status.fabdem_mosaic", i + 1, opened.length);
    }
    if (placed === 0) {
      progress.classList.remove("active");
      status.innerHTML = `<span style="color:#ff6b6b">${t("status.fabdem_all_failed")}</span>`;
      return;
    }

    // Wrap the mosaic as a GeoTIFF in memory so loadDemFromArrayBuffer
    // can ingest it like any other DEM. Same writer we use for bundle
    // outputs — Float32, EPSG:4326, north-up.
    const tiffMd = {
      width:  outW,
      height: outH,
      BitsPerSample:    [32],
      SampleFormat:     [3],
      SamplesPerPixel:  [1],
      ModelPixelScale:  [FABDEM_ARCSEC, FABDEM_ARCSEC, 0],
      ModelTiepoint:    [0, 0, 0, outWest, outNorth, 0],
      GeographicTypeGeoKey: 4326,
    };
    const buf = GeoTIFF.writeArrayBuffer(mosaic, tiffMd);

    state.demSourceUrl = `FABDEM viewport ${outWest.toFixed(2)},${outSouth.toFixed(2)} → ${outEast.toFixed(2)},${outNorth.toFixed(2)} (${opened.length} tile${opened.length === 1 ? "" : "s"})`;
    await loadDemFromArrayBuffer(buf, `FABDEM ${outW}×${outH} (${opened.length} tile${opened.length === 1 ? "" : "s"})`);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.fabdem_failed", escapeHtml(err.message))}</span>`;
  } finally {
    progress.classList.remove("active");
  }
}

async function loadDemFromArrayBuffer(buf, label) {
  // A compute still running against the previous DEM would render arrays
  // sized to the old H×W onto the new grid — kill it before anything else.
  cancelActiveCompute();
  status.textContent = t("status.loading_label", label);
  const tiff = await GeoTIFF.fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const W = image.getWidth();
  const H = image.getHeight();
  // geotiff.js 3.x: getTiePoints() is async and fileDirectory is an
  // ImageFileDirectory object — values are read via getValue('TagName').
  const tiePoints = await image.getTiePoints();
  const fileDirectory = image.fileDirectory;
  const pixelScale = fileDirectory.getValue("ModelPixelScale");
  if (!pixelScale || !tiePoints?.length) {
    throw new Error("DEM lacks geotransform metadata. Use a properly georeferenced GeoTIFF.");
  }
  const dx = pixelScale[0];
  const dy = pixelScale[1];
  const originX = tiePoints[0].x;
  const originY = tiePoints[0].y;

  // Read elevation as Float32Array
  const raster = await image.readRasters({ interleave: true });
  const height = raster instanceof Float32Array ? raster : Float32Array.from(raster);

  // Build mask: anything finite and != nodata
  const nodataRaw = fileDirectory.getValue("GDAL_NODATA");
  const nodata = nodataRaw ? parseFloat(nodataRaw) : null;
  const mask = new Uint8Array(H * W);
  for (let i = 0; i < H * W; i++) {
    const v = height[i];
    mask[i] = (Number.isFinite(v) && (nodata === null || v !== nodata)) ? 1 : 0;
  }

  // Pull the source TIFF's GeoKeys up front: they declare the real CRS (so a
  // COARSE geographic DEM with dx ≥ 0.01° isn't mis-read as projected by the
  // magnitude heuristic), and they're also stamped onto exported GeoTIFFs.
  let geoKeys = null;
  try {
    geoKeys = image.getGeoKeys ? image.getGeoKeys() : null;
  } catch { /* getGeoKeys throws on some malformed tiffs — fine to skip */ }

  // The map, overlays and click-to-pick are EPSG:4326-only. Prefer the TIFF's
  // declared model type (GTModelTypeGeoKey: 1=projected, 2=geographic); fall
  // back to a coordinate-magnitude heuristic only when GeoKeys are absent.
  const modelType = geoKeys && geoKeys.GTModelTypeGeoKey;
  const isProbablyGeographic =
    modelType === 2 ? true
      : modelType === 1 ? false
      : (Math.abs(originX) < 360 && Math.abs(originY) < 90 && dx < 0.01);
  if (isProbablyGeographic) {
    status.innerHTML = `<span style="opacity:0.7">${t("status.dem_lonlat")}</span>`;
  }

  // Convert degrees → metres for geographic DEMs using a flat-earth
  // approximation centred on the DEM's middle latitude. For a 5–50 km
  // extent this is good to ~0.3%.
  const latRef = isProbablyGeographic ? originY - (H * dy) / 2 : 0;
  const dxM = isProbablyGeographic
    ? dx * 111320 * Math.cos((latRef * Math.PI) / 180)
    : dx;
  const dyM = isProbablyGeographic ? dy * 110574 : dy;

  // (geoKeys was read above, before CRS classification. It's stamped onto any
  // GeoTIFFs we export later — energy.tif / passes.tif / network.tif — so
  // projected DEMs round-trip with their real CRS, not a bare 4326.)

  // A new DEM invalidates the cached network graph (elevations changed).
  state.networkGraph = null; state.networkGraphToken = null;
  state.dem = {
    height, mask, H, W,
    dx, dy,                  // native CRS units (degrees for geographic)
    dxM, dyM,                // always metres — fed to the worker
    originX, originY,
    // bbox in DEM CRS units (degrees for geographic):
    bbox: { xmin: originX, ymin: originY - H * dy, xmax: originX + W * dx, ymax: originY },
    isGeographic: isProbablyGeographic,
    geoKeys,                 // for GeoTIFF round-trip on export
  };
  state.demLabel = label;

  // Draw a rectangle around the DEM extent (so the user sees what cells
  // they're working with) and pan/zoom the map to fit.
  if (state.demRect) { state.demRect.remove(); state.demRect = null; }
  if (isProbablyGeographic) {
    const south = originY - H * dy;
    const north = originY;
    const west = originX;
    const east = originX + W * dx;
    const bounds = [[south, west], [north, east]];
    state.demRect = L.rectangle(bounds, {
      color: "#ff8c42",
      weight: 1.5,
      fillOpacity: 0,
      dashArray: "4 3",
      interactive: false,
    }).addTo(map);
    map.fitBounds(bounds, { padding: [20, 20], maxZoom: 16 });
  }

  // Clear any prior energy / passes / relief overlay + clicked points so
  // we don't leave stale visuals from the previous DEM hanging around.
  if (state.energyOverlay)     { state.energyOverlay.remove();     state.energyOverlay = null; }
  if (state.passesOverlay)     { state.passesOverlay.remove();     state.passesOverlay = null; }
  if (state.demReliefOverlay)  { state.demReliefOverlay.remove();  state.demReliefOverlay = null; }
  state.demSlope = null;
  state.demReliefDataUrl = null;
  if (state.pathLine)      { state.pathLine.remove();      state.pathLine = null; }
  if (state.routeLines)    { for (const ln of state.routeLines) ln.remove(); state.routeLines = []; }
  if (state.srcMarker)     { state.srcMarker.remove();     state.srcMarker = null; }
  if (state.dstMarker)     { state.dstMarker.remove();     state.dstMarker = null; }
  if (state.refMarkers && state.refMarkers.length) {
    for (const m of state.refMarkers) m.remove();
  }
  state.refMarkers = [];
  state.refPoints = [];
  state.qmcIndex = 0;
  state.src = null;
  state.dst = null;
  state.lastResult = null;
  // New DEM → previous calibration is meaningless; invalidate it and any
  // in-flight probe (gen bump) so the estimate shows "estimating…" until a
  // fresh probe lands.
  state.calibration = null;
  state.calibrationGen++;
  if (state.probeWorker) { state.probeWorker.terminate(); state.probeWorker = null; }
  // Drop any previously loaded vector network — its rasterised mask is
  // sized to the *previous* DEM's H×W and would corrupt the next compute
  // (or crash) if reused. The user re-uploads the .gpkg if they want it.
  // Drop the impassable mask + corridors BEFORE clearing the network: they're
  // sized to the previous DEM's grid, and clearVectorNetwork →
  // onNetworkCorridorsChanged would otherwise recalibrate against a stale,
  // wrong-sized mask. No dirty cascade — the loader already cancelled compute
  // and starts its own probe below.
  state.impassable = null;
  state.impassableRaster = null;
  state.impassableMeta = null;
  state.corridorCells = null; state.corridorBase = null; state.corridorRamp = null;
  state.corridorSet = null;
  state.osmWaterGeom = null; // grid-bound geometry is stale for a new DEM
  if (state.impassableOverlay) { state.impassableOverlay.remove(); state.impassableOverlay = null; }
  const impInputReset = document.getElementById("impassable-file");
  if (impInputReset) impInputReset.value = "";
  clearVectorNetwork();
  updateImpassableMeta();
  updateCorridorAvailability();
  // Bridges too — endA/endB are cell indices sized to the previous DEM's grid.
  state.bridges = null;
  state.bridgesMeta = null;
  if (state.bridgesLayer) { state.bridgesLayer.remove(); state.bridgesLayer = null; }
  updateBridgeMeta();
  syncRefDisplay();
  document.getElementById("src-display").textContent = "— click map —";
  document.getElementById("dst-display").textContent = "— optional —";
  document.getElementById("src-display").classList.remove("set");
  document.getElementById("dst-display").classList.remove("set");
  resultMeta.innerHTML = "—";

  // Display metadata. For geographic DEMs (EPSG:4326), dx/dy are in
  // degrees and need to be converted to metres for cell-size and coverage
  // figures. We use a flat-earth approximation good to ~0.3% at typical
  // cycling-region scales.
  const cellLabel = formatCellSize(dx, dy, originY, H, isProbablyGeographic);
  const coverLabel = formatCoverage(W, H, dx, dy, originY, isProbablyGeographic);
  const originLabel = isProbablyGeographic
    ? `${originX.toFixed(4)}°, ${originY.toFixed(4)}°`
    : `${originX.toFixed(1)}, ${originY.toFixed(1)}`;
  demMeta.innerHTML = `
    <span class="v">${W} × ${H}</span> cells, cell ${cellLabel}<br/>
    origin <span class="v">${originLabel}</span><br/>
    ${coverLabel}
  `;
  if (state.dem.isGeographic) {
    status.textContent = t("status.dem_loaded", label);
  } else {
    // Projected/unknown CRS: Leaflet is EPSG:4326-only, so the DEM can't be
    // placed on the map — overlays, click-to-pick and relief are all
    // unavailable (don't claim "click to set source"). Tell the user plainly.
    status.innerHTML = `<span style="color:#ff9d3d">${t("status.dem_projected", escapeHtml(label))}</span>`;
  }
  updateRunButtonState();
  syncLoadedHighlights(); // light up group 1A (and 1B was just cleared above)
  // Auto-expand: a fresh DEM opens the next input step (1B) + the compute setup.
  setGroupOpen("network-group", true);
  setGroupOpen("group-3", true);
  setGroupOpen("params-group", true);
  setGroupOpen("pick-points-group", true);
  setGroupOpen("execution-group", true);
  estimateRunTime();

  // Build the cmocean.phase + slope hillshade for the new DEM. Renders
  // synchronously — for a 12 M-cell viewport (the FABDEM cap) this takes
  // about a second; the user already paid for the DEM load so the extra
  // delay is rolled into that. The relief overlay is wired into the
  // standard layer-controls; it stays hidden until the user toggles it.
  // Skip the (expensive) relief build on non-geographic DEMs — the
  // imageOverlay path is gated on isGeographic too, so we'd just be
  // burning a few seconds of slope/render compute and a 5–20 MB
  // PNG that never gets displayed.
  if (state.dem.isGeographic) {
    try {
      // Slope array is 4·H·W bytes — for a 135 M-cell DEM that's 540 MB.
      // We compute it, hand it to the renderer once, then drop the reference
      // immediately. The render output is a tiny PNG dataURL; the raw slope
      // grid is never read again unless the user reloads the DEM.
      const slopeArr = computeSlope(height, mask, H, W,
                                    state.dem.dxM, state.dem.dyM);
      state.demReliefDataUrl = renderReliefToDataURL(state.dem, slopeArr);
      state.demSlope = null;  // free the float buffer after render
      applyDemReliefOverlay();
    } catch (err) {
      console.warn("[relief] failed to build hillshade:", err);
      state.demSlope = null;
      state.demReliefDataUrl = null;
    }
  }
  // Reveal the layer-block now that the data exists.
  const reliefRow = document.getElementById("relief-row");
  if (reliefRow) reliefRow.style.display = state.demReliefDataUrl ? "" : "none";
  applyLayerControls();

  // Calibrate the compute-time estimate for this DEM (async, off-thread).
  startCalibrationProbe();

  // A bundle was loaded before this DEM (or against a mismatched one) and
  // is waiting in state.pendingBundle. If this DEM matches its grid,
  // re-apply it now — parameters, src/dst/ref markers, and the cached
  // rasters all come back without a recompute.
  if (state.pendingBundle) {
    const pb = state.pendingBundle;
    const bH = pb.md.dem?.H, bW = pb.md.dem?.W;
    const dimsKnown = Number.isFinite(bH) && Number.isFinite(bW);
    if (!dimsKnown || (H === bH && W === bW)) {
      state.pendingBundle = null; // applyMetadataToUI re-stashes only on mismatch
      applyMetadataToUI(pb.md, pb.bin);
    } else {
      status.innerHTML =
        `<span style="color:#ff9d3d">${t("status.bundle_dem_mismatch_pending", W, H, bW, bH)}</span>`;
    }
  }
}

// ------- Vector network loader (GeoPackage) -------
// Reads a .gpkg via sql.js, finds the (first) geometry table, reprojects
// LineString features into the DEM CRS via proj4js, and rasterises them
// with Bresenham into a binary network mask. The mask is AND'd with the
// DEM mask before each compute so analysis is constrained to the lines.

let _sqlPromise = null;
function getSQL() {
  if (!_sqlPromise) {
    if (typeof initSqlJs !== "function") {
      return Promise.reject(new Error("sql.js didn't load (CDN blocked, or offline before it was ever fetched?)"));
    }
    // sql.js fetches sql-wasm.wasm from this CDN ON FIRST GeoPackage open. Like
    // the other CDN libs it is runtime-cached (sw.js), NOT precached — so
    // offline GeoPackage import requires opening a .gpkg at least once while
    // online (same caveat as DEMs). initSqlJs rejects below if it's missing.
    _sqlPromise = initSqlJs({
      locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`,
    }).catch((err) => { _sqlPromise = null; throw err; }); // let a later retry re-fetch
  }
  return _sqlPromise;
}

// Parse a GeoPackage StandardGeoPackageBinary blob into an array of
// [x, y] coordinates, or null when the geometry isn't a (Multi)LineString.
// Header layout per OGC GeoPackage 1.4 §2.1.3.
function parseGpkgGeom(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < 8) return null;
  if (blob[0] !== 0x47 || blob[1] !== 0x50) return null; // "GP"
  const flags = blob[3];
  const envelopeType = (flags >> 1) & 0x07;
  const envBytes = [0, 32, 48, 48, 64, 0, 0, 0][envelopeType] || 0;
  const wkbStart = 8 + envBytes;
  if (blob.length < wkbStart + 9) return null;

  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return parseWKB(view, wkbStart);
}

// Decode a WKB geometry-type word into the 2-D base type and the per-vertex
// byte stride. Handles both dimension encodings in the wild:
//   ISO/OGC: base + 1000·Z + 2000·M + 3000·ZM  (LineString Z = 1002 — what
//            QGIS writes into GeoPackages by default for 3-D sources)
//   EWKB:    flag bits 0x80000000 (Z) / 0x40000000 (M)
// The old code masked with `t & 0x0fff`, which left ISO-typed geometries
// (1002, 1005, …) unrecognised — 3-D .gpkg files silently rasterised to an
// empty network.
function wkbTypeInfo(t) {
  const code = t & 0x0fffffff;       // drop EWKB flag bits
  const base = code % 1000;          // ISO offsets: 1002 → 2, 3005 → 5
  const isoDim = Math.floor(code / 1000) | 0;
  const hasZ = (t & 0x80000000) !== 0 || isoDim === 1 || isoDim === 3;
  const hasM = (t & 0x40000000) !== 0 || isoDim === 2 || isoDim === 3;
  return { base, stride: 16 + (hasZ ? 8 : 0) + (hasM ? 8 : 0) };
}

// Every read is bounds-guarded against view.byteLength: a corrupt/truncated
// blob — or a header mis-aligned by an unrecognised GeoPackage envelope type
// — must return null (the caller skips that one feature) rather than throw a
// RangeError out of getFloat64/getUint32 that aborts the entire .gpkg load.
function parseWKB(view, off) {
  const len = view.byteLength;
  if (off + 5 > len) return null;
  const le = view.getUint8(off) === 1;
  off += 1;
  const t = view.getUint32(off, le);
  off += 4;
  const { base: baseType, stride } = wkbTypeInfo(t);

  if (baseType === 2) {
    // LineString
    if (off + 4 > len) return null;
    const n = view.getUint32(off, le); off += 4;
    if (off + n * stride > len) return null; // truncated / absurd vertex count
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = [view.getFloat64(off, le), view.getFloat64(off + 8, le)];
      off += stride;
    }
    return [out];
  }
  if (baseType === 5) {
    // MultiLineString — skip outer header per child too
    if (off + 4 > len) return null;
    const k = view.getUint32(off, le); off += 4;
    const lines = [];
    for (let j = 0; j < k; j++) {
      if (off + 5 > len) return null;
      const subLE = view.getUint8(off) === 1; off += 1;
      const subT = view.getUint32(off, subLE); off += 4;
      const { base: subBase, stride: subStride } = wkbTypeInfo(subT);
      if (subBase !== 2) return null;
      if (off + 4 > len) return null;
      const n = view.getUint32(off, subLE); off += 4;
      if (off + n * subStride > len) return null; // truncated / absurd
      const ln = new Array(n);
      for (let i = 0; i < n; i++) {
        ln[i] = [view.getFloat64(off, subLE), view.getFloat64(off + 8, subLE)];
        off += subStride;
      }
      lines.push(ln);
    }
    return lines;
  }
  return null;
}

// Bresenham 8-connected line draw onto a 1D row-major mask. Plots a
// "stamp" of (2*halfWidth + 1) cells for line widths > 1.
function rasterLine(r0, c0, r1, c1, mask, W, H, halfWidth) {
  const dr = Math.abs(r1 - r0);
  const dc = Math.abs(c1 - c0);
  const sr = r0 < r1 ? 1 : -1;
  const sc = c0 < c1 ? 1 : -1;
  let err = dc - dr;
  let r = r0, c = c0;
  // Hard iteration cap. A line clipped to the grid plots at most ~(W+H) cells.
  // A wrong-CRS .gpkg can yield endpoints MILLIONS of cells apart (one far NW,
  // one far SE) that slip past the off-grid cull at the call sites; without a
  // cap this Bresenham walk runs for millions of steps on the main thread and
  // freezes the tab. Such a network rasterises to ~0 in-grid cells and is
  // rejected downstream, so bailing early only affects the pathological case.
  let guard = 2 * (W + H) + 4 * halfWidth + 16;
  while (guard-- > 0) {
    for (let pdr = -halfWidth; pdr <= halfWidth; pdr++) {
      const rr = r + pdr;
      if (rr < 0 || rr >= H) continue;
      const rowOff = rr * W;
      for (let pdc = -halfWidth; pdc <= halfWidth; pdc++) {
        const cc = c + pdc;
        if (cc < 0 || cc >= W) continue;
        mask[rowOff + cc] = 1;
      }
    }
    if (r === r1 && c === c1) break;
    const e2 = 2 * err;
    if (e2 > -dr) { err -= dr; c += sc; }
    if (e2 <  dc) { err += dc; r += sr; }
  }
}

function readFileWithProgress(file, onFrac) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("FileReader error"));
    fr.onprogress = (e) => {
      if (e.lengthComputable) onFrac(e.loaded / e.total);
    };
    fr.readAsArrayBuffer(file);
  });
}

async function loadVectorNetwork(file) {
  if (!state.dem) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`;
    return;
  }

  // In-progress status lives in the network section's own meta line — it's
  // contextual to where the user clicked, and the global `status` stays
  // free for messages from other parts of the app.
  const vecMeta = document.getElementById("vec-meta");
  const setVecStatus = (html) => { if (vecMeta) vecMeta.innerHTML = html; };

  // Reuse the compute progress bar. File-read phase fills 0–40 %, sql.js
  // init 40–50 %, rasterise 50–100 %.
  progress.classList.add("active");
  progressBar.style.width = "0%";
  setVecStatus(t("status.vec_reading", escapeHtml(file.name), (file.size / 1024 / 1024).toFixed(0)));
  const buf = await readFileWithProgress(file, (frac) => {
    progressBar.style.width = `${(frac * 40).toFixed(1)}%`;
  });
  progressBar.style.width = "40%";

  setVecStatus(t("status.vec_init_sql"));
  const SQL = await getSQL();
  const db = new SQL.Database(new Uint8Array(buf));
  progressBar.style.width = "50%";

  try {
    const cont = db.exec("SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns LIMIT 1");
    if (!cont.length) throw new Error("No gpkg_geometry_columns entry — not a valid .gpkg?");
    const tableName = cont[0].values[0][0];
    // Geometry column name from the metadata — QGIS/ogr2ogr default to
    // "geom", but "geometry"/"shape" exist in the wild; hardcoding "geom"
    // made those files fail to load.
    const geomCol   = cont[0].values[0][1] || "geom";
    const srsId     = cont[0].values[0][2];

    // Detect attribute columns we can flag bridges/tunnels with — OSM-export
    // schemas vary: some have dedicated bridge/tunnel/layer columns, others
    // pack them into an hstore `other_tags` string. We SELECT whichever exist
    // alongside the geometry so loadVectorNetwork can capture bridge candidates
    // for the 1d "extract from loaded network" feature, without a re-parse.
    let allCols = [];
    try {
      const ti = db.exec(`PRAGMA table_info("${tableName}")`);
      if (ti.length) allCols = ti[0].values.map((v) => String(v[1]));
    } catch {}
    const tagCols = ["bridge", "tunnel", "layer", "name", "other_tags"].filter((c) => allCols.includes(c));

    // Resolve source CRS for proj4. WGS84 is built in; everything else
    // uses the WKT/PROJ string from gpkg_spatial_ref_sys.
    const isSrcWgs = srsId === 4326 || srsId === 0 || srsId === -1;
    if (!isSrcWgs) {
      const srsRes = db.exec(
        `SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id = ${srsId}`,
      );
      if (!srsRes.length || !srsRes[0].values[0][0]) {
        throw new Error(`Source SRS ${srsId} has no definition in gpkg_spatial_ref_sys`);
      }
      proj4.defs(`EPSG:${srsId}`, srsRes[0].values[0][0]);
    }

    // DEM bounds in source CRS for the rtree filter — keeps us from
    // burning every line in a country-scale .gpkg when the DEM is small.
    const { originX, originY, H, W, dx, dy } = state.dem;
    const south = originY - H * dy, north = originY;
    const west  = originX,         east  = originX + W * dx;
    let xmin, xmax, ymin, ymax;
    if (isSrcWgs) {
      xmin = west;  xmax = east;
      ymin = south; ymax = north;
    } else {
      const corners = [
        [west, south], [east, south], [east, north], [west, north],
      ].map(([x, y]) => proj4("EPSG:4326", `EPSG:${srsId}`, [x, y]));
      xmin = Math.min(...corners.map((p) => p[0]));
      xmax = Math.max(...corners.map((p) => p[0]));
      ymin = Math.min(...corners.map((p) => p[1]));
      ymax = Math.max(...corners.map((p) => p[1]));
    }

    // Try the rtree-filtered query first; fall back to a full scan if the
    // table isn't there.
    const rtree = `rtree_${tableName}_${geomCol}`;
    let stmt, totalFeatures = 0, useRtree = true;
    try {
      // Pre-count for the progress bar.
      const cnt = db.prepare(
        `SELECT COUNT(*) FROM "${rtree}" WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?`,
      );
      cnt.bind([xmax, xmin, ymax, ymin]);
      cnt.step();
      totalFeatures = cnt.get()[0] | 0;
      cnt.free();
      stmt = db.prepare(`
        SELECT t."${geomCol}"${tagCols.map((c) => `, t."${c}"`).join("")} FROM "${tableName}" t
        WHERE t.fid IN (
          SELECT id FROM "${rtree}"
          WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
        )
      `);
      stmt.bind([xmax, xmin, ymax, ymin]);
    } catch (e) {
      console.info("[gpkg] no rtree, full scan:", e.message);
      useRtree = false;
      try {
        const cnt = db.prepare(`SELECT COUNT(*) FROM "${tableName}"`);
        cnt.step();
        totalFeatures = cnt.get()[0] | 0;
        cnt.free();
      } catch {}
      stmt = db.prepare(`SELECT "${geomCol}"${tagCols.map((c) => `, "${c}"`).join("")} FROM "${tableName}"`);
    }
    // Geometry is row[0]; tag columns follow in tagCols order.
    const tagIdx = {}; tagCols.forEach((c, i) => { tagIdx[c] = i + 1; });

    const lineWidth = Math.max(1, parseInt(document.getElementById("vec-width")?.value, 10) || 1);
    const halfWidth = (lineWidth - 1) >> 1;
    const networkMask = new Uint8Array(W * H);

    const project = isSrcWgs ? (xy) => xy : (xy) => proj4(`EPSG:${srsId}`, "EPSG:4326", xy);

    let scanned = 0, rasterised = 0;
    // Collect WGS84 geometry for the optional vector rendering. Capped so a
    // monster network can't blow up memory / the Leaflet canvas — past the
    // cap we keep rasterising but stop storing, and disable the draw toggle.
    const VEC_RENDER_VERTEX_CAP = 2_000_000;
    let storedVertices = 0;
    let collected = [];
    // Bridge/tunnel ways extracted for the 1d "from loaded network" feature.
    const bridgeCandidates = [];
    const extractWayTags = (row) => {
      const get = (c) => (tagIdx[c] != null ? row[tagIdx[c]] : null);
      const ot = get("other_tags");
      const otv = (k) => { if (!ot) return null; const m = ot.match(new RegExp('"' + k + '"=>"([^"]*)"')); return m ? m[1] : null; };
      const bridge = get("bridge") || otv("bridge");
      const tunnel = get("tunnel") || otv("tunnel");
      const isBridge = (bridge && bridge !== "no") || tunnel === "yes";
      if (!isBridge) return { isBridge: false };
      const kind = tunnel === "yes" ? "tunnel" : "bridge";
      const layerRaw = get("layer") || otv("layer");
      return { isBridge: true, kind, layer: parseInt(layerRaw, 10) || (kind === "tunnel" ? -1 : 1), name: get("name") || otv("name") || null };
    };
    while (stmt.step()) {
      const row = stmt.get();
      const blob = row[0];
      scanned++;
      // parseGpkgGeom is bounds-guarded, but wrap defensively so any single
      // malformed geometry is skipped rather than aborting the whole load.
      let lines = null;
      try { lines = parseGpkgGeom(blob); } catch { lines = null; }
      if (!lines) continue;
      const tg = tagCols.length ? extractWayTags(row) : { isBridge: false };
      for (const coords of lines) {
        const keepRender = collected !== null && storedVertices < VEC_RENDER_VERTEX_CAP;
        // Build latlngs when rendering OR when this is a bridge/tunnel (we always
        // want a deck candidate's geometry, even past the render cap).
        const lineLatLngs = (keepRender || tg.isBridge) ? [] : null;
        let prevR = null, prevC = null;
        for (const xy of coords) {
          const [lng, lat] = project(xy);
          if (lineLatLngs) lineLatLngs.push([lat, lng]);
          if (keepRender) storedVertices++;
          const c = Math.floor((lng - originX) / dx);
          const r = Math.floor((originY - lat) / dy);
          if (prevR !== null) {
            // Clip wildly-out-of-bounds lines fast — we do per-pixel
            // bounds checks inside rasterLine but skipping segments that
            // are entirely outside saves a lot of pixel iterations.
            if (!(
              (prevR < 0 && r < 0) || (prevR >= H && r >= H) ||
              (prevC < 0 && c < 0) || (prevC >= W && c >= W)
            )) {
              rasterLine(prevR, prevC, r, c, networkMask, W, H, halfWidth);
            }
          }
          prevR = r; prevC = c;
        }
        if (lineLatLngs && lineLatLngs.length > 1) {
          if (keepRender) collected.push(lineLatLngs);
          if (tg.isBridge) bridgeCandidates.push({ latlngs: lineLatLngs, kind: tg.kind, layer: tg.layer, name: tg.name });
        }
        if (storedVertices >= VEC_RENDER_VERTEX_CAP && collected !== null) {
          console.warn(`[network] geometry over ${VEC_RENDER_VERTEX_CAP} vertices — vector rendering disabled, raster mask unaffected.`);
          collected = null;
        }
        rasterised++;
      }
      if (scanned % 2000 === 0) {
        const frac = totalFeatures > 0 ? scanned / totalFeatures : 0;
        progressBar.style.width = `${(50 + frac * 50).toFixed(1)}%`;
        setVecStatus(totalFeatures > 0
          ? t("status.vec_rasterising_of", scanned, totalFeatures, rasterised)
          : t("status.vec_rasterising_scan", scanned, rasterised));
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    stmt.free();
    progressBar.style.width = "100%";

    let networkCells = 0;
    for (let i = 0; i < networkMask.length; i++) if (networkMask[i]) networkCells++;

    if (networkCells === 0) {
      // Rasterised to nothing — almost always a CRS or geometry-type
      // mismatch with the DEM. DON'T store the mask: an empty mask AND'd
      // with the DEM would make every click un-snappable and Compute
      // unusable. Say so loudly instead.
      document.getElementById("vec-meta").innerHTML =
        t("status.net_meta_zero", srsId, scanned, rasterised);
      status.innerHTML = `<span style="color:#ff6b6b">${t("status.net_zero_cells")}</span>`;
      return;
    }

    state.networkMask = networkMask;
    state.networkSrsId = srsId;
    state.networkFeatureCount = rasterised;
    document.getElementById("vec-meta").innerHTML =
      `EPSG:${srsId} · ` + t("status.net_meta_drawn", rasterised, networkCells.toLocaleString(), (100 * networkCells / (W * H)).toFixed(1));
    status.textContent = t("status.network_loaded");
    state.lastResult = null; // previous compute used the un-constrained mask
    cancelActiveCompute();   // …and so would an in-flight one
    state.networkLines = collected;
    state.networkLinesMeta = null; // .gpkg graph-mode bridge flattening not wired (tags live per-feature, not per-kept-line)
    state.networkBridgeCandidates = bridgeCandidates.length ? bridgeCandidates : null;
    applyNetworkLinesOverlay();
    syncLoadedHighlights(); // light up group 1B
    setGroupOpen("impassable-group", true); // network loaded → next input step
    onNetworkCorridorsChanged(); // a new network may carve corridors over the mask
  } finally {
    db.close();
    progress.classList.remove("active");
  }
}

// Rasterise an array of WGS84 polylines ([[lat,lng], …] each) onto the DEM
// grid and install the result as the active network (mask, meta, rendering,
// compute invalidation). Shared tail for non-gpkg network sources (OSM).
function installNetworkFromLines(lines, srsId, sourceLabel, meta = null) {
  const { originX, originY, H, W, dx, dy } = state.dem;
  const lineWidth = Math.max(1, parseInt(document.getElementById("vec-width")?.value, 10) || 1);
  const halfWidth = (lineWidth - 1) >> 1;
  const networkMask = new Uint8Array(W * H);
  let rasterised = 0;
  for (const coords of lines) {
    let prevR = null, prevC = null;
    for (const [lat, lng] of coords) {
      const c = Math.floor((lng - originX) / dx);
      const r = Math.floor((originY - lat) / dy);
      if (prevR !== null && !(
        (prevR < 0 && r < 0) || (prevR >= H && r >= H) ||
        (prevC < 0 && c < 0) || (prevC >= W && c >= W)
      )) {
        rasterLine(prevR, prevC, r, c, networkMask, W, H, halfWidth);
      }
      prevR = r; prevC = c;
    }
    rasterised++;
  }

  let networkCells = 0;
  for (let i = 0; i < networkMask.length; i++) if (networkMask[i]) networkCells++;
  if (networkCells === 0) {
    status.innerHTML =
      `<span style="color:#ff6b6b">${t("status.net_zero_cells_src", escapeHtml(sourceLabel))}</span>`;
    return false;
  }

  state.networkMask = networkMask;
  state.networkSrsId = srsId;
  state.networkFeatureCount = rasterised;
  document.getElementById("vec-meta").innerHTML =
    `${escapeHtml(sourceLabel)} · ` + t("status.net_meta_drawn", rasterised, networkCells.toLocaleString(), (100 * networkCells / (W * H)).toFixed(1));
  status.textContent = t("status.network_loaded");
  state.lastResult = null;
  cancelActiveCompute();
  // Keep geometry for the optional vector rendering, same cap as the gpkg path.
  // Keep per-way meta (bridge/tunnel/layer) aligned with the kept lines for
  // graph-mode bridge handling (Phase C).
  let vertices = 0;
  let kept = [];
  let keptMeta = meta ? [] : null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    vertices += ln.length;
    if (vertices > 2_000_000) { kept = null; keptMeta = null; break; }
    kept.push(ln);
    if (keptMeta) keptMeta.push(meta[i] || null);
  }
  state.networkLines = kept;
  state.networkLinesMeta = keptMeta;
  applyNetworkLinesOverlay();
  syncLoadedHighlights(); // light up group 1B
  setGroupOpen("impassable-group", true); // network loaded → next input step
  onNetworkCorridorsChanged(); // a new network may carve corridors over the mask
  return true;
}

// Pull the street network (highway=*) from OpenStreetMap via the Overpass
// API, over the intersection of the current map view and the DEM extent.
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

async function loadOsmNetwork() {
  if (!state.dem) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`;
    return;
  }
  const { originX, originY, H, W, dx, dy } = state.dem;
  const b = map.getBounds();
  const south = Math.max(b.getSouth(), originY - H * dy);
  const north = Math.min(b.getNorth(), originY);
  const west  = Math.max(b.getWest(),  originX);
  const east  = Math.min(b.getEast(),  originX + W * dx);
  if (!(south < north && west < east)) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.osm_no_intersect")}</span>`;
    return;
  }
  const osmBtn = document.getElementById("vec-osm");
  if (osmBtn) osmBtn.disabled = true;
  progress.classList.add("active");
  progressBar.style.width = "20%";
  status.textContent = t("status.osm_querying");
  try {
    // `out geom` inlines each way's coordinates — no separate node lookups.
    const query =
      `[out:json][timeout:90];way["highway"](${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)});out geom;`;
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status} (busy? try again in a minute)`);
    progressBar.style.width = "60%";
    status.textContent = t("status.osm_parsing");
    const json = await resp.json();
    const lines = [];
    const meta = []; // parallel { deck, layer } for graph-mode bridge handling
    const bridgeCandidates = []; // bridge/tunnel ways for the 1d "from network" feature
    for (const el of json.elements || []) {
      if (el.type === "way" && Array.isArray(el.geometry) && el.geometry.length > 1) {
        const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
        lines.push(latlngs);
        const tg = el.tags || {};
        const deck = (tg.bridge && tg.bridge !== "no") || tg.tunnel === "yes";
        const layer = parseInt(tg.layer, 10) || (tg.tunnel === "yes" ? -1 : 1);
        meta.push(deck ? { deck: true, layer } : { deck: false, layer: 0 });
        if (deck) bridgeCandidates.push({ latlngs, kind: tg.tunnel === "yes" ? "tunnel" : "bridge", layer, name: tg["bridge:name"] || tg.name || null });
      }
    }
    if (!lines.length) throw new Error("Overpass returned no highway=* ways in this extent.");
    state.networkBridgeCandidates = bridgeCandidates.length ? bridgeCandidates : null;
    progressBar.style.width = "80%";
    status.textContent = t("status.osm_rasterising", lines.length.toLocaleString());
    // Let the status paint before the synchronous rasterise.
    await new Promise((r) => setTimeout(r, 0));
    installNetworkFromLines(lines, 4326, "OSM highway=*", meta);
  } catch (err) {
    console.error("[osm]", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.osm_failed", escapeHtml(err.message))}</span>`;
  } finally {
    progress.classList.remove("active");
    if (osmBtn) osmBtn.disabled = false;
  }
}

// ---- OSM bridges & tunnels (level decks → portal edges) -------------------
// Pull bridge/tunnel ways from OSM and model each as a level deck spanning its
// two ground abutments. A bare-earth DEM omits the deck, so routing over a
// viaduct otherwise dives into the valley below; the deck is the flat truth.
// In the raster compute each deck becomes a PORTAL EDGE between its end cells at
// the flat-deck cost, leaving the cells underneath untouched — so both the
// over-bridge and the under-bridge route stay correct (2.5-D safe).

function llToCell(lat, lng) {
  const { originX, originY, dx, dy } = state.dem;
  return [Math.floor((originY - lat) / dy), Math.floor((lng - originX) / dx)];
}

async function loadOsmBridges() {
  if (!state.dem) { status.innerHTML = '<span style="color:#ff6b6b">Load a DEM first.</span>'; return; }
  // OSM coords are lon/lat; the cell mapping (llToCell) only holds for a
  // geographic (EPSG:4326) DEM. Refuse on a projected DEM rather than place
  // bridges on garbage cells (mirrors the map-click / ref-file guards).
  if (!state.dem.isGeographic) {
    status.innerHTML = '<span style="color:#ff6b6b">OSM bridge pull needs a geographic (lon/lat) DEM.</span>';
    return;
  }
  const { originX, originY, H, W, dx, dy } = state.dem;
  const b = map.getBounds();
  const south = Math.max(b.getSouth(), originY - H * dy);
  const north = Math.min(b.getNorth(), originY);
  const west  = Math.max(b.getWest(),  originX);
  const east  = Math.min(b.getEast(),  originX + W * dx);
  if (!(south < north && west < east)) {
    status.innerHTML = '<span style="color:#ff6b6b">The current map view doesn\'t intersect the DEM — pan to the DEM first.</span>';
    return;
  }
  const withTunnels = !!document.getElementById("bridge-tunnels")?.checked;
  const btn = document.getElementById("bridge-osm");
  if (btn) btn.disabled = true;
  progress.classList.add("active");
  progressBar.style.width = "20%";
  status.textContent = "Querying OSM (Overpass) for bridges…";
  try {
    const bbox = `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;
    const parts = [`way["bridge"]["bridge"!="no"]["highway"](${bbox});`];
    if (withTunnels) parts.push(`way["tunnel"="yes"]["highway"](${bbox});`);
    // Pull the ways' geometry AND any `ele` tags on their nodes (mapped deck
    // elevations): union → set .bw → emit geometry, then its nodes carrying ele.
    const query = `[out:json][timeout:90];(${parts.join("")})->.bw;.bw out geom;node(w.bw)["ele"];out body;`;
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status} (busy? try again in a minute)`);
    progressBar.style.width = "60%";
    status.textContent = "Parsing OSM response…";
    const json = await resp.json();
    // Mapped node elevations (`ele`), keyed by rounded coord — matched to way
    // vertices by position (same OSM nodes ⇒ identical coords).
    const eleByCoord = new Map();
    const ckey = (lat, lon) => `${lat.toFixed(7)},${lon.toFixed(7)}`;
    for (const el of json.elements || []) {
      if (el.type !== "node" || !el.tags || el.tags.ele == null) continue;
      const e = parseFloat(el.tags.ele);
      if (Number.isFinite(e)) eleByCoord.set(ckey(el.lat, el.lon), e);
    }
    const ways = [];
    for (const el of json.elements || []) {
      if (el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
      const tg = el.tags || {};
      const g = el.geometry;
      // Deck elevation at each abutment (way end): the end node's `ele` if
      // mapped, else a way-level `ele`, else the nearest mapped node from that
      // end; null ⇒ buildPortals falls back to the DEM at the abutment cell.
      const vEle = g.map((p) => (eleByCoord.has(ckey(p.lat, p.lon)) ? eleByCoord.get(ckey(p.lat, p.lon)) : null));
      const wayEle = Number.isFinite(parseFloat(tg.ele)) ? parseFloat(tg.ele) : null;
      let firstTagged = null, lastTagged = null;
      for (let i = 0; i < vEle.length; i++) { if (vEle[i] != null) { firstTagged = vEle[i]; break; } }
      for (let i = vEle.length - 1; i >= 0; i--) { if (vEle[i] != null) { lastTagged = vEle[i]; break; } }
      ways.push({
        latlngs: g.map((p) => [p.lat, p.lon]),
        kind: tg.tunnel === "yes" ? "tunnel" : "bridge",
        layer: parseInt(tg.layer, 10) || 0,
        name: tg["bridge:name"] || tg.name || null,
        eleA: vEle[0] ?? wayEle ?? firstTagged ?? null,
        eleB: vEle[vEle.length - 1] ?? wayEle ?? lastTagged ?? null,
      });
    }
    if (!ways.length) throw new Error("Overpass returned no bridges/tunnels in this extent.");
    installBridgesFromWays(ways, "OSM");
  } catch (err) {
    console.error("[osm-bridges]", err);
    status.innerHTML = `<span style="color:#ff6b6b">OSM bridge pull failed: ${escapeHtml(err.message)}</span>`;
  } finally {
    progress.classList.remove("active");
    if (btn) btn.disabled = false;
  }
}

// Turn raw bridge/tunnel ways into the deck model (state.bridges). OSM splits a
// bridge way at its abutments, so the first/last vertex are the ground ends.
function installBridgesFromWays(ways, sourceLabel) {
  if (!state.dem.isGeographic) {
    status.innerHTML = '<span style="color:#ff6b6b">Bridges need a geographic (lon/lat) DEM.</span>';
    return false;
  }
  const { H, W, dxM, dyM, mask } = state.dem;
  const inB = (rc) => rc[0] >= 0 && rc[0] < H && rc[1] >= 0 && rc[1] < W;
  const bridges = [];
  let skipped = 0;
  for (const w of ways) {
    const pts = w.latlngs;
    const a = llToCell(pts[0][0], pts[0][1]);
    const z = llToCell(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    if (!inB(a) || !inB(z)) { skipped++; continue; }
    const endA = a[0] * W + a[1], endB = z[0] * W + z[1];
    // Need two distinct abutments with valid ground elevation to span a deck.
    if (endA === endB || !mask[endA] || !mask[endB]) { skipped++; continue; }
    let deckLenM = 0, prev = a;
    for (let i = 1; i < pts.length; i++) {
      const cur = llToCell(pts[i][0], pts[i][1]);
      deckLenM += Math.hypot((cur[0] - prev[0]) * dyM, (cur[1] - prev[1]) * dxM);
      prev = cur;
    }
    if (!(deckLenM > 0)) { skipped++; continue; }
    bridges.push({ latlngs: pts, endA, endB, deckLenM, kind: w.kind, layer: w.layer, name: w.name,
      eleA: Number.isFinite(w.eleA) ? w.eleA : null, eleB: Number.isFinite(w.eleB) ? w.eleB : null });
  }
  if (!bridges.length) {
    status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(sourceLabel)}: no usable bridges/tunnels on this DEM.</span>`;
    return false;
  }
  state.bridges = bridges;
  state.bridgesMeta = { source: sourceLabel, count: bridges.length, skipped };
  updateBridgeMeta();
  applyBridgeOverlay();
  markBridgesDirty(true);
  status.textContent = `${bridges.length} bridge/tunnel deck(s) loaded.`;
  return true;
}

function clearBridges() {
  state.bridges = null;
  state.bridgesMeta = null;
  if (state.bridgesLayer) { state.bridgesLayer.remove(); state.bridgesLayer = null; }
  updateBridgeMeta();
  markBridgesDirty(true);
}

function updateBridgeMeta() {
  const meta = document.getElementById("bridge-meta");
  if (!meta) return;
  if (!state.bridges) { meta.textContent = t("bridge.none"); syncLoadedHighlights(); return; }
  const m = state.bridgesMeta || {};
  let html = t("bridge.meta.count", String(state.bridges.length));
  if (m.skipped) html += `<br/>${t("bridge.meta.skipped", String(m.skipped))}`;
  meta.innerHTML = html;
  syncLoadedHighlights();
}

// Bridges change the RASTER routing (portal edges), so invalidate the compute
// + estimate. They do NOT affect the network-graph (graph mode is portal-blind;
// its bridge handling comes from the network's own tags, not state.bridges), so
// leave the cached graph alone — mirror markImpassableDirty otherwise.
function markBridgesDirty(reprobe = false) {
  cancelActiveCompute();
  state.lastResult = null;
  state.bridgesToken++;
  applyBridgeOverlay();
  if (reprobe && state.dem) {
    state.calibration = null;
    state.calibrationGen++;
    if (state.probeWorker) { state.probeWorker.terminate(); state.probeWorker = null; }
    startCalibrationProbe();
  }
  estimateRunTime();
  syncLoadedHighlights(); // 1D status (loaded/applied) may have changed
}

function bridgeOverlayOpacity() {
  const v = parseFloat(document.getElementById("bridge-opacity")?.value);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.9;
}

// Draw the decks as polylines (bridges orange, tunnels purple) on the network
// pane. Gated on the #bridge-show toggle + a geographic DEM.
function applyBridgeOverlay() {
  if (state.bridgesLayer) { state.bridgesLayer.remove(); state.bridgesLayer = null; }
  const show = !!document.getElementById("bridge-show")?.checked;
  if (!show || !state.dem || !state.dem.isGeographic || !state.bridges) return;
  const op = bridgeOverlayOpacity();
  const group = L.layerGroup();
  for (const br of state.bridges) {
    L.polyline(br.latlngs, {
      color: br.kind === "tunnel" ? "#a26bff" : "#ff7f0e",
      weight: 3, opacity: op, pane: "networkPane", interactive: false,
    }).addTo(group);
  }
  group.addTo(map);
  state.bridgesLayer = group;
}

// Bridges → GeoJSON FeatureCollection (LineStrings, [lon,lat]) for the bundle.
function bridgesToFC(bridges) {
  return {
    type: "FeatureCollection",
    features: bridges.map((br) => ({
      type: "Feature",
      properties: { kind: br.kind, layer: br.layer, name: br.name || null,
        eleA: br.eleA ?? null, eleB: br.eleB ?? null },
      geometry: { type: "LineString", coordinates: br.latlngs.map(([lat, lng]) => [lng, lat]) },
    })),
  };
}

function clearVectorNetwork() {
  cancelActiveCompute(); // in-flight runs are constrained to the old network
  state.networkMask = null;
  state.networkSrsId = null;
  state.networkFeatureCount = 0;
  state.networkLines = null;
  state.networkLinesMeta = null;
  state.networkBridgeCandidates = null;
  if (state.networkLinesLayer) { state.networkLinesLayer.remove(); state.networkLinesLayer = null; }
  state.networkGraph = null; state.networkGraphToken = null;
  removeGraphLayers();
  state.lastGraphResult = null;
  state.graphEnergyRaster = null;
  const meta = document.getElementById("vec-meta");
  if (meta) meta.innerHTML = "No network loaded.";
  const inp = document.getElementById("vector-file");
  if (inp) inp.value = "";
  syncLoadedHighlights(); // group 1B no longer "loaded"
  // Corridors depend on the network — drop them, disable the toggle, recalibrate.
  onNetworkCorridorsChanged();
}

// ---- Optional impassable mask (water bodies, etc.) ------------------------
// Upload a binary GeoTIFF (1=impassable); it's resampled onto the DEM grid by
// area-coverage majority. The loaded vector network can carve bridge corridors
// across it, optionally with a smooth elevation offset. All composition happens
// in buildComputeGrid() — engines unchanged.

// Invalidate everything a loaded mask affects. reprobe re-runs the compute-time
// calibration (only on geometry changes — not on every offset keystroke).
function markImpassableDirty(reprobe = false) {
  cancelActiveCompute();      // an in-flight run used the previous grid
  state.lastResult = null;    // stale render
  state.impassableToken++;    // rebuild the cached network graph (heights/validity changed)
  state.networkGraph = null; state.networkGraphToken = null;
  applyImpassableOverlay();
  if (reprobe && state.dem) {
    state.calibration = null;
    state.calibrationGen++;
    if (state.probeWorker) { state.probeWorker.terminate(); state.probeWorker = null; }
    startCalibrationProbe();
  }
  estimateRunTime();
  syncLoadedHighlights(); // 1C status (loaded/applied) may have changed
}

// ---- OSM water → impassable mask (group 1c) ------------------------------
// Pull water from OSM and rasterise it onto the DEM grid as an impassable mask,
// reusing the uploaded-mask pipeline (applyImpassableRaster → Invert, corridors,
// overlay, bundle — the synthetic raster matches the DEM grid so resampling is
// identity). Impassable = water AREAS (natural=water / waterway=riverbank /
// landuse=reservoir, ways + multipolygon relations) and NON-tunnelled
// waterway=river LINES. Streams (never queried) and tunnelled/culverted rivers
// (filtered client-side) stay passable. OSM coords are lon/lat → geographic DEM
// only (mirrors the OSM bridge/network guards).

// Fractional grid coords [gx, gy] for a lat/lng (cell centres at integer+0.5,
// matching resampleMaskToDem's identity sampling on a grid-matched raster).
function llToGridFrac(lat, lng) {
  const { originX, originY, dx, dy } = state.dem;
  return [(lng - originX) / dx, (originY - lat) / dy];
}

// Even-odd scanline fill of a BODY's rings (each [[gx,gy],…]) into `out`
// (1=impassable). All rings of one body fill together, so inner rings (islands)
// cut holes by crossing parity. Clamped to the body's row span; edges/vertices
// outside the grid still contribute correct crossings (only the marks clip).
function fillRingsEvenOdd(rings, out, W, H) {
  let yMin = Infinity, yMax = -Infinity;
  for (const r of rings) for (const p of r) { if (p[1] < yMin) yMin = p[1]; if (p[1] > yMax) yMax = p[1]; }
  if (!Number.isFinite(yMin)) return;
  const r0 = Math.max(0, Math.floor(yMin)), r1 = Math.min(H - 1, Math.floor(yMax));
  const xs = [];
  for (let ry = r0; ry <= r1; ry++) {
    const yc = ry + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      if (n < 3) continue;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ring[i][1], yj = ring[j][1];
        if ((yi > yc) !== (yj > yc)) xs.push(ring[i][0] + (yc - yi) / (yj - yi) * (ring[j][0] - ring[i][0]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const base = ry * W;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const cA = Math.max(0, Math.ceil(xs[k] - 0.5));
      const cB = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = cA; c <= cB; c++) out[base + c] = 1;
    }
  }
}

// Supercover (4-connected) rasterisation of a polyline — every cell the line
// crosses (Amanatides–Woo), so an 8-connected route can't slip across it.
function rasterPolylineSupercover(pts, out, W, H) {
  const mark = (cx, cy) => { if (cx >= 0 && cx < W && cy >= 0 && cy < H) out[cy * W + cx] = 1; };
  for (let s = 0; s + 1 < pts.length; s++) {
    const x0 = pts[s][0], y0 = pts[s][1], x1 = pts[s + 1][0], y1 = pts[s + 1][1];
    const dX = x1 - x0, dY = y1 - y0;
    let ix = Math.floor(x0), iy = Math.floor(y0);
    const ixe = Math.floor(x1), iye = Math.floor(y1);
    const stepX = dX > 0 ? 1 : (dX < 0 ? -1 : 0);
    const stepY = dY > 0 ? 1 : (dY < 0 ? -1 : 0);
    const tdX = dX !== 0 ? Math.abs(1 / dX) : Infinity;
    const tdY = dY !== 0 ? Math.abs(1 / dY) : Infinity;
    let tmX = dX !== 0 ? ((stepX > 0 ? ix + 1 : ix) - x0) / dX : Infinity;
    let tmY = dY !== 0 ? ((stepY > 0 ? iy + 1 : iy) - y0) / dY : Infinity;
    mark(ix, iy);
    let guard = Math.abs(ixe - ix) + Math.abs(iye - iy) + 4;
    while ((ix !== ixe || iy !== iye) && guard-- > 0) {
      if (tmX < tmY) { tmX += tdX; ix += stepX; } else { tmY += tdY; iy += stepY; }
      mark(ix, iy);
    }
  }
}

// Stitch open polyline segments (relation members) into closed rings by matching
// endpoints. Already-closed members pass through; even-odd fill wraps the rest.
function assembleRings(segments) {
  const tol = 1e-7;
  const near = (a, b) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
  const rings = [], open = [];
  for (const s of segments) {
    if (s.length >= 3 && near(s[0], s[s.length - 1])) rings.push(s);
    else if (s.length >= 2) open.push(s.slice());
  }
  while (open.length) {
    let chain = open.pop();
    let grew = true;
    while (grew && !near(chain[0], chain[chain.length - 1])) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const s = open[i], head = chain[0], tail = chain[chain.length - 1];
        if (near(tail, s[0]))               chain = chain.concat(s.slice(1));
        else if (near(tail, s[s.length - 1])) chain = chain.concat(s.slice().reverse().slice(1));
        else if (near(head, s[s.length - 1])) chain = s.slice(0, -1).concat(chain);
        else if (near(head, s[0]))          chain = s.slice().reverse().slice(0, -1).concat(chain);
        else continue;
        open.splice(i, 1); grew = true; break;
      }
    }
    // Only emit a CLOSED ring — an unclosed leftover (broken/truncated relation,
    // or a member without geometry) is not a valid area boundary; filling it
    // would fabricate a phantom closing edge and over-mark cells.
    if (chain.length >= 3 && near(chain[0], chain[chain.length - 1])) rings.push(chain);
  }
  return rings;
}

// The open sea/ocean is NOT a fillable polygon in OSM — it's implied by
// natural=coastline ways (directed so LAND is on the LEFT, WATER on the RIGHT).
// Real coastline data has open ends and gaps (river mouths, bbox edges), so a
// flood-fill leaks catastrophically. Instead, fill the sea with orientation
// SWEEPS: each crossing SETS the sea/land state on one side from the crossing's
// travel direction. State is SET locally per span (not toggled), so a missing/
// extra crossing corrupts at most one span instead of cascading. A single sweep
// is blind to coast PARALLEL to it (a N–S scanline can't see an E–W beach), so
// we run BOTH a horizontal and a vertical sweep and UNION them — each resolves
// the coast perpendicular to it (H → bays, V → open ocean). The shore is stamped
// impassable too. Pure over grid coords (unit-tested).
function fillSeaFromCoastlines(coastlines, data, W, H) {
  if (!coastlines || !coastlines.length) return 0;
  for (const line of coastlines) rasterPolylineSupercover(line, data, W, H); // shore = impassable edge
  const xs = []; // crossings of the current scan: { p = position along scan, sea = state past it }
  // Horizontal sweep: per ROW, a crossing sets the state to its EAST
  // (north-going coast, grid y decreasing → sea to the east).
  for (let ry = 0; ry < H; ry++) {
    const yc = ry + 0.5;
    xs.length = 0;
    for (const line of coastlines) for (let i = 0; i + 1 < line.length; i++) {
      const y0 = line[i][1], y1 = line[i + 1][1];
      if ((y0 > yc) !== (y1 > yc)) { const x0 = line[i][0], x1 = line[i + 1][0];
        xs.push({ p: x0 + (yc - y0) / (y1 - y0) * (x1 - x0), sea: y1 < y0 }); }
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a.p - b.p);
    const base = ry * W;
    let k = -1;
    for (let c = 0; c < W; c++) {
      const cx = c + 0.5;
      while (k + 1 < xs.length && xs[k + 1].p <= cx) k++;
      if (k >= 0 ? xs[k].sea : !xs[0].sea) data[base + c] = 1;
    }
  }
  // Vertical sweep: per COLUMN, a crossing sets the state to its SOUTH
  // (east-going coast, x increasing → sea to the south).
  for (let cx = 0; cx < W; cx++) {
    const xc = cx + 0.5;
    xs.length = 0;
    for (const line of coastlines) for (let i = 0; i + 1 < line.length; i++) {
      const x0 = line[i][0], x1 = line[i + 1][0];
      if ((x0 > xc) !== (x1 > xc)) { const y0 = line[i][1], y1 = line[i + 1][1];
        xs.push({ p: y0 + (xc - x0) / (x1 - x0) * (y1 - y0), sea: x1 > x0 }); }
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a.p - b.p);
    let k = -1;
    for (let r = 0; r < H; r++) {
      const cy = r + 0.5;
      while (k + 1 < xs.length && xs[k + 1].p <= cy) k++;
      if (k >= 0 ? xs[k].sea : !xs[0].sea) data[r * W + cx] = 1;
    }
  }
  let filled = 0; for (let i = 0, N = W * H; i < N; i++) if (data[i]) filled++;
  return filled;
}

// Whether river LINES count as impassable (the #imp-rivers toggle). Water areas
// and the coastline-derived sea are ALWAYS impassable; only the river-line layer
// is optional. Default true.
function riversImpassable() { return document.getElementById("imp-rivers")?.checked ?? true; }

// (Re)rasterise the cached OSM water geometry onto the DEM grid and feed it to
// the uploaded-mask pipeline. Re-callable so the #imp-rivers toggle re-applies
// without re-querying Overpass. Areas (even-odd fill) + sea (coastline flood)
// always; river lines (supercover) only when the toggle is on.
function rebuildOsmWaterMask() {
  const g = state.osmWaterGeom;
  if (!g || !state.dem || !state.dem.isGeographic) return;
  const { originX, originY, H, W, dx, dy } = state.dem;
  const data = new Uint8Array(W * H);
  for (const b of g.bodies) fillRingsEvenOdd(b.rings, data, W, H);
  if (riversImpassable()) for (const rv of g.rivers) rasterPolylineSupercover(rv, data, W, H);
  fillSeaFromCoastlines(g.coastlines, data, W, H);
  let cells = 0; for (let i = 0; i < data.length; i++) if (data[i]) cells++;
  // OSM water has a fixed polarity (water = impassable), so clear a stale Invert
  // from a prior uploaded raster before applying the canonical mask.
  const inv = document.getElementById("impassable-invert"); if (inv) inv.checked = false;
  const fi = document.getElementById("impassable-file"); if (fi) fi.value = "";
  // Wrap as a DEM-grid raster so the uploaded-mask pipeline consumes it
  // unchanged (resample is identity; Invert/corridors/overlay/bundle reused).
  applyImpassableRaster({ width: W, height: H, data, dx, dy, originX, originY, epsg: 4326 }, "OSM water");
  status.textContent = cells ? t("status.water_done", cells.toLocaleString()) : t("status.water_none");
}

async function loadOsmWater() {
  if (!state.dem) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`; return; }
  if (!state.dem.isGeographic) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.water_geographic")}</span>`; return; }
  const { originX, originY, H, W, dx, dy } = state.dem;
  // Full DEM extent — a mask should cover the whole grid, not just the view.
  const south = originY - H * dy, north = originY, west = originX, east = originX + W * dx;
  const btn = document.getElementById("impassable-osm");
  if (btn) btn.disabled = true;
  progress.classList.add("active");
  progressBar.style.width = "20%";
  status.textContent = t("status.water_querying");
  try {
    const bbox = `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;
    const query = `[out:json][timeout:120];(` +
      `way["natural"="water"](${bbox});relation["natural"="water"](${bbox});` +
      `way["waterway"="riverbank"](${bbox});relation["waterway"="riverbank"](${bbox});` +
      `way["landuse"="reservoir"](${bbox});relation["landuse"="reservoir"](${bbox});` +
      `way["natural"="coastline"](${bbox});` +     // the open sea: directed line, water on the right
      `way["waterway"="river"](${bbox});` +        // streams/canals/ditches intentionally NOT queried
      `);out geom;`;
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (!resp.ok) throw new Error(t("status.overpass_http", resp.status));
    progressBar.style.width = "55%";
    status.textContent = t("status.water_parsing");
    const json = await resp.json();
    const toGrid = (g) => llToGridFrac(g.lat, g.lon);
    const bodies = [];     // area bodies: { rings: [[[gx,gy],…], …] }
    const rivers = [];     // non-tunnelled river polylines: [[[gx,gy],…], …]
    const coastlines = []; // coastline polylines (sea = right side): [[[gx,gy],…], …]
    for (const el of json.elements || []) {
      const tg = el.tags || {};
      if (el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2) {
        if (tg.natural === "coastline") coastlines.push(el.geometry.map(toGrid));
        else if (tg.waterway === "river") { if (!tg.tunnel || tg.tunnel === "no") rivers.push(el.geometry.map(toGrid)); } // tunnelled = passable
        else bodies.push({ rings: [el.geometry.map(toGrid)] }); // closed water-area way (even-odd wraps it)
      } else if (el.type === "relation" && Array.isArray(el.members)) {
        const segs = [];
        for (const m of el.members) if (Array.isArray(m.geometry) && m.geometry.length >= 2) segs.push(m.geometry.map(toGrid));
        if (segs.length) bodies.push({ rings: assembleRings(segs) });
      }
    }
    if (!bodies.length && !rivers.length && !coastlines.length) {
      status.textContent = t("status.water_none"); // a normal "nothing here" result, not an error
      return;
    }
    progressBar.style.width = "75%";
    status.textContent = t("status.water_rasterising", (bodies.length + rivers.length + coastlines.length).toLocaleString());
    await new Promise((r) => setTimeout(r, 0)); // let the status paint before the synchronous rasterise
    state.osmWaterGeom = { bodies, rivers, coastlines }; // cache so the #imp-rivers toggle re-applies without re-querying
    rebuildOsmWaterMask();
    progressBar.style.width = "100%";
  } catch (err) {
    console.error("[osm-water]", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.water_failed", escapeHtml(err.message))}</span>`;
  } finally {
    progress.classList.remove("active");
    if (btn) btn.disabled = false;
  }
}

async function loadImpassableMaskFromFile(file) {
  if (!state.dem) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`; return; }
  const meta = document.getElementById("imp-meta");
  try {
    if (meta) meta.textContent = `Reading ${file.name}…`;
    const buf = await readFileWithProgress(file, () => {});
    const raster = await readMaskGeoTIFF(buf);
    applyImpassableRaster(raster, file.name);
  } catch (err) {
    console.error("[impassable]", err);
    if (meta) meta.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(err.message)}</span>`;
  }
}

// (Re)resample the cached source raster onto the DEM grid with the current
// Invert setting, refresh derived state, and invalidate. Re-callable so the
// Invert toggle doesn't require a re-upload.
function applyImpassableRaster(raster, name) {
  if (!raster || !state.dem) return;
  state.impassableRaster = raster;
  const invert = !!document.getElementById("impassable-invert")?.checked;
  const imp = resampleMaskToDem(raster, state.dem, { invert });
  let cells = 0;
  for (let i = 0; i < imp.length; i++) if (imp[i]) cells++;
  state.impassable = imp;
  state.impassableMeta = {
    name: name ?? state.impassableMeta?.name ?? "mask",
    width: raster.width, height: raster.height, srs: raster.epsg, cellsImpassable: cells,
  };
  recomputeCorridors();
  updateImpassableMeta();
  updateCorridorAvailability();
  markImpassableDirty(true);
  setGroupOpen("bridges-group", true); // mask loaded → next input step
}

function updateImpassableMeta() {
  const meta = document.getElementById("imp-meta");
  if (!meta) return;
  if (!state.impassable) { meta.textContent = t("imp.none"); syncLoadedHighlights(); return; }
  const m = state.impassableMeta || {};
  const N = state.dem ? state.dem.H * state.dem.W : 0;
  const pct = N ? (100 * (m.cellsImpassable || 0) / N).toFixed(1) : "0";
  const corr = state.corridorCells ? state.corridorCells.length : 0;
  let html = `${escapeHtml(m.name || "mask")} · ` +
    t("imp.meta.cells", (m.cellsImpassable || 0).toLocaleString(), pct);
  if (corr) html += `<br/>${t("imp.meta.corridor", corr.toLocaleString())}`;
  meta.innerHTML = html;
  syncLoadedHighlights();
}

function clearImpassableMask() {
  state.impassable = null;
  state.impassableRaster = null;
  state.impassableMeta = null;
  state.corridorCells = null; state.corridorBase = null; state.corridorRamp = null;
  state.corridorSet = null;
  state.osmWaterGeom = null; // forget the cached OSM water geometry too
  const inp = document.getElementById("impassable-file");
  if (inp) inp.value = "";
  updateImpassableMeta();
  updateCorridorAvailability();
  markImpassableDirty(true);
}

// Enable the "carve corridors" toggle only when a network is loaded.
function updateCorridorAvailability() {
  const cb = document.getElementById("imp-corridor");
  const row = document.getElementById("imp-corridor-row");
  const hasNet = !!state.networkMask;
  if (cb) cb.disabled = !hasNet;
  if (row) row.style.opacity = hasNet ? "1" : "0.55";
}

// A network load/clear can add/remove bridge corridors, changing the effective
// compute grid. Recompute them, refresh the toggle, and — when a mask is present
// so the grid actually changed — fully invalidate (overlay + graph token +
// recalibration + estimate) via markImpassableDirty, exactly like a mask change.
// Enable the "extract bridges from loaded network" button only when the loaded
// network actually carries bridge/tunnel-tagged ways.
function updateBridgeNetworkButton() {
  const btn = document.getElementById("bridge-from-network");
  if (btn) btn.disabled = !(state.networkBridgeCandidates && state.networkBridgeCandidates.length);
}

function onNetworkCorridorsChanged() {
  recomputeCorridors();
  updateCorridorAvailability();
  updateBridgeNetworkButton();
  if (state.impassable) {
    markImpassableDirty(true); // overlay + token bump + graph invalidation + reprobe + estimate
  } else {
    applyImpassableOverlay();
    state.impassableToken++;
  }
}

// ---- Optional vector-network rendering (black lines, fixed ground width) --
// Leaflet polyline weights are in CSS pixels, so a fixed ground width needs
// a per-zoom conversion: metres per CSS pixel in Web Mercator at zoom z is
// 156543.03 · cos(lat) / 2^z. Re-applied on zoomend and on width/opacity
// input changes (live setStyle on the existing layers — no rebuild).

function networkLineWidthM() {
  const v = parseFloat(document.getElementById("vec-render-width")?.value);
  return Number.isFinite(v) && v > 0 ? v : 4;
}

function networkLineOpacity() {
  const v = parseFloat(document.getElementById("vec-render-opacity")?.value);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

function networkLineWeightPx() {
  const zoom = map.getZoom();
  const lat = map.getCenter().lat;
  const mPerPx = 156543.03392 * Math.abs(Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  // Floor at 0.75 px so the network stays visible when zoomed far out.
  return Math.max(0.75, networkLineWidthM() / mPerPx);
}

function applyNetworkLinesOverlay() {
  if (state.networkLinesLayer) { state.networkLinesLayer.remove(); state.networkLinesLayer = null; }
  const on = !!document.getElementById("vec-render")?.checked;
  if (!on) return;
  if (!state.networkLines || !state.networkLines.length) {
    if (state.networkMask) {
      // Mask exists but geometry wasn't kept (over the vertex cap).
      status.textContent = t("status.net_too_large");
    }
    return;
  }
  // One shared canvas renderer — thousands of SVG paths would crawl.
  const renderer = L.canvas({ padding: 0.3, pane: "networkPane" });
  const weight = networkLineWeightPx();
  const opacity = networkLineOpacity();
  const group = L.layerGroup();
  for (const line of state.networkLines) {
    group.addLayer(L.polyline(line, {
      color: "#000",
      weight,
      opacity,
      interactive: false,
      renderer,
    }));
  }
  group.addTo(map);
  state.networkLinesLayer = group;
}

function updateNetworkLineStyle() {
  if (!state.networkLinesLayer) return;
  const weight = networkLineWeightPx();
  const opacity = networkLineOpacity();
  state.networkLinesLayer.eachLayer((l) => l.setStyle({ weight, opacity }));
}

map.on("zoomend", updateNetworkLineStyle);

// Whether the loaded network actually constrains the NEXT compute. The
// "Constrain compute to network" checkbox lets a network stay loaded —
// e.g. for the vector line rendering — without restricting the search
// graph (or snapping clicks, or gating src/dst).
function networkConstraintActive() {
  return !!state.networkMask && (document.getElementById("vec-constrain")?.checked ?? true);
}

// Snap a (row, col) pixel to the nearest network cell. Expanding-ring
// search with NO hard cutoff (capped only by the grid): the old version
// gave up at the snap-radius input, which on sparse networks turned every
// map click into a rejection — src never set, Compute permanently
// disabled. The radius input is now the "silent zone": snaps within it
// are quiet, snaps beyond it work too but the caller can tell the user
// how far the point moved (see snapToNetwork.lastDistance).
// Returns the original RC when the network is off / not constraining /
// genuinely empty.
function snapToNetwork(rc) {
  snapToNetwork.lastDistance = 0;
  if (!networkConstraintActive() || !state.dem) return rc;
  const [r, c] = rc;
  const { W, H, mask } = state.dem;
  if (r < 0 || r >= H || c < 0 || c >= W) return rc;
  if (state.networkMask[r * W + c]) return rc;
  const net = state.networkMask;
  const maxRing = Math.max(H, W);
  for (let ring = 1; ring <= maxRing; ring++) {
    let bestD2 = Infinity, bestRC = null;
    // Walk the square ring at Chebyshev distance `ring`. The first ring
    // containing network cells holds the Euclidean nearest among rings
    // ≤ ring+1; checking one extra ring after a hit keeps it exact enough
    // for snapping purposes (cells, not metres).
    const scanRing = (rg) => {
      for (let dc = -rg; dc <= rg; dc++) {
        for (const dr of (Math.abs(dc) === rg
          ? Array.from({ length: 2 * rg + 1 }, (_, k) => k - rg)
          : [-rg, rg])) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
          const i = rr * W + cc;
          if (net[i] && mask[i]) {
            const d2 = dr * dr + dc * dc;
            if (d2 < bestD2) { bestD2 = d2; bestRC = [rr, cc]; }
          }
        }
      }
    };
    scanRing(ring);
    if (bestRC) {
      scanRing(Math.min(maxRing, ring + 1));
      snapToNetwork.lastDistance = Math.sqrt(bestD2);
      return bestRC;
    }
  }
  return rc; // empty network — caller handles the message
}

// ------- Map clicks: set points -------
// Convert lat/lon to DEM pixel coords. For a UTM DEM this needs proj4; for
// the prototype we accept WGS84 DEMs OR provide a small UTM helper.
// The cleanest demo path is to show the DEM extent on the map in its native
// units. To keep dependencies minimal, the prototype assumes DEMs in EPSG:4326.
// Production: pull in proj4 and parse the GeoKeys to get the source CRS.

function latLngToPixel(latlng) {
  if (!state.dem) return null;
  const { originX, originY, dx, dy, W, H, isGeographic } = state.dem;
  // For a geographic DEM (lon = x, lat = y):
  if (isGeographic) {
    const col = Math.floor((latlng.lng - originX) / dx);
    const row = Math.floor((originY - latlng.lat) / dy);
    if (row < 0 || row >= H || col < 0 || col >= W) return null;
    return [row, col];
  }
  // For UTM DEMs we'd need proj4 here. As a fallback, treat the click
  // as if it were in the DEM's native units (only useful for testing
  // against a small DEM you've manually situated).
  return null;
}

function pixelToLatLng(r, c) {
  if (!state.dem) return null;
  const { originX, originY, dx, dy, isGeographic } = state.dem;
  if (isGeographic) {
    return L.latLng(originY - (r + 0.5) * dy, originX + (c + 0.5) * dx);
  }
  return null;
}

// ------- "Follow the vectors" graph mode -------
// Routing on the real polyline graph (graph-engine.js) instead of the raster
// mask, so passes trace the vectors with no staircase. Geometry round-trips
// through FRACTIONAL cell space: lat/lng → (r,c) for the engine, (r,c) → lat/lng
// for rendering. Gated to geographic DEMs (the same constraint as map clicks).
function latLngToCellFrac(lat, lng) {
  const { originX, originY, dx, dy } = state.dem;
  return [(originY - lat) / dy, (lng - originX) / dx];
}
function cellFracToLatLng(r, c) {
  const { originX, originY, dx, dy } = state.dem;
  return L.latLng(originY - r * dy, originX + c * dx);
}
function networkLinesToCellLines() {
  // state.networkLines = [[ [lat,lng], … ], … ] → fractional [r,c] polylines.
  return state.networkLines.map((ln) => ln.map(([lat, lng]) => latLngToCellFrac(lat, lng)));
}
function graphJunctionMode() {
  return document.getElementById("vec-junction-mode")?.value === "shared" ? "shared" : "crossings";
}
// Graph mode is usable only with a vector network whose geometry was kept and a
// geographic DEM. The toggle lives in the network panel.
function graphModeActive() {
  return !!document.getElementById("vec-graph-mode")?.checked
    && !!state.networkLines && state.networkLines.length > 0
    && !!state.dem && state.dem.isGeographic;
}
// Graph mode ("follow the vectors") is a SEPARATE engine that computes on the
// network graph. The compute is INHERENTLY constrained to the network, so the
// raster "Constrain compute to network" toggle is forced ON and locked while
// graph mode is checked (its precedence is visible, not silently ignored).
// "Compare with unconstrained" STAYS togglable: graph mode now honours it,
// running a full-DEM unconstrained raster scenario alongside the graph compute
// and exposing the difference through the displayed-scenario picker (see
// startGraphCompute). The checkbox is persisted, so it can be on from a prior
// session; a synthetic change after restore re-runs this.
function syncGraphModeUI() {
  const graph = !!document.getElementById("vec-graph-mode")?.checked;
  // Constrain: forced ON + locked in graph mode (compute is always on the net).
  // Remember the user's prior choice in a data attribute and RESTORE it when they
  // leave graph mode — entering graph mode shouldn't silently flip "constrain" on
  // for good. Only snapshot on the first entry (repeated calls while graph is on
  // must not overwrite the snapshot with the now-forced value).
  const con = document.getElementById("vec-constrain");
  if (con) {
    if (graph) {
      if (con.dataset.preGraph === undefined) con.dataset.preGraph = con.checked ? "1" : "0";
      con.checked = true;
    } else if (con.dataset.preGraph !== undefined) {
      con.checked = con.dataset.preGraph === "1";
      delete con.dataset.preGraph;
    }
    con.disabled = graph;
    const row = con.closest("label");
    if (row) {
      row.style.opacity = graph ? "0.6" : "";
      row.title = graph ? t("net.graph_constrain_locked") : "";
    }
  }
  // Compare: stays available — graph mode does run the comparison now.
  const cmp = document.getElementById("vec-compare");
  if (cmp) {
    cmp.disabled = false;
    const row = cmp.closest("label");
    if (row) { row.style.opacity = ""; row.title = ""; }
  }
}
// Identity of everything the cached graph depends on — a change rebuilds it.
function computeNetworkGraphToken() {
  return `${state.networkFeatureCount}|${graphJunctionMode()}|${state.dem ? state.dem.W + "x" + state.dem.H : "0"}|imp${state.impassableToken}`;
}

// Draw a path/route (sequence of node ids) as a polyline over the edges.
function drawGraphPath(graph, p, colour, group) {
  if (!p || !p.nodes || !p.nodes.length) return;
  const pts = p.nodes.map((n) => cellFracToLatLng(graph.nodeR[n], graph.nodeC[n]));
  group.addLayer(L.polyline(pts, { color: colour, weight: 4, opacity: 0.95, pane: "routesPane", interactive: false }));
}

// Render the cached graph result as a colored-vector overlay. Reads the style
// knobs LIVE so colormap/range/gamma changes recolor without recomputing.
// Rasterise the graph's per-node energy onto the DEM grid (network cells only),
// stamping each edge's lerped endpoint energy along its cells with the network
// line width. Returns a Float32Array (Infinity off-network) to feed the IDW
// interp, or null if there's no energy. Invalid (off-extent) edges are skipped.
function rasterizeGraphEnergy(graph, result) {
  if (!state.dem || !result.nodeEnergy) return null;
  const { H, W, mask } = state.dem;
  const lineWidth = Math.max(1, parseInt(document.getElementById("vec-width")?.value, 10) || 1);
  const halfWidth = (lineWidth - 1) >> 1;
  const eGrid = new Float32Array(H * W).fill(Infinity);
  let any = false;
  for (let e = 0; e < graph.nEdges; e++) {
    const a = graph.edgeA[e], b = graph.edgeB[e];
    if (graph.nodeValid && (!graph.nodeValid[a] || !graph.nodeValid[b])) continue;
    const eA = result.nodeEnergy[a], eB = result.nodeEnergy[b];
    const fA = Number.isFinite(eA), fB = Number.isFinite(eB);
    if (!fA && !fB) continue;
    const r0 = graph.nodeR[a], c0 = graph.nodeC[a], r1 = graph.nodeR[b], c1 = graph.nodeC[b];
    const steps = Math.max(1, Math.ceil(Math.hypot(r1 - r0, c1 - c0)));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const rr = Math.round(r0 + (r1 - r0) * f), cc = Math.round(c0 + (c1 - c0) * f);
      const ev = (fA ? eA : eB) * (1 - f) + (fB ? eB : eA) * f;
      for (let pdr = -halfWidth; pdr <= halfWidth; pdr++) {
        const rrr = rr + pdr; if (rrr < 0 || rrr >= H) continue;
        for (let pdc = -halfWidth; pdc <= halfWidth; pdc++) {
          const ccc = cc + pdc; if (ccc < 0 || ccc >= W) continue;
          const idx = rrr * W + ccc;
          if (!mask[idx]) continue;
          if (ev < eGrid[idx]) eGrid[idx] = ev;
          any = true;
        }
      }
    }
  }
  return any ? eGrid : null;
}

// Remove all graph-mode layers and reset the pane opacities (the raster
// overlays assume the panes sit at opacity 1 and set their own element opacity).
function removeGraphLayers() {
  for (const k of ["graphEnergyLayer", "graphPassesLayer", "graphRoutesLayer"]) {
    if (state[k]) { state[k].remove(); state[k] = null; }
  }
  const ep = map.getPane("energyPane"), pp = map.getPane("passesPane");
  if (ep) ep.style.opacity = "";
  if (pp) { pp.style.opacity = ""; pp.style.mixBlendMode = ""; }
}

// Build one colored-polyline-per-edge vector layer for a per-edge field.
// greyscale matches the raster passes layer; colormap matches the energy layer.
// Returns a layerGroup with `_range = [lo, hi]` for the legend.
function buildGraphFieldLayer(graph, field, { pane, greyscale, minId, maxId, percentiles, skipZero }) {
  // Collect drawable values. skipZero mirrors the raster's treatZeroAsTransparent:
  // zero / unreached edges DON'T draw, so the result reads as corridors instead
  // of a full-network outline. Percentile bounds tame the long passes tail.
  const vals = [];
  for (let e = 0; e < graph.nEdges; e++) {
    const v = field[e];
    if (!Number.isFinite(v)) continue;
    if (skipZero && v <= 0) continue;
    vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const pAt = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor((p / 100) * (vals.length - 1))))];
  let lo = pAt(percentiles[0]), hi = pAt(percentiles[1]);
  const uMin = readRangeInput(minId, null), uMax = readRangeInput(maxId, null);
  if (uMin != null) lo = uMin;
  if (uMax != null) hi = uMax;
  const span = hi > lo ? hi - lo : 1;
  const gamma = Math.max(0.05, parseFloat(document.getElementById("passes-gamma")?.value) || 1);
  const weight = Math.max(1.5, networkLineWeightPx());
  const renderer = L.canvas({ padding: 0.3, pane });
  const group = L.layerGroup();
  for (let e = 0; e < graph.nEdges; e++) {
    const v = field[e];
    if (!Number.isFinite(v)) continue;
    if (skipZero && v <= 0) continue;
    let t = (v - lo) / span; t = t < 0 ? 0 : (t > 1 ? 1 : t);
    t = Math.pow(t, gamma);
    let col;
    if (greyscale) { const g = Math.round(t * 255); col = `rgb(${g},${g},${g})`; }
    else { const [cr, cg, cb] = colormap(t); col = `rgb(${cr},${cg},${cb})`; }
    const a = graph.edgeA[e], b = graph.edgeB[e];
    group.addLayer(L.polyline(
      [cellFracToLatLng(graph.nodeR[a], graph.nodeC[a]), cellFracToLatLng(graph.nodeR[b], graph.nodeC[b])],
      { color: col, weight, opacity: 1, interactive: false, renderer },
    ));
  }
  group._range = [lo, hi];
  return group;
}

// Render the cached graph result as a pane-integrated vector layer driven by the
// existing visibility/opacity controls, plus a routes/path layer. Passes (the
// "follow the vectors" corridors) is the primary result; energy is shown ONLY
// when there are no passes (an energy-only from/to) — otherwise colouring every
// reached edge just restates the network, which the user already toggles via
// "Draw network". Reads style knobs live → recolours on restyle, no recompute.
function renderGraphOverlay() {
  if (!state.lastGraphResult || !state.dem) return;
  const { graph, result, energyAlt } = state.lastGraphResult;
  const { W, H } = state.dem;
  if (state.passesOverlay) { state.passesOverlay.remove(); state.passesOverlay = null; }
  removeGraphLayers();

  // The displayed-scenario picker only makes sense after a graph-mode COMPARE run.
  const srcRow = document.getElementById("energy-source-row");
  if (srcRow) srcRow.style.display = energyAlt ? "" : "none";
  const energySel = energyAlt
    ? (document.getElementById("energy-source")?.value || "constrained")
    : "constrained";

  // Energy: interpolated RASTER (built in finishGraph), shown through the same
  // energy imageOverlay grid mode uses → the Energy visibility/opacity/colormap
  // controls drive it, and it reads as a smooth field, not a network outline.
  // In a compare run the picker swaps the raster: the graph (constrained) field,
  // the full-DEM unconstrained field, or their difference.
  if (state.energyOverlay) { state.energyOverlay.remove(); state.energyOverlay = null; }
  const energyField = (energyAlt && energySel === "unconstrained" && energyAlt.unconstrained)
    ? energyAlt.unconstrained
    : (energyAlt && energySel === "difference" && energyAlt.difference)
      ? energyAlt.difference
      : state.graphEnergyRaster;
  if (energyField) {
    const out = renderFieldToDataURL(energyField, W, H, {
      usePercentileBounds: true, percentiles: [1, 80],
      userMin: readRangeInput("vmin", null), userMax: readRangeInput("vmax", null),
      useGreyscale: false, treatZeroAsTransparent: false,
    });
    state.energyDataUrl = out.url;
    state.lastAutoMin = out.lo; state.lastAutoMax = out.hi;
    applyEnergyOverlay();
  } else {
    state.energyDataUrl = null;
  }

  // Passes: vector corridors (the "follow the vectors" result), when density or
  // "want passes" is on (mirrors the grid, where passes renders only if computed).
  const passesWanted = !!document.getElementById("want-density")?.checked || !!document.getElementById("want-passes")?.checked;
  const hasPasses = passesWanted && result.edgePasses && result.edgePasses.some((v) => v > 0);
  if (hasPasses) {
    state.graphPassesLayer = buildGraphFieldLayer(graph, result.edgePasses, { pane: "passesPane", greyscale: true, minId: "passes-vmin", maxId: "passes-vmax", percentiles: [10, 90], skipZero: true });
    if (state.graphPassesLayer) {
      state.graphPassesLayer.addTo(map);
      state.lastPassesAutoMin = state.graphPassesLayer._range[0];
      state.lastPassesAutoMax = state.graphPassesLayer._range[1];
    }
  }
  const routesGroup = L.layerGroup();
  if (result.routes && result.routes.length) {
    for (let i = 0; i < result.routes.length; i++) drawGraphPath(graph, result.routes[i], routeColour(i, result.routes.length), routesGroup);
  } else if (result.path) {
    drawGraphPath(graph, result.path, "#4cc9f0", routesGroup);
  }
  routesGroup.addTo(map);
  state.graphRoutesLayer = routesGroup;

  const passesRow = document.getElementById("passes-row");
  if (passesRow) passesRow.style.display = hasPasses ? "" : "none";
  const passesVisRow = document.getElementById("passes-vis-row"); // modal vis/opacity row
  if (passesVisRow) passesVisRow.style.display = hasPasses ? "" : "none";

  applyLayerControls();   // drive visibility + opacity from the Energy/Passes controls
  updateLegendTicks();
  applyColormapToLegend();
}

map.on("click", (e) => {
  if (!state.dem) {
    status.textContent = t("status.load_dem_first");
    return;
  }
  const rawPx = latLngToPixel(e.latlng);
  if (!rawPx) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.click_outside")}</span>`;
    return;
  }
  // When a vector network is loaded, click points are snapped to the
  // nearest passable network cell within the configured radius.
  const px = snapToNetwork(rawPx);
  const [r, c] = px;
  const clickIdx = r * state.dem.W + c;
  if (!state.dem.mask[clickIdx]) {
    status.textContent = t("status.click_nodata");
    return;
  }
  if (!effectivePassableAt(clickIdx)) {
    // Impassable (barrier mask) and not reopened as a bridge corridor — the
    // compute would silently never seed/settle here.
    status.textContent = t("imp.cell_blocked");
    return;
  }
  if (networkConstraintActive() && !state.networkMask[r * state.dem.W + c]) {
    // Snap searches the whole grid now, so this only fires when the network
    // rasterised to zero usable cells (CRS/geometry mismatch with the DEM).
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.net_no_snap_click")}</span>`;
    return;
  }
  // Density mode: clicks add reference points ("click" placement) or do
  // nothing ("random" placement). They must never fall through to the
  // src/dst branch below — density runs ignore src/dst, so a silently-set
  // source marker would contradict the "— density —" displays and leak a
  // stale seed into the compute message.
  const densityOn = !!document.getElementById("want-density")?.checked;
  if (densityOn) {
    const densityClick = (document.getElementById("ref-source")?.value || "click") === "click";
    if (densityClick) {
      addRefPoint([r, c]);
    } else {
      status.textContent = t("status.ref_random_mode");
    }
    return;
  }
  if (!state.src) {
    state.src = px;
    if (state.srcMarker) state.srcMarker.remove();
    state.srcMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("src") })
      .addTo(map).bindTooltip("Source");
    document.getElementById("src-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("src-display").classList.add("set");
    status.textContent = t("status.src_set");
    updateRunButtonState();
  } else if (!state.dst) {
    state.dst = px;
    if (state.dstMarker) state.dstMarker.remove();
    state.dstMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("dst") })
      .addTo(map).bindTooltip("Destination");
    document.getElementById("dst-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("dst-display").classList.add("set");
    status.textContent = t("status.both_set");
    updateRunButtonState(); // refresh 3B status (now src + dst → green)
  } else {
    // Reset and start over
    state.src = px;
    state.dst = null;
    if (state.srcMarker) state.srcMarker.remove();
    if (state.dstMarker) state.dstMarker.remove();
    state.srcMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("src") })
      .addTo(map).bindTooltip("Source");
    state.dstMarker = null;
    document.getElementById("src-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("dst-display").textContent = "— click again —";
    document.getElementById("dst-display").classList.remove("set");
    status.textContent = t("status.src_replaced");
    updateRunButtonState(); // refresh 3B status (src only → orange)
  }
});

document.getElementById("clear-points").addEventListener("click", () => {
  state.src = null;
  state.dst = null;
  if (state.srcMarker) { state.srcMarker.remove(); state.srcMarker = null; }
  if (state.dstMarker) { state.dstMarker.remove(); state.dstMarker = null; }
  if (state.pathLine) { state.pathLine.remove(); state.pathLine = null; }
  document.getElementById("src-display").textContent = "— click map —";
  document.getElementById("dst-display").textContent = "— optional —";
  document.getElementById("src-display").classList.remove("set");
  document.getElementById("dst-display").classList.remove("set");
  updateRunButtonState();
});

// ------- Marker icons -------
// Source / destination / reference points all share a white-disc-with-
// black-border style. Tiny label text inside (`src` / `dst` / a 1-based
// order number for refs).
function makeLabelIcon(label, size, fontSize) {
  const html = `<div style="
    width:${size}px;height:${size}px;
    background:#fff;border:2px solid #000;border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    font-family:ui-monospace,monospace;font-weight:700;color:#000;
    font-size:${fontSize}px;line-height:1;box-sizing:border-box;
    white-space:nowrap;
  ">${label}</div>`;
  return L.divIcon({
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    className: "",
  });
}
const ICON_SRCDST_SIZE = 28, ICON_SRCDST_FONT = 9;
const ICON_REF_SIZE    = 20, ICON_REF_FONT    = 10;
const makeSrcDstIcon = (label) => makeLabelIcon(label, ICON_SRCDST_SIZE, ICON_SRCDST_FONT);
const makeRefIcon    = (idx)   => makeLabelIcon(String(idx), ICON_REF_SIZE, ICON_REF_FONT);

// ------- Multi-reference density helpers -------
// FIFO buffer: state.refPoints / state.refMarkers are kept in arrival order.
// Once the population exceeds the `N references` cap, the oldest entries are
// dropped from the front. Applies to single clicks AND to "Place random".
function addRefPoint(rc) {
  if (!state.dem) return;
  const [r, c] = rc;
  if (!effectivePassableAt(r * state.dem.W + c)) return; // nodata or blocked (barrier mask)
  state.refPoints.push([r, c]);
  const { originX, originY, dx, dy } = state.dem;
  const latlng = L.latLng(originY - (r + 0.5) * dy, originX + (c + 0.5) * dx);
  const idx = state.refPoints.length;
  const m = L.marker(latlng, { icon: makeRefIcon(idx) })
    .bindTooltip(`ref ${idx} · r=${r}, c=${c}`);
  // Respect the visibility toggle: a marker added while refs are hidden stays
  // off the map until the toggle re-adds it (applyLayerControls).
  if (document.getElementById("refs-visible")?.checked ?? true) m.addTo(map);
  state.refMarkers.push(m);
  enforceRefCap();
  syncRefDisplay();
}

function enforceRefCap() {
  const cap = Math.max(1, parseInt(document.getElementById("n-refs")?.value, 10) || 10);
  while (state.refPoints.length > cap) {
    state.refPoints.shift();
    const oldest = state.refMarkers.shift();
    if (oldest) oldest.remove();
  }
  // After a FIFO trim the surviving refs need their numbered icons
  // refreshed so what's drawn matches the (now reset) order.
  for (let i = 0; i < state.refMarkers.length; i++) {
    const marker = state.refMarkers[i];
    const [r, c] = state.refPoints[i];
    marker.setIcon(makeRefIcon(i + 1));
    marker.unbindTooltip().bindTooltip(`ref ${i + 1} · r=${r}, c=${c}`);
  }
}

function clearRefPoints() {
  for (const m of state.refMarkers) m.remove();
  state.refMarkers = [];
  state.refPoints = [];
  state.qmcIndex = 0;
  syncRefDisplay();
}

// ---- Quasi-Monte-Carlo point sets for reference placement ----------------
// Low-discrepancy sequences cover the DEM evenly (no clumps/gaps), so the
// density field converges with fewer reference points than pseudo-random
// placement. Both generators are indexed (stateless given i), and the app
// keeps a persistent counter (state.qmcIndex) so successive "Place random"
// clicks CONTINUE the sequence — re-starting at i=0 every click would drop
// the same points on top of the previous batch.

// Bit-reversal of a u32 = van der Corput base-2 radical inverse, which is
// both the Halton base-2 axis and Sobol dimension 1.
function bitReverse32(x) {
  x = ((x & 0x55555555) << 1) | ((x >>> 1) & 0x55555555);
  x = ((x & 0x33333333) << 2) | ((x >>> 2) & 0x33333333);
  x = ((x & 0x0f0f0f0f) << 4) | ((x >>> 4) & 0x0f0f0f0f);
  x = ((x & 0x00ff00ff) << 8) | ((x >>> 8) & 0x00ff00ff);
  return ((x << 16) | (x >>> 16)) >>> 0;
}

// Sobol dimension-2 direction numbers (primitive polynomial x²+x+1; the
// recurrence reproduces the canonical m = 1, 3, 5, 15, 17, … table).
const SOBOL_DIM2_V = (() => {
  const v = new Uint32Array(32);
  v[0] = 0x80000000;
  for (let j = 1; j < 32; j++) v[j] = (v[j - 1] ^ (v[j - 1] >>> 1)) >>> 0;
  return v;
})();

// i-th 2-D Sobol point, i ≥ 1 (i = 0 is the degenerate (0,0) corner).
// First points: (.5,.5) (.25,.75) (.75,.25) (.125,.625) …
function sobolPoint2D(i) {
  const u = bitReverse32(i >>> 0) / 2 ** 32;
  let x = 0;
  for (let j = 0; j < 32; j++) {
    if ((i >>> j) & 1) x = (x ^ SOBOL_DIM2_V[j]) >>> 0;
  }
  return [u, x / 2 ** 32];
}

// i-th 2-D Halton point (bases 2 and 3), i ≥ 1.
function haltonPoint2D(i) {
  const u = bitReverse32(i >>> 0) / 2 ** 32;
  let v = 0, f = 1 / 3, k = i;
  while (k > 0) {
    v += (k % 3) * f;
    k = (k / 3) | 0;
    f /= 3;
  }
  return [u, v];
}

function placeRandomRefPoints(n) {
  if (!state.dem) return;
  const { mask, H, W } = state.dem;
  // Reservoir of valid cell indices is too big to enumerate for huge DEMs;
  // rejection sampling is fine for typical mask densities (~99% valid) and
  // preserves the QMC sequences' even coverage over the masked subset.
  const want = Math.max(1, Math.min(2000, n | 0));
  const sampling = document.getElementById("ref-sampling")?.value || "random";
  // "census" is population-weighted and runs an async cloud query (FlatGeobuf
  // over the DEM bbox); fork to it and leave the QMC/random paths synchronous.
  if (sampling === "census") { placeCensusRefPoints(want); return; }
  const nextUV =
    sampling === "sobol"  ? () => sobolPoint2D(++state.qmcIndex) :
    sampling === "halton" ? () => haltonPoint2D(++state.qmcIndex) :
    () => [Math.random(), Math.random()];
  let attempts = 0;
  const cap = want * 200;
  const placed = [];
  const seen = new Set();
  // With a constraining network, snap each sample to its nearest network
  // cell (grid-wide) — sampling the raw mask and rejecting would need
  // ~1/density attempts on sparse networks, and compute-time snapping
  // would silently move the points anyway. Snapped samples can collide,
  // hence the dedupe.
  const constrained = networkConstraintActive();
  while (placed.length < want && attempts++ < cap) {
    const [u, v] = nextUV();
    let r = (v * H) | 0;
    let c = (u * W) | 0;
    if (!mask[r * W + c]) continue;
    if (constrained) {
      [r, c] = snapToNetwork([r, c]);
      if (!state.networkMask[r * W + c]) continue; // empty network
    }
    const key = r * W + c;
    if (seen.has(key)) continue;
    seen.add(key);
    placed.push([r, c]);
  }
  for (const rc of placed) addRefPoint(rc);
}

// ---- Census (IBGE 2022) population-weighted reference sampling ------------
// A live, in-browser port of census/sample_census.py. Instead of spreading
// references uniformly, it samples them by where people actually live: fetch
// the census setores intersecting the DEM bbox from a cloud FlatGeobuf (HTTP
// Range queries — only the bbox slice transfers, not the ~450 MB national
// file), weight each setor by pop·(area clipped to the DEM / full area), pick
// setores by a 1-D Sobol inverse-CDF, and drop each point inside its setor
// with a 2-D Sobol rejection draw. Brazil-only; needs the network. Structural
// parity with the Python (NOT bit-parity — there's no harness pairing them).
const CENSUS_FGB_URL =
  "https://storage.googleapis.com/telhas/simujoules/census/setores_br_pop.fgb";
// Built + uploaded out-of-band by census/build_fgb.py — it lives in the cloud
// bucket, NOT in the deployed app bundle (deploy.sh never stages census/).
// Coarse Brazil bbox: skip the (multi-MB) index walk for DEMs that can't
// possibly intersect the national census coverage.
const BRAZIL_BBOX = { xmin: -74.5, ymin: -34.5, xmax: -28.5, ymax: 6.0 };

// 1-D Sobol / van der Corput scalar in [0,1) — the first axis of sobolPoint2D.
function sobolScalar1D(i) { return bitReverse32(i >>> 0) / 2 ** 32; }

// Ray-cast (even-odd) point-in-ring test; ring = [[lng,lat], …].
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) &&
        (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// A polygon is [outerRing, hole1, …]: inside the outer ring and outside holes.
function pointInPolygon(x, y, rings) {
  if (!rings.length || !pointInRing(x, y, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) if (pointInRing(x, y, rings[h])) return false;
  return true;
}

// Shoelace ring area (abs; works on open or closed rings). lon/lat units — we
// only ever use the clipped/full RATIO, which is valid in any consistent CRS.
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}
function polyArea(rings) {        // outer − holes
  let a = rings.length ? ringArea(rings[0]) : 0;
  for (let h = 1; h < rings.length; h++) a -= ringArea(rings[h]);
  return Math.max(0, a);
}

// Sutherland–Hodgman clip of a ring against the axis-aligned DEM bbox; returns
// the clipped vertex list (possibly empty). Used only for the area ratio.
function clipRingToBbox(ring, bb) {
  let poly = ring;
  if (poly.length > 1) {         // drop the duplicate closing vertex if present
    const a = poly[0], b = poly[poly.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) poly = poly.slice(0, -1);
  }
  const ix = (p, q, x) => { const t = (x - p[0]) / (q[0] - p[0]); return [x, p[1] + t * (q[1] - p[1])]; };
  const iy = (p, q, y) => { const t = (y - p[1]) / (q[1] - p[1]); return [p[0] + t * (q[0] - p[0]), y]; };
  const clip = (pts, inside, cut) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(cut(prev, cur)); out.push(cur); }
      else if (pi) out.push(cut(prev, cur));
    }
    return out;
  };
  poly = clip(poly, (p) => p[0] >= bb.xmin, (p, q) => ix(p, q, bb.xmin)); if (!poly.length) return poly;
  poly = clip(poly, (p) => p[0] <= bb.xmax, (p, q) => ix(p, q, bb.xmax)); if (!poly.length) return poly;
  poly = clip(poly, (p) => p[1] >= bb.ymin, (p, q) => iy(p, q, bb.ymin)); if (!poly.length) return poly;
  poly = clip(poly, (p) => p[1] <= bb.ymax, (p, q) => iy(p, q, bb.ymax));
  return poly;
}
function clippedPolyArea(rings, bb) {
  if (!rings.length) return 0;
  let a = ringArea(clipRingToBbox(rings[0], bb));
  for (let h = 1; h < rings.length; h++) a -= ringArea(clipRingToBbox(rings[h], bb));
  return Math.max(0, a);
}

// Place `want` references sampled from census population over the DEM bbox.
// Async + detached from placeRandomRefPoints (the sync QMC paths are unchanged).
async function placeCensusRefPoints(want) {
  const fail = (key, ...a) =>
    void (status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t(key, ...a))}</span>`);
  if (!state.dem) return fail("census.no_dem");
  if (!state.dem.isGeographic) return fail("census.geographic");
  if (typeof flatgeobuf === "undefined") return fail("census.lib_missing");
  const bb = state.dem.bbox;     // {xmin,ymin,xmax,ymax} lon/lat
  if (bb.xmax < BRAZIL_BBOX.xmin || bb.xmin > BRAZIL_BBOX.xmax ||
      bb.ymax < BRAZIL_BBOX.ymin || bb.ymin > BRAZIL_BBOX.ymax)
    return fail("census.outside_brazil");
  if (state.censusInFlight) return;
  state.censusInFlight = true;
  const btn = document.getElementById("ref-place-random");
  if (btn) btn.disabled = true;
  status.textContent = t("census.fetching");
  try {
    // 1. Fetch setores intersecting the DEM bbox (HTTP Range over the .fgb).
    const rect = { minX: bb.xmin, minY: bb.ymin, maxX: bb.xmax, maxY: bb.ymax };
    const setores = [];          // { parts:[poly…], box:{minx…}, w }
    let totalW = 0;
    for await (const f of flatgeobuf.deserialize(CENSUS_FGB_URL, rect)) {
      const pop = +f?.properties?.pop;
      if (!Number.isFinite(pop) || pop <= 0) continue;
      const g = f.geometry;
      const parts = g?.type === "Polygon" ? [g.coordinates]
        : g?.type === "MultiPolygon" ? g.coordinates : null;
      if (!parts) continue;
      let full = 0, clip = 0;
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const rings of parts) {
        full += polyArea(rings);
        clip += clippedPolyArea(rings, bb);
        for (const p of rings[0]) {
          if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
          if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
        }
      }
      if (full <= 0) continue;
      const w = pop * Math.min(1, clip / full);   // pop weighted by in-extent area
      if (!(w > 0)) continue;
      setores.push({ parts, box: { minx, miny, maxx, maxy }, w });
      totalW += w;
    }
    if (!setores.length || totalW <= 0) return fail("census.no_setores");

    // 2. Population-weighted setor selection: 1-D Sobol → inverse CDF.
    const cdf = new Float64Array(setores.length);
    let acc = 0;
    for (let i = 0; i < setores.length; i++) { acc += setores[i].w; cdf[i] = acc / totalW; }
    const searchsorted = (u) => {
      let lo = 0, hi = setores.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; }
      return lo;
    };

    // 3. Place each point inside its setor: 2-D Sobol bbox draw + PIP rejection.
    const posCtr = new Map();     // setor idx → its 2-D Sobol counter (continues)
    const coords = [];
    for (let k = 0; k < want; k++) {
      const si = searchsorted(sobolScalar1D(k + 1));
      const s = setores[si];
      const { minx, miny, maxx, maxy } = s.box;
      let ctr = posCtr.get(si) ?? 0, pt = null;
      for (let tries = 0; tries < 64; tries++) {
        const [qx, qy] = sobolPoint2D(++ctr);
        const lng = minx + qx * (maxx - minx);
        const lat = miny + qy * (maxy - miny);
        if (s.parts.some((rings) => pointInPolygon(lng, lat, rings))) { pt = [lng, lat]; break; }
      }
      posCtr.set(si, ctr);
      if (!pt) { const r0 = s.parts[0][0]; pt = [r0[0][0], r0[0][1]]; }  // sliver fallback
      coords.push(pt);
    }

    // 4. lng/lat → pixel → passable → reference point (reuses the file-load path).
    const constrained = networkConstraintActive();
    const valid = [];
    let skipped = 0;
    for (const [lng, lat] of coords) {
      let rc = latLngToPixel(L.latLng(lat, lng));
      if (rc && constrained) {
        rc = snapToNetwork(rc);
        if (!state.networkMask[rc[0] * state.dem.W + rc[1]]) rc = null;
      }
      if (rc && effectivePassableAt(rc[0] * state.dem.W + rc[1])) valid.push(rc);
      else skipped++;
    }
    if (!valid.length) return fail("census.no_points");   // refs left untouched
    clearRefPoints();             // census REPLACES the current set (like file load)
    for (const rc of valid) addRefPoint(rc);
    const placed = state.refPoints.length;
    status.textContent = skipped
      ? t("census.placed.skipped", placed, skipped)
      : t("census.placed", placed);
  } catch (err) {
    fail("census.fetch_failed", err?.message || String(err));
  } finally {
    state.censusInFlight = false;
    if (btn) btn.disabled = false;
  }
}

// Load reference points from a GeoJSON of Point / MultiPoint features. Each
// coordinate is converted to a DEM pixel via latLngToPixel and placed through
// addRefPoint (reusing its mask check / numbered marker / FIFO cap). Replaces
// the current reference set; points outside the extent or on nodata are
// skipped. Pairs with census/sample_census.py output.
async function loadRefPointsFromFile(file) {
  if (!file) return;
  const fail = (key, ...a) => {
    status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t(key, ...a))}</span>`;
  };
  if (!state.dem) return fail("ref.load.no_dem");
  if (!state.dem.isGeographic) return fail("ref.load.geographic");
  let fc;
  try {
    fc = JSON.parse(await file.text());
  } catch (err) {
    return fail("ref.load.parse_error", err.message);
  }
  // Accept a FeatureCollection, a single Feature, or a bare geometry.
  const features = Array.isArray(fc?.features) ? fc.features
    : fc?.type === "Feature" ? [fc]
    : fc ? [{ geometry: fc.geometry || fc }] : [];
  const coords = [];
  for (const f of features) {
    const g = f?.geometry || f;
    if (g?.type === "Point") coords.push(g.coordinates);
    else if (g?.type === "MultiPoint") for (const c of g.coordinates) coords.push(c);
  }
  // GeoJSON coordinates are [lng, lat]. Keep only points inside the extent on a
  // passable cell; tally the rest so the load is never silently lossy.
  const valid = [];
  let skipped = 0;
  for (const [lng, lat] of coords) {
    const rc = latLngToPixel(L.latLng(lat, lng));
    if (rc && effectivePassableAt(rc[0] * state.dem.W + rc[1])) valid.push(rc);
    else skipped++;
  }
  if (!valid.length) return fail("ref.load.no_points", file.name);
  // Raise the N-references cap so the whole file survives the FIFO trim in
  // addRefPoint (input + worker top out at 2000; warn if we clip).
  const capInput = document.getElementById("n-refs");
  if (capInput) {
    capInput.value = String(Math.min(2000, Math.max(parseInt(capInput.value, 10) || 0, valid.length)));
  }
  if (valid.length > 2000) {
    console.warn(`[refs] ${valid.length - 2000} of ${valid.length} points dropped (2000 cap, FIFO).`);
  }
  clearRefPoints();
  for (const rc of valid) addRefPoint(rc);
  const placed = state.refPoints.length;
  status.textContent = skipped
    ? t("ref.loaded.skipped", placed, file.name, skipped)
    : t("ref.loaded", placed, file.name);
}

function syncRefDisplay() {
  const el = document.getElementById("ref-display");
  if (el) el.textContent = state.refPoints.length
    ? `${state.refPoints.length} reference${state.refPoints.length === 1 ? "" : "s"} placed`
    : "no references placed";
  updateRunButtonState();
  estimateRunTime();
}

// Unified gate for the Compute button. In density mode it unlocks once at
// least one reference point exists; otherwise it follows the src/dst rules.
function updateRunButtonState() {
  if (!state.dem) {
    runBtn.disabled = true;
  } else {
    const densityOn = !!document.getElementById("want-density")?.checked;
    runBtn.disabled = densityOn
      ? !(state.refPoints && state.refPoints.length > 0)
      : !state.src;
  }
  syncLoadedHighlights(); // refresh 3B/3C/4 status colours
}

// ------- Run -------
runBtn.addEventListener("click", async () => {
  const wantDensity = !!document.getElementById("want-density")?.checked;
  // Density mode runs from refPoints, not src — relax the src-required guard.
  if (!state.dem) return;
  if (!wantDensity && !state.src) return;
  if (wantDensity && (!state.refPoints || state.refPoints.length === 0)) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.density_needs_ref")}</span>`;
    return;
  }
  // Mobile: close the drawer so the user sees the result land on the map
  // instead of staring at the parameter panel while the compute runs.
  // No-op on desktop (drawer never opens above 860 px).
  window.__simuDrawer?.close();

  const mode = document.getElementById("mode").value;
  // Clamp α/β to ≥0: a negative cost coefficient makes negative edge weights,
  // which break Dijkstra (and a negative α NaN-poisons the time estimate). The
  // min="0" input attribute only guards the spinner, not typed/pasted values.
  const alphaRaw = parseFloat(document.getElementById("alpha").value);
  const alpha = Number.isFinite(alphaRaw) ? Math.max(0, alphaRaw) : 0.008;
  const betaRaw = parseFloat(document.getElementById("beta").value);
  const beta = Number.isFinite(betaRaw) ? Math.max(0, betaRaw) : 1.0;
  const eta = parseFloat(document.getElementById("eta").value);
  const eMaxRaw = parseFloat(document.getElementById("e-max")?.value);
  const eMax = Number.isFinite(eMaxRaw) && eMaxRaw > 0 ? eMaxRaw : 0;
  // Round mode only: budget caps each leg ("leg", default — totals reach
  // 2·eMax) or the round-trip sum ("total").
  const eMaxMode = document.getElementById("e-max-mode")?.value || "leg";

  // Optional extras (default off — energy-only is the fast path)
  const wantPasses = !!document.getElementById("want-passes")?.checked;
  const wantTopN   = !!document.getElementById("want-topn")?.checked;
  const nRoutes    = Math.max(1, Math.min(20, parseInt(document.getElementById("n-routes")?.value, 10) || 3));
  const penalty    = Math.max(0, parseFloat(document.getElementById("penalty")?.value) || 2.0);
  const repulsionMode = document.getElementById("repulsion-mode")?.value || "per-cell";
  // Reverse-optimization: flip the cost function so Dijkstra finds the
  // most expensive (under the original metric) routes rather than the
  // cheapest. The worker does the inversion against a precomputed
  // MAX_EDGE_COST = α·diagonal + β·(maxH − minH).
  // maximizeLength > 0 activates a length-constrained layered-DP path
  // search instead of the inverted Dijkstra. Memory-bounded; the worker
  // refuses if L·H·W exceeds the cap.
  const maximize       = !!document.getElementById("maximize")?.checked;
  const maximizeLength = Math.max(0, parseInt(document.getElementById("maximize-length")?.value, 10) || 0);
  // Density follows the global Mode select instead of having its own
  // direction toggle.
  const densityMode  = mode;

  if (wantTopN && !state.dst) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.topn_needs_dst")}</span>`;
    return;
  }

  // Whether the loaded network constrains THIS run (checkbox can disable
  // the constraint while keeping the network loaded for rendering).
  const constrainNet = networkConstraintActive();

  // If a constraining network is loaded, src/dst must lie on it — otherwise
  // the Dijkstra is constrained to network cells and can't relax through
  // them. Re-snap here defensively: covers the case where the user clicked
  // points BEFORE loading the .gpkg, and the case where snap-radius was 0
  // at click time. If a point can't be snapped (no network cell within
  // radius) we abort with a clear message rather than silently producing
  // empty routes.
  if (constrainNet && state.dem) {
    const W = state.dem.W;
    const offNet = (rc) => rc && !state.networkMask[rc[0] * W + rc[1]];
    const reSnapAndUpdate = (rc, marker, displayId, label) => {
      if (!rc || !offNet(rc)) return rc;
      const snapped = snapToNetwork(rc);
      if (offNet(snapped)) {
        // Snap is grid-wide now — this means the network has no usable
        // cells at all on this DEM.
        status.innerHTML = `<span style="color:#ff6b6b">${t("status.snap_failed_label", escapeHtml(label))}</span>`;
        return null;
      }
      // Move the marker so the user sees where compute actually started.
      const { originX, originY, dx, dy } = state.dem;
      const latlng = L.latLng(originY - (snapped[0] + 0.5) * dy, originX + (snapped[1] + 0.5) * dx);
      if (marker) marker.setLatLng(latlng);
      const disp = document.getElementById(displayId);
      if (disp) {
        disp.textContent = `r=${snapped[0]}, c=${snapped[1]}`;
        disp.classList.add("set");
      }
      return snapped;
    };
    // Gate each point on its existence: state.src is ALWAYS null in
    // density mode, and the old unconditional call returned that null
    // through `if (newSrc === null) return;` — silently aborting every
    // density compute whenever a constraining network was loaded.
    if (state.src) {
      const newSrc = reSnapAndUpdate(state.src, state.srcMarker, "src-display", "Source");
      if (newSrc === null) return;
      state.src = newSrc;
    }
    if (state.dst) {
      const newDst = reSnapAndUpdate(state.dst, state.dstMarker, "dst-display", "Destination");
      if (newDst === null) return;
      state.dst = newDst;
    }
    // Density refs get the same defensive re-snap: refs placed before the
    // network loaded (or via random placement over the whole DEM) may sit
    // off-network; their per-ref Dijkstras would start from isolated
    // seeds. Markers follow their snapped cells.
    if (wantDensity && state.refPoints?.length) {
      for (let i = 0; i < state.refPoints.length; i++) {
        const rc = state.refPoints[i];
        if (!offNet(rc)) continue;
        const snapped = snapToNetwork(rc);
        if (offNet(snapped)) {
          status.innerHTML = `<span style="color:#ff6b6b">${t("status.refs_no_snap")}</span>`;
          return;
        }
        state.refPoints[i] = snapped;
        const m = state.refMarkers[i];
        if (m) {
          const ll = pixelToLatLng(snapped[0], snapped[1]);
          if (ll) m.setLatLng(ll);
          m.unbindTooltip().bindTooltip(`ref ${i + 1} · r=${snapped[0]}, c=${snapped[1]}`);
        }
      }
    }
  }

  // Cancel any in-flight run, then capture this run's generation. Every
  // worker callback below checks it — a mismatch means the run was
  // superseded (new Compute click, new DEM/network) and the message is
  // dropped instead of rendered against the wrong grid.
  cancelActiveCompute();
  const gen = state.computeGen;

  status.textContent = t("status.computing");
  progress.classList.add("active");
  progressBar.style.width = "0%";
  runBtn.disabled = true;

  // ETA bookkeeping. The worker emits progress every ~N/50 cells, which
  // gives a usable ETA after the first few percent.
  state.computeStartedAt = performance.now();
  state.estimatedTotalMs = 0;
  syncLoadedHighlights(); // 3C → running (orange)
  // Cache density's expected ref count so the progress text reads
  // "ref X/N" while the workers are iterating.
  state.computeRefTotal = wantDensity ? state.refPoints.length : 0;

  const { H, W } = state.dem;
  const N = H * W;
  // Snapshot the run config now (engine/refs/budget/mode) so computeDone can
  // online-correct the estimate against the real elapsed time.
  if (state.calibration) state.lastRun = currentRunOpts(state.calibration, N);
  const wantNetworkInterp = !!document.getElementById("net-interp")?.checked;
  const interpMaxDistance = Math.max(1, parseInt(document.getElementById("net-interp-max-dist")?.value, 10) || 50);
  const interpSmoothing   = Math.max(0, parseInt(document.getElementById("net-interp-smoothing")?.value, 10) || 0);

  const computeFailed = (message) => {
    if (gen !== state.computeGen) return;
    cancelActiveCompute();
    // Falha de cálculo na nuvem: para a VM agora em vez de deixá-la ligada até o
    // lease expirar (cancelActiveCompute só corta o keepalive). computeDone faz o
    // mesmo no sucesso; stopCloudVm é idempotente.
    if (state.cloud.mode === "cloud" && state.cloud.orchestratorUrl) {
      stopCloudVm(state.cloud.orchestratorUrl);
    }
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.worker_error", escapeHtml(message))}</span>`;
  };

  const computeDone = (m) => {
    if (gen !== state.computeGen) return;
    // Terminate now rather than waiting for the next run — finished
    // workers pin their DEM copy + Dijkstra buffers otherwise.
    for (const w of state.workers) w.terminate();
    state.workers = [];
    progress.classList.remove("active");
    updateRunButtonState();
    state.computeStartedAt = 0;
    stampBridgeDeckPasses(m.passes); // deck cells carry the bridge flow (portals skip them)
    renderResult(m);
    status.textContent = t("status.done_ms", m.elapsedMs.toFixed(0));
    setGroupOpen("result-group", true); // compute done → reveal results
    syncLoadedHighlights();              // 3C → done (green), 4 → ready (orange)
    // Learn from this run: nudge the estimate toward reality (single runs
    // only — compare runs carry energyAlt and time ~2 scenarios). Compute and
    // interp phases are corrected separately (m.computeMs/m.interpMs when the
    // density path split them; else the whole run is compute). Then refresh
    // the pre-flight number so the correction is visible immediately.
    if (!m.energyAlt) {
      updateEstimateCorrection(m.computeMs ?? m.elapsedMs, m.interpMs ?? 0);
      estimateRunTime();
    }
    // The calibration probe is skipped while a compute runs — if this DEM
    // still has no calibration, run it now that the cores are free.
    if (!state.calibration) startCalibrationProbe();
    // Cloud: stop the VM after each run (default-ON), releasing the lease so it
    // doesn't bill idle. With "keep warm" ticked, leave the VM up to reuse on the
    // next run — just drop the keepalive so the orchestrator lease + in-VM
    // idle-watchdog reap it after ~15 min idle (the keepalive is also cleared
    // inside stopCloudVm).
    if (state.cloud.mode === "cloud" && state.cloud.orchestratorUrl) {
      if (document.getElementById("cloud-keep-warm")?.checked) {
        stopCloudKeepalive();
        setCloudHint("cloud.warm");
      } else {
        stopCloudVm(state.cloud.orchestratorUrl);
      }
    }
  };

  const reportProgress = (frac) => {
    if (gen !== state.computeGen) return;
    const pct = Math.min(100, frac * 100);
    progressBar.style.width = `${pct.toFixed(1)}%`;
    // Live ETA: linear extrapolation. Skip the noisy first 5% of the run.
    if (frac > 0.05) {
      const elapsed = performance.now() - state.computeStartedAt;
      const total = elapsed / frac;
      const remaining = Math.max(0, total - elapsed);
      let label;
      if (state.computeRefTotal > 0) {
        const cur = Math.max(1, Math.min(state.computeRefTotal, Math.ceil(frac * state.computeRefTotal)));
        label = t("status.density_progress", cur, state.computeRefTotal, pct.toFixed(0));
      } else {
        label = t("status.computing_pct", pct.toFixed(0));
      }
      status.textContent = t("status.time_left", label, formatDuration(remaining));
    }
  };

  // A worker-load failure (404, parse error) or an exception outside the
  // worker's own try/catch surfaces as an `error` event, not a message —
  // without these handlers the UI used to stay stuck on "Computing…".
  const spawnWorker = (onMessage) => {
    const w = new Worker(WORKER_URL);
    w.onmessage = (ev) => { if (gen === state.computeGen) onMessage(ev.data); };
    w.onerror = (e) => computeFailed(e.message || "worker failed to load or crashed");
    w.onmessageerror = () => computeFailed("worker message could not be deserialised");
    state.workers.push(w);
    return w;
  };

  // Per-worker DEM clones — buffers are transferred, so each worker needs
  // its own copy. The pool sizing below accounts for this memory.
  const demPayload = () => {
    // buildComputeGrid composes the impassable mask + bridge corridors into the
    // height/mask; networkMask stays the separate constraint slot the worker ANDs.
    const { height, mask, transfer } = buildComputeGrid();
    const networkMask = constrainNet ? new Uint8Array(state.networkMask) : null;
    if (networkMask) transfer.push(networkMask.buffer);
    return { height, mask, networkMask, transfer };
  };

  const portals = buildPortals();
  const baseMsg = {
    kind: "run",
    H, W,
    dx: state.dem.dxM,
    dy: state.dem.dyM,
    seedR: state.src ? state.src[0] : (state.refPoints[0] ? state.refPoints[0][0] : -1),
    seedC: state.src ? state.src[1] : (state.refPoints[0] ? state.refPoints[0][1] : -1),
    goalR: state.dst ? state.dst[0] : -1,
    goalC: state.dst ? state.dst[1] : -1,
    mode, alpha, beta, eta, eMax, eMaxMode,
    wantPasses, wantTopN, nRoutes, penalty, repulsionMode,
    wantDensity,
    refPoints: wantDensity ? state.refPoints.slice() : null,
    densityMode,
    wantNetworkInterp,
    interpMaxDistance,
    interpSmoothing,
    maximize,
    maximizeLength,
    // Bridge portal edges (hybrid raster overlay). Small arrays — spread into
    // every worker message via baseMsg (structured-cloned, NOT transferred, so
    // the shared arrays survive across the density pool's workers). The native
    // backend path appends them to its Blob separately.
    portalU: portals ? portals.u : null,
    portalV: portals ? portals.v : null,
    portalLenM: portals ? portals.lenM : null,
    portalHU: portals ? portals.hu : null,   // deck-end ele (NaN = use DEM)
    portalHV: portals ? portals.hv : null,
  };

  // Shared tail for the density paths (pool and native backend): optional
  // IDW fill as a follow-up worker task (the fill helpers live in the
  // worker; per-slice filling would be wrong), then computeDone.
  // ---- Pooled network interpolation -----------------------------------------
  // The IDW fill is embarrassingly parallel by rows: split the grid into
  // bands across the worker pool (each band worker gets the FULL inputs —
  // rays read past band edges — so memory is ~6 bytes/cell per worker,
  // capped). Smoothing can't be banded (it would seam at band edges), so
  // it runs as one cheap full-grid pass after the merge. Resolves with the
  // filled field; failures go through computeFailed (promise stays pending,
  // the generation bump kills the chain).
  const runInterp = (energy) => new Promise((resolve) => {
    status.textContent = t("status.interpolating_net");
    progressBar.style.width = "0%";
    const interpPayload = () => ({
      // Effective mask (impassable blocked, corridors open) so IDW energy never
      // bleeds across water; networkMask stays the fill seed.
      mask: buildComputeGrid({ maskOnly: true }).mask,
      networkMask: new Uint8Array(state.networkMask),
    });
    const smoothThenResolve = (filled) => {
      if (!(interpSmoothing > 0)) { resolve(filled); return; }
      const { mask, networkMask } = interpPayload();
      const w = spawnWorker((m) => {
        if (m.kind === "smooth-done") resolve(m.energy);
        else if (m.kind === "error") computeFailed(m.message);
      });
      w.postMessage(
        { kind: "smooth", energy: filled, networkMask, mask, H, W, iters: interpSmoothing },
        [filled.buffer, mask.buffer, networkMask.buffer],
      );
    };
    const cores = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
    // Budget the interp pool against deviceMemory like densityPoolSize (GB, spec-
    // capped at 8) with the #max-workers override, instead of a fixed 1.5 GB that
    // pinned huge DEMs to ONE worker. Each worker holds the full grid (~6·N bytes:
    // energy f32 + mask + networkMask) since rays read past band edges. The interp
    // runs AFTER the Dijkstra workers are freed (and in Cloud mode the browser
    // never ran them), so this RAM is genuinely available.
    const devMemGB = navigator.deviceMemory || 4;
    const memBudget = Math.max(1.5e9, devMemGB * 1e9 * 0.45);
    const memCap = Math.max(1, Math.floor(memBudget / (6 * N)));
    const userMax = parseInt(document.getElementById("max-workers")?.value, 10);
    const overrideN = Number.isFinite(userMax) && userMax > 0 ? userMax : 0;
    const bandCap = Math.ceil(H / 64);
    const P = overrideN
      ? Math.max(1, Math.min(bandCap, overrideN))
      : Math.max(1, Math.min(cores, memCap, bandCap));
    if (P <= 1) {
      // Single worker — smoothing handled worker-side in the same job.
      const { mask, networkMask } = interpPayload();
      const w = spawnWorker((m) => {
        if (m.kind === "progress") {
          progressBar.style.width = `${Math.min(100, m.progress * 100).toFixed(1)}%`;
        } else if (m.kind === "interp-done") resolve(m.energy);
        else if (m.kind === "error") computeFailed(m.message);
      });
      w.postMessage(
        {
          kind: "interp", energy, networkMask, mask, H, W,
          dx: state.dem.dxM, dy: state.dem.dyM,
          interpMaxDistance, interpSmoothing,
        },
        [energy.buffer, mask.buffer, networkMask.buffer],
      );
      return;
    }
    const merged = new Float32Array(N);
    const frac = new Float64Array(P);
    let remaining = P;
    for (let p = 0; p < P; p++) {
      const r0 = Math.floor(p * H / P);
      const r1 = Math.floor((p + 1) * H / P);
      const slot = p;
      const w = spawnWorker((m) => {
        if (m.kind === "progress") {
          frac[slot] = m.progress;
          let acc = 0;
          for (let i = 0; i < P; i++) acc += frac[i];
          progressBar.style.width = `${Math.min(100, (acc / P) * 100).toFixed(1)}%`;
        } else if (m.kind === "interp-done") {
          merged.set(m.energy, m.rowStart * W);
          frac[slot] = 1;
          if (--remaining === 0) smoothThenResolve(merged);
        } else if (m.kind === "error") computeFailed(m.message);
      });
      const eCopy = new Float32Array(energy);
      const { mask, networkMask } = interpPayload();
      w.postMessage(
        {
          kind: "interp", energy: eCopy, networkMask, mask, H, W,
          dx: state.dem.dxM, dy: state.dem.dyM,
          interpMaxDistance, rowStart: r0, rowEnd: r1,
        },
        [eCopy.buffer, mask.buffer, networkMask.buffer],
      );
    }
  });

  const finishDensityOutputs = (energy, density, alt) => {
    // Split the two phases so the online correction learns them independently
    // (interp often dominates a network-constrained run).
    const computeMs = performance.now() - state.computeStartedAt;
    const finalize = (energyOut, interpMs) => computeDone({
      energy: energyOut, passes: density,
      path: null, pathEnergy: null, pathLengthM: null, routes: null,
      elapsedMs: performance.now() - state.computeStartedAt,
      computeMs, interpMs: interpMs || 0,
      energyAlt: alt?.energyAlt || null,
      passesAlt: alt?.passesAlt || null,
    });
    if (wantNetworkInterp && constrainNet) {
      const t = performance.now();
      runInterp(energy).then((e) => finalize(e, performance.now() - t));
    } else finalize(energy, 0);
  };

  // ---- Density worker pool -------------------------------------------------
  // Each reference point's Dijkstra is independent, so density runs split
  // the refs across min(cores − 1, K, memory-cap) workers — near-linear
  // wall-clock speedup. Workers return raw accumulators (densityPartial);
  // the merge + final normalisation happens here.
  //
  // Memory cap: each worker's resident set is the DEM copy (height f32 4 +
  // mask u8 1 = 5 B/cell) + densityField scratch (E4 + settled1 + parents4 +
  // order4 + passes-f32 4 = 17) + outputs (density-f32 4 + energySum-f64 8 +
  // energyCount 4 = 16) ≈ 38 B/cell, and ~55 in round mode (a second
  // search resident). Budget it against navigator.deviceMemory (GB, which
  // the spec CAPS at 8 — it's a floor on true RAM, never the full amount),
  // taking a conservative fraction to leave room for the browser, the
  // main-thread DEM, and the OS. On huge DEMs this still yields 1 worker
  // (the honest ceiling: two won't fit), exactly the old behaviour.
  const K = wantDensity ? state.refPoints.length : 0;
  const poolN = wantDensity ? densityPoolSize({ N, K, round: densityMode === "round" }) : 1;

  // Run one full density field over the worker pool and resolve with the
  // raw outputs (no interp, no UI finalisation — the callers compose those).
  // useNetwork toggles the network constraint per scenario, which is what
  // the constrained-vs-unconstrained comparison varies. Progress maps into
  // [progressBase, progressBase + progressScale].
  const computeDensityField = ({ useNetwork, progressBase = 0, progressScale = 1 }) =>
    new Promise((resolve) => {
      const density = new Float64Array(N);
      const energySum = new Float64Array(N);
      const energyCount = new Int32Array(N);
      const workerFrac = new Float64Array(poolN);
      const sliceLen = new Float64Array(poolN);
      let remaining = poolN;

      const poolProgress = () => {
        let acc = 0;
        for (let i = 0; i < poolN; i++) acc += workerFrac[i] * sliceLen[i];
        reportProgress(progressBase + progressScale * (acc / K));
      };

      for (let p = 0; p < poolN; p++) {
        const lo = Math.floor(p * K / poolN);
        const hi = Math.floor((p + 1) * K / poolN);
        sliceLen[p] = hi - lo;
        const slot = p;
        const w = spawnWorker((m) => {
          if (m.kind === "progress") {
            workerFrac[slot] = m.progress;
            poolProgress();
          } else if (m.kind === "done") {
            for (let i = 0; i < N; i++) density[i] += m.density[i];
            for (let i = 0; i < N; i++) energySum[i] += m.energySum[i];
            for (let i = 0; i < N; i++) energyCount[i] += m.energyCount[i];
            workerFrac[slot] = 1;
            poolProgress();
            if (--remaining === 0) {
              // Second density normalisation (per-ref /N happened worker-side).
              for (let i = 0; i < N; i++) density[i] /= N;
              const energy = new Float32Array(N);
              for (let i = 0; i < N; i++) {
                energy[i] = energyCount[i] > 0 ? energySum[i] / energyCount[i] : Infinity;
              }
              resolve({ energy, passes: density });
            }
          } else if (m.kind === "error") {
            computeFailed(m.message);
          }
        });
        const { height, mask, transfer } = buildComputeGrid();
        const networkMask = useNetwork ? new Uint8Array(state.networkMask) : null;
        if (networkMask) transfer.push(networkMask.buffer);
        w.postMessage(
          {
            ...baseMsg,
            height, mask, networkMask,
            refPoints: state.refPoints.slice(lo, hi),
            densityPartial: true,
            // Interp (if any) runs after the merge, never per-slice.
            wantNetworkInterp: false,
          },
          transfer,
        );
      }
    });

  const startSingleWorker = () => {
    // Single worker: regular from/to/round runs, top-N, maximize, and
    // density with one ref (or when memory caps the pool at 1).
    const w = spawnWorker((m) => {
      if (m.kind === "progress") {
        reportProgress(m.progress);
      } else if (m.kind === "done") {
        computeDone(m);
      } else if (m.kind === "error") {
        computeFailed(m.message);
      } else if (m.kind === "warning") {
        // Non-fatal — the worker is still going and will follow up with
        // a `done` message. Yellow-tint the status; the next progress
        // tick will overwrite it.
        console.warn("[worker]", m.message);
        status.innerHTML = `<span style="color:#ffb86b">${escapeHtml(m.message)}</span>`;
      }
    });
    const { height, mask, networkMask, transfer } = demPayload();
    w.postMessage({ ...baseMsg, height, mask, networkMask }, transfer);
  };

  // ---- Optional native backend (density only, OFF by default) --------------
  // Sends the DEM + params to the local Rust server (backend/ in the repo)
  // which runs the per-ref Dijkstras on all cores. Any failure — server not
  // running, version mismatch, network error — falls back to the in-browser
  // pool. Protocol documented in backend/src/main.rs.
  const startDensityBackend = async (baseUrl, { useNetwork }) => {
    progressBar.style.width = "10%"; // no streaming progress from the backend
    // Liveness ticker: large runs take a while server-side and fetch gives
    // no progress events — an elapsed counter shows the app isn't hung.
    const t0 = performance.now();
    status.textContent = t("status.backend_computing");
    const ticker = setInterval(() => {
      if (gen !== state.computeGen) { clearInterval(ticker); return; }
      status.textContent =
        t("status.backend_computing_elapsed", formatDuration(performance.now() - t0));
    }, 1000);
    try {
      const params = {
        h: H, w: W,
        dx: state.dem.dxM, dy: state.dem.dyM,
        alpha, beta, eta, eMax, eMaxMode,
        densityMode,
        refPoints: state.refPoints.map(([r, c]) => [r, c]),
        hasNetwork: useNetwork,
        maximize,
        // Bridge portal edges appended after the (optional) network mask, in
        // order: portalU (i32×P), portalV (i32×P), portalLenM (f64×P),
        // portalHU (f64×P), portalHV (f64×P). HU/HV are deck-end ele (NaN=use DEM).
        nPortals: portals ? portals.n : 0,
      };
      const json = new TextEncoder().encode(JSON.stringify(params));
      const head = new Uint8Array(4);
      new DataView(head.buffer).setUint32(0, json.length, true);
      // Compose the impassable mask + bridge corridors into the grid the native
      // backend computes on (sent as raw bytes — parity kept).
      const { height: gridHeight, mask: gridMask } = buildComputeGrid();
      const body = new Blob([
        head, json, gridHeight, gridMask,
        ...(useNetwork ? [state.networkMask] : []),
        ...(portals ? [portals.u, portals.v, portals.lenM, portals.hu, portals.hv] : []),
      ]);
      const resp = await fetch(`${baseUrl}/density`, { method: "POST", body });
      if (!resp.ok) throw new Error(`backend HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (gen !== state.computeGen) return new Promise(() => {});

      // From here on the backend HAS answered — a parsing/allocation error
      // must surface as a failure, NOT fall through to the browser-pool
      // fallback (silently recomputing a huge DEM there looks like a hang).
      try {
        const dv = new DataView(buf);
        const jlen = dv.getUint32(0, true);
        const expect = 4 + jlen + 8 * N + 4 * N;
        if (buf.byteLength !== expect) {
          throw new Error(`backend response ${buf.byteLength} B, expected ${expect} B`);
        }
        let off = 4 + jlen;
        // Current backends pad the meta JSON so the payload is 8-byte
        // aligned — the density view sits straight on the response buffer,
        // zero copies. Unaligned (older backend): slice-copy to realign.
        const aligned = off % 8 === 0;
        const density = aligned
          ? new Float64Array(buf, off, N)
          : new Float64Array(buf.slice(off, off + 8 * N));
        off += 8 * N;
        // Energy is always copied out: downstream steps (interp) transfer
        // it to workers, and a view would drag the whole response buffer —
        // density included — along and detach it.
        const energy = new Float32Array(buf.slice(off, off + 4 * N));
        progressBar.style.width = "100%";
        return { energy, passes: density };
      } catch (err) {
        console.error("[backend] response handling failed:", err);
        computeFailed(`backend response handling failed: ${err.message}`);
        return new Promise(() => {}); // run is dead; keep the chain pending
      }
    } finally {
      clearInterval(ticker);
    }
  };

  // ---- Optional native backend: single-source energy field ------------------
  // POST /single — one Dijkstra (two for round) on the native server, returning
  // the raw energy field + optional passes. Maximize/top-N/path stay browser-
  // only (the backend produces no routes), so the caller only reaches here for
  // the plain from/to/round energy field. Throws on any failure → browser
  // fallback (a 404 from an old backend without /single lands here too).
  const startSingleBackend = async (baseUrl) => {
    progressBar.style.width = "10%"; // no streaming progress from the backend
    const t0 = performance.now();
    status.textContent = t("status.backend_computing");
    const ticker = setInterval(() => {
      if (gen !== state.computeGen) { clearInterval(ticker); return; }
      status.textContent =
        t("status.backend_computing_elapsed", formatDuration(performance.now() - t0));
    }, 1000);
    try {
      const params = {
        h: H, w: W,
        dx: state.dem.dxM, dy: state.dem.dyM,
        alpha, beta, eta, eMax, eMaxMode,
        densityMode: mode,                 // from | to | round (single-source dir)
        src: [state.src[0], state.src[1]],
        wantPasses,
        hasNetwork: constrainNet,
        maximize: false,                   // excluded from the single-source path
        nPortals: portals ? portals.n : 0,
      };
      const json = new TextEncoder().encode(JSON.stringify(params));
      const head = new Uint8Array(4);
      new DataView(head.buffer).setUint32(0, json.length, true);
      const { height: gridHeight, mask: gridMask } = buildComputeGrid();
      const body = new Blob([
        head, json, gridHeight, gridMask,
        ...(constrainNet ? [state.networkMask] : []),
        ...(portals ? [portals.u, portals.v, portals.lenM, portals.hu, portals.hv] : []),
      ]);
      const resp = await fetch(`${baseUrl}/single`, { method: "POST", body });
      if (!resp.ok) throw new Error(`backend HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (gen !== state.computeGen) return new Promise(() => {});
      try {
        const dv = new DataView(buf);
        const jlen = dv.getUint32(0, true);
        const expect = 4 + jlen + 4 * N + (wantPasses ? 4 * N : 0);
        if (buf.byteLength !== expect) {
          throw new Error(`backend response ${buf.byteLength} B, expected ${expect} B`);
        }
        let off = 4 + jlen;
        // Slice-copy (a single search, so the copy is cheap and the views need
        // no alignment): energy first, then passes when present.
        const energy = new Float32Array(buf.slice(off, off + 4 * N));
        off += 4 * N;
        const passes = wantPasses ? new Float32Array(buf.slice(off, off + 4 * N)) : null;
        progressBar.style.width = "100%";
        return { energy, passes };
      } catch (err) {
        console.error("[backend] single response handling failed:", err);
        computeFailed(`backend response handling failed: ${err.message}`);
        return new Promise(() => {}); // run is dead; keep the chain pending
      }
    } finally {
      clearInterval(ticker);
    }
  };

  // Backend with browser-pool fallback, per scenario. Resolves with raw
  // {energy, passes} like computeDensityField.
  const densityField = async (opts) => {
    if (runUseBackend) {
      try {
        return await startDensityBackend(backendUrl, opts);
      } catch (err) {
        if (gen !== state.computeGen) return new Promise(() => {});
        console.warn("[backend] falling back to in-browser workers:", err);
        // In cloud mode a dropped backend fetch usually means the VM was
        // preempted/reaped mid-run — say so; otherwise the generic message.
        status.textContent = t(cloudMode ? "cloud.preempted" : "status.backend_fallback");
        // This run is now executing on the browser pool, not the backend.
        // Re-tag it so computeDone's online correction trains corrBrowser
        // (actual/predicted vs the browser model), not corrBackend — otherwise
        // every fallback run corrupts the native-slice correction with
        // browser timings and leaves corrBrowser untrained.
        if (state.lastRun) state.lastRun.backend = false;
      }
    }
    return computeDensityField(opts);
  };

  // ---- Constrained vs unconstrained comparison ------------------------------
  // Two workers in parallel: the primary run exactly as configured (network
  // mask, passes, top-N, path, interp), plus a secondary run WITHOUT the
  // network (energy + passes when enabled). The energy difference
  // (constrained − unconstrained, clamped at 0 — a constraint can never
  // reduce cost) quantifies what the network costs in energy; it's defined
  // on network cells only (off-network constrained values are interp
  // visualisation, not analysis). Passes difference is signed: positive
  // where the network concentrates traffic, negative where unconstrained
  // corridors ran. Progress reports come from the primary.
  const startComparePair = () => {
    let primary = null, secondary = null;
    const maybeFinish = async () => {
      if (!primary || !secondary) return;
      // The difference is ANALYSED on network cells only (off-network
      // constrained values are interpolation, not analysis), then — when
      // the interp option is on — visually filled across non-network
      // cells exactly like the constrained field.
      const net = state.networkMask;
      let diff = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        if (net && !net[i]) { diff[i] = Infinity; continue; }
        const a = primary.energy[i], b = secondary.energy[i];
        diff[i] = (Number.isFinite(a) && Number.isFinite(b)) ? Math.max(0, a - b) : Infinity;
      }
      if (wantNetworkInterp && constrainNet) {
        diff = await runInterp(diff);
        if (gen !== state.computeGen) return;
      }
      primary.energyAlt = { unconstrained: secondary.energy, difference: diff };
      if (primary.passes && secondary.passes) {
        primary.passesAlt = { unconstrained: secondary.passes };
      }
      computeDone(primary);
    };
    const wA = spawnWorker((m) => {
      if (m.kind === "progress") reportProgress(m.progress);
      else if (m.kind === "done") { primary = m; maybeFinish(); }
      else if (m.kind === "error") computeFailed(m.message);
      else if (m.kind === "warning") {
        console.warn("[worker]", m.message);
        status.innerHTML = `<span style="color:#ffb86b">${escapeHtml(m.message)}</span>`;
      }
    });
    {
      const { height, mask, networkMask, transfer } = demPayload();
      wA.postMessage({ ...baseMsg, height, mask, networkMask }, transfer);
    }
    const wB = spawnWorker((m) => {
      if (m.kind === "done") { secondary = m; maybeFinish(); }
      else if (m.kind === "error") computeFailed(m.message);
    });
    {
      // No network, no path/top-N extras — same mode/cost/budget; passes
      // mirror the primary so the overlay is comparable across scenarios.
      // Bridges are terrain, so the composed grid applies here too (only the
      // networkMask constraint slot differs from the primary).
      const { height, mask, transfer } = buildComputeGrid();
      wB.postMessage(
        {
          ...baseMsg,
          height, mask, networkMask: null,
          goalR: -1, goalC: -1,
          wantTopN: false,
          wantNetworkInterp: false,
          maximizeLength: 0,
        },
        transfer,
      );
    }
  };

  const compareOn = constrainNet && !!document.getElementById("vec-compare")?.checked;
  // Graph mode is inherently network-constrained, so "Compare with unconstrained"
  // applies there too (independent of the now-locked-on raster constrain toggle):
  // graph mode runs a full-DEM unconstrained RASTER scenario alongside the graph
  // compute and exposes the difference through the displayed-scenario picker.
  const graphCompareOn = graphModeActive() && !!document.getElementById("vec-compare")?.checked;

  // Compute source: Browser (in-page pool) / Localhost (native Rust) / Cloud
  // (local orchestrator → pre-baked VM). backendOn = "anything but browser":
  // the density/single dispatch is engine-agnostic and just gets the right
  // base URL (the orchestrator mirrors the backend's /density,/single bytes).
  const cloudMode = computeMode() === "cloud";
  const backendOn = computeMode() !== "browser";
  const backendUrl = effectiveBackendUrl();
  // Will THIS run actually use the native backend? It only does raster density
  // and backend-eligible single-source (from/to/round); top-N, the destination
  // path, "maximize", graph mode, AND a non-density compare (which routes to the
  // browser-only startComparePair) always run in-browser. Used to avoid booting a
  // cloud VM for a run that would compute in-browser anyway.
  const willUseBackend = backendOn && !graphModeActive() &&
    (wantDensity || (!compareOn && !wantTopN && !maximize && !state.dst));
  // Run-scoped engine override. Normally tracks backendOn, but a failed cloud
  // boot flips it to false so the density path (which reads it inside
  // densityField) finishes in-browser like the single path. Assigned in
  // dispatchCompute(useBackend) before any compute starts.
  let runUseBackend = backendOn;

  // Density + compare: the two scenarios run sequentially (each already
  // saturates the cores), splitting the progress bar. Diffs come from the
  // RAW constrained field (pre-interp); the energy difference is therefore
  // naturally confined to network cells.
  const startDensityCompare = async () => {
    const A = await densityField({ useNetwork: true, progressBase: 0, progressScale: 0.5 });
    if (gen !== state.computeGen) return;
    const B = await densityField({ useNetwork: false, progressBase: 0.5, progressScale: 0.5 });
    if (gen !== state.computeGen) return;
    let diffE = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = A.energy[i], b = B.energy[i];
      diffE[i] = (Number.isFinite(a) && Number.isFinite(b)) ? Math.max(0, a - b) : Infinity;
    }
    // Difference is computed from the RAW constrained field (network cells
    // only), then visually filled like the constrained field when the
    // interp option is on.
    if (wantNetworkInterp && constrainNet) {
      diffE = await runInterp(diffE);
      if (gen !== state.computeGen) return;
    }
    finishDensityOutputs(A.energy, A.passes, {
      energyAlt: { unconstrained: B.energy, difference: diffE },
      passesAlt: { unconstrained: B.passes },
    });
  };

  // Full-DEM UNCONSTRAINED raster energy field for graph-mode compare (no network
  // mask). Density → browser pool; single-source → one worker (energy only, no
  // path/top-N). Resolves a Float32Array (Infinity where unreachable), or null on
  // cancel/error. Runs in-browser (graph mode never uses the native backend).
  const computeUnconstrainedEnergy = () => {
    if (wantDensity) return computeDensityField({ useNetwork: false }).then((r) => r.energy);
    return new Promise((resolve) => {
      const w = spawnWorker((m) => {
        if (m.kind === "done") resolve(m.energy);
        else if (m.kind === "error") { computeFailed(m.message); resolve(null); }
      });
      const { height, mask, transfer } = buildComputeGrid();
      // Same mode/cost/budget as the graph run; no network, no path/top-N/interp.
      w.postMessage(
        { ...baseMsg, height, mask, networkMask: null, goalR: -1, goalC: -1, wantTopN: false, maximizeLength: 0, wantNetworkInterp: false },
        transfer,
      );
    });
  };

  // "Follow the vectors": route on the network graph instead of the raster.
  // Lazily (re)builds the cached graph in a worker, then runs the chosen mode
  // on it and renders the colored-vector overlay. Same gen/cancel semantics.
  const startGraphCompute = () => {
    const token = computeNetworkGraphToken();
    // IDW-fill a rasterised graph field (energy or difference) off-network, using
    // the field's own finite cells as seeds (the graph IS the network). Resolves
    // with the filled field; transfers the input buffer (caller must not reuse it).
    const graphInterp = (field) => new Promise((resolve) => {
      const seedMask = new Uint8Array(field.length);
      for (let i = 0; i < field.length; i++) seedMask[i] = Number.isFinite(field[i]) ? 1 : 0;
      const mask = buildComputeGrid({ maskOnly: true }).mask; // don't fill across water
      const w = spawnWorker((m) => {
        if (m.kind === "interp-done") { if (gen !== state.computeGen) return; resolve(m.energy); }
        // On error, `field` is already DETACHED (transferred to the worker), so it
        // can't be returned — resolve null and let the caller keep the prior field.
        else if (m.kind === "error") { console.warn("[graph interp]", m.message); resolve(null); }
      });
      w.postMessage(
        { kind: "interp", energy: field, networkMask: seedMask, mask, H: state.dem.H, W: state.dem.W, dx: state.dem.dxM, dy: state.dem.dyM, interpMaxDistance, interpSmoothing },
        [field.buffer, seedMask.buffer, mask.buffer],
      );
    });
    const finishGraph = async (graph, result) => {
      if (gen !== state.computeGen) return;
      // Rasterise the graph energy onto the grid (network cells only) BEFORE
      // terminating workers — graph-mode compare spawns an unconstrained partner.
      const eGrid = rasterizeGraphEnergy(graph, result);

      // Graph-mode compare: run a full-DEM unconstrained RASTER scenario and diff
      // it against the graph energy (network cells), mirroring raster compare. The
      // diff is the energy COST of being restricted to the network (clamped ≥ 0).
      let energyAlt = null;
      if (graphCompareOn && eGrid) {
        status.textContent = t("status.computing");
        const uncon = await computeUnconstrainedEnergy();
        if (gen !== state.computeGen || !uncon) return;
        const diff = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const a = eGrid[i], b = uncon[i];
          diff[i] = (Number.isFinite(a) && Number.isFinite(b)) ? Math.max(0, a - b) : Infinity;
        }
        energyAlt = { unconstrained: uncon, difference: diff };
      }

      // Finalise the run now (the partner, if any, is done).
      for (const w of state.workers) w.terminate();
      state.workers = [];
      progress.classList.remove("active");
      updateRunButtonState();
      state.computeStartedAt = 0;
      state.lastGraphResult = { graph, result, energyAlt };
      state.graphEnergyRaster = null;
      renderGraphOverlay();   // passes corridors show immediately
      // Learn the graph engine's real per-edge cost (corrGraph). The graph's
      // actual node/edge counts also sharpen the next estimate. Skip the
      // correction on compare runs — their elapsed includes the partner scenario.
      if (state.networkGraph) { state.networkGraph.nNodes = graph.nNodes; state.networkGraph.nEdges = graph.nEdges; }
      if (!energyAlt) { updateEstimateCorrection(result.elapsedMs, 0); estimateRunTime(); }
      const routeNote = result.routes ? t("status.graph_route_note", result.routes.length) : "";
      const doneMsg = t("status.graph_done", result.elapsedMs.toFixed(0), graph.nNodes, graph.nEdges, routeNote);
      // Energy field: rasterise the graph energy onto the grid, then (when the
      // interp option is on) IDW-fill off-network — the smooth field grid shows.
      if (eGrid && wantNetworkInterp) {
        status.textContent = t("status.interpolating_energy");
        const interpStart = performance.now();
        // null = interp failed (e.g. OOM); leave graphEnergyRaster null (no energy
        // overlay, passes corridors still show) — the pre-refactor behaviour.
        const filled = await graphInterp(eGrid);
        if (gen !== state.computeGen) return;
        if (filled) state.graphEnergyRaster = filled;
        // Fill the difference field the same way so the "difference" scenario reads
        // as a smooth field (it's analysed on network cells, filled for display).
        // On interp failure difference becomes null → the picker falls back to the
        // constrained field (renderGraphOverlay) instead of a blank overlay.
        if (energyAlt) {
          energyAlt.difference = await graphInterp(energyAlt.difference);
          if (gen !== state.computeGen) return;
        }
        renderGraphOverlay();
        status.textContent = doneMsg;
        // Graph interp is single-worker — learn its rate (corrInterp).
        if (!energyAlt) { updateEstimateCorrection(0, performance.now() - interpStart); estimateRunTime(); }
      } else {
        if (eGrid) state.graphEnergyRaster = eGrid;
        renderGraphOverlay();
        status.textContent = doneMsg;
      }
    };
    const runOnGraph = (graph) => {
      if (gen !== state.computeGen) return;
      const params = {
        mode, alpha, beta, eta, eMax, eMaxMode,
        srcRC: state.src || null,
        dstRC: state.dst || null,
        wantPath: !!state.dst,
        wantTopN, nRoutes, penalty,
        maximize, maximizeLength,
        densityMode: mode,
      };
      if (wantDensity) {
        params.mode = "density";
        params.refRCs = state.refPoints.slice();
      }
      const w = spawnWorker((m) => {
        if (m.kind === "progress") reportProgress(m.progress);
        else if (m.kind === "graph-result") finishGraph(graph, m.result);
        else if (m.kind === "error") computeFailed(m.message);
      });
      // No transfer list → the cached graph is structured-cloned, not detached.
      w.postMessage({ kind: "graphRun", graph, params, gen });
    };
    if (state.networkGraph && state.networkGraphToken === token) { runOnGraph(state.networkGraph); return; }
    status.textContent = t("status.building_graph");
    const wb = spawnWorker((m) => {
      if (m.kind === "graph-built") {
        if (gen !== state.computeGen) return;
        state.networkGraph = m.graph;
        state.networkGraphToken = token;
        runOnGraph(m.graph);
      } else if (m.kind === "error") computeFailed(m.message);
    });
    // Compose the impassable mask + bridge corridors so graph node elevations
    // get the bridge profile and water nodes are marked invalid.
    const grid = buildComputeGrid();
    const dem = {
      height: grid.height, mask: grid.mask,
      H: state.dem.H, W: state.dem.W, dxM: state.dem.dxM, dyM: state.dem.dyM,
    };
    wb.postMessage(
      { kind: "graphBuild", lines: networkLinesToCellLines(), dem, opts: { junctionMode: graphJunctionMode(), snapTolCells: 0.5, stepCells: 1, lineMeta: state.networkLinesMeta }, gen },
      [dem.height.buffer, dem.mask.buffer],
    );
  };

  // The actual engine dispatch. `useBackend` is normally `backendOn`, but a
  // failed cloud boot calls it with `false` so the run finishes in-browser.
  // Mirror it into runUseBackend so the density path (densityField) agrees.
  const dispatchCompute = (useBackend) => {
    runUseBackend = useBackend;
    if (graphModeActive() && state.networkLines && state.networkLines.length) {
      startGraphCompute();
    } else if (wantDensity && compareOn) {
      startDensityCompare();
    } else if (wantDensity) {
      (async () => {
        const r = await densityField({ useNetwork: constrainNet });
        if (gen !== state.computeGen) return;
        finishDensityOutputs(r.energy, r.passes);
      })();
    } else if (compareOn) {
      startComparePair();
    } else if (useBackend && !wantTopN && !maximize && !state.dst) {
      // Single-source energy field on the native backend (energy + optional
      // passes). Top-N / maximize / a destination path need the browser (the
      // backend produces no routes); any backend failure falls back too.
      (async () => {
        const t0 = performance.now();
        let r;
        try {
          r = await startSingleBackend(backendUrl);
        } catch (err) {
          if (gen !== state.computeGen) return;
          console.warn("[backend] falling back to in-browser workers:", err);
          status.textContent = t(cloudMode ? "cloud.preempted" : "status.backend_fallback");
          if (state.lastRun) state.lastRun.backend = false;
          startSingleWorker();
          return;
        }
        if (gen !== state.computeGen || !r) return;
        const computeMs = performance.now() - t0;
        // The backend returns the raw network-constrained field; the IDW fill is
        // a separate browser phase (the worker did it inline for the JS path).
        let energy = r.energy, interpMs = 0;
        if (wantNetworkInterp && constrainNet) {
          const ti = performance.now();
          energy = await runInterp(energy);
          if (gen !== state.computeGen) return;
          interpMs = performance.now() - ti;
        }
        computeDone({
          energy, passes: r.passes,
          path: null, pathEnergy: null, pathLengthM: null, routes: null,
          elapsedMs: performance.now() - t0, computeMs, interpMs,
        });
      })();
    } else {
      startSingleWorker();
    }
  };

  // The browser/localhost paths dispatch straight away. Cloud first boots the
  // VM through the local orchestrator (idempotent), keeps the lease alive while
  // the compute runs, and stops the VM in computeDone. On a missing
  // orchestrator URL, or an orchestrator/boot failure, it falls back to the
  // in-browser pool for this run (densityField()/single's own try/catch then
  // re-tags lastRun.backend=false; here we force useBackend=false up front).
  if (!cloudMode) {
    state.cloud.mode = "browser"; // a prior cloud run must not stop a VM in this run's computeDone
    dispatchCompute(backendOn);
  } else if (!willUseBackend) {
    // Cloud selected, but THIS run (top-N / destination / maximize / graph)
    // computes in-browser regardless — don't boot a billable VM we won't touch
    // (it would only delay the run ~1 min and bill for nothing). The orchestrator
    // URL is irrelevant for such a run, so don't require it either.
    state.cloud.mode = "browser";
    dispatchCompute(false);
  } else if (!backendUrl) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("cloud.need_orch_url")}</span>`;
    cancelActiveCompute();
    runBtn.disabled = false;
    progress.classList.remove("active");
  } else {
    state.cloud.mode = "cloud";
    state.cloud.orchestratorUrl = backendUrl;
    (async () => {
      let ready = false;
      try {
        ready = await ensureCloudVm(backendUrl, () => gen !== state.computeGen);
      } catch (err) {
        if (gen !== state.computeGen) return;
        console.warn("[cloud] VM unavailable, falling back to browser:", err);
        const bootFailed = err && err.reason === "boot_failed";
        status.textContent = t(bootFailed ? "cloud.boot_failed" : "cloud.orch_unreachable");
        if (state.lastRun) state.lastRun.backend = false;
        // A boot_failed VM may have actually started before going unhealthy —
        // best-effort stop it so it doesn't linger (the lease is the backstop).
        if (bootFailed) stopCloudVm(backendUrl);
        state.cloud.mode = "browser"; // computeDone must not try to stop a VM that never started
        dispatchCompute(false);
        return;
      }
      if (gen !== state.computeGen || !ready) return;
      startCloudKeepalive(backendUrl);
      dispatchCompute(true);
    })();
  }
});

// ------- Render -------
function renderResult({ energy, passes, path, pathEnergy, pathLengthM, routes, elapsedMs, energyAlt, passesAlt }) {
  // A grid result supersedes any graph-mode overlay.
  removeGraphLayers();
  state.lastGraphResult = null;
  state.graphEnergyRaster = null;
  // Cache for live re-render on colormap / view / range changes.
  state.lastResult = {
    energy, passes, path, pathEnergy, pathLengthM, routes, elapsedMs,
    energyAlt: energyAlt || null,
    passesAlt: passesAlt || null,
  };

  // The displayed-scenario selector only makes sense after a compare run.
  const srcRow = document.getElementById("energy-source-row");
  if (srcRow) srcRow.style.display = (energyAlt || passesAlt) ? "" : "none";
  if (!energyAlt && !passesAlt) {
    const sel = document.getElementById("energy-source");
    if (sel) sel.value = "constrained";
  }

  // Auto bounds (state.lastAutoMin/Max and lastPassesAutoMin/Max) are
  // populated by renderFieldToDataURL during rerenderCachedResult below
  // — both layers use percentile clipping by default and the resolved
  // bounds come back from the renderer.

  // Show/hide the passes layer controls based on whether passes was computed
  const passesRow = document.getElementById("passes-row");
  if (passesRow) passesRow.style.display = passes ? "" : "none";
  const passesVisRow = document.getElementById("passes-vis-row"); // modal vis/opacity row
  if (passesVisRow) passesVisRow.style.display = passes ? "" : "none";

  rerenderCachedResult();

  const meta = [];
  // rerenderCachedResult populates state.lastAutoMax /
  // state.lastPassesAutoMax with the renderer's resolved upper bounds
  // (after percentile clipping etc.). Earlier code referenced bare
  // `autoMax` / `passesMax` here, which were never declared — left over
  // from a refactor that broke the metadata line silently until the
  // length-DP path actually triggered the renderer in a state that
  // exposed the unhandled exception.
  const eHi = state.lastAutoMax;
  if (Number.isFinite(eHi)) {
    meta.push(`max E: <span class="v">${eHi.toExponential(2)}</span>`);
  }
  meta.push(`time: <span class="v">${elapsedMs.toFixed(0)} ms</span>`);
  if (passes) {
    const pHi = state.lastPassesAutoMax;
    if (Number.isFinite(pHi)) {
      meta.push(`max passes: <span class="v">${pHi.toExponential(2)}</span>`);
    }
  }
  if (routes && routes.length) {
    meta.push(`<span class="v">${routes.length}</span> route${routes.length === 1 ? "" : "s"}:`);
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      meta.push(
        `  ${i + 1}. E=<span class="v">${r.energy.toExponential(2)}</span>, ` +
        `L=<span class="v">${(r.length / 1000).toFixed(2)} km</span>` +
        (r.shared > 0 ? `, shared <span class="v">${r.shared}</span>` : "")
      );
    }
  } else if (pathEnergy != null) {
    meta.push(`path E: <span class="v">${pathEnergy.toExponential(3)}</span>`);
    meta.push(`length: <span class="v">${(pathLengthM / 1000).toFixed(2)} km</span>`);
  }
  resultMeta.innerHTML = meta.join("<br/>");
}

// Re-render the cached energy + passes overlays with the currently-selected
// colormap. Called from renderResult (after a compute), from the colormap
// selector, and from any of the per-field range inputs.
function rerenderCachedResult() {
  // Graph-mode results live on their own vector layer — recolor them and skip
  // the raster pipeline entirely (style knobs still apply, no recompute).
  if (state.lastGraphResult && graphModeActive()) { renderGraphOverlay(); return; }
  // Reverted to grid rendering — drop any leftover graph overlay.
  removeGraphLayers();
  const r = state.lastResult;
  if (!r || !state.dem) return;
  const { path, routes } = r;
  const { H, W, originX, originY, dx, dy, isGeographic } = state.dem;

  // After a compare run, the scenario selector switches BOTH layers.
  // Energy: constrained (default) / unconstrained / difference field.
  // Passes: constrained / unconstrained, and in "difference" mode the two
  // scenarios render TOGETHER — constrained in light red, unconstrained in
  // light green, shared scale (no subtraction; overlap blends to yellow).
  // Pure re-render — no recompute.
  const energySel = document.getElementById("energy-source")?.value || "constrained";
  const energy = (r.energyAlt && energySel !== "constrained" && r.energyAlt[energySel])
    ? r.energyAlt[energySel]
    : r.energy;
  const dualPasses = energySel === "difference" && r.passes && r.passesAlt?.unconstrained;
  const dualRow = document.getElementById("passes-dual-row");
  if (dualRow) dualRow.style.display = dualPasses ? "" : "none";
  // The "Network (constrained)" label sits above the shared A-channel controls;
  // only meaningful in the difference view (where the B/terrain channel exists).
  const netLabel = document.getElementById("passes-net-label");
  if (netLabel) netLabel.style.display = dualPasses ? "flex" : "none";
  const passes = (r.passesAlt && energySel === "unconstrained" && r.passesAlt.unconstrained)
    ? r.passesAlt.unconstrained
    : r.passes;

  // -- Energy layer. In density mode this is the per-cell mean energy
  // across reference points (Infinity where unreachable from every ref);
  // otherwise it's the regular src/dst Dijkstra output. Default range
  // is percentile-clipped at p1/p80 — the long tail of "very far from
  // src" cells dominated the raw min/max stretch and washed everything
  // else into the bottom of the colormap.
  if (energy) {
    const out = renderFieldToDataURL(energy, W, H, {
      usePercentileBounds: true,
      percentiles: [1, 80],
      userMin: readRangeInput("vmin", null),
      userMax: readRangeInput("vmax", null),
      useGreyscale: false,
      treatZeroAsTransparent: false,
    });
    state.energyDataUrl = out.url;
    state.lastAutoMin = out.lo;
    state.lastAutoMax = out.hi;
  } else {
    state.energyDataUrl = null;
  }

  // -- Passes layer (greyscale, mirrors energy's absolute-range UI) --
  // Greyscale so additive blending on top of the colour-mapped energy
  // brightens "highway" cells without imposing its own hue. When blend
  // mode is "normal" the renderer paints with full alpha so dim cells
  // read as solid black instead of transparent.
  if (passes && dualPasses) {
    const gamma = parseFloat(document.getElementById("passes-gamma")?.value);
    const win = parseInt(document.getElementById("passes-mean-window")?.value, 10);
    const gammaB = parseFloat(document.getElementById("passes-gamma-b")?.value);
    const winB = parseInt(document.getElementById("passes-mean-window-b")?.value, 10);
    const out = renderDualPassesToDataURL(r.passes, r.passesAlt.unconstrained, W, H, {
      userMin: readRangeInput("passes-vmin", null),
      userMax: readRangeInput("passes-vmax", null),
      gamma: Number.isFinite(gamma) ? gamma : 1,
      meanWindow: Number.isFinite(win) && win > 1 ? win : 1,
      userMinB: readRangeInput("passes-vmin-b", null),
      userMaxB: readRangeInput("passes-vmax-b", null),
      gammaB: Number.isFinite(gammaB) ? gammaB : null,
      meanWindowB: Number.isFinite(winB) ? winB : null,
    });
    state.passesDataUrl = out.url;
    state.lastPassesAutoMin = out.lo;
    state.lastPassesAutoMax = out.hi;
  } else if (passes) {
    const blend = document.getElementById("passes-blend")?.value || "plus-lighter";
    const gamma = parseFloat(document.getElementById("passes-gamma")?.value);
    const win = parseInt(document.getElementById("passes-mean-window")?.value, 10);
    // "energy" blend: corridors take the energy field's colour (same
    // resolved lo/hi as the energy layer, rendered just above) and the
    // passes intensity drives the OPACITY — vmin/vmax/gamma shape the
    // alpha ramp. Falls back to greyscale when no energy field exists.
    const energyColor = blend === "energy" && energy && Number.isFinite(state.lastAutoMin);
    const out = renderFieldToDataURL(passes, W, H, {
      // p10/p90 default; passes counts are heavily long-tailed and a few
      // "highway" cells would otherwise dominate the stretch.
      usePercentileBounds: true,
      percentiles: [10, 90],
      userMin: readRangeInput("passes-vmin", null),
      userMax: readRangeInput("passes-vmax", null),
      gamma: Number.isFinite(gamma) ? gamma : 1,
      meanWindow: Number.isFinite(win) && win > 1 ? win : 1,
      useGreyscale: !energyColor,
      colorField: energyColor
        ? { field: energy, lo: state.lastAutoMin, hi: state.lastAutoMax }
        : null,
      solidAlpha: blend === "normal",
      treatZeroAsTransparent: true,
    });
    state.passesDataUrl = out.url;
    state.lastPassesAutoMin = out.lo;
    state.lastPassesAutoMax = out.hi;
  } else {
    state.passesDataUrl = null;
  }

  // Apply both overlays to the map (creates / updates Leaflet layers).
  applyEnergyOverlay();
  applyPassesOverlay();
  applyLayerControls(); // visibility/opacity/blend

  // Clear existing route polylines before redrawing
  if (state.pathLine) { state.pathLine.remove(); state.pathLine = null; }
  if (state.routeLines) {
    for (const ln of state.routeLines) ln.remove();
  }
  state.routeLines = [];

  function pathToLatLngs(p) {
    return p.map((idx) => {
      const rr = (idx / W) | 0;
      const cc = idx - rr * W;
      return [originY - (rr + 0.5) * dy, originX + (cc + 0.5) * dx];
    });
  }

  if (routes && routes.length > 0 && isGeographic) {
    // Top-N: colour each route by rank using the routes-colormap, with a
    // weight that decays slightly so the optimal route reads strongest.
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const colour = routeColour(i, routes.length);
      const weight = Math.max(2.5, 5 - i * 0.4);
      const opacity = Math.max(0.55, 0.95 - i * 0.05);
      const ln = L.polyline(pathToLatLngs(r.path), {
        color: colour, weight, opacity, pane: "routesPane",
      }).bindTooltip(`route ${i + 1} · E ${r.energy.toExponential(2)} · ${(r.length / 1000).toFixed(2)} km`).addTo(map);
      state.routeLines.push(ln);
    }
  } else if (path && path.length > 0 && isGeographic) {
    state.pathLine = L.polyline(pathToLatLngs(path), {
      color: "#4cc9f0", weight: 4, opacity: 0.95, pane: "routesPane",
    }).addTo(map);
  }

  // Update the legend's numeric ticks to reflect the current mapping.
  updateLegendTicks();
  // Update placeholders so the user can see what "auto" is currently using.
  syncRangePlaceholders();
  // Whatever style was rendered is now the "clean" snapshot. Any input
  // change after this point will re-mark dirty.
  clearStyleDirty();
}

// Separable 2D box blur. Treats the input as zero-padded outside the grid;
// unsettled cells (value 0 in the passes field) get averaged in, which lets
// the smoothed field bleed slightly past the original settled extent — the
// natural "blur" look the user wants.
function boxBlur2D(field, W, H, win) {
  const N = W * H;
  if (win <= 1) return field;
  const half = (win - 1) >> 1;
  const tmp = new Float64Array(N);
  // Horizontal pass: sliding-window mean over each row.
  for (let r = 0; r < H; r++) {
    const rowOff = r * W;
    let sum = 0, count = 0;
    for (let c = 0; c <= half && c < W; c++) {
      sum += field[rowOff + c];
      count++;
    }
    tmp[rowOff] = sum / count;
    for (let c = 1; c < W; c++) {
      const addC = c + half;
      const remC = c - half - 1;
      if (addC < W) { sum += field[rowOff + addC]; count++; }
      if (remC >= 0) { sum -= field[rowOff + remC]; count--; }
      tmp[rowOff + c] = sum / count;
    }
  }
  // Vertical pass over tmp.
  const out = new Float64Array(N);
  for (let c = 0; c < W; c++) {
    let sum = 0, count = 0;
    for (let r = 0; r <= half && r < H; r++) {
      sum += tmp[r * W + c];
      count++;
    }
    out[c] = sum / count;
    for (let r = 1; r < H; r++) {
      const addR = r + half;
      const remR = r - half - 1;
      if (addR < H) { sum += tmp[addR * W + c]; count++; }
      if (remR >= 0) { sum -= tmp[remR * W + c]; count--; }
      out[r * W + c] = sum / count;
    }
  }
  return out;
}

// Render a 2D scalar field to a base64 dataURL.
// Range: vmin/vmax in real units. When both blank → auto, from the percentile
// clip (`opts.percentiles`, default [10, 90]; all callers set
// usePercentileBounds:true). Mapping is linear lo→hi.
// Returns { url, lo, hi } so the caller can record the resolved bounds
// for the legend / placeholder display.
// `useGreyscale: true` paints a black→white ramp instead of the active
// colormap — used for the passes layer.
// `meanWindow > 1` applies a separable box-blur prefilter (treats unsettled
// cells as zero, so the smoothed field bleeds slightly outside the original
// settled extent — that's the desired blur look).
// `gamma`: exponent γ such that `t' = t^γ`. γ=1 → identity. γ=2 squares
// the intensity (darkens dim cells). γ=0.5 takes the square root
// (brightens dim cells).
function renderFieldToDataURL(field, W, H, opts) {
  const N = W * H;

  // Optional mean filter. boxBlur returns a fresh Float64Array.
  const work = opts.meanWindow && opts.meanWindow > 1
    ? boxBlur2D(field, W, H, opts.meanWindow)
    : field;

  // Resolve bounds.
  let autoLo = Infinity, autoHi = 0;
  if (opts.usePercentileBounds) {
    const [pLo, pHi] = opts.percentiles || [10, 90];
    // Reservoir-sample valid cells into a fixed-size Float32Array.
    // Pushing every valid value into a regular Array OOMs the tab on
    // 100M+-cell DEMs (multi-GB heap) — the typed-array reservoir
    // gives sub-1% percentile accuracy at 100k samples regardless
    // of N. Same pattern as renderReliefToDataURL.
    const SAMPLE_CAP = 100_000;
    const samples = new Float32Array(SAMPLE_CAP);
    let collected = 0;
    let seen = 0;
    for (let i = 0; i < N; i++) {
      const v = work[i];
      if (!Number.isFinite(v) || (opts.treatZeroAsTransparent && v <= 0)) continue;
      if (collected < SAMPLE_CAP) {
        samples[collected++] = v;
      } else {
        const j = Math.floor(Math.random() * (seen + 1));
        if (j < SAMPLE_CAP) samples[j] = v;
      }
      seen++;
    }
    if (collected > 0) {
      // Float32Array.sort sorts numerically by default; a comparator would
      // box every value to a Number wrapper.
      const sorted = samples.subarray(0, collected).slice().sort();
      // Clamp: p=100 would otherwise index sorted[length] (undefined).
      const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
      autoLo = at(pLo);
      autoHi = at(pHi);
    }
  }
  if (opts.autoMin != null) autoLo = opts.autoMin;
  if (opts.autoMax != null) autoHi = opts.autoMax;

  // Every caller passes usePercentileBounds:true, so bounds come from the
  // percentile clip above and the value→colour mapping is always linear
  // (lo→hi). The old raw-min/max auto path + sqrt-stretch branch had no caller
  // and was removed; pin either bound (userMin/userMax) for manual clamping.
  let lo = opts.userMin != null ? opts.userMin : autoLo;
  let hi = opts.userMax != null ? opts.userMax : autoHi;
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
  const span = hi - lo;
  const gammaExp = Math.max(0.01, opts.gamma ?? 1);

  // Stride-downsample the canvas on huge DEMs so createImageData can't OOM
  // the tab (stride=1 → byte-identical to full-res for DEMs under the cap).
  const { stride, outW, outH } = overlayCanvasDims(W, H);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(outW, outH);

  // Optional second field driving the COLOUR while the primary field
  // drives the ALPHA ("energy color" passes blend): hue from
  // colormap((colorField - lo) / span) with the caller-supplied bounds
  // (the energy layer's resolved lo/hi, so corridors match its legend),
  // opacity from the primary t (so passes vmin/vmax/gamma shape the
  // alpha ramp). Cells where the colour field is Infinity but the
  // primary is drawn (e.g. over-budget corridor cells in round/total
  // mode) clamp to the top colour — they're beyond the displayed max.
  const cfField = opts.colorField ? opts.colorField.field : null;
  let cfLo = 0, cfSpan = 1;
  if (opts.colorField) {
    cfLo = opts.colorField.lo;
    cfSpan = opts.colorField.hi - opts.colorField.lo;
    if (!Number.isFinite(cfLo)) cfLo = 0;
    if (!Number.isFinite(cfSpan) || cfSpan <= 0) cfSpan = 1;
  }

  // Iterate output pixels; sample the source field at the chosen stride.
  // `i` indexes the full-res field (and colorField), `o` the output canvas.
  for (let or = 0; or < outH; or++) {
    const srcR = or * stride;
    for (let oc = 0; oc < outW; oc++) {
      const i = srcR * W + oc * stride;
      const o = or * outW + oc;
      const v = work[i];
      // v <= 0 matches the percentile sampler's exclusion above (the two
      // predicates used to disagree: sampler v<=0, paint v===0, so negatives
      // were dropped from the bounds yet still painted).
      const unsettled =
        !Number.isFinite(v) || (opts.treatZeroAsTransparent && v <= 0);
      if (unsettled) {
        img.data[4 * o + 3] = 0;
        continue;
      }
      let t = (v - lo) / span;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      // Gamma adjustment: t' = t^γ. γ=1 leaves the mapping unchanged.
      if (gammaExp !== 1) t = Math.pow(t, gammaExp);
      let r2, g2, b2, a2;
      if (cfField) {
        const cv = cfField[i];
        let tc = Number.isFinite(cv) ? (cv - cfLo) / cfSpan : 1;
        if (tc < 0) tc = 0;
        else if (tc > 1) tc = 1;
        [r2, g2, b2] = colormap(tc);
        a2 = Math.round(t * 255);
      } else if (opts.useGreyscale) {
        const g = Math.round(t * 255);
        r2 = g2 = b2 = g;
        // For additive-style blends (plus-lighter, screen, multiply, etc.)
        // alpha=brightness makes black cells contribute nothing while bright
        // cells fully add. For "normal" blend that trick reads wrong (dark
        // cells become transparent and the energy field bleeds through), so
        // we use full alpha and let the slider do the dimming. The flag is
        // set by the renderer based on the active blend mode.
        a2 = opts.solidAlpha ? 255 : g;
      } else {
        [r2, g2, b2] = colormap(t);
        // Fully opaque on the canvas; user-facing dimming comes from the
        // L.imageOverlay opacity slider so that 100% on the slider really
        // means 100% opaque.
        a2 = 255;
      }
      img.data[4 * o + 0] = r2;
      img.data[4 * o + 1] = g2;
      img.data[4 * o + 2] = b2;
      img.data[4 * o + 3] = a2;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { url: canvas.toDataURL(), lo, hi };
}

// Two-scenario passes render for the "difference" view: constrained passes in
// ORANGE, unconstrained in AZURE BLUE, ADDITIVELY blended on a SHARED scale.
// The bases are additive complements (sum = white), so overlap goes to MAX
// brightness where both scenarios route together, and the alpha adds too so
// coincident corridors pop. The blue–orange axis stays discriminable under
// red–green colour-blindness (unlike the old red/green). No subtraction — the
// user reads where each scenario routes its traffic.
// Per-channel controls: the A (orange/constrained = network) channel uses the
// regular passes inputs; the B (blue/unconstrained = terrain) channel takes
// optional overrides that fall back to A's RESOLVED values when blank — so by
// default both channels share one scale (comparable), and each knob can diverge
// independently. Auto bounds are p10/p90 over BOTH fields' positive cells.
function renderDualPassesToDataURL(constrained, unconstrained, W, H, opts) {
  const N = W * H;
  const winA = opts.meanWindow && opts.meanWindow > 1 ? opts.meanWindow : 1;
  const winB = opts.meanWindowB && opts.meanWindowB > 1
    ? opts.meanWindowB
    : (opts.meanWindowB == null ? winA : 1);
  const a = winA > 1 ? boxBlur2D(constrained, W, H, winA) : constrained;
  const b = winB > 1 ? boxBlur2D(unconstrained, W, H, winB) : unconstrained;

  // Shared auto bounds: reservoir-sample positive cells from both fields.
  const SAMPLE_CAP = 100_000;
  const samples = new Float32Array(SAMPLE_CAP);
  let collected = 0, seen = 0;
  for (const f of [a, b]) {
    for (let i = 0; i < N; i++) {
      const v = f[i];
      if (!Number.isFinite(v) || v <= 0) continue;
      if (collected < SAMPLE_CAP) samples[collected++] = v;
      else {
        const j = Math.floor(Math.random() * (seen + 1));
        if (j < SAMPLE_CAP) samples[j] = v;
      }
      seen++;
    }
  }
  let autoLo = 0, autoHi = 1;
  if (collected > 0) {
    const sorted = samples.subarray(0, collected).slice().sort();
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
    autoLo = at(10);
    autoHi = at(90);
  }
  let lo = opts.userMin != null ? opts.userMin : autoLo;
  let hi = opts.userMax != null ? opts.userMax : autoHi;
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
  const span = hi - lo;
  const gammaExp = Math.max(0.01, opts.gamma ?? 1);
  // Green channel: explicit overrides, else inherit red's resolved values.
  let loB = opts.userMinB != null ? opts.userMinB : lo;
  let hiB = opts.userMaxB != null ? opts.userMaxB : hi;
  if (!Number.isFinite(loB)) loB = lo;
  if (!Number.isFinite(hiB) || hiB <= loB) hiB = loB + 1;
  const spanB = hiB - loB;
  const gammaExpB = Math.max(0.01, opts.gammaB ?? gammaExp);

  // Channel bases on the COLOURBLIND-SAFE blue–yellow opponent axis (survives
  // red–green CVD, unlike the old red/green), picked as ADDITIVE COMPLEMENTS so
  // their per-channel sum is exactly white (255,255,255) = maximum brightness
  // where both scenarios route together; each alone is maximally discriminable.
  const RA = 255, GA = 165, BA = 60;   // warm orange — A = constrained (network)
  const RB = 0,   GB = 90,  BB = 195;  // azure blue  — B = unconstrained (terrain)

  // Stride-downsample on huge DEMs (stride=1 → byte-identical under the cap).
  const { stride, outW, outH } = overlayCanvasDims(W, H);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(outW, outH);
  for (let or = 0; or < outH; or++) {
    const srcR = or * stride;
    for (let oc = 0; oc < outW; oc++) {
      const i = srcR * W + oc * stride;
      const o = or * outW + oc;
      let tA = (a[i] - lo) / span;
      let tB = (b[i] - loB) / spanB;
      // Full clamp on BOTH ends: a value below the channel's min must floor
      // at 0, not go negative — a negative channel would subtract from the
      // additive sum and could erase the other channel entirely.
      if (!Number.isFinite(tA) || a[i] <= 0 || tA < 0) tA = 0;
      else if (tA > 1) tA = 1;
      if (!Number.isFinite(tB) || b[i] <= 0 || tB < 0) tB = 0;
      else if (tB > 1) tB = 1;
      if (tA <= 0 && tB <= 0) { img.data[4 * o + 3] = 0; continue; }
      if (gammaExp !== 1 && tA > 0) tA = Math.pow(tA, gammaExp);
      if (gammaExpB !== 1 && tB > 0) tB = Math.pow(tB, gammaExpB);
      img.data[4 * o + 0] = Math.min(255, Math.round(RA * tA + RB * tB));
      img.data[4 * o + 1] = Math.min(255, Math.round(GA * tA + GB * tB));
      img.data[4 * o + 2] = Math.min(255, Math.round(BA * tA + BB * tB));
      img.data[4 * o + 3] = Math.min(255, Math.round((tA + tB) * 255));
    }
  }
  ctx.putImageData(img, 0, 0);
  return { url: canvas.toDataURL(), lo, hi };
}

// ============================================================================
// DEM relief layer (elevation + slope hillshade)
// ============================================================================
// Visualises the loaded DEM as cmocean.phase-coloured elevation with a
// white-to-black slope multiplied on top. Both layers share one rendered
// PNG (single Leaflet imageOverlay, single visibility/opacity control) so
// flat terrain reads as the pure elevation colour and steep terrain
// darkens — the classic hillshade aesthetic where cliffs and ridges read
// as shadow.
//
// Spec (fixed, no UI knobs for now):
//   elevation range  : p5 → p80 percentile of valid heights
//   slope range      : 0   → p80 percentile of |∇h| (m/m)
//   slope gamma      : 1.2 (out = pow(slope_norm, 1/1.2))
//   slope colour ramp: white → black   (slope=0 → 1.0, slope=p80 → 0.0)
//   composite        : multiply         out_rgb = elev_rgb · slopeFactor
//   colormap         : cmo_phase (cyclic, perceptually uniform)

// Central-difference slope magnitude in m/m. Edge cells use replicated
// boundary; masked neighbours fall back to the cell's own height (so a
// nodata strip at the DEM edge produces zero slope rather than a wild
// fictitious gradient).
function computeSlope(height, mask, H, W, dxM, dyM) {
  const slope = new Float32Array(H * W);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!mask[i]) continue;
      const cw = c > 0     ? c - 1 : c;
      const ce = c < W - 1 ? c + 1 : c;
      const rn = r > 0     ? r - 1 : r;
      const rs = r < H - 1 ? r + 1 : r;
      const wIdx = r  * W + cw;
      const eIdx = r  * W + ce;
      const nIdx = rn * W + c;
      const sIdx = rs * W + c;
      const h0 = height[i];
      const hw = mask[wIdx] ? height[wIdx] : h0;
      const he = mask[eIdx] ? height[eIdx] : h0;
      const hn = mask[nIdx] ? height[nIdx] : h0;
      const hs = mask[sIdx] ? height[sIdx] : h0;
      const spanX = (ce - cw) * dxM;
      const spanY = (rs - rn) * dyM;
      const dhdx = spanX > 0 ? (he - hw) / spanX : 0;
      const dhdy = spanY > 0 ? (hs - hn) / spanY : 0;
      slope[i] = Math.sqrt(dhdx * dhdx + dhdy * dhdy);
    }
  }
  return slope;
}

// Sample size for percentile estimation. 100k samples gives a sub-1 %
// error on p5/p80 of a smooth distribution — well below the visual
// resolution of the colormap. Using regular JS arrays here would balloon
// to multi-gig heaps on a 135 M-cell DEM (the "Sampa Sítio Urbano" case)
// and OOM the tab; typed arrays at fixed size keep this <1 MB regardless.
const RELIEF_PERCENTILE_SAMPLES = 100_000;

// Cap on the canvas backing buffer. Above ~10 M pixels Chrome refuses
// to allocate ImageData, and even when it succeeds the toDataURL cost
// dominates. We downsample by an integer stride and let Leaflet's
// imageOverlay scale the result up to the DEM extent — Leaflet uses
// CSS image-rendering, so the texture maps cleanly across the bounds.
const RELIEF_MAX_CANVAS_PX = 10 * 1024 * 1024;

// Shared canvas cap for the field overlays (energy / passes / impassable),
// mirroring the relief renderer. Above RELIEF_MAX_CANVAS_PX cells we render the
// canvas at an integer-strided lower resolution and let Leaflet's imageOverlay
// scale the texture across the same DEM bounds. Without this, createImageData
// at the full W*H OOMs the tab on huge DEMs (the documented 135 M-cell case
// allocates ~540 MB before toDataURL even runs). Returns stride=1 (byte-
// identical to the old full-res path) for any DEM under the cap.
function overlayCanvasDims(W, H) {
  const N = W * H;
  let stride = 1;
  if (N > RELIEF_MAX_CANVAS_PX) stride = Math.ceil(Math.sqrt(N / RELIEF_MAX_CANVAS_PX));
  return { stride, outW: Math.max(1, Math.floor(W / stride)), outH: Math.max(1, Math.floor(H / stride)) };
}

function renderReliefToDataURL(dem, slope) {
  const { H, W, height, mask } = dem;
  const N = H * W;

  // ---- Reservoir-sample valid (height, slope) pairs for percentiles --
  const eSamples = new Float32Array(RELIEF_PERCENTILE_SAMPLES);
  const sSamples = new Float32Array(RELIEF_PERCENTILE_SAMPLES);
  let collected = 0;
  let seen = 0; // count of valid cells visited
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    if (collected < RELIEF_PERCENTILE_SAMPLES) {
      eSamples[collected] = height[i];
      sSamples[collected] = slope[i];
      collected++;
    } else {
      // Standard reservoir step: replace position j (uniform in [0, seen])
      // with probability k/seen; here that simplifies to "pick a slot".
      const j = Math.floor(Math.random() * (seen + 1));
      if (j < RELIEF_PERCENTILE_SAMPLES) {
        eSamples[j] = height[i];
        sSamples[j] = slope[i];
      }
    }
    seen++;
  }
  if (collected === 0) return null;

  // Float32Array.sort sorts numerically by default — no comparator needed
  // (and passing one would coerce values to objects, defeating the point).
  const eSorted = eSamples.subarray(0, collected).slice().sort();
  const sSorted = sSamples.subarray(0, collected).slice().sort();
  const elevMin  = percentileFromSorted(eSorted, 5);
  const elevMax  = percentileFromSorted(eSorted, 80);
  const slopeMax = Math.max(1e-9, percentileFromSorted(sSorted, 80));
  const elevSpan = elevMax - elevMin;

  // ---- Decide canvas size — downsample if the DEM is too big -------
  let stride = 1;
  if (N > RELIEF_MAX_CANVAS_PX) {
    stride = Math.ceil(Math.sqrt(N / RELIEF_MAX_CANVAS_PX));
  }
  const outW = Math.max(1, Math.floor(W / stride));
  const outH = Math.max(1, Math.floor(H / stride));

  // cmo_phase is cyclic — values that wrap past 1.0 alias to the same
  // hue as 0.0, which is fine since we clip to [0, 1].
  const phaseMap = COLORMAPS.cmo_phase;
  const phaseN = phaseMap.length - 1;

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(outW, outH);
  const data = imageData.data;

  const invGamma = 1 / 1.2;

  // ---- Render at the (possibly downsampled) output resolution ------
  for (let or = 0; or < outH; or++) {
    const srcR = or * stride;
    for (let oc = 0; oc < outW; oc++) {
      const srcC = oc * stride;
      const srcI = srcR * W + srcC;
      const j = (or * outW + oc) * 4;
      if (!mask[srcI]) {
        data[j + 3] = 0; // transparent over nodata
        continue;
      }

      // -- Elevation lookup
      let er, eg, eb;
      if (elevSpan > 0) {
        const t = Math.max(0, Math.min(1, (height[srcI] - elevMin) / elevSpan));
        const f = t * phaseN;
        const k = Math.floor(f);
        const frac = f - k;
        const a = phaseMap[Math.min(k, phaseN)];
        const b = phaseMap[Math.min(k + 1, phaseN)];
        er = a[0] + (b[0] - a[0]) * frac;
        eg = a[1] + (b[1] - a[1]) * frac;
        eb = a[2] + (b[2] - a[2]) * frac;
      } else {
        // Pathological DEM (all same elevation) — paint mid-colormap.
        const a = phaseMap[Math.floor(phaseN / 2)];
        er = a[0]; eg = a[1]; eb = a[2];
      }

      // -- Slope as gamma-corrected white→black multiplier.
      //    slope=0   → factor 1.0 (multiplying by white leaves elev alone)
      //    slope=p80 → factor 0.0 (multiplying by black collapses to black)
      const sNorm = Math.min(1, slope[srcI] / slopeMax);
      const sGamma = Math.pow(sNorm, invGamma);
      const slopeFactor = 1 - sGamma;
      data[j]     = Math.round(er * slopeFactor);
      data[j + 1] = Math.round(eg * slopeFactor);
      data[j + 2] = Math.round(eb * slopeFactor);
      data[j + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}

function applyDemReliefOverlay() {
  if (state.demReliefOverlay) {
    state.demReliefOverlay.remove();
    state.demReliefOverlay = null;
  }
  if (!state.dem || !state.dem.isGeographic || !state.demReliefDataUrl) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  const bounds = [[originY - H * dy, originX], [originY, originX + W * dx]];
  state.demReliefOverlay = L.imageOverlay(
    state.demReliefDataUrl,
    bounds,
    { opacity: 0.85, pane: "reliefPane" },
  ).addTo(map);
}

function impassableOverlayOpacity() {
  const v = parseFloat(document.getElementById("imp-opacity")?.value);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

// Paint the EFFECTIVE impassable state to a dataURL for verification: blocked
// water red, reopened bridge corridors green. Returns null when nothing to show.
function renderImpassableDataURL() {
  if (!state.dem || !state.impassable) return null;
  const { H, W } = state.dem;
  const imp = state.impassable;
  // Stride-downsample on huge DEMs (stride=1 → identical under the cap). These
  // are SPARSE features, so we SCATTER each blocked/corridor cell into its
  // downsampled output pixel (point-sampling the strided grid would skip most
  // of them and the overlay would look empty).
  const { stride, outW, outH } = overlayCanvasDims(W, H);
  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(outW, outH);
  const d = img.data;
  const outIdx = (i) => { const r = (i / W) | 0, c = i - r * W; return (((r / stride) | 0) * outW + ((c / stride) | 0)) << 2; };
  for (let i = 0; i < imp.length; i++) {
    if (imp[i]) { const o = outIdx(i); d[o] = 220; d[o + 1] = 48; d[o + 2] = 48; d[o + 3] = 255; } // blocked
  }
  const cells = state.corridorCells;
  if (cells) for (let k = 0; k < cells.length; k++) {
    const o = outIdx(cells[k]); d[o] = 40; d[o + 1] = 200; d[o + 2] = 90; d[o + 3] = 255; // corridor
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

// Build the impassable-layer Leaflet imageOverlay from the current mask +
// corridors. Driven by the #imp-show / #imp-opacity controls in group 1c.
function applyImpassableOverlay() {
  if (state.impassableOverlay) { state.impassableOverlay.remove(); state.impassableOverlay = null; }
  const show = !!document.getElementById("imp-show")?.checked;
  if (!show || !state.dem || !state.dem.isGeographic || !state.impassable) return;
  const url = renderImpassableDataURL();
  if (!url) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  const bounds = [[originY - H * dy, originX], [originY, originX + W * dx]];
  state.impassableOverlay = L.imageOverlay(url, bounds, {
    opacity: impassableOverlayOpacity(), pane: "impassablePane",
  }).addTo(map);
}

// Linearly interpolate the p-th percentile (0..100) from a sorted ascending
// array. Returns NaN if the array is empty.
function percentileFromSorted(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  const t = Math.max(0, Math.min(100, p)) / 100;
  const f = t * (n - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = f - i0;
  return sorted[i0] + (sorted[i1] - sorted[i0]) * frac;
}

// Build the energy-layer Leaflet imageOverlay from the cached dataURL.
function applyEnergyOverlay() {
  if (state.energyOverlay) { state.energyOverlay.remove(); state.energyOverlay = null; }
  if (!state.dem || !state.dem.isGeographic || !state.energyDataUrl) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  const bounds = [[originY - H * dy, originX], [originY, originX + W * dx]];
  state.energyOverlay = L.imageOverlay(state.energyDataUrl, bounds, { opacity: 0.85, pane: "energyPane" }).addTo(map);
}

// Build the passes-layer Leaflet imageOverlay. Its pane (z 404) sits above
// energy (402) AND the drawn vector network (403), so corridors paint over
// the black network lines.
function applyPassesOverlay() {
  if (state.passesOverlay) { state.passesOverlay.remove(); state.passesOverlay = null; }
  if (!state.dem || !state.dem.isGeographic || !state.passesDataUrl) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  const bounds = [[originY - H * dy, originX], [originY, originX + W * dx]];
  state.passesOverlay = L.imageOverlay(state.passesDataUrl, bounds, { opacity: 0.7, pane: "passesPane" }).addTo(map);
}

// Apply the live UI controls (visibility, opacity, blend mode) to whichever
// overlays exist. Cheap — no canvas re-render. Also drives the tilemap
// add/remove cycle (we only fetch tiles when the user makes it visible).
function applyLayerControls() {
  // rmsampa-v2 tile overlay
  const tileVis = document.getElementById("tile-visible")?.checked ?? false;
  const tileOpRaw = parseFloat(document.getElementById("tile-opacity")?.value);
  const tileOp = Number.isFinite(tileOpRaw) ? tileOpRaw : 0.85;
  if (tileVis && !state.tileOverlayActive) {
    state.tileOverlay.addTo(map);
    state.tileOverlayActive = true;
  } else if (!tileVis && state.tileOverlayActive) {
    state.tileOverlay.remove();
    state.tileOverlayActive = false;
  }
  if (state.tileOverlayActive) {
    state.tileOverlay.setOpacity(tileOp);
  }

  if (state.demReliefOverlay) {
    const visible = document.getElementById("relief-visible")?.checked ?? false;
    const opacity = parseFloat(document.getElementById("relief-opacity")?.value);
    const op = Number.isFinite(opacity) ? opacity : 0.85;
    state.demReliefOverlay.setOpacity(visible ? op : 0);
  }
  if (state.energyOverlay) {
    const visible = document.getElementById("energy-visible")?.checked ?? true;
    const opacity = parseFloat(document.getElementById("energy-opacity")?.value);
    const op = Number.isFinite(opacity) ? opacity : 0.85;
    state.energyOverlay.setOpacity(visible ? op : 0);
  }
  if (state.passesOverlay) {
    const visible = document.getElementById("passes-visible")?.checked ?? true;
    const opacity = parseFloat(document.getElementById("passes-opacity")?.value);
    const op = Number.isFinite(opacity) ? opacity : 0.7;
    state.passesOverlay.setOpacity(visible ? op : 0);
    const blend = document.getElementById("passes-blend")?.value || "normal";
    const el = state.passesOverlay.getElement();
    // "energy" is a render mode (colour baked into the canvas), not a CSS
    // blend — composite it normally.
    if (el) el.style.mixBlendMode = blend === "energy" ? "normal" : blend;
  }
  // Reference-point markers: show/hide the whole set as a layer toggle.
  if (state.refMarkers) {
    const visible = document.getElementById("refs-visible")?.checked ?? true;
    for (const m of state.refMarkers) {
      if (visible && !map.hasLayer(m)) m.addTo(map);
      else if (!visible && map.hasLayer(m)) m.remove();
    }
  }
  // Graph-mode passes is a vector layer on passesPane (energy is the raster
  // overlay above) — drive its pane opacity + blend from the Passes controls.
  if (state.graphPassesLayer) {
    const visible = document.getElementById("passes-visible")?.checked ?? true;
    const opRaw = parseFloat(document.getElementById("passes-opacity")?.value);
    const op = Number.isFinite(opRaw) ? opRaw : 0.7;
    const blend = document.getElementById("passes-blend")?.value || "normal";
    const pp = map.getPane("passesPane");
    if (pp) {
      pp.style.opacity = String(visible ? op : 0);
      // Additive ("plus-lighter" / soma) blend makes the near-black low-pass
      // lines contribute nothing, leaving only the bright corridors.
      pp.style.mixBlendMode = blend === "energy" ? "normal" : blend;
    }
  }
}

function updateLegendTicks() {
  // Legend reflects the energy layer's mapping. Default auto = p1/p80
  // linear; user-pinned overrides either bound. Mid is the linear
  // midpoint of the value range (close-enough for any reasonable gamma).
  const lo = document.getElementById("legend-lo");
  const mid = document.getElementById("legend-mid");
  const hi = document.getElementById("legend-hi");
  if (!lo || !mid || !hi) return;
  const userMin = readRangeInput("vmin", null);
  const userMax = readRangeInput("vmax", null);
  const a = userMin != null ? userMin : (state.lastAutoMin ?? 0);
  const b = userMax != null ? userMax : (state.lastAutoMax ?? 1);
  lo.textContent = formatEnergy(a);
  mid.textContent = formatEnergy(0.5 * (a + b));
  hi.textContent = formatEnergy(b);
}

function readRangeInput(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  const raw = el.value.trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function isUserPinned(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  const raw = el.value.trim();
  if (raw === "") return false;
  const n = Number(raw);
  return Number.isFinite(n);
}

function syncRangePlaceholders() {
  const lo = document.getElementById("vmin");
  const hi = document.getElementById("vmax");
  if (lo && state.lastAutoMin != null) lo.placeholder = formatEnergy(state.lastAutoMin);
  if (hi && state.lastAutoMax != null) hi.placeholder = formatEnergy(state.lastAutoMax);
  // Passes absolute inputs — placeholders show the auto bounds.
  const pLo = document.getElementById("passes-vmin");
  const pHi = document.getElementById("passes-vmax");
  if (pLo && state.lastPassesAutoMin != null) pLo.placeholder = formatEnergy(state.lastPassesAutoMin);
  if (pHi && state.lastPassesAutoMax != null) pHi.placeholder = formatEnergy(state.lastPassesAutoMax);
}

// Density worker-pool size, shared by the runner and the time estimator so
// they can never drift. Each worker's resident set ≈ DEM copy (height f32 4 +
// mask u8 1 = 5 B/cell) + densityField scratch (E4 + settled1 + parents4 +
// order4 + passes-f32 4 = 17) + outputs (density-f32 4 + energySum-f64 8 +
// energyCount 4 = 16) ≈ 38 B/cell, ~55 in round mode (a second search
// resident). Budgeted against navigator.deviceMemory (GB; the spec CAPS it at
// 8 — a floor on true RAM, never the full amount) with a conservative
// fraction. The optional #max-workers input lets a user on a big-RAM machine
// (which deviceMemory can't see) force more, still clamped by K.
function densityPoolSize({ N, K, round }) {
  if (!K) return 1;
  const cores = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
  const bytesPerWorker = (round ? 55 : 38) * N;
  const devMemGB = navigator.deviceMemory || 4;
  const memBudget = Math.max(1.5e9, devMemGB * 1e9 * 0.45);
  const memCap = Math.max(1, Math.floor(memBudget / bytesPerWorker));
  const userMax = parseInt(document.getElementById("max-workers")?.value, 10);
  const overrideN = Number.isFinite(userMax) && userMax > 0 ? userMax : 0;
  return overrideN
    ? Math.max(1, Math.min(K, overrideN))
    : Math.max(1, Math.min(K, cores, memCap));
}

// Cache the native backend's core count from /health so the time estimate's
// backend-parallelism model reflects the actual server. Only pinged when the
// backend toggle/URL changes (not per estimate). Cleared/ignored when the
// backend is off; falls back to BACKEND_PAR_CAP if unreachable.
async function refreshBackendCores() {
  // Both Localhost and Cloud probe /health; the orchestrator proxies the VM's
  // /health (same fields: cores, mem_budget_bytes) when the VM is up, and
  // returns {ok:false,vmState:…} when it isn't — Number.isFinite gates below
  // tolerate the missing cores, so a stopped VM just leaves the estimate on its
  // fallback parallelism cap until the run boots it.
  if (computeMode() === "browser") { state.backendCores = null; estimateRunTime(); return; }
  const url = effectiveBackendUrl();
  if (!url) { state.backendCores = null; estimateRunTime(); return; }
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const h = await resp.json();
      // mem_budget_bytes lets the estimate replicate the server's slice cap
      // (the dominant backend parallelism limit on huge DEMs). Older backends
      // don't send it — fall back to a default in the estimate.
      if (Number.isFinite(h.cores)) {
        state.backendCores = {
          url, cores: h.cores,
          memBudgetBytes: Number.isFinite(h.mem_budget_bytes) ? h.mem_budget_bytes : null,
        };
      }
    }
  } catch { /* unreachable — estimate falls back to the parallelism cap */ }
  estimateRunTime();
}

// Reconcile the compute-source sub-panels (Localhost URL / Cloud orchestrator)
// to the selected radio, and gate Cloud to local origins. Called on every
// selector change AND on load (the radiogroup is in PERSIST_REFIRE). Mirrors
// the old syncBackend's show/hide, extended to three states.
function syncComputeSourceUI() {
  const mode = computeMode();
  const lh = document.getElementById("localhost-extra");
  const cl = document.getElementById("cloud-extra");
  if (lh) lh.style.display = mode === "localhost" ? "" : "none";
  if (cl) cl.style.display = mode === "cloud" ? "" : "none";
  // Origin gating: Cloud is only usable when the orchestrator (loopback-only)
  // is reachable — i.e. the applet is served locally. Disable the radio and
  // show a note when it isn't; if Cloud was somehow selected, snap to Browser.
  const cloudRadio = document.getElementById("cs-cloud");
  if (cloudRadio && !isLocalOrigin()) {
    cloudRadio.disabled = true;
    if (mode === "cloud") {
      const browserRadio = document.getElementById("cs-browser");
      if (browserRadio) { browserRadio.checked = true; }
      if (cl) cl.style.display = "none";
    }
    const note = ensureCloudLocalOnlyNote();
    if (note) note.style.display = "";
  } else {
    if (cloudRadio) cloudRadio.disabled = false;
    const note = document.getElementById("cloud-local-only-note");
    if (note) note.style.display = "none";
  }
  // Seed the VM-status hint when Cloud is freshly shown (no VM up yet); clear it
  // otherwise. A live boot/stop sequence overwrites it via setCloudHint.
  if (mode === "cloud" && !cloudRadio?.disabled) {
    if (!state.cloud.keepaliveTimer && state.cloud.vmState !== "RUNNING") setCloudHint("cloud.idle");
  } else {
    setCloudHint(null);
  }
}

// Lazily create (once) the "cloud only works locally" note placed right after
// the #cloud-extra block. Text is set through t() so it follows the language.
function ensureCloudLocalOnlyNote() {
  let note = document.getElementById("cloud-local-only-note");
  if (note) { note.textContent = t("cloud.local_only"); return note; }
  const cloudExtra = document.getElementById("cloud-extra");
  if (!cloudExtra || !cloudExtra.parentNode) return null;
  note = document.createElement("div");
  note.id = "cloud-local-only-note";
  // data-i18n lets the standard applyTranslations() walk re-translate the note
  // on a language switch (it's created after the initial walk).
  note.setAttribute("data-i18n", "cloud.local_only");
  note.style.cssText = "font-size: 10px; color: var(--muted); margin-top: 3px;";
  note.textContent = t("cloud.local_only");
  cloudExtra.parentNode.insertBefore(note, cloudExtra.nextSibling);
  return note;
}

// ---- Cloud VM state machine ---------------------------------------------
// Drives the LOCAL orchestrator that fronts a pre-baked compute VM. The RUN
// path calls ensureCloudVm() before dispatching the (unchanged) backend
// density/single fetch against the orchestrator URL. Lease keepalive runs
// while a compute is in flight; the VM is stopped after each run and on tab
// hide (a "stop VM after each run" default-ON behaviour). All status text goes
// through t(); the hint line lives in #cloud-vm-status.
const CLOUD_POLL_MS = 3000;       // /cloud/status poll cadence while booting
const CLOUD_KEEPALIVE_MS = 60000; // lease-extension cadence while computing
const CLOUD_BOOT_TIMEOUT_MS = 300000; // give the VM up to 5 min to go healthy

function setCloudHint(key, ...args) {
  const el = document.getElementById("cloud-vm-status");
  if (el) el.textContent = key ? t(key, ...args) : "";
}

// POST/GET helpers with a short timeout. Throw on transport failure (caller
// maps that to a fallback); a non-ok HTTP status throws too.
async function cloudFetchJson(url, { method = "GET", timeoutMs = 8000 } = {}) {
  const resp = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`orchestrator HTTP ${resp.status}`);
  return resp.json();
}

// Ensure the cloud VM is RUNNING && healthy, then refresh the backend core
// cache against the orchestrator. Resolves true on ready; throws on
// orchestrator-unreachable / boot failure (the caller falls back to browser).
// `gen`/`isStale` let a superseded run bail out of the poll loop.
async function ensureCloudVm(orchUrl, isStale) {
  // Kick the (idempotent) start — returns fast if already RUNNING.
  let started;
  try {
    started = await cloudFetchJson(`${orchUrl}/cloud/start`, { method: "POST", timeoutMs: 10000 });
  } catch (err) {
    state.cloud.vmState = "ERROR";
    throw Object.assign(new Error("orch_unreachable"), { reason: "orch_unreachable", cause: err });
  }
  state.cloud.vmState = started.state || "PROVISIONING";
  const etaS = Number.isFinite(started.etaSeconds) ? started.etaSeconds : 60;
  setCloudHint("cloud.starting", formatDuration(etaS * 1000));
  status.textContent = t("cloud.starting", formatDuration(etaS * 1000));

  // Poll /cloud/status until RUNNING && healthy (or timeout / cancel).
  const deadline = performance.now() + CLOUD_BOOT_TIMEOUT_MS;
  for (;;) {
    if (isStale && isStale()) return false;
    let st;
    try {
      st = await cloudFetchJson(`${orchUrl}/cloud/status`, { method: "GET", timeoutMs: 8000 });
    } catch (err) {
      state.cloud.vmState = "ERROR";
      throw Object.assign(new Error("orch_unreachable"), { reason: "orch_unreachable", cause: err });
    }
    state.cloud.vmState = st.state || state.cloud.vmState;
    if (st.state === "ERROR") {
      throw Object.assign(new Error("boot_failed"), { reason: "boot_failed" });
    }
    if (st.state === "RUNNING" && st.healthy === true) {
      // Cache cores/mem from the status payload (camelCase here) so the
      // estimate's slice model reflects the just-booted VM immediately.
      if (Number.isFinite(st.cores)) {
        state.backendCores = {
          url: orchUrl, cores: st.cores,
          memBudgetBytes: Number.isFinite(st.memBudgetBytes) ? st.memBudgetBytes : null,
        };
      }
      setCloudHint("cloud.ready", Number.isFinite(st.cores) ? st.cores : "?");
      return true;
    }
    if (performance.now() > deadline) {
      throw Object.assign(new Error("boot_failed"), { reason: "boot_failed" });
    }
    await new Promise((r) => setTimeout(r, CLOUD_POLL_MS));
  }
}

// Lease keepalive: while a cloud compute is in flight, extend the VM lease so
// the orchestrator doesn't reap it mid-run. Cleared by stopCloudKeepalive().
function startCloudKeepalive(orchUrl) {
  stopCloudKeepalive();
  state.cloud.keepaliveTimer = setInterval(() => {
    fetch(`${orchUrl}/cloud/keepalive`, { method: "POST", signal: AbortSignal.timeout(8000) })
      .catch(() => { /* best-effort — a missed keepalive just risks an early reap */ });
  }, CLOUD_KEEPALIVE_MS);
}
function stopCloudKeepalive() {
  if (state.cloud.keepaliveTimer) { clearInterval(state.cloud.keepaliveTimer); state.cloud.keepaliveTimer = null; }
}

// Stop the VM now (default-ON "stop after each run"). Best-effort: a POST with
// a short timeout from the in-page path, or a sendBeacon from a page-hide
// handler (which can't await). Always clears the keepalive first.
function stopCloudVm(orchUrl, { beacon = false } = {}) {
  stopCloudKeepalive();
  if (!orchUrl) return;
  if (beacon && navigator.sendBeacon) {
    try { navigator.sendBeacon(`${orchUrl}/cloud/stop`); } catch { /* best-effort */ }
    state.cloud.vmState = "STOPPING";
    return;
  }
  setCloudHint("cloud.stopping");
  state.cloud.vmState = "STOPPING";
  fetch(`${orchUrl}/cloud/stop`, { method: "POST", signal: AbortSignal.timeout(8000) })
    .then(() => { state.cloud.vmState = "STOPPED"; setCloudHint("cloud.stopped_after"); })
    .catch(() => { /* best-effort — the orchestrator's lease will reap it anyway */ });
}

// Calibration probe: each ref runs an UNBUDGETED search stopped after
// PROBE_MAX_SETTLED cells. Capping by cell count (not energy budget) bounds the
// probe's wall time regardless of DEM size — the ≤3 s (ideally ≤1 s) target —
// while anchoring the estimate at an unsaturated point, which fixes the old
// fixed-budget model's up-to-3.8× error on small DEMs it saturated. The few
// spread refs (not 2 central ones) average out per-ref placement variance.
const PROBE_MAX_SETTLED = 1_000_000;
const PROBE_REFS = 3;

// One-shot, off-thread calibration of the compute-time estimate for the
// current DEM. Runs PROBE_REFS budgeted Dijkstras in a dedicated worker,
// measuring the one-time allocation cost and the per-ref search throughput,
// so estimateRunTime() can scale with the energy budget instead of a fixed
// full-grid rate. Generation-guarded (a new DEM load drops a stale result);
// deferred while a real compute is running so it doesn't steal cores.
function startCalibrationProbe() {
  if (!state.dem) return;
  if (state.computeStartedAt) return; // a compute is running — retried in computeDone
  if (state.probeWorker) { state.probeWorker.terminate(); state.probeWorker = null; }

  const { H, W } = state.dem;
  // Probe the EFFECTIVE compute grid (impassable blocked, corridors reopened)
  // so the time estimate reflects the terrain a real run actually traverses.
  const { height: probeHeight, mask } = buildComputeGrid();
  // Two deterministic interior, on-mask reference cells (sample real relief,
  // not a corner). Spiral out from each target to the nearest valid cell.
  const findValid = (r0, c0) => {
    for (let rad = 0; rad < Math.max(H, W); rad++) {
      for (let dr = -rad; dr <= rad; dr += Math.max(1, 2 * rad)) {
        const r = r0 + dr;
        if (r < 0 || r >= H) continue;
        for (let dc = -rad; dc <= rad; dc++) {
          const c = c0 + dc;
          if (c < 0 || c >= W) continue;
          if (mask[r * W + c]) return [r, c];
        }
      }
    }
    return null;
  };
  const refs = [];
  for (const [fr, fc] of [[0.5, 0.5], [0.3, 0.35], [0.7, 0.65]]) {
    const v = findValid(Math.round(fr * H), Math.round(fc * W));
    if (v) refs.push(v);
  }
  if (refs.length < 2) return; // degenerate mask; estimate stays uncalibrated

  const probeGen = state.calibrationGen;
  const alpha = parseFloat(document.getElementById("alpha")?.value) || 0.008;
  const beta = parseFloat(document.getElementById("beta")?.value) || 1.0;
  const eta = parseFloat(document.getElementById("eta")?.value) || 0.1;

  const w = new Worker(WORKER_URL);
  state.probeWorker = w;
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.kind !== "probe-done") return;
    w.terminate();
    if (state.probeWorker === w) state.probeWorker = null;
    if (probeGen !== state.calibrationGen) return; // superseded by a newer DEM
    // Anchor this DEM/terrain's compute model at the probe's UNSATURATED
    // cell-capped point (Estar cells reached at budget bStar, in perRefProbe
    // ms incl. the passes walk). The estimate then scales:
    //   explored(eMax,alpha) = min(N, Estar·(eMax·αprobe/(bStar·α))^EXPLORE_EXP)
    //   perRef(explored)     = perRefProbe·(explored/Estar)^RATE_EXP
    // Anchoring at an unsaturated point (vs the old fixed budget that
    // saturated small DEMs) is what fixes the up-to-3.8× small-DEM error;
    // online correction absorbs the residual exponent/scale drift.
    const Estar = Math.max(1, m.exploredTotal / m.nRefs);
    const bStar = Math.max(1, m.budgetReached);
    const perRefProbe = Math.max(0.01, (m.totalMs - m.allocMs) / m.nRefs);
    state.calibration = {
      N: m.N,
      allocMsN: m.allocMs,
      Estar, bStar, perRefProbe,
      alphaAtProbe: alpha,
      // Online correction: actual/predicted from completed computes, per
      // PHASE/engine (the backend's native-speedup × slice-contention factor,
      // the graph engine's per-edge cost, and the interp fill rate are all
      // scale-/network-dependent, so we learn them rather than guess).
      corrBrowser: 1, corrBackend: 1, corrGraph: 1, corrInterp: 1,
    };
    estimateRunTime();
  };
  w.onerror = () => { w.terminate(); if (state.probeWorker === w) state.probeWorker = null; };

  // Cell cap: bound the probe's search time (the 3 s / ~1 s target) yet stay
  // unsaturated. min(fixed, 0.4·N) keeps it < N (so it always anchors below
  // full grid). On a 135 M-cell DEM ≈ 3×1 M cells ≈ ~1 s search + first-touch.
  const N = H * W;
  const maxSettled = Math.min(PROBE_MAX_SETTLED, Math.max(50_000, Math.floor(0.4 * N)));
  w.postMessage(
    {
      kind: "probe",
      height: probeHeight, mask, H, W,
      dx: state.dem.dxM, dy: state.dem.dyM,
      alpha, beta, eta, maxSettled,
      refPoints: refs,
    },
    [probeHeight.buffer, mask.buffer],
  );
  estimateRunTime(); // show "estimating…" until the probe lands
}

// ------- Compute-time estimation -------
// Calibrated by a per-DEM two-budget probe at load (state.calibration; see
// startCalibrationProbe), which anchors this DEM/terrain at an unsaturated
// cell-capped probe point (Estar cells at budget bStar, perRefProbe ms):
//   explored(eMax,alpha) = min(N, Estar·(eMax·alphaAtProbe/(bStar·alpha))^EXPLORE_EXP)
//   perRef(explored)     = perRefProbe·(explored/Estar)^RATE_EXP
// plus allocMsN (one-time scratch alloc). Online-corrected per engine
// (corrBrowser/corrBackend) from completed computes.
// Tunables:
const EXPLORE_EXP     = 2.1;  // explored ∝ reach^EXPLORE_EXP (reach ∝ eMax/alpha;
                              // area ∝ reach², ~2.1 measured on real terrain).
const RATE_EXP        = 1.1;  // perRef ∝ explored^RATE_EXP (>1 = cache
                              // rate-degradation as the frontier outgrows cache).
const NATIVE_SPEEDUP  = 1.6;  // native per-ref speedup vs JS — nominal; both
                              // converge toward bandwidth-bound on huge
                              // frontiers (~1.3) and diverge on small ones
                              // (~2.4). Online correction adjusts the residual.
const BW_CONTENTION   = 0.2;  // each extra concurrent slice slows the others
                              // ~20% (shared memory bandwidth): a USL penalty.
const BACKEND_PAR_CAP = 8;    // fallback core count when /health is unreachable
// Per-slice scratch+accumulator bytes/cell in the backend (mirrors
// backend/src/main.rs: 17 scratch + 20 acc; round doubles scratch + 1 byte).
const BACKEND_BYTES_PER_CELL = 37;
const BACKEND_BYTES_PER_CELL_ROUND = 55;
// Cloud transfer-size estimate: assumed wire bandwidth (megabits/s) for the
// up/down byte counts → a rough wall-time guess. Nominal home/office values;
// the estimate is informational only (it never gates a run).
const UPLINK_MBPS   = 50;
const DOWNLINK_MBPS = 200;
// Network-graph ("follow the vectors") compute: a graph Dijkstra is ∝ EDGES,
// not raster cells — orders of magnitude cheaper than the grid, so the raster
// model massively over-estimates it. Nominal; corrGraph tunes per network.
const GRAPH_MS_PER_EDGE = 5e-5;
// Network IDW interpolation (separate phase; often DOMINATES when the compute
// is network-constrained or on the graph, since it fills the whole grid while
// the compute touches only network cells/edges). Nominal per-cell rates;
// corrInterp tunes. Fill scales with the ray search distance.
const INTERP_MS_PER_CELL = 5e-6;        // per cell per maxDist unit (banded)
const INTERP_SMOOTH_MS_PER_CELL = 5e-6; // per cell per 3×3 smoothing pass (banded)

// Mirror runInterp's worker-pool sizing so the interp estimate matches the
// real banding (memory-capped on huge DEMs → often 1 worker there).
function interpPoolSize(N) {
  const cores = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
  const H = state.dem?.H || 1;
  return Math.max(1, Math.min(cores, Math.floor(1.5e9 / (6 * N)), Math.ceil(H / 64)));
}

// Graph edge count for the graph-mode estimate — the built graph if cached,
// else the network polyline segment count (≈ edges) before it's built.
function networkEdgeCount() {
  if (state.networkGraph && state.networkGraph.nEdges) return state.networkGraph.nEdges;
  if (state.networkLines && state.networkLines.length) {
    let v = 0;
    for (const ln of state.networkLines) v += Math.max(0, ln.length - 1);
    return Math.max(1, v);
  }
  return 0;
}

// Graph-mode compute: per-ref graph Dijkstra ∝ edges (round = both legs).
function predictGraphComputeMs(opts) {
  const dijk = opts.mode === "round" ? 2 : 1;
  const refs = opts.wantDensity ? (opts.refs || 1) : 1;
  return refs * Math.max(1, opts.netEdges) * GRAPH_MS_PER_EDGE * dijk;
}

// Network interpolation phase (0 when not interpolating). Graph-mode interp
// runs single-worker; raster-constrained interp is banded across the pool.
function predictInterpMs(opts) {
  if (!opts.interp || !(opts.N > 0)) return 0;
  const poolN = opts.graph ? 1 : interpPoolSize(opts.N);
  const fill = INTERP_MS_PER_CELL * opts.N * Math.max(1, opts.interpMaxDist || 50);
  const smooth = INTERP_SMOOTH_MS_PER_CELL * opts.N * (opts.smoothIters || 0);
  // The IDW fill is banded across the pool; smoothing is a single post-merge
  // worker pass, so it is NOT divided by poolN (poolN=1 in graph mode → same).
  return fill / poolN + smooth;
}

function exploredCells(cal, N, eMax, alpha) {
  if (!(eMax > 0)) return N; // no budget → full grid
  // flat reach ∝ eMax/alpha; anchored at (bStar, Estar) from the probe.
  const ratio = (eMax * cal.alphaAtProbe) / (cal.bStar * alpha);
  return Math.min(N, cal.Estar * Math.pow(ratio, EXPLORE_EXP));
}

// Pre-flight compute-time prediction in ms (raw, before the network-interp
// term). Shared by the live estimate and the online-correction update so they
// can't drift. `applyCorr` multiplies in the learned per-engine factor.
function predictComputeMs(cal, opts, applyCorr) {
  const { N, wantDensity, wantTopN, refs, eMax, mode, alpha, backend, graph } = opts;

  // "Follow the vectors": cost is ∝ graph edges, not raster cells (~1000× less
  // on a typical network/DEM). Using the raster model here is the severe
  // over-estimate users hit in graph mode.
  if (graph) {
    let ms = predictGraphComputeMs(opts);
    // Compare adds a full-DEM unconstrained RASTER scenario (single-point or
    // density pool) — add its cost via the raster model (graph off, browser).
    if (opts.graphCompare) ms += predictComputeMs(cal, { ...opts, graph: false, backend: false }, false);
    return applyCorr ? ms * (cal.corrGraph || 1) : ms;
  }

  const explored = exploredCells(cal, N, eMax, alpha);
  const perRef = cal.perRefProbe * Math.pow(explored / cal.Estar, RATE_EXP);
  const dijk = mode === "round" ? 2 : 1;

  let ms, corr = 1;
  if (wantDensity) {
    if (backend) {
      // Native backend: per-ref speedup, parallel across refs but capped by
      // the server's MEMORY-bounded slice count (the dominant factor on huge
      // DEMs — each slice holds full-grid scratch, so 1-2 fit in RAM, not
      // cores-many) and slowed by shared-bandwidth contention between slices.
      const perSlice = (mode === "round" ? BACKEND_BYTES_PER_CELL_ROUND : BACKEND_BYTES_PER_CELL) * N;
      const memBudget = (state.backendCores && state.backendCores.memBudgetBytes) || 8e9;
      const memCap = Math.max(1, Math.floor(memBudget / perSlice));
      const cores = (state.backendCores && state.backendCores.cores) || BACKEND_PAR_CAP;
      const slices = Math.max(1, Math.min(refs || 1, cores, memCap));
      const contention = 1 + BW_CONTENTION * (slices - 1);
      ms = (refs / slices) * (perRef / NATIVE_SPEEDUP) * contention * dijk;
      corr = cal.corrBackend || 1;
    } else {
      // Browser worker pool: per-ref work splits across poolN; each worker
      // pays its own alloc, overlapping in wall-clock (so allocMsN once).
      const poolN = densityPoolSize({ N, K: refs, round: mode === "round" });
      ms = cal.allocMsN + (refs / poolN) * perRef * dijk;
      corr = cal.corrBrowser || 1;
    }
  } else if (backend && !wantTopN && !opts.maximize && !opts.wantPath) {
    // Native backend single-source (POST /single) — same dispatch gate as the
    // runner. No per-worker browser DEM alloc; native per-Dijkstra speedup.
    // corrBackend is trained by density backend runs (a reasonable proxy — the
    // online correction skips the fast single-point modes by design).
    ms = (perRef / NATIVE_SPEEDUP) * dijk;
    corr = cal.corrBackend || 1;
  } else {
    // Single-point modes (from/to/round) — one Dijkstra (two for round).
    ms = cal.allocMsN + perRef * dijk;
    if (wantTopN) {
      const k = Math.max(1, Math.min(20, parseInt(document.getElementById("n-routes")?.value, 10) || 3));
      const rep = document.getElementById("repulsion-mode")?.value || "per-cell";
      const perIter = rep === "per-cell" ? 0.5 : 0.8;
      ms += perRef * perIter * k;
    }
    corr = cal.corrBrowser || 1;
  }
  return applyCorr ? ms * corr : ms;
}

// Read the current run config from the DOM (used by both the estimate and the
// post-compute correction, so they describe the same run).
function currentRunOpts(cal, N) {
  const mode = document.getElementById("mode")?.value || "from";
  const alpha = parseFloat(document.getElementById("alpha")?.value) || cal.alphaAtProbe;
  const eMaxRaw = parseFloat(document.getElementById("e-max")?.value);
  const graph = graphModeActive();
  // Interp runs when its toggle is on AND there's a network to fill around —
  // either a raster constraint or graph mode (graph energy is IDW-filled too).
  const interp = !!document.getElementById("net-interp")?.checked
    && (networkConstraintActive() || graph);
  return {
    N,
    wantDensity: !!document.getElementById("want-density")?.checked,
    wantTopN: !!document.getElementById("want-topn")?.checked,
    // maximize / a destination path keep single-source runs in the browser (the
    // backend produces no routes) — the predictor gates the backend arm on these.
    maximize: !!document.getElementById("maximize")?.checked,
    wantPath: !!state.dst,
    refs: state.refPoints?.length || 0,
    eMax: Number.isFinite(eMaxRaw) && eMaxRaw > 0 ? eMaxRaw : 0,
    mode, alpha,
    backend: computeMode() !== "browser",
    graph,
    // Graph-mode compare also runs a full-DEM unconstrained raster scenario.
    graphCompare: graph && !!document.getElementById("vec-compare")?.checked,
    netEdges: graph ? networkEdgeCount() : 0,
    interp,
    interpMaxDist: Math.max(1, parseInt(document.getElementById("net-interp-max-dist")?.value, 10) || 50),
    smoothIters: Math.max(0, parseInt(document.getElementById("net-interp-smoothing")?.value, 10) || 0),
  };
}

function estimateRunTime() {
  // Cloud transfer-size estimate (always reconciled — even before a DEM/probe).
  updateCloudTransferEstimate();

  const out = document.getElementById("time-estimate");
  if (!out) return;
  if (!state.dem) { out.textContent = ""; return; }

  const cal = state.calibration;
  if (!cal) { out.textContent = "≈ estimating…"; return; }

  const N = state.dem.H * state.dem.W;
  const opts = currentRunOpts(cal, N);
  // Two phases, separately corrected: compute (raster/backend/graph) + the
  // network interpolation fill (frequently the larger of the two).
  let ms = predictComputeMs(cal, opts, true);
  ms += predictInterpMs(opts) * (cal.corrInterp || 1);
  out.textContent = `≈ ${formatDuration(ms)}`;
}

// Cloud-only: estimate the bytes shipped to/from the orchestrator for the
// current run config and render them (+ a wire-time guess) into #cloud-transfer.
// Pulls the same inputs estimateRunTime uses. Cleared when not in cloud mode or
// when there's no DEM to size against.
function updateCloudTransferEstimate() {
  const line = document.getElementById("cloud-transfer");
  if (!line) return;
  if (computeMode() !== "cloud" || !state.dem) { line.textContent = ""; return; }

  const N = state.dem.H * state.dem.W;
  const mode = document.getElementById("mode")?.value || "from";
  const wantDensity = !!document.getElementById("want-density")?.checked;
  const wantPasses  = !!document.getElementById("want-passes")?.checked;
  const hasNetwork  = networkConstraintActive();
  const nPortals    = buildPortals()?.n || 0;

  // Upload: gridHeight (f32 → 4·N) + gridMask (u8 → N) + optional networkMask
  // (u8 → N) + the bridge portal arrays (~32 B/portal: 2×i32 + 3×f64). The JSON
  // header is negligible against the grid.
  const up = 4 * N + N + (hasNetwork ? N : 0) + nPortals * 32;
  // Download: density returns f64 density (8·N) + f32 energy (4·N); single
  // returns f32 energy (4·N) + optional f32 passes (4·N).
  const down = wantDensity ? (8 * N + 4 * N) : (4 * N + (wantPasses ? 4 * N : 0));
  // Rough wire time at the assumed link speeds (bytes·8 / (Mbps·1e6)).
  const wireMs = (up * 8 / (UPLINK_MBPS * 1e6) + down * 8 / (DOWNLINK_MBPS * 1e6)) * 1000;
  line.textContent = t("cloud.transfer", formatBytes(up), formatBytes(down), formatDuration(wireMs));
}

// Online correction: after a run finishes, nudge the per-PHASE correction
// toward actual/predicted so subsequent estimates converge to this machine's
// reality (EMA, clamped). The compute phase keys by engine (browser/backend/
// graph); the interp phase has its own factor — keeping them separate stops
// a slow interp from inflating the compute correction (and vice-versa).
function updateEstimateCorrection(computeMs, interpMs) {
  const cal = state.calibration, lr = state.lastRun;
  if (!cal || !lr) return;
  const nudge = (key, actual, predicted) => {
    if (!(actual > 0) || !(predicted > 0)) return;
    const ratio = Math.min(5, Math.max(0.2, actual / predicted));
    cal[key] = Math.min(5, Math.max(0.2, 0.5 * (cal[key] || 1) + 0.5 * ratio));
  };
  // Correct the compute phase only for the perf-critical paths (density and
  // graph), not the fast single-point modes — they share corrBrowser but have
  // a different cost shape, so learning from them would muddy the density one.
  if (computeMs > 0 && (lr.wantDensity || lr.graph)) {
    const key = lr.graph ? "corrGraph" : (lr.backend ? "corrBackend" : "corrBrowser");
    nudge(key, computeMs, predictComputeMs(cal, lr, false));
  }
  if (interpMs > 0 && lr.interp) {
    nudge("corrInterp", interpMs, predictInterpMs(lr));
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 950) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

// Binary-unit byte formatter for the cloud transfer estimate (KiB/MiB/GiB).
function formatBytes(b) {
  if (!Number.isFinite(b) || b < 0) return "—";
  if (b < 1024) return `${Math.round(b)} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function formatEnergy(v) {
  if (!Number.isFinite(v) || v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000 || a < 0.01) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

// ------- DEM metadata formatters -------
function formatCellSize(dx, dy, originY, H, isGeographic) {
  if (isGeographic) {
    const latRef = originY - (H * dy) / 2;
    const dxM = dx * 111320 * Math.cos((latRef * Math.PI) / 180);
    const dyM = dy * 110574;
    return `<span class="v">${dxM.toFixed(1)} × ${dyM.toFixed(1)} m</span> <span style="opacity:0.6">(${dx.toExponential(2)}° × ${dy.toExponential(2)}°)</span>`;
  }
  return `<span class="v">${dx.toFixed(1)} × ${dy.toFixed(1)} m</span>`;
}

function formatCoverage(W, H, dx, dy, originY, isGeographic) {
  let xKm, yKm;
  if (isGeographic) {
    const latRef = originY - (H * dy) / 2;
    xKm = (W * dx * 111320 * Math.cos((latRef * Math.PI) / 180)) / 1000;
    yKm = (H * dy * 110574) / 1000;
  } else {
    xKm = (W * dx) / 1000;
    yKm = (H * dy) / 1000;
  }
  return `<span class="v">${xKm.toFixed(2)} × ${yKm.toFixed(2)} km</span> coverage`;
}

// ------- ColorCET colormaps -------
// Auto-generated from the python `colorcet` package — full set, ~75 maps.
// Each entry: 17 anchor RGB triples sampled evenly from the 256-stop palette
// (Kovesi 2015, https://colorcet.com/). Maps are designed to be uniform under
// CIECAM02 rather than the simpler L* CIELab metric matplotlib uses, so they
// hold up better at the extremes.
const COLORMAPS = {
  CET_L1: [[0,0,0],[19,19,19],[32,32,32],[45,45,45],[59,59,59],[73,73,73],[88,88,88],[103,103,103],[119,119,119],[134,134,134],[150,150,150],[167,167,167],[184,184,184],[201,201,201],[219,219,219],[236,236,236],[254,255,255]],
  CET_L2: [[27,27,27],[38,38,38],[49,49,49],[61,61,61],[73,73,73],[86,86,86],[99,99,99],[112,112,112],[125,125,125],[138,138,138],[152,152,152],[166,166,166],[180,180,180],[195,195,195],[210,210,210],[225,225,225],[240,240,240]],
  CET_L3: [[0,0,0],[50,0,0],[74,0,0],[99,1,0],[125,2,0],[152,3,0],[180,5,0],[209,9,0],[237,20,0],[251,61,0],[254,102,0],[255,135,0],[255,164,1],[255,191,3],[255,217,9],[255,241,30],[255,255,255]],
  CET_L4: [[0,0,0],[49,0,0],[73,0,0],[97,1,0],[122,2,0],[148,3,0],[175,5,0],[203,8,0],[231,16,0],[246,54,0],[250,95,0],[252,127,0],[253,156,0],[254,182,0],[254,207,0],[254,231,0],[255,255,0]],
  CET_L5: [[0,21,5],[9,33,5],[8,47,4],[10,61,4],[14,76,5],[18,91,6],[22,106,7],[26,122,9],[31,138,11],[34,153,13],[39,170,14],[43,187,16],[47,204,18],[52,222,20],[83,238,21],[150,249,21],[216,255,20]],
  CET_L6: [[0,0,78],[5,2,110],[15,1,144],[10,4,181],[12,16,213],[31,34,238],[43,59,249],[47,85,251],[45,108,253],[43,129,253],[51,149,253],[53,169,252],[43,189,252],[41,209,250],[73,227,249],[128,242,247],[179,254,245]],
  CET_L7: [[0,2,75],[0,5,108],[5,5,143],[4,8,179],[22,15,212],[54,24,238],[101,28,250],[147,28,253],[186,28,253],[217,39,253],[239,65,254],[251,97,253],[254,130,252],[254,159,252],[254,186,253],[254,210,254],[254,234,254]],
  CET_L8: [[0,14,92],[14,21,118],[45,26,138],[86,24,146],[124,16,144],[157,10,140],[186,11,133],[212,24,125],[232,51,112],[243,79,96],[248,108,82],[248,136,71],[250,160,61],[252,182,55],[252,205,59],[249,226,67],[245,248,77]],
  CET_L9: [[5,0,171],[11,33,176],[13,55,180],[12,74,180],[6,93,173],[25,112,151],[43,130,120],[49,147,84],[65,161,55],[89,173,33],[121,185,12],[155,194,2],[188,203,8],[217,213,26],[239,224,50],[250,239,102],[249,249,249]],
  CET_L10: [[101,154,143],[113,158,136],[125,161,129],[139,164,123],[155,166,117],[176,165,113],[194,165,111],[206,167,108],[211,171,105],[214,176,105],[216,181,112],[216,187,125],[215,192,143],[215,197,160],[214,202,177],[213,207,194],[212,212,212]],
  CET_L11: [[111,172,91],[132,174,93],[151,175,95],[168,175,97],[184,176,99],[199,177,101],[213,178,104],[224,180,106],[230,184,109],[231,189,114],[231,195,124],[231,200,138],[230,206,156],[229,211,173],[228,216,191],[227,221,208],[226,226,226]],
  CET_L12: [[240,240,240],[228,233,239],[216,225,238],[203,217,236],[191,210,235],[179,203,232],[167,195,229],[156,188,225],[146,180,220],[138,173,214],[129,166,207],[121,158,199],[112,151,193],[101,144,188],[89,137,184],[75,130,180],[58,123,177]],
  CET_L13: [[0,0,0],[27,5,0],[43,8,0],[55,10,0],[67,12,0],[79,15,0],[92,17,0],[105,19,0],[118,22,0],[130,24,0],[144,27,0],[157,29,0],[171,32,0],[186,35,0],[200,37,0],[214,40,0],[229,43,0]],
  CET_L14: [[0,0,0],[0,14,0],[0,23,0],[0,30,0],[0,37,0],[0,44,0],[0,51,0],[0,58,0],[0,65,0],[0,72,0],[0,79,0],[0,87,0],[0,95,0],[0,103,0],[0,111,0],[0,119,0],[0,127,0]],
  CET_L15: [[0,0,0],[2,9,28],[4,15,48],[6,20,62],[7,25,75],[8,29,89],[10,34,103],[11,38,117],[13,43,132],[14,48,145],[16,53,160],[17,58,176],[19,63,191],[20,68,207],[22,73,222],[23,78,238],[25,84,255]],
  CET_L16: [[16,16,16],[32,19,69],[33,21,119],[22,29,161],[8,48,181],[6,71,183],[5,95,172],[32,117,143],[47,138,103],[57,156,66],[84,172,37],[122,185,11],[163,196,2],[201,207,15],[232,220,40],[248,236,87],[249,249,249]],
  CET_L17: [[254,255,255],[246,242,210],[242,228,175],[242,211,149],[243,192,130],[244,173,116],[245,153,107],[243,132,103],[239,111,105],[233,90,108],[222,69,115],[207,50,124],[189,34,134],[164,24,144],[133,28,154],[91,35,161],[0,42,167]],
  CET_L18: [[254,255,255],[245,247,213],[237,238,181],[233,228,157],[231,216,136],[229,204,116],[228,192,98],[228,179,82],[227,166,67],[226,153,55],[225,139,43],[224,124,35],[223,109,28],[221,92,24],[219,73,24],[216,51,26],[212,15,29]],
  CET_L19: [[254,255,255],[234,247,253],[216,238,253],[200,229,253],[190,218,254],[185,206,254],[184,192,251],[190,178,245],[199,162,235],[209,146,222],[220,127,203],[228,108,179],[234,87,152],[235,67,122],[231,49,89],[222,37,55],[208,33,14]],
  CET_L20: [[48,48,48],[60,53,88],[66,60,127],[66,69,161],[62,80,188],[55,96,200],[40,118,182],[37,138,149],[65,154,117],[104,164,89],[147,172,59],[187,178,30],[228,182,19],[247,193,20],[254,209,18],[253,228,15],[248,248,9]],
  CET_D1: [[32,80,218],[81,98,222],[112,117,225],[137,136,228],[160,156,231],[181,176,234],[201,197,236],[221,218,238],[237,231,233],[241,214,208],[240,190,177],[236,165,147],[231,140,118],[223,114,90],[214,87,63],[203,57,36],[191,2,5]],
  CET_D1A: [[23,41,113],[28,58,161],[40,78,207],[81,100,230],[119,125,243],[153,151,252],[185,180,250],[213,209,245],[238,226,230],[250,202,191],[252,165,146],[248,126,104],[232,91,70],[212,53,39],[184,6,15],[143,3,9],[102,7,2]],
  CET_D2: [[56,150,14],[85,162,51],[110,173,79],[133,184,106],[155,196,132],[176,207,158],[198,218,185],[219,229,212],[235,234,235],[234,221,239],[229,203,238],[222,185,237],[215,166,235],[208,148,233],[200,129,232],[192,109,230],[183,89,228]],
  CET_D3: [[56,150,14],[85,162,51],[110,173,79],[133,184,106],[155,196,132],[176,207,158],[198,218,185],[219,229,212],[238,234,230],[245,220,216],[248,201,194],[250,181,171],[250,161,150],[248,140,128],[245,119,108],[241,96,87],[236,71,68]],
  CET_D4: [[24,129,250],[40,115,219],[47,101,188],[49,88,159],[49,75,130],[46,62,102],[41,50,76],[35,38,51],[34,31,32],[51,35,32],[75,42,36],[99,49,41],[124,56,46],[149,62,51],[175,68,55],[202,74,60],[230,79,65]],
  CET_D6: [[14,147,250],[36,131,218],[44,114,188],[47,99,158],[48,83,130],[45,68,102],[41,54,76],[35,40,51],[33,32,32],[45,39,29],[63,52,31],[81,65,32],[100,79,33],[119,94,33],[138,108,32],[158,123,29],[179,138,25]],
  CET_D7: [[19,49,193],[59,60,187],[80,72,182],[96,84,176],[108,96,170],[119,108,164],[129,120,157],[137,132,151],[145,144,144],[160,154,135],[174,164,124],[189,174,113],[202,184,101],[215,195,88],[228,206,72],[240,216,51],[252,227,9]],
  CET_D8: [[0,42,215],[37,50,200],[62,57,185],[76,65,171],[86,72,157],[92,79,142],[96,86,128],[99,93,114],[101,100,99],[124,98,90],[147,94,80],[167,90,70],[187,84,59],[205,77,48],[224,67,36],[242,52,21],[255,24,0]],
  CET_D9: [[36,127,254],[89,141,254],[121,155,254],[147,170,253],[170,185,253],[191,200,252],[211,216,251],[230,232,250],[248,246,246],[252,228,222],[253,208,197],[253,188,172],[251,167,147],[247,147,123],[243,126,100],[237,104,77],[230,80,54]],
  CET_D10: [[0,216,255],[82,221,255],[119,226,255],[148,231,255],[172,236,255],[195,241,255],[216,245,255],[236,250,255],[254,254,254],[254,245,253],[254,235,251],[254,225,249],[253,214,247],[253,204,245],[252,194,243],[251,184,242],[249,173,240]],
  CET_D11: [[0,182,255],[61,180,247],[91,179,236],[112,178,225],[128,176,214],[141,175,203],[152,173,192],[162,172,181],[172,170,171],[182,168,163],[193,165,155],[203,162,147],[212,158,140],[221,155,132],[230,151,124],[238,148,116],[246,144,108]],
  CET_D12: [[0,200,255],[57,198,246],[92,196,237],[115,194,228],[133,192,219],[149,190,210],[162,188,202],[174,186,193],[184,184,187],[191,181,189],[198,178,195],[205,175,200],[212,172,206],[218,169,211],[224,166,216],[231,162,222],[237,158,227]],
  CET_D13: [[16,44,103],[32,65,138],[46,87,171],[54,112,202],[50,140,228],[66,169,245],[120,195,251],[182,217,247],[223,235,236],[174,223,208],[108,205,176],[56,182,138],[36,157,95],[31,130,59],[21,105,33],[8,81,15],[0,57,1]],
  CET_R1: [[0,47,245],[25,94,190],[38,122,138],[62,143,89],[71,163,36],[114,177,16],[160,188,23],[204,198,30],[241,202,36],[249,185,33],[248,159,28],[244,133,23],[240,105,20],[241,85,47],[251,101,110],[255,123,178],[253,145,250]],
  CET_R2: [[0,51,245],[0,88,200],[0,114,157],[49,131,118],[62,148,77],[66,164,26],[106,175,17],[145,184,25],[180,193,32],[213,200,39],[245,204,44],[253,186,37],[255,164,28],[255,141,19],[255,116,10],[254,87,2],[252,48,0]],
  CET_R3: [[8,92,248],[22,124,187],[49,146,121],[63,164,49],[103,175,29],[142,184,26],[177,193,21],[212,201,15],[244,204,31],[252,185,74],[254,161,105],[254,136,131],[252,107,154],[248,76,166],[241,54,119],[229,34,66],[214,4,0]],
  CET_R4: [[3,0,108],[5,0,156],[11,24,193],[16,48,224],[29,79,234],[5,124,169],[47,154,79],[81,177,8],[137,193,4],[184,208,2],[230,222,1],[250,204,11],[251,171,19],[252,135,20],[254,91,15],[244,38,12],[214,5,13]],
  CET_I1: [[54,183,236],[63,184,222],[71,185,207],[79,186,193],[87,186,178],[96,187,163],[106,186,147],[119,186,131],[135,184,117],[151,181,107],[167,177,100],[183,172,95],[197,167,93],[211,162,94],[224,156,97],[235,150,102],[246,144,108]],
  CET_I2: [[111,209,255],[112,210,245],[114,212,232],[117,213,219],[120,214,205],[125,214,191],[132,214,177],[142,214,162],[156,212,148],[170,210,137],[186,206,129],[202,202,122],[216,198,118],[230,193,117],[242,188,119],[254,183,123],[255,178,129]],
  CET_I3: [[19,185,229],[62,183,231],[85,180,233],[104,177,235],[121,174,235],[136,171,236],[151,168,235],[165,164,233],[178,161,228],[190,157,223],[201,154,216],[211,151,210],[221,147,202],[230,143,195],[238,140,188],[246,136,180],[253,132,172]],
  CET_C1: [[248,132,247],[249,104,196],[234,67,136],[207,36,75],[181,26,21],[189,67,4],[204,105,4],[213,143,4],[207,170,39],[164,160,95],[94,140,144],[33,108,193],[59,63,238],[104,76,249],[146,106,250],[202,124,254],[247,133,249]],
  CET_C2: [[239,85,241],[251,132,206],[251,175,161],[252,212,113],[240,237,53],[198,229,22],[150,211,16],[97,193,11],[49,172,40],[66,145,96],[62,115,151],[41,80,197],[43,36,232],[96,34,245],[142,56,250],[193,67,250],[237,82,243]],
  CET_C3: [[224,215,218],[237,187,173],[239,147,122],[235,104,73],[218,61,33],[173,50,26],[123,45,28],[76,38,28],[41,33,38],[42,46,78],[48,66,134],[42,87,194],[47,110,245],[111,136,250],[157,165,243],[194,195,235],[223,215,220]],
  CET_C4: [[222,213,216],[230,181,167],[225,136,112],[213,88,59],[201,48,22],[212,85,57],[224,133,109],[230,179,165],[220,209,215],[187,188,228],[145,153,229],[91,119,229],[25,99,228],[92,120,229],[146,153,229],[188,189,228],[221,213,218]],
  CET_C5: [[119,119,119],[141,141,141],[163,163,163],[187,187,187],[202,202,202],[185,185,185],[162,162,162],[139,139,139],[117,117,117],[97,97,97],[77,77,77],[57,57,57],[45,45,45],[57,57,57],[76,76,76],[97,97,97],[118,118,118]],
  CET_C6: [[246,54,26],[252,116,1],[255,179,0],[225,209,0],[152,184,0],[76,155,18],[43,167,81],[49,206,161],[37,232,234],[48,200,255],[40,150,255],[88,129,255],[170,158,255],[234,189,251],[255,165,185],[255,104,99],[246,53,29]],
  CET_C7: [[232,228,25],[250,197,104],[255,157,157],[255,111,204],[251,62,246],[227,122,254],[195,172,253],[147,213,252],[59,243,242],[46,230,195],[51,209,141],[39,189,86],[35,174,24],[97,186,0],[146,203,0],[191,218,0],[231,228,18]],
  CET_C8: [[232,148,149],[239,166,131],[237,185,115],[228,205,101],[204,221,99],[167,221,123],[134,212,149],[98,201,172],[61,187,193],[24,174,209],[6,158,222],[42,141,231],[97,124,231],[155,119,213],[190,123,191],[215,132,170],[232,146,150]],
  CET_C9: [[194,127,116],[205,157,108],[209,187,101],[205,218,97],[182,239,105],[144,230,129],[112,208,148],[81,183,163],[52,158,172],[27,133,178],[7,107,179],[21,80,177],[67,55,168],[117,53,152],[150,72,138],[175,97,127],[193,125,117]],
  CET_C10: [[217,144,132],[207,150,118],[190,157,110],[171,164,108],[148,170,115],[125,174,131],[102,177,151],[79,178,173],[65,177,193],[81,174,207],[111,168,214],[141,162,216],[170,154,210],[193,148,195],[208,144,175],[217,142,154],[217,144,133]],
  CET_C11: [[71,48,241],[95,86,203],[106,124,158],[94,160,109],[72,183,52],[114,161,17],[145,124,4],[164,80,0],[180,21,17],[203,17,64],[227,52,122],[246,79,184],[250,98,241],[217,86,254],[173,67,253],[123,50,251],[72,47,242]],
  CET_CBL1: [[16,16,16],[19,28,47],[13,40,76],[0,52,103],[1,65,125],[31,77,140],[66,91,140],[97,104,129],[121,118,118],[142,132,106],[163,146,92],[182,161,89],[198,176,103],[212,191,128],[224,207,160],[234,223,197],[240,240,240]],
  CET_CBL2: [[16,16,16],[22,28,44],[20,41,73],[16,53,100],[15,66,125],[14,80,150],[11,94,175],[6,108,202],[0,123,228],[54,136,241],[126,151,211],[172,167,161],[204,182,112],[229,198,56],[248,214,56],[255,231,158],[251,249,243]],
  CET_CBL3: [[16,16,16],[25,28,38],[30,40,61],[35,52,85],[37,64,110],[37,77,136],[35,91,163],[28,105,192],[12,119,220],[24,132,242],[77,147,250],[116,161,249],[146,176,248],[172,192,246],[196,208,244],[219,224,242],[240,240,240]],
  CET_CBL4: [[16,16,16],[33,28,14],[47,40,10],[61,52,5],[76,64,1],[91,77,1],[106,90,1],[122,104,1],[138,118,1],[154,131,1],[171,146,1],[188,161,1],[205,176,1],[223,191,0],[241,207,16],[254,222,99],[244,240,231]],
  CET_CBD1: [[58,144,254],[97,155,252],[125,166,251],[148,178,250],[168,190,248],[188,202,246],[206,215,244],[223,227,242],[237,236,236],[233,227,212],[226,214,185],[218,202,159],[209,190,132],[200,178,106],[189,166,79],[179,154,50],[167,143,8]],
  CET_CBD2: [[4,136,252],[69,141,243],[97,146,234],[116,151,225],[132,157,216],[146,162,206],[158,167,197],[169,173,188],[179,179,178],[190,184,169],[200,189,159],[210,194,149],[220,199,138],[229,205,127],[238,210,115],[246,216,103],[254,221,89]],
  CET_CBC1: [[62,134,234],[118,159,240],[164,185,242],[204,213,243],[235,233,233],[223,211,181],[203,184,127],[180,157,72],[154,132,17],[127,109,24],[98,85,33],[70,62,38],[47,46,46],[52,62,86],[59,84,134],[59,108,185],[59,133,232]],
  CET_CBC2: [[238,237,236],[226,214,183],[206,186,126],[182,159,67],[162,139,1],[181,158,64],[205,185,123],[225,213,181],[235,234,235],[204,214,245],[162,186,247],[112,159,248],[54,140,248],[113,159,248],[163,186,247],[205,214,245],[237,237,238]],
  CET_CBTL1: [[16,16,16],[52,18,14],[85,12,12],[114,1,14],[139,2,19],[163,5,26],[189,11,32],[215,17,39],[241,28,46],[251,67,67],[231,119,112],[188,161,166],[111,195,219],[41,218,250],[132,230,252],[196,239,251],[249,249,249]],
  CET_CBTL2: [[16,16,16],[47,21,17],[73,24,21],[95,30,26],[115,40,35],[127,56,49],[130,77,70],[127,98,94],[119,119,121],[105,138,147],[77,158,176],[26,177,204],[29,194,223],[84,208,234],[137,221,241],[189,231,242],[240,240,240]],
  CET_CBTL3: [[16,16,16],[23,29,31],[27,42,46],[31,56,62],[33,70,78],[35,84,95],[36,99,112],[36,114,130],[35,130,148],[34,145,166],[31,161,185],[29,177,203],[31,194,222],[47,210,240],[109,224,249],[175,234,249],[240,240,240]],
  CET_CBTL4: [[16,16,16],[46,22,18],[73,24,20],[100,25,23],[127,24,25],[154,23,29],[180,24,34],[205,31,41],[227,45,50],[242,67,64],[248,97,86],[252,124,110],[254,148,135],[254,172,160],[252,195,186],[247,218,213],[240,240,240]],
  CET_CBTD1: [[41,201,230],[89,207,233],[120,213,235],[145,219,237],[168,225,240],[190,231,242],[210,237,244],[229,243,246],[247,246,246],[251,237,235],[253,226,222],[254,215,210],[254,204,197],[255,193,184],[254,182,172],[253,171,160],[252,160,148]],
  CET_CBTC1: [[38,187,214],[110,204,226],[163,220,235],[209,237,245],[248,247,248],[253,225,221],[250,198,191],[244,172,162],[233,147,136],[202,134,125],[167,121,114],[132,108,104],[100,99,100],[92,117,124],[83,140,154],[64,163,184],[35,186,213]],
  CET_CBTC2: [[251,250,250],[254,228,224],[252,201,193],[247,175,164],[243,154,142],[247,173,163],[252,200,192],[254,227,222],[248,248,249],[210,238,246],[163,222,237],[108,206,228],[43,194,222],[109,206,228],[164,222,237],[211,238,246],[249,250,250]],
  // cmocean.phase — cyclic perceptually-uniform colormap by Thyng et al. 2016.
  // https://matplotlib.org/cmocean/#phase
  cmo_phase: [[168,120,13],[190,104,40],[207,86,67],[219,64,102],[223,42,147],[213,41,196],[192,65,229],[162,92,243],[125,115,240],[82,133,220],[44,144,188],[25,149,156],[12,152,124],[36,154,82],[94,148,32],[139,134,13],[168,120,13]],
};

// Class metadata for the dropdown <optgroup>s.
const COLORCET_GROUPS = [
  { label: "cmocean", keys: ["cmo_phase"] },
  { label: "Linear", keys: ["CET_L1","CET_L2","CET_L3","CET_L4","CET_L5","CET_L6","CET_L7","CET_L8","CET_L9","CET_L10","CET_L11","CET_L12","CET_L13","CET_L14","CET_L15","CET_L16","CET_L17","CET_L18","CET_L19","CET_L20"] },
  { label: "Diverging", keys: ["CET_D1","CET_D1A","CET_D2","CET_D3","CET_D4","CET_D6","CET_D7","CET_D8","CET_D9","CET_D10","CET_D11","CET_D12","CET_D13"] },
  { label: "Rainbow", keys: ["CET_R1","CET_R2","CET_R3","CET_R4"] },
  { label: "Isoluminant", keys: ["CET_I1","CET_I2","CET_I3"] },
  { label: "Cyclic", keys: ["CET_C1","CET_C2","CET_C3","CET_C4","CET_C5","CET_C6","CET_C7","CET_C8","CET_C9","CET_C10","CET_C11"] },
  { label: "Colour-blind safe linear", keys: ["CET_CBL1","CET_CBL2","CET_CBL3","CET_CBL4"] },
  { label: "Colour-blind safe diverging", keys: ["CET_CBD1","CET_CBD2"] },
  { label: "Colour-blind safe cyclic", keys: ["CET_CBC1","CET_CBC2"] },
  { label: "Tritan-safe linear", keys: ["CET_CBTL1","CET_CBTL2","CET_CBTL3","CET_CBTL4"] },
  { label: "Tritan-safe diverging", keys: ["CET_CBTD1"] },
  { label: "Tritan-safe cyclic", keys: ["CET_CBTC1","CET_CBTC2"] },
];

let activeColormap = "cmo_phase"; // cmocean.phase — cyclic, perceptually uniform

// Sample a CET colormap at evenly-spaced positions for top-N route colours.
// route i of n → t = (i + 0.5) / n so we land in the middle of each band
// rather than at the saturated endpoints.
function routeColour(i, n) {
  const name = document.getElementById("routes-colormap")?.value || "CET_R2";
  const anchors = COLORMAPS[name] || COLORMAPS.CET_R2;
  const t = n > 1 ? (i + 0.5) / n : 0.5;
  const m = anchors.length - 1;
  const f = t * m;
  const j = Math.floor(f);
  const frac = f - j;
  const a = anchors[Math.min(j, m)];
  const b = anchors[Math.min(j + 1, m)];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgb(${r},${g},${bl})`;
}

// Recolour the existing top-N route polylines in place from the current
// routes-colormap. Cheap setStyle on the already-drawn lines — no recompute
// and no energy/passes raster re-render (the maximize path is a fixed colour,
// unaffected). Used by the routes-colormap selector, which previously called
// the full rerenderCachedResult() and re-rasterised both W×H field canvases.
function recolorRouteLines() {
  if (!state.routeLines || !state.routeLines.length) return;
  const n = state.routeLines.length;
  for (let i = 0; i < n; i++) state.routeLines[i].setStyle({ color: routeColour(i, n) });
}

function colormap(t) {
  const anchors = COLORMAPS[activeColormap] || COLORMAPS.viridis;
  t = Math.max(0, Math.min(1, t));
  const n = anchors.length - 1;
  const f = t * n;
  const i = Math.floor(f);
  const frac = f - i;
  const a = anchors[Math.min(i, n)];
  const b = anchors[Math.min(i + 1, n)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

// Build a CSS linear-gradient string for the swatch.
function colormapToCss(name) {
  const anchors = COLORMAPS[name];
  const stops = anchors.map((rgb, i) => {
    const pct = ((i / (anchors.length - 1)) * 100).toFixed(1);
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${pct}%`;
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function applyColormapToLegend() {
  const swatch = document.querySelector(".swatch");
  if (swatch) swatch.style.background = colormapToCss(activeColormap);
}

// ------- Bundle download / reload -------
// `metadata.jsonld` captures everything needed to reproduce the run from the
// same DEM: timestamps, engine, all compute parameters, source/destination
// pixel coordinates, and the visualisation knobs. Output rasters are written
// as GeoTIFFs (energy.tif / passes.tif / network.tif) so they drop straight
// into QGIS without needing the metadata to interpret them. Routes and the
// path are GeoJSON. JSON-LD `@context` is inlined so the file is self-
// describing without a network fetch.

// ---- GeoTIFF helpers --------------------------------------------------------
// We use geotiff.js's writer (bundled in the same script as the reader). The
// metadata schema mirrors what readRasters expects on the way back, so the
// round-trip is lossless. Float32 / Float64 / Uint8 cover all our outputs.

function tiffMetadataForDem(dem, sampleKind) {
  // sampleKind: "float32" (energy), "float64" (passes), or "uint8" (mask).
  const { H, W, originX, originY, dx, dy, isGeographic, geoKeys } = dem;
  const bps = sampleKind === "float64" ? 64 : sampleKind === "uint8" ? 8 : 32;
  // SampleFormat: 1 = unsigned int, 2 = signed int, 3 = IEEE floating point.
  const sf  = sampleKind === "uint8" ? 1 : 3;
  const md = {
    width:  W,
    height: H,
    BitsPerSample: [bps],
    SampleFormat:  [sf],
    SamplesPerPixel: [1],
    // ModelTiepoint maps raster pixel (0,0,0) to world (originX, originY, 0).
    // ModelPixelScale gives the per-pixel size; dy is positive in our DEM
    // model (height per row going down) so we use it directly.
    ModelTiepoint:    [0, 0, 0, originX, originY, 0],
    ModelPixelScale:  [Math.abs(dx), Math.abs(dy), 0],
  };
  // Forward the source DEM's CRS info verbatim. If we don't have it (older
  // load path) but we know the DEM is geographic, set EPSG:4326. The writer
  // also defaults to 4326 if neither is set, so projected DEMs without
  // captured GeoKeys would be misinterpreted — this is the failure mode to
  // watch for.
  if (geoKeys && Object.keys(geoKeys).length > 0) {
    Object.assign(md, geoKeys);
  } else if (isGeographic) {
    md.GeographicTypeGeoKey = 4326;
  }
  return md;
}

function writeRasterAsGeoTIFF(values, dem, sampleKind) {
  if (typeof GeoTIFF?.writeArrayBuffer !== "function") {
    throw new Error("GeoTIFF writer unavailable — load the full geotiff.js bundle.");
  }
  return GeoTIFF.writeArrayBuffer(values, tiffMetadataForDem(dem, sampleKind));
}

// Read a GeoTIFF blob from a bundle and return the underlying typed array
// in the requested element kind. We do a strict size check against the
// loaded DEM dims so a v3 bundle restored against a wrong DEM fails loudly
// (the buffer length mismatch surfaces the same way the .bin path does).
async function readRasterFromGeoTIFF(arrayBuffer, expectedKind) {
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const raster = await image.readRasters({ interleave: true });
  // readRasters returns the typed-array kind that matches the file's
  // BitsPerSample/SampleFormat. We coerce to the kind the caller wants.
  if (expectedKind === "float32" && !(raster instanceof Float32Array)) {
    return Float32Array.from(raster);
  }
  if (expectedKind === "float64" && !(raster instanceof Float64Array)) {
    return Float64Array.from(raster);
  }
  if (expectedKind === "uint8" && !(raster instanceof Uint8Array)) {
    return Uint8Array.from(raster);
  }
  return raster;
}

// ===================== Impassable mask + bridge corridors =====================
// An optional binary raster ("water") marks cells impassable. It is resampled
// onto the DEM grid by AREA-COVERAGE MAJORITY (a DEM cell is impassable iff
// ≥50% of its footprint is impassable in the source). The loaded vector network
// can OPTIONALLY carve passable "bridge" corridors across the mask: each
// corridor cell is levelled to a smooth profile — land elevation at each shore
// entrance, a linear ramp up to (+/-offset) at the bridge centre, then back
// down. Everything is composed in buildComputeGrid() *before* the grid reaches
// the worker/backend, so the engines are unchanged AND a run with no/all-zero
// mask is byte-identical to before (see buildComputeGrid).

function geoKeysToEpsg(gk) {
  if (!gk) return null;
  return gk.ProjectedCSTypeGeoKey || gk.ProjectedCRSGeoKey ||
         gk.GeographicTypeGeoKey || gk.GeodeticCRSGeoKey || null;
}

// Resolve a proj4 source key for an EPSG code, registering WGS84/UTM defs
// formulaically (proj4 only ships 4326 + a handful). Returns "EPSG:4326" for
// geographic codes, a registered "EPSG:<code>" for WGS84/UTM, or null if the
// code is projected-but-unknown (caller then assumes DEM-aligned coords).
function proj4DefForEpsg(code) {
  if (!code || code === 4326 || code === 4269 || code === 4979) return "EPSG:4326";
  const key = `EPSG:${code}`;
  try { if (proj4.defs(key)) return key; } catch {}
  if (code >= 32601 && code <= 32660) {
    proj4.defs(key, `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`);
    return key;
  }
  if (code >= 32701 && code <= 32760) {
    proj4.defs(key, `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`);
    return key;
  }
  return null;
}

// Parse an uploaded mask GeoTIFF → { width, height, data, dx, dy, originX,
// originY, epsg }. dx/dy are positive (pixel size); originX/Y is the top-left.
async function readMaskGeoTIFF(arrayBuffer) {
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const tiePoints = await image.getTiePoints();
  const scale = image.fileDirectory.getValue("ModelPixelScale");
  if (!scale || !tiePoints?.length) {
    throw new Error("Mask GeoTIFF lacks geotransform metadata (ModelPixelScale / tie points).");
  }
  const data = await image.readRasters({ interleave: true });
  let geoKeys = null;
  try { geoKeys = image.getGeoKeys ? image.getGeoKeys() : null; } catch {}
  return {
    width, height, data,
    dx: Math.abs(scale[0]), dy: Math.abs(scale[1]),
    originX: tiePoints[0].x, originY: tiePoints[0].y,
    epsg: geoKeysToEpsg(geoKeys),
  };
}

// Resample a parsed mask raster onto the DEM grid → Uint8Array (1=impassable),
// area-coverage majority (≥50%) via adaptive S×S sub-sampling of each DEM cell.
// Sub-points outside the source extent count as PASSABLE (the "missing = passable"
// rule). Only meaningful for geographic DEMs (the rest of the app is gated the
// same way). `invert` flips the source convention (uploaded raster marks passable).
function resampleMaskToDem(raster, dem, opts = {}) {
  const invert = !!opts.invert;
  const { H, W, originX, originY, dx, dy, isGeographic } = dem;
  const out = new Uint8Array(W * H); // 0 = passable
  // Nearest-pixel sub-point sampler: value>0 (xor invert) → impassable.
  const sample = (mx, my) => {
    const mc = Math.floor((mx - raster.originX) / raster.dx);
    const mr = Math.floor((raster.originY - my) / raster.dy);
    if (mc < 0 || mc >= raster.width || mr < 0 || mr >= raster.height) return 0; // missing = passable
    const v = raster.data[mr * raster.width + mc] > 0;
    return (v !== invert) ? 1 : 0;
  };
  // CRS: DEM is lon/lat (4326) when geographic. Reproject DEM sub-points into
  // the mask CRS only when it differs and we can build a def; otherwise assume
  // the mask shares the DEM's coordinate space (fail-safe: surfaces as a 0-cell
  // result in imp-meta if it doesn't).
  const demKey = isGeographic ? "EPSG:4326" : proj4DefForEpsg(geoKeysToEpsg(dem.geoKeys));
  const maskKey = proj4DefForEpsg(raster.epsg);
  const reproject = (demKey && maskKey && demKey !== maskKey)
    ? (x, y) => proj4(demKey, maskKey, [x, y]) : null;
  // Sub-samples per axis ≈ source pixels spanned by a DEM cell, capped at 8.
  // A finer source is area-averaged; an equal/coarser source collapses to S=1
  // (a single centre sample — correct, one source pixel spans the DEM cell).
  const S = reproject ? 4 : Math.max(1, Math.min(8, Math.ceil(dx / raster.dx)));
  const S2 = S * S;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let hit = 0;
      for (let j = 0; j < S; j++) {
        const y = originY - (r + (j + 0.5) / S) * dy;
        for (let i = 0; i < S; i++) {
          const x = originX + (c + (i + 0.5) / S) * dx;
          if (reproject) { const p = reproject(x, y); hit += sample(p[0], p[1]); }
          else hit += sample(x, y);
        }
      }
      out[r * W + c] = (hit * 2 >= S2) ? 1 : 0; // ≥50% coverage → impassable
    }
  }
  return out;
}

// The corridor elevation offset, clamped to the supported bridge range.
function corridorOffsetMetres() {
  const v = parseFloat(document.getElementById("imp-offset")?.value);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-5, Math.min(15, v));
}

// Local-graph Dijkstra (binary heap) from a set of seed nodes; edge weights in
// metres. Returns a Float64Array of geodesic distances (Infinity if unreached —
// e.g. cells in a different corridor component). m = node count.
function dijkstraLocal(seeds, nbr, nbrLen, m) {
  const dist = new Float64Array(m).fill(Infinity);
  const heap = []; // [dist, node]
  const push = (d, n) => {
    heap.push([d, n]); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) {
        let l = 2 * i + 1, rr = 2 * i + 2, s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (rr < heap.length && heap[rr][0] < heap[s][0]) s = rr;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]]; i = s;
      }
    }
    return top;
  };
  for (const s of seeds) if (dist[s] !== 0) { dist[s] = 0; push(0, s); }
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    const ns = nbr[u], ls = nbrLen[u];
    for (let k = 0; k < ns.length; k++) {
      const v = ns[k], nd = d + ls[k];
      if (nd < dist[v]) { dist[v] = nd; push(nd, v); }
    }
  }
  return dist;
}

// Recompute the cached bridge corridors (network ∩ impassable cells, reopened
// and levelled). Runs only on mask/network/corridor-toggle change — cheap, and
// keeps buildComputeGrid() a pure apply. Per connected corridor component:
//   • shore "entrances" = corridor cells touching a valid land-network cell,
//     grouped into clusters (the two bridge ends);
//   • base elevation = linear interpolation between the two ends (t along the
//     bridge); 1 end → flat; ≥3 ends → inverse-distance blend (rare junctions);
//   • ramp = geodesic distance to the nearest entrance ÷ its component max
//     (0 at the entrances, 1 at the centre) — the offset is scaled by this, so
//     height = base + offset·ramp gives a smooth ramp up to the bridge centre.
// Components with no land entrance are left blocked (can't bridge to nowhere).
function recomputeCorridors() {
  state.corridorCells = null; state.corridorBase = null; state.corridorRamp = null;
  state.corridorSet = null;
  const dem = state.dem, imp = state.impassable, net = state.networkMask;
  const on = !!document.getElementById("imp-corridor")?.checked;
  if (!dem || !imp || !net || !on) return;
  const { H, W, dxM, dyM, height, mask: dmask } = dem;
  const N = H * W;
  // 1) corridor cells (network ∩ impassable) + global→local index map.
  const cells = []; const local = new Map();
  for (let i = 0; i < N; i++) if (net[i] && imp[i]) { local.set(i, cells.length); cells.push(i); }
  const m = cells.length;
  if (!m) return;
  const drs = [-1, -1, -1, 0, 0, 1, 1, 1], dcs = [-1, 0, 1, -1, 1, -1, 0, 1];
  const diag = Math.hypot(dxM, dyM);
  const stepLen = [diag, dyM, diag, dxM, dxM, diag, dyM, diag];
  // 2) local adjacency among corridor cells + summed adjacent land elevations.
  const nbr = new Array(m), nbrLen = new Array(m);
  const entElev = new Float64Array(m), entCnt = new Int32Array(m);
  for (let li = 0; li < m; li++) {
    const i = cells[li]; const r = (i / W) | 0, c = i - r * W;
    const ns = [], ls = [];
    for (let k = 0; k < 8; k++) {
      const nr = r + drs[k], nc = c + dcs[k];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const j = nr * W + nc;
      const lj = local.get(j);
      if (lj !== undefined) { ns.push(lj); ls.push(stepLen[k]); }
      else if (net[j] && !imp[j] && dmask[j]) { entElev[li] += height[j]; entCnt[li]++; }
    }
    nbr[li] = ns; nbrLen[li] = ls;
  }
  // 3) connected components over the corridor graph.
  const comp = new Int32Array(m).fill(-1); let nComp = 0;
  for (let li = 0; li < m; li++) {
    if (comp[li] >= 0) continue;
    const cid = nComp++; const q = [li]; comp[li] = cid;
    while (q.length) { const x = q.pop(); for (const y of nbr[x]) if (comp[y] < 0) { comp[y] = cid; q.push(y); } }
  }
  // 4) entrance clusters (8-connected entrance cells) — naturally per-component.
  const isEnt = new Uint8Array(m);
  for (let li = 0; li < m; li++) if (entCnt[li] > 0) isEnt[li] = 1;
  const clusterId = new Int32Array(m).fill(-1);
  const clusters = []; const clustersByComp = Array.from({ length: nComp }, () => []);
  for (let li = 0; li < m; li++) {
    if (!isEnt[li] || clusterId[li] >= 0) continue;
    const cid = clusters.length; const q = [li]; clusterId[li] = cid;
    const cc = []; let esum = 0, ecnt = 0;
    while (q.length) {
      const x = q.pop(); cc.push(x); esum += entElev[x]; ecnt += entCnt[x];
      for (const y of nbr[x]) if (isEnt[y] && clusterId[y] < 0) { clusterId[y] = cid; q.push(y); }
    }
    clusters.push({ cells: cc, elev: ecnt ? esum / ecnt : 0, comp: comp[li] });
    clustersByComp[comp[li]].push(cid);
  }
  // 5) per-cluster geodesic distance + nearest-entrance distance for the ramp.
  const distOf = clusters.map((cl) => dijkstraLocal(cl.cells, nbr, nbrLen, m));
  const dNear = new Float64Array(m).fill(Infinity);
  for (const d of distOf) for (let li = 0; li < m; li++) if (d[li] < dNear[li]) dNear[li] = d[li];
  const compMaxNear = new Float64Array(nComp);
  for (let li = 0; li < m; li++) { const cm = comp[li]; if (Number.isFinite(dNear[li]) && dNear[li] > compMaxNear[cm]) compMaxNear[cm] = dNear[li]; }
  // 6) base + ramp per corridor cell; drop cells whose component has no shore.
  const outCells = [], outBase = [], outRamp = [];
  for (let li = 0; li < m; li++) {
    const cl = clustersByComp[comp[li]];
    if (!cl.length) continue; // no entrance reachable → leave blocked
    let base;
    if (cl.length === 2) {
      const dA = distOf[cl[0]][li], dB = distOf[cl[1]][li];
      const t = (dA + dB) > 0 ? dA / (dA + dB) : 0.5;
      base = (1 - t) * clusters[cl[0]].elev + t * clusters[cl[1]].elev;
    } else if (cl.length === 1) {
      base = clusters[cl[0]].elev;
    } else {
      let num = 0, den = 0;
      for (const ci of cl) {
        const d = distOf[ci][li];
        if (d <= 1e-9) { num = clusters[ci].elev; den = 1; break; }
        const w = 1 / d; num += w * clusters[ci].elev; den += w;
      }
      base = den ? num / den : clusters[cl[0]].elev;
    }
    const mx = compMaxNear[comp[li]];
    outCells.push(cells[li]);
    outBase.push(base);
    outRamp.push(mx > 0 && Number.isFinite(dNear[li]) ? dNear[li] / mx : 0);
  }
  if (!outCells.length) return;
  state.corridorCells = Int32Array.from(outCells);
  state.corridorBase = Float32Array.from(outBase);
  state.corridorRamp = Float32Array.from(outRamp);
  state.corridorSet = new Set(outCells);
}

// Per-feature "apply to compute" master toggles (1c/1d). When off, the data
// stays loaded (and its overlay can still be shown) but it does NOT affect the
// compute. Default true when the control is absent.
function impassableEnabled() { return document.getElementById("imp-enabled")?.checked ?? true; }
function bridgesEnabled() { return document.getElementById("bridge-enabled")?.checked ?? true; }

// True if a cell is traversable in the EFFECTIVE compute grid (raw DEM mask AND
// not impassable-unless-reopened-as-a-corridor). Used to validate point picks so
// clicks/refs can't land on blocked water that the compute would silently drop.
function effectivePassableAt(idx) {
  if (!state.dem || !state.dem.mask[idx]) return false;
  if (state.impassable && impassableEnabled() && state.impassable[idx]) {
    return !!(state.corridorSet && state.corridorSet.has(idx));
  }
  return true;
}

// THE single source of truth for the compute grid. Returns fresh, transferable
// height+mask with the impassable mask blocked and bridge corridors reopened +
// levelled. When state.impassable is null OR has no impassable cells (so
// recomputeCorridors produced no corridors), this returns byte-identical copies
// of state.dem.height/mask — guaranteeing prior results are reproduced exactly.
// Must be used by EVERY compute serialization site (worker, density pool,
// backend Blob, compare-secondary, graph build, probe) — there is no single
// dispatch choke point.
function buildComputeGrid(opts = {}) {
  const maskOnly = !!opts.maskOnly; // for the IDW interp DOMAIN (no height needed)
  const dem = state.dem;
  const height = maskOnly ? null : new Float32Array(dem.height);
  const mask = new Uint8Array(dem.mask);
  const imp = impassableEnabled() ? state.impassable : null; // 1c master toggle
  if (imp) {
    const N = mask.length;
    for (let i = 0; i < N; i++) if (imp[i] && mask[i]) mask[i] = 0; // block water on valid land
    const cells = state.corridorCells;
    if (cells && cells.length) {
      const off = maskOnly ? 0 : corridorOffsetMetres();
      const base = state.corridorBase, ramp = state.corridorRamp;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k];
        mask[i] = 1;                                  // reopen the corridor (even over nodata water)
        if (!maskOnly) height[i] = base[k] + off * ramp[k]; // smooth bridge profile
      }
    }
  }
  return maskOnly
    ? { mask, transfer: [mask.buffer] }
    : { height, mask, transfer: [height.buffer, mask.buffer] };
}

// Pack the loaded OSM bridges into portal-edge arrays for the engine: end-cell
// indices (u, v) and the deck length in metres. The worker/backend compute the
// directed deck cost from these + the (composed) height array, so JS and Rust
// derive identical costs (parity). Returns null when no bridges are loaded — in
// which case the compute is byte-identical to before (no-op invariant).
function buildPortals() {
  const brs = state.bridges;
  if (!brs || !brs.length || !bridgesEnabled()) return null; // 1d master toggle
  const n = brs.length;
  const u = new Int32Array(n), v = new Int32Array(n), lenM = new Float64Array(n);
  // Deck-END elevations from OSM `ele` (NaN = unmapped → the engine falls back to
  // the DEM at the abutment cell). hu/hv pair with endA/endB.
  const hu = new Float64Array(n), hv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    u[i] = brs[i].endA; v[i] = brs[i].endB; lenM[i] = brs[i].deckLenM;
    hu[i] = (brs[i].eleA != null) ? brs[i].eleA : NaN;
    hv[i] = (brs[i].eleB != null) ? brs[i].eleB : NaN;
  }
  return { u, v, lenM, hu, hv, n };
}

// Grid cells a bridge's deck geometry passes through (Bresenham along its
// polyline), clipped to the DEM. Used to paint deck passes/density.
function bridgeDeckCells(br) {
  const { W, H } = state.dem;
  const pts = br.latlngs.map(([lat, lng]) => llToCell(lat, lng));
  const cells = [];
  for (let i = 1; i < pts.length; i++) {
    let r = pts[i - 1][0], c = pts[i - 1][1];
    const r1 = pts[i][0], c1 = pts[i][1];
    const dr = Math.abs(r1 - r), dc = Math.abs(c1 - c), sr = r < r1 ? 1 : -1, sc = c < c1 ? 1 : -1;
    let err = dc - dr;
    for (;;) {
      if (r >= 0 && r < H && c >= 0 && c < W) cells.push(r * W + c);
      if (r === r1 && c === c1) break;
      const e2 = 2 * err;
      if (e2 > -dr) { err -= dr; c += sc; }
      if (e2 < dc) { err += dc; r += sr; }
    }
  }
  return cells;
}

// A bridge portal jumps abutment→abutment, so the deck's interior cells aren't
// in the path tree and carry no passes. Paint them with the flow crossing the
// bridge so the deck shows up: flow = min(passes[endA], passes[endB]) — which is
// exactly the portal's tree-edge flow (the downstream abutment's subtree) for a
// single source, and a tight estimate for round/density. max() so a deck cell
// with heavier ground traffic underneath isn't lowered. Raster modes only —
// graph mode already routes the (flattened) deck edges, so they carry passes.
function stampBridgeDeckPasses(passes) {
  if (!passes || !state.bridges || !state.dem || !bridgesEnabled()) return;
  for (const br of state.bridges) {
    const a = passes[br.endA], b = passes[br.endB];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const flow = Math.min(a, b);
    if (!(flow > 0)) continue;
    for (const cell of bridgeDeckCells(br)) if (flow > passes[cell]) passes[cell] = flow;
  }
}

// Vocab IRI deliberately points at the actual deployed file rather than an
// abstract namespace. Trade-off: bundles tie themselves to this serving URL,
// but in exchange the @vocab term resolves to a real document instead of a
// 404. If you ever move the deploy, set up a redirect from this URL or bump
// schemaVersion + ship a migration that rewrites the context.
const SIMU_CONTEXT = {
  "@vocab": "https://telhas.pedalhidrografi.co/simujoules/vocab/simujoules.jsonld#",
  "schema": "https://schema.org/",
  "geo": "http://www.opengis.net/ont/geosparql#",
  "qudt": "http://qudt.org/schema/qudt/",
};

function pixelToLonLat(idx, dem) {
  const r = (idx / dem.W) | 0;
  const c = idx - r * dem.W;
  return [dem.originX + (c + 0.5) * dem.dx, dem.originY - (r + 0.5) * dem.dy];
}

// Exact inverse of pixelToLonLat — recover the cell index from a [lon,lat]
// pair. Only safe when the DEM matches the one the coords were written
// against (callers gate on demDimsMatch === true). Used to rebuild the
// route/path index arrays from a bundle's GeoJSON on reload, so restored
// lines render and recolor identically to a fresh compute.
function lonLatToPixel(lon, lat, dem) {
  const c = Math.round((lon - dem.originX) / dem.dx - 0.5);
  const r = Math.round((dem.originY - lat) / dem.dy - 0.5);
  return r * dem.W + c;
}

// Rebuild a top-N `routes` list ({path, energy, length, shared}) from the
// routes.geojson FeatureCollection a bundle was exported with.
function routesFromFC(fc, dem) {
  if (!fc || !Array.isArray(fc.features)) return null;
  const routes = fc.features
    .filter((f) => f.geometry?.type === "LineString")
    .map((f) => {
      const p = f.properties || {};
      return {
        path:   f.geometry.coordinates.map(([lon, lat]) => lonLatToPixel(lon, lat, dem)),
        energy: p.energy ?? 0,
        length: p.length_m ?? 0,
        shared: p.shared_cells ?? 0,
      };
    });
  // Features are written in rank order (routesFCFromList), so the array is
  // already ordered best-first — no re-sort needed.
  return routes.length ? routes : null;
}

// Rebuild the maximize `path` index array from path.geojson.
function pathFromFC(fc, dem) {
  const feat = fc?.features?.find((f) => f.geometry?.type === "LineString");
  if (!feat) return null;
  return feat.geometry.coordinates.map(([lon, lat]) => lonLatToPixel(lon, lat, dem));
}

function pathFCFromIndices(path, dem, props = {}) {
  const coords = path.map((i) => pixelToLonLat(i, dem));
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: props,
    }],
  };
}

function routesFCFromList(routes, dem) {
  return {
    type: "FeatureCollection",
    features: routes.map((r, i) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: r.path.map((idx) => pixelToLonLat(idx, dem)),
      },
      properties: {
        rank: i + 1,
        energy: r.energy,
        length_m: r.length,
        shared_cells: r.shared,
      },
    })),
  };
}

// Graph-mode result → GeoJSON FeatureCollection (one LineString per edge with
// passes/energy/length). Node coords are fractional cells → [lng,lat] via the
// raw inverse (no +0.5; matches cellFracToLatLng).
function graphEdgesFC(graph, result, dem) {
  const lonlat = (r, c) => [dem.originX + c * dem.dx, dem.originY - r * dem.dy];
  const passes = result.edgePasses, energy = result.edgeEnergy;
  return {
    type: "FeatureCollection",
    features: Array.from({ length: graph.nEdges }, (_, e) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          lonlat(graph.nodeR[graph.edgeA[e]], graph.nodeC[graph.edgeA[e]]),
          lonlat(graph.nodeR[graph.edgeB[e]], graph.nodeC[graph.edgeB[e]]),
        ],
      },
      properties: {
        passes: passes ? passes[e] : 0,
        energy: energy && Number.isFinite(energy[e]) ? energy[e] : null,
        length_m: graph.edgeLenM[e],
      },
    })),
  };
}

function buildMetadata(result, withOutputs = true) {
  const dem = state.dem;
  const params = {
    mode:          document.getElementById("mode")?.value,
    alpha:         parseFloat(document.getElementById("alpha")?.value),
    beta:          parseFloat(document.getElementById("beta")?.value),
    eta:           parseFloat(document.getElementById("eta")?.value),
    eMax:          parseFloat(document.getElementById("e-max")?.value) || 0,
    eMaxMode:      document.getElementById("e-max-mode")?.value || "leg",
    src:           state.src,
    dst:           state.dst,
    wantPasses:    !!document.getElementById("want-passes")?.checked,
    wantTopN:      !!document.getElementById("want-topn")?.checked,
    nRoutes:       parseInt(document.getElementById("n-routes")?.value, 10) || 3,
    penalty:       parseFloat(document.getElementById("penalty")?.value) || 2.0,
    repulsionMode: document.getElementById("repulsion-mode")?.value || "per-cell",
    wantDensity:   !!document.getElementById("want-density")?.checked,
    nRefs:         parseInt(document.getElementById("n-refs")?.value, 10) || 10,
    refSource:     document.getElementById("ref-source")?.value || "click",
    maximize:      !!document.getElementById("maximize")?.checked,
    maximizeLength: parseInt(document.getElementById("maximize-length")?.value, 10) || 0,
    // refPoints carries the actual placed points so reload can re-stamp
    // the green markers exactly where they were.
    refPoints:     Array.isArray(state.refPoints) ? state.refPoints.slice() : [],
  };
  const viz = {
    fieldColormap:  activeColormap,
    routesColormap: document.getElementById("routes-colormap")?.value || "CET_R2",
    energy: {
      vmin:    readRangeInput("vmin", null),
      vmax:    readRangeInput("vmax", null),
      opacity: parseFloat(document.getElementById("energy-opacity")?.value),
      visible: !!document.getElementById("energy-visible")?.checked,
    },
    passes: {
      vmin:       readRangeInput("passes-vmin", null),
      vmax:       readRangeInput("passes-vmax", null),
      opacity:    parseFloat(document.getElementById("passes-opacity")?.value),
      visible:    !!document.getElementById("passes-visible")?.checked,
      blend:      document.getElementById("passes-blend")?.value || "plus-lighter",
      gamma:      parseFloat(document.getElementById("passes-gamma")?.value),
      meanWindow: parseInt(document.getElementById("passes-mean-window")?.value, 10) || 1,
    },
    tile: {
      url:     RMSAMPA_URL,
      opacity: parseFloat(document.getElementById("tile-opacity")?.value),
      visible: !!document.getElementById("tile-visible")?.checked,
    },
    relief: {
      opacity: parseFloat(document.getElementById("relief-opacity")?.value),
      visible: !!document.getElementById("relief-visible")?.checked,
    },
  };
  // Vector network constraint, if loaded. The actual rasterised mask is
  // saved separately as `network.bin` (see downloadBundle).
  const network = {
    enabled:           !!state.networkMask,
    constrain:         !!document.getElementById("vec-constrain")?.checked,
    compare:           !!document.getElementById("vec-compare")?.checked,
    graphMode:         !!document.getElementById("vec-graph-mode")?.checked,
    junctionMode:      graphJunctionMode(),
    srsId:             state.networkSrsId || null,
    featureCount:      state.networkFeatureCount || 0,
    lineWidth:         parseInt(document.getElementById("vec-width")?.value, 10) || 1,
    snapRadius:        parseInt(document.getElementById("vec-snap")?.value, 10) || 10,
    renderWidthM:      networkLineWidthM(),
    renderOpacity:     networkLineOpacity(),
    wantInterp:        !!document.getElementById("net-interp")?.checked,
    interpMaxDistance: parseInt(document.getElementById("net-interp-max-dist")?.value, 10) || 50,
    interpSmoothing:   parseInt(document.getElementById("net-interp-smoothing")?.value, 10) || 0,
  };
  // Impassable mask + bridge-corridor settings (the resampled mask raster is
  // saved separately as impassable.tif — see downloadBundle).
  const impassable = {
    enabled:          !!state.impassable,
    apply:            impassableEnabled(),
    corridorOverride: !!document.getElementById("imp-corridor")?.checked,
    elevationOffset:  corridorOffsetMetres(),
    invert:           !!document.getElementById("impassable-invert")?.checked,
    show:             !!document.getElementById("imp-show")?.checked,
    opacity:          impassableOverlayOpacity(),
    sourceName:       state.impassableMeta?.name || null,
    srcWidth:         state.impassableMeta?.width || null,
    srcHeight:        state.impassableMeta?.height || null,
    srs:              state.impassableMeta?.srs || null,
    cells:            state.impassableMeta?.cellsImpassable || 0,
  };
  // OSM bridges & tunnels (geometry saved separately as bridges.geojson).
  const bridges = {
    enabled:  !!(state.bridges && state.bridges.length),
    apply:    bridgesEnabled(),
    count:    state.bridges ? state.bridges.length : 0,
    source:   state.bridgesMeta?.source || null,
    tunnels:  !!document.getElementById("bridge-tunnels")?.checked,
    show:     !!document.getElementById("bridge-show")?.checked,
    opacity:  bridgeOverlayOpacity(),
  };

  const md = {
    "@context":           SIMU_CONTEXT,
    "@type":              "EnergyFieldComputation",
    "schema:dateCreated": new Date().toISOString(),
    timestamp:            new Date().toISOString(),
    // schemaVersion 3: outputs are GeoTIFFs (energy.tif/passes.tif/network.tif)
    // instead of raw .bin dumps, so the unzipped bundle drops directly into
    // QGIS. v2 bundles with .bin still load — see loadBundleFile fallback.
    schemaVersion:        3,
    // engine is always "js" now (wasm removed). Kept in the metadata for
    // round-trip compatibility with older bundle readers.
    engine:               "js",
    elapsedMs:            result?.elapsedMs ?? null,
    dem: {
      label:        state.demLabel || null,
      sourceUrl:    state.demSourceUrl || null,
      H:            dem.H,
      W:            dem.W,
      originX:      dem.originX,
      originY:      dem.originY,
      dx:           dem.dx,
      dy:           dem.dy,
      dxM:          dem.dxM,
      dyM:          dem.dyM,
      isGeographic: dem.isGeographic,
    },
    params,
    viz,
    network,
    impassable,
    bridges,
    stats: {
      maxE:        state.lastAutoMax ?? null,
      maxPasses:   state.lastPassesAutoMax ?? null,
      pathEnergy:  result?.pathEnergy ?? null,
      pathLengthM: result?.pathLengthM ?? null,
    },
  };

  if (withOutputs && result) {
    // Each raster output is a GeoTIFF — same CRS / extent / pixel grid as
    // the source DEM, so QGIS can stack them on top without reprojection.
    // The "type" hint encodes the pixel datatype so the loader knows which
    // typed array to read into; "format" disambiguates from older v2 .bin.
    md.outputs = {
      energy: result.energy ? {
        format: "GeoTIFF",
        type:   "Float32",
        shape:  [dem.H, dem.W],
        file:   "energy.tif",
      } : null,
      passes: result.passes ? {
        format: "GeoTIFF",
        type:   "Float64",
        shape:  [dem.H, dem.W],
        file:   "passes.tif",
      } : null,
      // Alternate ("compare with the unconstrained / no-network") scenario: the
      // unconstrained energy + passes and the precomputed (network-masked, interp-
      // filled) difference field — what the difference/unconstrained views render.
      // Only the GRID compare path writes these (graph-mode alt lives on
      // state.lastGraphResult, not exported yet) — gate the descriptors so the
      // metadata never claims a file the zip omits.
      energyUnconstrained: (!state.lastGraphResult && result.energyAlt?.unconstrained) ? {
        format: "GeoTIFF", type: "Float32", shape: [dem.H, dem.W], file: "energy_unconstrained.tif",
      } : null,
      energyDifference: (!state.lastGraphResult && result.energyAlt?.difference) ? {
        format: "GeoTIFF", type: "Float32", shape: [dem.H, dem.W], file: "energy_difference.tif",
      } : null,
      passesUnconstrained: (!state.lastGraphResult && result.passesAlt?.unconstrained) ? {
        format: "GeoTIFF", type: "Float64", shape: [dem.H, dem.W], file: "passes_unconstrained.tif",
      } : null,
      network: state.networkMask ? {
        format: "GeoTIFF",
        type:   "Uint8",
        shape:  [dem.H, dem.W],
        file:   "network.tif",
      } : null,
      impassable: state.impassable ? {
        format: "GeoTIFF",
        type:   "Uint8",
        shape:  [dem.H, dem.W],
        file:   "impassable.tif",
      } : null,
      bridges: (state.bridges && state.bridges.length) ? {
        format: "GeoJSON",
        file:   "bridges.geojson",
      } : null,
      routes: result.routes && result.routes.length ? {
        format: "GeoJSON",
        file:   "routes.geojson",
      } : null,
      path: result.path && result.path.length ? {
        format: "GeoJSON",
        file:   "path.geojson",
      } : null,
    };
  }
  return md;
}

// Export the already-rendered energy / passes PNGs (colormap, range, gamma
// and mean filter baked in — byte-identical to what the map overlays show)
// as a zip with ESRI world files (.pgw) + .prj, so they drop into QGIS
// georeferenced. Complements the bundle export, which carries the RAW
// fields as GeoTIFFs.
//
// Deliberately excluded: the relief render (stride-downsampled on huge
// DEMs, so the DEM's dx/dy world file would be wrong for it), and CSS
// blend effects (plus-lighter etc. happen at compositing time in the
// browser, not in the PNG — the "energy color" passes mode IS baked in,
// since that one is painted into the canvas).
const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
  'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';

async function exportRenderedImages() {
  try {
    if (!state.dem || !state.lastResult) {
      status.textContent = t("status.nothing_rendered");
      return;
    }
    const items = [];
    if (state.energyDataUrl) items.push(["energy_rendered", state.energyDataUrl]);
    if (state.passesDataUrl) items.push(["passes_rendered", state.passesDataUrl]);
    if (!items.length) {
      status.textContent = t("status.no_layers_export");
      return;
    }
    if (typeof JSZip === "undefined") throw new Error("JSZip didn't load");

    const { dx, dy, originX, originY, isGeographic } = state.dem;
    // World file: pixel size, rotation terms, centre of the top-left pixel.
    const worldFile =
      `${dx}\n0\n0\n${-dy}\n${originX + dx / 2}\n${originY - dy / 2}\n`;

    const zip = new JSZip();
    for (const [name, url] of items) {
      zip.file(`${name}.png`, url.split(",")[1], { base64: true });
      zip.file(`${name}.pgw`, worldFile);
      // Only stamp a CRS we actually know. Projected DEMs still get the
      // world file (correct pixel grid); assign the CRS manually in QGIS.
      if (isGeographic) zip.file(`${name}.prj`, WGS84_WKT);
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/-Z?$/, "");
    const slug = state.demLabel
      ? state.demLabel.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") + "-"
      : "";
    const a = document.createElement("a");
    a.href = url;
    a.download = `simujoules-rendered-${slug}${ts}.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    status.textContent =
      t("status.exported_layers", items.length, (blob.size / 1024 / 1024).toFixed(1));
  } catch (err) {
    console.error("[export-rendered] failed:", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.export_failed", escapeHtml(err.message))}</span>`;
  }
}

async function downloadBundle() {
  console.info("[bundle] download click — lastResult?", !!state.lastResult, "dem?", !!state.dem, "JSZip?", typeof JSZip);
  if (!state.dem) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.download_need_dem")}</span>`;
    return;
  }
  if (!state.lastResult && !state.lastGraphResult) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.download_need_compute")}</span>`;
    return;
  }
  if (typeof JSZip === "undefined") {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.jszip_failed")}</span>`;
    return;
  }
  status.textContent = t("status.building_bundle");
  try {
    const graphMode = !!state.lastGraphResult;
    const r = state.lastResult || {}; // graph-only bundles carry no grid result
    const dem = state.dem;
    const md = buildMetadata(state.lastResult, true);
    if (graphMode) {
      md.outputs = md.outputs || {};
      md.outputs.graphEdges = { format: "GeoJSON", file: "graph_edges.geojson", junctionMode: graphJunctionMode() };
    }

    const zip = new JSZip();
    zip.file("metadata.jsonld", JSON.stringify(md, null, 2));
    // Output rasters as GeoTIFFs — the unzipped bundle drops straight into
    // QGIS / any GIS, no .bin-plus-metadata gymnastics. CRS and pixel grid
    // are inherited from the source DEM via tiffMetadataForDem.
    if (r.energy && !graphMode) {
      zip.file("energy.tif",  new Uint8Array(writeRasterAsGeoTIFF(r.energy, dem, "float32")));
    }
    if (r.passes && !graphMode) {
      zip.file("passes.tif",  new Uint8Array(writeRasterAsGeoTIFF(r.passes, dem, "float64")));
    }
    // Alternate scenario for a "Comparar com cenário sem rede" (compare) run:
    // the unconstrained energy/passes and the saved difference field, so the
    // difference / unconstrained views survive a reload (not just the toggle).
    if (r.energyAlt?.unconstrained && !graphMode) {
      zip.file("energy_unconstrained.tif", new Uint8Array(writeRasterAsGeoTIFF(r.energyAlt.unconstrained, dem, "float32")));
    }
    if (r.energyAlt?.difference && !graphMode) {
      zip.file("energy_difference.tif", new Uint8Array(writeRasterAsGeoTIFF(r.energyAlt.difference, dem, "float32")));
    }
    if (r.passesAlt?.unconstrained && !graphMode) {
      zip.file("passes_unconstrained.tif", new Uint8Array(writeRasterAsGeoTIFF(r.passesAlt.unconstrained, dem, "float64")));
    }
    // The rasterised network mask reproduces the constrained compute even
    // when the source .gpkg isn't handy at reload. Stored as a 1-byte-per-
    // cell GeoTIFF (uint8) so QGIS can also display it as a raster mask.
    if (state.networkMask) {
      zip.file("network.tif", new Uint8Array(writeRasterAsGeoTIFF(state.networkMask, dem, "uint8")));
    }
    // The resampled impassable mask (DEM-aligned uint8) reproduces the blocked
    // water + bridge corridors on reload without re-uploading the source raster.
    if (state.impassable) {
      zip.file("impassable.tif", new Uint8Array(writeRasterAsGeoTIFF(state.impassable, dem, "uint8")));
    }
    // OSM bridges/tunnels as GeoJSON — re-derived into decks on reload.
    if (state.bridges && state.bridges.length) {
      zip.file("bridges.geojson", JSON.stringify(bridgesToFC(state.bridges), null, 2));
    }
    if (r.routes && r.routes.length && !graphMode) {
      zip.file("routes.geojson", JSON.stringify(routesFCFromList(r.routes, dem), null, 2));
    }
    if (r.path && r.path.length && !graphMode) {
      zip.file("path.geojson", JSON.stringify(pathFCFromIndices(r.path, dem, {
        energy: r.pathEnergy,
        length_m: r.pathLengthM,
      }), null, 2));
    }
    // "Follow the vectors" result → per-edge GeoJSON (passes/energy/length).
    if (state.lastGraphResult) {
      zip.file("graph_edges.geojson", JSON.stringify(
        graphEdgesFC(state.lastGraphResult.graph, state.lastGraphResult.result, dem), null, 2));
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/-Z?$/, "");
    const slug = state.demLabel ? state.demLabel.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") + "-" : "";
    const a = document.createElement("a");
    a.href = url;
    a.download = `simujoules-${slug}${ts}.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    status.textContent = t("status.bundle_saved", (blob.size / 1024 / 1024).toFixed(1));
  } catch (err) {
    console.error("[bundle] download failed:", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.download_failed", escapeHtml(err.message))}</span>`;
  }
}

// Read a bundle (.zip with metadata.jsonld + arrays) or a bare .jsonld and
// restore as much UI/state as possible. After restoration: if a matching
// DEM is already loaded, src/dst markers are placed and the user can click
// Compute to reproduce. If no DEM, the status nudges them to load one.
async function loadBundleFile(file) {
  try {
    let md;
    let bin = {}; // { energy: Float32Array, passes: Float64Array, ... }
    if (/\.zip$/i.test(file.name)) {
      if (typeof JSZip === "undefined") throw new Error("JSZip didn't load");
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const mdEntry = zip.file("metadata.jsonld") || zip.file("metadata.json");
      if (!mdEntry) throw new Error("No metadata.jsonld inside the archive.");
      md = JSON.parse(await mdEntry.async("string"));
      // v3 bundles use GeoTIFFs for the rasters; v2 used raw little-endian
      // .bin dumps. Try .tif first, fall back to .bin so old bundles still
      // load after this change.
      const eTif = zip.file("energy.tif"),  eBin = zip.file("energy.bin");
      if (eTif) {
        bin.energy = await readRasterFromGeoTIFF(await eTif.async("arraybuffer"), "float32");
      } else if (eBin) {
        bin.energy = new Float32Array(await eBin.async("arraybuffer"));
      }
      const pTif = zip.file("passes.tif"),  pBin = zip.file("passes.bin");
      if (pTif) {
        bin.passes = await readRasterFromGeoTIFF(await pTif.async("arraybuffer"), "float64");
      } else if (pBin) {
        bin.passes = new Float64Array(await pBin.async("arraybuffer"));
      }
      // Alternate-scenario rasters (compare view): unconstrained energy/passes +
      // the saved difference field. Held on `bin` so the pending-DEM replay picks
      // them up too; reconstructed onto state.lastResult.energyAlt/passesAlt below.
      const euTif = zip.file("energy_unconstrained.tif");
      if (euTif) bin.energyUnconstrained = await readRasterFromGeoTIFF(await euTif.async("arraybuffer"), "float32");
      const edTif = zip.file("energy_difference.tif");
      if (edTif) bin.energyDifference = await readRasterFromGeoTIFF(await edTif.async("arraybuffer"), "float32");
      const puTif = zip.file("passes_unconstrained.tif");
      if (puTif) bin.passesUnconstrained = await readRasterFromGeoTIFF(await puTif.async("arraybuffer"), "float64");
      const nTif = zip.file("network.tif"), nBin = zip.file("network.bin");
      if (nTif) {
        bin.network = await readRasterFromGeoTIFF(await nTif.async("arraybuffer"), "uint8");
      } else if (nBin) {
        bin.network = new Uint8Array(await nBin.async("arraybuffer"));
      }
      const iTif = zip.file("impassable.tif");
      if (iTif) bin.impassable = await readRasterFromGeoTIFF(await iTif.async("arraybuffer"), "uint8");
      const brGeo = zip.file("bridges.geojson");
      if (brGeo) { try { bin.bridgesFC = JSON.parse(await brGeo.async("string")); } catch {} }
      // Route/path vector geometry. These ride alongside the rasters and get
      // re-rendered (converted back to cell indices) once a matching DEM is
      // present — no recompute needed. Held in `bin` so the pending-bundle
      // replay (loadDemFromArrayBuffer) picks them up too.
      const rGeo = zip.file("routes.geojson");
      if (rGeo) { try { bin.routesFC = JSON.parse(await rGeo.async("string")); } catch {} }
      const pGeo = zip.file("path.geojson");
      if (pGeo) { try { bin.pathFC = JSON.parse(await pGeo.async("string")); } catch {} }
    } else if (/\.jsonld?$|\.json$/i.test(file.name)) {
      md = JSON.parse(await file.text());
    } else {
      throw new Error("Unrecognised file — pass a .zip bundle or .jsonld.");
    }
    applyMetadataToUI(md, bin);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.reload_failed", escapeHtml(err.message))}</span>`;
  }
}

function applyMetadataToUI(md, bin = {}) {
  const p = md.params || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
  const check = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.checked = !!v; };

  // ---- DEM dimension check -----------------------------------------------
  // Binary outputs (energy/passes/network) are sized to the bundle's DEM.
  // Replaying them onto a different DEM would corrupt the visualisation,
  // so we gate the binary path on a strict H×W match. Parameters/UI still
  // get applied — the user is told to re-Compute.
  const bundleH = md.dem?.H, bundleW = md.dem?.W;
  const demDimsMatch =
    state.dem && Number.isFinite(bundleH) && Number.isFinite(bundleW)
      ? state.dem.H === bundleH && state.dem.W === bundleW
      : null; // null = unknown (no DEM loaded yet, or bundle didn't record dims)
  if (state.dem && demDimsMatch === false) {
    console.warn(
      `[bundle] DEM dimension mismatch: bundle ${bundleW}×${bundleH}, ` +
      `loaded ${state.dem.W}×${state.dem.H}. Skipping binary replay.`
    );
  }

  // No DEM yet (or the wrong one): hold the full bundle — rasters included —
  // so loadDemFromArrayBuffer can re-apply it when a matching DEM lands.
  // A successful full application clears the slot.
  state.pendingBundle = (!state.dem || demDimsMatch === false) ? { md, bin } : null;

  set("mode", p.mode);
  set("alpha", p.alpha);
  set("beta", p.beta);
  set("eta", p.eta);
  set("e-max", p.eMax);
  set("e-max-mode", p.eMaxMode);
  check("want-passes", p.wantPasses);
  check("want-topn", p.wantTopN);
  set("n-routes", p.nRoutes);
  set("penalty", p.penalty);
  set("repulsion-mode", p.repulsionMode);
  check("want-density", p.wantDensity);
  check("maximize", p.maximize);
  set("maximize-length", p.maximizeLength);
  set("n-refs", p.nRefs);
  set("ref-source", p.refSource);

  const v = md.viz || {};
  if (v.fieldColormap && COLORMAPS[v.fieldColormap]) {
    activeColormap = v.fieldColormap;
    const sel = document.getElementById("colormap"); if (sel) sel.value = v.fieldColormap;
    applyColormapToLegend();
  }
  if (v.routesColormap && COLORMAPS[v.routesColormap]) {
    set("routes-colormap", v.routesColormap);
  }
  if (v.energy) {
    set("vmin", v.energy.vmin);
    set("vmax", v.energy.vmax);
    set("energy-opacity", v.energy.opacity);
    check("energy-visible", v.energy.visible);
  }
  if (v.passes) {
    set("passes-vmin", v.passes.vmin);
    set("passes-vmax", v.passes.vmax);
    set("passes-opacity", v.passes.opacity);
    check("passes-visible", v.passes.visible);
    set("passes-blend", v.passes.blend);
    set("passes-gamma", v.passes.gamma);
    set("passes-mean-window", v.passes.meanWindow);
  }
  if (v.tile) {
    set("tile-opacity", v.tile.opacity);
    check("tile-visible", v.tile.visible);
  }
  if (v.relief) {
    set("relief-opacity", v.relief.opacity);
    check("relief-visible", v.relief.visible);
  }

  // ---- Vector network params ---------------------------------------------
  // Slider/checkbox values from the bundle's `network` section. Mask
  // restoration happens further down once we've also confirmed DEM dims.
  const net = md.network || {};
  set("vec-width", net.lineWidth);
  set("vec-snap", net.snapRadius);
  check("net-interp", net.wantInterp);
  check("vec-constrain", net.constrain);
  check("vec-compare", net.compare);
  check("vec-graph-mode", net.graphMode);
  if (net.junctionMode) set("vec-junction-mode", net.junctionMode);
  set("net-interp-max-dist", net.interpMaxDistance);
  set("net-interp-smoothing", net.interpSmoothing);
  set("vec-render-width", net.renderWidthM);
  set("vec-render-opacity", net.renderOpacity);
  updateNetworkLineStyle();

  // ---- Impassable mask params (mask restore happens further down) --------
  const imp = md.impassable || {};
  check("imp-enabled", imp.apply);
  check("impassable-invert", imp.invert);
  set("imp-offset", Number.isFinite(imp.elevationOffset) ? imp.elevationOffset : 0);
  set("imp-opacity", Number.isFinite(imp.opacity) ? imp.opacity : 0.5);
  check("imp-corridor", imp.corridorOverride);
  check("imp-show", imp.show);
  // Reveal the dependent rows to match the restored toggles (without firing the
  // change handlers — corridors are recomputed once the mask is restored below).
  { const r = document.getElementById("imp-offset-row");
    if (r) r.style.display = document.getElementById("imp-corridor")?.checked ? "" : "none"; }
  { const r = document.getElementById("imp-opacity-row");
    if (r) r.style.display = document.getElementById("imp-show")?.checked ? "" : "none"; }

  // ---- Bridge/tunnel params (geometry restore happens further down) -------
  const br = md.bridges || {};
  check("bridge-enabled", br.apply);
  check("bridge-tunnels", br.tunnels);
  check("bridge-show", br.show);
  set("bridge-opacity", Number.isFinite(br.opacity) ? br.opacity : 0.9);

  // (Engine preference is no longer user-selectable — JS only.
  // md.enginePreference from older bundles is read but ignored.)

  // Trigger UI sync for toggles that reveal/hide their option groups —
  // top-N exposes the routes-count + repulsion controls, density swaps
  // src/dst for the multi-ref UI and disables/enables the energy layer.
  const topnCheck = document.getElementById("want-topn");
  if (topnCheck) topnCheck.dispatchEvent(new Event("change"));
  const densityCheck = document.getElementById("want-density");
  if (densityCheck) densityCheck.dispatchEvent(new Event("change"));

  // Restore src/dst pixel positions. If a DEM is loaded that matches the
  // bundle's DEM dimensions, place markers right away; otherwise hold the
  // values for when the DEM gets loaded.
  if (Array.isArray(p.src)) state.src = p.src.slice(0, 2);
  if (Array.isArray(p.dst)) state.dst = p.dst.slice(0, 2);

  function placeMarker(point, label) {
    if (!state.dem || !point) return null;
    const [r, c] = point;
    const { originX, originY, dx, dy } = state.dem;
    const latlng = L.latLng(originY - (r + 0.5) * dy, originX + (c + 0.5) * dx);
    return L.marker(latlng, { icon: makeSrcDstIcon(label === "Source" ? "src" : "dst") })
      .addTo(map).bindTooltip(label);
  }
  // Don't drop markers onto a mismatched DEM — they'd land on bogus pixels.
  // Also skip in density mode — the "Pick points" UI is hidden / disabled
  // there and stale src/dst markers would just clutter the map.
  const densityOnNow = !!document.getElementById("want-density")?.checked;
  if (state.dem && state.src && demDimsMatch !== false && !densityOnNow) {
    if (state.srcMarker) state.srcMarker.remove();
    state.srcMarker = placeMarker(state.src, "Source");
    document.getElementById("src-display").textContent = `r=${state.src[0]}, c=${state.src[1]}`;
    document.getElementById("src-display").classList.add("set");
  }
  if (state.dem && state.dst && demDimsMatch !== false && !densityOnNow) {
    if (state.dstMarker) state.dstMarker.remove();
    state.dstMarker = placeMarker(state.dst, "Destination");
    document.getElementById("dst-display").textContent = `r=${state.dst[0]}, c=${state.dst[1]}`;
    document.getElementById("dst-display").classList.add("set");
  }

  // ---- Reference points (multi-ref density) ------------------------------
  // Re-stamp the FIFO ring exactly as it was. addRefPoint pushes + numbers
  // the markers and respects enforceRefCap, so the cap field set above
  // governs how many actually survive.
  if (Array.isArray(p.refPoints) && state.dem && demDimsMatch !== false) {
    // Clear whatever is on the map from a previous bundle / run.
    if (state.refMarkers) for (const m of state.refMarkers) m.remove();
    state.refMarkers = [];
    state.refPoints = [];
    for (const rc of p.refPoints) {
      if (Array.isArray(rc) && rc.length >= 2) addRefPoint([rc[0] | 0, rc[1] | 0]);
    }
    syncRefDisplay();
  }

  // ---- Network mask restore ---------------------------------------------
  // Only when we have a DEM, dims match, and the byte length matches H*W.
  // Otherwise leave the slot empty — better to recompute than to load a
  // mask that points at the wrong cells.
  if (bin.network && state.dem && demDimsMatch === true) {
    const N = state.dem.H * state.dem.W;
    if (bin.network.length === N) {
      state.networkMask = bin.network;
      state.networkSrsId = net.srsId || null;
      state.networkFeatureCount = net.featureCount || 0;
      const meta = document.getElementById("vec-meta");
      if (meta) {
        // srsId / featureCount come from the bundle's metadata.jsonld, which a
        // shared/crafted bundle controls — escape before innerHTML (stored XSS).
        meta.innerHTML =
          `Restored from bundle: <span class="v">${escapeHtml(String(state.networkFeatureCount))}</span> ` +
          `features (SRS ${escapeHtml(String(state.networkSrsId ?? "?"))}).`;
      }
    } else {
      console.warn(
        `[bundle] network.bin size mismatch: ${bin.network.length} bytes vs H*W=${N}. Discarded.`
      );
    }
  }

  // ---- Impassable mask restore -------------------------------------------
  // After the network mask (corridors depend on it) and under the same dim
  // check. We only have the DEM-aligned resampled mask here, not the source
  // raster, so the Invert toggle won't re-resample (already baked in).
  if (bin.impassable && state.dem && demDimsMatch === true) {
    const N = state.dem.H * state.dem.W;
    if (bin.impassable.length === N) {
      let cells = 0;
      for (let i = 0; i < N; i++) if (bin.impassable[i]) cells++;
      state.impassable = bin.impassable;
      state.impassableMeta = {
        name: imp.sourceName || "mask", width: imp.srcWidth || null,
        height: imp.srcHeight || null, srs: imp.srs || null, cellsImpassable: cells,
      };
      recomputeCorridors();
      updateImpassableMeta();
      updateCorridorAvailability();
      applyImpassableOverlay();
    } else {
      console.warn(`[bundle] impassable.tif size mismatch: ${bin.impassable.length} vs H*W=${N}. Discarded.`);
    }
  }

  // ---- Bridges/tunnels restore -------------------------------------------
  // Re-derive decks from the saved GeoJSON (endA/endB depend on the grid, so
  // only under a dimension match). installBridgesFromWays handles overlay +
  // invalidation, mirroring a fresh OSM pull.
  if (bin.bridgesFC && state.dem && demDimsMatch === true) {
    const ways = (bin.bridgesFC.features || [])
      .filter((f) => f.geometry?.type === "LineString" && Array.isArray(f.geometry.coordinates))
      .map((f) => ({
        latlngs: f.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
        kind: f.properties?.kind || "bridge",
        layer: f.properties?.layer || 0,
        name: f.properties?.name || null,
        eleA: Number.isFinite(f.properties?.eleA) ? f.properties.eleA : null,
        eleB: Number.isFinite(f.properties?.eleB) ? f.properties.eleB : null,
      }));
    if (ways.length) installBridgesFromWays(ways, "bundle");
  }

  applyLayerControls();
  estimateRunTime();

  // If we got the cached outputs back, render them straight away — no
  // recompute needed. Skip if the DEM dimensions don't match (or no DEM
  // is loaded yet). Routes/path come back from GeoJSON (converted to cell
  // indices); the energy/passes rasters come back from the GeoTIFFs. Any
  // subset is fine — a maximize bundle has a path but no top-N routes, a
  // density bundle has neither.
  let restored = false;
  if (state.dem && demDimsMatch === true) {
    const N = state.dem.H * state.dem.W;
    const energyOk = bin.energy && bin.energy.length === N;
    const passesOk = bin.passes && bin.passes.length === N;
    const routes = routesFromFC(bin.routesFC || null, state.dem);
    const path = routes ? null : pathFromFC(bin.pathFC || null, state.dem);
    // Render whenever we recovered anything drawable; routes take precedence
    // over a lone path (renderResult draws one or the other, mirroring a
    // fresh compute where top-N and maximize are mutually exclusive).
    if (energyOk || passesOk || routes || path) {
      // Rebuild the compare scenarios from the alt rasters so the displayed-
      // scenario picker + the difference/unconstrained views come back (not just
      // the toggle). renderResult shows #energy-source-row when these are present.
      const eu = bin.energyUnconstrained?.length === N ? bin.energyUnconstrained : null;
      const ed = bin.energyDifference?.length === N ? bin.energyDifference : null;
      const pu = bin.passesUnconstrained?.length === N ? bin.passesUnconstrained : null;
      const energyAlt = (eu || ed) ? { unconstrained: eu, difference: ed } : null;
      const passesAlt = pu ? { unconstrained: pu } : null;
      const synth = {
        energy:      energyOk ? bin.energy : null,
        passes:      passesOk ? bin.passes : null,
        path,
        pathEnergy:  md.stats?.pathEnergy ?? null,
        pathLengthM: md.stats?.pathLengthM ?? null,
        routes,
        elapsedMs:   md.elapsedMs ?? 0,
        energyAlt,
        passesAlt,
      };
      renderResult(synth);
      setGroupOpen("result-group", true); // bundle loaded a result → reveal it
      restored = true;
    }
  }

  updateRunButtonState();
  if (restored) {
    status.textContent = t("status.bundle_restored");
  } else if (state.dem && demDimsMatch === false) {
    status.innerHTML =
      `<span style="color:#ff9d3d">${t("status.bundle_dem_mismatch", bundleW, bundleH, state.dem.W, state.dem.H)}</span>`;
  } else if (state.dem && (state.src || (p.wantDensity && state.refPoints?.length))) {
    status.textContent = t("status.bundle_params_loaded");
  } else if (!state.dem) {
    const hint = md.dem?.sourceUrl ? ` (try ${escapeHtml(md.dem.sourceUrl)})` : "";
    status.innerHTML = `<span style="opacity:0.85">${t("status.bundle_need_dem", hint)}</span>`;
  } else {
    status.textContent = t("status.bundle_loaded");
  }
}
