// Vyhodnocení jednoho archu (fotka → narovnání → barevné čáry → porovnání s GPX) a skóre celé hry.
// Čisté JS bez DOM. Podrobnosti bodování viz docs/METRIKY.md, registrace viz docs/REGISTRACE.md.

import { layoutForProject, lookupMarkerId, markerCornersMm, calibSampleRect, foreignTeams } from './layout.js';
import { detectMarkers } from './markers.js';
import { solveHomography, warpSheet, downscale, applyH, fitTPS } from './homography.js';
import { makeGeoref, mapExtentMeters } from './geo.js';
import { estimateWhite, whiteBalance, sampleInk, classifyInks, cleanMask, maskFromLabels } from './color.js';
import { edt } from './edt.js';
import { filterByTime, findGaps, resample, filterJitter, checkCheckpoints } from './gpx.js';

export const DEFAULT_OPTS = {
  ppm: 4,               // px na mm narovnaného archu
  detectMaxDim: 2000,   // delší strana fotky pro detekci značek
  tolM: 50,             // safe pás v metrech terénu (100 % bodů, cca 3,3 mm při 1:15 000)
  maxTolM: 300,         // hranice nulových bodů v metrech (postupný pokles až do ~2 cm při 1:15 000)
  optLineWidthMm: 1.2,  // optimální šířka stopy fixy [mm] (~1 mm; tlustší čára snižuje Precision)
  wrongPenalty: 2.0,    // přísnost penalizace chybného zakreslení / slepého hádání v Precision
  parallelShiftMm: 2.2, // rozšíření safe pásu [mm] za každou souběžnou čáru jiného týmu vedle sebe
  jitterRadiusM: 15,    // poloměr potlačení plavání GPS na místě [m]
  stealthRefTracking: 0, // práh stopování pro odemčení utajení (0 = vypnuto, bez krácení)
  stepM: 5,             // krok převzorkování GPX [m]
  minChroma: 14,        // min. sytost barvy, aby pixel mohl být fixa (šedotónová mapa)
  maxDist: 40,          // max. barevná vzdálenost od kalibrované fixy
  bgMinDiff: 18,        // min. barevná odchylka od referenční barevné mapy (Lab)
  bgRadius: 3,          // poloměr okolí [px] pro porovnání s referenční barevnou mapou
  minArea: 12,          // min. velikost souvislé čáry v px (menší = šum)
  mapInsetMm: 1.2,      // okraj mapového pole, který se ignoruje (rámeček)
  maxGapS: 120,         // výpadek GPX: časová mezera [s]
  maxJumpM: 150,        // výpadek GPX: skok [m]
};

/**
 * Váha bodu podle vzdálenosti d (v libovolných jednotkách):
 * 1 do t, lineárně klesá k 0 v maxT (výchozí 2·t).
 */
