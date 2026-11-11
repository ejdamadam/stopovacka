# Metriky a bodování hry Stopovačka

Tento dokument popisuje způsob výpočtu přesnosti zakreslení tras a celkového skóre hry ve Stopovačce.

## 1. Porovnání nakreslené čáry s trasou GPX

Pro každý cizí tým vyhodnocovaný na archu se porovnává binární maska rozpoznané nakreslené fixy s referenční trasou GPX.

### Převod a rasterizace
1. Referenční trasa GPX je převzorkována s krokem `stepM` (výchozí 5 m). Body mimo časové okno hry nebo uvnitř výpadků záznamu (`gap: true`) se do hodnocení nezahrnují.
2. Z bodů trasy uvnitř mapového pole se rasterizuje referenční lomená čára $T$.
3. Nakreslená čára týmu tvoří binární masku $D$ o rozměrech $W \times H$ pixelů mapového pole.

### Euklidovská distanční transformace (EDT)
Pomocí algoritmu Felzenszwalb–Huttenlocher se spočítají dvě distanční mapy:
- $D_d(x,y)$: vzdálenost v pixelech od libovolného bodu k nejbližšímu pixelu nakreslené čáry $D$.
- $D_t(x,y)$: vzdálenost v pixelech od libovolného bodu k nejbližšímu pixelu skutečné trasy $T$.

### Váhová funkce (Soft Tolerance)
Aby se eliminovaly drobné nepřesnosti tisku, registrace a kreslení tlustou fixou, používá se funkce lineárního poklesu váhy bodu:

$$\text{softWeight}(d, \text{tol}) = \begin{cases}
1 & \text{pro } d \le \text{tol} \\
2 - \frac{d}{\text{tol}} & \text{pro } \text{tol} < d \le 2\cdot\text{tol} \\
0 & \text{pro } d > 2\cdot\text{tol}
\end{cases}$$

kde:
- $\text{tol} = \frac{\text{tolM}}{mPerPx}$ je tolerance v pixelech mapového pole,
- $\text{tolM}$ je tolerance v terénu (výchozí hodnota 50 metrů).

### Recall (pokrytí skutečné trasy)
Měří, jak velkou část skutečné trasy tým odhalil a zakreslil:
$$\text{Recall} = \frac{\sum_{p \in P_{\text{eval}}} \text{softWeight}(D_d(p), \text{tol})}{|P_{\text{eval}}|}$$

### Precision (přesnost zakreslených čar)
Měří, kolik ze zakreslených čar odpovídá skutečné trase (penalizuje „hádání“ a kreslení čar naslepo po celé mapě):
$$\text{Precision} = \frac{\sum_{q \in D} \text{softWeight}(D_t(q), \text{tol})}{|D|}$$

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
*Pokud tým neodevzdal GPX trasu, nelze utajení ověřit a Stealth = 0.*

### Penalizace za výpadky GPX
Výpadek záznamu je definován jako:
- časová mezera mezi body $> 120\text{ s}$ (`maxGapS`), nebo
- prostorový skok $> 150\text{ m}$ (`maxJumpM`).

Součet všech výpadků $\Delta t_{\text{gap}}$ (v minutách) se porovná s povoleným limitem:
- `allowedGapMin` (výchozí 5 minut zdarma),
- `penaltyPerMin` (výchozí 2 body za každou započatou minutu nad limit).

$$\text{Penalty}_i = \max\left(0, \text{round}\left((\Delta t_{\text{gap}} - \text{allowedGapMin}) \cdot \text{penaltyPerMin}\right)\right)$$

### Celkový výsledek
$$\text{Total}_i = \text{Tracking}_i + \text{Stealth}_i - \text{Penalty}_i$$
Vítězí tým s nejvyšším počtem bodů. Při rovnosti rozhoduje vyšší hodnota stopování.
