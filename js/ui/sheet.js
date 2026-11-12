// js/ui/sheet.js
// Vykreslení tištěného archu hry pro jeden tým.
// Všechny rozměry a pozice jsou v milimetrech (mm) podle layoutu.

import { layoutForProject, foreignTeams, calibSampleRect, markerIdsForTeam } from '../core/layout.js';
import { markerSvg } from '../core/markers.js';
import { makeGeoref, mapExtentMeters, snapToStandardScale } from '../core/geo.js';

// Re-export pro vyhodnocovací modul a ostatní UI části
export { foreignTeams };

/**
 * Escapování HTML entit pro bezpečné vložení textů do šablony.
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Dosazení parametrů do šablony URL dlaždice (např. {z}, {x}, {y}, {s}).
 */
function formatTileUrl(template, x, y, z) {
  if (!template) return '';
  const subdomains = ['a', 'b', 'c'];
  const s = subdomains[Math.abs(x + y) % subdomains.length];
  return template
    .replace(/\{s\}/g, s)
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y));
}

/**
 * Výpočet vhodné „zaokrouhlené“ délky měřítka v metrech (1, 2, 5 × 10^k).
 */
function niceBarLength(widthM) {
  const target = Math.max(10, widthM * 0.22);
  const exp = Math.pow(10, Math.floor(Math.log10(target)));
  const frac = target / exp;
  let mult = 1;
  if (frac >= 5) mult = 5;
  else if (frac >= 2) mult = 2;
  else mult = 1;
  return mult * exp;
}

/**
 * Vykreslí HTML jednoho tištěného archu (A4/A3) v mm pro zadaný index týmu.
 * @param {object} project Projekt hry (name, teams, paper, orientation, map, ...)
 * @param {number} teamIdx Index týmu (0..teams.length-1)
 * @returns {string} HTML řetězec archu
 */
