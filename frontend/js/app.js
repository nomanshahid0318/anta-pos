/* ============================================================
   ANTA Shoes POS v4 — Database-backed client (no Google Sheets)
   ============================================================ */
const DEFAULT_API = (location.origin && location.origin.startsWith('http'))
  ? location.origin
  : 'http://127.0.0.1:8765';

let CFG = {
  apiUrl: localStorage.getItem('anta_api_url') || DEFAULT_API,
  token: localStorage.getItem('anta_token') || '',
};

let DB = {
  promos: [],
  products: [],
  transactions: [],
  returns: [],
  exchanges: [],
  claims: [],
  settings: {
    storeName: 'Store 1 — Tripoli',
    storeId: 's1',
    policy: 'Exchange within 7 days with receipt.',
    currency: 'LYD',
  },
  nextInv: 1,
  shiftStart: new Date().toISOString(),
};

let BANKS = [{ id: 'cash', name: 'Cash', device: '', ico: '💵', active: true }];
let STORES = [];
let currentUser = null;
let cart = [];
let selPay = 'Cash';
let pinEntry = '';
let USER = null;
let isOnline = false;
let activityLog = [];

/* ---------- helpers ---------- */
function today() {
  return new Date().toISOString().split('T')[0];
}
function getVal(id, fallback = '') {
  const el = document.getElementById(id);
  return el ? el.value : fallback;
}
function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}
function timeNow() {
  return new Date().toTimeString().slice(0, 5);
}
function fmt(n) {
  return 'LYD ' + (+n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtN(n) {
  return (+n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function toast(msg, type = 'ok') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.background =
    type === 'error' ? 'var(--red)' : type === 'warn' ? '#856404' : type === 'info' ? 'var(--accent2)' : 'var(--navy)';
  t.style.display = 'block';
  setTimeout(() => (t.style.display = 'none'), 3000);
}
function addLog(action, status) {
  activityLog.unshift({ t: new Date().toTimeString().slice(0, 8), action, status });
  activityLog = activityLog.slice(0, 50);
  try {
    localStorage.setItem('anta_log_v4', JSON.stringify(activityLog));
  } catch (e) {}
}
function updateActivityLog() {
  const el = document.getElementById('sync-log');
  if (!el) return;
  el.innerHTML =
    activityLog
      .slice(0, 12)
      .map(
        (l) =>
          `<div style="padding:3px 0;border-bottom:1px solid var(--gray1);display:flex;gap:8px"><span style="color:var(--gray3)">${l.t}</span><span>${l.action}</span><span>${l.status}</span></div>`
      )
      .join('') ||
    '<div style="color:var(--gray3);padding:8px;text-align:center">' + t('no_activity') + '</div>';
}
function setOnline(state, label) {
  isOnline = state === 'online';
  const cls = state;
  ['sync-dot', 'top-dot'].forEach((id) => {
    const d = document.getElementById(id);
    if (d) d.className = 'dot ' + cls;
  });
  const lbl = document.getElementById('sync-label');
  if (lbl) lbl.textContent = state === 'online' ? '🟢 ' + t('online') : state === 'syncing' ? '🔄 ' + t('syncing') : '🔴 ' + t('offline');
  const top = document.getElementById('top-sync');
  if (top) top.textContent = state === 'online' ? t('online') : state === 'syncing' ? t('syncing') : t('offline');
  const last = document.getElementById('sync-last');
  if (last && label) last.textContent = label;
}
function authHeaders(json = true) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (CFG.token) h['Authorization'] = 'Bearer ' + CFG.token;
  return h;
}

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const url = (CFG.apiUrl || DEFAULT_API).replace(/\/$/, '') + path;
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: authHeaders(!!opts.body),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    if (res.status === 401) {
      // token expired
      if (!path.includes('/auth/login') && !path.includes('/auth/stores') && !path.includes('/auth/ping')) {
        addLog(path, '🔒 auth');
      }
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (data && (data.detail || data.msg)) || res.statusText;
      return { ok: false, status: 'error', msg, _http: res.status, data };
    }
    return data;
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timed out — server may be slow or asleep, try again' : e.message;
    return { ok: false, status: 'error', msg, timedOut: e.name === 'AbortError' };
  }
}

