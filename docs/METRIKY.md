# Metriky a bodování hry Stopovačka

Tento dokument popisuje způsob výpočtu přesnosti zakreslení tras a celkového skóre hry ve Stopovačce.

## 1. Porovnání nakreslené čáry s trasou GPX

Pro každý cizí tým vyhodnocovaný na archu se porovnává binární maska rozpoznané nakreslené fixy s referenční trasou GPX.

### Převod, potlačení šumu a rasterizace
1. Pokud GPX obsahuje časové značky `<time>`, potlačí se pomocí `filterJitter` (`jitterRadiusM = 15 m`) plavání GPS signálu při stání na místě (body v okruhu 15 m od kotvy se přichytí ke kotvě se zachováním času), takže přestávky nevytvářejí fiktivní metry ani falešné výpadky. Chůze stejnou cestou tam a zpět zůstává plně zachována – soupeř, který tuto cestu zakreslí, tak získá body za oba průchody.
2. Ručně nakreslená / opravená trasa GPX bez časových značek `<time>` se vyhodnocuje souvisle bez detekce výpadků (ani delší přímé úseky mezi naklikanými body se neoznačují jako výpadek signálu).
3. Referenční trasa GPX je převzorkována s krokem `stepM` (výchozí 5 m). Body uvnitř výpadků záznamu (`gap: true`) se nezahrnují do aktivního hodnocení `Recall`, ale vytvářejí neutrální (*don't-care*) koridor, aby stopující tým nebyl trestán za výpadek GPX soupeře.
4. Z platných bodů trasy uvnitř mapového pole se rasterizuje referenční lomená čára $T$.
5. Z binární masky nakreslené fixy $D$ se extrahuje středové jádro o optimální šířce ~1 mm (`optLineWidthMm = 1.2 mm`) pro výpočet pokrytí, a současně se určí průměrná šířka stopy `avgLineWidthMm`.

### Euklidovská distanční transformace (EDT)
Pomocí algoritmu Felzenszwalb–Huttenlocher se spočítají distanční mapy:
- $D_d(x,y)$: vzdálenost v pixelech od libovolného bodu k nejbližšímu pixelu ~1 mm středového jádra nakreslené čáry (tlustší fixa tedy nerozšíří dosah).
- $D_t(x,y)$: vzdálenost v pixelech od libovolného bodu k nejbližšímu pixelu platné skutečné trasy $T$.

### Váhová funkce (Soft Tolerance) a souběžné čáry
Safe pás s plným bodováním je nastaven na `tolM = 50 m` ($\pm 3{,}3\text{ mm}$ na papíře v měřítku 1 : 15 000). Mimo safe pás klesá váha bodu lineárně až k nule v hranici `maxTolM = 300 m` ($\approx 2\text{ cm}$ na papíře při 1 : 15 000):

$$\text{softWeight}(d, \text{tol}, \text{maxTol}) = \begin{cases}
1 & \text{pro } d \le \text{tol} \\
\frac{\text{maxTol} - d}{\text{maxTol} - \text{tol}} & \text{pro } \text{tol} < d \le \text{maxTol} \\
0 & \text{pro } d > \text{maxTol}
\end{cases}$$

kde $\text{tol} = \frac{\text{tolM}}{mPerPx}$ a $\text{maxTol} = \max\left(2\cdot\text{tol}, \frac{\text{maxTolM}}{mPerPx}\right)$.

Pokud jde více týmů stejnou cestou a hráč jejich čáry zakreslí souběžně vedle sebe, toleranční pásmo se lokálně rozšíří o `parallelShiftMm = 2.2 mm` za každou souběžnou čáru jiného týmu v daném místě.

### Recall (pokrytí skutečné trasy)
Měří, jak velkou část skutečné trasy tým odhalil a zakreslil:
$$\text{Recall} = \frac{\sum_{p \in P_{\text{eval}}} \text{softWeight}(D_d(p), \text{tol}_{\text{loc}}, \text{maxTol}_{\text{loc}})}{|P_{\text{eval}}|}$$

### Precision (přesnost čar, tloušťka fixy a penalizace hádání)
Měří, kolik ze zakreslených čar odpovídá skutečné trase. Chybné pixely mimo toleranci jsou zatíženy váhou `wrongPenalty` (výchozí `2.0`), aby se nevyplácelo slepé čmárání naslepo po mapě, a tlusté čáry nad `optLineWidthMm` (`1.2 mm`) jsou penalizovány faktorem $\text{thicknessFactor} = \min(1, \frac{\text{optLineWidthMm}}{\text{avgLineWidthMm}})$:

$$\text{Precision} = \text{thicknessFactor} \cdot \frac{\sum_{q \in D_{\text{eval}}} w(q)}{\sum_{q \in D_{\text{eval}}} \left(w(q) + \text{wrongPenalty} \cdot (1 - w(q))\right)}$$

kde $w(q) = \text{softWeight}(D_t(q), \text{tol}_{\text{loc}}, \text{maxTol}_{\text{loc}})$ a $D_{\text{eval}}$ jsou nakreslené pixely mimo neutrální zónu případného cizího výpadku GPX.

### $F_1$ skóre a bodový zisk
Celkové skóre odhalení daného týmu je harmonickým průměrem:
$$F_1 = \frac{2 \cdot \text{Recall} \cdot \text{Precision}}{\text{Recall} + \text{Precision}}$$
$$\text{Score} = \text{round}(100 \cdot F_1) \in [0, 100]$$

---

## 2. Celkové skóre hry

Hra hodnotí dvě složky dovedností týmu:
1. **Stopování (Tracking)**: Schopnost týmu vypátrat a přesně zakreslit trasy ostatních týmů.
2. **Utajení (Stealth)**: Schopnost týmu pohybovat se nenápadně a nenechat se vystopovat ostatními.

### Stopování (0–100 bodů)
Průměr ze skóre, která tým získal na svém archu za zakreslení všech ostatních ($N - 1$) týmů:
$$\text{Tracking}_i = \frac{1}{N - 1} \sum_{j \ne i} \text{Score}(i \to j)$$
*Pokud arch týmu chybí nebo nebyl odevzdán, je Tracking = 0.*

### Utajení (0–100 bodů)
Počítá se z toho, jak dobře byl tým $i$ zakreslen ostatními týmy:
$$\text{Detected}_i = \frac{1}{N - 1} \sum_{j \ne i} \text{Score}(j \to i)$$
$$\text{Stealth}_i = 100 - \text{Detected}_i$$
*(Volitelně lze v pokročilém nastavení zapnout práh `stealthRefTracking > 0`, který utajení podmiňuje minimálním skóre stopování $\text{Stealth}_i = \text{round}(\text{RawStealth}_i \cdot \min(1, \text{Tracking}_i / \text{stealthRefTracking}))$; výchozí hodnota je `0`, tj. bez krácení.)*
*Pokud tým neodevzdal GPX trasu, nelze utajení ověřit a Stealth = 0.*

### Detekce výpadků GPX a volitelná penalizace
Výpadek záznamu se zjišťuje u nahraných GPX tras s časovými značkami jako:
- časová mezera mezi body $> 120\text{ s}$ (`maxGapS`), nebo
- prostorový skok $> 150\text{ m}$ (`maxJumpM`).

Pokud aplikace výpadek zjistí, upozorní na něj organizátora v záložce **4. GPX trasy** i **5. Vyhodnocení**, aby bylo možné trasu případně ručně dokreslit v mapě a nahrát opravené GPX (bez časových značek se pak vyhodnocuje souvisle).

Výchozí bodová penalizace je `0` bodů/min (`penaltyPerMin = 0`), protože výpadky nebývají vinou týmu. V pokročilém nastavení lze penalizaci zapnout:
- `allowedGapMin` (výchozí 5 minut zdarma),
- `penaltyPerMin` (výchozí 0 bodů za minutu nad limit).

$$\text{Penalty}_i = \max\left(0, \text{round}\left((\Delta t_{\text{gap}} - \text{allowedGapMin}) \cdot \text{penaltyPerMin}\right)\right)$$

### Celkový výsledek
$$\text{Total}_i = \text{Tracking}_i + \text{Stealth}_i - \text{Penalty}_i$$
Vítězí tým s nejvyšším počtem bodů. Při rovnosti rozhoduje vyšší hodnota stopování.

---

## 3. Kontrola bodů povinného průchodu (mimo bodování)

V záložce **4. GPX trasy** lze přidat kontrolní body (název, souřadnice WGS-84, poloměr uznání v metrech). Aplikace u každého týmu zkontroluje minimální vzdálenost trasy GPX (včetně úseček mezi po sobě jdoucími body do 200 m mimo výpadky) k danému bodu a zobrazí, zda tým kontrolou prošel. Tato kontrola slouží pouze pro přehled organizátora a do bodového skóre se nezapočítává.
