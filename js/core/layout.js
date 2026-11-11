// Rozložení tištěného archu v milimetrech. (0,0) = levý horní roh papíru.
//
//  ┌──────────────────────────────────────┐
//  │ [TL]   název týmu + legenda barev [TR]│  ← horní pás (výška = velikost značky)
//  │ ┌──────────────────────────────────┐ │
//  │ │                                  │ │
//  │ │          MAPOVÉ POLE             │ │  ← šedotónová mapa, sem se kreslí
//  │ │                                  │ │
//  │ └──────────────────────────────────┘ │
//  │ [BL] [kalib.1][kalib.2][kalib.3] [BR]│  ← dolní pás: kalibrační pole pro fixy
//  └──────────────────────────────────────┘
//
// POZOR: po vytištění archů se layout nesmí měnit (vyhodnocení počítá pozice značek z layoutu).
// Při změně zvyš LAYOUT_VERSION.

export const LAYOUT_VERSION = 1;

export const PAPERS = { A4: { w: 210, h: 297 }, A3: { w: 297, h: 420 } };

// 16 ID z původního ArUco slovníku: rotačně jednoznačná, vzájemná Hammingova vzdálenost ≥ 7
// (ověřeno v tests/core.test.mjs přes pickMarkerIds(16, 7)). Tým t má ID MARKER_IDS[4t .. 4t+3]
// v pořadí rohů TL, TR, BR, BL → z fotky se pozná, kterému týmu arch patří.
export const MARKER_IDS = [1, 6, 24, 31, 42, 45, 51, 52, 75, 76, 82, 85, 96, 103, 121, 126];
export const CORNERS = ['TL', 'TR', 'BR', 'BL'];

export function markerIdsForTeam(t) { return MARKER_IDS.slice(4 * t, 4 * t + 4); }

/** Najde (tým, roh) podle ID značky, nebo null. */
export function lookupMarkerId(id) {
  const i = MARKER_IDS.indexOf(id);
  return i < 0 ? null : { team: Math.floor(i / 4), corner: i % 4 };
}

/**
 * @param {object} o
 * @param {'A4'|'A3'} o.paper
 * @param {'portrait'|'landscape'} o.orientation
 * @param {number|null} o.mapAspect  šířka/výška mapového obrázku; null = vyplnit celé dostupné pole
 * @param {number} o.calibCount      počet kalibračních polí (= počet cizích týmů, typicky 3)
 */
export function computeLayout({ paper = 'A4', orientation = 'portrait', mapAspect = null, calibCount = 3 } = {}) {
  const P = PAPERS[paper] || PAPERS.A4;
  const w = orientation === 'landscape' ? P.h : P.w;
  const h = orientation === 'landscape' ? P.w : P.h;
  const margin = 7;                                    // okraj papíru (tiskárny netisknou ~4–5 mm)
  const s = Math.round(Math.min(w, h) * 0.09);         // velikost značky (A4: 19 mm, A3: 27 mm)
  const quiet = s / 7 * 1.5;                           // bílá zóna kolem značky
  const markers = [
    { corner: 'TL', x: margin, y: margin },
    { corner: 'TR', x: w - margin - s, y: margin },
    { corner: 'BR', x: w - margin - s, y: h - margin - s },
    { corner: 'BL', x: margin, y: h - margin - s },
  ].map(m => ({ ...m, size: s, cx: m.x + s / 2, cy: m.y + s / 2 }));

  // dostupná plocha pro mapu
  const avail = { x: margin, y: margin + s + quiet, w: w - 2 * margin, h: h - 2 * margin - 2 * s - 2 * quiet };
  let mapRect = { ...avail };
  if (mapAspect && mapAspect > 0) {
    if (mapAspect > avail.w / avail.h) { mapRect.h = avail.w / mapAspect; mapRect.y = avail.y + (avail.h - mapRect.h) / 2; }
    else { mapRect.w = avail.h * mapAspect; mapRect.x = avail.x + (avail.w - mapRect.w) / 2; }
  }

  // hlavička mezi horními značkami
  const header = { x: margin + s + quiet, y: margin, w: w - 2 * (margin + s + quiet), h: s };

  // kalibrační pole mezi dolními značkami
  const cx0 = margin + s + quiet, cw = w - 2 * (margin + s + quiet), gap = 3;
  const bw = (cw - gap * (calibCount - 1)) / calibCount;
  const calib = [];
  for (let i = 0; i < calibCount; i++) calib.push({ x: cx0 + i * (bw + gap), y: h - margin - s, w: bw, h: s });

  return { version: LAYOUT_VERSION, paper, orientation, w, h, margin, markerSize: s, markers, avail, mapRect, header, calib };
}

/** Poměr stran (šířka/výška) mapového obrázku podle definice georeference, nebo null. */
export function mapAspectOf(georefDef) {
  if (!georefDef) return null;
  if (georefDef.type === 'tiles') return (georefDef.px1 - georefDef.px0) / (georefDef.py1 - georefDef.py0);
  if (georefDef.type === 'affine') return georefDef.aspect || null;
  return null;
}

/** Layout archu pro daný projekt – JEDINÉ místo, kde se z projektu skládají parametry layoutu
 *  (používá ho tisk i vyhodnocení, aby se nikdy nerozešly). */
export function layoutForProject(project) {
  return computeLayout({
    paper: project.paper || 'A4',
    orientation: project.orientation || 'portrait',
    mapAspect: mapAspectOf(project.map && project.map.georef),
    calibCount: Math.max(1, (project.teams || []).length - 1),
  });
}

/** Indexy cizích týmů pro arch týmu teamIdx (v pořadí kalibračních polí). */
export function foreignTeams(nTeams, teamIdx) {
  const r = [];
  for (let i = 0; i < nTeams; i++) if (i !== teamIdx) r.push(i);
  return r;
}

/** Oblast uvnitř kalibračního pole, ze které se berou vzorky barvy (bez rámečku a popisku). */
export function calibSampleRect(c) {
  const inset = Math.min(2, c.w * 0.05);
  const labelH = c.h * 0.32;
  return { x: c.x + inset, y: c.y + labelH, w: c.w - 2 * inset, h: c.h - labelH - inset };
}

/** Bodové korespondence sheet-mm pro danou značku (4 rohy v pořadí js-aruco: TL,TR,BR,BL značky). */
export function markerCornersMm(m) {
  return [
    { x: m.x, y: m.y }, { x: m.x + m.size, y: m.y },
    { x: m.x + m.size, y: m.y + m.size }, { x: m.x, y: m.y + m.size },
  ];
}
