// Homografie (projektivní transformace roviny) a práce s obrázky.
// H je pole 9 čísel (řádkově), mapuje (x,y) → (x',y') = ((h0 x + h1 y + h2)/w, (h3 x + h4 y + h5)/w), w = h6 x + h7 y + h8.

import { solveLinear } from './geo.js';

// Hartleyho normalizace: posun do těžiště a škálování na průměrnou vzdálenost √2 (lepší podmíněnost).
function normalization(pts) {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  const md = pts.reduce((s, p) => s + Math.hypot(p.x - mx, p.y - my), 0) / n || 1;
  const k = Math.SQRT2 / md;
  return { T: [k, 0, -k * mx, 0, k, -k * my, 0, 0, 1], k, mx, my };
}

export function mul3(A, B) {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) throw new Error('Homografie není invertovatelná');
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

/**
 * Odhad homografie src → dst z n ≥ 4 korespondencí (DLT, h8 = 1, metoda nejmenších čtverců
 * na normalizovaných souřadnicích). Vrací {H, rms} – rms = střední reprojekční chyba v jednotkách dst.
 */
export function solveHomography(src, dst) {
  if (src.length < 4 || src.length !== dst.length) throw new Error('Homografie potřebuje ≥ 4 body');
  const ns = normalization(src), nd = normalization(dst);
  const S = src.map(p => ({ x: ns.k * (p.x - ns.mx), y: ns.k * (p.y - ns.my) }));
  const D = dst.map(p => ({ x: nd.k * (p.x - nd.mx), y: nd.k * (p.y - nd.my) }));
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0)), Atb = new Array(8).fill(0);
  const add = (r, b) => { for (let j = 0; j < 8; j++) { Atb[j] += r[j] * b; for (let k = 0; k < 8; k++) AtA[j][k] += r[j] * r[k]; } };
  for (let i = 0; i < S.length; i++) {
    const { x, y } = S[i], u = D[i].x, v = D[i].y;
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  const Hn = [...h, 1];
  // H = Td^-1 · Hn · Ts
  let H = mul3(invert3(nd.T), mul3(Hn, ns.T));
  H = H.map(v => v / H[8]);
  let se = 0;
  for (let i = 0; i < src.length; i++) { const p = applyH(H, src[i].x, src[i].y); se += (p.x - dst[i].x) ** 2 + (p.y - dst[i].y) ** 2; }
  return { H, rms: Math.sqrt(se / src.length) };
}

/**
 * Thin-Plate Spline (TPS) pro nelineární korekci deformace/pomačkání papíru.
 * srcPts = [{x, y}] v sheet mm, dstDiffs = [{dx, dy}] reziduální posuny v photo px.
 * Vrací funkci tps(x, y) -> {dx, dy}.
 */
export function fitTPS(srcPts, dstDiffs, lambda = 1e-3) {
  const n = srcPts.length;
  if (n < 4) return () => ({ dx: 0, dy: 0 });

  const U = (r2) => (r2 <= 1e-9 ? 0 : r2 * Math.log(r2) * 0.5);

  const M = n + 3;
  const A = Array.from({ length: M }, () => new Array(M).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = srcPts[i].x - srcPts[j].x, dy = srcPts[i].y - srcPts[j].y;
      const u = U(dx * dx + dy * dy);
      A[i][j] = u;
      A[j][i] = u;
    }
    A[i][i] = lambda; // Tikhonovova regularizace
    A[i][n] = 1; A[i][n + 1] = srcPts[i].x; A[i][n + 2] = srcPts[i].y;
    A[n][i] = 1; A[n + 1][i] = srcPts[i].x; A[n + 2][i] = srcPts[i].y;
  }

  const bx = new Array(M).fill(0), by = new Array(M).fill(0);
  for (let i = 0; i < n; i++) { bx[i] = dstDiffs[i].dx; by[i] = dstDiffs[i].dy; }

  let wx, wy;
  try {
    wx = solveLinear(A, bx);
    wy = solveLinear(A, by);
  } catch {
    return () => ({ dx: 0, dy: 0 });
  }

  return (x, y) => {
    let dx = wx[n] + wx[n + 1] * x + wx[n + 2] * y;
    let dy = wy[n] + wy[n + 1] * x + wy[n + 2] * y;
    for (let i = 0; i < n; i++) {
      const rx = x - srcPts[i].x, ry = y - srcPts[i].y;
      const u = U(rx * rx + ry * ry);
      dx += wx[i] * u;
      dy += wy[i] * u;
    }
    return { dx, dy };
  };
}