/* ---------- LOGIN ---------- */
/* ---------- BRANDING (company name/logo, set in HO Settings) ---------- */
function applyBranding(b) {
  // Blank stays blank — no "ANTA" is forced on anyone who hasn't set
  // their own company name/logo in HO Settings.
  const name = (b && b.company_name) || '';
  const logo = (b && b.company_logo) || '';
  window.__brandName = name; // used by invoice/handover print templates
  window.__brandLogo = logo;
  const logoBox = document.getElementById('brand-logo');
  const logoText = document.getElementById('brand-text');
  const loginTitle = document.getElementById('login-title-text');
  const initial = name ? name.trim().charAt(0).toUpperCase() : '';
  if (logoBox) {
    logoBox.innerHTML = logo ? `<img src="${logo}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : initial;
  }
  if (logoText) logoText.textContent = name;
  if (loginTitle) loginTitle.textContent = name ? name + ' POS' : 'POS';
  if (document.title) document.title = name ? name + ' — POS' : 'POS';
}
async function loadBranding() {
  const res = await api('/api/settings/branding');
  if (res && res.ok) applyBranding(res);
}

async function initLogin() {
  const sel = document.getElementById('login-store');
  const cached = localStorage.getItem('anta_stores_v4');
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length) STORES = parsed.filter(s => (s.store_id || s.StoreID) !== 'HO');
    } catch (e) {}
  }
  if (!Array.isArray(STORES) || !STORES.length) {
    STORES = [
      { store_id: 's1', name: 'Store 1 — Tripoli' },
      { store_id: 's2', name: 'Store 2 — Benghazi' },
      { store_id: 's3', name: 'Store 3 — Misrata' },
    ];
  }
  const paint = () => {
    if (!sel) return;
    const visibleStores = STORES.filter(s => (s.store_id || s.StoreID) !== 'HO');
    sel.innerHTML = visibleStores.map((s) => `<option value="${s.store_id || s.StoreID}">${s.name || s.Name}</option>`).join('');
    if (!sel.value && visibleStores[0]) sel.value = visibleStores[0].store_id || visibleStores[0].StoreID;
  };
  paint();
  const res = await api('/api/auth/stores');
  if (Array.isArray(res) && res.length) {
    STORES = res.filter(s => (s.store_id || s.StoreID) !== 'HO');
    localStorage.setItem('anta_stores_v4', JSON.stringify(STORES));
    paint();
    setOnline('online', 'Server reachable');
  } else {
    setOnline('offline', 'Server unreachable');
  }
}

function pinPress(d) {
  if (pinEntry.length >= 4) return;
  pinEntry += d;
  document.getElementById('pin-display').textContent = '●'.repeat(pinEntry.length) + '—'.repeat(4 - pinEntry.length);
}
function pinClear() {
  pinEntry = pinEntry.slice(0, -1);
  document.getElementById('pin-display').textContent = '●'.repeat(pinEntry.length) + '—'.repeat(4 - pinEntry.length);
}
async function pinSubmit() {
  const err = document.getElementById('login-error');
  if (!pinEntry) {
    if (err) { err.style.display = 'block'; err.textContent = 'Enter PIN'; }
    return;
  }
  const storeSel = document.getElementById('login-store');
  const storeId = (storeSel && storeSel.value) || (STORES[0] && (STORES[0].store_id || STORES[0].StoreID)) || 's1';
  if (storeSel && !storeSel.value && STORES.length) {
    storeSel.value = storeId;
  }
  const storeName = ((STORES.find((s) => (s.store_id || s.StoreID) === storeId) || {}).name
    || (STORES.find((s) => (s.store_id || s.StoreID) === storeId) || {}).Name
    || storeId);
  setOnline('syncing', 'Authenticating...');
  const res = await api('/api/auth/login', { method: 'POST', body: { store_id: storeId, pin: pinEntry } });
  const token = res && (res.access_token || res.accessToken);
  if (token && res.user) {
    CFG.token = token;
    localStorage.setItem('anta_token', CFG.token);
    doLogin(res.user, storeId, res.user.storeName || storeName);
    return;
  }
  if (err) {
    err.style.display = 'block';
    err.textContent = (res && (res.detail || res.msg)) || 'Wrong PIN';
  }
  pinEntry = '';
  const pd = document.getElementById('pin-display');
  if (pd) pd.textContent = '----';
  setOnline('online', 'Wrong PIN');
}
function applyProfitVisibility() {
  // Profit is a company-financial number — only meaningful to whoever
  // manages the money (admin/accountant). Cashiers and store managers
  // don't need to see it while ringing up sales.
  const role = (USER && USER.role) || 'cashier';
  const canSeeProfit = role === 'admin' || role === 'accountant';
  document.querySelectorAll('.profit-col').forEach((el) => { el.style.display = canSeeProfit ? '' : 'none'; });
}
function doLogin(user, storeId, storeName) {
  USER = user || {};
  window.USER = USER;
  currentUser = USER;
  DB.settings.storeId = USER.storeId || storeId;
  DB.settings.storeName = USER.storeName || storeName;
  applyProfitVisibility();
  const ls = document.getElementById('login-screen'); if (ls) ls.style.display = 'none';
  const app = document.getElementById('app'); if (app) app.style.display = 'flex';
  const sb = document.getElementById('sb-store'); if (sb) sb.textContent = DB.settings.storeName;
  const un = document.getElementById('user-name'); if (un) un.textContent = USER.name || 'User';
  const ur = document.getElementById('user-role'); if (ur) ur.textContent = USER.role || 'cashier';
  try { applyLang(); } catch (e) {}
  try { applyRoleUI(); } catch (e) {}
  try { checkLicense(); } catch (e) {}
  document.getElementById('shift-t').textContent = new Date().toTimeString().slice(0, 5);
  initApp();
}
function logout() {
  if (!confirm('Log out?')) return;
  currentUser = null;
  pinEntry = '';
  CFG.token = '';
  localStorage.removeItem('anta_token');
  cart = [];
  document.getElementById('pin-display').textContent = '----';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-error').style.display = 'none';
}

/* ---------- NAV ---------- */
/* ---------- DAY-END CASH HANDOVER ---------- */
async function generateHandover() {
  const box = document.getElementById('handover-preview');
  box.innerHTML = '<div style="text-align:center;padding:14px;color:var(--gray4);font-size:12px">⏳ Calculating today\'s totals…</div>';
  const res = await api('/api/handover/submit', { method: 'POST', body: {} });
  if (!res || !res.ok) {
    box.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#b91c1c;font-size:12px">❌ ${(res && (res.detail || res.msg)) || 'Failed to generate handover'}</div>`;
    return;
  }
  renderHandoverCard(res.handover, box);
  toast('✅ Handover ' + res.handover.handoverId + ' submitted');
  loadHandoverHistory();
}
function renderHandoverCard(h, target) {
  const bankRows = (h.bankSales || []).map((b) => `<tr><td>${b.bank}</td><td style="text-align:right">${fmt2(b.amount)}</td></tr>`).join('');
  const statusBadge = h.status === 'received'
    ? `<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">✅ RECEIVED by ${h.receivedBy} · ${h.receivedAt}</span>`
    : `<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">⏳ PENDING — waiting for accountant</span>`;
  const varianceRow = h.status === 'received'
    ? `<div style="display:flex;justify-content:space-between;margin-top:6px;font-size:12px"><span>Counted cash</span><b>${fmt2(h.countedCash)}</b></div>
       <div style="display:flex;justify-content:space-between;font-size:12px;color:${Math.abs(h.variance) < 0.01 ? 'var(--green)' : (h.variance < 0 ? 'var(--red)' : 'var(--amber)')}"><span>Variance</span><b>${h.variance >= 0 ? '+' : ''}${fmt2(h.variance)}</b></div>
       ${h.varianceNotes ? `<div style="font-size:11px;color:var(--gray4);margin-top:4px">Note: ${h.varianceNotes}</div>` : ''}`
    : '';
  window.__lastHandover = h;
  target.innerHTML = `
    <div style="border:1.5px solid var(--gray2);border-radius:10px;padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:800;color:var(--navy)">${h.handoverId}</div>
        ${statusBadge}
      </div>
      <div style="font-size:11px;color:var(--gray4);margin-bottom:10px">${h.date} · ${h.storeName} · submitted by ${h.submittedBy} at ${h.submittedAt}</div>
      <table style="width:100%;font-size:12px">
        <tr><td>Invoices</td><td style="text-align:right">${h.invoiceCount}</td></tr>
        <tr><td>Units sold</td><td style="text-align:right">${h.unitsSold}</td></tr>
        <tr><td>Total sales</td><td style="text-align:right;font-weight:700">${fmt2(h.totalSales)}</td></tr>
        <tr><td style="font-weight:700">💵 Cash sales</td><td style="text-align:right;font-weight:700;color:var(--green)">${fmt2(h.cashSales)}</td></tr>
        ${bankRows}
        <tr><td>Returns (info)</td><td style="text-align:right">${fmt2(h.returnsTotal)}</td></tr>
      </table>
      ${varianceRow}
      <button class="btn btn-ghost btn-sm btn-full" style="margin-top:10px" onclick="printHandover(window.__lastHandover)">🖨️ Print (with signature)</button>
    </div>`;
}
function printHandover(h) {
  if (!h) { toast('Nothing to print', 'error'); return; }
  const brand = window.__brandName || 'ANTA Shoes';
  const bankRows = (h.bankSales || []).map((b) => `<tr><td>${b.bank}</td><td style="text-align:right">${fmt2(b.amount)}</td></tr>`).join('');
  const printedAt = new Date().toLocaleString();
  document.getElementById('handover-print-modal').innerHTML = `
    <div style="max-width:380px;margin:20px auto;font-family:Arial,sans-serif;font-size:13px;color:#111">
      <div style="text-align:center;margin-bottom:12px">
        <div style="font-size:20px;font-weight:900">${brand}</div>
        <div style="font-size:13px;font-weight:700;margin-top:2px">Day-End Cash Handover</div>
        <div style="font-size:11px;color:#555">${h.storeName} · ${h.date}</div>
        <div style="font-size:11px;color:#555">Handover ID: ${h.handoverId}</div>
      </div>
      <div style="border-top:1px dashed #999;border-bottom:1px dashed #999;padding:8px 0;margin-bottom:10px">
        <table style="width:100%">
          <tr><td>Invoices</td><td align="right">${h.invoiceCount}</td></tr>
          <tr><td>Units sold</td><td align="right">${h.unitsSold}</td></tr>
          <tr><td>Total Sales</td><td align="right"><b>${fmt2(h.totalSales)}</b></td></tr>
          <tr><td><b>Cash Sales</b></td><td align="right"><b>${fmt2(h.cashSales)}</b></td></tr>
          ${bankRows}
          <tr><td>Returns (info)</td><td align="right">${fmt2(h.returnsTotal)}</td></tr>
        </table>
      </div>
      <div style="font-size:11px;color:#555;margin-bottom:18px">Submitted by ${h.submittedBy} at ${h.submittedAt}</div>

      <div style="margin-top:24px">
        <div style="margin-bottom:26px">
          <div style="border-bottom:1px solid #333;height:22px"></div>
          <div style="font-size:11px;margin-top:3px">Handed Over By (Cashier) — Name &amp; Signature</div>
        </div>
        <div style="margin-bottom:26px">
          <div style="border-bottom:1px solid #333;height:22px"></div>
          <div style="font-size:11px;margin-top:3px">Received By (Accountant) — Name &amp; Signature</div>
        </div>
        <table style="width:100%;font-size:11px;margin-top:6px">
          <tr><td style="width:50%">Cash Counted: ______________</td><td>Date/Time: ______________</td></tr>
          <tr><td colspan="2" style="padding-top:14px">Notes / Variance: __________________________________</td></tr>
        </table>
      </div>
      <div style="text-align:center;margin-top:20px;font-size:9px;color:#999">Printed ${printedAt}</div>
    </div>`;
  setTimeout(() => window.print(), 50);
}
function fmt2(n) { return (Number(n) || 0).toFixed(2); }
async function loadHandoverHistory() {
  const el = document.getElementById('handover-history');
  el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--gray4);font-size:12px">⏳ Loading…</div>';
  const res = await api('/api/handover/mine');
  if (!res || !res.data) { el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--gray3);font-size:12px">Failed to load</div>'; return; }
  if (!res.data.length) { el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--gray3);font-size:12px">No handovers submitted yet</div>'; return; }
  window.__handoverHistory = res.data;
  el.innerHTML = res.data.map((h, i) => {
    const badge = h.status === 'received'
      ? `<span style="background:#dcfce7;color:#166534;padding:1px 7px;border-radius:9px;font-size:9px;font-weight:700">RECEIVED</span>`
      : `<span style="background:#fef3c7;color:#92400e;padding:1px 7px;border-radius:9px;font-size:9px;font-weight:700">PENDING</span>`;
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--gray1);font-size:12px">
      <div><b>${h.date}</b> · ${h.handoverId}<br><span style="color:var(--gray4);font-size:10px">Cash ${fmt2(h.cashSales)} · Total ${fmt2(h.totalSales)}</span></div>
      <div style="display:flex;align-items:center;gap:6px">${badge}<button class="btn btn-ghost btn-sm" onclick="printHandover(window.__handoverHistory[${i}])">🖨️</button></div>
    </div>`;
  }).join('');
}

function show(name) {
  if(window.__screenTitles && window.__screenTitles[name]){ /* i18n titles */ }
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const s = document.getElementById('screen-' + name);
  if (s) s.classList.add('active');
  document.querySelectorAll('.nav-item').forEach((n) => {
    if (n.getAttribute('onclick') && n.getAttribute('onclick').includes("'" + name + "'")) n.classList.add('active');
  });
  const titles = Object.assign({dashboard:'Dashboard',sale:'New Sale',returns:'Returns',exchange:'Exchange',claims:'Claims',grn:'Receive Stock (GRN)',inventory:'Inventory',reports:'Reports',handover:'Day End / Cash Handover',settings:'Settings'}, window.__screenTitles||{});
  document.getElementById('screen-title').textContent = titles[name] || name;
  if (name === 'dashboard') renderDash();
  if (name === 'sale') {
    renderQuick();
    setTimeout(() => document.getElementById('bc-input').focus(), 80);
  }
  if (name === 'inventory') renderInv();
  if (name === 'reports') {
    rptPreset();
    loadReports();
  }
  if (name === 'grn') { grnActiveTab = 'pending'; switchGRNTab('pending'); }
  if (name === 'returns') renderRetList();
  if (name === 'handover') loadHandoverHistory();
  if (name === 'settings') {
    document.getElementById('api-url').value = CFG.apiUrl;
    document.getElementById('s-name').value = DB.settings.storeName || '';
    document.getElementById('s-policy').value = DB.settings.policy || '';
    renderBanksList();
    updateActivityLog();
  }
  const sb = document.getElementById('sidebar');
  if (sb) sb.classList.remove('open');
}

/* ---------- CATALOG / STOCK ---------- */
function getProd(bc) {
  const v = (bc || '').toLowerCase();
  return DB.products.find((p) => p.barcode === bc || (p.name || '').toLowerCase().includes(v));
}
function getStock(bc) {
  const p = DB.products.find((pr) => pr.barcode === bc);
  if (!p) return 0;
  if (typeof p.stock === 'number') return p.stock;
  return p.opening || 0;
}
function adjustLocalStock(barcode, delta) {
  const p = DB.products.find((pr) => pr.barcode === barcode);
  if (p && typeof p.stock === 'number') p.stock = Math.max(0, p.stock + delta);
}

async function reloadCatalog() {
  setOnline('syncing', 'Loading catalog...');
  const [prods, banks, settings] = await Promise.all([
    api('/api/products'),
    api('/api/banks'),
    api('/api/settings'),
  ]);
  if (Array.isArray(prods)) {
    DB.products = prods.map((r) => ({
      id: 'P' + r.barcode,
      barcode: String(r.barcode || '').trim(),
      name: String(r.name || '').trim(),
      brand: r.brand || 'ANTA',
      category: r.category || 'Footwear',
      size: r.size || '',
      cost: +r.cost || 0,
      retail: +r.retail || 0,
      reorder: +r.reorder || 5,
      opening: +r.opening || 0,
      stock: typeof r.stock === 'number' ? r.stock : +r.opening || 0,
      active: r.active === false || r.active === 'N' ? 'N' : 'Y',
    }));
    addLog('products', '✅ ' + DB.products.length);
  } else if (!DB.products.length) {
    // Couldn't reach the server AND nothing loaded yet this session —
    // fall back to whatever was cached from the last successful load, so
    // POS can still scan/sell instead of showing an empty catalog.
    if (loadCatalogCache()) toast('📴 Offline — using last saved catalog', 'warn');
  }
  if (Array.isArray(banks)) {
    BANKS = banks.map((b) => ({
      id: b.bank_id,
      name: b.name,
      device: b.device || '',
      active: b.active === false ? 'N' : 'Y',
      ico: b.icon || (b.name === 'Cash' ? '💵' : '🏦'),
    }));
    populatePaySelects();
    renderBanksList();
    addLog('banks', '✅ ' + BANKS.length);
  }
  if (settings && settings.ok) {
    DB.settings.policy = settings.policy || DB.settings.policy;
    DB.settings.currency = settings.currency || 'LYD';
    applyBranding(settings);
  }
  if (Array.isArray(prods) && DB.products.length) saveCatalogCache();
  // recent data
  await Promise.all([loadLocalSales(), loadLocalReturns()]);
  setOnline('online', 'Catalog ready');
  renderQuick();
  renderDash();
  toast(t('catalog_loaded') + ' (' + DB.products.length + ' products)');
  updatePendingSyncBadge();
}

async function ensureStock() {
  const res = await api('/api/inventory/ensure', { method: 'POST' });
  if (res && res.ok) {
    toast(t('store_init'));
    await reloadCatalog();
  } else toast('❌ ' + (res && res.msg ? res.msg : 'Failed'), 'error');
}

async function loadLocalSales() {
  const res = await api('/api/sales?limit=200');
  if (res && res.data) {
    DB.transactions = res.data.map((t) => ({ ...t, type: 'sale', synced: true }));
  }
}
async function loadLocalReturns() {
  const res = await api('/api/returns?limit=100');
  if (res && res.data) DB.returns = res.data.map((r) => ({ ...r, synced: true }));
}

/* ---------- DASHBOARD ---------- */
/* ---------- SALES REPORT — WhatsApp/Email with saved recipients ---------- */
let _reportVia = null;
let _lastReportData = null;
function _getRecipients(via) {
  try { return JSON.parse(localStorage.getItem('anta_recipients_' + via) || '[]'); } catch (e) { return []; }
}
function _saveRecipients(via, arr) {
  localStorage.setItem('anta_recipients_' + via, JSON.stringify(arr));
}
function openRecipientPicker(via) {
  _reportVia = via;
  document.getElementById('recipient-picker-title').textContent = via === 'whatsapp' ? '📤 Send Sales Report — WhatsApp' : '✉️ Send Sales Report — Email';
  document.getElementById('new-recipient-input').placeholder = via === 'whatsapp' ? 'Add number (e.g. 218912345678)' : 'Add email address';
  renderRecipientList();
  document.getElementById('recipient-picker').style.display = 'flex';
}
function closeRecipientPicker() {
  document.getElementById('recipient-picker').style.display = 'none';
}
function renderRecipientList() {
  const list = _getRecipients(_reportVia);
  const el = document.getElementById('recipient-list');
  if (!list.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--gray4);padding:8px 0">No saved recipients yet — add one below.</div>';
    return;
  }
  el.innerHTML = list.map((r, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--gray1)">
      <input type="checkbox" id="recip-${i}" checked>
      <label for="recip-${i}" style="flex:1;font-size:13px">${r}</label>
      <button class="btn btn-ghost btn-sm" style="color:var(--red);padding:2px 7px" onclick="removeRecipient(${i})">✕</button>
    </div>`).join('');
}
function addRecipient() {
  const input = document.getElementById('new-recipient-input');
  const val = (input.value || '').trim();
  if (!val) return;
  const list = _getRecipients(_reportVia);
  if (!list.includes(val)) { list.push(val); _saveRecipients(_reportVia, list); }
  input.value = '';
  renderRecipientList();
}
function removeRecipient(i) {
  const list = _getRecipients(_reportVia);
  list.splice(i, 1);
  _saveRecipients(_reportVia, list);
  renderRecipientList();
}
async function confirmSendReport() {
  const list = _getRecipients(_reportVia);
  const selected = list.filter((_, i) => document.getElementById('recip-' + i) && document.getElementById('recip-' + i).checked);
  if (!selected.length) { toast('Select at least one recipient', 'error'); return; }
  closeRecipientPicker();
  await sendSalesReport(_reportVia, selected);
}
async function sendSalesReport(via, recipients) {
  toast('⏳ Preparing report…', 'info');
  const todayStr = new Date().toISOString().slice(0, 10);
  const res = await api('/api/reports?from=' + todayStr + '&to=' + todayStr);
  const rev = (res && res.revenue) || 0;
  const inv = (res && res.invoices) || 0;
  const units = (res && res.units) || 0;
  const pay = (res && res.paymentBreakdown) || {};
  const txns = (res && res.transactions) || [];
  const storeName = DB.settings.storeName || 'Store';
  const now = new Date();

  // Build the actual Excel file — this is the real report; the
  // WhatsApp/email message is just a short heads-up with the numbers,
  // since neither wa.me nor mailto: links support attaching a file
  // automatically (browser/WhatsApp security limitation, not something
  // this app can bypass for free) — so the file downloads, and you
  // attach it in the chat/email with one extra tap.
  const summarySheet = [
    ['Sales Report', storeName],
    ['Date', now.toLocaleDateString()],
    [],
    ['Invoices', inv],
    ['Units Sold', units],
    ['Total Revenue', rev],
    [],
    ['Payment Method', 'Amount'],
    ...Object.entries(pay).map(([k, v]) => [k, v]),
  ];
  const txnSheet = [['Invoice', 'Time', 'Customer', 'Items', 'Units', 'Payment', 'Total']]
    .concat(txns.map((t) => [t.id, t.time, t.customer, t.items, t.units, t.payment, t.total]));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summarySheet), 'Summary');
  const roleForExport = (USER && USER.role) || 'cashier';
  const canSeeProfitExport = roleForExport === 'admin' || roleForExport === 'accountant';
  const items = (res && res.productBreakdown) || [];
  const itemsHeader = canSeeProfitExport ? ['Barcode', 'Product', 'Qty', 'Revenue', 'Cost', 'Profit'] : ['Barcode', 'Product', 'Qty', 'Revenue'];
  const itemsSheet = [itemsHeader].concat(
    items.map((p) => canSeeProfitExport
      ? [p.barcode, p.name, p.qty, p.revenue, p.cost, p.profit]
      : [p.barcode, p.name, p.qty, p.revenue])
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(itemsSheet), 'Items Sold');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(txnSheet), 'Transactions');
  XLSX.writeFile(wb, 'sales_report_' + storeName.replace(/[^a-z0-9]/gi, '_') + '_' + todayStr + '.xlsx');

  const payLines = Object.entries(pay).map(([k, v]) => `  ${k}: ${fmt2(v)}`).join('\n') || '  —';
  const text =
    `📊 Sales Report — ${storeName}\n${now.toLocaleDateString()} ${now.toLocaleTimeString()}\n\n` +
    `Invoices: ${inv}\nUnits sold: ${units}\nTotal Revenue: ${fmt2(rev)}\n\nPayment breakdown:\n${payLines}\n\n` +
    `📎 Full Excel report downloaded — please attach it here.`;

  if (via === 'whatsapp') {
    recipients.forEach((number, i) => {
      setTimeout(() => {
        window.open('https://wa.me/' + number.replace(/[^0-9]/g, '') + '?text=' + encodeURIComponent(text), '_blank');
      }, i * 400); // stagger so browsers don't block multiple popups at once
    });
    if (recipients.length > 1) toast('If some chats didn\'t open, allow pop-ups for this site and try again', 'warn');
  } else {
    window.location.href = 'mailto:' + recipients.join(',') + '?subject=' + encodeURIComponent('Sales Report — ' + storeName + ' — ' + now.toLocaleDateString()) + '&body=' + encodeURIComponent(text);
  }
}
async function renderDash() {
  const todayStr = new Date().toISOString().slice(0, 10);
  // Use the SAME endpoint the Reports screen uses for the numbers, so
  // the dashboard can never disagree with Reports — that mismatch was
  // the bug. /api/dashboard is only used afterward, for low-stock (which
  // Reports doesn't provide).
  const rpt = await api('/api/reports?from=' + todayStr + '&to=' + todayStr);
  if (rpt && rpt.ok) {
    const d = today();
    const retCount = DB.returns.filter((r) => r.date === d).length;
    const pm = rpt.paymentBreakdown || {};
    const cashAmt = pm['Cash'] || 0;
    document.getElementById('d-sales').textContent = fmt(rpt.revenue || 0);
    document.getElementById('d-inv').textContent = (rpt.invoices || 0) + ' invoices';
    document.getElementById('d-net').textContent = fmt(rpt.net || 0);
    document.getElementById('d-qty').textContent = rpt.units || 0;
    document.getElementById('d-atv').textContent = fmt(rpt.atv || 0);
    document.getElementById('d-ret').textContent = fmt(rpt.returns || 0);
    document.getElementById('d-retc').textContent = retCount + ' returns';
    document.getElementById('d-cash').textContent = fmt(cashAmt);
    const recent = (rpt.transactions || []).slice(0, 7);
    document.getElementById('d-txns').innerHTML =
      recent.map((t) => `<tr><td class="fw7">${t.id}</td><td>${t.time || ''}</td><td>${t.customer || ''}</td><td>${t.payment || ''}</td><td class="fw7">${fmt(t.total || 0)}</td></tr>`).join('') ||
      '<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:14px">No sales yet</td></tr>';
  } else {
    // Couldn't reach the server at all — compute from what's already
    // loaded locally, so the dashboard shows real numbers instead of
    // zeros baked into the HTML.
    const d = today();
    const tt = DB.transactions.filter((t) => t.date === d);
    const ts = tt.reduce((s, t) => s + (+t.total || 0), 0);
    const cashTs = tt.filter((t) => (t.payment || '') === 'Cash').reduce((s, t) => s + (+t.total || 0), 0);
    let qty = 0;
    tt.forEach((t) => { (t.items || []).forEach((i) => { qty += +i.qty || 0; }); });
    const retToday = DB.returns.filter((r) => r.date === d).reduce((s, r) => s + (+r.amount || 0), 0);
    document.getElementById('d-sales').textContent = fmt(ts);
    document.getElementById('d-inv').textContent = tt.length + ' invoices';
    document.getElementById('d-net').textContent = fmt(ts - retToday);
    document.getElementById('d-qty').textContent = qty;
    document.getElementById('d-atv').textContent = fmt(tt.length ? ts / tt.length : 0);
    document.getElementById('d-ret').textContent = fmt(retToday);
    document.getElementById('d-retc').textContent = DB.returns.filter((r) => r.date === d).length + ' returns';
    document.getElementById('d-cash').textContent = fmt(cashTs);
    const recent = DB.transactions.slice(0, 7);
    document.getElementById('d-txns').innerHTML =
      recent.map((t) => `<tr><td class="fw7">${t.id}</td><td>${t.time || ''}</td><td>${t.customer || ''}</td><td>${t.payment || ''}</td><td class="fw7">${fmt(t.total || 0)}</td></tr>`).join('') ||
      '<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:14px">No sales yet</td></tr>';
  }

  const res = await api('/api/dashboard');
  if (res && res.ok) {
    const low = res.lowStock || [];
    document.getElementById('low-badge').textContent = low.length;
    document.getElementById('d-low').innerHTML =
      low
        .slice(0, 5)
        .map((p) => {
          const s = p.onHand;
          return `<div style="padding:5px 0;border-bottom:1px solid var(--gray1);display:flex;justify-content:space-between;font-size:11px"><span style="font-weight:600;flex:1">${(p.name || '').slice(0, 28)}</span><span class="badge ${s <= 0 ? 'badge-red' : 'badge-amber'}">${s <= 0 ? 'OUT' : s}</span></div>`;
        })
        .join('') || '<div style="color:var(--gray3);font-size:11px;padding:8px">All stock OK ✅</div>';
  }

  // queue UI legacy hide
  const qc = document.getElementById('q-count');
  if (qc) qc.textContent = '0';
  const bar = document.getElementById('q-bar');
  if (bar) bar.classList.add('hidden');
}

