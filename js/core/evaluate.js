// Vyhodnocení jednoho archu (fotka → narovnání → barevné čáry → porovnání s GPX) a skóre celé hry.
// Čisté JS bez DOM. Podrobnosti bodování viz docs/METRIKY.md, registrace viz docs/REGISTRACE.md.

import { layoutForProject, lookupMarkerId, markerCornersMm, calibSampleRect, foreignTeams } from './layout.js';
import { detectMarkers } from './markers.js';
import { solveHomography, warpSheet, downscale, applyH, fitTPS } from './homography.js';
import { makeGeoref, mapExtentMeters } from './geo.js';
import { estimateWhite, whiteBalance, sampleInk, classifyInks, cleanMask, maskFromLabels } from './color.js';
import { edt } from './edt.js';
import { filterByTime, findGaps, resample } from './gpx.js';

export const DEFAULT_OPTS = {
  ppm: 4,               // px na mm narovnaného archu
  detectMaxDim: 2000,   // delší strana fotky pro detekci značek
  tolM: 50,             // tolerance v metrech terénu: do tolM plný bod, do 2·tolM lineárně klesá k nule
  stepM: 5,             // krok převzorkování GPX [m]
  minChroma: 14,        // min. sytost barvy, aby pixel mohl být fixa (mapa je šedotónová)
  maxDist: 40,          // max. barevná vzdálenost od kalibrované fixy
  minArea: 12,          // min. velikost souvislé čáry v px (menší = šum)
  mapInsetMm: 1.2,      // okraj mapového pole, který se ignoruje (rámeček)
  maxGapS: 120,         // výpadek GPX: časová mezera [s]
  maxJumpM: 150,        // výpadek GPX: skok [m]
};

/** Váha bodu podle vzdálenosti d (v libovolných jednotkách) a tolerance t: 1 do t, lineárně 0 v 2t. */
export function softWeight(d, t) {
  if (!(d <= 2 * t)) return 0;      // zachytí i Infinity/NaN
  return d <= t ? 1 : 2 - d / t;
}

/** Přepočet projektu na georeferenci (nebo vyhodí srozumitelnou chybu). */
function georefOf(project) {
  if (!project.map || !project.map.georef) throw new Error('Projekt nemá georeferencovanou mapu');
  return makeGeoref(project.map.georef);
}

/**
 * Najde ArUco značky ve fotce a spočítá homografii sheet mm → photo px.
 * Vrací {team, H, rms, markers:[{id, corner, corners}], warnings}.
 */
