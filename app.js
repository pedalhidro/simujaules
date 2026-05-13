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
  "locate.unavailable":  { pt: "Localização indisponível.",             en: "Location unavailable." },
  "locate.timeout":      { pt: "Tempo esgotado ao buscar localização.", en: "Location lookup timed out." },
  "locate.error":        { pt: "Erro ao buscar localização.",           en: "Location lookup failed." },
  "locate.unsupported":  { pt: "Geolocalização não suportada.",         en: "Geolocation not supported." },
  "help.title":          { pt: "Como funciona", en: "How it works" },

  // ---- Group: Load DEM --------------------------------------------------
  "group.load_dem":      { pt: "1. Carregar DEM", en: "1. Load DEM" },
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
  "group.network":       { pt: "1b. Rede vetorial opcional (.gpkg)", en: "1b. Optional vector network (.gpkg)" },
  "net.line_width":      { pt: "largura da linha (células)", en: "line width (cells)" },
  "net.snap_radius":     { pt: "raio de snap (células)", en: "snap radius (cells)" },
  "net.clear":           { pt: "Limpar rede",  en: "Clear network" },
  "net.interp":          { pt: "Interpolar entre células fora da rede", en: "Interpolate across non-network cells" },
  "net.max_distance":    { pt: "distância máx (células)", en: "max distance (cells)" },
  "net.smoothing":       { pt: "suavizações", en: "smoothing iters" },
  "net.no_network":      { pt: "Nenhuma rede carregada.", en: "No network loaded." },

  // ---- Group: Pick points ----------------------------------------------
  "group.pick_points":   { pt: "2. Marcar pontos", en: "2. Pick points" },
  "pts.click_map":       { pt: "— clicar mapa —", en: "— click map —" },
  "pts.optional":        { pt: "— opcional —",  en: "— optional —" },
  "pts.click_again":     { pt: "— clicar novamente —", en: "— click again —" },
  "pts.density":         { pt: "— densidade —", en: "— density —" },
  "pts.clear":           { pt: "Limpar pontos", en: "Clear points" },

  // ---- Group: Parameters -----------------------------------------------
  "group.parameters":    { pt: "3. Parâmetros", en: "3. Parameters" },
  "param.mode":          { pt: "Modo", en: "Mode" },
  "mode.from":           { pt: "Saindo da fonte",     en: "From source" },
  "mode.to":             { pt: "Vindo até a fonte",  en: "To source point" },
  "mode.round":          { pt: "Ida e volta",         en: "Round trip" },
  "param.alpha":         { pt: "α (por metro plano)", en: "α (per metre flat)" },
  "param.beta":          { pt: "β (por metro de subida)", en: "β (per metre uphill)" },
  "param.eta":           { pt: "η (recuperação descida)", en: "η (downhill recovery)" },
  "param.budget":        { pt: "Orçamento de energia (≤0 = ∞)", en: "Energy budget (≤0 = ∞)" },
  "param.want_passes":   { pt: "Calcular contagem de passagens", en: "Compute passes count (route density)" },
  "param.want_topn":     { pt: "Calcular top-N rotas", en: "Compute top-N routes" },
  "param.want_density":  { pt: "Calcular densidade multi-referência", en: "Compute multi-reference density" },
  "param.maximize":      { pt: "Maximizar energia (inverter otimização)", en: "Maximize energy (reverse optimization)" },
  "param.max_length":    { pt: "Comprimento L (arestas, 0 = sem restrição)", en: "Path length L (edges, 0 = unconstrained)" },
  "param.max_length.hint": { pt: "0: Dijkstra invertido (geometricamente curto, custo denso). L>0: DP em camadas encontra o caminho de custo máximo com exatamente L arestas entre src e dst. Limite de memória ≈ 256 MB ⇒ L·H·W precisa caber; DEMs grandes limitam L a poucas dezenas.", en: "0: inverted Dijkstra (geometrically short, cost-dense). L>0: layered DP finds the max-cost path of exactly L edges from src to dst. Memory cap ≈ 256 MB ⇒ L·H·W must fit; large DEMs limit L to a few dozen." },
  "param.n_refs":        { pt: "N referências", en: "N references" },
  "param.ref_source":    { pt: "Origem das referências", en: "Reference source" },
  "ref.click":           { pt: "clicar no mapa", en: "click on map" },
  "ref.random":          { pt: "aleatórias", en: "random" },
  "ref.direction_hint":  { pt: "A direção segue o Modo acima.", en: "Direction follows the Mode above." },
  "ref.place_random":    { pt: "Distribuir aleatórias", en: "Place random" },
  "ref.clear":           { pt: "Limpar referências", en: "Clear refs" },
  "ref.none":            { pt: "nenhuma referência marcada", en: "no references placed" },
  "param.n_routes":      { pt: "N (1–20)", en: "N (1–20)" },
  "param.penalty":       { pt: "penalidade / força", en: "penalty / strength" },
  "param.repulsion":     { pt: "Modo de repulsão", en: "Repulsion mode" },
  "rep.per_cell":        { pt: "por célula (penalidade^usadas) — afiada", en: "per-cell (penalty^used) — sharp" },
  "rep.linear":          { pt: "linear 1/(d+1) — suave, ampla", en: "linear 1/(d+1) — soft, wide" },
  "rep.square":          { pt: "quadrática 1/(d²+1) — suave, local", en: "square 1/(d²+1) — soft, local" },
  "param.routes_cmap":   { pt: "Colormap das rotas", en: "Routes colormap" },
  "param.field_cmap":    { pt: "Colormap do campo", en: "Field colormap" },

  // ---- Compute -----------------------------------------------------------
  "btn.compute":         { pt: "Calcular", en: "Compute" },

  // ---- Group: Result ----------------------------------------------------
  "group.result":        { pt: "Resultado", en: "Result" },
  "btn.refresh_style":   { pt: "Atualizar estilo", en: "Refresh style" },
  "result.empty":        { pt: "—", en: "—" },
  "layer.tiles":         { pt: "rmsampa-v2 tiles", en: "rmsampa-v2 tiles" },
  "layer.tiles.hint":    { pt: '<a href="https://telhas.pedalhidrografi.co/rmsampa-v2/" target="_blank" rel="noopener" style="color: var(--accent-2);">Tiles XYZ</a> de pedalhidrografi.co.', en: '<a href="https://telhas.pedalhidrografi.co/rmsampa-v2/" target="_blank" rel="noopener" style="color: var(--accent-2);">XYZ tiles</a> from pedalhidrografi.co.' },
  "layer.relief":        { pt: "Relevo (DEM)", en: "Relief (DEM)" },
  "layer.relief.hint":   { pt: "cmocean.phase, p5–p80 · declividade 0–p80 (γ=1.2) multiplicada", en: "cmocean.phase, p5–p80 · slope 0–p80 (γ=1.2) multiplied" },
  "layer.energy":        { pt: "Energia", en: "Energy" },
  "vmin.label":          { pt: "min (auto = p1)", en: "min (auto = p1)" },
  "vmax.label":          { pt: "max (auto = p80)", en: "max (auto = p80)" },
  "vmin.passes":         { pt: "min (auto = p10)", en: "min (auto = p10)" },
  "vmax.passes":         { pt: "max (auto = p90)", en: "max (auto = p90)" },
  "energy.range_hint":   { pt: "Auto = sqrt-stretched; pino qualquer limite para linear com clamping.", en: "Auto = sqrt-stretched; pin either bound for linear with clamping." },
  "layer.passes":        { pt: "Passagens (overlay)", en: "Passes (overlay)" },
  "passes.gamma":        { pt: "γ gama (1 = sem mudança)", en: "γ gamma (1 = no change)" },
  "passes.mean_window":  { pt: "filtro média N", en: "mean filter N" },
  "passes.blend":        { pt: "Blend", en: "Blend" },
  "blend.add":           { pt: "soma (plus-lighter)", en: "add (plus-lighter)" },
  "blend.normal":        { pt: "normal", en: "normal" },
  "blend.screen":        { pt: "screen", en: "screen" },
  "blend.multiply":      { pt: "multiply", en: "multiply" },
  "blend.overlay":       { pt: "overlay", en: "overlay" },
  "passes.hint":         { pt: "Rampa cinza; com modo \"soma\", células de alta passagem clareiam o campo de energia abaixo. Mesmo comportamento auto/pinado da Energia.", en: 'Greyscale ramp; with "add" mode high-pass cells brighten the energy field beneath. Same auto / pinned-range behaviour as Energy.' },
  "btn.range_reset":     { pt: "Reset auto", en: "Reset ranges to auto" },
  "btn.download_bundle": { pt: "Baixar bundle (.zip)", en: "Download bundle (.zip)" },
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
  "help.h.compute":      { pt: "4 · Calcular", en: "4 · Compute" },
  "help.p.compute":      { pt: "Aperte <em>Calcular</em>. Habilitado quando há fonte (modo padrão) ou pelo menos uma referência (modo densidade). Estimativa de tempo aparece antes; durante a execução, a barra mostra o tempo restante.", en: 'Hit <em>Compute</em>. Enabled when a source is set (default mode) or at least one reference (density mode). A time estimate appears beforehand; during the run, the bar shows time remaining.' },
  "help.h.viz":          { pt: "5 · Visualização", en: "5 · Visualisation" },
  "help.p.viz":          { pt: "As camadas <em>Energia</em> e <em>Passagens</em> têm visibilidade, opacidade e blend independentes. Mudanças de colormap, range, gamma, filtro média e blend ficam pendentes até <em>Atualizar estilo</em> — evita re-renderizar a cada digitação em DEMs grandes.", en: 'The <em>Energy</em> and <em>Passes</em> layers have independent visibility, opacity, and blend. Changes to colormap, range, gamma, mean filter, and blend stay pending until you click <em>Refresh style</em> — saves re-rendering on every keystroke for large DEMs.' },
  "help.h.bundle":       { pt: "6 · Salvar / restaurar", en: "6 · Save / reload" },
  "help.p.bundle":       { pt: "<em>Baixar bundle (.zip)</em> empacota um <code>metadata.jsonld</code> com todos os parâmetros, mais GeoTIFFs georeferenciados (energy.tif, passes.tif, network.tif) que abrem direto no QGIS. Para reproduzir: carregue o mesmo DEM, depois leia o JSON-LD ou ZIP.", en: '<em>Download bundle (.zip)</em> packs a <code>metadata.jsonld</code> with every parameter, plus georeferenced GeoTIFFs (energy.tif, passes.tif, network.tif) that open directly in QGIS. To reproduce: load the same DEM, then read the JSON-LD or ZIP back.' },
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
}

