# Stopovačka

Webová aplikace pro organizaci a automatické vyhodnocení orientační hry „stopování týmů“ (určená pro iPhone Safari i desktop, provozovatelná na GitHub Pages bez jakéhokoliv backendu).

---

## Princip hry

- 4 týmy se pohybují v terénu a snaží se vystopovat pohyb ostatních týmů, aniž by samy byly odhaleny.
- Každý tým dostane vytištěný arch s mapou území (mapa je tištěna **šedotónově**).
- V dolní části archu má tým kalibrační pole, kam na začátku udělá vzorek fixy pro každý cizí tým (např. Červení = modrá fixa, Modří = zelená fixa...).
- Během hry týmy zakreslují spatřené trasy soupeřů do mapy.
- Každý tým má zapnutý tracker v telefonu (např. Stopař z Mapy.cz), ze kterého po hře odevzdá GPX soubor své skutečné trasy.
- Po skončení hry organizátor vyfotí jednotlivé archy telefonem. Aplikace automaticky:
  1. Detekuje rohové ArUco značky a arch geometricky narovná (homografie).
  2. Provede vyvážení bílé podle papíru.
  3. Zkalibruje barvy fix z kalibračních rámečků.
  4. Vysegmentuje nakreslené čáry v mapě.
  5. Pomocí euklidovské distanční transformace (EDT) porovná nakreslené čáry s referenčními GPX trasami.
  6. Vypočítá skóre stopování, skóre utajení, penalizace za výpadky GPX a celkové pořadí.

---

## Architektura a principy projektu

- **Žádný build krok:** Čisté ES moduly (ESM), nulové npm závislosti pro běh aplikace. Funguje přímo přes statický webový server i z GitHub Pages.
- **Oddělení jádra od DOM:**
  - `js/core/*` je čistý JavaScript bez přístupu k DOM a oknu prohlížeče. Veškerá logika je unit-testovatelná přímo v Node.js (`node --test tests/`).
  - `js/ui/*` a `js/app.js` řeší interakci s uživatelem, Leaflet mapu, renderování canvasu a stav v `localStorage`.
- **Podpora offline/mobilního provozu:** Optimalizováno pro iPhone Safari (dotykové cíle $\ge 44\text{ px}$, šetrná práce s pamětí canvasu).

### Přehled modulů

| Modul | Popis |
|---|---|
| `js/core/geo.js` | Georeference (dlaždice WebMercator i afinní z vlícovacích bodů), parsování souřadnic, lokální metrická projekce |
| `js/core/layout.js` | Rozvržení archu v milimetrech (papír A4/A3, pozice značek, mapového pole a kalibračních okének) |
| `js/core/markers.js` | Generování ArUco značek do SVG + detekce přes js-aruco |
| `js/core/homography.js` | Výpočet homografie DLT, Hartleyho normalizace, bilineární zpětné vzorkování archu |
| `js/core/color.js` | Převod sRGB $\to$ CIE Lab, vyvážení bílé, vzorkování inkoustu, klasifikace čar a morfologické čištění |
| `js/core/edt.js` | Přesná 2D euklidovská distanční transformace (Felzenszwalb–Huttenlocher) |
| `js/core/gpx.js` | Regexový GPX parser bez DOM (Mapy.cz, Strava, Garmin), detekce výpadků, převzorkování |
| `js/core/evaluate.js` | Registrace fotky, segmentace čar, výpočet Recall/Precision/$F_1$, skóre hry a překryvný render |
| `js/ui/sheet.js` | Tiskové rozvržení archu v mm, šedotónová mapa, SVG značky a kalibrační pole |
| `js/ui/mapPicker.js` | Výběr výřezu dlaždicové mapy přes Leaflet (OpenTopoMap, Freemap, OSM) s tiskovým rámečkem |
| `js/ui/evaluate.js` | UI pro nahrání fotek archů, spuštění analýzy, interaktivní overlay a tabulky výsledků |
| `js/app.js` | Řízení stavu projektu, záložky aplikace, ukládání do `localStorage` |

---

## Spuštění a testování

### Lokální spuštění
Pro lokální běh stačí spustit jakýkoliv statický webový server v kořenovém adresáři:
```bash
python3 -m http.server 8000
```
Následně otevřete v prohlížeči `http://localhost:8000`.

### Spuštění testů
Unit testy pokrývají kompletní jádro aplikace:
```bash
node --test tests/*.test.mjs
```

---

## Dokumentace
- [Uživatelský návod krok za krokem](docs/NAVOD.md)
- [Metriky a bodování](docs/METRIKY.md)
- [Registrace fotky a extrakce tras](docs/REGISTRACE.md)
- [Specifikace rozhraní modulů jádra](docs/SPEC_MODULY.md)

---

## Stav projektu

- [x] Georeference a mapové projekce (`js/core/geo.js`)
- [x] Matematika homografie a narovnání archu (`js/core/homography.js`)
- [x] Layout archu a ArUco kódování (`js/core/layout.js`, `js/core/markers.js`)
- [x] Barevný pipeline CIE Lab a morfologie (`js/core/color.js`)
- [x] 2D Euklidovská distanční transformace (`js/core/edt.js`)
- [x] Robustní GPX parser a analýza tras (`js/core/gpx.js`)
- [x] Vyhodnocovací jádro a metriky hry (`js/core/evaluate.js`)
- [x] Generování tiskových archů a CSS tisk (`js/ui/sheet.js`)
- [x] Výběr mapových podkladů v Leafletu (`js/ui/mapPicker.js`)
- [x] Uživatelské rozhraní aplikace a správa stavu (`js/app.js`, `index.html`)
- [x] Vyhodnocovací UI modul (`js/ui/evaluate.js`)
- [x] Sada unit testů pro všechny moduly jádra (`tests/`)
