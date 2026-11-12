// js/ui/mapPicker.js
// Výběr výřezu dlaždicové mapy pomocí knihovny Leaflet.

import { latLonToGlobalPx, makeGeoref, mapExtentMeters, snapToStandardScale, STANDARD_SCALES } from '../core/geo.js';

function formatScaleOption(s) {
  const cmM = s / 100;
  const cmText = cmM >= 1000 ? `${(cmM / 1000).toFixed(cmM % 1000 === 0 ? 0 : 1)} km` : `${Math.round(cmM)} m`;
  return `1 : ${s.toLocaleString('cs-CZ')} (1 cm = ${cmText})`;
}

export const TILE_PRESETS = [
  {
    id: 'opentopomap',
    name: 'OpenTopoMap (turistická)',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: 'Kartendaten: © OpenStreetMap-Mitwirkende, SRTM | Kartendarstellung: © OpenTopoMap (CC-BY-SA)',
    subdomains: 'abc',
    maxZoom: 17
  },
  {
    id: 'osm',
    name: 'OpenStreetMap (standard)',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap přispěvatelé',
    subdomains: 'abc',
    maxZoom: 19
  },
  {
    id: 'freemap',
    name: 'Freemap Slovakia (outdoor)',
    url: 'https://outdoor.tiles.freemap.sk/{z}/{x}/{y}',
    attribution: '© OpenStreetMap přispěvatelé, Freemap Slovensko',
    subdomains: 'abc',
    maxZoom: 18
  }
];

/**
 * Otevře a inicializuje interaktivní mapový výběr výřezu v daném kontejneru.
 *
 * @param {HTMLElement} container DOM element pro vykreslení
 * @param {object} opts Konfigurace
 * @param {string} [opts.tileUrl] Výchozí URL šablona dlaždic
 * @param {string} [opts.attribution] Výchozí atribuce mapy
 * @param {number} [opts.aspect=1.4] Poměr stran mapového pole (šířka / výška)
 * @param {number} [opts.printWidthMm=190] Tištěná šířka mapRect v mm pro výpočet měřítka
 * @param {number} [opts.printZoom=15] Výchozí tiskový zoom (13–17)
 * @param {object|Array} [opts.initialCenter] Výchozí střed {lat, lon, zoom} nebo [lat, lon]
 * @param {Function} [opts.onChange] Callback volaný při změně výřezu nebo nastavení
 * @returns {object} API: { getGeoref(z), getTileUrl(), getAttribution(), updateAspect(aspect, printW), destroy() }
 */