/* ---------- SALE ---------- */
function renderQuick() {
  const _sp = DB.settings.storeId ? DB.settings.storeId.toUpperCase() : 'S1';
  document.getElementById('inv-num').textContent = _sp + '-AUTO';
  const d = document.getElementById('quick-prods');
  d.innerHTML = DB.products
    .filter((p) => p.active !== 'N')
    .map((p) => {
      const s = getStock(p.barcode);
      return `<div onclick="addToCart('${p.barcode}')" style="padding:9px;border:1.5px solid var(--gray2);border-radius:8px;cursor:pointer;transition:.15s;background:#fff" onmouseover="this.style.borderColor='var(--accent2)';this.style.background='#f0f7ff'" onmouseout="this.style.borderColor='var(--gray2)';this.style.background='#fff'"><div style="font-size:10px;font-weight:700;color:var(--navy);margin-bottom:1px">${p.name}</div><div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:12px;font-weight:800;color:var(--accent)">${fmt(p.retail)}</span><span class="badge ${s <= 0 ? 'badge-red' : s <= p.reorder ? 'badge-amber' : 'badge-green'}">${s <= 0 ? 'OUT' : s}</span></div></div>`;
    })
    .join('');
}
function searchProd(v) {
  const sr = document.getElementById('search-drop');
  if (!v || v.length < 2) {
    sr.style.display = 'none';
    return;
  }
  const m = DB.products
    .filter((p) => p.barcode.includes(v) || p.name.toLowerCase().includes(v.toLowerCase()))
    .slice(0, 6);
  if (!m.length) {
    sr.style.display = 'none';
    return;
  }
  sr.innerHTML = m
    .map((p) => {
      const s = getStock(p.barcode);
      return `<div class="search-item" onclick="addToCart('${p.barcode}');document.getElementById('bc-input').value='';document.getElementById('search-drop').style.display='none'"><div><div style="font-size:11px;font-weight:700;color:var(--navy)">${p.name}</div><div style="font-size:9px;color:var(--gray4)">${p.barcode} · Stock: ${s}</div></div><div style="font-size:12px;font-weight:800;color:var(--accent);margin-left:auto">${fmt(p.retail)}</div></div>`;
    })
    .join('');
  sr.style.display = 'block';
}
function bcKey(e) {
  if (e.key === 'Enter') {
    const v = e.target.value.trim();
    if (v) {
      addToCart(v);
      e.target.value = '';
      document.getElementById('search-drop').style.display = 'none';
    }
  }
}
function addToCart(bc) {
  const p = DB.products.find((pr) => pr.barcode === bc || pr.name.toLowerCase() === bc.toLowerCase());
  if (!p) {
    toast(t('not_found') + ' ' + bc, 'error');
    return;
  }
  const s = getStock(p.barcode);
  if (s <= 0) {
    toast('⚠️ Out of stock', 'warn');
    return;
  }
  const ex = cart.find((i) => i.barcode === p.barcode);
  if (ex) {
    if (ex.qty >= s) {
      toast(t('max_stock') + ' ' + s, 'warn');
      return;
    }
    ex.qty++;
  } else {
    cart.push({
      barcode: p.barcode,
      name: p.name,
      qty: 1,
      price: p.retail,
      cost: parseFloat(p.cost) || 0,
      discount: 0,
    });
  }
  renderCart();
  toast('✅ ' + p.name.slice(0, 25));
}
function renderCart() {
  const ci = document.getElementById('cart-items');
  if (!cart.length) {
    ci.innerHTML =
      '<div class="cart-empty"><div style="font-size:44px">🛒</div><div style="font-weight:700;color:var(--gray3)">Cart empty</div></div>';
  } else {
    ci.innerHTML = cart
      .map(
        (item, idx) =>
          `<div class="cart-item"><div style="flex:1"><div style="font-size:11px;font-weight:700;color:var(--navy)">${item.name}</div><div style="font-size:10px;color:var(--gray4)">${fmt(item.price)} · <input type="number" value="${item.discount}" min="0" max="100" style="width:35px;font-size:9px;border:1px solid var(--gray2);border-radius:3px;padding:1px 3px" onchange="cart[${idx}].discount=+this.value;refreshPromoPricing().then(()=>calcCart())">% disc</div></div><div style="display:flex;align-items:center;gap:5px"><button class="qty-btn" onclick="chQty(${idx},-1)">−</button><span style="font-weight:700;min-width:18px;text-align:center">${item.qty}</span><button class="qty-btn" onclick="chQty(${idx},1)">+</button></div><div style="text-align:right"><div style="font-size:12px;font-weight:700;color:var(--navy)">${fmt(item.price * item.qty * (1 - item.discount / 100))}</div><div style="font-size:9px;cursor:pointer;color:var(--red)" onclick="cart.splice(${idx},1);renderCart()">✕</div></div></div>`
      )
      .join('');
  }
  calcCart();
}
function chQty(idx, d) {
  const item = cart[idx];
  const s = getStock(item.barcode);
  const n = item.qty + d;
  if (n <= 0) {
    cart.splice(idx, 1);
    renderCart();
    refreshPromoPricing().then(()=>calcCart());
    return;
  }
  if (n > s) {
    toast(t('max_stock') + ' ' + s, 'warn');
    return;
  }
  item.qty = n;
  renderCart();
  refreshPromoPricing().then(()=>calcCart());
}
function clearCart() {
  window.__promoQuote = null;
  if (cart.length && confirm('Clear cart?')) {
    cart = [];
    setVal('g-disc', 0);
    renderCart();
  }
}
function calcCart() {
  const disc = +getVal('g-disc', 0) || 0;
  const sub = cart.reduce((s, i) => s + i.price * i.qty * (1 - i.discount / 100), 0);
  const da = (sub * disc) / 100;
  const total = sub - da;
  const el = (id) => document.getElementById(id);
  if (el('c-sub')) el('c-sub').textContent = fmt(sub);
  if (el('c-disc')) el('c-disc').textContent = '-' + fmt(da);
  if (el('c-total')) el('c-total').textContent = fmt(total);
  return { sub, da, total, disc };
}
function openPay() {
  if (!cart.length) {
    toast('❌ Cart empty', 'error');
    return;
  }
  const { total } = calcCart();
  document.getElementById('pay-due').textContent = fmt(total);
  const pg = document.getElementById('pay-grid');
  pg.innerHTML = BANKS.filter((b) => b.active !== 'N')
    .map(
      (b) =>
        `<div class="pay-method ${b.name === selPay ? 'selected' : ''}" onclick="setPay('${b.name}')"><span class="pay-ico">${b.ico || '💳'}</span>${b.name}${b.device ? `<div style="font-size:8px;opacity:.6">${b.device}</div>` : ''}</div>`
    )
    .join('');
  document.getElementById('cash-sec').style.display = selPay === 'Cash' ? 'block' : 'none';
  document.getElementById('ref-sec').style.display = selPay !== 'Cash' ? 'block' : 'none';
  setVal('cash-rec', '');
  document.getElementById('change-box').style.display = 'none';
  setVal('pay-ref', '');
  document.getElementById('pay-modal').style.display = 'flex';
}
function setPay(m) {
  selPay = m;
  document.querySelectorAll('.pay-method').forEach((el) =>
    el.classList.toggle('selected', el.getAttribute('onclick').includes("'" + m + "'"))
  );
  document.getElementById('cash-sec').style.display = m === 'Cash' ? 'block' : 'none';
  document.getElementById('ref-sec').style.display = m !== 'Cash' ? 'block' : 'none';
}
function calcChange() {
  const { total } = calcCart();
  const r = +getVal('cash-rec', 0) || 0;
  const ch = r - total;
  const cb = document.getElementById('change-box');
  cb.style.display = r > 0 ? 'block' : 'none';
  document.getElementById('change-amt').textContent = fmt(Math.max(ch, 0));
  cb.style.background = ch < 0 ? 'var(--red-light)' : 'var(--green-light)';
  document.getElementById('change-amt').style.color = ch < 0 ? 'var(--red)' : 'var(--green)';
}
function closePay() {
  document.getElementById('pay-modal').style.display = 'none';
}
/* ---------- OFFLINE SALES QUEUE ---------- */
// If a sale can't reach the server (no internet, HO asleep, etc.) it's
// saved locally instead of being lost or blocking the cashier. It's
// queued, the sale completes normally on screen, and it's automatically
// pushed to HO the moment connectivity comes back — either via the
// browser's 'online' event or a periodic retry every 30s as a fallback.
const PENDING_SALES_KEY = 'anta_pending_sales_v1';
function getPendingSales() {
  try { return JSON.parse(localStorage.getItem(PENDING_SALES_KEY) || '[]'); }
  catch (e) { return []; }
}
function savePendingSales(arr) {
  try { localStorage.setItem(PENDING_SALES_KEY, JSON.stringify(arr)); } catch (e) {}
  updatePendingSyncBadge();
}
function queuePendingSale(localId, payload) {
  const arr = getPendingSales();
  arr.push({ localId, payload, queuedAt: Date.now() });
  savePendingSales(arr);
}
function updatePendingSyncBadge() {
  const n = getPendingSales().length;
  const el = document.getElementById('pending-sync-badge');
  if (!el) return;
  // Cashiers don't need to see sync internals — it just adds worry over
  // something they can't act on anyway. Managers/admins can see it since
  // they're the ones who'd care if HO connectivity is flaky.
  const role = (USER && USER.role) || 'cashier';
  const visibleToRole = role === 'admin' || role === 'manager';
  if (n > 0 && visibleToRole) {
    el.style.display = 'block';
    el.textContent = `⏳ ${n} sale(s) waiting to sync`;
  } else {
    el.style.display = 'none';
  }
}
let _syncingPending = false;
async function trySyncPendingSales() {
  if (_syncingPending) return;
  const queue = getPendingSales();
  if (!queue.length) return;
  _syncingPending = true;
  try {
    let synced = 0;
    while (true) {
      const queue2 = getPendingSales();
      if (!queue2.length) break;
      const item = queue2[0];
      const res = await api('/api/sales', { method: 'POST', body: item.payload });
      if (res && res.ok) {
        // Success — drop it from the queue and reconcile the transaction's
        // id in the local list (it was shown with a temporary LOCAL- id).
        const remaining = getPendingSales().filter((q) => q.localId !== item.localId);
        savePendingSales(remaining);
        const txn = res.sale || { ...item.payload, id: res.id, synced: true };
        const idx = DB.transactions.findIndex((t) => t.id === item.localId);
        if (idx >= 0) DB.transactions[idx] = txn;
        synced++;
      } else {
        // Still can't reach the server — stop here (keep order) and try
        // again on the next 'online' event / periodic tick.
        break;
      }
    }
    if (synced) toast(`🔄 ${synced} offline sale(s) synced to HO`, 'ok');
  } finally {
    _syncingPending = false;
  }
}
window.addEventListener('online', () => { setTimeout(trySyncPendingSales, 1500); });
setInterval(trySyncPendingSales, 30000);