export function registerPhoto(photo, layout, { detectMaxDim = DEFAULT_OPTS.detectMaxDim, sheetTeam = null } = {}) {
  const warnings = [];
  let found = [];
  // detekce na zmenšené fotce; když nenajdeme všechny 4, zkusíme jiné rozlišení
  for (const dim of [detectMaxDim, 1400, 2800]) {
    const { img, scale } = downscale(photo, dim);
    const ms = detectMarkers(img)
      .map(m => ({ ...m, info: lookupMarkerId(m.id), corners: m.corners.map(c => ({ x: c.x / scale, y: c.y / scale })) }))
      .filter(m => m.info);
    if (ms.length > found.length) found = ms;
    if (found.length >= 4) break;
  }
  if (!found.length) throw new Error('Na fotce nebyla nalezena žádná značka arch. Vyfoť celý arch včetně všech 4 rohových čtverců.');

  // tým archu = nejčastější tým mezi nalezenými značkami (nebo zadaný)
  let team = sheetTeam;
  if (team == null) {
    const cnt = {};
    for (const m of found) cnt[m.info.team] = (cnt[m.info.team] || 0) + 1;
    team = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
  }
  const foreign = found.filter(m => m.info.team !== team);
  if (foreign.length) warnings.push(`Ignoruji ${foreign.length} značk(y) jiného týmu (na fotce je zřejmě i jiný arch).`);
  let ms = found.filter(m => m.info.team === team);
  // každá pozice nejvýš jednou
  const seen = new Set();
  ms = ms.filter(m => {
    const key = m.info.role || m.info.corner;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  if (ms.length < 2) throw new Error(`Nalezena jen ${ms.length} značka týmu – potřeba aspoň 2 (ideálně 4–8).`);
  if (ms.length < 4) warnings.push(`Nalezeny jen ${ms.length} značky – narovnání může být méně přesné.`);

  const src = [], dst = [];
  for (const m of ms) {
    const targetMarker = layout.markers.find(x => x.role === m.info.role) || (m.info.corner != null ? layout.markers[m.info.corner] : null);
    if (!targetMarker) continue;
    const mm = markerCornersMm(targetMarker);
    for (let k = 0; k < 4; k++) { src.push(mm[k]); dst.push(m.corners[k]); }
  }
  const { H, rms } = solveHomography(src, dst);

  // Nelineární korekce pomačkání/zvlnění papíru (TPS) při dostatečném počtu značek (>= 5 značek)
  let tps = null;
  if (ms.length >= 5) {
    const diffs = dst.map((d, i) => {
      const p = applyH(H, src[i].x, src[i].y);
      return { dx: d.x - p.x, dy: d.y - p.y };
    });
    tps = fitTPS(src, diffs);
  }

  // přibližné měřítko fotky (px/mm) pro převod chyby na mm
  const a = applyH(H, 0, 0), b = applyH(H, layout.w, 0);
  const pxPerMm = Math.hypot(b.x - a.x, b.y - a.y) / layout.w;
  const rmsMm = rms / pxPerMm;
  if (rmsMm > 1.8 && !tps) warnings.push(`Vyšší chyba registrace (${rmsMm.toFixed(1)} mm) – arch je asi zvlněný nebo fotka pod velkým úhlem.`);
  return { team, H, tps, rms, rmsMm, pxPerMm, markers: ms.map(m => ({ id: m.id, role: m.info.role, corner: m.info.corner, corners: m.corners })), warnings };
}

/** Rasterizace lomené čáry (pole {x,y} v px, null = přerušení) do binární masky w×h. */
function rasterizePolyline(pts, w, h) {
  const mask = new Uint8Array(w * h);
  const plot = (x, y) => { const X = Math.round(x), Y = Math.round(y); if (X >= 0 && Y >= 0 && X < w && Y < h) mask[Y * w + X] = 1; };
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    if (!p || !q) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) * 2));
    for (let k = 0; k <= n; k++) plot(p.x + (q.x - p.x) * k / n, p.y + (q.y - p.y) * k / n);
  }
  if (pts.length === 1 && pts[0]) plot(pts[0].x, pts[0].y);
  return mask;
}

