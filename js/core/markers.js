// ArUco značky – „původní“ ArUco slovník 5×5 (1024 ID), který dekóduje js-aruco (js/vendor/aruco.js).
// Značka = 7×7 buněk: černý okraj 1 buňka + vnitřní 5×5 data. Kolem značky musí být bílá zóna (≥1 buňka).
// Každý řádek dat kóduje 2 bity ID pomocí jednoho ze 4 kódových slov (bity 1 a 3 jsou data, zbytek parita).
// V matici bitů: 1 = BÍLÁ buňka, 0 = černá (stejná konvence jako js-aruco).

const WORDS = [[1, 0, 0, 0, 0], [1, 0, 1, 1, 1], [0, 1, 0, 0, 1], [0, 1, 1, 1, 0]];

/** Vnitřní 5×5 matice bitů pro dané ID (0..1023). */
export function markerBits(id) {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(WORDS[(id >> (8 - 2 * i)) & 3].slice());
  return rows;
}

const rot90 = (m) => m.map((row, i) => row.map((_, j) => m[m.length - j - 1][i]));
const bitsToKey = (m) => m.map(r => r.join('')).join('');

function isValidCode(m) {
  return m.every(row => WORDS.some(w => w.every((b, k) => b === row[k])));
}
function bitsToId(m) {
  let id = 0;
  for (let i = 0; i < 5; i++) { id = (id << 1) | m[i][1]; id = (id << 1) | m[i][3]; }
  return id;
}

/** Je ID jednoznačné při otočení? (žádná rotace o 90/180/270° není jiným platným kódem) */
export function isRotationSafe(id) {
  let m = markerBits(id);
  for (let r = 1; r < 4; r++) { m = rot90(m); if (isValidCode(m)) return false; }
  return true;
}

function hamming(a, b) { let d = 0; for (let i = 0; i < 25; i++) if (a[i] !== b[i]) d++; return d; }

/**
 * Deterministický výběr `count` ID: rotačně bezpečné, bez bílého okraje dat (lepší kontrast)
 * a s minimální Hammingovou vzdáleností `minDist` mezi všemi rotacemi všech vybraných.
 * Výsledek je zapsán natvrdo v layout.js (MARKER_IDS) – tato funkce slouží k jeho ověření v testech.
 */
export function pickMarkerIds(count = 16, minDist = 6, start = 1) {
  const chosen = [], keys = [];
  for (let id = start; id < 1024 && chosen.length < count; id++) {
    if (!isRotationSafe(id)) continue;
    let m = markerBits(id); const rk = [];
    for (let r = 0; r < 4; r++) { rk.push(bitsToKey(m)); m = rot90(m); }
    if (keys.every(k => rk.every(x => hamming(x, k) >= minDist))) { chosen.push(id); keys.push(rk[0]); }
  }
  return chosen;
}

/** SVG značky o velikosti sizeMm (vložit do archu pozicovaného v mm). */
export function markerSvg(id, sizeMm) {
  const bits = markerBits(id);
  let rects = '';
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++)
    if (bits[i][j]) rects += `<rect x="${j + 1}" y="${i + 1}" width="1.02" height="1.02" fill="#fff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" width="${sizeMm}mm" height="${sizeMm}mm" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="7" height="7" fill="#000"/>${rects}</svg>`;
}

/**
 * Detekce značek přes js-aruco (globální AR, CV – načíst js/vendor/cv.js a aruco.js).
 * img = {width,height,data RGBA}. Vrací [{id, corners:[{x,y}×4]}], corners[0] = levý horní roh značky
 * v její kanonické orientaci, dále po směru hodinových ručiček.
 * minPerimeterFrac: minimální délka obrysu jako podíl šířky obrázku (js-aruco má 0.2, my menší → menší značky).
 */
export function detectMarkers(img, { minPerimeterFrac = 0.06 } = {}) {
  const AR = globalThis.AR, CV = globalThis.CV;
  if (!AR || !CV) throw new Error('js-aruco není načteno');
  const det = new AR.Detector();
  CV.grayscale(img, det.grey);
  CV.adaptiveThreshold(det.grey, det.thres, 2, 7);
  det.contours = CV.findContours(det.thres, det.binary);
  let cands = det.findCandidates(det.contours, img.width * minPerimeterFrac, 0.05, 10);
  cands = det.clockwiseCorners(cands);
  cands = det.notTooNear(cands, 10);
  const found = det.findMarkers(det.grey, cands, 49);
  return found.map(m => ({ id: m.id, corners: m.corners.map(c => ({ x: c.x, y: c.y })) }));
}

export { bitsToId as _bitsToId, rot90 as _rot90 };