/* ---------- OFFLINE CATALOG CACHE ---------- */
// Keeps the last-known catalog/banks/settings on disk so POS can still
// open, scan barcodes, and price a sale correctly even after a full page
// reload with zero internet — not just mid-session.
const CATALOG_CACHE_KEY = 'anta_catalog_cache_v1';
function saveCatalogCache() {
  try {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({
      products: DB.products, banks: (typeof BANKS !== 'undefined' ? BANKS : []), settings: DB.settings, cachedAt: Date.now(),
    }));
  } catch (e) {}
}
function loadCatalogCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) || 'null');
    if (raw && Array.isArray(raw.products) && raw.products.length) {
      DB.products = raw.products;
      if (raw.banks && raw.banks.length) { BANKS = raw.banks; populatePaySelects(); renderBanksList(); }
      return true;
    }
  } catch (e) {}
  return false;
}

async function completeSale() {
  try { await refreshPromoPricing(); } catch(e) {}
  const { sub, da, total, disc } = calcCart();
  if (selPay === 'Cash') {
    const r = +getVal('cash-rec', 0) || 0;
    if (r < total) {
      toast('❌ Insufficient cash', 'error');
      return;
    }
  }
  const payload = {
    customer: getVal('cust-name', '') || 'Walk-in',
    items: cart.map((i) => ({
      barcode: i.barcode,
      name: i.name,
      qty: i.qty,
      price: i.price,
      cost: i.cost,
      discount: i.discount,
      lineTotal: i.price * i.qty * (1 - i.discount / 100),
    })),
    subtotal: (window.__promoQuote && window.__promoQuote.subtotal) || sub,
    globalDiscount: (window.__promoQuote && window.__promoQuote.globalDiscount) || da,
    discount: (window.__promoQuote && window.__promoQuote.discount) || da,
    total: (window.__promoQuote && window.__promoQuote.total != null) ? window.__promoQuote.total : total,
    payment: selPay,
    payRef: getVal('pay-ref', ''),
    type: 'sale',
    storeId: DB.settings.storeId,
    store: DB.settings.storeName,
    date: today(),
    time: timeNow(),
  };
  setOnline('syncing', 'Saving sale...');
  const res = await api('/api/sales', { method: 'POST', body: payload });
  let txn;
  if (res && res.ok) {
    // Normal online path.
    txn = res.sale || { ...payload, id: res.id, synced: true };
  } else if (res && res._http) {
    // Server was reachable and REJECTED the sale (validation error, bad
    // data, etc.) — this is a real problem, not a connectivity one, so
    // the sale must NOT go through silently. Block it like before.
    toast(t('sale_failed') + ' ' + ((res && res.msg) || 'error'), 'error');
    setOnline('online', 'Sale error');
    return;
  } else {
    // Couldn't reach the server at all (offline, HO asleep, network
    // drop). Don't lose the sale or block the cashier — complete it
    // locally with a temporary id, queue it, and sync automatically the
    // moment connectivity returns.
    const localId = 'LOCAL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    txn = { ...payload, id: localId, synced: false };
    queuePendingSale(localId, payload);
    // Cashiers just need to know the sale went through — sync internals
    // aren't their concern and just add worry over something they can't
    // act on. Managers/admins see the fuller picture.
    const role = (USER && USER.role) || 'cashier';
    if (role === 'admin' || role === 'manager') {
      toast('📴 Offline — sale saved locally, will sync automatically when online', 'warn');
    }
  }
  // local stock adjust
  (payload.items || []).forEach((i) => adjustLocalStock(i.barcode, -i.qty));
  DB.transactions.unshift(txn);
  closePay();
  showInvoice(txn);
  cart = [];
  window.__promoQuote = null;
  setVal('g-disc', 0);
  setVal('cust-name', '');
  renderCart();
  renderQuick();
  addLog('sale', (txn.synced === false ? '📴 offline ' : '✅ ') + txn.id);
  {
    const role = (USER && USER.role) || 'cashier';
    const showOfflineDetail = txn.synced === false && (role === 'admin' || role === 'manager');
    setOnline('online', showOfflineDetail ? 'Sale saved offline' : 'Sale saved');
  }
  toast(t('sale_complete') + ' ' + txn.id);
}
function showInvoice(txn) {
  window.__lastInvoiceId = (txn && (txn.id || txn.invoice_id)) || window.__lastInvoiceId;
  const items = txn.items || [];
  const promoNotes = txn.promoNotes || [];
  const money = (n) => fmt(n);
  const brand = window.__brandName || 'ANTA Shoes';
  const logo = window.__brandLogo || '';
  const logoHtml = logo
    ? `<img src="${logo}" style="width:52px;height:52px;object-fit:cover;border-radius:10px;margin:0 auto 8px;display:block">`
    : '';

  const itemRows = items
    .map((i, idx) => {
      const lineTotal = i.lineTotal != null ? i.lineTotal : i.price * i.qty;
      const promoTag = i.promo ? `<div style="font-size:9.5px;color:#0a7a3c;font-weight:700;margin-top:1px">🏷️ ${i.promo}${i.freeQty ? ` — ${i.freeQty} free` : ''}</div>` : '';
      const lineDiscount = i.discount && i.discount > 0 ? `<div style="font-size:9.5px;color:#94a3b8">-${money(i.discount)} off</div>` : '';
      const bg = idx % 2 === 1 ? 'background:#f8fafc' : '';
      return `<tr style="${bg}">
        <td style="padding:7px 4px;vertical-align:top">
          <div style="font-weight:600;color:#1e293b">${i.name}</div>
          ${promoTag}${lineDiscount}
        </td>
        <td style="padding:7px 4px;text-align:center;color:#475569;vertical-align:top">${i.qty}</td>
        <td style="padding:7px 4px;text-align:right;font-weight:700;color:#1e293b;vertical-align:top">${money(lineTotal)}</td>
      </tr>`;
    })
    .join('');

  const discountBlock = txn.discount
    ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#475569"><span>Item Discounts</span><span>-${money(txn.discount)}</span></div>`
    : '';
  const globalDiscountBlock = txn.globalDiscount
    ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#475569"><span>Invoice Discount</span><span>-${money(txn.globalDiscount)}</span></div>`
    : '';
  const promoNotesBlock = promoNotes.length
    ? `<div style="font-size:10.5px;color:#0a7a3c;font-weight:600;margin-top:6px;padding:6px 8px;background:#f0fdf4;border-radius:6px;border:1px solid #bbf7d0">🏷️ Promotions applied: ${promoNotes.join(', ')}</div>`
    : '';

  document.getElementById('inv-content').innerHTML = `
    <div data-invoice-id="${txn.id||''}" style="font-family:Arial,Helvetica,sans-serif;color:#0f172a">
      <div style="text-align:center;padding-bottom:14px;margin-bottom:14px;border-bottom:2.5px solid #0f172a">
        ${logoHtml}
        <div style="font-size:23px;font-weight:900;letter-spacing:.3px">${brand}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">${txn.store || DB.settings.storeName}</div>
        <div style="display:inline-flex;gap:10px;margin-top:8px;font-size:10.5px;color:#64748b;background:#f1f5f9;padding:4px 12px;border-radius:20px">
          <span>${txn.date}</span><span>·</span><span>${txn.time || ''}</span><span>·</span><span style="font-weight:700;color:#0f172a">${txn.id}</span>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;font-size:11.5px;color:#475569;margin-bottom:10px">
        <span>Customer: <b style="color:#0f172a">${txn.customer || 'Walk-in'}</b></span>
        <span>Cashier: <b style="color:#0f172a">${(window.USER&&window.USER.name)||''}</b></span>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:4px">
        <thead>
          <tr style="border-bottom:2px solid #0f172a">
            <th style="text-align:left;padding:5px 4px;font-size:10.5px;letter-spacing:.4px;color:#475569">ITEM</th>
            <th style="text-align:center;padding:5px 4px;font-size:10.5px;letter-spacing:.4px;color:#475569">QTY</th>
            <th style="text-align:right;padding:5px 4px;font-size:10.5px;letter-spacing:.4px;color:#475569">TOTAL</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <div style="border-top:1.5px dashed #cbd5e1;padding-top:10px;margin-top:6px;font-size:12.5px">
        <div style="display:flex;justify-content:space-between;padding:3px 0;color:#475569"><span>Subtotal</span><span>${money(txn.subtotal)}</span></div>
        ${discountBlock}
        ${globalDiscountBlock}
        ${promoNotesBlock}
        <div style="display:flex;justify-content:space-between;align-items:center;background:#0f172a;color:#fff;border-radius:8px;padding:10px 12px;margin-top:10px">
          <span style="font-size:12px;font-weight:600;letter-spacing:.3px">TOTAL</span>
          <span style="font-size:19px;font-weight:900">${money(txn.total)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11.5px;color:#475569">
          <span>Payment Method</span><span style="font-weight:700;color:#0f172a">${txn.payment}${txn.payRef ? ' · Ref ' + txn.payRef : ''}</span>
        </div>
      </div>

      <div style="text-align:center;margin-top:16px;padding-top:12px;border-top:1.5px dashed #cbd5e1;font-size:10px;color:#94a3b8">
        <svg id="inv-barcode" style="max-width:100%"></svg>
        <div style="margin-top:6px">${DB.settings.policy}</div>
        <div style="margin-top:6px;font-weight:600;color:#475569">Thank you for shopping with us! شكراً لزيارتكم</div>
      </div>
    </div>`;
  document.getElementById('inv-modal').style.display = 'flex';
  const barEl = document.getElementById('inv-barcode');
  if (barEl && typeof JsBarcode !== 'undefined') {
    try {
      JsBarcode(barEl, String(txn.id || ''), {
        format: 'CODE128', width: 2, height: 55, displayValue: true,
        fontSize: 13, margin: 4, background: 'transparent', lineColor: '#0f172a',
      });
    } catch (e) {}
  }
}

