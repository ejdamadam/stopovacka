// Rozložení tištěného archu v milimetrech. (0,0) = levý horní roh papíru.
//
//  Arch s 8 značkami (odolný proti pomačkání a přeložení v terénu):
//  ┌──────────────────────────────────────┐
//  │ [TL]   název týmu   [TC]  instrukce  [TR]│  ← horní pás (výška = velikost značky)
//  │ ┌──────────────────────────────────┐ │
//  │ │                                  │ │
//  │[ML]        MAPOVÉ POLE            [MR]  ← šedotónová nebo barevná mapa
//  │ │                                  │ │
//  │ └──────────────────────────────────┘ │
//  │ [BL] [kalib.1][kalib.2] [BC] [kalib.3] [BR]│  ← dolní pás: kalibrační pole pro fixy
//  └──────────────────────────────────────┘
//
// POZOR: po vytištění archů se layout nesmí měnit (vyhodnocení počítá pozice značek z layoutu).
// Při změně zvyš LAYOUT_VERSION.

export const LAYOUT_VERSION = 3;

export const PAPERS = { A4: { w: 210, h: 297 }, A3: { w: 297, h: 420 } };

// 64 ID z původního ArUco slovníku: rotačně jednoznačná, vzájemná Hammingova vzdálenost ≥ 5
// (32 pro rohové značky CORNER_IDS + 32 pro středové značky hran EDGE_IDS), podpora pro až 8 týmů.
// Prvních 16 CORNER_IDS a 16 EDGE_IDS přesně zachovává původní vybranou sadu pro týmy 1–4.
export const CORNER_IDS = [
  1, 6, 24, 31, 42, 45, 51, 52, 75, 76, 82, 85, 96, 103, 121, 126,
  128, 135, 141, 145, 150, 155, 162, 164, 169, 175, 181, 184, 194, 196, 207, 208
];
export const MARKER_IDS = CORNER_IDS.slice(0, 16);
export const EDGE_IDS = [
  389, 394, 403, 412, 422, 432, 457, 479, 483, 492, 501, 642, 649, 660, 677, 703,
  215, 217, 222, 225, 230, 232, 251, 252, 258, 260, 269, 272, 277, 282, 289, 295
];
export const ALL_MARKER_IDS = [...CORNER_IDS, ...EDGE_IDS];

export const CORNERS = ['TL', 'TR', 'BR', 'BL'];
export const ROLES_8 = ['TL', 'TC', 'TR', 'MR', 'BR', 'BC', 'BL', 'ML'];

export function markerIdsForTeam(t, markerCount = 4) {
  const corners = CORNER_IDS.slice(4 * t, 4 * t + 4);
  if (markerCount === 4) return corners;
  const edges = EDGE_IDS.slice(4 * t, 4 * t + 4);
  // Pořadí pro 8 značek po obvodu: TL, TC, TR, MR, BR, BC, BL, ML
  return [corners[0], edges[0], corners[1], edges[1], corners[2], edges[2], corners[3], edges[3]];
}

/** Najde (tým, roh/hrana) podle ID značky, nebo null. */
export function lookupMarkerId(id) {
  const ci = CORNER_IDS.indexOf(id);
  if (ci >= 0) {
    const team = Math.floor(ci / 4);
    const corner = ci % 4;
    return { team, corner, role: CORNERS[corner], isCorner: true };
  }
  const ei = EDGE_IDS.indexOf(id);
  if (ei >= 0) {
    const team = Math.floor(ei / 4);
    const edge = ei % 4;
    return { team, corner: null, edge, role: ['TC', 'MR', 'BC', 'ML'][edge], isCorner: false };
  }
  return null;
}

/**
 * @param {object} o
 * @param {'A4'|'A3'} o.paper
 * @param {'portrait'|'landscape'} o.orientation
 * @param {number|null} o.mapAspect  šířka/výška mapového obrázku; null = vyplnit celé dostupné pole
 * @param {number} o.calibCount      počet kalibračních polí (= počet cizích týmů, typicky 3)
 * @param {number} o.markerCount     počet značek (4 nebo 8, výchozí 8 pro vyšší odolnost v terénu)
 */