export function softWeight(d, t, maxT = 2 * t) {
  if (!(d <= maxT)) return 0;      // zachytí i Infinity/NaN
  if (d <= t) return 1;
  return (maxT - d) / Math.max(1e-9, maxT - t);
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
 * Extrahuje ~1mm středové jádro nakreslené čáry a odhadne její průměrnou šířku v mm.
 * Tlustá čára tak nerozšíří dosah pro Recall a šířka nad optLineWidthMm sníží Precision.
 */
function extractLineCoreAndWidth(drawn, w, h, ppm, optLineWidthMm) {
  let nDrawn = 0;
  const bgMask = new Uint8Array(w * h);
  for (let i = 0; i < drawn.length; i++) {
    if (drawn[i]) nDrawn++;
    else bgMask[i] = 1;
  }
  if (nDrawn === 0) {
    return { coreMask: drawn, avgWidthMm: 0, thicknessFactor: 1 };
  }

  const dEdge = edt(bgMask, w, h);
  const ridgeMask = new Uint8Array(w * h);
  let ridgeCount = 0;
  let widthPxSum = 0;
  let maxWidthPx = 0;

  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rowOff + x;
      if (!drawn[idx]) continue;
      const de = dEdge[idx];
      let maxN = de;
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < h - 1 ? y + 1 : h - 1;
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < w - 1 ? x + 1 : w - 1;
      for (let ny = y0; ny <= y1; ny++) {
        const nRow = ny * w;
        for (let nx = x0; nx <= x1; nx++) {
          const val = dEdge[nRow + nx];
          if (val > maxN) maxN = val;
        }
      }
      if (de >= maxN - 0.6) {
        ridgeMask[idx] = 1;
        ridgeCount++;
        const estW = Math.max(1, 2 * de - 1);
        widthPxSum += estW;
        if (estW > maxWidthPx) maxWidthPx = estW;
      }
    }
  }

  const avgWidthPx = ridgeCount > 0 ? widthPxSum / ridgeCount : 1;
  const avgWidthMm = avgWidthPx / ppm;
  const thicknessFactor = avgWidthMm > optLineWidthMm ? Math.min(1, optLineWidthMm / avgWidthMm) : 1;

  const optRadiusPx = 0.5 * optLineWidthMm * ppm;
  let coreMask;
  if (maxWidthPx <= optLineWidthMm * ppm) {
    coreMask = drawn;
  } else {
    const dRidge = edt(ridgeMask, w, h);
    coreMask = new Uint8Array(w * h);
    for (let i = 0; i < drawn.length; i++) {
      if (drawn[i] && dRidge[i] <= optRadiusPx) coreMask[i] = 1;
    }
  }

  return { coreMask, avgWidthMm, thicknessFactor };
}

/**
 * Porovná nakreslenou masku (v souřadnicích mapového pole, px) s GPX trasou.
 * trackPx = [{x,y,gap}|null] převzorkovaná trasa v px mapového pole. mPerPx = metry terénu na px.
 */