function median(arr) {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Porovná nakreslenou masku (v souřadnicích mapového pole, px) s GPX trasou.
 * trackPx = [{x,y,gap}|null] převzorkovaná trasa v px mapového pole. mPerPx = metry terénu na px.
 */
export function compareDrawing(drawn, w, h, trackPx, mPerPx, tolM) {
  const tolPx = tolM / mPerPx;
  // jen body uvnitř mapy a mimo výpadky se hodnotí
  const inside = (p) => p && p.x >= 0 && p.y >= 0 && p.x <= w - 1 && p.y <= h - 1;
  const evalPts = trackPx.filter(p => inside(p) && !p.gap);
  const totalPts = trackPx.filter(p => p && !p.gap).length;
  // trasa pro raster: přerušit ve výpadcích a mimo mapu
  const poly = trackPx.map(p => (p && !p.gap ? p : null));
  const trackMask = rasterizePolyline(poly, w, h);

  const Dd = edt(drawn, w, h);       // vzdálenost k nakreslené čáře
  const Dt = edt(trackMask, w, h);   // vzdálenost ke skutečné trase

  let rSum = 0; const trackErr = [];
  for (const p of evalPts) {
    const X = Math.round(p.x), Y = Math.round(p.y);
    const d = Dd[Y * w + X];
    rSum += softWeight(d, tolPx);
    if (Number.isFinite(d)) trackErr.push(d * mPerPx);
  }
  let pSum = 0, nDrawn = 0; const drawnErr = [];
  for (let i = 0; i < drawn.length; i++) {
    if (!drawn[i]) continue;
    nDrawn++;
    const d = Dt[i];
    pSum += softWeight(d, tolPx);
    if (Number.isFinite(d)) drawnErr.push(d * mPerPx);
  }
  const recall = evalPts.length ? rSum / evalPts.length : 0;
  const precision = nDrawn ? pSum / nDrawn : 0;
  const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  return {
    recall, precision, f1,
    score: Math.round(100 * f1),
    nDrawnPx: nDrawn,
    nTrackPts: evalPts.length,
    trackInMapFrac: totalPts ? evalPts.length / totalPts : 0,
    medianDrawnErrM: median(drawnErr),   // jak daleko jsou nakreslené čáry od skutečné trasy
    medianTrackErrM: median(trackErr),   // jak daleko je skutečná trasa od nejbližší nakreslené čáry
  };
}

/** Připraví GPX trasu týmu: časový filtr, výpadky, převzorkování. */
export function prepareTrack(gpx, project, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const g = project.game || {};
  const pts = filterByTime(gpx.points, g.startMs ?? null, g.endMs ?? null);
  const gaps = findGaps(pts, { maxGapS: o.maxGapS, maxJumpM: o.maxJumpM });
  const res = resample(pts, o.stepM, { maxGapS: o.maxGapS, maxJumpM: o.maxJumpM });
  const gapS = gaps.reduce((s, x) => s + (x.gapS || 0), 0);
  return { points: pts, gaps, gapS, resampled: res };
}

/**
 * Celé vyhodnocení jednoho archu.
 * @param {object} a
 * @param {{width,height,data}} a.photo   fotka archu (RGBA)
 * @param {object} a.project              projekt (viz app.js)
 * @param {object} a.tracks               {teamIdx: výsledek prepareTrack} – trasy týmů
 * @param {number} [a.sheetTeam]          vynutit tým archu (jinak podle značek)
 * @param {object} [a.opts]               přepsání DEFAULT_OPTS
 */
export function evaluateSheet({ photo, project, tracks = {}, sheetTeam = null, opts = {} }) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const layout = layoutForProject(project);
  const georef = georefOf(project);
  const nTeams = project.teams.length;

  // 1) registrace a narovnání
  const reg = registerPhoto(photo, layout, { detectMaxDim: o.detectMaxDim, sheetTeam });
  const warnings = [...reg.warnings];
  if (reg.team >= nTeams) throw new Error(`Arch patří týmu č. ${reg.team + 1}, ale projekt má jen ${nTeams} týmy.`);
  const raw = warpSheet(photo, reg.H, layout.w, layout.h, o.ppm, reg.tps);

  // 2) vyvážení bílé podle papíru v mapovém poli
  const toPx = (r) => ({ x: Math.round(r.x * o.ppm), y: Math.round(r.y * o.ppm), w: Math.round(r.w * o.ppm), h: Math.round(r.h * o.ppm) });
  const mapPx = toPx(layout.mapRect);
  const white = estimateWhite(raw, mapPx);
  const rect = whiteBalance(raw, white);

  // 3) kalibrace fix z kalibračních polí (pořadí = cizí týmy vzestupně)
  const foreign = foreignTeams(nTeams, reg.team);
  const inks = foreign.map((t, i) => {
    const ink = layout.calib[i] ? sampleInk(rect, toPx(calibSampleRect(layout.calib[i]))) : null;
    const teamName = project.teams[t]?.name || `Tým ${t + 1}`;
    if (!ink) {
      warnings.push(`Kalibrační pole týmu ${teamName} je prázdné – tým není na tomto archu vyhodnocován.`);
    }
    return { team: t, ink };
  });
  const validInks = inks.filter(x => x.ink);
  // varování, když jsou si dvě fixy moc podobné
  for (let i = 0; i < validInks.length; i++) for (let j = i + 1; j < validInks.length; j++) {
    const A = validInks[i].ink.lab, B = validInks[j].ink.lab;
    const d = Math.hypot((A[0] - B[0]) * 0.5, A[1] - B[1], A[2] - B[2]);
    if (d < 20) warnings.push(`Fixy pro týmy ${project.teams[validInks[i].team]?.name || validInks[i].team + 1} a ${project.teams[validInks[j].team]?.name || validInks[j].team + 1} mají velmi podobnou barvu – mohou se plést.`);
  }

  // 4) klasifikace pixelů v mapovém poli (bez okraje s rámečkem)
  const inset = Math.round(o.mapInsetMm * o.ppm);
  const inner = { x: mapPx.x + inset, y: mapPx.y + inset, w: mapPx.w - 2 * inset, h: mapPx.h - 2 * inset };
  const isColorMap = project.mapPrintMode === 'color' || project.mapPrintMode === 'colorFaded';
  const minChroma = o.minChroma ?? (isColorMap ? 18 : DEFAULT_OPTS.minChroma);
  const maxDist = o.maxDist ?? (isColorMap ? 36 : DEFAULT_OPTS.maxDist);
  const labels = classifyInks(rect, inner, validInks.map(x => ({ lab: x.ink.lab })), { minChroma, maxDist });

  // 5) porovnání s GPX pro každý cizí tým
  const ext = mapExtentMeters(georef);
  const mPerPx = ext.widthM / mapPx.w;
  const W = mapPx.w, Hh = mapPx.h;
  const perTeam = inks.map(({ team, ink }) => {
    const out = { team, ink, error: null, skipped: false };
    const tr = tracks[team];
    // maska čar v souřadnicích mapového pole
    let drawn = new Uint8Array(W * Hh);
    const k = validInks.findIndex(x => x.team === team);
    if (k >= 0) {
      const full = cleanMask(maskFromLabels(labels, k + 1), rect.width, rect.height, { minArea: o.minArea, close: 1 });
      for (let y = 0; y < Hh; y++) {
        const off = (y + mapPx.y) * rect.width + mapPx.x;
        for (let x = 0; x < W; x++) drawn[y * W + x] = full[off + x];
      }
    }
    out.drawn = drawn;
    if (!ink) {
      out.skipped = true;
      out.error = 'Nevyhodnocováno (prázdné kalibrační pole)';
      out.score = null;
      return out;
    }
    if (!tr) { out.error = 'Chybí GPX trasa týmu'; return out; }
    const trackPx = tr.resampled.map(p => {
      const uv = georef.toUV(p.lat, p.lon);
      return { x: uv.u * W, y: uv.v * Hh, gap: !!p.gap };
    });
    out.trackPx = trackPx;
    Object.assign(out, compareDrawing(drawn, W, Hh, trackPx, mPerPx, o.tolM));
    if (out.trackInMapFrac < 0.8) warnings.push(`Trasa týmu ${project.teams[team]?.name || team + 1} je z ${Math.round((1 - out.trackInMapFrac) * 100)} % mimo mapu.`);
    return out;
  });

  return {
    team: reg.team, layout, ppm: o.ppm, registration: reg, white, rect, mapPx, mPerPx,
    perTeam, warnings,
  };
}