/* ---------- RETURNS / EXCHANGE / CLAIMS ---------- */
async function doReturn() {
  const bc = document.getElementById('r-bc').value.trim();
  if (!bc) {
    toast('❌ Enter barcode', 'error');
    return;
  }
  const p = getProd(bc);
  const r = {
    date: today(),
    time: timeNow(),
    store: DB.settings.storeName,
    storeId: DB.settings.storeId,
    origInvoice: document.getElementById('r-inv').value,
    barcode: p ? p.barcode : bc,
    productName: p ? p.name : bc,
    qty: +document.getElementById('r-qty').value || 1,
    amount: +document.getElementById('r-amt').value || 0,
    method: document.getElementById('r-method').value,
    reason: document.getElementById('r-reason').value,
  };
  const res = await api('/api/returns', { method: 'POST', body: r });
  if (!res || !res.ok) {
    toast('❌ ' + ((res && res.msg) || 'Failed'), 'error');
    return;
  }
  r.ref = res.ref;
  r.synced = true;
  DB.returns.unshift(r);
  adjustLocalStock(r.barcode, r.qty);
  toast(t('return_ok') + ' ' + r.ref);
  ['r-bc', 'r-inv', 'r-amt'].forEach((id) => (document.getElementById(id).value = ''));
  document.getElementById('r-qty').value = 1;
  renderRetList();
  renderQuick();
}
function renderRetList() {
  document.getElementById('ret-list').innerHTML =
    [...DB.returns]
      .slice(0, 20)
      .map(
        (r) =>
          `<tr><td class="fw7">${r.ref}</td><td>${r.date}</td><td>${r.productName}</td><td>${r.qty}</td><td class="fw7 text-red">-${fmt(r.amount)}</td><td><span class="badge badge-green">DB</span></td></tr>`
      )
      .join('') ||
    '<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:14px">No returns</td></tr>';
}
function exLookup(side, v) {
  const p = getProd(v);
  document.getElementById('ex-' + side + '-nm').textContent = p ? '✅ ' + p.name : v.length > 2 ? '❌ Not found' : '';
  if (p) document.getElementById('ex-' + side + '-pr').value = p.retail;
  exCalc();
}
function exCalc() {
  const op = (+document.getElementById('ex-old-pr').value || 0) * (+document.getElementById('ex-old-qty').value || 1);
  const np = (+document.getElementById('ex-new-pr').value || 0) * (+document.getElementById('ex-new-qty').value || 1);
  const d = np - op;
  document.getElementById('ex-diff').textContent = fmt(Math.abs(d));
  document.getElementById('ex-diff').style.color = d > 0 ? 'var(--red)' : d < 0 ? 'var(--green)' : 'var(--navy)';
  document.getElementById('ex-diff-note').textContent = d > 0 ? '⬆ Customer pays' : d < 0 ? '⬇ Refund' : 'No diff';
}
async function doExchange() {
  const ob = document.getElementById('ex-old-bc').value.trim();
  const nb = document.getElementById('ex-new-bc').value.trim();
  if (!ob || !nb) {
    toast('❌ Enter both barcodes', 'error');
    return;
  }
  const op = getProd(ob);
  const np = getProd(nb);
  const diff =
    +document.getElementById('ex-new-pr').value * +document.getElementById('ex-new-qty').value -
    +document.getElementById('ex-old-pr').value * +document.getElementById('ex-old-qty').value;
  const ex = {
    date: today(),
    time: timeNow(),
    store: DB.settings.storeName,
    storeId: DB.settings.storeId,
    customer: document.getElementById('ex-cust').value || 'Walk-in',
    oldBarcode: op ? op.barcode : ob,
    oldName: op ? op.name : ob,
    oldQty: +document.getElementById('ex-old-qty').value,
    newBarcode: np ? np.barcode : nb,
    newName: np ? np.name : nb,
    newQty: +document.getElementById('ex-new-qty').value,
    diff,
    payment: document.getElementById('ex-pay').value,
  };
  const res = await api('/api/exchanges', { method: 'POST', body: ex });
  if (!res || !res.ok) {
    toast('❌ ' + ((res && res.msg) || 'Failed'), 'error');
    return;
  }
  toast(t('exchange_ok') + ' ' + res.ref);
  adjustLocalStock(ex.oldBarcode, ex.oldQty);
  adjustLocalStock(ex.newBarcode, -ex.newQty);
  ['ex-old-bc', 'ex-new-bc', 'ex-cust', 'ex-old-pr', 'ex-new-pr'].forEach((id) => (document.getElementById(id).value = ''));
  ['ex-old-qty', 'ex-new-qty'].forEach((id) => (document.getElementById(id).value = 1));
  ['ex-old-nm', 'ex-new-nm'].forEach((id) => (document.getElementById(id).textContent = ''));
  document.getElementById('ex-diff').textContent = 'LYD 0.00';
  renderQuick();
}
function clLookup(v) {
  const p = getProd(v);
  document.getElementById('cl-name').value = p ? p.name : '';
  document.getElementById('cl-val').value = p ? (p.cost * (+document.getElementById('cl-qty').value || 1)).toFixed(2) : '';
}
async function doClaim() {
  const bc = document.getElementById('cl-bc').value.trim();
  if (!bc) {
    toast('❌ Enter barcode', 'error');
    return;
  }
  const p = getProd(bc);
  const qty = +document.getElementById('cl-qty').value || 1;
  const cl = {
    date: today(),
    time: timeNow(),
    store: DB.settings.storeName,
    storeId: DB.settings.storeId,
    barcode: p ? p.barcode : bc,
    productName: p ? p.name : bc,
    qty,
    type: document.getElementById('cl-type').value,
    value: p ? p.cost * qty : 0,
    supplier: document.getElementById('cl-sup').value,
  };
  const res = await api('/api/claims', { method: 'POST', body: cl });
  if (!res || !res.ok) {
    toast('❌ ' + ((res && res.msg) || 'Failed'), 'error');
    return;
  }
  toast(t('claim_ok') + ' ' + res.ref);
  adjustLocalStock(cl.barcode, -qty);
  ['cl-bc', 'cl-name', 'cl-val', 'cl-sup'].forEach((id) => (document.getElementById(id).value = ''));
  document.getElementById('cl-qty').value = 1;
  renderQuick();
}