export function compareDrawing(drawn, w, h, trackPx, mPerPx, tolM, opts = {}) {
  const maxTolM = opts.maxTolM ?? (tolM * 6);
  const ppm = opts.ppm ?? DEFAULT_OPTS.ppm;
  const optLineWidthMm = opts.optLineWidthMm ?? DEFAULT_OPTS.optLineWidthMm;
  const wrongPenalty = opts.wrongPenalty ?? DEFAULT_OPTS.wrongPenalty;
  const parallelShiftMm = opts.parallelShiftMm ?? DEFAULT_OPTS.parallelShiftMm;
  const otherDrawnEdts = opts.otherDrawnEdts ?? [];

  const tolPx = tolM / mPerPx;
  const maxTolPx = Math.max(2 * tolPx, maxTolM / mPerPx);
  const shiftPx = parallelShiftMm * ppm;
  const parallelCheckPx = tolPx + 2 * shiftPx;

  // jen body uvnitř mapy a mimo výpadky se hodnotí
  const inside = (p) => p && p.x >= 0 && p.y >= 0 && p.x <= w - 1 && p.y <= h - 1;
  const evalPts = trackPx.filter(p => inside(p) && !p.gap);
  const totalPts = trackPx.filter(p => p && !p.gap).length;
  // trasa pro raster: přerušit ve výpadcích a mimo mapu
  const poly = trackPx.map(p => (p && !p.gap ? p : null));
  const trackMask = rasterizePolyline(poly, w, h);

  // Neutrální koridor přes výpadky GPX (aby poctivě zakreslující tým nebyl trestán za cizí výpadek GPS)
  let DtFull = null;
  if (trackPx.some(p => p && p.gap)) {
    const fullTrackMask = rasterizePolyline(trackPx.filter(Boolean), w, h);
    DtFull = edt(fullTrackMask, w, h);
  }

  const core = opts.precomputedCore || (() => {
    const extracted = extractLineCoreAndWidth(drawn, w, h, ppm, optLineWidthMm);
    return { ...extracted, Dd: edt(extracted.coreMask, w, h) };
  })();
  const { avgWidthMm, thicknessFactor, Dd } = core;
  const Dt = edt(trackMask, w, h);   // vzdálenost ke skutečné trase

  const hasOther = otherDrawnEdts.length > 0;
  const localTols = (idx) => {
    if (!hasOther) return { localTolPx: tolPx, localMaxTolPx: maxTolPx };
    let overlapCount = 0;
    for (let k = 0; k < otherDrawnEdts.length; k++) {
      if (otherDrawnEdts[k][idx] <= parallelCheckPx) overlapCount++;
    }
    const extra = overlapCount * shiftPx;
    return { localTolPx: tolPx + extra, localMaxTolPx: maxTolPx + extra };
  };

  let rSum = 0; const trackErr = [];
  for (const p of evalPts) {
    const X = Math.round(p.x), Y = Math.round(p.y);
    const idx = Y * w + X;
    const d = Dd[idx];
    const { localTolPx, localMaxTolPx } = localTols(idx);
    rSum += softWeight(d, localTolPx, localMaxTolPx);
    if (Number.isFinite(d)) trackErr.push(d * mPerPx);
  }

  let pSum = 0, pDenom = 0, nDrawn = 0; const drawnErr = [];
  for (let i = 0; i < drawn.length; i++) {
    if (!drawn[i]) continue;
    nDrawn++;
    const d = Dt[i];
    const { localTolPx, localMaxTolPx } = localTols(i);
    // Pokud pixel leží v koridoru výpadku GPX soupeře (mimo platné úseky), nepenalizovat
    if (DtFull && d > localTolPx && DtFull[i] <= localTolPx * 1.5) {
      continue;
    }
    const wVal = softWeight(d, localTolPx, localMaxTolPx);
    pSum += wVal;
    pDenom += wVal + wrongPenalty * (1 - wVal);
    if (Number.isFinite(d)) drawnErr.push(d * mPerPx);
  }
  const recall = evalPts.length ? rSum / evalPts.length : 0;
  const rawPrecision = pDenom > 0 ? pSum / pDenom : 0;
  const precision = rawPrecision * thicknessFactor;
  const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  return {
    recall, precision, f1,
    score: Math.round(100 * f1),
    nDrawnPx: nDrawn,
    nTrackPts: evalPts.length,
    trackInMapFrac: totalPts ? evalPts.length / totalPts : 0,
    medianDrawnErrM: median(drawnErr),   // jak daleko jsou nakreslené čáry od skutečné trasy
    medianTrackErrM: median(trackErr),   // jak daleko je skutečná trasa od nejbližší nakreslené čáry
    avgLineWidthMm: avgWidthMm,
    thicknessFactor,
  };
}

/** Připraví GPX trasu týmu: časový filtr, potlačení plavání GPS, výpadky, převzorkování a body průchodu. */
export function prepareTrack(gpx, project, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const g = (project && project.game) || {};
  const rawPts = filterByTime(gpx.points, g.startMs ?? null, g.endMs ?? null);
  const withTime = rawPts.filter(p => p.time != null).length;
  const hasTimestamps = rawPts.length > 0 && withTime > 0;

  let gaps, pts, res, gapS;
  if (hasTimestamps) {
    gaps = findGaps(rawPts, { maxGapS: o.maxGapS, maxJumpM: o.maxJumpM });
    pts = filterJitter(rawPts, { radiusM: o.jitterRadiusM ?? DEFAULT_OPTS.jitterRadiusM });
    res = resample(pts, o.stepM, { maxGapS: o.maxGapS, maxJumpM: o.maxJumpM });
    gapS = gaps.reduce((s, x) => s + (x.gapS != null ? x.gapS : Math.round((x.jumpM || 0) / 1.5)), 0);
  } else {
    // Ručně nakreslená / opravená trasa bez časových značek se vyhodnocuje souvisle bez výpadků
    gaps = [];
    pts = rawPts;
    res = resample(pts, o.stepM, { maxGapS: Infinity, maxJumpM: Infinity });
    gapS = 0;
  }

  const checkpoints = checkCheckpoints(res.length ? res : rawPts, (project && project.checkpoints) || []);
  return { points: pts, rawPoints: rawPts, gaps, gapS, resampled: res, hasTimestamps, checkpoints };
}