/** Bilineární vzorkování RGBA, výsledek zapisuje do out[o..o+3]. Mimo obrázek → bílá. */
function sampleBilinear(img, x, y, out, o) {
  const { width: W, height: Hh, data } = img;
  if (x < 0 || y < 0 || x > W - 1 || y > Hh - 1) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255; return; }
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, Hh - 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const a = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
    const b = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
    out[o + c] = a + (b - a) * fy;
  }
  out[o + 3] = 255;
}

/**
 * Narovnání archu: pro každý pixel výstupu (rect px) spočítá mm → fotka (přes H: mm → photo px + volitelný TPS posun) a navzorkuje.
 * Vrací obrázek wMm·ppm × hMm·ppm.
 */
export function warpSheet(photo, H_mm2photo, wMm, hMm, ppm = 4, tps = null) {
  const W = Math.round(wMm * ppm), Hh = Math.round(hMm * ppm);
  const data = new Uint8ClampedArray(W * Hh * 4);
  const H = H_mm2photo;

  // Předpočítaná mřížka TPS posunů po 10 mm krocích pro maximální rychlost
  const useTps = typeof tps === 'function';
  let grid = null, gw = 0, gh = 0, gStep = 10;
  if (useTps) {
    gw = Math.ceil(wMm / gStep) + 1;
    gh = Math.ceil(hMm / gStep) + 1;
    grid = new Float32Array(gw * gh * 2);
    for (let gy = 0; gy < gh; gy++) {
      const my = Math.min(hMm, gy * gStep);
      for (let gx = 0; gx < gw; gx++) {
        const mx = Math.min(wMm, gx * gStep);
        const d = tps(mx, my);
        const idx = (gy * gw + gx) * 2;
        grid[idx] = d.dx;
        grid[idx + 1] = d.dy;
      }
    }
  }

  for (let Y = 0; Y < Hh; Y++) {
    const my = (Y + 0.5) / ppm;
    for (let X = 0; X < W; X++) {
      const mx = (X + 0.5) / ppm;
      const w = H[6] * mx + H[7] * my + H[8];
      let px = (H[0] * mx + H[1] * my + H[2]) / w;
      let py = (H[3] * mx + H[4] * my + H[5]) / w;
      if (grid) {
        const gx = Math.min(mx / gStep, gw - 1);
        const gy = Math.min(my / gStep, gh - 1);
        const gx0 = Math.floor(gx), gy0 = Math.floor(gy);
        const gx1 = Math.min(gx0 + 1, gw - 1), gy1 = Math.min(gy0 + 1, gh - 1);
        const fx = gx - gx0, fy = gy - gy0;
        const i00 = (gy0 * gw + gx0) * 2, i10 = (gy0 * gw + gx1) * 2;
        const i01 = (gy1 * gw + gx0) * 2, i11 = (gy1 * gw + gx1) * 2;
        const dx = (grid[i00] * (1 - fx) + grid[i10] * fx) * (1 - fy) + (grid[i01] * (1 - fx) + grid[i11] * fx) * fy;
        const dy = (grid[i00 + 1] * (1 - fx) + grid[i10 + 1] * fx) * (1 - fy) + (grid[i01 + 1] * (1 - fx) + grid[i11 + 1] * fx) * fy;
        px += dx;
        py += dy;
      }
      sampleBilinear(photo, px, py, data, (Y * W + X) * 4);
    }
  }
  return { width: W, height: Hh, data };
}

/** Zmenšení obrázku (průměrování bloků / bilineárně), aby delší strana ≤ maxDim. Vrací {img, scale}. */
export function downscale(img, maxDim) {
  const s = Math.min(1, maxDim / Math.max(img.width, img.height));
  if (s >= 1) return { img, scale: 1 };
  const W = Math.max(1, Math.round(img.width * s)), Hh = Math.max(1, Math.round(img.height * s));
  const data = new Uint8ClampedArray(W * Hh * 4);
  const fx = img.width / W, fy = img.height / Hh, src = img.data, sw = img.width;
  for (let Y = 0; Y < Hh; Y++) {
    const y0 = Math.floor(Y * fy), y1 = Math.max(y0 + 1, Math.floor((Y + 1) * fy));
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor(X * fx), x1 = Math.max(x0 + 1, Math.floor((X + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * sw + x) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; n++; }
      const o = (Y * W + X) * 4; data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n; data[o + 3] = 255;
    }
  }
  return { img: { width: W, height: Hh, data }, scale: W / img.width };
}