/* ---------- GRN ---------- */
let grnActiveTab = 'pending';
function switchGRNTab(tab) {
  grnActiveTab = tab;
  const pendBtn = document.getElementById('grn-tab-pending');
  const histBtn = document.getElementById('grn-tab-history');
  if (pendBtn) pendBtn.className = tab === 'pending' ? 'btn btn-sm' : 'btn btn-ghost btn-sm';
  if (histBtn) histBtn.className = tab === 'history' ? 'btn btn-sm' : 'btn btn-ghost btn-sm';
  if (tab === 'pending') loadGRNs();
  else loadGRNHistory();
}
async function loadGRNHistory() {
  const gl = document.getElementById('grn-list');
  gl.innerHTML = '<div style="text-align:center;padding:22px;color:var(--gray4);font-size:12px">⏳ Loading receive history...</div>';
  const res = await api('/api/grns?status=received');
  if (!res || !res.data) {
    gl.innerHTML = '<div style="text-align:center;padding:22px;color:var(--gray3);font-size:12px">⚠️ Cannot load history.<br><button class="btn btn-ghost btn-sm mt" onclick="loadGRNHistory()">🔄 Retry</button></div>';
    return;
  }
  const grouped = {};
  res.data.forEach((line) => {
    if (!grouped[line.GRNID]) grouped[line.GRNID] = { grnId: line.GRNID, date: line.Date, receivedBy: line.ReceivedBy, receivedAt: line.ReceivedAt, lines: [] };
    grouped[line.GRNID].lines.push(line);
  });
  window.__grnHistoryData = grouped;
  const grns = Object.values(grouped).sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
  if (!grns.length) {
    gl.innerHTML = '<div style="text-align:center;padding:22px;color:var(--gray3);font-size:12px">No GRNs received yet</div>';
    return;
  }
  // Summary first — GRN number, date, total issued/received qty across
  // all items in that GRN — so you can see at a glance what a GRN was,
  // without scrolling through every line. Tap a row for the item-level
  // breakdown if you need it.
  gl.innerHTML = `<table><thead><tr><th>GRN ID</th><th>Date</th><th>Items</th><th>Issued Qty</th><th>Received Qty</th><th>Received By</th><th></th></tr></thead><tbody>` +
    grns.map((g) => {
      const totalIssued = g.lines.reduce((s, l) => s + (+l.QtyIssued || 0), 0);
      const totalReceived = g.lines.reduce((s, l) => s + (+l.QtyReceived || 0), 0);
      return `<tr style="cursor:pointer" onclick="toggleGRNDetail('${g.grnId}')">
        <td class="fw7">${g.grnId}</td>
        <td>${g.receivedAt ? g.receivedAt.split(' ')[0] : g.date}</td>
        <td style="text-align:center">${g.lines.length}</td>
        <td style="text-align:center">${totalIssued}</td>
        <td style="text-align:center;font-weight:700;color:var(--green)">${totalReceived}</td>
        <td>${g.receivedBy || '—'}</td>
        <td style="text-align:center">▼</td>
      </tr>
      <tr id="grn-detail-${g.grnId}" style="display:none"><td colspan="7" style="padding:0">
        <table style="margin:6px 0 6px 14px;width:calc(100% - 14px)"><thead><tr><th>Barcode</th><th>Product</th><th>Issued</th><th>Received</th></tr></thead>
        <tbody>${g.lines.map((l) => `<tr><td style="font-family:monospace;font-size:10px">${l.Barcode}</td><td>${l.Name}</td><td style="text-align:center">${l.QtyIssued}</td><td style="text-align:center;font-weight:700;color:var(--green)">${l.QtyReceived}</td></tr>`).join('')}</tbody></table>
      </td></tr>`;
    }).join('') + `</tbody></table>`;
}
function toggleGRNDetail(grnId) {
  const row = document.getElementById('grn-detail-' + grnId);
  if (row) row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
}
async function loadGRNs() {
  const gl = document.getElementById('grn-list');
  gl.innerHTML = '<div style="text-align:center;padding:22px;color:var(--gray4);font-size:12px">⏳ Loading pending GRNs...</div>';
  const res = await api('/api/grns?status=pending');
  if (!res || !res.data) {
    gl.innerHTML =
      '<div style="text-align:center;padding:22px;color:var(--gray3);font-size:12px">⚠️ Cannot load GRNs.<br><button class="btn btn-ghost btn-sm mt" onclick="loadGRNs()">🔄 Retry</button></div>';
    return;
  }
  const grouped = {};
  res.data.forEach((line) => {
    if (!grouped[line.GRNID]) grouped[line.GRNID] = { grnId: line.GRNID, date: line.Date, lines: [] };
    grouped[line.GRNID].lines.push(line);
  });
  const grns = Object.values(grouped);
  document.getElementById('grn-badge').textContent = grns.length;
  if (!grns.length) {
    gl.innerHTML = '<div style="text-align:center;padding:22px;color:var(--gray3);font-size:12px">No pending GRNs ✅</div>';
    return;
  }
  gl.innerHTML = grns
    .map(
      (g) => `
    <div class="grn-card pending">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div><div style="font-weight:800;color:var(--navy)">${g.grnId}</div><div style="font-size:11px;color:var(--gray4)">Date: ${g.date} · ${g.lines.length} items</div></div>
        <button class="btn btn-green btn-sm" onclick="receiveGRN('${g.grnId}',this)">✅ Receive All</button>
      </div>
      <table><thead><tr><th>Barcode</th><th>Product</th><th>Qty Issued</th><th>Receive Qty</th></tr></thead>
      <tbody>${g.lines
        .map(
          (l) =>
            `<tr><td style="font-family:monospace;font-size:10px">${l.Barcode}</td><td>${l.Name}</td><td style="text-align:center">${l.QtyIssued}</td><td><input type="number" value="${l.QtyIssued}" min="0" max="${l.QtyIssued}" id="recv-${g.grnId}-${l.Barcode}" style="width:70px;padding:4px 7px;border:1.5px solid var(--gray2);border-radius:6px;font-size:12px"></td></tr>`
        )
        .join('')}</tbody></table>
    </div>`
    )
    .join('');
}
function downloadReceiveErrorLog(rows) {
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const header = ['GRN ID', 'Barcode', 'Qty', 'Status', 'Reason'];
  const csv = [header.join(',')]
    .concat(rows.map((r) => [r.grnId, r.barcode, r.qty, r.status, r.reason].map(esc).join(',')))
    .join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'grn_receive_errors_' + today() + '.csv';
  a.click();
}
async function receiveGRN(grnId, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  let secs = 0;
  const timer = setInterval(() => { secs++; btn.textContent = `⏳ Processing… ${secs}s`; }, 1000);
  btn.textContent = '⏳ Processing… 0s';
  const inputs = document.querySelectorAll(`[id^="recv-${grnId}-"]`);
  let count = 0;
  let failed = 0;
  const logRows = [];
  try {
    for (const inp of inputs) {
      const barcode = inp.id.replace(`recv-${grnId}-`, '');
      const qty = parseInt(inp.value) || 0;
      if (qty > 0) {
        // Each request gets its own 45s timeout — if the server never
        // responds (cold start, network drop, whatever), this stops the
        // button from waiting forever and turns it into a clear failure
        // instead, with the reason captured for the diagnostic log.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);
        let res;
        try {
          res = await api('/api/grns/receive', {
            method: 'POST',
            body: {
              grnId,
              barcode,
              qty,
              storeId: DB.settings.storeId,
              storeName: DB.settings.storeName,
            },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
        if (res && res.ok !== false) {
          adjustLocalStock(barcode, qty);
          count++;
        } else {
          failed++;
          const reason = (res && res.msg) || 'failed';
          logRows.push({ grnId, barcode, qty, status: 'failed', reason });
          toast(`❌ ${barcode}: ${reason}`, 'error');
        }
      }
    }
    if (count) toast(`✅ GRN ${grnId} — ${count} item(s) received` + (failed ? `, ${failed} failed` : ''), failed ? 'warn' : 'ok');
    else if (failed) toast(`❌ GRN ${grnId} — all ${failed} item(s) failed`, 'error');
  } catch (e) {
    failed++;
    logRows.push({ grnId, barcode: '?', qty: '', status: 'failed', reason: e.message });
    toast('❌ Receive failed: ' + e.message, 'error');
  } finally {
    // Always restore the button and refresh, even if something above
    // threw or failed — this is what stops it from ever staying stuck
    // on "Processing..." forever.
    clearInterval(timer);
    btn.disabled = false;
    btn.textContent = original;
    // Only download a log when something actually went wrong — a clean
    // receive shouldn't dump a file on the cashier for no reason.
    if (logRows.length) downloadReceiveErrorLog(logRows);
    loadGRNs();
    reloadCatalog();
  }
}

/* ---------- INVENTORY ---------- */
async function renderInv() {
  const search = (document.getElementById('inv-search').value || '').toLowerCase();
  const filter = document.getElementById('inv-filter').value;
  const tb = document.getElementById('inv-table');
  const res = await api('/api/inventory' + (search ? '?q=' + encodeURIComponent(search) : ''));
  let rows = (res && res.data) || [];
  if (filter === 'low') rows = rows.filter((r) => r.status === 'LOW' || r.status === 'OUT');
  if (filter === 'out') rows = rows.filter((r) => r.status === 'OUT');
  tb.innerHTML =
    rows
      .map((p) => {
        const s = p.onHand;
        const st =
          s <= 0
            ? '<span class="badge badge-red">OUT</span>'
            : s <= p.reorder
              ? '<span class="badge badge-amber">LOW</span>'
              : '<span class="badge badge-green">OK</span>';
        return `<tr><td style="font-family:monospace;font-size:10px">${p.barcode}</td><td class="fw7">${p.name}</td><td>${p.opening || 0}</td><td class="text-red">${p.sold}</td><td class="text-green">${p.returns}</td><td>${p.claims}</td><td style="font-weight:800;font-size:13px;color:${s <= 0 ? 'var(--red)' : s <= p.reorder ? 'var(--amber)' : 'var(--navy)'}">${s}</td><td>${p.reorder}</td><td>${st}</td></tr>`;
      })
      .join('') ||
    '<tr><td colspan="9" style="text-align:center;color:var(--gray3);padding:18px">No products</td></tr>';
}

/* ---------- EXPENSES ---------- */

/* ---------- REPORTS ---------- */
function rptPreset() {
  const p = document.getElementById('rpt-preset').value;
  const now = new Date();
  const d = today();
  const fld = document.getElementById('rpt-from');
  const tld = document.getElementById('rpt-to');
  if (p === 'today') {
    fld.value = d;
    tld.value = d;
  } else if (p === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const yd = y.toISOString().split('T')[0];
    fld.value = yd;
    tld.value = yd;
  } else if (p === 'week') {
    const ws = new Date(now);
    ws.setDate(now.getDate() - now.getDay());
    fld.value = ws.toISOString().split('T')[0];
    tld.value = d;
  } else if (p === 'month') {
    fld.value = d.slice(0, 7) + '-01';
    tld.value = d;
  }
}
async function loadReports() {
  const from = document.getElementById('rpt-from').value;
  const to = document.getElementById('rpt-to').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const res = await api('/api/reports?' + qs.toString());
  if (!res || !res.ok) {
    toast('Report load failed', 'warn');
    return;
  }
  const roleForProfit = (USER && USER.role) || 'cashier';
  const canSeeProfitKpi = roleForProfit === 'admin' || roleForProfit === 'accountant';
  const kpiRows = [
    ['Revenue', fmt(res.revenue), ''],
    ['Net', fmt(res.net), 'blue'],
    ['Invoices', res.invoices, 'green'],
    ['ATV', fmt(res.atv), 'amber'],
    ['Units', res.units, 'purple'],
    ['Returns', fmt(res.returns), ''],
  ];
  if (canSeeProfitKpi) {
    kpiRows.push(['Cost', fmt(res.totalCost||0), ''], ['Profit', fmt(res.totalProfit||0), 'green'], ['Margin', (res.margin||0)+'%', 'teal']);
  }
  document.getElementById('rpt-kpis').innerHTML = kpiRows
    .map(([l, v, c]) => `<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`)
    .join('');

  const pm = res.paymentBreakdown || {};
  const rev = res.revenue || 0;
  document.getElementById('rpt-pay').innerHTML =
    Object.entries(pm)
      .map(([m, v]) => {
        const pct = rev ? Math.round((v / rev) * 100) : 0;
        return `<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px"><span>${m}</span><span class="fw7">${fmt(v)} (${pct}%)</span></div><div style="background:var(--gray1);border-radius:4px;height:7px"><div style="background:var(--accent2);width:${pct}%;height:100%;border-radius:4px"></div></div></div>`;
      })
      .join('') || '<div style="color:var(--gray3);font-size:11px;padding:14px;text-align:center">No data</div>';

  const prods = res.productBreakdown || [];
  document.getElementById('rpt-prod').innerHTML =
    prods
      .map(
        (p) =>
          `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--gray1);font-size:11px"><span class="fw7">${p.name}</span><span>${p.qty} · ${fmt(p.revenue)}</span></div>`
      )
      .join('') || '<div style="color:var(--gray3);font-size:11px;padding:14px;text-align:center">No data</div>';

  const txns = res.transactions || [];
  window.__lastReport = res;
  document.getElementById('rpt-txns').innerHTML =
    txns
      .slice(0, 150)
      .map(
        (x) =>
          `<tr><td class="fw7">${x.id}</td><td>${x.date||''}</td><td>${x.time||''}</td><td>${x.customer||''}</td><td style="text-align:center">${x.items||0}</td><td style="text-align:center">${x.units||0}</td><td style="font-size:10px;max-width:200px">${x.productList||''}</td><td>${fmt(x.subtotal||0)}</td><td>${fmt(x.discount||0)}</td><td class="fw7 profit-col" style="display:none;color:var(--green)">${fmt(x.profit||0)}</td><td>${x.payment||''}</td><td class="fw7">${fmt(x.total||0)}</td></tr>`
      )
      .join('') ||
    '<tr><td colspan="12" style="text-align:center;color:var(--gray3);padding:14px">No transactions</td></tr>';
  applyProfitVisibility();
}
function exportRpt() {
  const rows = (window.__lastReport && window.__lastReport.transactions) || [];
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const role = (USER && USER.role) || 'cashier';
  const canSeeProfit = role === 'admin' || role === 'accountant';
  const header = canSeeProfit
    ? ['Invoice','Date','Time','Customer','Items','Units','Products','Subtotal','Discount','Cost','Profit','Margin%','Payment','Ref','Total']
    : ['Invoice','Date','Time','Customer','Items','Units','Products','Subtotal','Discount','Payment','Ref','Total'];
  const rowToCells = (x) => canSeeProfit
    ? [x.id, x.date, x.time, x.customer, x.items, x.units, x.productList, x.subtotal, x.discount, x.cost, x.profit, x.margin, x.payment, x.payRef, x.total]
    : [x.id, x.date, x.time, x.customer, x.items, x.units, x.productList, x.subtotal, x.discount, x.payment, x.payRef, x.total];
  const csv = [header.join(',')]
    .concat(rows.map((x) => rowToCells(x).map(esc).join(',')))
    .join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'anta_report_' + today() + '.csv';
  a.click();
}

/* ---------- SETTINGS ---------- */
async function testConn() {
  const url = (document.getElementById('api-url') && document.getElementById('api-url').value.trim()) || CFG.apiUrl;
  CFG.apiUrl = url.replace(/\/$/, '');
  localStorage.setItem('anta_api_url', CFG.apiUrl);
  const div = document.getElementById('conn-res');
  div.style.display = 'block';
  div.innerHTML = '⏳ Testing...';
  div.style.color = 'var(--gray4)';
  const res = await api('/api/health');
  if (res && res.ok) {
    div.innerHTML = '✅ Connected! ' + (res.app || '') + ' v' + (res.version || '');
    div.style.color = 'var(--green)';
    setOnline('online', 'Connected');
    toast('✅ Connected!');
    const info = document.getElementById('server-info');
    if (info) info.textContent = 'DB engine: ' + (res.db || 'sqlite') + ' · ' + CFG.apiUrl;
  } else {
    div.innerHTML = '❌ Failed. Is the server running?';
    div.style.color = 'var(--red)';
    toast('❌ Failed', 'error');
  }
}
function renderBanksList() {
  const el = document.getElementById('banks-list');
  if (!el) return;
  el.innerHTML =
    BANKS.filter((b) => b.active !== 'N')
      .map(
        (b) =>
          `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--gray1);font-size:12px"><span class="fw7">${b.name}</span>${b.device ? `<span style="color:var(--gray4);font-size:10px">${b.device}</span>` : ''}</div>`
      )
      .join('') || '<div style="color:var(--gray3);font-size:11px">No banks configured</div>';
}
function populatePaySelects() {
  const opts = BANKS.filter((b) => b.active !== 'N')
    .map((b) => `<option>${b.name}</option>`)
    .join('');
  ['r-method', 'ex-pay', 'exp-pay'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
}
async function saveSettings() {
  const lang = (document.getElementById('s-lang')||{}).value || LANG || 'en';
  localStorage.setItem('anta_lang', lang); LANG = lang; applyLang();
  const apiUrl = (document.getElementById('api-url')||{}).value;
  if(apiUrl){ CFG.apiUrl = apiUrl; localStorage.setItem('anta_api_url', apiUrl); }
  const policy = (document.getElementById('s-policy')||{}).value;
  const body = { language: lang };
  if(policy!=null) body.policy = policy;
  if(USER && USER.role==='admin'){
    const sn = (document.getElementById('s-name')||{}).value;
    const pn = (document.getElementById('s-pos-name')||{}).value;
    if(sn) body.store_name = sn;
    if(pn) body.pos_name = pn;
    body.store_id = CFG.storeId || (USER && USER.storeId);
  } else if((document.getElementById('s-name')||{}).value){
    toast(t('admin_only_err'),'warn');
  }
  const res = await api('/api/settings', { method:'PUT', body });
  if(res && res.ok){ toast(t('settings_saved')); if(res.store_name) CFG.storeName=res.store_name; }
  else toast((res && res.msg) || 'Save failed','error');
}

/* legacy stubs kept so old onclick names don't break */
let _posAutoRefreshTimer = null, _posAutoRefreshing = false;
function startPosAutoRefresh() {
  // Background catalog/stock refresh every 60s on top of the manual sync
  // button, guarded against overlap so it can't stack up requests.
  if (_posAutoRefreshTimer) return;
  _posAutoRefreshTimer = setInterval(async () => {
    if (!CFG.token || _posAutoRefreshing) return;
    _posAutoRefreshing = true;
    try { await reloadCatalog(); } catch (e) {}
    finally { _posAutoRefreshing = false; }
  }, 60000);
}
function syncNow() {
  reloadCatalog();
}
function pushAll() {
  toast('All data is already in the database', 'info');
}
function loadProductsFromSheets() {
  reloadCatalog();
}
function loadBanks() {
  reloadCatalog();
}
function updateQueueUI() {
  const n = 0;
  const el = document.getElementById('q-count');
  if (el) el.textContent = n;
}

/* ---------- INIT ---------- */
async function initApp() {
  try { if (typeof loadAppSettings === 'function') await loadAppSettings(); } catch (e) {}
  try { if (typeof loadPromos === 'function') await loadPromos(); } catch (e) {}
  try {
    const l = localStorage.getItem('anta_log_v4');
    if (l) activityLog = JSON.parse(l);
  } catch (e) {}
  updateQueueUI();
  populatePaySelects();
  updatePendingSyncBadge();
  if (navigator.onLine) setTimeout(trySyncPendingSales, 2000);
  const expDateEl = document.getElementById('exp-date');
  if (expDateEl) expDateEl.value = today();
  rptPreset();
  await ensureStock();
  await reloadCatalog();
  renderRetList();
  renderDash();
  show('dashboard');
  startPosAutoRefresh();
}
function updateClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleDateString('en-GB') + ' · ' + new Date().toTimeString().slice(0, 5);
}
setInterval(updateClock, 1000);
updateClock();
document.addEventListener('click', (e) => {
  if (!e.target.closest('.relative')) {
    const sd = document.getElementById('search-drop');
    if (sd) sd.style.display = 'none';
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') pinSubmit();
});

// boot
/* ===== i18n AR/EN ===== */
const I18N = {
  en: {
    dashboard:'Dashboard', sale:'New Sale', returns:'Returns', exchange:'Exchange', claims:'Claims',
    grn:'Receive Stock (GRN)', inventory:'Inventory', reports:'Reports', settings:'Settings',
    complete:'Complete Sale', store_name:'Store Name', pos_name:'POS / Receipt Name', policy:'Return Policy',
    language:'Language', locked:'System locked', main:'Main', transactions:'Transactions', stock:'Stock',
    finance:'Finance', logout:'Logout', search:'Search product / barcode...', customer:'Customer',
    payment:'Payment', subtotal:'Subtotal', discount:'Discount', total:'TOTAL', cart_empty:'Cart empty',
    save:'Save', print:'Print', thermal:'Thermal ESC/POS', close:'Close', refresh:'Refresh',
    today_sales:'Today Sales', invoices:'Invoices', low_stock:'Low Stock', queue:'Queue',
    login_title:'ANTA Shoes POS', login_sub:'Select store and enter PIN', wrong_pin:'Wrong PIN',
    switch_ar:'Switched to Arabic', switch_en:'Switched to English', lang_btn:'العربية / EN', lang_en:'English', lang_ar:'العربية',
    portal:'← Portal', head_office:'Head Office', new_sale_title:'🛒 New Sale', clear:'🗑 Clear',
    charge:'💳 Charge', products:'Products', process_return:'↩️ Process Return', barcode:'Barcode',
    original_invoice:'Original Invoice #', qty:'Qty', amount:'Amount', method:'Method', reason:'Reason',
    defective:'Defective/Damaged', wrong_size:'Wrong size', change_mind:'Customer change of mind',
    wrong_product:'Wrong product', other:'Other', process_return_btn:'✅ Process Return',
    recent_returns:'Recent Returns', ref:'Ref', date:'Date', product:'Product', amount_col:'Amount',
    exchange_title:'🔄 Exchange', old_item:'📤 OLD ITEM (returning)', price:'Price',
    new_item:'📥 NEW ITEM (selling)', difference:'Difference', complete_exchange:'✅ Complete Exchange',
    claims_title:'⚠️ Claims & Damage', typ:'Type', damage_writeoff:'Damage Writeoff',
    supplier_claim:'Supplier Claim', theft:'Theft', value:'Value', supplier:'Supplier',
    record_claim:'⚠️ Record Claim', receive_stock:'📥 Receive Stock from HO',
    loading_ho:'Loading from HO...', inventory_title:'📦 Inventory', all:'All',
    out_of_stock:'Out of Stock', grn_in:'GRN In', sold:'Sold', on_hand:'ON HAND', reorder:'Reorder',
    status:'Status', today:'Today', yesterday:'Yesterday', this_week:'This Week', this_month:'This Month',
    custom_range:'Custom Range', search_btn:'🔍 Search', export:'⬇️ Export',
    payment_breakdown:'Payment Breakdown', top_products:'Top Products', items:'Items', units:'Units',
    profit:'Profit', db_server:'🗄️ Database Server',
    db_connected:'Connected to local SQLite/PostgreSQL API — no Google Sheets required.',
    api_base_url:'API Base URL', test_connection:'🔌 Test Connection', reload_catalog:'📦 Reload Catalog',
    init_stock:'📥 Init Store Stock', payment_methods:'🏦 Payment Methods', reload_banks:'🔄 Reload Banks',
    store_settings:'⚙️ Store Settings', admin_only:'Store/POS name: admin only', save_btn:'💾 Save',
    activity_log:'📋 Activity Log', collect_payment:'💳 Collect Payment', amount_due:'Amount Due',
    cash_received:'Cash Received', chg:'CHANGE',
    txn_ref:'Transaction Reference # (from device)', cancel:'Cancel', complete_sale:'✅ Complete Sale',
    print_btn:'🖨️ Print', thermal_btn:'🧾 Thermal ESC/POS', scan_barcode:'Scan barcode to start',
    connecting:'Connecting...', pos_label:'POS', online:'Online', offline:'Offline', syncing:'Working',
    net_revenue:'Net Revenue', after_returns:'after returns', units_sold:'Units Sold',
    today_label:'today', avg_basket:'Avg Basket', per_invoice:'per invoice', returns_count:'returns',
    cash_label:'Cash', cash_sales:'cash sales', recent_transactions:'Recent Transactions',
    invoice_col:'Invoice', time_col:'Time', customer_col:'Customer', payment_col:'Payment', total_col:'Total',
    new_sale_btn:'➕ New Sale', sync_btn:'🔄 Sync', offline_pending:'pending — will sync when connected',
    no_activity:'No activity yet', enter_pin:'Enter PIN', processing:'⏳ Processing...',
    db_engine:'DB engine:', testing:'⏳ Testing...', connected_ok:'✅ Connected!',
    connected_fail:'❌ Failed. Is the server running?', no_invoice:'No invoice',
    receipt_failed:'Receipt failed', report_fail:'Report load failed',
    settings_saved:'✅ Settings saved', catalog_loaded:'✅ Catalog loaded',
    store_init:'✅ Store stock initialized', sale_complete:'✅ Sale complete!',
    return_ok:'✅ Return:', exchange_ok:'✅ Exchange:', claim_ok:'✅ Claim:',
    cart_empty_err:'❌ Cart empty', barcode_err:'❌ Enter barcode', both_barcodes_err:'❌ Enter both barcodes',
    failed:'❌ Failed', insufficient_cash:'❌ Insufficient cash', not_found:'❌ Not found:',
    sale_failed:'❌ Sale failed:', print_error:'Print error', max_stock:'⚠️ Max stock:',
    out_of_stock_err:'⚠️ Out of stock', admin_only_err:'Only admin can change store/POS name',
    sent_printer:'Sent to thermal printer', escpos_downloaded:'ESC/POS file downloaded',
    data_in_db:'All data is already in the database',
    inv_label:'INV-', empty:'—', sidebar_offline:'⚠️ Offline:'
  },
  ar: {
    dashboard:'لوحة التحكم', sale:'مبيعات جديدة', returns:'مرتجعات', exchange:'استبدال', claims:'شكاوى',
    grn:'استلام مخزون', inventory:'المخزون', reports:'التقارير', settings:'الإعدادات',
    complete:'إتمام البيع', store_name:'اسم المتجر', pos_name:'اسم نقطة البيع', policy:'سياسة الإرجاع',
    language:'اللغة', locked:'النظام مقفل', main:'الرئيسية', transactions:'المعاملات', stock:'المخزون',
    finance:'المالية', logout:'تسجيل الخروج', search:'بحث منتج / باركود...', customer:'العميل',
    payment:'الدفع', subtotal:'المجموع الفرعي', discount:'الخصم', total:'الإجمالي', cart_empty:'السلة فارغة',
    save:'حفظ', print:'طباعة', thermal:'ESC/POS حراري', close:'إغلاق', refresh:'تحديث',
    today_sales:'مبيعات اليوم', invoices:'فواتير', low_stock:'مخزون منخفض', queue:'الطابور',
    login_title:'أنتا للأحذية', login_sub:'اختر المتجر وأدخل الرقم السري', wrong_pin:'رقم سري خاطئ',
    switch_ar:'تم التبديل إلى العربية', switch_en:'تم التبديل إلى الإنجليزية', lang_btn:'EN / العربية', lang_en:'English', lang_ar:'العربية',
    portal:'→ البوابة', head_office:'المركز الرئيسي', new_sale_title:'🛒 مبيعات جديدة', clear:'🗑 مسح السلة',
    charge:'💳 دفع', products:'المنتجات', process_return:'↩️ معالجة مرتجع', barcode:'باركود',
    original_invoice:'رقم الفاتورة الأصلية', qty:'الكمية', amount:'المبلغ', method:'الطريقة', reason:'السبب',
    defective:'تالف/معيب', wrong_size:'مقاس خاطئ', change_mind:'تغيير رأي العميل',
    wrong_product:'منتج خاطئ', other:'أخرى', process_return_btn:'✅ معالجة المرتجع',
    recent_returns:'المرتجعات الأخيرة', ref:'المرجع', date:'التاريخ', product:'المنتج', amount_col:'المبلغ',
    exchange_title:'🔄 استبدال', old_item:'📤 الصنف القديم (مرتجع)', price:'السعر',
    new_item:'📥 الصنف الجديد (مباع)', difference:'الفرق', complete_exchange:'✅ إتمام الاستبدال',
    claims_title:'⚠️ شكاوى وتوالف', typ:'النوع', damage_writeoff:'شطب تالف',
    supplier_claim:'مطالبة مورد', theft:'سرقة', value:'القيمة', supplier:'المورد',
    record_claim:'⚠️ تسجيل شكوى', receive_stock:'📥 استلام مخزون من المركز الرئيسي',
    loading_ho:'جاري التحميل من المركز...', inventory_title:'📦 المخزون', all:'الكل',
    out_of_stock:'نفذ من المخزون', grn_in:'وارد', sold:'مباع', on_hand:'المتاح', reorder:'إعادة طلب',
    status:'الحالة', today:'اليوم', yesterday:'أمس', this_week:'هذا الأسبوع', this_month:'هذا الشهر',
    custom_range:'نطاق مخصص', search_btn:'🔍 بحث', export:'⬇️ تصدير',
    payment_breakdown:'تفاصيل المدفوعات', top_products:'أكثر المنتجات مبيعاً', items:'أصناف', units:'وحدات',
    profit:'الربح', db_server:'🗄️ خادم قاعدة البيانات',
    db_connected:'متصل بقاعدة بيانات SQLite/PostgreSQL — لا حاجة لـ Google Sheets.',
    api_base_url:'رابط API الأساسي', test_connection:'🔌 اختبار الاتصال', reload_catalog:'📦 إعادة تحميل الكتالوج',
    init_stock:'📥 تهيئة مخزون المتجر', payment_methods:'🏦 طرق الدفع', reload_banks:'🔄 تحديث البنوك',
    store_settings:'⚙️ إعدادات المتجر', admin_only:'اسم المتجر/نقطة البيع: للمدير فقط', save_btn:'💾 حفظ',
    activity_log:'📋 سجل النشاط', collect_payment:'💳 تحصيل المبلغ', amount_due:'المبلغ المستحق',
    cash_received:'المبلغ المستلم', chg:'الباقي',
    txn_ref:'رقم مرجع المعاملة (من الجهاز)', cancel:'إلغاء', complete_sale:'✅ إتمام البيع',
    print_btn:'🖨️ طباعة', thermal_btn:'🧾 ESC/POS حراري', scan_barcode:'امسح الباركود للبدء',
    connecting:'جاري الاتصال...', pos_label:'نقطة البيع', online:'متصل', offline:'غير متصل', syncing:'جاري المزامنة',
    net_revenue:'صافي الإيرادات', after_returns:'بعد المرتجعات', units_sold:'الوحدات المباعة',
    today_label:'اليوم', avg_basket:'متوسط السلة', per_invoice:'لكل فاتورة', returns_count:'مرتجعات',
    cash_label:'نقداً', cash_sales:'مبيعات نقدية', recent_transactions:'آخر المعاملات',
    invoice_col:'الفاتورة', time_col:'الوقت', customer_col:'العميل', payment_col:'الدفع', total_col:'الإجمالي',
    new_sale_btn:'➕ مبيعات جديدة', sync_btn:'🔄 مزامنة', offline_pending:'معلق — ستتم المزامنة عند الاتصال',
    no_activity:'لا يوجد نشاط بعد', enter_pin:'أدخل الرقم السري', processing:'⏳ جاري المعالجة...',
    db_engine:'محرك قاعدة البيانات:', testing:'⏳ جاري الاختبار...', connected_ok:'✅ تم الاتصال!',
    connected_fail:'❌ فشل. هل الخادم يعمل؟', no_invoice:'لا توجد فاتورة',
    receipt_failed:'فشل الإيصال', report_fail:'فشل تحميل التقرير',
    settings_saved:'✅ تم حفظ الإعدادات', catalog_loaded:'✅ تم تحميل الكتالوج',
    store_init:'✅ تم تهيئة مخزون المتجر', sale_complete:'✅ تمت عملية البيع!',
    return_ok:'✅ مرتجع:', exchange_ok:'✅ استبدال:', claim_ok:'✅ شكوى:',
    cart_empty_err:'❌ السلة فارغة', barcode_err:'❌ أدخل الباركود', both_barcodes_err:'❌ أدخل كلا الباركودين',
    failed:'❌ فشل', insufficient_cash:'❌ مبلغ نقدي غير كاف', not_found:'❌ غير موجود:',
    sale_failed:'❌ فشلت عملية البيع:', print_error:'خطأ في الطباعة', max_stock:'⚠️ الحد الأقصى للمخزون:',
    out_of_stock_err:'⚠️ نفذ من المخزون', admin_only_err:'المدير فقط يمكنه تغيير اسم المتجر/نقطة البيع',
    sent_printer:'تم الإرسال إلى الطابعة الحرارية', escpos_downloaded:'تم تحميل ملف ESC/POS',
    data_in_db:'جميع البيانات موجودة بالفعل في قاعدة البيانات',
    inv_label:'فاتورة-', empty:'—', sidebar_offline:'⚠️ غير متصل:'
  }
};
let LANG = localStorage.getItem('anta_lang') || 'en';


function t(key){
  const pack = I18N[LANG] || I18N.en;
  return (pack && pack[key]) || (I18N.en && I18N.en[key]) || key;
}

function applyLang(){
  try {
    LANG = localStorage.getItem('anta_lang') || LANG || 'en';
    const root = document.getElementById('html-root') || document.documentElement;
    root.setAttribute('lang', LANG);
    root.setAttribute('dir', LANG === 'ar' ? 'rtl' : 'ltr');
    document.body && document.body.setAttribute('dir', LANG === 'ar' ? 'rtl' : 'ltr');

    // Translate all [data-i18n] elements (includes nav labels now)
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      if (!k) return;
      const val = t(k);
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.placeholder !== undefined) el.placeholder = val;
      } else if (el.tagName === 'SELECT') {
        el.querySelectorAll('option[data-i18n]').forEach(opt => {
          const ok = opt.getAttribute('data-i18n');
          if (ok) opt.textContent = t(ok);
        });
      } else {
        if (!el.querySelector('[data-i18n]')) el.textContent = val;
      }
    });

    // Sidebar section headers
    document.querySelectorAll('.nav-sec').forEach(el => {
      const txt = (el.textContent || '').trim().toLowerCase();
      const map = {main:'main', transactions:'transactions', stock:'stock', finance:'finance', reports:'reports', settings:'settings', overview:'main', admin:'settings'};
      if (map[txt]) el.textContent = t(map[txt]);
    });

    // Common buttons / header items
    const logout = document.querySelector('.logout-btn');
    if (logout) logout.textContent = t('logout');
    const lt = document.getElementById('lang-toggle');
    if (lt) lt.textContent = t('lang_btn');
    const st = document.getElementById('screen-title');
    if (st && window.__lastScreen) st.textContent = t(window.__lastScreen) || st.textContent;

    // Login texts
    const loginTitle = document.querySelector('#login-screen .login-title');
    if (loginTitle) loginTitle.textContent = t('login_title');
    const loginSub = document.querySelector('#login-screen .login-sub');
    if (loginSub) loginSub.textContent = t('login_sub');

    // data-i18n-keep (cart summary)
    document.querySelectorAll('[data-i18n-keep]').forEach(el => {
      const k = el.getAttribute('data-i18n-keep');
      if (k) el.textContent = t(k);
    });

    // Stat labels
    document.querySelectorAll('.stat-label').forEach(el => {
      const k = el.getAttribute('data-i18n-stat');
      if (k) el.textContent = t(k);
    });
    document.querySelectorAll('.stat-sub').forEach(el => {
      const k = el.getAttribute('data-i18n-stat');
      if (k) el.textContent = t(k);
    });

    // Card titles
    document.querySelectorAll('[data-i18n-card]').forEach(el => {
      const k = el.getAttribute('data-i18n-card');
      if (k) el.textContent = t(k);
    });

    // Table headers
    document.querySelectorAll('th[data-i18n-th]').forEach(el => {
      const k = el.getAttribute('data-i18n-th');
      if (k) el.textContent = t(k);
    });

    // Buttons
    document.querySelectorAll('[data-i18n-btn]').forEach(el => {
      const k = el.getAttribute('data-i18n-btn');
      if (k) el.textContent = t(k);
    });

    // Modal titles
    document.querySelectorAll('.modal-title').forEach(el => {
      const k = el.getAttribute('data-i18n-modal');
      if (k) el.textContent = t(k);
    });

    // Form labels
    document.querySelectorAll('.form-label').forEach(el => {
      const k = el.getAttribute('data-i18n-label');
      if (k) el.textContent = t(k);
    });

    // Topbar status
    const topSync = document.getElementById('top-sync');
    if (topSync) topSync.textContent = isOnline ? t('online') : t('offline');

    window.__screenTitles = {
      dashboard:t('dashboard'), sale:t('sale'), returns:t('returns'), exchange:t('exchange'),
      claims:t('claims'), grn:t('grn'), inventory:t('inventory'), reports:t('reports'), settings:t('settings')
    };
  } catch (e) {
    console.warn('applyLang', e);
  }
}
function toggleLang(){
  LANG = (LANG === 'en') ? 'ar' : 'en';
  localStorage.setItem('anta_lang', LANG);
  const sel = document.getElementById('s-lang'); if (sel) sel.value = LANG;
  applyLang();
  // refresh current screen title
  try {
    const active = document.querySelector('.nav-item.active');
    if (active) {
      const oc = active.getAttribute('onclick') || '';
      const m = oc.match(/show\('([^']+)'\)/);
      if (m) show(m[1]);
    }
  } catch (e) {}
  toast(LANG === 'ar' ? t('switch_ar') : t('switch_en'));
}


