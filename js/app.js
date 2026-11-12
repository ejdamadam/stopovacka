// js/app.js
// Hlavní kontrolér webové aplikace Stopovačka (ES moduly, bez build kroku)

import { layoutForProject } from './core/layout.js';
import { makeGeoref, parseLatLon } from './core/geo.js';
import { renderSheetHtml, renderMapToCanvas } from './ui/sheet.js';
import { openMapPicker } from './ui/mapPicker.js';

const STORAGE_KEY = 'stopovacka.project.v1';

/**
 * Výchozí struktura projektu
 */
function createDefaultProject() {
  return {
    version: 1,
    name: 'Jarní stopovačka 2026',
    teams: [
      { name: 'Tým 1', color: '#e53935' },
      { name: 'Tým 2', color: '#1e88e5' },
      { name: 'Tým 3', color: '#43a047' },
      { name: 'Tým 4', color: '#e67e22' }
    ],
    paper: 'A4',
    orientation: 'portrait',
    mapPrintMode: 'grayscale',
    markerGrid: 8,
    map: null,
    game: {
      startMs: null,
      endMs: null
    },
    gpx: {}
  };
}

let project = loadProject();

export function getProject() {
  return project;
}

export function saveProject(p) {
  if (p) project = p;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    return true;
  } catch (err) {
    if (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014) {
      alert('Chyba: Nedostatek místa v paměti prohlížeče (localStorage). Obrázek mapy nebo soubory GPX jsou příliš velké. Zkuste menší obrázek nebo použijte dlaždicovou mapu.');
    } else {
      alert('Chyba při ukládání: ' + err.message);
    }
    console.error('saveProject quota error:', err);
    return false;
  }
}

// Zpřístupnění pro konzoli i jiné skripty
globalThis.Stopovacka = { getProject, saveProject, exportProjectFile, importProjectFile, newProjectPrompt };

function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.version === 1) {
        return data;
      }
    }
  } catch (e) {
    console.warn('Nelze načíst projekt z localStorage:', e);
  }
  return createDefaultProject();
}

/**
 * Pomocné funkce pro datum a čas v lokálním formátu
 */
function msToDatetimeLocal(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datetimeLocalToMs(str) {
  if (!str) return null;
  const t = new Date(str).getTime();
  return isNaN(t) ? null : t;
}

/**
 * Zmenšení obrázku mapy před uložením do paměti (max 2400 px, JPEG 0.85)
 */
function resizeImageFile(file, maxDim = 2400, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Chyba při čtení souboru'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Chyba při dekódování obrázku'));
      img.onload = () => {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({ dataUrl, width: w, height: h, aspect: w / h });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// -------------------------------------------------------------
// Inicializace UI po načtení DOM
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initOfflineSupport();
  initTabs();
  initStep1Project();
  initStep2Map();
  initStep3Print();
  initStep4Game();
  initStep5Evaluate();
});

function initOfflineSupport() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => {
        console.log('Stopovačka Service Worker aktivní:', reg.scope);
      })
      .catch((err) => {
        console.warn('Registrace Service Workeru selhala:', err);
      });
  }

  const badge = document.getElementById('project-status-badge');
  const updateBadge = () => {
    if (!badge) return;
    if (navigator.onLine) {
      badge.textContent = '🟢 Online';
      badge.title = 'Aplikace je připojena k síti a uložena v offline mezipaměti.';
    } else {
      badge.textContent = '✈️ Offline';
      badge.title = 'Běží v offline režimu – vyhodnocení archů a analýza funguje bez internetu.';
    }
  };
  window.addEventListener('online', updateBadge);
  window.addEventListener('offline', updateBadge);
  updateBadge();
}

// -------------------------------------------------------------
// Přepínání záložek
// -------------------------------------------------------------
let activeTabId = 'tab-project';

function initTabs() {
  const tabBtns = document.querySelectorAll('.nav-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });
}

function switchTab(tabId) {
  activeTabId = tabId;
  document.querySelectorAll('.nav-tab-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === tabId);
  });

  if (tabId === 'tab-map') {
    if (mapPickerInstance) {
      const layout = layoutForProject(project);
      const aspect = layout.avail.w / layout.avail.h;
      mapPickerInstance.updateAspect(aspect, layout.mapRect.w);
      setTimeout(() => {
        if (mapPickerInstance && typeof mapPickerInstance.invalidateSize === 'function') {
          mapPickerInstance.invalidateSize();
        }
      }, 50);
    }
  } else if (tabId === 'tab-print') {
    updatePrintPreview();
  }
}