export function openMapPicker(container, opts = {}) {
  const L = globalThis.L;
  if (!L) {
    throw new Error('Leaflet není načten v globálním prostoru (window.L).');
  }

  let aspect = opts.aspect && opts.aspect > 0 ? opts.aspect : 1.4;
  let printWidthMm = opts.printWidthMm && opts.printWidthMm > 0 ? opts.printWidthMm : 190;
  let currentPrintZoom = Number(opts.printZoom) || 15;

  // Najít odpovídající preset nebo použít první
  let currentPreset = TILE_PRESETS.find(p => p.url === opts.tileUrl) || TILE_PRESETS[0];
  let currentTileUrl = opts.tileUrl || currentPreset.url;
  let currentAttribution = opts.attribution || currentPreset.attribution;

  // Výchozí souřadnice středu a zoom
  let initLat = 49.8;
  let initLon = 15.4;
  let initZoom = 14;

  if (opts.initialCenter) {
    if (Array.isArray(opts.initialCenter) && opts.initialCenter.length >= 2) {
      initLat = opts.initialCenter[0];
      initLon = opts.initialCenter[1];
    } else if (opts.initialCenter.lat != null && opts.initialCenter.lon != null) {
      initLat = opts.initialCenter.lat;
      initLon = opts.initialCenter.lon;
      if (opts.initialCenter.zoom) initZoom = opts.initialCenter.zoom;
    }
  }

  // Vyčistit kontejner a připravit HTML strukturu
  container.innerHTML = `
    <div class="map-picker-root" style="display:flex; flex-direction:column; width:100%; height:100%; min-height:420px; box-sizing:border-box;">
      <div class="map-picker-toolbar" style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding:8px; background:#f5f6f8; border:1px solid #ddd; border-bottom:none; border-radius:6px 6px 0 0; font-family:-apple-system, BlinkMacSystemFont, sans-serif; font-size:14px;">
        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:10px;">
          <label style="display:flex; align-items:center; gap:6px;">
            <span style="font-weight:600; font-size:13px; color:#333;">Podklad:</span>
            <select class="map-picker-layer-select" style="padding:4px 8px; border:1px solid #bbb; border-radius:4px; background:#fff; font-size:13px;">
              ${TILE_PRESETS.map(p => `<option value="${p.id}" ${p.url === currentTileUrl ? 'selected' : ''}>${p.name}</option>`).join('')}
            </select>
          </label>
          <div style="display:flex; align-items:center; gap:5px; background:#fff; border:1px solid #bbb; border-radius:4px; padding:3px 6px;">
            <span style="font-weight:600; font-size:13px; color:#333;">Měřítko:</span>
            <button type="button" class="btn-scale-step-out" style="width:24px; height:24px; border:1px solid #ccc; border-radius:3px; background:#f4f4f4; cursor:pointer; font-weight:bold; font-size:14px; line-height:1; display:flex; align-items:center; justify-content:center; user-select:none;" title="Zmenšit měřítko / oddálit (např. 1:15 000)">−</button>
            <select class="map-picker-scale-select" style="padding:2px 6px; border:1px solid #bbb; border-radius:3px; background:#fff; font-size:13px; font-weight:600; color:#1a73e8; cursor:pointer;">
              ${STANDARD_SCALES.map(s => `<option value="${s}">${formatScaleOption(s)}</option>`).join('')}
              <option value="custom" disabled hidden>Vlastní měřítko</option>
            </select>
            <button type="button" class="btn-scale-step-in" style="width:24px; height:24px; border:1px solid #ccc; border-radius:3px; background:#f4f4f4; cursor:pointer; font-weight:bold; font-size:14px; line-height:1; display:flex; align-items:center; justify-content:center; user-select:none;" title="Zvětšit měřítko / přiblížit (např. 1:7 500)">+</button>
          </div>
          <label style="display:flex; align-items:center; gap:6px;">
            <span style="font-weight:600; font-size:13px; color:#333;">Tiskový detail:</span>
            <select class="map-picker-zoom-select" style="padding:4px 8px; border:1px solid #bbb; border-radius:4px; background:#fff; font-size:13px;" title="Rozlišení dlaždic pro tisk">
              <option value="auto">Auto (podle zoomu)</option>
              <option value="13" ${currentPrintZoom === 13 ? 'selected' : ''}>13 (velké území)</option>
              <option value="14" ${currentPrintZoom === 14 ? 'selected' : ''}>14</option>
              <option value="15" ${currentPrintZoom === 15 ? 'selected' : ''}>15 (doporučeno)</option>
              <option value="16" ${currentPrintZoom === 16 ? 'selected' : ''}>16 (podrobná)</option>
              <option value="17" ${currentPrintZoom === 17 ? 'selected' : ''}>17 (velký detail)</option>
              <option value="18" ${currentPrintZoom === 18 ? 'selected' : ''}>18 (extra detail)</option>
            </select>
          </label>
        </div>
        <div class="map-picker-info" style="display:flex; align-items:center; gap:8px; font-size:13px; color:#222; font-weight:500;">
          <span class="map-picker-scale" style="background:#e8f0fe; color:#1a73e8; padding:3px 8px; border-radius:4px; font-weight:600;">Měřítko: –</span>
          <span class="map-picker-extent" style="color:#555;">(– km)</span>
        </div>
      </div>
      <div class="map-picker-map-wrap" style="position:relative; flex:1 1 380px; min-height:360px; width:100%; overflow:hidden; border:1px solid #ddd; border-radius:0 0 6px 6px;">
        <div class="map-picker-map" style="position:absolute; left:0; top:0; width:100%; height:100%;"></div>
        <div class="map-picker-overlay" style="position:absolute; pointer-events:none; box-sizing:border-box; border:2.5px solid #1976d2; box-shadow:0 0 0 9999px rgba(0, 0, 0, 0.38); z-index:1000; transition:width 0.15s ease, height 0.15s ease, left 0.15s ease, top 0.15s ease;">
          <div style="position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:18px; height:18px; opacity:0.85;">
            <svg viewBox="0 0 18 18" width="18" height="18">
              <line x1="9" y1="0" x2="9" y2="18" stroke="#1976d2" stroke-width="2"/>
              <line x1="0" y1="9" x2="18" y2="9" stroke="#1976d2" stroke-width="2"/>
            </svg>
          </div>
          <div style="position:absolute; left:4px; top:4px; font-size:11px; font-weight:700; color:#fff; background:rgba(25, 118, 210, 0.85); padding:1px 5px; border-radius:2px; font-family:sans-serif; pointer-events:none;">
            Výřez pro tisk
          </div>
        </div>
      </div>
    </div>
  `;

  const mapWrap = container.querySelector('.map-picker-map-wrap');
  const mapEl = container.querySelector('.map-picker-map');
  const overlayEl = container.querySelector('.map-picker-overlay');
  const layerSelect = container.querySelector('.map-picker-layer-select');
  const zoomSelect = container.querySelector('.map-picker-zoom-select');
  const scaleEl = container.querySelector('.map-picker-scale');
  const extentEl = container.querySelector('.map-picker-extent');
  const scaleSelect = container.querySelector('.map-picker-scale-select');
  const btnScaleStepOut = container.querySelector('.btn-scale-step-out');
  const btnScaleStepIn = container.querySelector('.btn-scale-step-in');

  // Inicializace Leaflet mapy s plynulým zoomováním umožňujícím přesné standardní měřítko
  const map = L.map(mapEl, {
    center: [initLat, initLon],
    zoom: initZoom,
    zoomSnap: 0,               // Plynulý zoom pro přesné nastavení standardních měřítek
    wheelPxPerZoomLevel: 120,  // Plynulejší zoomování kolečkem myši / trackpadem
    zoomControl: true,
    attributionControl: false  // vlastní atribuce v panelu a archu
  });

  let currentTileLayer = null;

  function setLayer(preset) {
    if (currentTileLayer) {
      map.removeLayer(currentTileLayer);
    }
    currentPreset = preset;
    currentTileUrl = preset.url;
    currentAttribution = preset.attribution;
    currentTileLayer = L.tileLayer(preset.url, {
      subdomains: preset.subdomains || 'abc',
      maxZoom: preset.maxZoom || 19,
      crossOrigin: true
    }).addTo(map);
  }

  setLayer(currentPreset);

  // Vypočtené rozměry rámečku
  let box = { left: 0, top: 0, width: 100, height: 100 };

  function updateOverlaySize() {
    const cw = mapWrap.clientWidth || 400;
    const ch = mapWrap.clientHeight || 360;

    let bw = cw * 0.82;
    let bh = bw / aspect;

    if (bh > ch * 0.82) {
      bh = ch * 0.82;
      bw = bh * aspect;
    }

    bw = Math.round(bw);
    bh = Math.round(bh);
    const bLeft = Math.round((cw - bw) / 2);
    const bTop = Math.round((ch - bh) / 2);

    box = { left: bLeft, top: bTop, width: bw, height: bh };

    overlayEl.style.width = `${bw}px`;
    overlayEl.style.height = `${bh}px`;
    overlayEl.style.left = `${bLeft}px`;
    overlayEl.style.top = `${bTop}px`;
  }

  /**
   * Spočítá georeferenci výřezu pro zvolený tiskový zoom.
   */
  function getGeoref(z = currentPrintZoom) {
    let zoomVal;
    if (z === 'auto' || currentPrintZoom === 'auto') {
      zoomVal = Math.max(12, Math.min(18, Math.round(map.getZoom())));
    } else {
      zoomVal = Number(z) || Number(currentPrintZoom) || 15;
    }

    const nw = map.containerPointToLatLng(L.point(box.left, box.top));
    const se = map.containerPointToLatLng(L.point(box.left + box.width, box.top + box.height));

    const p0 = latLonToGlobalPx(nw.lat, nw.lng, zoomVal);
    const p1 = latLonToGlobalPx(se.lat, se.lng, zoomVal);

    const px0 = Math.round(Math.min(p0.x, p1.x));
    const py0 = Math.round(Math.min(p0.y, p1.y));
    const px1 = Math.round(Math.max(p0.x, p1.x));
    const py1 = Math.round(Math.max(p0.y, p1.y));

    return { type: 'tiles', z: zoomVal, px0, py0, px1, py1 };
  }

  // Spočítá zoom úroveň pro přesné cílové měřítko (např. 10 000)
  function zoomForScale(targetScale) {
    const center = map.getCenter();
    const lat = center ? center.lat : initLat;
    const paperM = printWidthMm / 1000;
    // EPSG:3857 konstanta: (2 * PI * 6378137) / 256 = 156543.033928
    const constM = 156543.03392804097;
    const bw = (box && box.width > 0) ? box.width : ((mapWrap.clientWidth || 400) * 0.82);
    const cosLat = Math.cos(lat * (Math.PI / 180));
    const z = Math.log2((bw * constM * cosLat) / (paperM * targetScale));
    return Math.max(1, Math.min(19, z));
  }

  function getCurrentRawScale() {
    const georef = getGeoref(currentPrintZoom);
    try {
      const geo = makeGeoref(georef);
      const extent = mapExtentMeters(geo);
      return (extent.widthM * 1000) / printWidthMm;
    } catch (e) {
      return 10000;
    }
  }

  if (btnScaleStepIn) {
    btnScaleStepIn.addEventListener('click', (e) => {
      e.preventDefault();
      const currentScale = getCurrentRawScale();
      // Krok k většímu detailu (menší číslo měřítka, např. 15 000 -> 10 000)
      const smaller = STANDARD_SCALES.filter(s => s < currentScale - 50);
      const target = smaller.length > 0 ? smaller[smaller.length - 1] : STANDARD_SCALES[0];
      map.setZoom(zoomForScale(target));
    });
  }

  if (btnScaleStepOut) {
    btnScaleStepOut.addEventListener('click', (e) => {
      e.preventDefault();
      const currentScale = getCurrentRawScale();
      // Krok k většímu území (větší číslo měřítka, např. 10 000 -> 15 000)
      const larger = STANDARD_SCALES.filter(s => s > currentScale + 50);
      const target = larger.length > 0 ? larger[0] : STANDARD_SCALES[STANDARD_SCALES.length - 1];
      map.setZoom(zoomForScale(target));
    });
  }

  if (scaleSelect) {
    scaleSelect.addEventListener('change', (e) => {
      const target = Number(e.target.value);
      if (target && target > 0) {
        map.setZoom(zoomForScale(target));
      }
    });
  }

  function updateInfo() {
    const georef = getGeoref(currentPrintZoom);
    try {
      const geo = makeGeoref(georef);
      const extent = mapExtentMeters(geo);
      const rawScale = (extent.widthM * 1000) / printWidthMm;
      const snappedScale = snapToStandardScale(rawScale);

      if (scaleSelect) {
        const isStandard = STANDARD_SCALES.includes(snappedScale) && (Math.abs(rawScale - snappedScale) / snappedScale <= 0.05);
        if (isStandard) {
          scaleSelect.value = String(snappedScale);
        } else {
          let customOpt = scaleSelect.querySelector('option[value="custom"]');
          if (customOpt) {
            customOpt.textContent = `Vlastní (1 : ${snappedScale.toLocaleString('cs-CZ')})`;
            scaleSelect.value = 'custom';
          }
        }
      }

      const cmM = snappedScale / 100;
      const cmText = cmM >= 1000
        ? `${(cmM / 1000).toFixed(cmM % 1000 === 0 ? 0 : 1)} km`
        : `${Math.round(cmM)} m`;

      if (scaleEl) {
        scaleEl.textContent = `Měřítko tisku: 1 : ${snappedScale.toLocaleString('cs-CZ')} (1 cm = ${cmText})`;
      }
      if (extentEl) {
        const wKm = (extent.widthM / 1000).toFixed(1);
        const hKm = (extent.heightM / 1000).toFixed(1);
        extentEl.textContent = `(cca ${wKm} × ${hKm} km v terénu)`;
      }

      if (typeof opts.onChange === 'function') {
        opts.onChange({
          georef,
          tileUrl: currentTileUrl,
          attribution: currentAttribution,
          printZoom: currentPrintZoom,
          scale: snappedScale,
          extent
        });
      }
    } catch (e) {
      // Ignorovat přechodné chyby při výpočtu
    }
  }

  // Obsluha ovládacích prvků
  layerSelect.addEventListener('change', (e) => {
    const preset = TILE_PRESETS.find(p => p.id === e.target.value) || TILE_PRESETS[0];
    setLayer(preset);
    updateInfo();
  });

  zoomSelect.addEventListener('change', (e) => {
    currentPrintZoom = e.target.value === 'auto' ? 'auto' : (Number(e.target.value) || 15);
    updateInfo();
  });

  map.on('move', updateInfo);
  map.on('zoom', updateInfo);

  const resizeObserver = new ResizeObserver(() => {
    map.invalidateSize();
    updateOverlaySize();
    updateInfo();
  });
  resizeObserver.observe(mapWrap);

  // Inicializační layout
  setTimeout(() => {
    map.invalidateSize();
    updateOverlaySize();
    updateInfo();
  }, 100);

  return {
    getGeoref(z) {
      return getGeoref(z != null ? z : currentPrintZoom);
    },
    getTileUrl() {
      return currentTileUrl;
    },
    getAttribution() {
      return currentAttribution;
    },
    getSelectedPreset() {
      return currentPreset;
    },
    setScale(targetScale) {
      if (targetScale && targetScale > 0) {
        map.setZoom(zoomForScale(targetScale));
      }
    },
    updateAspect(newAspect, newPrintWidthMm) {
      if (newAspect && newAspect > 0) aspect = newAspect;
      if (newPrintWidthMm && newPrintWidthMm > 0) printWidthMm = newPrintWidthMm;
      map.invalidateSize();
      updateOverlaySize();
      updateInfo();
    },
    invalidateSize() {
      map.invalidateSize();
      updateOverlaySize();
      updateInfo();
    },
    destroy() {
      resizeObserver.disconnect();
      map.remove();
      container.innerHTML = '';
    }
  };
}