export function computeLayout(paperOrOpts = {}, orientation = 'portrait', mapAspect = null, calibCount = 3, markerCount = 8) {
  let paper = 'A4';
  if (typeof paperOrOpts === 'string') {
    paper = paperOrOpts;
  } else if (paperOrOpts && typeof paperOrOpts === 'object') {
    paper = paperOrOpts.paper || 'A4';
    orientation = paperOrOpts.orientation || 'portrait';
    mapAspect = paperOrOpts.mapAspect !== undefined ? paperOrOpts.mapAspect : null;
    calibCount = paperOrOpts.calibCount !== undefined ? paperOrOpts.calibCount : 3;
    markerCount = paperOrOpts.markerCount !== undefined ? paperOrOpts.markerCount : 8;
  }

  const P = PAPERS[paper] || PAPERS.A4;
  const w = orientation === 'landscape' ? P.h : P.w;
  const h = orientation === 'landscape' ? P.w : P.h;
  const margin = 10;                                   // bezpečný okraj papíru 10 mm (vyhovuje všem tiskárnám vč. AirPrint a nezkresluje tisk)
  const s = Math.round(Math.min(w, h) * (markerCount === 8 ? 0.075 : 0.09)); // A4: 16 mm (8 značek) nebo 19 mm (4 značky)
  const quiet = Math.max(2, Math.round(s / 7 * 1.2)); // bílá zóna kolem značky

  const cornerMarkers = [
    { role: 'TL', corner: 'TL', x: margin, y: margin },
    { role: 'TR', corner: 'TR', x: w - margin - s, y: margin },
    { role: 'BR', corner: 'BR', x: w - margin - s, y: h - margin - s },
    { role: 'BL', corner: 'BL', x: margin, y: h - margin - s },
  ];

  let markersList = cornerMarkers;
  if (markerCount === 8) {
    const edgeMarkers = [
      { role: 'TC', corner: null, x: Math.round((w - s) / 2), y: margin },
      { role: 'MR', corner: null, x: w - margin - s, y: Math.round((h - s) / 2) },
      { role: 'BC', corner: null, x: Math.round((w - s) / 2), y: h - margin - s },
      { role: 'ML', corner: null, x: margin, y: Math.round((h - s) / 2) },
    ];
    // Pořadí 8 značek po obvodu: TL, TC, TR, MR, BR, BC, BL, ML
    markersList = [
      cornerMarkers[0], edgeMarkers[0], cornerMarkers[1], edgeMarkers[1],
      cornerMarkers[2], edgeMarkers[2], cornerMarkers[3], edgeMarkers[3]
    ];
  }

  const markers = markersList.map(m => ({ ...m, size: s, cx: m.x + s / 2, cy: m.y + s / 2 }));

  // dostupná plocha pro mapu
  let avail;
  if (markerCount === 8) {
    avail = {
      x: margin + s + quiet,
      y: margin + s + quiet,
      w: w - 2 * (margin + s + quiet),
      h: h - 2 * (margin + s + quiet),
    };
  } else {
    avail = {
      x: margin,
      y: margin + s + quiet,
      w: w - 2 * margin,
      h: h - 2 * margin - 2 * s - 2 * quiet,
    };
  }

  let mapRect = { ...avail };
  if (mapAspect && mapAspect > 0) {
    if (mapAspect > avail.w / avail.h) {
      mapRect.h = avail.w / mapAspect;
      mapRect.y = avail.y + (avail.h - mapRect.h) / 2;
    } else {
      mapRect.w = avail.h * mapAspect;
      mapRect.x = avail.x + (avail.w - mapRect.w) / 2;
    }
  }

  // hlavička mezi horními značkami
  let header;
  if (markerCount === 8) {
    const tcX = Math.round((w - s) / 2);
    header = {
      x: margin + s + quiet,
      y: margin,
      w: w - 2 * (margin + s + quiet),
      h: s,
      left: { x: margin + s + quiet, y: margin, w: tcX - quiet - (margin + s + quiet), h: s },
      right: { x: tcX + s + quiet, y: margin, w: (w - margin - s - quiet) - (tcX + s + quiet), h: s }
    };
  } else {
    header = { x: margin + s + quiet, y: margin, w: w - 2 * (margin + s + quiet), h: s };
  }

  // kalibrační pole mezi dolními značkami
  const calib = [];
  if (markerCount === 8) {
    const bcX = Math.round((w - s) / 2);
    const leftW = bcX - quiet - (margin + s + quiet);
    const rightW = (w - margin - s - quiet) - (bcX + s + quiet);
    const gap = 2.5;

    // Rozdělíme calibCount mezi levou a pravou část od BC
    const leftCount = Math.ceil(calibCount / 2);
    const rightCount = calibCount - leftCount;
    const maxPerSide = Math.max(leftCount, rightCount, 1);

    // Všechna kalibrační pole mají stejnou jednotnou šířku bw podle strany s více poli
    const bw = (leftW - gap * (maxPerSide - 1)) / maxPerSide;

    // Levá polovina: pole vycentrovaná v prostoru leftW
    const leftSpan = leftCount * bw + (leftCount - 1) * gap;
    const leftX0 = (margin + s + quiet) + (leftW - leftSpan) / 2;
    for (let i = 0; i < leftCount; i++) {
      calib.push({ x: leftX0 + i * (bw + gap), y: h - margin - s, w: bw, h: s });
    }

    // Pravá polovina: pole vycentrovaná v prostoru rightW (stejná šířka bw jako vlevo!)
    if (rightCount > 0) {
      const rightSpan = rightCount * bw + (rightCount - 1) * gap;
      const rightX0 = (bcX + s + quiet) + (rightW - rightSpan) / 2;
      for (let i = 0; i < rightCount; i++) {
        calib.push({ x: rightX0 + i * (bw + gap), y: h - margin - s, w: bw, h: s });
      }
    }
  } else {
    const cx0 = margin + s + quiet, cw = w - 2 * (margin + s + quiet), gap = 3;
    const bw = (cw - gap * (calibCount - 1)) / calibCount;
    for (let i = 0; i < calibCount; i++) calib.push({ x: cx0 + i * (bw + gap), y: h - margin - s, w: bw, h: s });
  }

  return { version: LAYOUT_VERSION, paper, orientation, w, h, margin, markerSize: s, markerCount, markers, avail, mapRect, header, calib };
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
    markerCount: project.markerGrid === 4 ? 4 : 8,
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