// ------- Compute worker -------
// Single JS worker for all compute paths. Wasm support was removed: it
// covered only the energy-only fast path (passes/top-N/density/budget
// all fell back to JS anyway) and the Rust toolchain was a maintenance
// tax for a 3–5× win on one mode. One engine is easier to reason about,
// easier to deploy, and the heap is comparable for typical DEMs.
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
  });
}
function markStyleDirty() {
  // Skip if nothing actually changed since the last render — guards
  // against late blur/change events re-marking after a refresh click.
  if (state.lastStyleSnapshot === styleSnapshot()) return;
  const btn = document.getElementById("refresh-style");
  if (btn) {
    btn.dataset.dirty = "1";
    btn.textContent = "Refresh style ●";
  }
}
function clearStyleDirty() {
  state.lastStyleSnapshot = styleSnapshot();
  const btn = document.getElementById("refresh-style");
  if (btn) {
    btn.dataset.dirty = "";
    btn.textContent = "Refresh style";
  }
}

// (Engine-tag pill removed — JS is the only compute engine now.
// state.engine = "js" is set in the state object below.)

// Wire the colormap selector and the manual range inputs. Any change
// re-renders the cached energy field — no recompute needed.
document.addEventListener("DOMContentLoaded", () => {
  // Apply translations as soon as the DOM is ready, BEFORE any other UI
  // wiring that might read element text. This populates static labels,
  // option text in select elements, etc.
  applyTranslations();
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
        opt.textContent = k.replace("CET_", "CET-");
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
        opt.textContent = k.replace("CET_", "CET-");
        og.appendChild(opt);
      }
      routesSel.appendChild(og);
    }
    routesSel.value = "CET_R2"; // perceptually uniform rainbow — good for ranks
    routesSel.addEventListener("change", rerenderCachedResult);
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
      // Also fade the "Pick points" group so it's clearly inactive.
      const pickGroup = document.getElementById("pick-points-group");
      if (pickGroup) {
        pickGroup.style.opacity = on ? "0.45" : "1";
        pickGroup.style.pointerEvents = on ? "none" : "";
      }
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
  // Anything that affects the time estimate
  for (const id of ["mode", "want-passes", "want-topn", "n-routes", "want-density", "n-refs", "e-max"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", estimateRunTime);
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
        status.innerHTML = `<span style="color:#ff6b6b">.gpkg load failed: ${err.message}</span>`;
      }
      // Reset the input so re-picking the same file fires `change` again.
      ev.target.value = "";
    });
  }
  const vecClearBtn = document.getElementById("vec-clear");
  if (vecClearBtn) vecClearBtn.addEventListener("click", clearVectorNetwork);

  // Bundle download / reload
  const dlBtn = document.getElementById("download-bundle");
  if (dlBtn) dlBtn.addEventListener("click", downloadBundle);
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
});