/**
 * Celé vyhodnocení jednoho archu.
 * @param {object} a
 * @param {{width,height,data}} a.photo   fotka archu (RGBA)
 * @param {object} a.project              projekt (viz app.js)
 * @param {object} a.tracks               {teamIdx: výsledek prepareTrack} – trasy týmů
 * @param {number} [a.sheetTeam]          vynutit tým archu (jinak podle značek)
 * @param {{width,height,data}} [a.refMap] referenční čistá mapa (RGBA) pro odečtení barevného podkladu
 * @param {object} [a.opts]               přepsání DEFAULT_OPTS
 */
export function evaluateSheet({ photo, project, tracks = {}, sheetTeam = null, refMap = null, opts = {} }) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const layout = layoutForProject(project);
  const georef = georefOf(project);
  const nTeams = project.teams.length;

  // 1) registrace a narovnání
  const reg = registerPhoto(photo, layout, { detectMaxDim: o.detectMaxDim, sheetTeam });
  const warnings = [...reg.warnings];
  if (reg.team >= nTeams) throw new Error(`Arch patří týmu č. ${reg.team + 1}, ale projekt má jen ${nTeams} týmy.`);
  const raw = warpSheet(photo, reg.H, layout.w, layout.h, o.ppm, reg.tps);

  // 2) vyvážení bílé podle papíru (lokální mřížkové proti stínům)
  const toPx = (r) => ({ x: Math.round(r.x * o.ppm), y: Math.round(r.y * o.ppm), w: Math.round(r.w * o.ppm), h: Math.round(r.h * o.ppm) });
  const mapPx = toPx(layout.mapRect);
  const white = estimateWhite(raw, mapPx);
  const rect = whiteBalance(raw, white, { local: true });

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
  const minChroma = opts.minChroma ?? (isColorMap ? 18 : DEFAULT_OPTS.minChroma);
  const maxDist = opts.maxDist ?? (isColorMap ? 36 : DEFAULT_OPTS.maxDist);

  // Varování při málo syté/tmavé fixe v kalibračním poli (oprava B.6)
  for (const x of validInks) {
    if (x.ink.chroma != null && x.ink.chroma < minChroma) {
      const teamName = project.teams[x.team]?.name || `Tým ${x.team + 1}`;
      warnings.push(`Fixa týmu ${teamName} je tmavá nebo málo sytá (chroma ${Math.round(x.ink.chroma)}) – může splývat s mapou.`);
    }
  }

  const useRefMap = Boolean(isColorMap && refMap && refMap.width > 0 && refMap.height > 0);
  if (isColorMap && !useRefMap) {
    warnings.push('Barevná mapa: nepodařilo se načíst referenční podklad mapy pro odečtení barev – barevné prvky mapy se mohou plést s fixou.');
  }

  const classifyOpts = useRefMap
    ? { minChroma, maxDist, refMap, refRect: mapPx, bgMinDiff: o.bgMinDiff, bgRadius: o.bgRadius }
    : { minChroma, maxDist };
  const labels = classifyInks(rect, inner, validInks.map(x => ({ lab: x.ink.lab })), classifyOpts);

  // 5) extrakce masek a porovnání s GPX pro každý cizí tým
  const ext = mapExtentMeters(georef);
  const mPerPx = ext.widthM / mapPx.w;
  const W = mapPx.w, Hh = mapPx.h;
  const optLineWidthMm = o.optLineWidthMm ?? DEFAULT_OPTS.optLineWidthMm;

  const extracted = inks.map(({ team, ink }) => {
    let drawn = new Uint8Array(W * Hh);
    const k = validInks.findIndex(x => x.team === team);
    if (k >= 0) {
      const full = cleanMask(maskFromLabels(labels, k + 1), rect.width, rect.height, { minArea: o.minArea, close: 1 });
      for (let y = 0; y < Hh; y++) {
        const off = (y + mapPx.y) * rect.width + mapPx.x;
        for (let x = 0; x < W; x++) drawn[y * W + x] = full[off + x];
      }
    }
    const core = ink ? extractLineCoreAndWidth(drawn, W, Hh, o.ppm, optLineWidthMm) : null;
    const Dd = core ? edt(core.coreMask, W, Hh) : null;
    return { team, ink, drawn, core: core ? { ...core, Dd } : null };
  });

  const perTeam = extracted.map(item => {
    const { team, ink, drawn, core } = item;
    const out = { team, ink, error: null, skipped: false };
    const tr = tracks[team];
    out.drawn = drawn;
    if (!ink) {
      out.skipped = true;
      out.error = 'Nevyhodnocováno (prázdné kalibrační pole)';
      out.score = null;
      return out;
    }
    if (!tr) { out.error = 'Chybí GPX trasa týmu'; return out; }
    if (tr.gaps && tr.gaps.length > 0) {
      const teamName = project.teams[team]?.name || `Tým ${team + 1}`;
      warnings.push(`V GPX trase týmu ${teamName} byl zjištěn výpadek záznamu (${tr.gaps.length}×, celkem ${Math.max(1, Math.round(tr.gapS / 60))} min) – můžete nahrát ručně opravené GPX.`);
    }
    const trackPx = tr.resampled.map(p => {
      const uv = georef.toUV(p.lat, p.lon);
      return { x: uv.u * W, y: uv.v * Hh, gap: !!p.gap };
    });
    out.trackPx = trackPx;
    const otherDrawnEdts = extracted
      .filter(other => other.team !== team && other.core && other.core.Dd)
      .map(other => other.core.Dd);
    Object.assign(out, compareDrawing(drawn, W, Hh, trackPx, mPerPx, o.tolM, {
      ...o,
      otherDrawnEdts,
      precomputedCore: core,
    }));
    if (out.trackInMapFrac < 0.8) warnings.push(`Trasa týmu ${project.teams[team]?.name || team + 1} je z ${Math.round((1 - out.trackInMapFrac) * 100)} % mimo mapu.`);
    return out;
  });

  return {
    team: reg.team, layout, ppm: o.ppm, registration: reg, white, rect, mapPx, mPerPx,
    usedRefMap: useRefMap, perTeam, warnings,
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
 *  - utajení (0–100): (100 − průměr skóre, se kterým tým zakreslili ostatní) * min(1, tracking / stealthRefTracking)
 *    (podmíněno aktivním stopováním ostatních proti kempování)
 *  - penalizace: za výpadky GPX nad povolený limit (body za minutu); bez GPX → utajení 0
 * Vrací [{team, name, tracking, stealth, rawStealth, gapMin, penalty, total, detail:{[target]: score}}] seřazené podle total.
 */
export function gameScore(project, sheetResults, tracks, { allowedGapMin = 5, penaltyPerMin = 0, stealthRefTracking = DEFAULT_OPTS.stealthRefTracking } = {}) {
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
    const rawStealth = !tr ? 0 : g.length ? Math.round(100 - g.reduce((s, x) => s + x, 0) / g.length) : null;
    const unlock = (stealthRefTracking > 0) ? Math.min(1, r.tracking / stealthRefTracking) : 1;
    r.rawStealth = rawStealth;
    r.stealth = rawStealth == null ? null : Math.round(rawStealth * unlock);
    r.penalty = tr ? Math.max(0, Math.round((tr.gapS / 60 - allowedGapMin) * penaltyPerMin)) : 0;
    r.total = r.tracking + (r.stealth ?? 0) - r.penalty;
  }
  return rows.sort((a, b) => b.total - a.total);
}
