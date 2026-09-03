// Fallback when opened in a plain browser (no Electron bridge): keep data in localStorage.
if (!window.bp) {
  window.bp = {
    load: async () => { try { return JSON.parse(localStorage.getItem('bp-data') || '[]'); } catch { return []; } },
    save: async (list) => localStorage.setItem('bp-data', JSON.stringify(list)),
    exportCsv: async () => ({ ok: false }),
    importCsv: async () => ({ ok: false }),
    openDataFolder: async () => alert('Data is stored in this browser\'s local storage.'),
    confirmDelete: async (msg) => confirm(msg),
    loadPrefs: async () => { try { return JSON.parse(localStorage.getItem('bp-prefs') || 'null'); } catch { return null; } },
    savePrefs: async (p) => localStorage.setItem('bp-prefs', JSON.stringify(p)),
    openPrefsFile: async () => alert('Preferences are stored in this browser\'s local storage.'),
    dataInfo: async () => ({ folder: 'Browser local storage', isDefault: true }),
    chooseDataFolder: async () => { alert('Choosing a folder is only available in the desktop app.'); return { ok: false }; },
    useDefaultDataFolder: async () => ({ ok: false }),
  };
}

// ---------- State ----------
let entries = [];          // all readings
let editingId = null;      // id of the entry being edited, or null
let chartRange = 30;       // days shown on the chart (0 = all)
let searchTerm = '';

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);

const pad = (n) => String(n).padStart(2, '0');
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function nowStr() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function entryTime(e) {
  return new Date(`${e.date}T${e.time || '00:00'}`).getTime();
}
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Thresholds (from preferences.json) ----------
const DEFAULT_PREFS = {
  normalMax: { sys: 135, dia: 89 },
  highFrom: { sys: 140, dia: 90 },
  crisisAbove: { sys: 180, dia: 120 },
};
let prefs = JSON.parse(JSON.stringify(DEFAULT_PREFS));

function categorize(sys, dia) {
  const { normalMax: n, highFrom: h, crisisAbove: c } = prefs;
  if (sys > c.sys || dia > c.dia) return { key: 'crisis', label: 'Crisis', hint: `Above ${c.sys}/${c.dia} · seek medical attention` };
  if (sys >= h.sys || dia >= h.dia) return { key: 'high', label: 'High', hint: `${h.sys}+ or ${h.dia}+` };
  if (sys > n.sys || dia > n.dia) return { key: 'elevated', label: 'Elevated', hint: `Above ${n.sys}/${n.dia}` };
  return { key: 'normal', label: 'Normal', hint: `Up to ${n.sys}/${n.dia}` };
}