/** Převod hex barvy „#rrggbb“ na [r,g,b]. */
function hexRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 0, 255];
}

/**
 * Obrázek pro kontrolu: narovnaný arch se zesvětleným podkladem, rozpoznané čáry v barvě fixy
 * a skutečné GPX trasy (tenká čára v barvě týmu s tmavým lemem). onlyTeam = index týmu nebo null (všechny).
 */
export function renderOverlay(result, project, { onlyTeam = null, fade = 0.6 } = {}) {
  const { rect, mapPx } = result;
  const W = rect.width, Hh = rect.height;
  const data = new Uint8ClampedArray(rect.data.length);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rect.data[i] + (255 - rect.data[i]) * fade;
    data[i + 1] = rect.data[i + 1] + (255 - rect.data[i + 1]) * fade;
    data[i + 2] = rect.data[i + 2] + (255 - rect.data[i + 2]) * fade;
    data[i + 3] = 255;
  }
  const put = (x, y, c) => {
    const X = Math.round(x), Y = Math.round(y);
    if (X < 0 || Y < 0 || X >= W || Y >= Hh) return;
    const o = (Y * W + X) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
  };
  const teams = result.perTeam.filter(p => (onlyTeam == null || p.team === onlyTeam) && !p.skipped && p.ink);
  // nakreslené čáry
  for (const p of teams) {
    const c = p.ink ? p.ink.rgb : [255, 0, 255];
    const w = mapPx.w;
    for (let i = 0; i < p.drawn.length; i++) if (p.drawn[i]) put(mapPx.x + (i % w), mapPx.y + Math.floor(i / w), c);
  }
  // GPX trasy (lem 3×3 tmavý, střed v barvě týmu)
  for (const pass of [0, 1]) {
    for (const p of teams) {
      if (!p.trackPx) continue;
      const c = pass ? hexRgb(project.teams[p.team].color) : [30, 30, 30];
      for (let i = 1; i < p.trackPx.length; i++) {
        const a = p.trackPx[i - 1], b = p.trackPx[i];
        if (a.gap || b.gap) continue;
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
        for (let k = 0; k <= n; k++) {
          const x = mapPx.x + a.x + (b.x - a.x) * k / n, y = mapPx.y + a.y + (b.y - a.y) * k / n;
          if (x < mapPx.x || y < mapPx.y || x > mapPx.x + mapPx.w || y > mapPx.y + mapPx.h) continue;
          if (pass) put(x, y, c);
          else for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(x + dx, y + dy, c);
        }
      }
    }
  }
  return { width: W, height: Hh, data };
}

