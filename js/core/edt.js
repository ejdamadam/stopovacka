// Přesná euklidovská distanční transformace (EDT) podle Felzenszwalb–Huttenlocher.
// Počítá 2D euklidovskou vzdálenost v čase O(w · h).

/**
 * 1D distanční transformace parabolickým obalem: D(p) = min_q ((p - q)² + f(q)).
 * f: Float64Array délky n (Infinity pro neaktivní pozice)
 * v: Int32Array (pracovní paměť pro vrcholy parabol)
 * z: Float64Array (pracovní paměť pro hranice intervalů, délka n + 1)
 * d: Float64Array (výstupní čtverce vzdáleností délky n)
 */
function edt1d(f, n, v, z, d) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  if (k < 0) {
    for (let q = 0; q < n; q++) d[q] = Infinity;
    return;
  }

  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const dq = q - v[j];
    d[q] = dq * dq + f[v[j]];
  }
}

/**
 * Přesná euklidovská vzdálenost (px) každého pixelu k nejbližšímu pixelu s mask≠0.
 * mask: Uint8Array nebo jiné pole délky w * h (0 = pozadí, ≠0 = popředí).
 * Pokud maska nemá žádný nenulový pixel → všude Infinity.
 * Vrací Float32Array(w * h).
 */
export function edt(mask, w, h) {
  const n = w * h;
  const out = new Float32Array(n);

  let hasForeground = false;
  for (let i = 0; i < n; i++) {
    if (mask[i] !== 0) {
      hasForeground = true;
      break;
    }
  }

  if (!hasForeground) {
    out.fill(Infinity);
    return out;
  }

  const maxDim = Math.max(w, h);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const d1 = new Float64Array(n);

  // 1. průchod podél sloupců
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      f[y] = mask[y * w + x] !== 0 ? 0 : Infinity;
    }
    edt1d(f, h, v, z, d);
    for (let y = 0; y < h; y++) {
      d1[y * w + x] = d[y];
    }
  }

  // 2. průchod podél řádků
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      f[x] = d1[rowOff + x];
    }
    edt1d(f, w, v, z, d);
    for (let x = 0; x < w; x++) {
      out[rowOff + x] = Math.sqrt(d[x]);
    }
  }

  return out;
}
