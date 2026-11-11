# Specifikace API modulů (kontrakt mezi moduly)

Viz také [AGENTS.md](../AGENTS.md) – souřadnicové systémy, zásady (žádný build, čisté ES moduly,
jádro bez DOM, komentáře česky, identifikátory anglicky).

Obrázek v jádře = `{width, height, data: Uint8ClampedArray RGBA}`.
Obdélník = `{x, y, w, h}` (v jednotkách podle kontextu – mm nebo px).

## js/core/color.js
```js
srgbToLab(r, g, b) -> [L, a, b]            // r,g,b 0..255, D65, L 0..100
labChroma([L,a,b]) -> number               // sqrt(a²+b²)
deltaE([L,a,b], [L,a,b]) -> number         // CIE76
estimateWhite(img, rect?) -> {r,g,b}       // barva papíru = medián nejjasnějších ~10 % pixelů v rect (px)
whiteBalance(img, white) -> img            // nový obrázek, kanály škálované tak, aby white → (245,245,245)
sampleInk(img, rect) -> {lab:[L,a,b], rgb:[r,g,b], n} | null
    // medián Lab pixelů v rect, které jsou „inkoust“: chroma ≥ 12 NEBO L < 70 (výrazně tmavší než papír).
    // null když je takových pixelů < 20.
classifyInks(img, rect, inks, opts) -> Uint8Array(width*height)
    // inks = [{lab}], výsledek: 0 = nic, k+1 = inkoust k. Mimo rect 0.
    // Mapa je tištěná šedotónově ⇒ pixel je kandidát, jen když chroma ≥ opts.minChroma (výchozí 14).
    // Přiřadí nejbližší inkoust podle vážené vzdálenosti (odstín má větší váhu než světlost:
    // d = sqrt((ΔL*0.5)² + Δa² + Δb²)); přijme, pokud d ≤ opts.maxDist (výchozí 40).
cleanMask(mask, w, h, {minArea=12, close=1}) -> Uint8Array   // binární 0/1
    // 1) morfologické uzavření (dilatace + eroze) s poloměrem `close` px (spojí přerušené čáry),
    // 2) odstranění 8-souvislých komponent menších než minArea px.
maskFromLabels(labels, k) -> Uint8Array    // 1 kde labels === k
```

## js/core/edt.js
```js
edt(mask, w, h) -> Float32Array(w*h)
    // přesná euklidovská vzdálenost (px) každého pixelu k nejbližšímu pixelu s mask≠0 (Felzenszwalb–Huttenlocher).
    // Pokud maska nemá žádný nenulový pixel → všude Infinity.
```

## js/core/gpx.js
```js
parseGpx(text) -> {name, points:[{lat, lon, ele|null, time|null /* ms epoch */}], segments:[[startIdx, endIdx]]}
    // regex, bez DOM; trkpt i rtept; atributy lat/lon v libovolném pořadí a uvozovkách.
haversine(a, b) -> metry
filterByTime(points, startMs|null, endMs|null) -> points   // body bez času ponechá
trackLength(points) -> metry
findGaps(points, {maxGapS=120, maxJumpM=150}) -> [{index, fromTime, toTime, gapS, jumpM}]
    // výpadek = mezi body i-1 a i je časový rozdíl > maxGapS NEBO skok > maxJumpM
resample(points, stepM) -> [{lat, lon, time|null, gap:boolean}]
    // body po stepM metrech podél trasy; gap=true pro body ležící uvnitř výpadku (podle findGaps)
```

## js/core/evaluate.js (píše koordinátor)
```js
evaluateSheet({photo, layout, georef, sheetTeam?, teams, tracks, opts}) -> SheetResult
gameScore(project, sheetResults) -> table
renderOverlay(sheetResult) -> img
```
