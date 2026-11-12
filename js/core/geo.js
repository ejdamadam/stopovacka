// Georeference: převod mezi lat/lon (WGS84) a normalizovanými souřadnicemi mapy (u,v ∈ [0,1]).
// Dva typy:
//  - 'tiles'  : mapa složená z dlaždic WebMercator (OpenTopoMap, Freemap, mapy.com…).
//               Přesná, žádné vlícovací body nejsou potřeba.
//               def = { type:'tiles', z, px0, py0, px1, py1 }  (globální pixely na zoomu z)
//  - 'affine' : vlastní obrázek (sken O-mapy, screenshot) + vlícovací body.
//               def = { type:'affine', aspect: W/H, points:[{u,v,lat,lon}] }
//               2 body → podobnost (posun+rotace+měřítko), ≥3 body → afinní transformace (MNČ).
//               Afinní fit se dělá v lokálních metrech, takže pro území do ~20 km je chyba projekce zanedbatelná.

export const EARTH_R = 6371008.8;
const D2R = Math.PI / 180;

// ---------- WebMercator ----------
export function latLonToGlobalPx(lat, lon, z) {
  const n = 256 * Math.pow(2, z);
  const s = Math.sin(lat * D2R);
  return {
    x: ((lon + 180) / 360) * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  };
}

export function globalPxToLatLon(x, y, z) {
  const n = 256 * Math.pow(2, z);
  const lon = (x / n) * 360 - 180;
  const k = Math.PI - (2 * Math.PI * y) / n;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(k) - Math.exp(-k)));
  return { lat, lon };
}

// ---------- lokální metrická projekce (ekvidistantní válcová kolem lat0/lon0) ----------
export function makeLocalProj(lat0, lon0) {
  const c = Math.cos(lat0 * D2R);
  return {
    lat0, lon0,
    // x = východ [m], y = sever [m]
    toXY: (lat, lon) => ({ x: EARTH_R * (lon - lon0) * D2R * c, y: EARTH_R * (lat - lat0) * D2R }),
    toLatLon: (x, y) => ({ lat: lat0 + y / EARTH_R / D2R, lon: lon0 + x / (EARTH_R * c) / D2R }),
  };
}

// ---------- parsování souřadnic ----------
// Podporuje: "48.9512, 19.0712" | "48.9512N, 19.0712E" (formát mapy.com) | "N 48°57.072', E 19°4.272'"
// | "48°57'4.3"N 19°4'16.3"E". Vrací {lat, lon} nebo null.
export function parseLatLon(str) {
  if (!str) return null;
  const s = String(str).trim().replace(/,(?=\d)/g, '.'); // desetinná čárka „48,95“ → „48.95“ jen mezi číslicemi
  const parts = [];
  const re = /([NSEW])?\s*(-?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*['′]?\s*)?(?:(\d+(?:\.\d+)?)\s*["″]?\s*)?([NSEW])?/gi;
  let m;
  while ((m = re.exec(s)) && parts.length < 2) {
    if (m[0].trim() === '') { re.lastIndex++; continue; }
    if (m[2] === undefined) continue;
    let v = Math.abs(parseFloat(m[2])) + (m[3] ? parseFloat(m[3]) / 60 : 0) + (m[4] ? parseFloat(m[4]) / 3600 : 0);
    if (m[2].startsWith('-')) v = -v;
    const hemi = (m[1] || m[5] || '').toUpperCase();
    if (hemi === 'S' || hemi === 'W') v = -Math.abs(v);
    parts.push({ v, hemi });
  }
  if (parts.length < 2) return null;
  let [a, b] = parts;
  // pokud je zadáno E/W první, prohodit
  if (a.hemi === 'E' || a.hemi === 'W' || b.hemi === 'N' || b.hemi === 'S') [a, b] = [b, a];
  const lat = a.v, lon = b.v;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { lat, lon };
}

// ---------- lineární algebra (malé systémy) ----------
// Řeší A x = b (n×n) Gaussovou eliminací s pivotací. A je pole řádků.
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('Singulární soustava');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Afinní fit: hledá [a b c; d e f] tak, že (X,Y) ≈ (a x + b y + c, d x + e y + f). MNČ.
function fitAffine(src, dst) {
  const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
  for (let i = 0; i < src.length; i++) {
    const r = [src[i].x, src[i].y, 1];
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) AtA[j][k] += r[j] * r[k];
      bx[j] += r[j] * dst[i].x; by[j] += r[j] * dst[i].y;
    }
  }
  const [a, b, c] = solveLinear(AtA, bx);
  const [d, e, f] = solveLinear(AtA, by);
  return [a, b, c, d, e, f];
}

// Podobnost ze 2+ bodů: X = s·cos·x − s·sin·y + tx, Y = s·sin·x + s·cos·y + ty  (p = s·cos, q = s·sin)
function fitSimilarity(src, dst) {
  const A = [], bb = [];
  for (let i = 0; i < src.length; i++) {
    A.push([src[i].x, -src[i].y, 1, 0]); bb.push(dst[i].x);
    A.push([src[i].y, src[i].x, 0, 1]); bb.push(dst[i].y);
  }
  const AtA = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], Atb = [0, 0, 0, 0];
  for (let r = 0; r < A.length; r++)
    for (let j = 0; j < 4; j++) { Atb[j] += A[r][j] * bb[r]; for (let k = 0; k < 4; k++) AtA[j][k] += A[r][j] * A[r][k]; }
  const [p, q, tx, ty] = solveLinear(AtA, Atb);
  return [p, -q, tx, q, p, ty];
}