/**
 * Skóre hry. sheetResults = {teamIdx: výsledek evaluateSheet}, tracks = {teamIdx: prepareTrack}.
 *  - stopování (0–100): průměr skóre archu týmu přes vyhodnocované cizí týmy (nevyplněné kalibrační pole se nepočítá)
 *  - utajení (0–100): 100 − průměr skóre, se kterým tým zakreslili ostatní (nevyhodnocované archy se nepočítají)
 *  - penalizace: za výpadky GPX nad povolený limit (body za minutu); bez GPX → utajení 0
 * Vrací [{team, name, tracking, stealth, gapMin, penalty, total, detail:{[target]: score}}] seřazené podle total.
 */
export function gameScore(project, sheetResults, tracks, { allowedGapMin = 5, penaltyPerMin = 2 } = {}) {
  const n = project.teams.length;
  const got = Array.from({ length: n }, () => []);   // got[j] = skóre, jak dobře ostatní stopovali j
  const rows = project.teams.map((t, i) => {
    const res = sheetResults[i];
    const detail = {};
    let sum = 0;
    let evaluatedCount = 0;
    for (const j of foreignTeams(n, i)) {
      const p = res && res.perTeam.find(x => x.team === j);
      if (p && p.skipped) {
        detail[j] = null; // Tento tým nebyl na archu stopován / chybí značka v kalibračním poli
      } else if (p && Number.isFinite(p.score)) {
        detail[j] = p.score;
        sum += p.score;
        evaluatedCount++;
        got[j].push(p.score);
      } else if (res) {
        detail[j] = 0;
        sum += 0;
        evaluatedCount++;
        got[j].push(0);
      } else {
        detail[j] = null;
      }
    }
    const tracking = evaluatedCount > 0 ? Math.round(sum / evaluatedCount) : 0;
    return { team: i, name: t.name, tracking, detail, evaluatedCount };
  });
  for (const r of rows) {
    const tr = tracks[r.team];
    const g = got[r.team];
    r.gapMin = tr ? Math.round(tr.gapS / 60) : null;
    r.stealth = !tr ? 0 : g.length ? Math.round(100 - g.reduce((s, x) => s + x, 0) / g.length) : null;
    r.penalty = tr ? Math.max(0, Math.round((tr.gapS / 60 - allowedGapMin) * penaltyPerMin)) : 0;
    r.total = r.tracking + (r.stealth ?? 0) - r.penalty;
  }
  return rows.sort((a, b) => b.total - a.total);
}