// -------------------------------------------------------------
// 1. ZÁLOŽKA: PROJEKT
// -------------------------------------------------------------
function initStep1Project() {
  const nameInput = document.getElementById('project-name');
  const paperSelect = document.getElementById('paper-format');
  const orientSelect = document.getElementById('paper-orientation');
  const mapPrintModeSelect = document.getElementById('map-print-mode');
  const markerGridSelect = document.getElementById('marker-grid');
  const teamsContainer = document.getElementById('teams-container');

  if (nameInput) {
    nameInput.value = project.name || '';
    nameInput.oninput = () => {
      project.name = nameInput.value.trim() || 'Stopovačka';
      saveProject(project);
    };
  }

  if (paperSelect) {
    paperSelect.value = project.paper || 'A4';
    paperSelect.onchange = () => {
      project.paper = paperSelect.value;
      if (project.map) delete project.map.renderedDataUrl;
      saveProject(project);
      syncLayoutChanges();
    };
  }

  if (orientSelect) {
    orientSelect.value = project.orientation || 'portrait';
    orientSelect.onchange = () => {
      project.orientation = orientSelect.value;
      if (project.map) delete project.map.renderedDataUrl;
      saveProject(project);
      syncLayoutChanges();
    };
  }

  if (mapPrintModeSelect) {
    mapPrintModeSelect.value = project.mapPrintMode || 'grayscale';
    mapPrintModeSelect.onchange = () => {
      project.mapPrintMode = mapPrintModeSelect.value;
      if (project.map) delete project.map.renderedDataUrl;
      saveProject(project);
      syncLayoutChanges();
    };
  }

  if (markerGridSelect) {
    markerGridSelect.value = String(project.markerGrid || 8);
    markerGridSelect.onchange = () => {
      project.markerGrid = parseInt(markerGridSelect.value, 10);
      saveProject(project);
      syncLayoutChanges();
    };
  }

  renderTeamsList(teamsContainer);
  initProjectFileActions();
}

let fileActionsInitialized = false;
function initProjectFileActions() {
  if (fileActionsInitialized) return;
  fileActionsInitialized = true;

  const btnExport = document.getElementById('btn-export-project');
  const btnExportHdr = document.getElementById('btn-export-project-hdr');
  if (btnExport) btnExport.addEventListener('click', exportProjectFile);
  if (btnExportHdr) btnExportHdr.addEventListener('click', exportProjectFile);

  const fileInput = document.getElementById('file-import-project');
  const fileInputHdr = document.getElementById('file-import-project-hdr');
  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      importProjectFile(file);
      e.target.value = '';
    }
  };
  if (fileInput) fileInput.addEventListener('change', handleFileChange);
  if (fileInputHdr) fileInputHdr.addEventListener('change', handleFileChange);

  const btnNew = document.getElementById('btn-new-project');
  if (btnNew) btnNew.addEventListener('click', newProjectPrompt);
}