function invAffine([a, b, c, d, e, f]) {
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-15) throw new Error('Degenerovaná transformace');
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}
const applyAff = (T, x, y) => ({ x: T[0] * x + T[1] * y + T[2], y: T[3] * x + T[4] * y + T[5] });

// ---------- hlavní API ----------
// Vrací objekt { toUV(lat,lon), toLatLon(u,v), center:{lat,lon}, proj (lokální metry), rmsM?, residuals? }
export function makeGeoref(def) {
  if (!def) throw new Error('Mapa není georeferencovaná');
  if (def.type === 'tiles') {
    const { z, px0, py0, px1, py1 } = def;
    const w = px1 - px0, h = py1 - py0;
    const toLatLon = (u, v) => globalPxToLatLon(px0 + u * w, py0 + v * h, z);
    const toUV = (lat, lon) => { const p = latLonToGlobalPx(lat, lon, z); return { u: (p.x - px0) / w, v: (p.y - py0) / h }; };
    const center = toLatLon(0.5, 0.5);
    return { type: 'tiles', toUV, toLatLon, center, proj: makeLocalProj(center.lat, center.lon) };
  }
  if (def.type === 'affine') {
    const pts = def.points || [];
    if (pts.length < 2) throw new Error('Potřeba aspoň 2 vlícovací body (lépe 3–5)');
    const aspect = def.aspect || 1;
    const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const lon0 = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
    const proj = makeLocalProj(lat0, lon0);
    // obrazové souřadnice v izotropním prostoru (x = u·aspect, y = v); y metrů míří na sever → otočíme znaménko
    const src = pts.map(p => ({ x: p.u * aspect, y: p.v }));
    const dst = pts.map(p => { const q = proj.toXY(p.lat, p.lon); return { x: q.x, y: -q.y }; });
    const T = pts.length >= 3 ? fitAffine(src, dst) : fitSimilarity(src, dst);
    const Ti = invAffine(T);
    const toLatLon = (u, v) => { const q = applyAff(T, u * aspect, v); return proj.toLatLon(q.x, -q.y); };
    const toUV = (lat, lon) => { const q = proj.toXY(lat, lon); const r = applyAff(Ti, q.x, -q.y); return { u: r.x / aspect, v: r.y }; };
    const residuals = pts.map((p, i) => { const q = applyAff(T, src[i].x, src[i].y); return Math.hypot(q.x - dst[i].x, q.y - dst[i].y); });
    const rmsM = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
    const center = toLatLon(0.5, 0.5);
    return { type: 'affine', toUV, toLatLon, center, proj, residuals, rmsM };
  }
  throw new Error('Neznámý typ georeference: ' + def.type);
}

// Kolik metrů terénu odpovídá rozměru mapového pole (pro měřítko a převod px → m).
export function mapExtentMeters(georef) {
  const d = (a, b) => { const A = georef.proj.toXY(a.lat, a.lon), B = georef.proj.toXY(b.lat, b.lon); return Math.hypot(A.x - B.x, A.y - B.y); };
  return {
    widthM: d(georef.toLatLon(0, 0.5), georef.toLatLon(1, 0.5)),
    heightM: d(georef.toLatLon(0.5, 0), georef.toLatLon(0.5, 1)),
  };
}

// Běžná standardní měřítka v kartografii, turistice a orientačních hrách
export const STANDARD_SCALES = [
  2000, 3000, 4000, 5000, 7500, 10000, 12500, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000
];

/**
 * Zaokrouhlí nebo zarovná libovolné měřítko na „normální“ kartografické číslo.
 * Pokud je měřítko v toleranci (např. 5 %) od některého standardního měřítka, vrátí přesně toto měřítko.
 * Jinak zaokrouhlí na čisté hezké číslo (po 250, 500, 1000 nebo 5000).
 *
 * @param {number} scale Vypočtené měřítko (např. 10012)
 * @param {number} [tolerance=0.05] Relativní tolerance pro přitažení k standardnímu měřítku
 * @returns {number} Čisté standardní nebo zaokrouhlené měřítko (např. 10000)
 */
export function snapToStandardScale(scale, tolerance = 0.05) {
  if (!scale || scale <= 0 || !Number.isFinite(scale)) return 10000;
  for (const s of STANDARD_SCALES) {
    if (Math.abs(scale - s) / s <= tolerance) {
      return s;
    }
  }
  if (scale < 5000) {
    return Math.round(scale / 250) * 250;
  } else if (scale < 20000) {
    return Math.round(scale / 500) * 500;
  } else if (scale < 50000) {
    return Math.round(scale / 1000) * 1000;
  } else {
    return Math.round(scale / 5000) * 5000;
  }
}