async function printThermal(){
  try{
    const invEl=document.querySelector('#inv-content [data-invoice-id]');
    const id = (invEl && invEl.getAttribute('data-invoice-id')) || (window.__lastInvoiceId||'');
    if(!id){ toast(t('no_invoice'),'error'); return; }
    const url=(CFG.apiUrl||'').replace(/\/$/,'')+'/api/receipts/sale/'+encodeURIComponent(id)+'?fmt=escpos';
    const res=await fetch(url,{headers:authHeaders(false)});
    if(!res.ok){ toast(t('receipt_failed'),'error'); return; }
    const blob=await res.blob();
    // Web Serial thermal if available
    if(navigator.serial){
      try{
        const port = await navigator.serial.requestPort();
        await port.open({baudRate:9600});
        const writer=port.writable.getWriter();
        const buf=new Uint8Array(await blob.arrayBuffer());
        await writer.write(buf);
        writer.releaseLock();
        await port.close();
        toast(t('sent_printer'));
        return;
      }catch(e){ /* fall through download */ }
    }
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=id+'-escpos.bin';
    a.click();
    toast(t('escpos_downloaded'));
  }catch(e){ toast(t('print_error'),'error'); }
}

async function loadPromos(){
  const res=await api('/api/promotions?active_only=true');
  DB.promos = (res && res.data) ? res.data : [];
}
async function refreshPromoPricing(){
  if(!cart.length) return null;
  const res=await api('/api/promotions/preview',{method:'POST', body:{items:cart, globalDiscount: parseFloat((document.getElementById('pay-gdisc')||{}).value)||0}});
  if(res && res.ok){
    window.__promoQuote = res;
    return res;
  }
  return null;
}

