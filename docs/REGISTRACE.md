# Registrace fotky a extrakce tras

Tento dokument popisuje matematický a obrazový pipeline od pořízení fotky archu po získání binárních masek tras.

## 1. Značky ArUco a identifikace archu

Každý vytištěný arch obsahuje v rozích 4 značky z původního ArUco slovníku 5×5 (1024 ID):
- Vnější černý okraj 1 buňka, vnitřní data 5×5 buněk, celkem 7×7 buněk.
- Kolem značky je povinná bílá ochranná zóna (quiet zone) $\ge 1.5$ buňky.
- Pro 4 týmy je vybráno 16 ID (`MARKER_IDS`), která mají vzájemnou rotační Hammingovu vzdálenost $\ge 7$.
- Tým $t$ (0..3) má přiřazenou čtveřici značek:
  - TL (Top-Left): `MARKER_IDS[4t + 0]`
  - TR (Top-Right): `MARKER_IDS[4t + 1]`
  - BR (Bottom-Right): `MARKER_IDS[4t + 2]`
  - BL (Bottom-Left): `MARKER_IDS[4t + 3]`

Díky tomu aplikace z jediné fotky automaticky pozná:
1. Kterému týmu arch patří (nejčastější tým mezi detekovanými rohy).
2. Orientaci archu v prostoru (pořadí rohů TL, TR, BR, BL).

---

## 2. Homografie a narovnání archu (Warping)

### Projektivní geometrie
Vztah mezi rovinou papíru v milimetrech $[X, Y, 1]^T$ a rovinou fotky v pixelech $[x, y, 1]^T$ popisuje homografie $3 \times 3$:

$$\begin{bmatrix} x' \\ y' \\ w \end{bmatrix} = \mathbf{H} \begin{bmatrix} X \\ Y \\ 1 \end{bmatrix}, \quad x = \frac{x'}{w}, \quad y = \frac{y'}{w}$$

### Řešení přes DLT (Direct Linear Transformation)
- Pro každou z nalezených značek známe přesné teoretické souřadnice jejích 4 rohů v mm z `computeLayout`.
- Ze 4 značek získáme až 16 bodových korespondencí (minimum pro výpočet jsou 2 značky = 8 bodů, standardně 4 značky = 16 bodů).
- Souřadnice jsou normalizovány (Hartleyho normalizace s těžištěm v počátku a průměrnou vzdáleností $\sqrt{2}$).
- Homografie se řeší metodou nejmenších čtverců (SVD / normální rovnice) a denormalizuje.
- Spočítá se střední kvadratická chyba reprojekce (RMS) v milimetrech (`rmsMm`).

### Zpětné vzorkování (Inverse Warping)
- Cílový narovnaný arch má rozměr $W_{\text{rect}} = W_{\text{mm}} \cdot \text{ppm}$, $H_{\text{rect}} = H_{\text{mm}} \cdot \text{ppm}$ (výchozí rozlišení $\text{ppm} = 4\text{ px/mm}$).
- Pro každý pixel $(X, Y)$ narovnaného archu se spočítá poloha ve fotce přes $\mathbf{H}$ a provede se bilineární interpolace barev RGBA.

---

## 3. Vyvážení bílé a kalibrace fix

### Vyvážení bílé
Osvětlení při focení telefonem bývá nerovnoměrné nebo barevně posunuté (žluté žárovkové světlo apod.):
1. V ploše mapového pole se určí medián barvy nejjasnějších ~10 % pixelů (`estimateWhite`), což odpovídá podkladovému bílému papíru.
2. Kanály R, G, B celého narovnaného archu se lineárně přeškálují tak, aby barva papíru odpovídala neutrální světle šedé $(245, 245, 245)$.

### Kalibrace fix z kalibračních polí
V dolním pásu archu má tým předkreslené rámečky pro každý cizí tým:
1. `calibSampleRect` vymezí střední oblast rámečku pod textem (spodních 68 % výšky).
2. `sampleInk` vybere pixely, které nesou inkoust (sytost $\text{Chroma} \ge 12$ nebo světlost $L < 70$).
3. Určí se reprezentativní barva fixy v barevném prostoru CIE Lab (D65) jako medián vzorků.

---

## 4. Klasifikace barevných čar v mapě

Mapa je tištěná výhradně **šedotónově**, což znamená, že veškerá kresba mapy má nízkou sytost ($\text{Chroma} \approx 0$).
Barevné čáry fixy mají naopak vysokou sytost.

1. Pro každý pixel mapového pole se převede barva sRGB $\to$ CIE Lab (optimalizováno s precomputed lookup table pro linearizaci).
2. Pixel je kandidátem na fixu, pokud $\text{Chroma} \ge \text{minChroma}$ (výchozí 14).
3. Spočítá se vážená barevná vzdálenost ke každé kalibrované fixe:
   $$d = \sqrt{(0.5 \cdot \Delta L)^2 + \Delta a^2 + \Delta b^2}$$
   *(Váha světlosti $L$ je snížena na polovinu, protože sytost a odstín fixy jsou stabilnější než kolísání přítlaku a stínování).*
4. Pokud $\min(d) \le \text{maxDist}$ (výchozí 40), pixel je přiřazen příslušné fixe.

---

## 5. Morfologické čištění masky

Surová maska klasifikovaných pixelů může obsahovat drobné tečky způsobené tiskovým rastrem nebo naopak tenká přerušení čáry:
1. **Morfologické uzavření (Closing)**: dilatace následovaná erozí o poloměru `close = 1 px`. Tím se spojí drobné mezery ve stopě fixy.
2. **Filtrace malých komponent**: hledání 8-souvislých komponent (Connected Component Labeling). Komponenty s plochou menší než `minArea` (výchozí 12 px) jsou odstraněny jako šum.

Výsledná čistá binární maska vstupuje do porovnávacího algoritmu s trasou GPX (viz `METRIKY.md`).