export function renderSheetHtml(project, teamIdx) {
  const teams = project.teams || [];
  const team = teams[teamIdx] || { name: `Tým ${teamIdx + 1}`, color: '#000000' };
  const layout = layoutForProject(project);

  // 1. ArUco značky (rohy + volitelně středy hran pro odolnost proti zvlnění)
  const markerIds = markerIdsForTeam(teamIdx, layout.markers.length);
  const markersHtml = layout.markers.map((m, i) => {
    const id = markerIds[i];
    const svg = markerSvg(id, m.size);
    const roleCls = (m.role || m.corner || '').toLowerCase();
    return `<div class="sheet-marker sheet-marker-${roleCls}" style="position:absolute; left:${m.x}mm; top:${m.y}mm; width:${m.size}mm; height:${m.size}mm; line-height:0; pointer-events:none;">${svg}</div>`;
  }).join('\n');

  // 2. Hlavička archu (mezi horními značkami)
  const header = layout.header;
  let headerHtml = '';
  if (header.left && header.right) {
    headerHtml = `
      <div class="sheet-header sheet-header-left" style="position:absolute; left:${header.left.x}mm; top:${header.left.y}mm; width:${header.left.w}mm; height:${header.left.h}mm; display:flex; flex-direction:column; justify-content:center; align-items:flex-start; box-sizing:border-box; padding:0 1.5mm; overflow:hidden; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="font-size:4.2mm; font-weight:700; line-height:1.2; color:#111; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;">
          Arch týmu: <span style="text-decoration:underline; text-underline-offset:0.8mm;">${escapeHtml(team.name)}</span>
        </div>
      </div>
      <div class="sheet-header sheet-header-right" style="position:absolute; left:${header.right.x}mm; top:${header.right.y}mm; width:${header.right.w}mm; height:${header.right.h}mm; display:flex; flex-direction:column; justify-content:center; align-items:flex-end; text-align:right; box-sizing:border-box; padding:0 1.5mm; overflow:hidden; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="font-size:2.3mm; color:#444; line-height:1.2;">
          Zakresluj trasy ostatních týmů. Každý tým jinou barevnou fixou (ne černou/šedou).
        </div>
      </div>`;
  } else {
    headerHtml = `
      <div class="sheet-header" style="position:absolute; left:${header.x}mm; top:${header.y}mm; width:${header.w}mm; height:${header.h}mm; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; box-sizing:border-box; padding:0 2mm; overflow:hidden; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="font-size:4.8mm; font-weight:700; line-height:1.2; color:#111; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;">
          Arch týmu: <span style="text-decoration:underline; text-underline-offset:1mm;">${escapeHtml(team.name)}</span>
        </div>
        <div style="font-size:2.6mm; color:#444; margin-top:0.8mm; line-height:1.2;">
          Zakresluj trasy ostatních týmů. Každý tým jinou barevnou fixou (ne černou/šedou).
        </div>
      </div>`;
  }

  // 3. Mapové pole (šedotónová mapa, měřítko, atribuce)
  const mapRect = layout.mapRect;
  let mapContentHtml = '';
  let scaleBarHtml = '';
  let attributionHtml = '';

  if (project.map && project.map.kind === 'tiles' && project.map.georef) {
    const { z, px0, py0, px1, py1 } = project.map.georef;
    const totalW = px1 - px0;
    const totalH = py1 - py0;

    if (totalW > 0 && totalH > 0) {
      const tileX0 = Math.floor(px0 / 256);
      const tileX1 = Math.floor((px1 - 1) / 256);
      const tileY0 = Math.floor(py0 / 256);
      const tileY1 = Math.floor((py1 - 1) / 256);

      let tiles = '';
      for (let ty = tileY0; ty <= tileY1; ty++) {
        for (let tx = tileX0; tx <= tileX1; tx++) {
          const leftPct = ((tx * 256 - px0) / totalW) * 100;
          const topPct = ((ty * 256 - py0) / totalH) * 100;
          const widthPct = (256 / totalW) * 100;
          const heightPct = (256 / totalH) * 100;
          const url = formatTileUrl(project.map.tileUrl, tx, ty, z);
          tiles += `<img src="${escapeHtml(url)}" alt="" style="position:absolute; left:${leftPct.toFixed(4)}%; top:${topPct.toFixed(4)}%; width:${widthPct.toFixed(4)}%; height:${heightPct.toFixed(4)}%; display:block; pointer-events:none;" crossorigin="anonymous" />`;
        }
      }
      mapContentHtml = tiles;
    }
  } else if (project.map && project.map.kind === 'image' && project.map.imageDataUrl) {
    mapContentHtml = `<img src="${escapeHtml(project.map.imageDataUrl)}" alt="Mapa" style="position:absolute; left:0; top:0; width:100%; height:100%; object-fit:fill; display:block;" />`;
  } else {
    mapContentHtml = `<div style="display:flex; width:100%; height:100%; align-items:center; justify-content:center; color:#888; font-family:sans-serif; font-size:4mm;">(Mapa zatím nebyla nastavena)</div>`;
  }

  // Měřítko mapy (podrobné měřítko s dílky a převodem 1 cm = X m)
  if (project.map && project.map.georef) {
    try {
      const georef = makeGeoref(project.map.georef);
      const extent = mapExtentMeters(georef);
      if (extent.widthM > 0 && mapRect.w > 0) {
        const paperM = mapRect.w / 1000;
        const rawScale = extent.widthM / paperM;
        const scaleNum = snapToStandardScale(rawScale);
        const barM = niceBarLength(scaleNum * paperM);
        const barMm = (barM / scaleNum) * 1000;

        // Poměr pro převod 1 cm na mapě na metry v terénu
        const cmM = scaleNum / 100;
        const cmText = cmM >= 1000
          ? `${(cmM / 1000).toFixed(cmM % 1000 === 0 ? 0 : 1)} km`
          : `${Math.round(cmM)} m`;

        // Počet dílků měřítka (2, 4 nebo 5 podle délky úsečky)
        const exp = Math.pow(10, Math.floor(Math.log10(barM)));
        const frac = Math.round(barM / exp);
        let numDivs = 4;
        if (frac === 5) numDivs = 5;
        else if (frac === 2) numDivs = 4;
        else if (frac === 1) numDivs = (barM >= 100) ? 4 : 2;

        const formatDist = (m) => {
          if (m === 0) return '0';
          if (m >= 1000) {
            const km = m / 1000;
            return `${km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)} km`;
          }
          return `${Math.round(m)} m`;
        };

        const barLabel = formatDist(barM);
        const midLabel = formatDist(barM / 2);
        const scaleText = `1 : ${scaleNum.toLocaleString('cs-CZ')}`;

        // Vykreslení střídavých černých a bílých segmentů
        let barSegmentsHtml = '';
        for (let di = 0; di < numDivs; di++) {
          const isBlack = (di % 2 === 0);
          const isLast = (di === numDivs - 1);
          barSegmentsHtml += `<div style="flex:1; height:100%; background:${isBlack ? '#000000' : '#ffffff'}; ${!isLast ? 'border-right:0.18mm solid #000;' : ''}"></div>`;
        }

        scaleBarHtml = `
          <div class="sheet-scalebar" style="position:absolute; left:2mm; bottom:2mm; background:rgba(255,255,255,0.92); padding:1mm 2mm 0.8mm 2mm; border:0.25mm solid #333; border-radius:0.5mm; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height:1.2; text-align:center; z-index:10; box-shadow:0 0.5mm 1.5mm rgba(0,0,0,0.15);">
            <div style="font-size:2.4mm; font-weight:700; color:#111; margin-bottom:0.4mm;">
              ${scaleText} <span style="font-size:1.8mm; font-weight:600; color:#444; margin-left:1mm;">(1 cm = ${cmText})</span>
            </div>
            <div style="display:flex; justify-content:space-between; width:${barMm.toFixed(2)}mm; font-size:1.8mm; font-weight:600; color:#222; margin-bottom:0.3mm;">
              <span>0</span>
              <span>${midLabel}</span>
              <span>${barLabel}</span>
            </div>
            <div style="display:flex; width:${barMm.toFixed(2)}mm; height:1.2mm; border:0.22mm solid #000; box-sizing:border-box;">
              ${barSegmentsHtml}
            </div>
          </div>`;
      }
    } catch (e) {
      // Georeference není kompletní, měřítko přeskočíme
    }
  }

  // Atribuce mapy
  if (project.map && project.map.attribution) {
    attributionHtml = `
      <div class="sheet-attribution" style="position:absolute; right:2mm; bottom:2mm; background:rgba(255,255,255,0.85); padding:0.6mm 1.4mm; border-radius:0.4mm; font-family:sans-serif; font-size:1.7mm; color:#222; max-width:65%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; z-index:10;">
        ${escapeHtml(project.map.attribution)}
      </div>`;
  }

  const mapPrintMode = project.mapPrintMode || (project.map && project.map.printMode) || 'grayscale';
  let mapFilter = 'filter:grayscale(1) contrast(.85) brightness(1.08);';
  if (mapPrintMode === 'color') {
    mapFilter = 'filter:contrast(.92) brightness(1.02);';
  } else if (mapPrintMode === 'colorFaded') {
    mapFilter = 'filter:saturate(0.60) contrast(.90) brightness(1.08);';
  }

  const mapRectHtml = `
    <div class="sheet-map-box" style="position:absolute; left:${mapRect.x}mm; top:${mapRect.y}mm; width:${mapRect.w}mm; height:${mapRect.h}mm; box-sizing:border-box; border:0.25mm solid #000; overflow:hidden; background:#ffffff;">
      <div class="sheet-map-content sheet-map-mode-${mapPrintMode}" style="position:absolute; left:0; top:0; width:100%; height:100%; ${mapFilter} overflow:hidden;">
        ${mapContentHtml}
      </div>
      ${scaleBarHtml}
      ${attributionHtml}
    </div>`;

  // 4. Kalibrační pole pro cizí týmy (dolní pás)
  const foreignIdxs = foreignTeams(teams.length, teamIdx);
  const calibHtml = foreignIdxs.map((otherIdx, i) => {
    const box = layout.calib[i];
    if (!box) return '';
    const otherTeam = teams[otherIdx] || { name: `Tým ${otherIdx + 1}` };
    const labelH = box.h * 0.32; // podle calibSampleRect

    return `
      <div class="sheet-calib" style="position:absolute; left:${box.x}mm; top:${box.y}mm; width:${box.w}mm; height:${box.h}mm; box-sizing:border-box; border:0.25mm solid #000; background:#ffffff; overflow:hidden; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="height:${labelH}mm; box-sizing:border-box; padding:0.3mm 1mm; font-size:2.2mm; line-height:1.15; font-weight:700; text-align:center; border-bottom:0.18mm solid #bbb; display:flex; align-items:center; justify-content:center; background:#f4f4f4; color:#111; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          Tým ${escapeHtml(otherTeam.name)}: sem tlustě čáru fixou
        </div>
        <div style="height:${(box.h - labelH).toFixed(2)}mm; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:0.5mm 1mm; font-size:1.8mm; color:#888; line-height:1.2; pointer-events:none;">
          <span>(libovolná barevná fixa mimo černou/šedou)</span>
        </div>
      </div>`;
  }).join('\n');

  // Kontejner archu (přesné rozměry v mm, připraveno pro tisk)
  return `
<div class="sheet" style="position:relative; width:${layout.w}mm; height:${layout.h}mm; box-sizing:border-box; background:#ffffff; overflow:hidden; page-break-after:always; break-after:page;">
  ${markersHtml}
  ${headerHtml}
  ${mapRectHtml}
  ${calibHtml}
</div>`.trim();
}