const map = L.map("map", { preferCanvas: true }).setView([-23.55, -46.63], 12);
L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }
).addTo(map);

// ------- State -------
const state = {
  dem: null, // { height, mask, H, W, dx, dy, bbox, originX, originY }
  src: null, // [r, c]
  dst: null, // [r, c]
  worker: null,
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
  // Engine preference (user-toggleable via the title-bar chip). Default
  // is JS so users without wasm built still get a working app.
  enginePreference: "js",
  wasmAvailable: false,
  // Outline rectangle drawn to show the loaded DEM's extent.
  demRect: null,
  // Optional rasterised vector network. When non-null, AND'd with the
  // DEM mask before every compute so analysis is constrained to network
  // cells. networkSrsId stamps the source CRS so we can warn on DEM swap.
  networkMask: null,
  networkSrsId: null,
  networkFeatureCount: 0,
  // Multi-reference density: list of [r, c] pixel coords plus their map markers.
  refPoints: [],
  refMarkers: [],
  // Live-ETA bookkeeping (set on Compute, cleared on done/error).
  computeStartedAt: 0,
  estimatedTotalMs: 0,
  etaTimer: 0,
};

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
  attribution: 'pedalhidrografi.co',
});

demFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  status.textContent = "Loading DEM…";
  try {
    const buf = await file.arrayBuffer();
    state.demSourceUrl = null;
    await loadDemFromArrayBuffer(buf, file.name);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">Error: ${err.message}</span>`;
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
  status.textContent = `Fetching ${label}…`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const buf = await resp.arrayBuffer();
    state.demSourceUrl = url;
    await loadDemFromArrayBuffer(buf, label);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">Error: ${err.message}</span>`;
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
    status.innerHTML = '<span style="color:#ff6b6b">Map not ready.</span>';
    return;
  }
  const bounds = map.getBounds();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west  = bounds.getWest();
  const east  = bounds.getEast();
  if (!Number.isFinite(south) || north <= south || east <= west) {
    status.innerHTML = '<span style="color:#ff6b6b">Couldn\'t read map bounds.</span>';
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
      `<span style="color:#ff6b6b">Janela ~${(estBytes / 1024 / 1024).toFixed(0)} MB ` +
      `(${outW}×${outH} cells), acima do limite de ${FABDEM_MAX_BYTES / 1024 / 1024} MB. Aproxime o zoom.</span>`;
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

  status.textContent = `Buscando ${tileSpecs.length} tile(s) FABDEM…`;
  progress.classList.add("active");
  progressBar.style.width = "0%";

  try {
    // Open each tile (small IFD fetch only — geotiff.js doesn't pull pixels
    // until readRasters is called). 404s are common: oceans and polar
    // strips fall outside FABDEM coverage. We log and skip.
    const opened = [];
    for (let i = 0; i < tileSpecs.length; i++) {
      const t = tileSpecs[i];
      try {
        const tiff = await GeoTIFF.fromUrl(t.url);
        const image = await tiff.getImage();
        opened.push({ ...t, image });
      } catch (e) {
        console.info(`[fabdem] skipping ${t.url}: ${e.message}`);
      }
      progressBar.style.width = `${((i + 1) / tileSpecs.length * 30).toFixed(1)}%`;
    }

    if (!opened.length) {
      status.innerHTML =
        '<span style="color:#ff6b6b">Nenhum tile FABDEM encontrado para esta janela ' +
        '(provavelmente oceano ou fora da cobertura ±60° lat).</span>';
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
    for (let i = 0; i < opened.length; i++) {
      const t = opened[i];
      const tileSouth = t.lat;
      const tileNorth = t.lat + FABDEM_TILE_DEG;
      const tileWest  = t.lon;
      const tileEast  = t.lon + FABDEM_TILE_DEG;

      // Snap the intersection to the same arcsec grid as the mosaic so
      // pixel offsets line up exactly.
      const interWest  = Math.max(outWest,  tileWest);
      const interEast  = Math.min(outEast,  tileEast);
      const interSouth = Math.max(outSouth, tileSouth);
      const interNorth = Math.min(outNorth, tileNorth);
      if (interEast <= interWest || interNorth <= interSouth) continue;

      // Per-tile nodata sentinel — FABDEM uses GDAL_NODATA, varies by tile.
      const nodataRaw = t.image.fileDirectory.getValue("GDAL_NODATA");
      const nodata = nodataRaw ? parseFloat(nodataRaw) : null;

      // Convert the geographic intersection to a pixel window. NB:
      // image.readRasters({bbox}) does NOT exist on GeoTIFFImage — only
      // the top-level tiff.readRasters supports bbox. Passing it to the
      // image-level call silently falls back to "read full image", which
      // would blow the 50 MB cap AND scramble the mosaic placement below.
      // We compute the pixel window ourselves from the source's origin
      // and resolution so geotiff.js issues Range requests for just the
      // strips overlapping the viewport.
      const [oX, oY] = t.image.getOrigin();
      const [rX, rY] = t.image.getResolution(); // rX > 0 east, rY < 0 down
      const wnd = [
        Math.round((interWest  - oX) / rX),
        Math.round((interNorth - oY) / rY),
        Math.round((interEast  - oX) / rX),
        Math.round((interSouth - oY) / rY),
      ];
      const raster = await t.image.readRasters({
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
      progressBar.style.width = `${(30 + (i + 1) / opened.length * 70).toFixed(1)}%`;
      status.textContent = `Mosaico: tile ${i + 1}/${opened.length}…`;
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
    status.innerHTML = `<span style="color:#ff6b6b">FABDEM load failed: ${err.message}</span>`;
  } finally {
    progress.classList.remove("active");
  }
}

async function loadDemFromArrayBuffer(buf, label) {
  status.textContent = `Loading ${label}…`;
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

  // Detect CRS — for this prototype we assume the DEM is in a projected
  // metric CRS where x = easting, y = northing increasing northward.
  // Geographic (lon/lat) DEMs need reprojection that we skip here for clarity.
  // Most real-world cycling DEMs are UTM, which works.
  const isProbablyGeographic =
    Math.abs(originX) < 360 && Math.abs(originY) < 90 && dx < 0.01;
  if (isProbablyGeographic) {
    status.innerHTML = '<span style="opacity:0.7">DEM is in lon/lat — distances approximated from latitude (good to ~0.3% under ~50 km extent).</span>';
  }

  // Convert degrees → metres for geographic DEMs using a flat-earth
  // approximation centred on the DEM's middle latitude. For a 5–50 km
  // extent this is good to ~0.3%.
  const latRef = isProbablyGeographic ? originY - (H * dy) / 2 : 0;
  const dxM = isProbablyGeographic
    ? dx * 111320 * Math.cos((latRef * Math.PI) / 180)
    : dx;
  const dyM = isProbablyGeographic ? dy * 110574 : dy;

  // Pull GeoKeys from the source TIFF so we can stamp the same CRS onto
  // any GeoTIFFs we write later (energy.tif / passes.tif / network.tif
  // in the bundle export). Without this, projected DEMs would round-trip
  // as bare 4326 — wrong for everything outside lon/lat space.
  let geoKeys = null;
  try {
    geoKeys = image.getGeoKeys ? image.getGeoKeys() : null;
  } catch { /* getGeoKeys throws on some malformed tiffs — fine to skip */ }

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
  state.src = null;
  state.dst = null;
  state.lastResult = null;
  // Drop any previously loaded vector network — its rasterised mask is
  // sized to the *previous* DEM's H×W and would corrupt the next compute
  // (or crash) if reused. The user re-uploads the .gpkg if they want it.
  clearVectorNetwork();
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
  status.textContent = `${label} loaded. Click on the map to set source point.`;
  updateRunButtonState();
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
      return Promise.reject(new Error("sql.js didn't load (CDN blocked?)"));
    }
    _sqlPromise = initSqlJs({
      locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`,
    });
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

function parseWKB(view, off) {
  const le = view.getUint8(off) === 1;
  off += 1;
  const t = view.getUint32(off, le);
  off += 4;
  const baseType = t & 0x0fff;            // strip Z/M flags
  const hasZ = (t & 0x80000000) || (t & 0x1000) || baseType !== t && (Math.floor(t / 1000) === 1 || Math.floor(t / 1000) === 3);
  const hasM = (t & 0x40000000) || (t & 0x2000) || baseType !== t && (Math.floor(t / 1000) === 2 || Math.floor(t / 1000) === 3);
  const stride = 16 + (hasZ ? 8 : 0) + (hasM ? 8 : 0);

  if (baseType === 2) {
    // LineString
    const n = view.getUint32(off, le); off += 4;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = [view.getFloat64(off, le), view.getFloat64(off + 8, le)];
      off += stride;
    }
    return [out];
  }
  if (baseType === 5) {
    // MultiLineString — skip outer header per child too
    const k = view.getUint32(off, le); off += 4;
    const lines = [];
    for (let j = 0; j < k; j++) {
      const subLE = view.getUint8(off) === 1; off += 1;
      const subT = view.getUint32(off, subLE); off += 4;
      const subBase = subT & 0x0fff;
      if (subBase !== 2) return null;
      const subStride = 16
        + ((subT & 0x80000000 || Math.floor(subT / 1000) === 1 || Math.floor(subT / 1000) === 3) ? 8 : 0)
        + ((subT & 0x40000000 || Math.floor(subT / 1000) === 2 || Math.floor(subT / 1000) === 3) ? 8 : 0);
      const n = view.getUint32(off, subLE); off += 4;
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
  while (true) {
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
    status.innerHTML = '<span style="color:#ff6b6b">Load a DEM first.</span>';
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
  setVecStatus(`Reading ${file.name} (${(file.size / 1024 / 1024).toFixed(0)} MB)…`);
  const buf = await readFileWithProgress(file, (frac) => {
    progressBar.style.width = `${(frac * 40).toFixed(1)}%`;
  });
  progressBar.style.width = "40%";

  setVecStatus("Initializing sql.js…");
  const SQL = await getSQL();
  const db = new SQL.Database(new Uint8Array(buf));
  progressBar.style.width = "50%";

  try {
    const cont = db.exec("SELECT table_name, srs_id FROM gpkg_geometry_columns LIMIT 1");
    if (!cont.length) throw new Error("No gpkg_geometry_columns entry — not a valid .gpkg?");
    const tableName = cont[0].values[0][0];
    const srsId     = cont[0].values[0][1];

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
    const rtree = `rtree_${tableName}_geom`;
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
        SELECT t.geom FROM "${tableName}" t
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
      stmt = db.prepare(`SELECT geom FROM "${tableName}"`);
    }

    const lineWidth = Math.max(1, parseInt(document.getElementById("vec-width")?.value, 10) || 1);
    const halfWidth = (lineWidth - 1) >> 1;
    const networkMask = new Uint8Array(W * H);

    const project = isSrcWgs ? (xy) => xy : (xy) => proj4(`EPSG:${srsId}`, "EPSG:4326", xy);

    let scanned = 0, rasterised = 0;
    while (stmt.step()) {
      const row = stmt.get();
      const blob = row[0];
      scanned++;
      const lines = parseGpkgGeom(blob);
      if (!lines) continue;
      for (const coords of lines) {
        let prevR = null, prevC = null;
        for (const xy of coords) {
          const [lng, lat] = project(xy);
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
        rasterised++;
      }
      if (scanned % 2000 === 0) {
        const frac = totalFeatures > 0 ? scanned / totalFeatures : 0;
        progressBar.style.width = `${(50 + frac * 50).toFixed(1)}%`;
        setVecStatus(totalFeatures > 0
          ? `Rasterising… <span class="v">${scanned}</span>/${totalFeatures} (${rasterised} drawn)`
          : `Rasterising… <span class="v">${scanned}</span> scanned, ${rasterised} drawn`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    stmt.free();
    progressBar.style.width = "100%";

    let networkCells = 0;
    for (let i = 0; i < networkMask.length; i++) if (networkMask[i]) networkCells++;

    state.networkMask = networkMask;
    state.networkSrsId = srsId;
    state.networkFeatureCount = rasterised;
    document.getElementById("vec-meta").innerHTML =
      `EPSG:${srsId} · <span class="v">${rasterised}</span> lines drawn<br/>` +
      `<span class="v">${networkCells.toLocaleString()}</span> network cells (${(100 * networkCells / (W * H)).toFixed(1)}% of grid)`;
    status.textContent = "Network loaded.";
    state.lastResult = null; // previous compute used the un-constrained mask
  } finally {
    db.close();
    progress.classList.remove("active");
  }
}

function clearVectorNetwork() {
  state.networkMask = null;
  state.networkSrsId = null;
  state.networkFeatureCount = 0;
  const meta = document.getElementById("vec-meta");
  if (meta) meta.innerHTML = "No network loaded.";
  const inp = document.getElementById("vector-file");
  if (inp) inp.value = "";
}

// Snap a (row, col) pixel to the nearest network cell within radius (in
// cell units). Returns the original RC if the network is off, the radius
// is 0, or no network cell exists in the search box.
function snapToNetwork(rc) {
  if (!state.networkMask || !state.dem) return rc;
  const radius = Math.max(0, parseInt(document.getElementById("vec-snap")?.value, 10) || 0);
  if (radius === 0) return rc;
  const [r, c] = rc;
  const { W, H, mask } = state.dem;
  if (r < 0 || r >= H || c < 0 || c >= W) return rc;
  if (state.networkMask[r * W + c]) return rc;
  let bestD2 = Infinity, bestRC = null;
  for (let dr = -radius; dr <= radius; dr++) {
    const rr = r + dr;
    if (rr < 0 || rr >= H) continue;
    for (let dc = -radius; dc <= radius; dc++) {
      const cc = c + dc;
      if (cc < 0 || cc >= W) continue;
      const i = rr * W + cc;
      if (state.networkMask[i] && mask[i]) {
        const d2 = dr * dr + dc * dc;
        if (d2 < bestD2) { bestD2 = d2; bestRC = [rr, cc]; }
      }
    }
  }
  return bestRC || rc;
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

map.on("click", (e) => {
  if (!state.dem) {
    status.textContent = "Load a DEM first.";
    return;
  }
  const rawPx = latLngToPixel(e.latlng);
  if (!rawPx) {
    status.innerHTML = '<span style="color:#ff6b6b">Click is outside the DEM, or DEM is in a non-geographic CRS (this prototype supports EPSG:4326 DEMs only — see notes).</span>';
    return;
  }
  // When a vector network is loaded, click points are snapped to the
  // nearest passable network cell within the configured radius.
  const px = snapToNetwork(rawPx);
  const [r, c] = px;
  if (!state.dem.mask[r * state.dem.W + c]) {
    status.textContent = "Clicked cell is nodata.";
    return;
  }
  if (state.networkMask && !state.networkMask[r * state.dem.W + c]) {
    status.innerHTML = '<span style="color:#ff6b6b">No network cell within snap radius — increase the radius or click closer to a line.</span>';
    return;
  }
  // Density mode in "click" placement: every click adds a reference point.
  // src/dst are left alone in this mode.
  const densityOn = !!document.getElementById("want-density")?.checked;
  const densityClick = (document.getElementById("ref-source")?.value || "click") === "click";
  if (densityOn && densityClick) {
    addRefPoint([r, c]);
    return;
  }
  if (!state.src) {
    state.src = px;
    if (state.srcMarker) state.srcMarker.remove();
    state.srcMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("src") })
      .addTo(map).bindTooltip("Source");
    document.getElementById("src-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("src-display").classList.add("set");
    status.textContent = "Source set. Click again to set destination, or run.";
    updateRunButtonState();
  } else if (!state.dst) {
    state.dst = px;
    if (state.dstMarker) state.dstMarker.remove();
    state.dstMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("dst") })
      .addTo(map).bindTooltip("Destination");
    document.getElementById("dst-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("dst-display").classList.add("set");
    status.textContent = "Both points set. Run to compute.";
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
    status.textContent = "Source replaced. Click to set destination, or run.";
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
  if (!state.dem.mask[r * state.dem.W + c]) return;
  state.refPoints.push([r, c]);
  const { originX, originY, dx, dy } = state.dem;
  const latlng = L.latLng(originY - (r + 0.5) * dy, originX + (c + 0.5) * dx);
  const idx = state.refPoints.length;
  const m = L.marker(latlng, { icon: makeRefIcon(idx) })
    .addTo(map).bindTooltip(`ref ${idx} · r=${r}, c=${c}`);
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
  syncRefDisplay();
}

function placeRandomRefPoints(n) {
  if (!state.dem) return;
  const { mask, H, W } = state.dem;
  // Reservoir of valid cell indices is too big to enumerate for huge DEMs;
  // rejection sampling is fine for typical mask densities (~99% valid).
  const want = Math.max(1, Math.min(2000, n | 0));
  let attempts = 0;
  const cap = want * 200;
  const placed = [];
  while (placed.length < want && attempts++ < cap) {
    const r = (Math.random() * H) | 0;
    const c = (Math.random() * W) | 0;
    if (mask[r * W + c]) placed.push([r, c]);
  }
  for (const rc of placed) addRefPoint(rc);
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
  if (!state.dem) { runBtn.disabled = true; return; }
  const densityOn = !!document.getElementById("want-density")?.checked;
  if (densityOn) {
    runBtn.disabled = !(state.refPoints && state.refPoints.length > 0);
  } else {
    runBtn.disabled = !state.src;
  }
}

// ------- Run -------
runBtn.addEventListener("click", async () => {
  const wantDensity = !!document.getElementById("want-density")?.checked;
  // Density mode runs from refPoints, not src — relax the src-required guard.
  if (!state.dem) return;
  if (!wantDensity && !state.src) return;
  if (wantDensity && (!state.refPoints || state.refPoints.length === 0)) {
    status.innerHTML = '<span style="color:#ff6b6b">Density mode needs at least one reference point — click on the map or use "Place random".</span>';
    return;
  }
  // Mobile: close the drawer so the user sees the result land on the map
  // instead of staring at the parameter panel while the compute runs.
  // No-op on desktop (drawer never opens above 860 px).
  window.__simuDrawer?.close();

  const mode = document.getElementById("mode").value;
  const alpha = parseFloat(document.getElementById("alpha").value);
  const beta = parseFloat(document.getElementById("beta").value);
  const eta = parseFloat(document.getElementById("eta").value);
  const eMaxRaw = parseFloat(document.getElementById("e-max")?.value);
  const eMax = Number.isFinite(eMaxRaw) && eMaxRaw > 0 ? eMaxRaw : 0;

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
    status.innerHTML = '<span style="color:#ff6b6b">Top-N routes requires a destination point.</span>';
    return;
  }

  // If a network is loaded, src/dst must lie on it — otherwise the Dijkstra
  // is constrained to network cells and can't relax through them. Re-snap
  // here defensively: covers the case where the user clicked points BEFORE
  // loading the .gpkg, and the case where snap-radius was 0 at click time.
  // If a point can't be snapped (no network cell within radius) we abort
  // with a clear message rather than silently producing empty routes.
  if (state.networkMask && state.dem) {
    const W = state.dem.W;
    const offNet = (rc) => rc && !state.networkMask[rc[0] * W + rc[1]];
    const reSnapAndUpdate = (rc, marker, displayId, label) => {
      if (!rc || !offNet(rc)) return rc;
      const snapped = snapToNetwork(rc);
      if (offNet(snapped)) {
        status.innerHTML = `<span style="color:#ff6b6b">${label} isn't on the network and no network cell is within snap radius — increase the radius or move the point closer to a line.</span>`;
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
    const newSrc = reSnapAndUpdate(state.src, state.srcMarker, "src-display", "Source");
    if (newSrc === null) return;
    state.src = newSrc;
    if (state.dst) {
      const newDst = reSnapAndUpdate(state.dst, state.dstMarker, "dst-display", "Destination");
      if (newDst === null) return;
      state.dst = newDst;
    }
  }

  // Tear down old worker if any (we can't re-use after transferred buffers)
  if (state.worker) state.worker.terminate();

  // Single JS worker — wasm support has been removed.
  state.worker = new Worker(WORKER_URL);
  state.engine = "js";

  status.textContent = "Computing…";
  progress.classList.add("active");
  progressBar.style.width = "0%";
  runBtn.disabled = true;

  // ETA bookkeeping. The wasm worker doesn't emit progress messages; for
  // it we just show "Computing…" and the static estimate. The JS worker
  // emits progress every ~N/50 cells, which gives a usable ETA after the
  // first few percent.
  state.computeStartedAt = performance.now();
  state.estimatedTotalMs = 0;
  // Cache density's expected ref count so the progress text reads
  // "ref X/N" while the worker is iterating.
  state.computeRefTotal = wantDensity ? state.refPoints.length : 0;

  state.worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.kind === "progress") {
      const pct = Math.min(100, m.progress * 100);
      progressBar.style.width = `${pct.toFixed(1)}%`;
      // Live ETA: linear extrapolation. Skip the noisy first 5% of the run.
      if (m.progress > 0.05) {
        const elapsed = performance.now() - state.computeStartedAt;
        const total = elapsed / m.progress;
        const remaining = Math.max(0, total - elapsed);
        let label;
        if (state.computeRefTotal > 0) {
          // Density: progress fraction is (k+1)/N_refs after each ref.
          const cur = Math.max(1, Math.min(state.computeRefTotal, Math.ceil(m.progress * state.computeRefTotal)));
          label = `Computing density: ref ${cur}/${state.computeRefTotal} (${pct.toFixed(0)}%)`;
        } else {
          label = `Computing… ${pct.toFixed(0)}%`;
        }
        status.textContent = `${label} — ${formatDuration(remaining)} left`;
      }
    } else if (m.kind === "done") {
      progress.classList.remove("active");
      updateRunButtonState();
      state.computeStartedAt = 0;
      renderResult(m);
      status.textContent = `Done in ${m.elapsedMs.toFixed(0)} ms.`;
    } else if (m.kind === "error") {
      progress.classList.remove("active");
      updateRunButtonState();
      state.computeStartedAt = 0;
      status.innerHTML = `<span style="color:#ff6b6b">Worker error: ${m.message}</span>`;
    } else if (m.kind === "warning") {
      // Non-fatal — the worker is still going and will follow up with
      // a `done` message. Yellow-tint the status; the next progress
      // tick will overwrite it.
      console.warn("[worker]", m.message);
      status.innerHTML = `<span style="color:#ffb86b">${m.message}</span>`;
    }
  };

  // Transfer the DEM to the worker (clone, since we need to keep our copy).
  // For very large DEMs you'd transfer ownership and re-load on each run.
  const heightCopy = new Float32Array(state.dem.height);
  const maskCopy = new Uint8Array(state.dem.mask);
  // Send the network mask separately. The worker AND's it with the DEM
  // mask for Dijkstra, but keeps the original DEM mask available for
  // post-Dijkstra interpolation across non-network cells.
  const networkMaskCopy = state.networkMask ? new Uint8Array(state.networkMask) : null;
  const wantNetworkInterp = !!document.getElementById("net-interp")?.checked;
  const interpMaxDistance = Math.max(1, parseInt(document.getElementById("net-interp-max-dist")?.value, 10) || 50);
  const interpSmoothing   = Math.max(0, parseInt(document.getElementById("net-interp-smoothing")?.value, 10) || 0);

  state.worker.postMessage(
    {
      kind: "run",
      height: heightCopy,
      mask: maskCopy,
      H: state.dem.H,
      W: state.dem.W,
      dx: state.dem.dxM,
      dy: state.dem.dyM,
      seedR: state.src ? state.src[0] : (state.refPoints[0] ? state.refPoints[0][0] : -1),
      seedC: state.src ? state.src[1] : (state.refPoints[0] ? state.refPoints[0][1] : -1),
      goalR: state.dst ? state.dst[0] : -1,
      goalC: state.dst ? state.dst[1] : -1,
      mode, alpha, beta, eta, eMax,
      wantPasses, wantTopN, nRoutes, penalty, repulsionMode,
      wantDensity,
      refPoints: wantDensity ? state.refPoints.slice() : null,
      densityMode,
      networkMask: networkMaskCopy,
      wantNetworkInterp,
      interpMaxDistance,
      interpSmoothing,
      maximize,
      maximizeLength,
    },
    [heightCopy.buffer, maskCopy.buffer, ...(networkMaskCopy ? [networkMaskCopy.buffer] : [])]
  );
});

// ------- Render -------
function renderResult({ energy, passes, path, pathEnergy, pathLengthM, routes, elapsedMs }) {
  // Cache for live re-render on colormap / view / range changes.
  state.lastResult = { energy, passes, path, pathEnergy, pathLengthM, routes, elapsedMs };

  // Auto bounds (state.lastAutoMin/Max and lastPassesAutoMin/Max) are
  // populated by renderFieldToDataURL during rerenderCachedResult below
  // — both layers use percentile clipping by default and the resolved
  // bounds come back from the renderer.

  // Show/hide the passes layer controls based on whether passes was computed
  const passesRow = document.getElementById("passes-row");
  if (passesRow) passesRow.style.display = passes ? "" : "none";

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
  const r = state.lastResult;
  if (!r || !state.dem) return;
  const { energy, passes, path, routes } = r;
  const { H, W, originX, originY, dx, dy, isGeographic } = state.dem;

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
  if (passes) {
    const blend = document.getElementById("passes-blend")?.value || "plus-lighter";
    const gamma = parseFloat(document.getElementById("passes-gamma")?.value);
    const win = parseInt(document.getElementById("passes-mean-window")?.value, 10);
    const out = renderFieldToDataURL(passes, W, H, {
      // p10/p90 default; passes counts are heavily long-tailed and a few
      // "highway" cells would otherwise dominate the stretch.
      usePercentileBounds: true,
      percentiles: [10, 90],
      userMin: readRangeInput("passes-vmin", null),
      userMax: readRangeInput("passes-vmax", null),
      gamma: Number.isFinite(gamma) ? gamma : 1,
      meanWindow: Number.isFinite(win) && win > 1 ? win : 1,
      useGreyscale: true,
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
        color: colour, weight, opacity,
      }).bindTooltip(`route ${i + 1} · E ${r.energy.toExponential(2)} · ${(r.length / 1000).toFixed(2)} km`).addTo(map);
      state.routeLines.push(ln);
    }
  } else if (path && path.length > 0 && isGeographic) {
    state.pathLine = L.polyline(pathToLatLngs(path), {
      color: "#4cc9f0", weight: 4, opacity: 0.95,
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
// Range: vmin/vmax in real units. When both blank → auto. Auto-bounds use
// `opts.percentiles` (default [10, 90]) when `usePercentileBounds` is
// set, else min/max. Stretch: linear when bounds are pinned or
// percentile-based; sqrt for the raw min/max auto path (long-tail).
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
      autoLo = sorted[Math.floor(sorted.length * pLo / 100)];
      autoHi = sorted[Math.floor(sorted.length * pHi / 100)];
    }
  } else {
    for (let i = 0; i < N; i++) {
      const v = work[i];
      if (Number.isFinite(v) && (!opts.treatZeroAsTransparent || v > 0)) {
        if (v < autoLo) autoLo = v;
        if (v > autoHi) autoHi = v;
      }
    }
  }
  if (opts.autoMin != null) autoLo = opts.autoMin;
  if (opts.autoMax != null) autoHi = opts.autoMax;

  const userPinned = opts.userMin != null || opts.userMax != null;
  let lo = opts.userMin != null ? opts.userMin : autoLo;
  let hi = opts.userMax != null ? opts.userMax : autoHi;
  // Sqrt stretch only on the raw min/max auto path. Percentile-clipped or
  // user-pinned bounds get a plain linear mapping.
  const useSqrt = !userPinned && !opts.usePercentileBounds;
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
  const span = hi - lo;
  const gammaExp = Math.max(0.01, opts.gamma ?? 1);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);

  for (let i = 0; i < N; i++) {
    const v = work[i];
    const unsettled =
      !Number.isFinite(v) || (opts.treatZeroAsTransparent && v === 0);
    if (unsettled) {
      img.data[4 * i + 3] = 0;
      continue;
    }
    let t;
    if (useSqrt) {
      t = Math.sqrt(Math.max(0, v / hi));
    } else {
      t = (v - lo) / span;
    }
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    // Gamma adjustment: t' = t^(1+γ). γ=0 leaves the mapping unchanged.
    if (gammaExp !== 1) t = Math.pow(t, gammaExp);
    let r2, g2, b2, a2;
    if (opts.useGreyscale) {
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
    img.data[4 * i + 0] = r2;
    img.data[4 * i + 1] = g2;
    img.data[4 * i + 2] = b2;
    img.data[4 * i + 3] = a2;
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
    { opacity: 0.85 },
  ).addTo(map);
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
  state.energyOverlay = L.imageOverlay(state.energyDataUrl, bounds, { opacity: 0.85 }).addTo(map);
}

// Build the passes-layer Leaflet imageOverlay (always above energy).
function applyPassesOverlay() {
  if (state.passesOverlay) { state.passesOverlay.remove(); state.passesOverlay = null; }
  if (!state.dem || !state.dem.isGeographic || !state.passesDataUrl) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  const bounds = [[originY - H * dy, originX], [originY, originX + W * dx]];
  state.passesOverlay = L.imageOverlay(state.passesDataUrl, bounds, { opacity: 0.7 }).addTo(map);
  // Bump the passes overlay to the top of the imageOverlay pane so it sits
  // visually above the energy overlay.
  state.passesOverlay.bringToFront();
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
    if (el) el.style.mixBlendMode = blend;
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

// ------- Compute-time estimation -------
// Empirical rates on the 553k-cell test DEM:
//   JS forward Dijkstra ≈ 170 ms  → ~3,300 cells/ms.
//   wasm forward Dijkstra ≈ 30–50 ms → ~12,000 cells/ms (when built).
// Mode round-trip = 2 passes. Passes adds ~10%. Each top-N iteration is
// ~0.5× of a Dijkstra (A* terminates at goal). Distance-transform-based
// repulsion modes add ~0.3× per iteration.
const RATE_CELLS_PER_MS_JS   = 3300;

function estimateRunTime() {
  const out = document.getElementById("time-estimate");
  if (!out) return;
  if (!state.dem) { out.textContent = ""; return; }

  const N = state.dem.H * state.dem.W;
  const wantPasses = !!document.getElementById("want-passes")?.checked;
  const wantTopN   = !!document.getElementById("want-topn")?.checked;
  const wantDensity = !!document.getElementById("want-density")?.checked;
  // Single (JS) engine — rate constant is fixed.
  const rate = RATE_CELLS_PER_MS_JS;

  let ms = N / rate;
  const mode = document.getElementById("mode")?.value || "from";
  if (mode === "round") ms *= 2;
  if (wantPasses) ms *= 1.1;

  if (wantTopN) {
    const k = Math.max(1, Math.min(20, parseInt(document.getElementById("n-routes")?.value, 10) || 3));
    const rep = document.getElementById("repulsion-mode")?.value || "per-cell";
    const perIter = rep === "per-cell" ? 0.5 : 0.8;
    ms += (N / rate) * perIter * k;
  }
  // Multi-reference density runs one (or two for round-trip) Dijkstras per
  // reference, each with passes tracking.
  if (wantDensity) {
    const refs = state.refPoints?.length || 0;
    // Density direction now follows the global mode select.
    const dmode = document.getElementById("mode")?.value || "from";
    const dijkstrasPerRef = dmode === "round" ? 2 : 1;
    ms += (N / rate) * 1.1 * dijkstrasPerRef * refs;
  }
  // Network IDW fill (8-direction ray search) plus optional 3×3 smoothing
  // passes. Only kicks in when a network mask is loaded AND interpolation
  // is enabled — otherwise the cells outside the network are left empty.
  // The 0.3 / 0.05 multipliers are rough rule-of-thumb fits from runs on
  // the 5e6-cell DEM; tune if they drift.
  const wantNetInterp = !!document.getElementById("net-interp")?.checked;
  if (wantNetInterp && state.networkMask) {
    const smoothingIters = parseInt(document.getElementById("net-interp-smoothing")?.value, 10) || 0;
    ms += (N / rate) * (0.3 + 0.05 * smoothingIters);
  }
  out.textContent = `≈ ${formatDuration(ms)}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 950) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
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

function buildMetadata(result, withOutputs = true) {
  const dem = state.dem;
  const params = {
    mode:          document.getElementById("mode")?.value,
    alpha:         parseFloat(document.getElementById("alpha")?.value),
    beta:          parseFloat(document.getElementById("beta")?.value),
    eta:           parseFloat(document.getElementById("eta")?.value),
    eMax:          parseFloat(document.getElementById("e-max")?.value) || 0,
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
    srsId:             state.networkSrsId || null,
    featureCount:      state.networkFeatureCount || 0,
    lineWidth:         parseInt(document.getElementById("vec-width")?.value, 10) || 1,
    snapRadius:        parseInt(document.getElementById("vec-snap")?.value, 10) || 10,
    wantInterp:        !!document.getElementById("net-interp")?.checked,
    interpMaxDistance: parseInt(document.getElementById("net-interp-max-dist")?.value, 10) || 50,
    interpSmoothing:   parseInt(document.getElementById("net-interp-smoothing")?.value, 10) || 0,
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
      network: state.networkMask ? {
        format: "GeoTIFF",
        type:   "Uint8",
        shape:  [dem.H, dem.W],
        file:   "network.tif",
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

async function downloadBundle() {
  console.info("[bundle] download click — lastResult?", !!state.lastResult, "dem?", !!state.dem, "JSZip?", typeof JSZip);
  if (!state.dem) {
    status.innerHTML = '<span style="color:#ff6b6b">Load a DEM first, then run Compute, then download.</span>';
    return;
  }
  if (!state.lastResult) {
    status.innerHTML = '<span style="color:#ff6b6b">Nothing to download yet — click Compute first.</span>';
    return;
  }
  if (typeof JSZip === "undefined") {
    status.innerHTML = '<span style="color:#ff6b6b">JSZip didn\'t load — check the network/console.</span>';
    return;
  }
  status.textContent = "Building bundle…";
  try {
    const r = state.lastResult;
    const dem = state.dem;
    const md = buildMetadata(r, true);

    const zip = new JSZip();
    zip.file("metadata.jsonld", JSON.stringify(md, null, 2));
    // Output rasters as GeoTIFFs — the unzipped bundle drops straight into
    // QGIS / any GIS, no .bin-plus-metadata gymnastics. CRS and pixel grid
    // are inherited from the source DEM via tiffMetadataForDem.
    if (r.energy) {
      zip.file("energy.tif",  new Uint8Array(writeRasterAsGeoTIFF(r.energy, dem, "float32")));
    }
    if (r.passes) {
      zip.file("passes.tif",  new Uint8Array(writeRasterAsGeoTIFF(r.passes, dem, "float64")));
    }
    // The rasterised network mask reproduces the constrained compute even
    // when the source .gpkg isn't handy at reload. Stored as a 1-byte-per-
    // cell GeoTIFF (uint8) so QGIS can also display it as a raster mask.
    if (state.networkMask) {
      zip.file("network.tif", new Uint8Array(writeRasterAsGeoTIFF(state.networkMask, dem, "uint8")));
    }
    if (r.routes && r.routes.length) {
      zip.file("routes.geojson", JSON.stringify(routesFCFromList(r.routes, dem), null, 2));
    }
    if (r.path && r.path.length) {
      zip.file("path.geojson", JSON.stringify(pathFCFromIndices(r.path, dem, {
        energy: r.pathEnergy,
        length_m: r.pathLengthM,
      }), null, 2));
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
    status.textContent = `Saved bundle (${(blob.size / 1024 / 1024).toFixed(1)} MB).`;
  } catch (err) {
    console.error("[bundle] download failed:", err);
    status.innerHTML = `<span style="color:#ff6b6b">Download failed: ${err.message}</span>`;
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
      const nTif = zip.file("network.tif"), nBin = zip.file("network.bin");
      if (nTif) {
        bin.network = await readRasterFromGeoTIFF(await nTif.async("arraybuffer"), "uint8");
      } else if (nBin) {
        bin.network = new Uint8Array(await nBin.async("arraybuffer"));
      }
      // GeoJSON route/path geometry doesn't get re-rasterised — when no DEM
      // is loaded yet we couldn't draw it anyway. After the user loads a
      // matching DEM and clicks Compute, the routes are regenerated.
    } else if (/\.jsonld?$|\.json$/i.test(file.name)) {
      md = JSON.parse(await file.text());
    } else {
      throw new Error("Unrecognised file — pass a .zip bundle or .jsonld.");
    }
    applyMetadataToUI(md, bin);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">Reload failed: ${err.message}</span>`;
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

  set("mode", p.mode);
  set("alpha", p.alpha);
  set("beta", p.beta);
  set("eta", p.eta);
  set("e-max", p.eMax);
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
  set("net-interp-max-dist", net.interpMaxDistance);
  set("net-interp-smoothing", net.interpSmoothing);

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
        meta.innerHTML =
          `Restored from bundle: <span class="v">${state.networkFeatureCount}</span> ` +
          `features (SRS ${state.networkSrsId || "?"}).`;
      }
    } else {
      console.warn(
        `[bundle] network.bin size mismatch: ${bin.network.length} bytes vs H*W=${N}. Discarded.`
      );
    }
  }

  applyLayerControls();
  estimateRunTime();

  // If we got the binary outputs back, render them straight away — no
  // recompute needed. Skip if the DEM dimensions don't match (or no DEM
  // is loaded yet).
  let restored = false;
  if (state.dem && bin.energy && demDimsMatch === true) {
    const N = state.dem.H * state.dem.W;
    if (bin.energy.length === N && (!bin.passes || bin.passes.length === N)) {
      const synth = {
        energy:      bin.energy,
        passes:      bin.passes || null,
        path:        null,
        pathEnergy:  md.stats?.pathEnergy ?? null,
        pathLengthM: md.stats?.pathLengthM ?? null,
        routes:      null,
        elapsedMs:   md.elapsedMs ?? 0,
      };
      renderResult(synth);
      restored = true;
    }
  }

  updateRunButtonState();
  if (restored) {
    status.textContent = "Bundle restored from cache. Click Compute to re-derive routes/path.";
  } else if (state.dem && demDimsMatch === false) {
    status.innerHTML =
      `<span style="color:#ff9d3d">DEM size mismatch — bundle was for ` +
      `${bundleW}×${bundleH}, loaded DEM is ${state.dem.W}×${state.dem.H}. ` +
      `Parameters applied; binary outputs skipped. Load the matching DEM to restore overlays.</span>`;
  } else if (state.dem && (state.src || (p.wantDensity && state.refPoints?.length))) {
    status.textContent = "Bundle parameters loaded. Click Compute to reproduce.";
  } else if (!state.dem) {
    const hint = md.dem?.sourceUrl ? ` (try ${md.dem.sourceUrl})` : "";
    status.innerHTML = `<span style="opacity:0.85">Bundle loaded. Now load the matching DEM${hint} and click Compute.</span>`;
  } else {
    status.textContent = "Bundle loaded. Click on the map to set source point.";
  }
}
