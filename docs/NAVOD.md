# Uživatelský návod ke hře Stopovačka

Tento návod vás provede přípravou hry, tiskem archů, průběhem a vyhodnocením orientační hry „Stopovačka“.

---

## 1. Příprava hry v aplikaci

Aplikace běží přímo v prohlížeči (optimální pro iPhone Safari i libovolný moderní desktopový prohlížeč):
1. Otevřete aplikaci na GitHub Pages nebo přes lokální server.
2. V záložce **„1. Projekt“**:
   - Zadejte název akce/hry.
   - Pojmenujte jednotlivé týmy (výchozí 4 týmy) a vyberte jejich rozlišovací barvy.
   - Zvolte formát papíru (**A4** nebo **A3**) a orientaci (**na výšku** / **na šířku**).
   - **Barevnost tisku mapy**:
     * *Šedotónová (doporučeno)*: maximální kontrast, barevné fixy z mapy jasně vystupují.
     * *Tlumená barevná*: lesy zelené, voda modrá, ale barvy jsou ztlumené, aby fixy dominovaly.
     * *Plnobarevná*: původní sytost mapy.
   - **Korekční značky (ArUco)**:
     * *8 značek (doporučeno)*: 4 v rozích + 4 ve středech hran. Umožňuje nelineární TPS narovnání pomačkaného nebo přeloženého papíru v terénu a je odolné i při zašpinění nebo utržení rohu.
     * *4 značky*: klasické rohové značky.
3. **Uložení a přenos projektu (PC → Mobil)**:
   - Pokud mapu připravujete a tisknete na počítači předem a vyhodnocovat chcete v terénu na mobilu:
   - V záložce „1. Projekt“ klepněte na **„Stáhnout projekt do souboru (.json)“**.
   - Soubor si pošlete na telefon (AirDrop, WhatsApp, e-mail nebo iCloud/Google Drive).
   - V den hry otevřete aplikaci na mobilu a klepněte na **„Nahrát projekt ze souboru“**. Vše se okamžitě načte.

---

## 2. Výběr a nastavení mapy

V záložce **„2. Mapa“** máte dvě možnosti:

### Možnost A: Dlaždicová mapa (doporučeno pro běžný terén)
1. Zvolte podklad (OpenTopoMap, turistická Freemap Slovakia nebo OpenStreetMap).
2. Na interaktivní mapě posuňte a přibližte výřez terénu tak, aby požadované území bylo uvnitř vyznačeného obdélníku.
3. Zvolte tiskový zoom (obvykle 14–16) podle požadovaného detailu vrstevnic a cest.

### Možnost B: Vlastní mapa (sken O-mapy nebo orofoto)
1. Nahrajte obrázek mapy (JPG / PNG).
2. Klepnutím do mapy označte 2 až 4 výrazné body (křižovatky cest, kapličky, vrcholy) a zadejte jejich souřadnice (např. z Mapy.cz).
3. Aplikace spočítá afinní transformaci a zobrazí střední chybu v metrech (`rmsM`).

---

## 3. Tisk archů pro týmy

V záložce **„3. Tisk“**:
1. Zkontrolujte náhledy archů pro jednotlivé týmy. Každý arch obsahuje:
   - Identifikační ArUco značky v rozích papíru.
   - Hlavičku s názvem týmu a instrukcemi.
   - Šedotónovou mapu s měřítkem.
   - **Kalibrační pole** pro každý cizí tým v dolní části archu.
2. Stiskněte tlačítko **„Vytisknout archy“**.
   - V dialogu tisku zkontrolujte měřítko 100 % (bez zmenšování/přizpůsobování okrajům).
   - Tiskněte černobíle / šedotónově.

---

## 4. Průběh hry

1. Každému týmu předejte jeho vytištěný arch a sadu **barevných fix** (doporučeno: syté, výrazné barvy jako červená, modrá, zelená, fialová; vyvarujte se černé a šedé).
2. **DŮLEŽITÉ PŘED STARTEM**: Každý tým musí hned na začátku udělat **tlustou čáru fixou do kalibračního pole** pro každý cizí tým, aby bylo jasné, kterou barvou bude koho zakreslovat.
3. Každý tým spustí na svém telefonu záznam trasy (např. Stopař v aplikaci Mapy.cz nebo outdoorové hodinky).
4. V záložce **„4. Hra & GPX“** v aplikaci organizátora nastavte oficiální čas začátku a konce hry.
5. Během hry týmy pátrají po pohybu soupeřů a jejich spatřené nebo vydedukované trasy zakreslují do své mapy příslušnou barvou fixy.

---

## 5. Ukončení a vyhodnocení hry

1. V cíli odevzdá každý tým svůj arch organizátorovi a exportuje GPX soubor své stopy.
2. V záložce **„4. Hra & GPX“**:
   - Nahrajte GPX soubory jednotlivých týmů. Aplikace automaticky zkontroluje délku tras a výpadky signálu.
3. V záložce **„5. Vyhodnocení“**:
   - Telefonem vyfoťte odevzdané archy.
   - Fotku můžete nahrát přímo z fotoaparátu do karty týmu nebo hromadně.
   - Aplikace automaticky:
     * Najde rohové značky a arch narovná.
     * Vyrovná vyvážení bílé podle papíru.
     * Načte barvy fix z kalibračních polí.
     * Vysegmentuje barevné čáry a porovná je s GPX trasou každého týmu.
4. V náhledu zkontrolujte překryvný obrázek (Overlay) s nakreslenými čarami a reálnými stopami.
5. Prohlédněte si tabulku výsledků (Stopování, Utajení, Penalizace a Celkové skóre).
6. Výsledky lze stáhnout jako CSV soubor tlačítkem **„Exportovat výsledky (CSV)“**.
