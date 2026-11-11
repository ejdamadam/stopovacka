# AGENTS.md – poznámky pro další agenty / vývojáře

Projekt: **Stopovačka** – webová aplikace (iPhone Safari, GitHub Pages) pro vyhodnocení
orientační hry „stopování týmů“. Viz [README.md](README.md) (uživatelský přehled),
[docs/NAVOD.md](docs/NAVOD.md) (návod krok za krokem), [docs/METRIKY.md](docs/METRIKY.md)
(bodování a penalizace), [docs/REGISTRACE.md](docs/REGISTRACE.md) (registrace fotky a tras).

## Princip hry (kontext)
- 4 týmy, každý dostane vytištěný arch s mapou (mapa je tištěná **šedotónově**).
- Každý tým během hry zakresluje trasy *ostatních* týmů, každý cizí tým jinou barvou fixy.
- Každý tým má zapnutý tracker mapy.com → po hře GPX skutečné trasy.
- Na konci se každý arch vyfotí telefonem, aplikace fotku narovná (ArUco značky v rozích),
  vytáhne barevné čáry a porovná je s GPX.

## Zásady
- **Žádný build krok.** Čisté ES moduly, statické soubory, funguje z GitHub Pages i `python3 -m http.server`.
- Jádro (`js/core/*`) je **čisté JS bez DOM** → testovatelné v Node (`node --test tests/`).
  DOM/UI je jen v `js/app.js` a `js/ui/*`.
- Obrázky v jádře = objekt `{width, height, data: Uint8ClampedArray RGBA}` (kompatibilní s `ImageData`).
- Komentáře a UI texty česky, identifikátory anglicky.
- Externí knihovny: `js/vendor/aruco.js` + `cv.js` (js-aruco, MIT, J. Mellado; globální `AR`, `CV`),
  Leaflet z CDN (jen pro výběr výřezu dlaždicové mapy).

## Souřadnicové systémy (DŮLEŽITÉ)
1. **lat/lon** (WGS84) – GPX.
2. **map uv** – normalizované souřadnice mapového obrázku, `u,v ∈ [0,1]`, (0,0) = levý horní roh.
   Převod lat/lon ↔ uv dělá georeference (`js/core/geo.js`, `makeGeoref`).
3. **sheet mm** – milimetry na tištěném archu, (0,0) = levý horní roh papíru.
   Rozložení archu (`js/core/layout.js`, `computeLayout`) určuje polohu značek, mapy a kalibračních polí.
4. **photo px** – pixely fotky. Homografie `H: sheet mm → photo px` (`js/core/homography.js`).
5. **rect px** – narovnaný arch, `rect = mm * PX_PER_MM` (výchozí 4 px/mm).
6. **local m** – lokální metry (ekvidistantní projekce kolem středu mapy) pro vzdálenosti.

## Moduly
| soubor | obsah |
|---|---|
| `js/core/geo.js` | georeference (dlaždice WebMercator / afinní z vlícovacích bodů), parsování souřadnic, lokální metry |
| `js/core/layout.js` | rozložení archu (papír, značky, mapové pole, kalibrační pole), ID značek per tým |
| `js/core/markers.js` | generování ArUco (původní 5×5 slovník) jako SVG + detekce přes js-aruco |
| `js/core/homography.js` | DLT homografie (≥4 body, nejmenší čtverce), aplikace, narovnání obrazu |
| `js/core/color.js` | sRGB→Lab, vyvážení bílé, kalibrace barev fix, klasifikace pixelů, čištění masky |
| `js/core/edt.js` | přesná euklidovská distanční transformace (Felzenszwalb) |
| `js/core/gpx.js` | parser GPX (regex, bez DOM), časový filtr, délka, výpadky záznamu |
| `js/core/evaluate.js` | celý pipeline vyhodnocení jednoho archu + skóre hry |
| `js/app.js` | UI, stav projektu (localStorage), tisk, nahrávání fotek |

## Stav / TODO
Viz sekce „Stav“ na konci [README.md](README.md). Při změně bodování aktualizuj `docs/METRIKY.md`,
při změně layoutu/registrace `docs/REGISTRACE.md`.

**Pozor:** změna `computeLayout` po vytištění archů rozbije vyhodnocení už vytištěných archů
(pozice značek se počítají z layoutu). Pokud měníš layout, zvyš `LAYOUT_VERSION`.