export function exportProjectFile() {
  const jsonStr = JSON.stringify(project, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = (project.name || 'stopovacka').replace(/[^a-zA-Z0-9_\u00C0-\u017F-]+/g, '_').toLowerCase();
  a.download = `${safeName}_${dateStr}.stopovacka.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

export function importProjectFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => alert('Chyba při čtení souboru projektu.');
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || typeof data !== 'object') throw new Error('Neplatný formát souboru.');
      if (!Array.isArray(data.teams) || data.teams.length < 2) throw new Error('Projekt neobsahuje platný seznam týmů.');
      project = data;
      saveProject(project);
      refreshAllUI();
      alert(`Projekt „${project.name}“ byl úspěšně načten!`);
    } catch (err) {
      alert('Chyba při načítání projektu: ' + err.message);
    }
  };
  reader.readAsText(file);
}

export function newProjectPrompt() {
  if (confirm('Opravdu chcete vytvořit nový projekt? Aktuální data budou nahrazena výchozí šablonou (pokud chcete stávající data uchovat, nejdříve si je stáhněte přes „Uložit projekt“).')) {
    project = createDefaultProject();
    saveProject(project);
    refreshAllUI();
  }
}

function refreshAllUI() {
  initStep1Project();
  initStep2Map();
  updatePrintPreview();
  initStep4Game();
  initStep5Evaluate();
}

function renderTeamsList(container) {
  if (!container) return;
  container.innerHTML = '';

  project.teams.forEach((team, idx) => {
    const row = document.createElement('div');
    row.className = 'team-row';

    const badge = document.createElement('div');
    badge.className = 'team-badge';
    badge.style.backgroundColor = team.color;
    badge.textContent = String(idx + 1);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-control team-name-input';
    nameInput.value = team.name;
    nameInput.placeholder = `Tým ${idx + 1}`;
    nameInput.addEventListener('input', () => {
      team.name = nameInput.value.trim() || `Tým ${idx + 1}`;
      saveProject(project);
      updatePrintTeamTabs();
    });

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'team-color-picker';
    colorInput.value = team.color;
    colorInput.title = 'Orientační barva v grafech (fixy v terénu mohou mít libovolnou jinou barvu)';
    colorInput.addEventListener('input', () => {
      team.color = colorInput.value;
      badge.style.backgroundColor = team.color;
      saveProject(project);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-ghost btn-sm';
    deleteBtn.style.padding = '4px 8px';
    deleteBtn.style.color = 'var(--danger, #dc2626)';
    deleteBtn.innerHTML = '🗑️';
    deleteBtn.title = 'Odebrat tým';
    if (project.teams.length <= 2) {
      deleteBtn.disabled = true;
      deleteBtn.style.opacity = '0.25';
      deleteBtn.style.cursor = 'not-allowed';
      deleteBtn.title = 'Hra vyžaduje minimálně 2 týmy';
    } else {
      deleteBtn.addEventListener('click', () => {
        if (project.teams.length <= 2) return;
        const name = team.name || `Tým ${idx + 1}`;
        if (confirm(`Opravdu chcete odebrat ${name}?`)) {
          project.teams.splice(idx, 1);
          if (project.gpx) {
            const newGpx = {};
            let nIdx = 0;
            for (let oIdx = 0; oIdx < project.teams.length + 1; oIdx++) {
              if (oIdx === idx) continue;
              if (project.gpx[oIdx]) newGpx[nIdx] = project.gpx[oIdx];
              nIdx++;
            }
            project.gpx = newGpx;
          }
          if (project.results?.sheets) {
            delete project.results.sheets[idx];
          }
          saveProject(project);
          refreshAllUI();
        }
      });
    }

    row.appendChild(badge);
    row.appendChild(nameInput);
    row.appendChild(colorInput);
    row.appendChild(deleteBtn);
    container.appendChild(row);
  });

  const actionsDiv = document.createElement('div');
  actionsDiv.style.display = 'flex';
  actionsDiv.style.justifyContent = 'space-between';
  actionsDiv.style.alignItems = 'center';
  actionsDiv.style.marginTop = '10px';
  actionsDiv.style.paddingTop = '8px';
  actionsDiv.style.borderTop = '1px solid var(--border-color)';

  const countInfo = document.createElement('span');
  countInfo.style.fontSize = '12px';
  countInfo.style.color = 'var(--text-muted)';
  const n = project.teams.length;
  countInfo.textContent = `Celkem ${n} ${n >= 5 ? 'týmů' : (n >= 2 ? 'týmy' : 'tým')} (podporováno 2 až 8)`;

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-secondary btn-sm';
  addBtn.id = 'btn-add-team';
  addBtn.innerHTML = '➕ Přidat tým';
  if (project.teams.length >= 8) {
    addBtn.disabled = true;
    addBtn.style.opacity = '0.4';
    addBtn.style.cursor = 'not-allowed';
    addBtn.title = 'Maximální počet týmů je 8';
  } else {
    addBtn.addEventListener('click', () => {
      const nextIdx = project.teams.length;
      const palette = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#d81b60', '#546e7a'];
      project.teams.push({
        name: `Tým ${nextIdx + 1}`,
        color: palette[nextIdx % palette.length],
      });
      saveProject(project);
      refreshAllUI();
    });
  }

  actionsDiv.appendChild(countInfo);
  actionsDiv.appendChild(addBtn);
  container.appendChild(actionsDiv);
}

function syncLayoutChanges() {
  updateDynamicPrintStyle();
  if (mapPickerInstance) {
    const layout = layoutForProject(project);
    const aspect = layout.avail.w / layout.avail.h;
    mapPickerInstance.updateAspect(aspect, layout.mapRect.w);
  }
}

// -------------------------------------------------------------
// 2. ZÁLOŽKA: MAPA
// -------------------------------------------------------------
let mapPickerInstance = null;
let pendingPoint = null;

function initStep2Map() {
  const btnTiles = document.getElementById('btn-map-mode-tiles');
  const btnImage = document.getElementById('btn-map-mode-image');
  const secTiles = document.getElementById('map-mode-tiles-section');
  const secImage = document.getElementById('map-mode-image-section');
  const pickerMount = document.getElementById('map-picker-mount');
  const btnSaveTile = document.getElementById('btn-save-tile-extent');
  const tileStatusMsg = document.getElementById('tile-status-msg');

  // Přepínání režimů mapy
  const currentKind = project.map ? project.map.kind : 'tiles';
  setMapMode(currentKind);

  btnTiles.addEventListener('click', () => {
    setMapMode('tiles');
  });

  btnImage.addEventListener('click', () => {
    setMapMode('image');
  });

  function setMapMode(mode) {
    btnTiles.classList.toggle('active', mode === 'tiles');
    btnImage.classList.toggle('active', mode === 'image');
    secTiles.style.display = mode === 'tiles' ? 'block' : 'none';
    secImage.style.display = mode === 'image' ? 'block' : 'none';

    if (mode === 'tiles') {
      ensureMapPicker();
    }
  }

  function ensureMapPicker() {
    if (mapPickerInstance) return;
    const layout = layoutForProject(project);
    const aspect = layout.avail.w / layout.avail.h;

    let initCenter = [49.8, 15.4];
    let initTileUrl = undefined;
    let initAttribution = undefined;

    if (project.map && project.map.kind === 'tiles') {
      initTileUrl = project.map.tileUrl;
      initAttribution = project.map.attribution;
      if (project.map.georef) {
        try {
          const g = makeGeoref(project.map.georef);
          initCenter = g.center;
        } catch (e) {
          // ignore
        }
      }
    }

    try {
      mapPickerInstance = openMapPicker(pickerMount, {
        aspect,
        printWidthMm: layout.mapRect.w,
        initialCenter: initCenter,
        tileUrl: initTileUrl,
        attribution: initAttribution,
        apiKey: project.map && project.map.apiKey ? project.map.apiKey : (localStorage.getItem('stopovacka.mapyKey') || ''),
        onChange: (info) => {
          tileStatusMsg.textContent = 'Výřez změněn (nezapomeňte kliknout na Uložit)';
        }
      });
    } catch (err) {
      console.error('Chyba při otevírání mapPickeru:', err);
    }
  }

  btnSaveTile.addEventListener('click', () => {
    if (!mapPickerInstance) return;
    const georef = mapPickerInstance.getGeoref();
    project.map = {
      kind: 'tiles',
      tileUrl: mapPickerInstance.getTileUrl(),
      attribution: mapPickerInstance.getAttribution(),
      apiKey: mapPickerInstance.getApiKey ? mapPickerInstance.getApiKey() : '',
      georef
    };
    saveProject(project);
    tileStatusMsg.textContent = '✓ Výřez mapy byl uložen do projektu.';
    tileStatusMsg.style.color = 'var(--success)';
    setTimeout(() => {
      tileStatusMsg.style.color = 'var(--text-muted)';
    }, 3000);
  });

  initCustomImageGeoref();
}

function initCustomImageGeoref() {
  const fileInput = document.getElementById('map-image-file-input');
  const fileNameEl = document.getElementById('map-image-name');
  const containerEl = document.getElementById('image-georef-container');
  const imgWrap = document.getElementById('image-wrap');
  const annotateImg = document.getElementById('annotate-img');
  const markersLayer = document.getElementById('image-markers-layer');
  const pointsTbody = document.getElementById('points-tbody');
  const rmsDisplay = document.getElementById('rms-display');
  const btnClearPoints = document.getElementById('btn-clear-points');

  // Modální okno pro zadání souřadnic
  const modal = document.getElementById('point-modal');
  const modalInput = document.getElementById('modal-coord-input');
  const modalError = document.getElementById('modal-coord-error');
  const btnModalSave = document.getElementById('btn-modal-save');
  const btnModalCancel = document.getElementById('btn-modal-cancel');

  if (project.map && project.map.kind === 'image' && project.map.imageDataUrl) {
    containerEl.style.display = 'block';
    fileNameEl.textContent = 'Nahraný obrázek';
    annotateImg.src = project.map.imageDataUrl;
    renderPointsTableAndMarkers();
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    fileNameEl.textContent = 'Zpracovávám obrázek...';
    try {
      const { dataUrl, width, height, aspect } = await resizeImageFile(file, 2400, 0.85);
      project.map = {
        kind: 'image',
        imageDataUrl: dataUrl,
        georef: {
          type: 'affine',
          aspect: aspect,
          points: []
        }
      };
      saveProject(project);

      fileNameEl.textContent = `${file.name} (${width} × ${height} px)`;
      containerEl.style.display = 'block';
      annotateImg.src = dataUrl;
      renderPointsTableAndMarkers();
    } catch (err) {
      alert('Chyba při nahrávání obrázku: ' + err.message);
      fileNameEl.textContent = 'Chyba nahrávání';
    }
  });

  // Klepnutí do obrázku
  imgWrap.addEventListener('click', (e) => {
    if (!project.map || project.map.kind !== 'image') return;
    const rect = annotateImg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;

    if (u < 0 || u > 1 || v < 0 || v > 1) return;

    pendingPoint = {
      u: Number(u.toFixed(4)),
      v: Number(v.toFixed(4))
    };

    modalInput.value = '';
    modalError.style.display = 'none';
    modal.style.display = 'flex';
    modalInput.focus();
  });

  function closeModal() {
    modal.style.display = 'none';
    pendingPoint = null;
  }

  btnModalCancel.addEventListener('click', closeModal);

  btnModalSave.addEventListener('click', () => {
    if (!pendingPoint) return;
    const text = modalInput.value.trim();
    const parsed = parseLatLon(text);
    if (!parsed) {
      modalError.textContent = 'Neplatný formát souřadnic. Zadejte např. 49.1234N, 16.5678E nebo 48°57.072\'N 19°4.272\'E';
      modalError.style.display = 'block';
      return;
    }

    if (!project.map.georef.points) project.map.georef.points = [];
    project.map.georef.points.push({
      u: pendingPoint.u,
      v: pendingPoint.v,
      lat: parsed.lat,
      lon: parsed.lon
    });

    saveProject(project);
    closeModal();
    renderPointsTableAndMarkers();
  });

  modalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnModalSave.click();
    } else if (e.key === 'Escape') {
      closeModal();
    }
  });

  btnClearPoints.addEventListener('click', () => {
    if (!confirm('Opravdu chcete smazat všechny vlícovací body?')) return;
    if (project.map && project.map.georef) {
      project.map.georef.points = [];
      saveProject(project);
      renderPointsTableAndMarkers();
    }
  });

  function renderPointsTableAndMarkers() {
    markersLayer.innerHTML = '';
    pointsTbody.innerHTML = '';
    rmsDisplay.textContent = '';

    if (!project.map || project.map.kind !== 'image' || !project.map.georef) return;
    const pts = project.map.georef.points || [];

    // Vykreslit značky na obrázku
    pts.forEach((p, idx) => {
      const marker = document.createElement('div');
      marker.className = 'map-point-marker';
      marker.style.left = `${(p.u * 100).toFixed(2)}%`;
      marker.style.top = `${(p.v * 100).toFixed(2)}%`;
      marker.textContent = String(idx + 1);
      markersLayer.appendChild(marker);
    });

    // Výpočet georeference pro zjištění RMS a reziduí
    let residuals = [];
    let rmsM = null;
    if (pts.length >= 2) {
      try {
        const geo = makeGeoref(project.map.georef);
        residuals = geo.residuals || [];
        rmsM = geo.rmsM;
        rmsDisplay.textContent = `Střední chyba (RMS): ${rmsM.toFixed(1)} m`;
        rmsDisplay.style.color = rmsM < 25 ? 'var(--success)' : 'var(--warning)';
      } catch (err) {
        rmsDisplay.textContent = `Chyba: ${err.message}`;
        rmsDisplay.style.color = 'var(--danger)';
      }
    } else {
      rmsDisplay.textContent = `Zadáno ${pts.length}/2 bodů (minimum 2, doporučeno 3–5)`;
      rmsDisplay.style.color = 'var(--text-muted)';
    }

    // Tabulka bodů
    pts.forEach((p, idx) => {
      const tr = document.createElement('tr');
      const resText = residuals[idx] != null ? `${residuals[idx].toFixed(1)} m` : '–';

      tr.innerHTML = `
        <td style="font-weight:bold;">${idx + 1}</td>
        <td>${p.u.toFixed(3)}, ${p.v.toFixed(3)}</td>
        <td>${p.lat.toFixed(5)}°, ${p.lon.toFixed(5)}°</td>
        <td>${resText}</td>
        <td>
          <button type="button" class="btn btn-danger btn-sm" style="padding:2px 8px; min-height:24px;" data-del="${idx}" title="Smazat bod">×</button>
        </td>
      `;

      tr.querySelector('[data-del]').addEventListener('click', () => {
        project.map.georef.points.splice(idx, 1);
        saveProject(project);
        renderPointsTableAndMarkers();
      });

      pointsTbody.appendChild(tr);
    });
  }
}

// -------------------------------------------------------------
// 3. ZÁLOŽKA: TISK
// -------------------------------------------------------------
let selectedPreviewTeam = 'all';

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updatePrintTeamTabs() {
  const container = document.getElementById('print-team-tabs');
  if (!container) return;

  const teams = project.teams || [];
  if (selectedPreviewTeam !== 'all' && Number(selectedPreviewTeam) >= teams.length) {
    selectedPreviewTeam = 'all';
  }

  let html = `<button type="button" class="btn btn-secondary btn-sm preview-team-tab ${selectedPreviewTeam === 'all' ? 'active' : ''}" data-team="all">Všechny archy</button>`;
  teams.forEach((t, i) => {
    const isAct = String(i) === selectedPreviewTeam;
    html += `<button type="button" class="btn btn-secondary btn-sm preview-team-tab ${isAct ? 'active' : ''}" data-team="${i}">${escapeHtml(t.name || `Tým ${i + 1}`)}</button>`;
  });
  container.innerHTML = html;

  container.querySelectorAll('.preview-team-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.preview-team-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPreviewTeam = btn.getAttribute('data-team');
      updatePrintButtonLabel();
      updatePrintPreview();
    });
  });

  updatePrintButtonLabel();
}

function updatePrintButtonLabel() {
  const btnPrint = document.getElementById('btn-print-sheets');
  if (!btnPrint) return;
  const count = project.teams ? project.teams.length : 4;

  if (selectedPreviewTeam === 'all') {
    btnPrint.textContent = `🖨️ Vytisknout všechny archy (${count} ${count >= 5 ? 'stran' : (count >= 2 ? 'strany' : 'strana')})`;
  } else {
    const idx = Number(selectedPreviewTeam);
    const team = project.teams && project.teams[idx] ? project.teams[idx].name : `Tým ${idx + 1}`;
    btnPrint.textContent = `🖨️ Vytisknout jen arch: ${team} (1 strana)`;
  }
}

function initStep3Print() {
  const btnPrint = document.getElementById('btn-print-sheets');
  if (btnPrint) {
    btnPrint.addEventListener('click', async () => {
      const origText = btnPrint.textContent;
      btnPrint.disabled = true;
      btnPrint.textContent = '⏳ Příprava tisku…';

      updateDynamicPrintStyle();

      // Pokud máme dlaždicovou mapu, předrenderujeme ji do jednoho souvislého JPEG data URL na canvasu.
      // Tím se vyhneme Safari/WebKit chybě, kdy se 60 samostatných dlaždic nestihne stáhnout před otevřením
      // tiskového dialogu, nebo je Safari zahodí, když uživatel nemá zaškrtnuto "Tisknout pozadí".
      if (project.map && project.map.kind === 'tiles' && project.map.georef && !project.map.renderedDataUrl) {
        try {
          const printMode = project.mapPrintMode || 'grayscale';
          const dataUrl = await renderMapToCanvas(project.map, printMode);
          if (dataUrl) {
            project.map.renderedDataUrl = dataUrl;
          }
        } catch (err) {
          console.warn('Předvykreslení mapy selhalo, použije se fallback na dlaždice:', err);
        }
      }

      renderSheetsToPrintContainer(selectedPreviewTeam);

      // Dočasně přepneme stránku do tiskového stavu, aby prohlížeč (zejména Safari na iPhone)
      // vykreslil tiskový kontejner v plné velikosti před vyvoláním dialogu tisku.
      document.body.classList.add('is-printing-sheets');

      const printContainer = document.getElementById('print-container');
      if (printContainer) {
        const imgs = Array.from(printContainer.querySelectorAll('img'));
        if (imgs.length > 0) {
          await Promise.all(imgs.map(img => {
            if (img.complete && typeof img.decode === 'function') {
              return img.decode().catch(() => {});
            }
            return new Promise(resolve => {
              img.onload = () => {
                if (typeof img.decode === 'function') img.decode().catch(() => {}).then(resolve);
                else resolve();
              };
              img.onerror = () => resolve();
              setTimeout(resolve, 800);
            });
          }));
        }
      }

      btnPrint.disabled = false;
      btnPrint.textContent = origText;

      const cleanupPrinting = () => {
        document.body.classList.remove('is-printing-sheets');
        window.removeEventListener('afterprint', cleanupPrinting);
      };
      window.addEventListener('afterprint', cleanupPrinting);

      requestAnimationFrame(() => {
        setTimeout(() => {
          try {
            window.print();
          } finally {
            setTimeout(cleanupPrinting, 1500);
          }
        }, 50);
      });
    });
  }

  // Podpora i pro přímou klávesovou zkratku Ctrl+P / Cmd+P
  window.addEventListener('beforeprint', () => {
    updateDynamicPrintStyle();
    renderSheetsToPrintContainer(selectedPreviewTeam);
    document.body.classList.add('is-printing-sheets');
  });

  window.addEventListener('afterprint', () => {
    document.body.classList.remove('is-printing-sheets');
  });

  updatePrintTeamTabs();
}

function updateDynamicPrintStyle() {
  const styleEl = document.getElementById('print-page-style');
  const paper = project.paper || 'A4';
  const orientation = project.orientation || 'portrait';
  const layout = layoutForProject(project);
  // Bezpečná výška o 2 mm menší než fyzický papír (např. 295 mm pro A4), která zabraňuje zaokrouhlovací chybě a přetečení na prázdnou 2. stránku
  const safeH = Math.max(100, layout.h - 2);
  const safeW = layout.w;
  if (styleEl) {
    styleEl.textContent = `
      @media print {
        @page {
          size: ${paper} ${orientation};
          margin: 0;
        }
        .sheet {
          width: ${safeW}mm !important;
          height: ${safeH}mm !important;
          max-height: ${safeH}mm !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
          overflow: visible !important;
        }
        .sheet:last-child {
          page-break-after: avoid !important;
          break-after: avoid !important;
        }
        .sheet-map-box {
          background: #ffffff !important;
        }
        .sheet-map-content {
          filter: none !important;
          -webkit-filter: none !important;
        }
        .sheet-map-content img {
          filter: none !important;
          -webkit-filter: none !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
      }
    `;
  }
}

function renderSheetsToPrintContainer(targetTeam = 'all') {
  const printContainer = document.getElementById('print-container');
  if (!printContainer) return;

  const count = project.teams ? project.teams.length : 0;
  let html = '';
  if (targetTeam === 'all') {
    for (let i = 0; i < count; i++) {
      html += renderSheetHtml(project, i) + '\n';
    }
  } else {
    const idx = Number(targetTeam);
    if (idx >= 0 && idx < count) {
      html = renderSheetHtml(project, idx) + '\n';
    }
  }
  printContainer.innerHTML = html;
}

function updatePrintPreview() {
  updateDynamicPrintStyle();
  renderSheetsToPrintContainer(selectedPreviewTeam);

  // Na pozadí můžeme začít sestavovat mapu do canvasu, aby byla okamžitě k dispozici při stisku Tisknout
  if (project.map && project.map.kind === 'tiles' && project.map.georef && !project.map.renderedDataUrl) {
    const printMode = project.mapPrintMode || 'grayscale';
    renderMapToCanvas(project.map, printMode).then(dataUrl => {
      if (dataUrl && !project.map.renderedDataUrl) {
        project.map.renderedDataUrl = dataUrl;
        renderSheetsToPrintContainer(selectedPreviewTeam);
      }
    }).catch(() => {});
  }

  const previewContainer = document.getElementById('preview-container');
  const alertEl = document.getElementById('print-alert');
  if (!previewContainer) return;

  if (!project.map || !project.map.georef) {
    alertEl.style.display = 'block';
    alertEl.innerHTML = '⚠️ <strong>Upozornění:</strong> Mapa zatím není nastavena nebo georeferencována. Vytisknuté archy budou mít prázdné mapové pole.';
  } else {
    alertEl.style.display = 'none';
  }

  previewContainer.innerHTML = '';

  const layout = layoutForProject(project);
  // Škálování náhledu na obrazovce tak, aby se vešel do kontejneru
  const targetWidthPx = Math.min(window.innerWidth - 64, 780);
  const scale = targetWidthPx / (layout.w * 3.7795); // 1mm ≈ 3.78px při 96 DPI

  const teamsToShow = selectedPreviewTeam === 'all'
    ? project.teams.map((_, i) => i)
    : [Number(selectedPreviewTeam)];

  teamsToShow.forEach(idx => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-preview-wrap';
    wrap.style.width = `${layout.w}mm`;
    wrap.style.height = `${layout.h}mm`;
    wrap.style.transform = `scale(${Math.min(1, scale.toFixed(3))})`;
    wrap.style.marginBottom = `${Math.round(layout.h * (scale - 1))}px`;

    wrap.innerHTML = renderSheetHtml(project, idx);
    previewContainer.appendChild(wrap);
  });
}

// -------------------------------------------------------------
// 4. ZÁLOŽKA: HRA & GPX
// -------------------------------------------------------------
function initStep4Game() {
  const startInput = document.getElementById('game-start-time');
  const endInput = document.getElementById('game-end-time');
  const gpxContainer = document.getElementById('gpx-teams-container');

  if (project.game) {
    startInput.value = msToDatetimeLocal(project.game.startMs);
    endInput.value = msToDatetimeLocal(project.game.endMs);
  }

  startInput.addEventListener('change', () => {
    project.game.startMs = datetimeLocalToMs(startInput.value);
    saveProject(project);
  });

  endInput.addEventListener('change', () => {
    project.game.endMs = datetimeLocalToMs(endInput.value);
    saveProject(project);
  });

  renderGpxTeamsList(gpxContainer);
}

function renderGpxTeamsList(container) {
  if (!container) return;
  container.innerHTML = '';

  project.teams.forEach((team, idx) => {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.style.flexWrap = 'wrap';

    const badge = document.createElement('div');
    badge.className = 'team-badge';
    badge.style.backgroundColor = team.color;
    badge.textContent = String(idx + 1);

    const nameSpan = document.createElement('span');
    nameSpan.style.fontWeight = '600';
    nameSpan.style.minWidth = '120px';
    nameSpan.textContent = team.name;

    const gpxInfo = project.gpx && project.gpx[idx];
    const statusWrap = document.createElement('div');
    statusWrap.style.display = 'flex';
    statusWrap.style.alignItems = 'center';
    statusWrap.style.gap = '10px';
    statusWrap.style.flex = '1';

    if (gpxInfo && gpxInfo.text) {
      const trkptCount = (gpxInfo.text.match(/<trkpt/gi) || gpxInfo.text.match(/<rtept/gi) || []).length;
      statusWrap.innerHTML = `
        <span style="font-size:13px; color:var(--success); font-weight:600;">✓ ${gpxInfo.fileName || 'GPX soubor'}</span>
        <span style="font-size:12px; color:var(--text-muted);">(${trkptCount} bodů, ${Math.round(gpxInfo.text.length / 1024)} KB)</span>
        <button type="button" class="btn btn-danger btn-sm" style="margin-left:auto;">Odstranit</button>
      `;
      statusWrap.querySelector('button').addEventListener('click', () => {
        delete project.gpx[idx];
        saveProject(project);
        renderGpxTeamsList(container);
      });
    } else {
      const fileLabel = document.createElement('label');
      fileLabel.className = 'btn btn-secondary btn-sm';
      fileLabel.style.cursor = 'pointer';
      fileLabel.textContent = '📁 Nahrát GPX';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.gpx,application/gpx+xml,text/xml';
      fileInput.style.display = 'none';

      fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
          if (!project.gpx) project.gpx = {};
          project.gpx[idx] = {
            fileName: file.name,
            text: reader.result
          };
          saveProject(project);
          renderGpxTeamsList(container);
        };
        reader.readAsText(file);
      });

      fileLabel.appendChild(fileInput);
      statusWrap.appendChild(fileLabel);
    }

    row.appendChild(badge);
    row.appendChild(nameSpan);
    row.appendChild(statusWrap);
    container.appendChild(row);
  });
}

// -------------------------------------------------------------
// 5. ZÁLOŽKA: VYHODNOCENÍ (PŘIPOJENÍ MODULU)
// -------------------------------------------------------------
function initStep5Evaluate() {
  const mountEl = document.getElementById('evaluate-mount');
  if (!mountEl) return;

  // Dynamický import vyhodnocovacího modulu od jiného agenta
  import('./ui/evaluate.js')
    .then(module => {
      if (typeof module.mountEvaluate === 'function') {
        mountEl.innerHTML = '';
        module.mountEvaluate(mountEl, { getProject, saveProject });
      }
    })
    .catch(err => {
      console.error('Chyba při načítání js/ui/evaluate.js:', err);
    });
}