// ---------- Time picker (hour / minute / AM-PM) ----------
function fillTimeSelects() {
  const hour = $('f-hour'), min = $('f-min');
  for (let h = 1; h <= 12; h++) hour.add(new Option(String(h), String(h)));
  for (let m = 0; m < 60; m++) min.add(new Option(pad(m), pad(m)));
}
function setTimeValue(hhmm) {
  let [h, m] = (hhmm || nowStr()).split(':').map(Number);
  if (!Number.isFinite(h)) h = 0;
  if (!Number.isFinite(m)) m = 0;
  $('f-ampm').value = h >= 12 ? 'PM' : 'AM';
  $('f-hour').value = String(h % 12 === 0 ? 12 : h % 12);
  $('f-min').value = pad(m);
}
function getTimeValue() {
  let h = Number($('f-hour').value) % 12;
  if ($('f-ampm').value === 'PM') h += 12;
  return `${pad(h)}:${$('f-min').value}`;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function persist() {
  try {
    await window.bp.save(entries);
  } catch (e) {
    toast('Could not save data: ' + e.message, true);
  }
}

function sorted() {
  return [...entries].sort((a, b) => entryTime(b) - entryTime(a));
}

// ---------- Form ----------
function resetForm() {
  editingId = null;
  $('form-title').textContent = 'New reading';
  $('btn-save').textContent = 'Save reading';
  $('btn-cancel').classList.add('hidden');
  $('f-date').value = todayStr();
  setTimeValue(nowStr());
  $('f-sys').value = '';
  $('f-dia').value = '';
  $('f-pulse').value = '';
  $('f-note').value = '';
  updateLivePill();
  document.querySelectorAll('#history-body tr').forEach((r) => r.classList.remove('editing'));
  $('f-sys').focus({ preventScroll: true });
}

function updateLivePill() {
  const sys = Number($('f-sys').value);
  const dia = Number($('f-dia').value);
  const pill = $('live-category');
  if (sys >= 50 && dia >= 30) {
    const c = categorize(sys, dia);
    pill.className = `category-pill cat-${c.key}`;
    pill.innerHTML = `${escapeHtml(c.label)} <small>${escapeHtml(c.hint)}</small>`;
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
}

function startEdit(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  editingId = id;
  $('form-title').textContent = 'Edit reading';
  $('btn-save').textContent = 'Update reading';
  $('btn-cancel').classList.remove('hidden');
  $('f-date').value = e.date;
  setTimeValue(e.time);
  $('f-sys').value = e.sys;
  $('f-dia').value = e.dia;
  $('f-pulse').value = e.pulse ?? '';
  $('f-note').value = e.note ?? '';
  updateLivePill();
  document.querySelectorAll('#history-body tr').forEach((r) => r.classList.toggle('editing', r.dataset.id === id));
  $('f-sys').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function onSubmit(ev) {
  ev.preventDefault();
  const sys = Number($('f-sys').value);
  const dia = Number($('f-dia').value);
  const pulseRaw = $('f-pulse').value.trim();
  const pulse = pulseRaw === '' ? null : Number(pulseRaw);

  if (!(sys >= 50 && sys <= 260)) return toast('Systolic must be between 50 and 260.', true);
  if (!(dia >= 30 && dia <= 160)) return toast('Diastolic must be between 30 and 160.', true);
  if (dia >= sys) return toast('Diastolic should be lower than systolic.', true);
  if (pulse !== null && !(pulse >= 30 && pulse <= 220)) return toast('Pulse must be between 30 and 220.', true);

  const record = {
    id: editingId || uid(),
    date: $('f-date').value,
    time: getTimeValue(),
    sys, dia, pulse,
    note: $('f-note').value.trim(),
  };

  if (editingId) {
    entries = entries.map((e) => (e.id === editingId ? record : e));
    toast('Reading updated');
  } else {
    entries.push(record);
    const c = categorize(sys, dia);
    toast(`Saved · ${sys}/${dia} · ${c.label}`);
  }
  await persist();
  resetForm();
  renderAll();
}

async function deleteEntry(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const ok = await window.bp.confirmDelete(`Delete the reading ${e.sys}/${e.dia} on ${fmtDate(e.date)} at ${fmtTime(e.time)}?`);
  if (!ok) return;
  entries = entries.filter((x) => x.id !== id);
  if (editingId === id) resetForm();
  await persist();
  renderAll();
  toast('Reading deleted');
}

// ---------- Stats ----------
function average(list) {
  if (!list.length) return null;
  const s = list.reduce((a, e) => a + e.sys, 0) / list.length;
  const d = list.reduce((a, e) => a + e.dia, 0) / list.length;
  const withPulse = list.filter((e) => e.pulse != null);
  const p = withPulse.length ? withPulse.reduce((a, e) => a + e.pulse, 0) / withPulse.length : null;
  return { sys: Math.round(s), dia: Math.round(d), pulse: p == null ? null : Math.round(p), n: list.length, list };
}

// Readings in the N days ending on the day of the most recent reading
// (so back-entered or older logs still get a 7-day / 30-day average).
function withinDays(days) {
  const latest = sorted()[0];
  if (!latest) return [];
  const end = new Date(`${latest.date}T23:59:59`).getTime();
  const cutoff = end - days * 86400000;
  return entries.filter((e) => { const t = entryTime(e); return t > cutoff && t <= end; });
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function setStat(prefix, avg) {
  const v = $(`s-${prefix}`), sub = $(`s-${prefix}-sub`);
  const card = v.closest('.stat');
  card.className = 'stat';
  if (!avg) { v.textContent = '–'; sub.textContent = 'No readings'; return; }
  const c = categorize(avg.sys, avg.dia);
  card.classList.add(`cat-${c.key}`);
  v.textContent = `${avg.sys}/${avg.dia}`;
  const dates = avg.list.map((e) => e.date).sort();
  const range = dates[0] === dates[dates.length - 1] ? shortDate(dates[0]) : `${shortDate(dates[0])} – ${shortDate(dates[dates.length - 1])}`;
  sub.textContent = `${c.label}${avg.pulse != null ? ` · pulse ${avg.pulse}` : ''} · ${avg.n} reading${avg.n === 1 ? '' : 's'} · ${range}`;
}

function renderStats() {
  const list = sorted();
  const last = list[0];
  const lastCard = $('s-last').closest('.stat');
  lastCard.className = 'stat';
  if (last) {
    const c = categorize(last.sys, last.dia);
    lastCard.classList.add(`cat-${c.key}`);
    $('s-last').textContent = `${last.sys}/${last.dia}`;
    $('s-last-sub').textContent = `${c.label} · ${fmtDate(last.date)} ${fmtTime(last.time)}`;
  } else {
    $('s-last').textContent = '–';
    $('s-last-sub').textContent = 'No readings yet';
  }
  setStat('avg7', average(withinDays(7)));
  setStat('avg30', average(withinDays(30)));
  $('s-count').textContent = entries.length;
  if (entries.length) {
    const first = list[list.length - 1];
    $('s-count-sub').textContent = `Since ${fmtDate(first.date)}`;
  } else {
    $('s-count-sub').textContent = '';
  }
}

// ---------- Chart ----------
function renderChart() {
  const canvas = $('chart');
  const empty = $('chart-empty');
  $('legend-ref').textContent = `${prefs.normalMax.sys} / ${prefs.normalMax.dia} normal limit`;
  const data = (chartRange ? withinDays(chartRange) : [...entries]).sort((a, b) => entryTime(a) - entryTime(b));

  const cssW = canvas.clientWidth || 600;
  const cssH = 240;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (data.length < 2) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const padL = 40, padR = 16, padT = 14, padB = 30;
  const w = cssW - padL - padR, h = cssH - padT - padB;

  const refSys = prefs.normalMax.sys, refDia = prefs.normalMax.dia;
  const allVals = data.flatMap((e) => [e.sys, e.dia]).concat([refDia, refSys]);
  let yMin = Math.floor((Math.min(...allVals) - 10) / 10) * 10;
  let yMax = Math.ceil((Math.max(...allVals) + 10) / 10) * 10;
  const tMin = entryTime(data[0]), tMax = entryTime(data[data.length - 1]);
  const tSpan = Math.max(tMax - tMin, 1);

  const x = (t) => padL + ((t - tMin) / tSpan) * w;
  const y = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * h;

  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();

  // grid + y labels
  ctx.font = '11px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const step = (yMax - yMin) > 100 ? 20 : 10;
  for (let v = yMin; v <= yMax; v += step) {
    ctx.strokeStyle = '#eef1f6';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(padL + w, y(v)); ctx.stroke();
    ctx.fillStyle = col('--muted');
    ctx.fillText(String(v), padL - 8, y(v));
  }

  // reference lines at the normal limit
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = col('--ref');
  ctx.lineWidth = 1.5;
  for (const v of [refSys, refDia]) {
    ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(padL + w, y(v)); ctx.stroke();
  }
  ctx.setLineDash([]);

  // x labels: pick up to ~6 evenly spaced dates
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = col('--muted');
  const labelCount = Math.min(6, data.length);
  const seen = new Set();
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.round((i / Math.max(labelCount - 1, 1)) * (data.length - 1));
    const e = data[idx];
    if (seen.has(e.date)) continue;
    seen.add(e.date);
    const [yy, mm, dd] = e.date.split('-').map(Number);
    const label = new Date(yy, mm - 1, dd).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    ctx.fillText(label, x(entryTime(e)), padT + h + 8);
  }

  // series
  const drawSeries = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    data.forEach((e, i) => {
      const px = x(entryTime(e)), py = y(e[key]);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    data.forEach((e) => {
      ctx.beginPath(); ctx.arc(x(entryTime(e)), y(e[key]), 3.5, 0, Math.PI * 2); ctx.fill();
    });
  };
  drawSeries('sys', col('--sys'));
  drawSeries('dia', col('--dia'));
}

// ---------- History ----------
function renderHistory() {
  const body = $('history-body');
  const q = searchTerm.toLowerCase();
  const list = sorted().filter((e) => !q || e.date.includes(q) || (e.note || '').toLowerCase().includes(q) || fmtDate(e.date).toLowerCase().includes(q));

  body.innerHTML = list.map((e) => {
    const c = categorize(e.sys, e.dia);
    return `<tr data-id="${e.id}"${e.id === editingId ? ' class="editing"' : ''}>
      <td>${escapeHtml(fmtDate(e.date))}</td>
      <td>${escapeHtml(fmtTime(e.time))}</td>
      <td class="num"><strong>${e.sys}</strong></td>
      <td class="num"><strong>${e.dia}</strong></td>
      <td class="num">${e.pulse ?? '–'}</td>
      <td><span class="badge cat-${c.key}">${escapeHtml(c.label)}</span></td>
      <td class="note">${escapeHtml(e.note)}</td>
      <td class="actions">
        <button class="btn icon" data-action="edit" title="Edit">✎</button>
        <button class="btn icon danger" data-action="delete" title="Delete">✕</button>
      </td>
    </tr>`;
  }).join('');

  const emptyEl = $('history-empty');
  if (!entries.length) {
    emptyEl.textContent = 'No readings yet. Add your first one on the left.';
    emptyEl.classList.remove('hidden');
  } else if (!list.length) {
    emptyEl.textContent = 'No readings match your search.';
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
  }
}

function renderAll() {
  renderStats();
  renderChart();
  renderHistory();
}

// ---------- Import ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

async function importCsv() {
  const res = await window.bp.importCsv();
  if (!res.ok) return;
  const rows = parseCsv(res.text);
  if (!rows.length) return toast('The file is empty.', true);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (names) => header.findIndex((h) => names.includes(h));
  const iDate = idx(['date']), iTime = idx(['time']), iSys = idx(['systolic', 'sys']), iDia = idx(['diastolic', 'dia']), iPulse = idx(['pulse', 'hr', 'heart rate']), iNote = idx(['notes', 'note']);
  if (iDate < 0 || iSys < 0 || iDia < 0) return toast('CSV needs Date, Systolic and Diastolic columns.', true);

  const existing = new Set(entries.map((e) => `${e.date}|${e.time}|${e.sys}|${e.dia}`));
  let added = 0, skipped = 0;
  for (const r of rows.slice(1)) {
    const date = (r[iDate] || '').trim();
    const time = iTime >= 0 ? (r[iTime] || '').trim().slice(0, 5) : '08:00';
    const sys = Number(r[iSys]), dia = Number(r[iDia]);
    const pulseRaw = iPulse >= 0 ? (r[iPulse] || '').trim() : '';
    const pulse = pulseRaw === '' ? null : Number(pulseRaw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(sys > 0) || !(dia > 0)) { skipped++; continue; }
    const key = `${date}|${time}|${sys}|${dia}`;
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key);
    entries.push({ id: uid(), date, time, sys, dia, pulse: Number.isFinite(pulse) ? pulse : null, note: iNote >= 0 ? (r[iNote] || '').trim() : '' });
    added++;
  }
  await persist();
  renderAll();
  toast(`Imported ${added} reading${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}`);
}

// ---------- Settings dialog ----------
function openSettings() {
  $('p-normal-sys').value = prefs.normalMax.sys;
  $('p-normal-dia').value = prefs.normalMax.dia;
  $('p-high-sys').value = prefs.highFrom.sys;
  $('p-high-dia').value = prefs.highFrom.dia;
  $('p-crisis-sys').value = prefs.crisisAbove.sys;
  $('p-crisis-dia').value = prefs.crisisAbove.dia;
  refreshDataFolderLabel();
  $('settings-dialog').showModal();
}

async function refreshDataFolderLabel() {
  const info = await window.bp.dataInfo();
  const el = $('p-data-folder');
  el.textContent = info.folder;
  el.title = info.folder;
  el.classList.toggle('is-default', !!info.isDefault);
  $('btn-default-folder').disabled = !!info.isDefault;
}

async function applyDataFolderResult(res) {
  if (!res || !res.ok) {
    if (res && res.error) toast('Could not change data folder: ' + res.error, true);
    return;
  }
  entries = res.entries || [];
  resetForm();
  renderAll();
  await refreshDataFolderLabel();
  toast(`Readings are now saved in ${res.info.folder}`);
}

async function saveSettings(ev) {
  ev.preventDefault();
  const n = (id) => Number($(id).value);
  const next = {
    normalMax: { sys: n('p-normal-sys'), dia: n('p-normal-dia') },
    highFrom: { sys: n('p-high-sys'), dia: n('p-high-dia') },
    crisisAbove: { sys: n('p-crisis-sys'), dia: n('p-crisis-dia') },
  };
  const vals = [next.normalMax, next.highFrom, next.crisisAbove];
  if (vals.some((v) => !(v.sys > 0) || !(v.dia > 0))) return toast('Please fill in every threshold.', true);
  if (!(next.normalMax.sys < next.highFrom.sys && next.highFrom.sys <= next.crisisAbove.sys)) return toast('Systolic thresholds must increase: normal < high ≤ crisis.', true);
  if (!(next.normalMax.dia < next.highFrom.dia && next.highFrom.dia <= next.crisisAbove.dia)) return toast('Diastolic thresholds must increase: normal < high ≤ crisis.', true);
  prefs = next;
  try {
    await window.bp.savePrefs(prefs);
  } catch (e) {
    return toast('Could not save preferences: ' + e.message, true);
  }
  $('settings-dialog').close();
  updateLivePill();
  renderAll();
  toast(`Thresholds saved · normal up to ${prefs.normalMax.sys}/${prefs.normalMax.dia}`);
}

// Keep a numeric field to 3 digits and jump to the next field once 3 digits are typed
function autoAdvance(fromId, toId) {
  const el = $(fromId);
  el.addEventListener('input', () => {
    const digits = el.value.replace(/\D/g, '').slice(0, 3);
    if (digits !== el.value) el.value = digits;
    if (digits.length === 3 && toId) {
      const next = $(toId);
      next.focus();
      next.select?.();
    }
  });
}

// ---------- Wire up ----------
async function init() {
  fillTimeSelects();
  const savedPrefs = await window.bp.loadPrefs();
  if (savedPrefs) {
    prefs = {
      normalMax: { ...DEFAULT_PREFS.normalMax, ...(savedPrefs.normalMax || {}) },
      highFrom: { ...DEFAULT_PREFS.highFrom, ...(savedPrefs.highFrom || {}) },
      crisisAbove: { ...DEFAULT_PREFS.crisisAbove, ...(savedPrefs.crisisAbove || {}) },
    };
  }
  entries = await window.bp.load();
  resetForm();
  renderAll();

  $('entry-form').addEventListener('submit', onSubmit);
  $('btn-cancel').addEventListener('click', resetForm);
  $('btn-now').addEventListener('click', () => { $('f-date').value = todayStr(); setTimeValue(nowStr()); });
  ['f-sys', 'f-dia'].forEach((id) => $(id).addEventListener('input', updateLivePill));
  autoAdvance('f-sys', 'f-dia');
  autoAdvance('f-dia', 'f-pulse');
  autoAdvance('f-pulse', null);

  $('btn-settings').addEventListener('click', openSettings);
  $('settings-form').addEventListener('submit', saveSettings);
  $('btn-prefs-cancel').addEventListener('click', () => $('settings-dialog').close());
  $('btn-prefs-file').addEventListener('click', () => window.bp.openPrefsFile());
  $('btn-choose-folder').addEventListener('click', async () => applyDataFolderResult(await window.bp.chooseDataFolder()));
  $('btn-default-folder').addEventListener('click', async () => applyDataFolderResult(await window.bp.useDefaultDataFolder()));

  // Enter in systolic jumps to diastolic, then to pulse, so you can type "120 Enter 80 Enter"
  $('f-sys').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('f-dia').focus(); } });
  $('f-dia').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('f-pulse').value) { e.preventDefault(); $('f-pulse').focus(); } });
  // Enter anywhere else in the form saves the reading
  $('entry-form').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    $('entry-form').requestSubmit();
  });

  $('history-body').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.action === 'edit') startEdit(id);
    else if (btn.dataset.action === 'delete') deleteEntry(id);
  });

  $('search').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); renderHistory(); });

  $('range-seg').addEventListener('click', (ev) => {
    const b = ev.target.closest('.seg-btn');
    if (!b) return;
    chartRange = Number(b.dataset.range);
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    renderChart();
  });

  $('btn-export').addEventListener('click', async () => {
    if (!entries.length) return toast('Nothing to export yet.', true);
    const res = await window.bp.exportCsv(sorted());
    if (res.ok) toast('Exported to ' + res.filePath);
  });
  $('btn-import').addEventListener('click', importCsv);
  $('btn-folder').addEventListener('click', () => window.bp.openDataFolder());

  window.addEventListener('resize', renderChart);
}

init();