async function checkLicense(){
  const st=await api('/api/license/status');
  if(st && st.locked && (USER&&USER.role!=='admin')){
    toast((st.reason||t('locked')),'error');
    logout();
    return false;
  }
  return true;
}


function applyRoleUI(){
  const role = (USER && USER.role) || 'cashier';
  // Cashiers/managers cannot edit store name
  const nameEl = document.getElementById('s-name');
  const posEl = document.getElementById('s-pos-name');
  const canEdit = role === 'admin';
  if(nameEl){ nameEl.disabled = !canEdit; }
  if(posEl){ posEl.disabled = !canEdit; }
  // hide HO-ish if any
  document.querySelectorAll('[data-role]').forEach(el=>{
    const need = (el.getAttribute('data-role')||'').split(',');
    el.style.display = (role==='admin' || need.includes(role)) ? '' : 'none';
  });
}

async function loadAppSettings(){
  const res = await api('/api/settings');
  if(!res || !res.ok) return;
  const sn=document.getElementById('s-name'); if(sn) sn.value = res.store_name||'';
  const pn=document.getElementById('s-pos-name'); if(pn) pn.value = res.pos_name||'';
  const pol=document.getElementById('s-policy'); if(pol) pol.value = res.policy||'';
  const lg=document.getElementById('s-lang'); if(lg) lg.value = res.language||LANG||'en';
  if(res.language){ LANG=res.language; localStorage.setItem('anta_lang', LANG); applyLang(); }
  applyRoleUI();
}

// boot last — after all helpers exist
(async function boot() {
  try {
    const savedUrl = localStorage.getItem('anta_api_url');
    if (savedUrl) CFG.apiUrl = savedUrl;
    try { applyLang(); } catch (e) {}
    try { await loadBranding(); } catch (e) {}
    await initLogin();
  } catch (e) {
    console.error('boot failed', e);
    try {
      const sel = document.getElementById('login-store');
      if (sel && !sel.options.length) {
        sel.innerHTML = '<option value="s1">Store 1 — Tripoli</option><option value="s2">Store 2 — Benghazi</option><option value="s3">Store 3 — Misrata</option><option value="HO">Head Office</option>';
      }
    } catch (e2) {}
  }
})();