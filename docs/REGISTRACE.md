# Registrace fotky a extrakce tras

Tento dokument popisuje matematický a obrazový pipeline od pořízení fotky archu po získání binárních masek tras.

## 1. Značky ArUco a identifikace archu

Každý vytištěný arch obsahuje po obvodu ArUco značky z původního 5×5 slovníku (1024 ID):
- Vnější černý okraj 1 buňka, vnitřní data 5×5 buněk, celkem 7×7 buněk.
- Kolem každé značky je bílá ochranná zóna (quiet zone) $\ge 1.2$ buňky.
- Pro 4 týmy je vybráno 32 vzájemně rotačně jednoznačných ID s Hammingovou vzdáleností $\ge 7$ přes všechny 4 rotace:
  - 16 ID pro rohy (`CORNER_IDS`): `TL`, `TR`, `BR`, `BL`.
  - 16 ID pro středy hran (`EDGE_IDS`): `TC` (nahoře uprostřed), `MR` (vpravo uprostřed), `BC` (dole uprostřed), `ML` (vlevo uprostřed).
- Tým $t$ (0..3) má přiřazenou sadu značek:
  - Rohy: `CORNER_IDS[4t .. 4t+3]` (TL, TR, BR, BL)
  - Středy hran: `EDGE_IDS[4t .. 4t+3]` (TC, MR, BC, ML)

Díky 8 značkám po obvodu aplikace z jediné fotky automaticky:
1. Pozná, kterému týmu arch patří (i když je některá značka poškozena nebo zakryta prstem).
2. Spočítá globální projektivní homografii $\mathbf{H}$ (až 32 bodových korespondencí z 8 značek).
3. Při detekci $\ge 5$ značek aktivuje **nelineární model deformace (Thin-Plate Spline, TPS)**, který eliminuje zkreslení z křížového přeložení papíru v kapse nebo zvlnění v terénu.

---

## 2. Homografie a nelineární TPS narovnání archu (Warping)

### Projektivní geometrie a DLT
Základní vztah mezi rovinou papíru $[X, Y, 1]^T$ (mm) a fotkou $[x, y, 1]^T$ (px) určuje homografie $3 \times 3$:

$$\begin{bmatrix} x' \\ y' \\ w \end{bmatrix} = \mathbf{H} \begin{bmatrix} X \\ Y \\ 1 \end{bmatrix}, \quad x = \frac{x'}{w}, \quad y = \frac{y'}{w}$$

Homografie se počítá metodou nejmenších čtverců (DLT s Hartleyho normalizací) ze všech nalezených rohů značek (až 32 bodů).

### Nelineární TPS korekce (Thin-Plate Spline)
Pokud je papír zvlněný nebo byl v terénu přeložen, body uprostřed stran (`TC`, `BC`, `ML`, `MR`) vykazují odchylku $\Delta \vec{p}_i = \vec{p}_{\text{photo}, i} - \mathbf{H}(\vec{p}_{\text{mm}, i})$.
Pomocí biharmonického jádra $U(r) = r^2 \ln(r)$ se spočítá hladká nelineární korekce:

$$\vec{p}(X, Y) = \mathbf{H}(X, Y) + \vec{\Delta}_{\text{TPS}}(X, Y)$$

TPS pole se předpočítá v mřížce po 10 mm a při vzorkování se bilineárně interpoluje. Tím se narovnají lomy papíru i lokální vyboulení bez zpomalení výpočtu.

### Zpětné vzorkování (Inverse Warping)
- Cílový narovnaný arch má rozměr $W_{\text{rect}} = W_{\text{mm}} \cdot \text{ppm}$, $H_{\text{rect}} = H_{\text{mm}} \cdot \text{ppm}$ (výchozí rozlišení $\text{ppm} = 4\text{ px/mm}$).
- Pro každý pixel $(X, Y)$ narovnaného archu se spočítá poloha ve fotce přes $\mathbf{H} + \vec{\Delta}_{\text{TPS}}$ a provede se bilineární interpolace barev RGBA.

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
