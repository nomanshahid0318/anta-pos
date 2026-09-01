// ============ THEME CUSTOMIZATION SYSTEM ============
const THEME_PRESETS=[
  {name:'ANTA Red',navy:'#101b36',accent:'#e0294d',accent2:'#2e5aeb'},
  {name:'Ocean',navy:'#0c2340',accent:'#00a8a8',accent2:'#0077b6'},
  {name:'Emerald',navy:'#0b2e23',accent:'#059669',accent2:'#0d9488'},
  {name:'Sunset',navy:'#3d1e12',accent:'#ea580c',accent2:'#f59e0b'},
  {name:'Royal',navy:'#241b3d',accent:'#7c3aed',accent2:'#a855f7'},
  {name:'Charcoal Gold',navy:'#1a1a1a',accent:'#c9a227',accent2:'#8a7530'},
  {name:'Slate',navy:'#1e293b',accent:'#0ea5e9',accent2:'#64748b'},
  {name:'Burgundy',navy:'#2d1220',accent:'#9f1239',accent2:'#be185d'},
];
function _hexToRgb(h){h=h.replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');const n=parseInt(h,16);return [(n>>16)&255,(n>>8)&255,n&255];}
function _rgbToHex([r,g,b]){return '#'+[r,g,b].map(c=>Math.max(0,Math.min(255,Math.round(c))).toString(16).padStart(2,'0')).join('');}
function _shadeDarken(hex,pct){const [r,g,b]=_hexToRgb(hex);return _rgbToHex([r*(1-pct),g*(1-pct),b*(1-pct)]);}
function _shadeLighten(hex,pct){const [r,g,b]=_hexToRgb(hex);return _rgbToHex([r+(255-r)*pct,g+(255-g)*pct,b+(255-b)*pct]);}
function deriveTheme(navy,accent,accent2){
  return {
    navy, navy2:_shadeLighten(navy,0.18), blue:_shadeLighten(navy,0.30),
    accent, accentDark:_shadeDarken(accent,0.18),
    accent2, accent2Light:_shadeLighten(accent2,0.92),
  };
}
function applyTheme(t){
  const r=document.documentElement.style;
  r.setProperty('--navy',t.navy); r.setProperty('--navy2',t.navy2); r.setProperty('--blue',t.blue);
  r.setProperty('--accent',t.accent); r.setProperty('--accent-dark',t.accentDark);
  r.setProperty('--accent2',t.accent2); r.setProperty('--accent2-light',t.accent2Light);
}
function saveTheme(navy,accent,accent2){
  const t=deriveTheme(navy,accent,accent2);
  applyTheme(t);
  localStorage.setItem('anta_theme',JSON.stringify({navy,accent,accent2}));
  try{ api('/api/settings',{method:'PUT',body:{appTheme:JSON.stringify({navy,accent,accent2})}}); }catch(e){}
}
function loadSavedTheme(){
  try{
    const saved=localStorage.getItem('anta_theme');
    if(saved){ const c=JSON.parse(saved); applyTheme(deriveTheme(c.navy,c.accent,c.accent2)); return c; }
  }catch(e){}
  return null;
}
function resetTheme(){
  localStorage.removeItem('anta_theme');
  applyTheme(deriveTheme(THEME_PRESETS[0].navy,THEME_PRESETS[0].accent,THEME_PRESETS[0].accent2));
  try{ api('/api/settings',{method:'PUT',body:{appTheme:''}}); }catch(e){}
}
// Apply saved theme immediately on script load (before most rendering) to avoid a flash of default colors.
loadSavedTheme();
/* ANTA Head Office v4 — DB API client (no Google Sheets) */
const DEFAULT_API=(location.origin&&location.origin.startsWith('http'))?location.origin:'http://127.0.0.1:8765';
let CFG={apiUrl:localStorage.getItem('anta_ho_api')||DEFAULT_API,token:localStorage.getItem('anta_ho_token')||''};
let DATA={stores:[],users:[],banks:[],products:[],warehouse:[],supplierGRNs:[],storeGRNs:[],transfers:[],expenses:[],dashboard:null,sales:[],inventory:[],categories:['Running','Casual','Basketball','Training','Kids','Slippers','Other'],settings:{company:'ANTA Shoes Libya',currency:'LYD'}}

// Pagination and search for products — server-side: only the current
// page (prodPageSize rows) is ever fetched, never the full catalog.
let prodPageSize=20;
let prodCurrentPage=1;
let prodSearchQuery='';
let prodPageItems=[];   // rows for the currently-shown page only
let prodTotalCount=0;   // total matching rows, from the server
let prodFilteredList=[]; // kept for backward-compat with any leftover references; mirrors prodPageItems
let sgrnLines=[],stgrnLines=[],trLines=[],suppliers=[],supplierTxns=[],capitalEntries=[],bsEntries=[],cfItems={investing:[],financing:[]};
let poLines=[],__poList=[],__poReceiveTarget=null;
let isOnline=false,pinEntry='',currentUser=null;
const $=id=>document.getElementById(id);
const today=()=>new Date().toISOString().split('T')[0];
const fmt=n=>'LYD '+(+n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
function toggleSidebar(){
  const sb=document.getElementById('sidebar'),bd=document.getElementById('sidebar-backdrop');
  if(!sb)return;
  const opening=!sb.classList.contains('open');
  sb.classList.toggle('open',opening);
  if(bd)bd.classList.toggle('open',opening);
}
function toast(msg,type='ok'){
  const container=$('toast-container');
  if(!container)return;
  const icons={ok:'✅',error:'❌',warn:'⚠️',info:'ℹ️'};
  const el=document.createElement('div');
  el.className='toast '+type;
  el.innerHTML=`<span class="toast-ico">${icons[type]||icons.ok}</span><span class="toast-msg"></span><span class="toast-close">✕</span>`;
  el.querySelector('.toast-msg').textContent=msg;
  const remove=()=>{el.classList.add('leaving');setTimeout(()=>el.remove(),200);};
  el.querySelector('.toast-close').onclick=remove;
  container.appendChild(el);
  setTimeout(remove,type==='error'?5000:3200);
}
let _hoLoadTimer=null,_hoLoadStart=0;
function _hoTickLoadLabel(){
  const secs=Math.floor((Date.now()-_hoLoadStart)/1000);
  const hint=secs>=8?' — server waking up, first load can take up to ~60s':'';
  const l=$('sync-lbl');if(l)l.textContent='🔄 Loading ('+secs+'s)'+hint;
  const tl=$('top-lbl');if(tl)tl.textContent='Loading ('+secs+'s)'+hint;
}
function setSyncStatus(state,label){[$('sync-dot'),$('top-dot')].forEach(d=>{if(d)d.className='dot '+state;});
  if(state==='syncing'){
    if(!_hoLoadTimer){_hoLoadStart=Date.now();_hoTickLoadLabel();_hoLoadTimer=setInterval(_hoTickLoadLabel,1000);}
  }else if(_hoLoadTimer){clearInterval(_hoLoadTimer);_hoLoadTimer=null;}
  if(state!=='syncing'){const l=$('sync-lbl');if(l)l.textContent=state==='online'?'🟢 Connected':'🔴 Offline';const tl=$('top-lbl');if(tl)tl.textContent=state==='online'?'Online':'Offline';}
  const sl=$('sync-last');if(sl&&label)sl.textContent=label;isOnline=state==='online';}
let _hoAutoRefreshTimer=null,_hoAutoRefreshing=false;
function startHoAutoRefresh(){
  // Background refresh every 90s on top of the manual 🔄 Refresh button.
  // Guarded so a slow refresh never overlaps the next tick (which is what
  // caused the DB connection pool to fill up before).
  if(_hoAutoRefreshTimer)return;
  _hoAutoRefreshTimer=setInterval(async()=>{
    if(!CFG.token||_hoAutoRefreshing)return;
    _hoAutoRefreshing=true;
    try{await loadAll();}catch(_e){}
    finally{_hoAutoRefreshing=false;}
  },90000);
}
function authHeaders(json=true){const h={};if(json)h['Content-Type']='application/json';if(CFG.token)h.Authorization='Bearer '+CFG.token;return h;}
async function api(path,opts={}){const url=(CFG.apiUrl||DEFAULT_API).replace(/\/$/,'')+path;try{const res=await fetch(url,{method:opts.method||'GET',headers:authHeaders(!!opts.body),body:opts.body?JSON.stringify(opts.body):undefined});const data=await res.json().catch(()=>null);if(!res.ok)return{ok:false,status:'error',msg:(data&&(data.detail||data.msg))||res.statusText};return data;}catch(e){return{ok:false,status:'error',msg:e.message};}}
function pinPress(d){if(pinEntry.length>=4)return;pinEntry+=d;$('pin-display').textContent='●'.repeat(pinEntry.length)+'—'.repeat(4-pinEntry.length);}
function pinClear(){pinEntry=pinEntry.slice(0,-1);$('pin-display').textContent='●'.repeat(pinEntry.length)+'—'.repeat(4-pinEntry.length);}
async function pinSubmit(){
  if(!pinEntry){
    const e=$('login-error'); if(e){e.style.display='block';e.textContent='Enter PIN';}
    return;
  }
  const storeId=($('login-store')&&$('login-store').value)||'HO';
  const e=$('login-error'); if(e){e.style.display='none';e.textContent='';}
  setSyncStatus('syncing','Signing in...');
  const empCode=($('login-empcode')&&$('login-empcode').value.trim())||undefined;
  const res=await api('/api/auth/login',{method:'POST',body:{store_id:storeId,pin:pinEntry,employeeCode:empCode}});
  const token=res&&(res.access_token||res.accessToken);
  const user=res&&res.user;
  if(token&&user){
    const role=(user.role||'').toLowerCase();
    if(role!=='admin'&&role!=='manager'&&role!=='accountant'&&role!=='merchandiser'&&role!=='warehouse'){
      if(e){e.style.display='block';e.textContent='HO requires admin, manager, merchandiser, warehouse or accountant';}
      pinEntry=''; if($('pin-display'))$('pin-display').textContent='----';
      return;
    }
    CFG.token=token;
    localStorage.setItem('anta_ho_token',CFG.token);
    currentUser=user;
    try{applyRoleUI();}catch(_err){}
    if($('login-screen'))$('login-screen').style.display='none';
    const app=$('app');
    if(app){app.style.display='flex';app.classList.add('open');}
    try{setSyncStatus('online','Logged in as '+(user.name||role));}catch(_err){}
    try{await loadAll();}catch(_err){console.error(_err); toast('Loaded with some errors','warn');}
    try{show('dashboard');}catch(_err){}
    startHoAutoRefresh();
    return;
  }
  const msg=(res&&(res.detail||res.msg||res.message))||'Wrong PIN or server error';
  if(e){e.style.display='block';e.textContent=typeof msg==='string'?msg:JSON.stringify(msg);}
  pinEntry=''; if($('pin-display'))$('pin-display').textContent='----';
  if($('login-empcode'))$('login-empcode').value='';
}
function show(name){const sb=$('sidebar');if(sb&&sb.classList.contains('open'))toggleSidebar();window.__currentScreen=name;if($('content'))$('content').scrollTop=0;document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));const s=$('screen-'+name);if(s)s.classList.add('active');document.querySelectorAll('.nav-item').forEach(n=>{if(n.getAttribute('onclick')&&n.getAttribute('onclick').includes("'"+name+"'"))n.classList.add('active');});const titles={dashboard:'HO Dashboard','stores-view':'All Stores',warehouse:'HO Warehouse','supplier-grn':'Supplier GRN','store-grn':'Send Stock to Stores',transfer:'Stock Transfer',products:'Product Master',pl:'P&L Summary','expenses-ho':'Expenses',reports:'Sales Reports','inventory-ho':'Inventory — All Stores','stores-admin':'Manage Stores',users:'Users & PINs',banks:'Banks & Payments',settings:'Settings','balance-sheet':'Balance Sheet',cashflow:'Cash Flow','supplier-accounts':'Supplier Accounts',capital:'Capital & Equity','fixed-assets':'Fixed Assets','prepaid-expenses':'Prepaid Expenses','employee-advances':'Employee Advances','accrued-expenses':'Accrued Expenses',shifts:'Cashier Shifts','stock-counts':'Stock Take / Physical Count',payroll:'Payroll',attendance:'Attendance',costcenters:'Cost Centers & Projects',addons:'Cheques',budget:'Budget vs Actual','three-way-match':'Invoice Matching','purchase-orders':'Purchase Orders',customers:'Customers','stock-aging':'Stock Aging','audit-log':'Audit Log','barcode-labels':'Barcode Labels',accounts:'Chart of Accounts',handovers:'Cash Handovers',license:'License',promotions:'Promotions'};if($('screen-title'))$('screen-title').textContent=titles[name]||name;
if(name==='prepaid-expenses'){populatePrepaidStoreSelect();loadPrepaidExpenses();}
if(name==='employee-advances'){populateAdvStoreSelect();loadEmployeeAdvances();}
if(name==='accrued-expenses'){populateAccStoreSelect();loadAccruedExpenses();}
if(name==='shifts'){loadShifts();}
if(name==='stock-counts'){populateSCStoreSelect();loadStockCounts();}
if(name==='payroll'){populatePRStoreSelect();loadPayrollRuns();}
if(name==='attendance'){populateAttStoreSelects();loadAttendanceDay();loadAttendanceSummary();}
if(name==='costcenters'){populateCCStoreSelect();loadCostCenters();loadProjects();loadCCReport();loadProjectReport();}
if(name==='addons'){loadCheques();loadChequesDueSoon();}
if(name==='budget'){if($('bud-month')&&!$('bud-month').value)$('bud-month').value=today().slice(0,7);loadBudgetReport();}
if(name==='three-way-match'){populateTWMPOSelect();loadSupplierInvoices();}
if(name==='dashboard')renderDash();if(name==='stores-view')renderStoresView();if(name==='warehouse')renderWarehouse();
if(name==='audit-log'){loadAuditLog();}
if(name==='stock-aging'){loadStockAging();}
if(name==='customers'){loadCustomersHO();}
if(name==='purchase-orders'){if($('po-date'))$('po-date').value=today();poLines=[];renderPOLines();populateSupplierSelect();loadPOs();}
if(name==='supplier-grn'){sgrnHistCurrentPage=1;fetchAndRenderSGRNHist();if($('sgrn-date'))$('sgrn-date').value=today();if($('sgrn-id'))$('sgrn-id').value='SGRN-'+Date.now().toString().slice(-6);}
if(name==='store-grn'){stgrnPendingCurrentPage=1;stgrnDoneCurrentPage=1;fetchAndRenderStGRNPending();fetchAndRenderStGRNDone();populateStoreSelects();if($('stgrn-date'))$('stgrn-date').value=today();if($('stgrn-id'))$('stgrn-id').value='GRN-'+Date.now().toString().slice(-6);}
if(name==='transfer'){renderTrHist();populateStoreSelects();}if(name==='products'){prodCurrentPage=1;fetchAndRenderProductsPage();}
if(name==='pl'){plPreset();populateStoreSelects('pl-store');loadPL();}if(name==='expenses-ho'){populateStoreSelects('exp-store-filter');populateStoreSelects('ho-exp-store');if($('ho-exp-date'))$('ho-exp-date').value=today();loadExpenses();populateExpenseCCDropdowns();}if(name==='promotions')loadPromosHO();if(name==='accounts'){loadTrialBalance();loadCOA();loadJournals();}if(name==='license')loadLicense();
if(name==='reports'){rptPreset();populateStoreSelects('rpt-store');}if(name==='inventory-ho'){invAllCurrentPage=1;fetchAndRenderInvAll();}
if(name==='stores-admin')renderStoresAdmin();if(name==='users'){renderUsers();populateStoreSelects('u-store');}if(name==='banks')renderBanks();
if(name==='settings'){if($('api-url'))$('api-url').value=CFG.apiUrl;loadSettingsForm();renderThemeUI();}
if(name==='balance-sheet'){if($('bs-date'))$('bs-date').value=today();loadBalanceSheet();}
if(name==='cashflow'){cfPreset();loadCashFlow();}if(name==='handovers'){populateStoreSelects('handover-store-filter');loadHOHandovers();}if(name==='supplier-accounts'){renderSupplierAccounts();if($('sup-txn-date'))$('sup-txn-date').value=today();}
if(name==='capital'){if($('cap-date'))$('cap-date').value=today();renderCapital();}
if(name==='fixed-assets'){if($('fa-date'))$('fa-date').value=today();populateStoreSelects('fa-store');loadFixedAssets();}
}
async function fetchInBatches(fns,batchSize){
  // Runs the given zero-arg async functions in small concurrent batches
  // instead of all at once, so we never ask the DB for more connections
  // than it can comfortably hand out in parallel.
  const out=[];
  for(let i=0;i<fns.length;i+=batchSize){
    const batch=fns.slice(i,i+batchSize).map(fn=>fn());
    out.push(...await Promise.all(batch));
  }
  return out;
}
function currentScreenName(){const el=document.querySelector('.screen.active');return el?el.id.replace('screen-',''):'';}
async function loadAll(){if(!CFG.token){toast('Login first','warn');return;}setSyncStatus('syncing','Loading...');toast('🔄 Loading live data...','info');
api('/api/settings').then(r=>{if(r&&r.ok)syncThemeFromServer(r.appTheme);}).catch(()=>{});
try{const [dash,sales,banks,stores,users,exps,wh,sgrns,stgrns,trs,sups,suptx,caps,bs,cf]=await fetchInBatches([
()=>api('/api/dashboard'),()=>api('/api/sales?limit=500'),()=>api('/api/banks'),()=>api('/api/stores/all'),()=>api('/api/auth/users'),()=>api('/api/expenses?limit=300'),
()=>api('/api/ho/warehouse'),()=>api('/api/ho/supplier-grns'),()=>api('/api/ho/store-grns'),()=>api('/api/ho/transfers'),()=>api('/api/ho/suppliers'),()=>api('/api/ho/supplier-txns'),()=>api('/api/ho/capital'),()=>api('/api/ho/bs-entries'),()=>api('/api/ho/cf-items')],4);
if(dash&&dash.ok){DATA.dashboard=dash;generateNotifications(dash);}
if(sales&&sales.data)DATA.sales=sales.data.map(s=>({...s,Date:s.date,Total:s.total,Payment:s.payment,Store:s.store,StoreID:s.storeId}));
if(Array.isArray(banks))DATA.banks=banks.map(b=>({BankID:b.bank_id,Name:b.name,Device:b.device,Active:b.active?'Y':'N'}));
const storeRows=Array.isArray(stores)?stores:(stores&&Array.isArray(stores.data)?stores.data:[]);if(storeRows.length||Array.isArray(stores)||(stores&&stores.data))DATA.stores=storeRows.map(s=>({StoreID:s.store_id||s.StoreID,Name:s.name||s.Name,City:s.city||s.City||'',Address:s.address||s.Address||'',Manager:s.manager||s.Manager||'',Phone:s.phone||s.Phone||'',Active:(s.active===false||s.Active==='N')?'N':'Y'}));
if(Array.isArray(users))DATA.users=users.map(u=>({UserID:u.user_id,StoreID:u.store_id,StoreName:u.store_name,Name:u.name,Role:u.role,Active:u.active?'Y':'N',PosLoginEnabled:u.posLoginEnabled!==false,EmployeeCode:u.employeeCode||'',StandardSalary:u.standardSalary||0,CommissionRate:u.commissionRate||0}));
if(exps&&exps.data)DATA.expenses=exps.data.map(e=>({...e,Date:e.date,Amount:e.amount,Store:e.store,StoreID:e.storeId,Category:e.category,Description:e.description,PayMethod:e.payMethod}));
if(wh&&wh.data)DATA.warehouse=wh.data;if(sgrns&&sgrns.data)DATA.supplierGRNs=sgrns.data;if(stgrns&&stgrns.data)DATA.storeGRNs=stgrns.data;if(trs&&trs.data)DATA.transfers=trs.data;
if(sups&&sups.data)suppliers=sups.data;if(suptx&&suptx.data)supplierTxns=suptx.data;if(caps&&caps.data)capitalEntries=caps.data;
if(bs&&bs.data)bsEntries=bs.data.map(b=>({id:b.id,type:b.type,desc:b.desc,amount:b.amount,date:b.date}));
if(cf&&cf.data){cfItems={investing:[],financing:[]};cf.data.forEach(c=>{if(!cfItems[c.section])cfItems[c.section]=[];cfItems[c.section].push({label:c.label,value:c.value});});}
setSyncStatus('online','Loaded: '+new Date().toLocaleTimeString());if($('dash-status'))$('dash-status').textContent='Live data loaded: '+new Date().toLocaleTimeString();
renderDash();populateStoreSelects();try{await loadCategories();}catch(_e){}
if(currentScreenName()==='products'){try{await fetchAndRenderProductsPage();}catch(_e){}}
toast('✅ All data loaded!');}catch(e){setSyncStatus('offline','Error');toast('❌ '+e.message,'error');}}
// ---------- Notifications (real data — recent sales + low stock, no fake events) ----------
let NOTIFICATIONS=[],__notifSeenSales=new Set(),__notifSeenLowStock=new Set(),__notifFirstLoad=true;
function generateNotifications(dash){
  if(!dash)return;
  const isNew=!__notifFirstLoad;
  (dash.recentSales||[]).forEach(s=>{
    if(__notifSeenSales.has(s.id))return;
    __notifSeenSales.add(s.id);
    NOTIFICATIONS.unshift({id:'sale-'+s.id,icon:'🛒',title:'New Sale',msg:`${s.id} — ${fmt(s.total||0)} · ${s.customer||'Walk-in'}`,ts:Date.now(),read:!isNew,screen:'reports'});
    if(isNew)toast(`🛒 New Sale: ${s.id} — ${fmt(s.total||0)}`,'info');
  });
  (dash.lowStock||[]).forEach(l=>{
    const key=(l.store||'')+'-'+l.barcode;
    if(__notifSeenLowStock.has(key))return;
    __notifSeenLowStock.add(key);
    const out=(l.onHand||0)<=0;
    NOTIFICATIONS.unshift({id:'stock-'+key,icon:out?'🔴':'⚠️',title:out?'Out of Stock':'Low Stock',msg:`${l.name} — ${l.store||''}`,ts:Date.now(),read:!isNew,screen:'stock-aging'});
    if(isNew)toast(`${out?'🔴':'⚠️'} ${out?'Out of stock':'Low stock'}: ${l.name}`,'warn');
  });
  NOTIFICATIONS=NOTIFICATIONS.slice(0,60);
  __notifFirstLoad=false;
  updateNotifBadge();
  if($('notif-panel')&&$('notif-panel').style.display==='block')renderNotifList();
}
function updateNotifBadge(){
  const n=NOTIFICATIONS.filter(x=>!x.read).length;
  const b=$('notif-badge');
  if(!b)return;
  if(n>0){b.textContent=n>99?'99+':n;b.style.display='flex';}
  else b.style.display='none';
}
function timeAgo(ts){
  const s=Math.floor((Date.now()-ts)/1000);
  if(s<60)return 'just now';
  if(s<3600)return Math.floor(s/60)+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
function renderNotifList(){
  const list=$('notif-list');
  if(!list)return;
  if(!NOTIFICATIONS.length){
    list.innerHTML='<div style="padding:32px 16px;text-align:center;color:var(--gray3)"><div style="font-size:26px;margin-bottom:6px">🔔</div><div style="font-size:12px">No notifications yet</div></div>';
    return;
  }
  list.innerHTML=NOTIFICATIONS.map((n,i)=>`<div onclick="openNotif(${i})" style="display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--gray1);cursor:pointer;${n.read?'':'background:var(--accent2-light)'}" onmouseover="this.style.background='var(--gray0)'" onmouseout="this.style.background='${n.read?'':'var(--accent2-light)'}'">
    <span style="font-size:16px;flex-shrink:0">${n.icon}</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;font-weight:700;color:var(--navy)">${n.title}${n.read?'':' <span style=\"display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent2);margin-left:3px\"></span>'}</div>
      <div style="font-size:11px;color:var(--gray4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n.msg}</div>
      <div style="font-size:9.5px;color:var(--gray3);margin-top:2px">${timeAgo(n.ts)}</div>
    </div>
  </div>`).join('');
}
function openNotif(i){
  const n=NOTIFICATIONS[i];
  if(!n)return;
  n.read=true;
  updateNotifBadge();
  closeAllTopMenus();
  if(n.screen)show(n.screen);
}
function markAllNotifsRead(){
  NOTIFICATIONS.forEach(n=>n.read=true);
  updateNotifBadge();
  renderNotifList();
}

async function loadCategories(){
  const res=await api('/api/categories');
  if(res&&res.ok&&Array.isArray(res.categories)&&res.categories.length)DATA.categories=res.categories;
  renderCategoryOptions();
}
function renderCategoryOptions(){
  const cats=DATA.categories||[];
  const sel=$('p-cat');
  if(sel){const cur=sel.value;sel.innerHTML=cats.map(c=>`<option>${c}</option>`).join('');if(cur&&cats.includes(cur))sel.value=cur;}
  const list=$('cat-list');
  if(list)list.innerHTML=cats.map(c=>`<span class="badge badge-gray" style="margin:3px 5px 3px 0;display:inline-flex;align-items:center;gap:5px">${c}<span style="cursor:pointer;opacity:.65" onclick="removeCategory('${c.replace(/'/g,"\\'")}')" title="Remove">✕</span></span>`).join('')||'<span style="color:var(--gray3);font-size:12px">No categories yet — add one below</span>';
}
async function addCategory(){
  const inp=$('new-cat-name');
  const name=((inp&&inp.value)||'').trim();
  if(!name){toast('Enter a category name','warn');return;}
  const res=await api('/api/categories',{method:'POST',body:{name}});
  if(res&&res.ok){DATA.categories=res.categories;renderCategoryOptions();if(inp)inp.value='';toast('✅ Category added — it now appears in the product form and the download template');}
  else toast('❌ '+((res&&res.msg)||'Failed to add category'),'error');
}
async function removeCategory(name){
  if(!confirm('Remove category "'+name+'"?\n\nExisting products keep their category text — this only removes it from the picker and future templates.'))return;
  const res=await api('/api/categories/'+encodeURIComponent(name),{method:'DELETE'});
  if(res&&res.ok){DATA.categories=res.categories;renderCategoryOptions();toast('Category removed');}
  else toast('❌ '+((res&&res.msg)||'Failed'),'error');
}
function populateStoreSelects(id){const ids=id?[id]:['stgrn-store','tr-from','tr-to','pl-store','rpt-store','exp-store-filter','u-store','bs-store','recalc-store','fa-store'];const stores=DATA.stores.length?DATA.stores.filter(s=>s.StoreID!=='HO'):[{StoreID:'s1',Name:'Store 1 — Tripoli'},{StoreID:'s2',Name:'Store 2 — Benghazi'},{StoreID:'s3',Name:'Store 3 — Misrata'}];ids.forEach(selId=>{const el=$(selId);if(!el)return;const hasAll=!['stgrn-store','tr-from','tr-to','u-store','recalc-store','fa-store'].includes(selId);const storeList=(selId==='u-store'||selId==='fa-store')?[{StoreID:'HO',Name:'Head Office'},...stores]:stores;el.innerHTML=(hasAll?'<option value="all">All Stores</option>':'')+storeList.map(s=>`<option value="${s.StoreID}">${s.Name}</option>`).join('');});}
function renderDash(){const d=DATA.dashboard;const set=(id,v)=>{const el=$(id);if(el)el.textContent=v;};if(d){set('d-rev',fmt(d.totalRevenue||0));set('d-inv',d.totalInvoices||0);set('d-net',fmt(d.netRevenue||0));set('d-atv',fmt(d.atv||0));set('d-ret',fmt(d.totalReturns||0));set('d-ret-pct',d.totalRevenue?(d.totalReturns/d.totalRevenue*100).toFixed(1)+'% return rate':'0%');set('d-ho-stock',DATA.warehouse.filter(w=>(+w.OnHand||0)>0).length);
const pm=d.paymentBreakdown||{},totR=d.totalRevenue||1;if($('d-pay'))$('d-pay').innerHTML=Object.entries(pm).map(([m,v])=>{const pct=Math.round(v/totR*100);return`<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px"><span>${m}</span><span class="fw7">${fmt(v)} (${pct}%)</span></div><div style="background:var(--gray1);border-radius:4px;height:7px"><div style="background:var(--accent2);width:${pct}%;height:100%;border-radius:4px"></div></div></div>`;}).join('')||'<div style="color:var(--gray3);font-size:11px;padding:14px;text-align:center">Load data first</div>';
if($('d-low'))$('d-low').innerHTML=(d.lowStock||[]).slice(0,8).map(i=>`<tr><td style="font-size:11px">${i.store||'—'}</td><td class="fw7" style="font-size:11px">${String(i.name||i.barcode||'').slice(0,28)}</td><td style="font-weight:800;color:${+i.onHand<=0?'var(--red)':'var(--amber)'}">${i.onHand}</td><td><button class="btn btn-green btn-sm" onclick="show('store-grn')">📦</button></td></tr>`).join('')||'<tr><td colspan="4"><div class="empty-state"><div class="ico">✅</div><div class="title">All stock levels healthy</div><div class="sub">No low-stock alerts right now</div></div></td></tr>';}
const stores=DATA.stores.length?DATA.stores.filter(s=>s.StoreID!=='HO'):[{StoreID:'s1',Name:'Store 1 — Tripoli'},{StoreID:'s2',Name:'Store 2 — Benghazi'},{StoreID:'s3',Name:'Store 3 — Misrata'}];
const sb=DATA.dashboard?.storeBreakdown||[];
const lbRows=stores.map(s=>{const b=sb.find(x=>x.store===s.Name||x.store===s.StoreID||x.name===s.Name);return {name:s.Name,rev:b?(b.revenue||0):null,invoices:b?(b.invoices||0):0,returns:b?(b.returns||0):0,hasData:!!b};}).sort((a,b)=>(b.rev||0)-(a.rev||0));
const maxRev=Math.max(...lbRows.map(r=>r.rev||0),1);
if($('store-cards'))$('store-cards').innerHTML=lbRows.map((r,i)=>{
  if(!r.hasData)return `<div class="lb-row"><div class="lb-rank">${i+1}</div><div class="lb-name">${r.name}</div><div class="lb-track"></div><div class="lb-stats"><span class="badge badge-gray">No data</span></div></div>`;
  const pct=Math.max(3,Math.round(r.rev/maxRev*100));
  const net=r.rev-r.returns;
  return `<div class="lb-row">
    <div class="lb-rank ${i===0?'rank-1':''}">${i+1}</div>
    <div class="lb-name">${r.name}</div>
    <div class="lb-track"><div class="lb-fill" style="width:${pct}%"></div></div>
    <div class="lb-stats">
      <div><div class="lb-stat-value">${fmt(r.rev)}</div><div class="lb-stat-label">Revenue</div></div>
      <div><div class="lb-stat-value">${r.invoices}</div><div class="lb-stat-label">Invoices</div></div>
      <div><div class="lb-stat-value">${fmt(net)}</div><div class="lb-stat-label">Net</div></div>
    </div>
  </div>`;
}).join('')||'<div class="lb-empty">No store data yet — click Load Live Data</div>';
renderRevenueTrend();renderActivityFeed();}
function renderRevenueTrend(){
  const el=$('d-trend');
  if(!el)return;
  const days=[];
  for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);days.push(d.toISOString().split('T')[0]);}
  const byDay={};days.forEach(d=>byDay[d]=0);
  (DATA.sales||[]).forEach(s=>{if(byDay[s.Date]!==undefined)byDay[s.Date]+=(+s.Total||0);});
  const max=Math.max(...days.map(d=>byDay[d]),1);
  const total=days.reduce((a,d)=>a+byDay[d],0);
  if(!total){el.innerHTML='<div style="text-align:center;color:var(--gray3);padding:30px;font-size:12px">No sales in the last 7 days yet</div>';return;}
  el.innerHTML=`<div class="bar-wrap" style="height:120px">${days.map(d=>{
    const v=byDay[d];const h=Math.max(4,Math.round(v/max*100));
    const lbl=new Date(d+'T00:00:00').toLocaleDateString(undefined,{weekday:'short'});
    return `<div class="bar-grp" title="${d}: ${fmt(v)}"><div class="bar" style="height:${h}px;background:var(--accent2)"></div><div class="bar-lbl">${lbl}</div></div>`;
  }).join('')}</div><div style="margin-top:10px;font-size:11px;color:var(--gray4)">7-day total: <b style="color:var(--navy)">${fmt(total)}</b></div>`;
}
function renderActivityFeed(){
  const el=$('d-activity');
  if(!el)return;
  const sales=(DATA.dashboard&&DATA.dashboard.recentSales)||[];
  if(!sales.length){el.innerHTML='<div style="text-align:center;color:var(--gray3);padding:24px;font-size:12px">No recent activity</div>';return;}
  el.innerHTML=sales.slice(0,10).map(s=>`<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--gray1)">
    <span style="font-size:15px">🛒</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;font-weight:700;color:var(--navy)">${s.id} <span style="font-weight:400;color:var(--gray4)">· ${s.customer||'Walk-in'}</span></div>
      <div style="font-size:11px;color:var(--gray4)">${s.date} ${s.time||''} · ${s.payment||''}</div>
    </div>
    <div style="font-weight:800;color:var(--green);font-size:12.5px;white-space:nowrap">${fmt(s.total||0)}</div>
  </div>`).join('');
}
function renderStoresView(){const sb=DATA.dashboard?.storeBreakdown||[];const stores=DATA.stores.filter(s=>s.StoreID!=='HO');const rows=stores.map(s=>{const b=sb.find(x=>x.store===s.Name||x.store===s.StoreID)||{revenue:0,invoices:0,returns:0};return{name:s.Name,rev:b.revenue||0,inv:b.invoices||0,ret:b.returns||0,net:(b.revenue||0)-(b.returns||0),atv:b.invoices?b.revenue/b.invoices:0,retPct:b.revenue?b.returns/b.revenue*100:0};}).sort((a,b)=>b.rev-a.rev);const maxR=Math.max(...rows.map(r=>r.rev),1);if($('sv-table'))$('sv-table').innerHTML=rows.map((r,i)=>`<tr><td class="fw7">${i+1}</td><td class="fw7">${r.name}</td><td>${fmt(r.rev)}</td><td>${r.inv}</td><td>${fmt(r.atv)}</td><td class="text-red">${fmt(r.ret)}</td><td>${r.retPct.toFixed(1)}%</td><td class="fw7">${fmt(r.net)}</td><td><span class="badge ${r.rev>0?'badge-green':'badge-gray'}">${r.rev>0?'Active':'No Data'}</span></td></tr>`).join('');}
let selectedWarehouse=new Set();
let whFilteredList=[];
function renderWarehouse(){
  const search=(($('wh-search')||{}).value||'').toLowerCase();
  whFilteredList=DATA.warehouse.filter(w=>!search||(w.Name||'').toLowerCase().includes(search)||String(w.Barcode).includes(search));
  if($('wh-table'))$('wh-table').innerHTML=whFilteredList.map(w=>{
    const oh=+w.OnHand||0;const checked=selectedWarehouse.has(w.Barcode)?'checked':'';
    return `<tr><td><input type="checkbox" ${checked} onchange="toggleWarehouseRow('${w.Barcode}')"></td><td style="font-family:monospace;font-size:10px">${w.Barcode}</td><td class="fw7">${w.Name}</td><td>${w.Brand||'—'}</td><td class="text-green">${w.Supplier_In||0}</td><td class="text-red">${w.Store_Out||0}</td><td style="font-weight:800;color:${oh<=0?'var(--red)':oh<=5?'var(--amber)':'var(--navy)'}">${oh}</td><td><button class="btn btn-primary btn-sm" onclick="sendToStore('${w.Barcode}','${(w.Name||'').replace(/'/g,"\\'")}',${oh})">Send</button></td></tr>`;
  }).join('')||'<tr><td colspan="8" style="text-align:center;color:var(--gray3);padding:18px">No warehouse data</td></tr>';
  const selAll=$('wh-select-all');
  if(selAll)selAll.checked=whFilteredList.length>0&&whFilteredList.every(w=>selectedWarehouse.has(w.Barcode));
  const info=$('wh-selected-info');
  if(info)info.textContent=selectedWarehouse.size?`✅ ${selectedWarehouse.size} row(s) selected`:`${whFilteredList.length} row(s) shown`;
}
function toggleWarehouseRow(bc){if(selectedWarehouse.has(bc))selectedWarehouse.delete(bc);else selectedWarehouse.add(bc);renderWarehouse();}
function exportWarehouse(){
  _csvDownload(whFilteredList,[['Barcode','Barcode'],['Name','Name'],['Brand','Brand'],['Supplier In','Supplier_In'],['Store Out','Store_Out'],['On Hand','OnHand']],'ho_warehouse_'+today()+'.csv');
}
function toggleAllWarehouse(cb){
  if(cb.checked)whFilteredList.forEach(w=>selectedWarehouse.add(w.Barcode));
  else whFilteredList.forEach(w=>selectedWarehouse.delete(w.Barcode));
  renderWarehouse();
}
async function deleteSelectedWarehouse(){
  if(!selectedWarehouse.size){toast('No rows selected','error');return;}
  if(!confirm(`Delete ${selectedWarehouse.size} selected warehouse row(s)? Products stay in Product Master — only warehouse stock is removed. Cannot be undone.`))return;
  const res=await api('/api/ho/warehouse/bulk-delete',{method:'POST',body:Array.from(selectedWarehouse)});
  if(res&&res.ok){toast(`✅ Deleted ${res.deleted} row(s)`);selectedWarehouse=new Set();await loadAll();renderWarehouse();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Delete failed'),'error');
}
function sendToStore(barcode,name,hoStock){
  // "Send" from HO Warehouse jumps to Send-to-Stores and pre-fills THIS
  // product's line, instead of dropping you on an empty form you have to
  // fill in again from scratch. Manually opening the screen and adding
  // lines yourself (the normal "Add Line" flow) still works exactly as
  // before — this is only triggered by the per-row Send button.
  stgrnLines=[{barcode,name,qty:1,hoStock:+hoStock||0}];
  show('store-grn');
  renderStGRNLines();
}
function addSGRNLine(){sgrnLines.push({barcode:'',name:'',qty:1,cost:0});renderSGRNLines();}
function renderSGRNLines(){if(!$('sgrn-lines'))return;$('sgrn-lines').innerHTML=sgrnLines.map((l,i)=>`<tr><td><input class="form-input" style="width:130px;padding:4px 7px;font-size:11px" value="${l.barcode}" oninput="sgrnBC(${i},this.value)"></td><td><input class="form-input" style="padding:4px 7px;font-size:11px" value="${l.name}" oninput="sgrnLines[${i}].name=this.value"></td><td><input class="form-input" type="number" style="width:70px;padding:4px 7px" value="${l.qty}" oninput="sgrnLines[${i}].qty=+this.value;calcSGRN()"></td><td><input class="form-input" type="number" style="width:90px;padding:4px 7px" value="${l.cost}" oninput="sgrnLines[${i}].cost=+this.value;calcSGRN()"></td><td><button class="btn btn-ghost btn-sm" onclick="sgrnLines.splice(${i},1);renderSGRNLines()">✕</button></td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:13px">Add lines</td></tr>';calcSGRN();}
let _sgrnBCDebounce=null;
function sgrnBC(i,bc){
  sgrnLines[i].barcode=bc;
  clearTimeout(_sgrnBCDebounce);
  if(bc.length<4)return;
  _sgrnBCDebounce=setTimeout(async()=>{
    const res=await api('/api/products/lookup/'+encodeURIComponent(bc));
    if(res&&res.ok&&sgrnLines[i]&&sgrnLines[i].barcode===bc){
      sgrnLines[i].name=res.name;sgrnLines[i].cost=+res.cost||0;renderSGRNLines();
    }
  },250);
}
function calcSGRN(){const tot=sgrnLines.reduce((s,l)=>s+l.qty*l.cost,0);if($('sgrn-n'))$('sgrn-n').textContent=sgrnLines.length;if($('sgrn-total'))$('sgrn-total').textContent=fmt(tot);}
function clearSGRN(){sgrnLines=[];renderSGRNLines();}
function toggleSGRNRate(){
  const currency=$('sgrn-currency')?$('sgrn-currency').value:'LYD';
  const isForeign=currency!=='LYD';
  if($('sgrn-rate-group'))$('sgrn-rate-group').style.display=isForeign?'block':'none';
  if($('sgrn-currency-note'))$('sgrn-currency-note').style.display=isForeign?'block':'none';
}
async function saveSGRN(){
  if(!sgrnLines.length){toast('Add lines','error');return;}
  const grnId=$('sgrn-id').value||('SGRN-'+Date.now().toString().slice(-6));
  const meta={grnId,date:$('sgrn-date').value,supplier:$('sgrn-supplier').value,invoiceNo:$('sgrn-inv').value,notes:$('sgrn-notes').value,currency:($('sgrn-currency')&&$('sgrn-currency').value)||'LYD',exchangeRate:+(($('sgrn-rate')&&$('sgrn-rate').value)||1)};
  const startTime=Date.now();
  const logRows=[];
  const CHUNK=300;
  let saved=0,failed=0;
  bupShow('sgrn-bup');
  bupUpdate({prefix:'sgrn-bup',status:'⏳ Saving GRN… keep this tab open',done:0,total:sgrnLines.length,startTime});
  for(let i=0;i<sgrnLines.length;i+=CHUNK){
    const chunk=sgrnLines.slice(i,i+CHUNK);
    const res=await api('/api/ho/supplier-grn',{method:'POST',body:{...meta,lines:chunk}});
    if(res&&res.ok&&Array.isArray(res.results)){
      res.results.forEach(r=>logRows.push(r));
      saved+=res.results.filter(r=>r.status==='saved').length;
      failed+=res.results.filter(r=>r.status==='failed').length;
    } else {
      chunk.forEach(l=>logRows.push({barcode:l.barcode||'?',name:l.name||'',status:'failed',reason:(res&&(res.detail||res.msg))||'request failed — no response from server'}));
      failed+=chunk.length;
    }
    bupUpdate({prefix:'sgrn-bup',status:'⏳ Saving GRN… keep this tab open',done:Math.min(i+CHUNK,sgrnLines.length),total:sgrnLines.length,startTime,failed});
  }
  bupUpdate({prefix:'sgrn-bup',status:'✅ Done',done:sgrnLines.length,total:sgrnLines.length,startTime,failed});
  setTimeout(()=>bupHide('sgrn-bup'),2500);
  if(saved){
    toast(`✅ GRN ${grnId} — ${saved} item(s) saved`+(failed?`, ${failed} failed — see downloaded log`:''),failed?'warn':'ok');
    window.__lastGrnLines=sgrnLines.slice();
    if($('sgrn-print-labels'))$('sgrn-print-labels').style.display='inline-block';
    sgrnLines=[];renderSGRNLines();$('sgrn-id').value='SGRN-'+Date.now().toString().slice(-6);
    await loadAll();sgrnHistCurrentPage=1;await fetchAndRenderSGRNHist();
  } else {
    toast('❌ GRN save failed — 0 items saved. Check the downloaded log for the reason.','error');
  }
  if(logRows.length)downloadEventLog(logRows);
}
async function deleteSupplierGRN(grnId,btn){
  if(!confirm(`Delete GRN ${grnId}? This reverses its effect on HO Warehouse stock — the products it added will be subtracted back out.`))return;
  const res=await runWithElapsedTimer(btn,'Deleting',()=>api('/api/ho/supplier-grn/'+encodeURIComponent(grnId),{method:'DELETE'}));
  if(res&&res.ok){toast(`✅ GRN ${grnId} deleted — ${res.deleted} line(s), stock reversed`);await loadAll();await fetchAndRenderSGRNHist();}
  else{
    const reason=(res&&(res.detail||res.msg))||'Delete failed';
    toast('❌ '+reason,'error');
    _csvDownload([{grnId,reason}],[['GRN ID','grnId'],['Reason','reason']],'grn_delete_error_'+today()+'.csv');
  }
}
let sgrnHistPageSize=20,sgrnHistCurrentPage=1,sgrnHistSearchQuery='',sgrnHistPageItems=[],sgrnHistTotalCount=0;
let selectedGrnLines=new Set(); // now holds grnId strings (whole GRNs), not individual line ids
async function fetchAndRenderSGRNHist(){
  const offset=(sgrnHistCurrentPage-1)*sgrnHistPageSize;
  const qs=new URLSearchParams({limit:String(sgrnHistPageSize),offset:String(offset)});
  if(sgrnHistSearchQuery)qs.set('q',sgrnHistSearchQuery);
  if($('sgrn-hist'))$('sgrn-hist').innerHTML='<tr><td colspan="9" style="text-align:center;color:var(--gray3);padding:13px">⏳ Loading…</td></tr>';
  try{
    const res=await api('/api/ho/supplier-grns-summary?'+qs.toString());
    sgrnHistPageItems=(res&&res.data)?res.data:[];
    sgrnHistTotalCount=(res&&typeof res.count==='number')?res.count:sgrnHistPageItems.length;
  }catch(_e){sgrnHistPageItems=[];sgrnHistTotalCount=0;toast('❌ Failed to load GRN history','error');}
  renderSGRNHistTable();
  renderSGRNHistPagination();
}
function renderSGRNHistTable(){
  if($('sgrn-hist'))$('sgrn-hist').innerHTML=sgrnHistPageItems.map(g=>{
    const checked=selectedGrnLines.has(g.grnId)?'checked':'';
    return `<tr><td><input type="checkbox" ${checked} onchange="toggleGrnLine('${g.grnId}')"></td><td class="fw7">${g.grnId}</td><td>${g.date}</td><td>${g.supplier}</td><td>${g.invoiceNo||'—'}</td><td>${g.items} item${g.items===1?'':'s'}</td><td>${g.qty}</td><td>${fmt(g.totalCost||0)}</td><td><button class="btn btn-ghost btn-sm" onclick="viewSGRNDetail('${g.grnId}')" title="View line items">👁️</button> <button class="btn btn-ghost btn-sm" onclick="deleteWholeSupplierGRN('${g.grnId}')" title="Delete this whole GRN — reverses all its lines">🗑</button></td></tr>`;
  }).join('')||'<tr><td colspan="9" style="text-align:center;color:var(--gray3);padding:13px">No GRNs</td></tr>';
  const selAll=$('sgrn-hist-select-all');
  if(selAll)selAll.checked=sgrnHistPageItems.length>0&&sgrnHistPageItems.every(g=>selectedGrnLines.has(g.grnId));
  updateSgrnHistSelectedInfo();
}
function toggleGrnLine(grnId){if(selectedGrnLines.has(grnId))selectedGrnLines.delete(grnId);else selectedGrnLines.add(grnId);renderSGRNHistTable();}
function toggleAllGrnLines(cb){
  if(cb.checked)sgrnHistPageItems.forEach(g=>selectedGrnLines.add(g.grnId));
  else sgrnHistPageItems.forEach(g=>selectedGrnLines.delete(g.grnId));
  renderSGRNHistTable();
}
async function selectAllMatchingGrnLines(){
  if(!sgrnHistTotalCount){toast('Nothing to select','warn');return;}
  toast('⏳ Selecting all matching GRNs…','info');
  const qs=new URLSearchParams({limit:String(Math.max(sgrnHistTotalCount,1))});
  if(sgrnHistSearchQuery)qs.set('q',sgrnHistSearchQuery);
  const res=await api('/api/ho/supplier-grns-summary?'+qs.toString());
  if(res&&res.data){res.data.forEach(g=>selectedGrnLines.add(g.grnId));renderSGRNHistTable();toast(`✅ ${selectedGrnLines.size} GRN(s) selected`);}
  else toast('❌ Failed to select all — try again','error');
}
function clearGrnLineSelection(){selectedGrnLines=new Set();renderSGRNHistTable();}
function updateSgrnHistSelectedInfo(){
  const el=$('sgrn-hist-selected-info');
  if(!el)return;
  el.textContent=selectedGrnLines.size?`✅ ${selectedGrnLines.size} GRN(s) selected · ${sgrnHistTotalCount} total match`:`${sgrnHistTotalCount} GRN(s) total`;
}
async function deleteSupplierGRNLine(id){
  if(!confirm('Delete this GRN line? This reverses its qty from HO Warehouse stock.'))return;
  const res=await api('/api/ho/supplier-grn-line/'+id,{method:'DELETE'});
  if(res&&res.ok){toast('🗑️ Deleted');await loadAll();if(__sgrnDetailGrnId)viewSGRNDetail(__sgrnDetailGrnId);await fetchAndRenderSGRNHist();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Delete failed'),'error');
}
async function deleteWholeSupplierGRN(grnId){
  if(!confirm(`Delete GRN ${grnId} entirely? This reverses ALL its lines' stock from HO Warehouse. Cannot be undone.`))return;
  const res=await api('/api/ho/supplier-grn/'+encodeURIComponent(grnId),{method:'DELETE'});
  if(res&&res.ok){toast(`🗑️ Deleted GRN ${grnId}`);selectedGrnLines.delete(grnId);await loadAll();await fetchAndRenderSGRNHist();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Delete failed'),'error');
}
async function deleteSelectedGrnLines(){
  if(!selectedGrnLines.size){toast('No GRNs selected','error');return;}
  if(!confirm(`Delete ${selectedGrnLines.size} selected GRN(s) entirely? This reverses all their lines' stock from HO Warehouse. This cannot be undone.`))return;
  const ids=Array.from(selectedGrnLines);
  let ok=0,failed=0;
  for(const grnId of ids){
    const res=await api('/api/ho/supplier-grn/'+encodeURIComponent(grnId),{method:'DELETE'});
    if(res&&res.ok)ok++;else failed++;
  }
  toast(`🗑️ Deleted ${ok} GRN(s)`+(failed?`, ${failed} failed`:''),failed?'warn':'ok');
  selectedGrnLines=new Set();
  await loadAll();await fetchAndRenderSGRNHist();
}
let __sgrnDetailGrnId=null;
async function viewSGRNDetail(grnId){
  __sgrnDetailGrnId=grnId;
  const res=await api('/api/ho/supplier-grns?q='+encodeURIComponent(grnId)+'&limit=500');
  const lines=((res&&res.data)||[]).filter(l=>l.GRNID===grnId);
  if($('sgrn-detail-title'))$('sgrn-detail-title').textContent='📦 '+grnId+' — Line Items';
  if($('sgrn-detail-lines'))$('sgrn-detail-lines').innerHTML=lines.map(l=>`<tr><td style="font-family:monospace;font-size:10px">${l.Barcode}</td><td>${l.Name}</td><td>${l.Qty}</td><td>${fmt(l.UnitCost||0)}</td><td><button class="btn btn-ghost btn-sm" onclick="deleteSupplierGRNLine(${l.id})" title="Delete this line only">🗑</button></td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:14px">No lines found</td></tr>';
  $('sgrn-detail-modal').style.display='flex';
}
function closeSGRNDetail(){$('sgrn-detail-modal').style.display='none';__sgrnDetailGrnId=null;}
let sgrnHistSearchDebounce=null;
function searchSGRNHist(query){
  clearTimeout(sgrnHistSearchDebounce);
  sgrnHistSearchDebounce=setTimeout(()=>{sgrnHistSearchQuery=String(query||'').trim();sgrnHistCurrentPage=1;fetchAndRenderSGRNHist();},180);
}
function clearSGRNHistSearch(){
  clearTimeout(sgrnHistSearchDebounce);
  if($('sgrn-hist-search'))$('sgrn-hist-search').value='';
  sgrnHistSearchQuery='';sgrnHistCurrentPage=1;fetchAndRenderSGRNHist();
}
function renderSGRNHistPagination(){
  const container=$('sgrn-hist-pagination');
  if(!container)return;
  const totalPages=Math.max(1,Math.ceil(sgrnHistTotalCount/sgrnHistPageSize));
  sgrnHistCurrentPage=Math.max(1,Math.min(sgrnHistCurrentPage,totalPages));
  let html='<div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">';
  if(sgrnHistCurrentPage>1)html+=`<button class="btn btn-ghost btn-sm" onclick="sgrnHistCurrentPage--;fetchAndRenderSGRNHist()">← Previous</button>`;
  html+=`<span style="font-size:11px;color:var(--gray4)">Page ${sgrnHistCurrentPage} of ${totalPages}</span>`;
  if(sgrnHistCurrentPage<totalPages)html+=`<button class="btn btn-ghost btn-sm" onclick="sgrnHistCurrentPage++;fetchAndRenderSGRNHist()">Next →</button>`;
  html+='</div>';
  container.innerHTML=html;
}
function downloadSGRNTemplate(){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['Barcode,Name,Qty,UnitCost\n8001000000001,ANTA Running Pro,20,120\n'],{type:'text/csv'}));a.download='supplier_grn_template.csv';a.click();}
async function uploadSGRN(file){if(!file)return;const rows=await readExcel(file);rows.forEach(r=>sgrnLines.push({barcode:String(r.Barcode||'').trim(),name:String(r.Name||'').trim(),qty:+(r.Qty||1),cost:+(r.UnitCost||r.Cost||0)}));renderSGRNLines();toast('✅ '+rows.length+' lines');}
function dropSGRN(e){e.preventDefault();if(e.dataTransfer.files[0])uploadSGRN(e.dataTransfer.files[0]);}
function addStGRNLine(){stgrnLines.push({barcode:'',name:'',qty:1,hoStock:0});renderStGRNLines();}
function renderStGRNLines(){if(!$('stgrn-lines'))return;$('stgrn-lines').innerHTML=stgrnLines.map((l,i)=>`<tr><td><input class="form-input" style="width:130px;padding:4px 7px;font-size:11px" value="${l.barcode}" oninput="stgrnBC(${i},this.value)"></td><td><input class="form-input" style="padding:4px 7px;font-size:11px" value="${l.name}"></td><td style="font-weight:700;color:${l.hoStock<=0?'var(--red)':'var(--green)'}">${l.hoStock}</td><td><input class="form-input" type="number" style="width:70px;padding:4px 7px" value="${l.qty}" oninput="stgrnLines[${i}].qty=+this.value;calcStGRN()"></td><td><button class="btn btn-ghost btn-sm" onclick="stgrnLines.splice(${i},1);renderStGRNLines()">✕</button></td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:13px">Add lines</td></tr>';calcStGRN();}
function stgrnBC(i,bc){stgrnLines[i].barcode=bc;const wh=DATA.warehouse.find(w=>String(w.Barcode)===bc);if(wh){stgrnLines[i].name=wh.Name;stgrnLines[i].hoStock=+wh.OnHand||0;renderStGRNLines();}}
function calcStGRN(){if($('stgrn-n'))$('stgrn-n').textContent=stgrnLines.length;if($('stgrn-total'))$('stgrn-total').textContent=stgrnLines.reduce((s,l)=>s+l.qty,0);}
function clearStGRN(){stgrnLines=[];renderStGRNLines();}
async function issueStoreGRN(){
  const storeId=$('stgrn-store').value;
  if(!storeId||!stgrnLines.length){toast('Select store + lines','error');return;}
  const storeName=(DATA.stores.find(s=>s.StoreID===storeId)||{}).Name||storeId;
  const grnId=$('stgrn-id').value||('GRN-'+Date.now().toString().slice(-6));
  const meta={grnId,date:$('stgrn-date').value,storeId,storeName,notes:$('stgrn-notes').value};
  const startTime=Date.now();
  const logRows=[];
  const CHUNK=300;
  let saved=0,failed=0;
  bupShow('stgrn-bup');
  bupUpdate({prefix:'stgrn-bup',status:'⏳ Issuing stock… keep this tab open',done:0,total:stgrnLines.length,startTime});
  for(let i=0;i<stgrnLines.length;i+=CHUNK){
    const chunk=stgrnLines.slice(i,i+CHUNK);
    const res=await api('/api/ho/store-grn',{method:'POST',body:{...meta,lines:chunk}});
    if(res&&res.ok&&Array.isArray(res.results)){
      res.results.forEach(r=>logRows.push(r));
      saved+=res.results.filter(r=>r.status==='saved').length;
      failed+=res.results.filter(r=>r.status==='failed').length;
    } else {
      chunk.forEach(l=>logRows.push({barcode:l.barcode||'?',name:l.name||'',status:'failed',reason:(res&&(res.detail||res.msg))||'request failed — no response from server'}));
      failed+=chunk.length;
    }
    bupUpdate({prefix:'stgrn-bup',status:'⏳ Issuing stock… keep this tab open',done:Math.min(i+CHUNK,stgrnLines.length),total:stgrnLines.length,startTime,failed});
  }
  bupUpdate({prefix:'stgrn-bup',status:'✅ Done',done:stgrnLines.length,total:stgrnLines.length,startTime,failed});
  setTimeout(()=>bupHide('stgrn-bup'),2500);
  if(saved){
    toast(`✅ Issued ${saved} item(s)`+(failed?`, ${failed} failed — see downloaded log`:''),failed?'warn':'ok');
    stgrnLines=[];renderStGRNLines();$('stgrn-id').value='GRN-'+Date.now().toString().slice(-6);
    await loadAll();renderStGRNTables();
  } else {
    toast('❌ Issue failed — 0 items saved. Check the downloaded log for the reason.','error');
  }
  if(logRows.length)downloadEventLog(logRows);
}
async function deleteStoreGRN(grnId,btn){
  if(!confirm(`Delete GRN ${grnId}? This reverses the stock it reserved from HO Warehouse. Only works while it's still pending (not yet received by the store).`))return;
  const res=await runWithElapsedTimer(btn,'Deleting',()=>api('/api/ho/store-grn/'+encodeURIComponent(grnId),{method:'DELETE'}));
  if(res&&res.ok){toast(`✅ GRN ${grnId} deleted — ${res.deleted} line(s), stock reversed`);await loadAll();renderStGRNTables();}
  else{
    const reason=(res&&(res.detail||res.msg))||'Delete failed';
    toast('❌ '+reason,'error');
    _csvDownload([{grnId,reason}],[['GRN ID','grnId'],['Reason','reason']],'grn_delete_error_'+today()+'.csv');
  }
}
let stgrnPendingPageSize=20,stgrnPendingCurrentPage=1,stgrnPendingSearchQuery='',stgrnPendingTotalCount=0,stgrnPendingPageItems=[];
let stgrnDonePageSize=20,stgrnDoneCurrentPage=1,stgrnDoneSearchQuery='',stgrnDoneTotalCount=0,stgrnDonePageItems=[];
let selectedStGRN=new Set();

async function viewStGRNDetail(grnId){
  const res=await api('/api/ho/store-grns?q='+encodeURIComponent(grnId)+'&limit=500');
  const lines=((res&&res.data)||[]).filter(l=>l.GRNID===grnId);
  if($('stgrn-detail-title'))$('stgrn-detail-title').textContent='📦 '+grnId+' — Line Items';
  if($('stgrn-detail-lines'))$('stgrn-detail-lines').innerHTML=lines.map(l=>`<tr><td style="font-family:monospace;font-size:10px">${l.Barcode}</td><td>${l.Name}</td><td>${l.QtyIssued}</td><td>${l.QtyReceived}</td></tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:var(--gray3);padding:14px">No lines found</td></tr>';
  $('stgrn-detail-modal').style.display='flex';
}
function closeStGRNDetail(){$('stgrn-detail-modal').style.display='none';}
async function fetchAndRenderStGRNPending(){
  const offset=(stgrnPendingCurrentPage-1)*stgrnPendingPageSize;
  const qs=new URLSearchParams({status:'pending',limit:String(stgrnPendingPageSize),offset:String(offset)});
  if(stgrnPendingSearchQuery)qs.set('q',stgrnPendingSearchQuery);
  if($('stgrn-pending'))$('stgrn-pending').innerHTML='<tr><td colspan="9" style="text-align:center;color:var(--gray3);padding:13px">⏳ Loading…</td></tr>';
  try{
    const res=await api('/api/ho/store-grns-summary?'+qs.toString());
    stgrnPendingPageItems=(res&&res.data)?res.data:[];
    stgrnPendingTotalCount=(res&&typeof res.count==='number')?res.count:stgrnPendingPageItems.length;
  }catch(_e){stgrnPendingPageItems=[];stgrnPendingTotalCount=0;toast('❌ Failed to load pending GRNs','error');}
  renderStGRNPendingTable();
  renderStGRNPendingPagination();
}
function renderStGRNPendingTable(){
  if($('stgrn-pending'))$('stgrn-pending').innerHTML=stgrnPendingPageItems.map(g=>{
    const checked=selectedStGRN.has(g.grnId)?'checked':'';
    return `<tr><td><input type="checkbox" ${checked} onchange="toggleStGRNRow('${g.grnId}')"></td><td class="fw7">${g.grnId}</td><td>${g.date}</td><td>${g.storeName}</td><td>${g.items} item${g.items===1?'':'s'}</td><td>${g.qtyIssued}</td><td>${g.qtyReceived}</td><td><span class="badge badge-amber">Pending</span></td><td><button class="btn btn-ghost btn-sm" onclick="viewStGRNDetail('${g.grnId}')" title="View line items">👁️</button> <button class="btn btn-ghost btn-sm" onclick="deleteStoreGRN('${g.grnId}',this)" title="Delete — mistake ho jaye to yahan se undo karein">🗑</button></td></tr>`;
  }).join('')||'<tr><td colspan="9" style="text-align:center;color:var(--gray3);padding:13px">No pending</td></tr>';
  const selAll=$('stgrn-select-all');
  if(selAll)selAll.checked=stgrnPendingPageItems.length>0&&stgrnPendingPageItems.every(g=>selectedStGRN.has(g.grnId));
  const info=$('stgrn-selected-info');
  if(info)info.textContent=selectedStGRN.size?`✅ ${selectedStGRN.size} GRN(s) selected`:`${stgrnPendingTotalCount} pending GRN(s)`;
}
function renderStGRNPendingPagination(){
  const container=$('stgrn-pending-pagination');
  if(!container)return;
  const totalPages=Math.max(1,Math.ceil(stgrnPendingTotalCount/stgrnPendingPageSize));
  stgrnPendingCurrentPage=Math.max(1,Math.min(stgrnPendingCurrentPage,totalPages));
  let html='<div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">';
  if(stgrnPendingCurrentPage>1)html+=`<button class="btn btn-ghost btn-sm" onclick="stgrnPendingCurrentPage--;fetchAndRenderStGRNPending()">← Previous</button>`;
  html+=`<span style="font-size:11px;color:var(--gray4)">Page ${stgrnPendingCurrentPage} of ${totalPages} · ${stgrnPendingTotalCount} line(s)${stgrnPendingSearchQuery?` match "${stgrnPendingSearchQuery}"`:''}</span>`;
  if(stgrnPendingCurrentPage<totalPages)html+=`<button class="btn btn-ghost btn-sm" onclick="stgrnPendingCurrentPage++;fetchAndRenderStGRNPending()">Next →</button>`;
  html+='</div>';
  container.innerHTML=html;
}
let _stgrnPendingSearchDebounce=null;
function searchStGRNPending(query){
  clearTimeout(_stgrnPendingSearchDebounce);
  _stgrnPendingSearchDebounce=setTimeout(()=>{stgrnPendingSearchQuery=String(query||'').trim();stgrnPendingCurrentPage=1;fetchAndRenderStGRNPending();},180);
}
function toggleStGRNRow(grnId){if(selectedStGRN.has(grnId))selectedStGRN.delete(grnId);else selectedStGRN.add(grnId);renderStGRNPendingTable();}
function toggleAllStGRN(cb){
  const idsOnPage=[...new Set(stgrnPendingPageItems.map(g=>g.grnId))];
  if(cb.checked)idsOnPage.forEach(id=>selectedStGRN.add(id));
  else idsOnPage.forEach(id=>selectedStGRN.delete(id));
  renderStGRNPendingTable();
}
async function selectAllMatchingStGRN(){
  if(!stgrnPendingTotalCount){toast('Nothing to select','warn');return;}
  toast('⏳ Selecting all matching…','info');
  const qs=new URLSearchParams({status:'pending',limit:String(Math.max(stgrnPendingTotalCount,1))});
  if(stgrnPendingSearchQuery)qs.set('q',stgrnPendingSearchQuery);
  const res=await api('/api/ho/store-grns-summary?'+qs.toString());
  if(res&&res.data){res.data.forEach(g=>selectedStGRN.add(g.grnId));renderStGRNPendingTable();toast(`✅ ${selectedStGRN.size} GRN(s) selected`);}
  else toast('❌ Failed to select all — try again','error');
}
function clearStGRNSelection(){selectedStGRN=new Set();renderStGRNPendingTable();}
async function deleteSelectedStGRN(btn){
  if(!selectedStGRN.size){toast('No GRNs selected','error');return;}
  if(!confirm(`Delete ${selectedStGRN.size} selected GRN(s)? Stock reserved for each will be reversed. Only works for GRNs not yet received. Cannot be undone.`))return;
  const ids=Array.from(selectedStGRN);
  const total=ids.length;
  let ok=0,failed=0;
  const errorLog=[];
  const original=btn?btn.innerHTML:'';
  if(btn)btn.disabled=true;
  const startTime=Date.now();
  for(let i=0;i<ids.length;i++){
    const grnId=ids[i];
    if(btn){
      const secs=Math.round((Date.now()-startTime)/1000);
      const rate=(i>0)?(Date.now()-startTime)/i:0;
      const remaining=rate>0?Math.round(rate*(total-i)/1000):null;
      btn.innerHTML=`⏳ Deleting ${i+1}/${total}`+(remaining!=null?` — ~${remaining}s left`:'');
    }
    const res=await api('/api/ho/store-grn/'+encodeURIComponent(grnId),{method:'DELETE'});
    if(res&&res.ok)ok++;
    else{failed++;errorLog.push({grnId,reason:(res&&(res.detail||res.msg))||'failed'});}
  }
  if(btn){btn.disabled=false;btn.innerHTML=original;}
  selectedStGRN=new Set();
  toast(`✅ ${ok} deleted`+(failed?`, ${failed} failed — see downloaded log`:''),failed?'warn':'ok');
  if(errorLog.length)_csvDownload(errorLog,[['GRN ID','grnId'],['Reason','reason']],'grn_delete_errors_'+today()+'.csv');
  await loadAll();stgrnPendingCurrentPage=1;await fetchAndRenderStGRNPending();
}

async function fetchAndRenderStGRNDone(){
  const offset=(stgrnDoneCurrentPage-1)*stgrnDonePageSize;
  const qs=new URLSearchParams({status:'received',limit:String(stgrnDonePageSize),offset:String(offset)});
  if(stgrnDoneSearchQuery)qs.set('q',stgrnDoneSearchQuery);
  if($('stgrn-done'))$('stgrn-done').innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:13px">⏳ Loading…</td></tr>';
  try{
    const res=await api('/api/ho/store-grns-summary?'+qs.toString());
    stgrnDonePageItems=(res&&res.data)?res.data:[];
    stgrnDoneTotalCount=(res&&typeof res.count==='number')?res.count:stgrnDonePageItems.length;
  }catch(_e){stgrnDonePageItems=[];stgrnDoneTotalCount=0;}
  if($('stgrn-done'))$('stgrn-done').innerHTML=stgrnDonePageItems.map(g=>`<tr><td class="fw7">${g.grnId}</td><td>${g.date}</td><td>${g.storeName}</td><td>${g.items} item${g.items===1?'':'s'}</td><td>${g.qtyReceived}</td><td><span class="badge badge-green">Received</span></td><td><button class="btn btn-ghost btn-sm" onclick="viewStGRNDetail('${g.grnId}')" title="View line items">👁️</button></td></tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:13px">None</td></tr>';
  renderStGRNDonePagination();
}
function renderStGRNDonePagination(){
  const container=$('stgrn-done-pagination');
  if(!container)return;
  const totalPages=Math.max(1,Math.ceil(stgrnDoneTotalCount/stgrnDonePageSize));
  stgrnDoneCurrentPage=Math.max(1,Math.min(stgrnDoneCurrentPage,totalPages));
  let html='<div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">';
  if(stgrnDoneCurrentPage>1)html+=`<button class="btn btn-ghost btn-sm" onclick="stgrnDoneCurrentPage--;fetchAndRenderStGRNDone()">← Previous</button>`;
  html+=`<span style="font-size:11px;color:var(--gray4)">Page ${stgrnDoneCurrentPage} of ${totalPages} · ${stgrnDoneTotalCount} line(s)${stgrnDoneSearchQuery?` match "${stgrnDoneSearchQuery}"`:''}</span>`;
  if(stgrnDoneCurrentPage<totalPages)html+=`<button class="btn btn-ghost btn-sm" onclick="stgrnDoneCurrentPage++;fetchAndRenderStGRNDone()">Next →</button>`;
  html+='</div>';
  container.innerHTML=html;
}
let _stgrnDoneSearchDebounce=null;
function searchStGRNDone(query){
  clearTimeout(_stgrnDoneSearchDebounce);
  _stgrnDoneSearchDebounce=setTimeout(()=>{stgrnDoneSearchQuery=String(query||'').trim();stgrnDoneCurrentPage=1;fetchAndRenderStGRNDone();},180);
}
function renderStGRNTables(){
  // Back-compat shim for any leftover caller (e.g. after save/delete
  // actions elsewhere) — refreshes both paginated lists from page 1.
  stgrnPendingCurrentPage=1;stgrnDoneCurrentPage=1;
  fetchAndRenderStGRNPending();fetchAndRenderStGRNDone();
}
function downloadStGRNTemplate(){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['Barcode,Name,Qty\n8001000000001,ANTA Running Pro,10\n'],{type:'text/csv'}));a.download='store_grn_template.csv';a.click();}
async function uploadStGRN(file){if(!file)return;const rows=await readExcel(file);rows.forEach(r=>{const bc=String(r.Barcode||'').trim();const wh=DATA.warehouse.find(w=>String(w.Barcode)===bc);stgrnLines.push({barcode:bc,name:String(r.Name||wh?.Name||'').trim(),qty:+(r.Qty||1),hoStock:+(wh?.OnHand||0)});});renderStGRNLines();toast('✅ '+rows.length+' lines');}
function addTrLine(){trLines.push({barcode:'',name:'',qty:1,notes:''});renderTrLines();}
function renderTrLines(){if(!$('tr-lines'))return;$('tr-lines').innerHTML=trLines.map((l,i)=>`<tr><td><input class="form-input" style="width:120px;padding:4px 7px;font-size:11px" value="${l.barcode}" oninput="trBC(${i},this.value)"></td><td><input class="form-input" style="padding:4px 7px;font-size:11px" value="${l.name}"></td><td><input class="form-input" type="number" style="width:65px;padding:4px 7px" value="${l.qty}" oninput="trLines[${i}].qty=+this.value"></td><td><input class="form-input" style="padding:4px 7px;font-size:11px" value="${l.notes}" oninput="trLines[${i}].notes=this.value"></td><td><button class="btn btn-ghost btn-sm" onclick="trLines.splice(${i},1);renderTrLines()">✕</button></td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:13px">Add lines</td></tr>';}
let _trBCDebounce=null;
function trBC(i,bc){
  trLines[i].barcode=bc;
  clearTimeout(_trBCDebounce);
  if(bc.length<4)return;
  _trBCDebounce=setTimeout(async()=>{
    const res=await api('/api/products/lookup/'+encodeURIComponent(bc));
    if(res&&res.ok&&trLines[i]&&trLines[i].barcode===bc){
      trLines[i].name=res.name;renderTrLines();
    }
  },250);
}
async function doTransfer(){const from=$('tr-from').value,to=$('tr-to').value;if(from===to||!trLines.length){toast('Invalid transfer','error');return;}const stores=DATA.stores;const res=await api('/api/ho/transfer',{method:'POST',body:{date:today(),fromStoreId:from,fromStore:(stores.find(s=>s.StoreID===from)||{}).Name||from,toStoreId:to,toStore:(stores.find(s=>s.StoreID===to)||{}).Name||to,lines:trLines}});if(res&&res.ok){toast('✅ Transfer '+res.count);trLines=[];renderTrLines();await loadAll();}else toast('❌ Failed','error');}
function renderTrHist(){if($('tr-hist'))$('tr-hist').innerHTML=DATA.transfers.slice(0,20).map(t=>`<tr><td class="fw7">${t.RefID}</td><td>${t.Date}</td><td>${t.FromStore}</td><td>${t.ToStore}</td><td>${(t.Name||'').slice(0,25)}</td><td>${t.Qty}</td><td><span class="badge badge-green">${t.Status}</span></td></tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:13px">No transfers</td></tr>';}
let selectedProducts = new Set();
function toggleAllProducts(cb){
  // Selects/deselects every product matching the current search (all pages),
  // not just the page in view, so "select all" + the delete/count reflect
  // the full matching set the user is looking at.
  // Selects/deselects only the products on the CURRENT page. Since the
  // full catalog is no longer loaded client-side (that was the slow
  // part), "select all" now means "select all on this page" — for a
  // bigger bulk delete, narrow the search first, or select page by page.
  selectedProducts = cb.checked ? new Set([...selectedProducts,...prodPageItems.map(p=>p.Barcode)]) : new Set([...selectedProducts].filter(bc=>!prodPageItems.some(p=>p.Barcode===bc)));
  renderProductsTable();
}
function toggleProduct(bc){
  if(selectedProducts.has(bc)) selectedProducts.delete(bc); else selectedProducts.add(bc);
  renderProductsTable();
}
async function selectAllMatchingProducts(){
  // Selects every product matching the current search — across ALL
  // pages, not just what's currently on screen. Fetches barcodes only
  // once, on demand, rather than keeping the full catalog loaded at all
  // times (that was the slow part). Fine as an occasional deliberate
  // action; just not something we do automatically on every page load.
  if(!prodTotalCount){toast('No products to select','warn');return;}
  if(prodTotalCount>3000&&!confirm(`Select all ${prodTotalCount} matching product(s)? This fetches the full matching list once — may take a few seconds for very large catalogs.`))return;
  toast('⏳ Selecting all matching products…','info');
  const qs=new URLSearchParams({active_only:'false',limit:String(prodTotalCount)});
  if(prodSearchQuery)qs.set('q',prodSearchQuery);
  const rows=await api('/api/products?'+qs.toString());
  if(Array.isArray(rows)){
    rows.forEach(p=>selectedProducts.add(p.barcode));
    renderProductsTable();
    toast(`✅ ${selectedProducts.size} product(s) selected`);
  } else {
    toast('❌ Failed to select all — try again','error');
  }
}
function clearProductSelection(){
  selectedProducts=new Set();
  renderProductsTable();
}
async function deleteSelectedProducts(){
  if(!selectedProducts.size){toast('No products selected','error');return;}
  if(!confirm('Delete '+selectedProducts.size+' selected product(s)? This cannot be undone.'))return;
  const res=await api('/api/products/bulk-delete',{method:'POST',body:Array.from(selectedProducts)});
  if(res&&res.ok){toast('🗑️ Deleted '+res.deleted+' product(s)');selectedProducts=new Set();await fetchAndRenderProductsPage();}
  else toast('❌ Delete failed','error');
}
async function deleteProduct(bc){
  if(!confirm('Delete product '+bc+'? This cannot be undone.'))return;
  const res=await api('/api/products/'+encodeURIComponent(bc),{method:'DELETE'});
  if(res&&res.ok){toast('🗑️ Deleted');selectedProducts.delete(bc);await fetchAndRenderProductsPage();}
  else toast('❌ Delete failed','error');
}
let editingProductBarcode=null;
function editProduct(bc){
  const p=prodPageItems.find(x=>String(x.Barcode)===String(bc));
  if(!p){toast('Product not found — try refreshing the page','error');return;}
  editingProductBarcode=p.Barcode;
  showAddProd();
  const title=$('add-prod-title'); if(title)title.textContent='✏️ Edit Product';
  if($('p-bc'))$('p-bc').value=p.Barcode;
  if($('p-nm'))$('p-nm').value=p.Name||'';
  if($('p-br'))$('p-br').value=p.Brand||'ANTA';
  if($('p-cat')){const catSel=$('p-cat');if(p.Category&&!Array.from(catSel.options).some(o=>o.value===p.Category)){const opt=document.createElement('option');opt.textContent=p.Category;catSel.appendChild(opt);}catSel.value=p.Category||'';}
  if($('p-sz'))$('p-sz').value=p.Size||'';
  if($('p-color'))$('p-color').value=p.Color||'';
  if($('p-dept'))$('p-dept').value=p.Department||'';
  if($('p-season'))$('p-season').value=p.Season||'';
  if($('p-gender'))$('p-gender').value=p.Gender||'';
  if($('p-cost'))$('p-cost').value=p.Cost||0;
  if($('p-orig'))$('p-orig').value=p.OriginalPrice||0;
  if($('p-ret'))$('p-ret').value=p.Retail||0;
  if($('p-ro'))$('p-ro').value=p.Reorder||5;
}
async function fetchAndRenderProductsPage(){
  // The only function that hits the server for Product Master. Fetches
  // just prodPageSize rows (default 20) + a total count — never the full
  // catalog — so opening/paging/searching Product Master stays fast no
  // matter how many thousand products exist.
  const el=$('prod-table');
  if(el)el.innerHTML='<tr><td colspan="17" style="text-align:center;color:var(--gray3);padding:18px">⏳ Loading…</td></tr>';
  const offset=(prodCurrentPage-1)*prodPageSize;
  const qs=new URLSearchParams({active_only:'false',limit:String(prodPageSize),offset:String(offset)});
  if(prodSearchQuery)qs.set('q',prodSearchQuery);
  const countQs=new URLSearchParams({active_only:'false'});
  if(prodSearchQuery)countQs.set('q',prodSearchQuery);
  try{
    const [rows,countRes]=await Promise.all([
      api('/api/products?'+qs.toString()),
      api('/api/products/count?'+countQs.toString()),
    ]);
    prodPageItems=Array.isArray(rows)?rows.map(p=>({...p,Barcode:p.barcode,Name:p.name,Brand:p.brand,Category:p.category,Department:p.department||'',Season:p.season||'',Gender:p.gender||'',Color:p.color||'',Size:p.size,Cost:p.cost,Retail:p.retail,OriginalPrice:p.originalPrice||0,Reorder:p.reorder,Opening:p.opening,Active:p.active?'Y':'N'})):[];
    prodTotalCount=(countRes&&typeof countRes.count==='number')?countRes.count:prodPageItems.length;
    prodFilteredList=prodPageItems; // kept in sync for anything still reading the old name
  }catch(_e){
    prodPageItems=[];prodTotalCount=0;
    toast('❌ Failed to load products','error');
  }
  const totalPages=Math.max(1,Math.ceil(prodTotalCount/prodPageSize));
  prodCurrentPage=Math.max(1,Math.min(prodCurrentPage,totalPages));
  renderProductsTable();
  renderPaginationControls(totalPages);
}
function renderProductsTable(){
  // Redraws the table from the already-fetched page (prodPageItems) with
  // no server call — used for selection toggles etc. where nothing about
  // WHICH rows are shown has changed, only their checked state.
  if($('prod-table'))$('prod-table').innerHTML=prodPageItems.map(p=>{const m=p.Cost&&p.Retail?((p.Retail-p.Cost)/p.Retail*100).toFixed(1):'—';const checked=selectedProducts.has(p.Barcode)?'checked':'';return`<tr><td><input type="checkbox" ${checked} onchange="toggleProduct('${p.Barcode}')"></td><td style="font-family:monospace;font-size:10px">${p.Barcode}</td><td>${fmt(p.Cost||0)}</td><td>${fmt(p.OriginalPrice||0)}</td><td>${fmt(p.Retail||0)}</td><td class="fw7">${p.Name}</td><td>${p.Brand||'ANTA'}</td><td>${p.Category||''}</td><td>${p.Department||''}</td><td>${p.Season||''}</td><td>${p.Gender||''}</td><td>${p.Size||'—'}</td><td>${p.Color||''}</td><td>${m}%</td><td>${p.Reorder||5}</td><td><span class="badge badge-green">Active</span></td><td><button class="btn btn-ghost btn-sm" onclick="editProduct('${p.Barcode}')">✏️</button> <button class="btn btn-ghost btn-sm" onclick="deleteProduct('${p.Barcode}')">🗑️</button></td></tr>`;}).join('')||'<tr><td colspan="17" style="text-align:center;color:var(--gray3);padding:18px">No products found</td></tr>';
  const selAll=$('prod-select-all');
  if(selAll)selAll.checked=prodPageItems.length>0&&prodPageItems.every(p=>selectedProducts.has(p.Barcode));
  updateProdSelectedInfo();
}
function renderProducts(){
  // Back-compat shim: any leftover caller just gets a fresh server fetch.
  fetchAndRenderProductsPage();
}
function showAddProd(){
  editingProductBarcode=null;
  const title=$('add-prod-title'); if(title)title.textContent='➕ Add / Edit Product';
  ['p-bc','p-nm','p-sz','p-color','p-dept','p-season','p-cost','p-ret','p-orig'].forEach(id=>{if($(id))$(id).value='';});
  if($('p-br'))$('p-br').value='ANTA';
  if($('p-cat'))$('p-cat').selectedIndex=0;
  if($('p-gender'))$('p-gender').value='';
  if($('p-ro'))$('p-ro').value=5;
  if($('add-prod-form'))$('add-prod-form').style.display='flex';
  if($('p-bc'))$('p-bc').focus();
}
function closeAddProd(){
  if($('add-prod-form'))$('add-prod-form').style.display='none';
  editingProductBarcode=null;
}
async function saveProd(){
  const bc=$('p-bc').value.trim(),nm=$('p-nm').value.trim();
  if(!bc||!nm){toast('Required fields','error');return;}
  const body={
    barcode:bc,name:nm,brand:$('p-br').value,category:$('p-cat').value,size:$('p-sz').value,
    color:$('p-color')?.value||'',department:$('p-dept')?.value||'',season:$('p-season')?.value||'',gender:$('p-gender')?.value||'',
    cost:+$('p-cost').value||0,retail:+$('p-ret').value||0,reorder:+($('p-ro')?.value)||5,
    active:true,
  };
  const origVal=($('p-orig')&&$('p-orig').value||'').trim();
  if(origVal)body.originalPrice=+origVal;
  if(editingProductBarcode&&editingProductBarcode!==bc)body.old_barcode=editingProductBarcode;
  const res=await api('/api/products',{method:'POST',body});
  if(res&&res.barcode){
    toast('✅ Saved');editingProductBarcode=null;await loadAll();renderProducts();
    closeAddProd();
  } else toast('❌ '+((res&&res.msg)||'Failed'),'error');
}
async function downloadProdTemplate(){
  const categories=(DATA.categories&&DATA.categories.length)?DATA.categories:['Running','Casual','Basketball','Training','Kids','Slippers','Other'];
  const genders=['Men','Women','Kids','Unisex'];
  if(typeof ExcelJS==='undefined'){
    // Fallback: plain CSV (no dropdowns) if ExcelJS failed to load (e.g. offline)
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['Barcode,Name,Brand,Category,Department,Season,Gender,Size,Color,Cost,Original Price,Retail,Reorder\n8001000000009,ANTA Sample Shoe,ANTA,Running,Footwear,SS26,Men,42,White,120,180,180,5\n'],{type:'text/csv'}));a.download='products_template.csv';document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    return;
  }
  const wb=new ExcelJS.Workbook();
  const ws=wb.addWorksheet('Products');
  const headers=['Barcode','Name','Brand','Category','Department','Season','Gender','Size','Color','Cost','Original Price','Retail','Reorder'];
  ws.addRow(headers);
  ws.getRow(1).font={bold:true};
  ws.addRow(['8001000000009','ANTA Sample Shoe','ANTA','Running','Footwear','SS26','Men','42','White',120,180,180,5]);
  ws.columns.forEach(c=>c.width=15);
  const catCol='D',genderCol='G',lastRow=1000;
  for(let r=2;r<=lastRow;r++){
    ws.getCell(catCol+r).dataValidation={type:'list',allowBlank:true,formulae:[`"${categories.join(',')}"`]};
    ws.getCell(genderCol+r).dataValidation={type:'list',allowBlank:true,formulae:[`"${genders.join(',')}"`]};
  }
  const buf=await wb.xlsx.writeBuffer();
  const blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='products_template.xlsx';document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function normKey(k){return String(k||'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function pickField(rowNorm, aliases){for(const a of aliases){if(rowNorm[a]!==undefined&&rowNorm[a]!=='')return rowNorm[a];}return '';}
const FIELD_ALIASES={
  barcode:['barcode','bar code','sku','itemcode','item code','code','productcode'],
  name:['name','productname','itemname','description','title'],
  brand:['brand'],
  category:['category','cat'],
  department:['department','dept'],
  season:['season'],
  gender:['gender','sex'],
  size:['size'],
  color:['color','colour'],
  cost:['cost','unitcost','costprice','buyingprice'],
  originalprice:['originalprice','orginalprice','origprice','firstprice','msrp','launchprice'],
  retail:['retail','price','sellingprice','retailprice','currentprice','currentretailprice'],
  reorder:['reorder','reorderlevel','minstock','reorderqty'],
  qty:['qty','quantity','stock','openingqty','opening','onhand'],
};
const FIELD_KEYS={};Object.keys(FIELD_ALIASES).forEach(f=>{FIELD_KEYS[f]=FIELD_ALIASES[f].map(normKey);});
function cleanId(v){
  // Prevents big barcodes/SKUs from turning into things like "8.001e+12"
  // when the Excel cell was stored as a number instead of text.
  if(typeof v==='number')return Number.isFinite(v)?v.toFixed(0):'';
  return String(v==null?'':v).trim();
}
function csvEscape(v){v=String(v==null?'':v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;}
function downloadEventLog(logRows){
  if(!logRows||!logRows.length)return;
  const lines=['#,Barcode,Name,Status,Reason'];
  logRows.forEach((r,i)=>lines.push([i+1,csvEscape(r.barcode),csvEscape(r.name),csvEscape(r.status),csvEscape(r.reason||'')].join(',')));
  const ts=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/csv'}));a.download=`products_upload_log_${ts}.csv`;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function uploadChunkResilient(chunk,logRows,endpoint,rowKey){
  // Send the chunk. If the server processed it (even partially — see the
  // per-row `results` it returns), record every row's pass/fail and stop.
  // If the WHOLE request failed outright (timeout, network drop, 500),
  // don't give up on the data: split the chunk in half and retry each
  // half on its own, all the way down to single rows if necessary, so a
  // single bad row is the only thing that can ever be lost.
  const res=await api(endpoint,{method:'POST',body:rowKey?{[rowKey]:chunk}:chunk});
  if(res&&res.ok&&Array.isArray(res.results)){
    res.results.forEach(r=>logRows.push(r));
    return {created:res.created||0,updated:res.updated||0,failed:res.results.filter(r=>r.status==='failed').length};
  }
  if(res&&res.ok&&!Array.isArray(res.results)){
    // Endpoint succeeded but doesn't return per-row results (e.g. whole
    // chunk saved in one go) — count every row in this chunk as passed.
    chunk.forEach(r=>logRows.push({barcode:r.barcode||'?',name:r.name||'',status:'saved',reason:''}));
    return {created:res.count||chunk.length,updated:0,failed:0};
  }
  if(chunk.length<=1){
    const only=chunk[0]||{};
    logRows.push({barcode:only.barcode||'?',name:only.name||'',status:'failed',reason:(res&&(res.detail||res.msg))||'request failed — no response from server'});
    return {created:0,updated:0,failed:1};
  }
  const mid=Math.ceil(chunk.length/2);
  const r1=await uploadChunkResilient(chunk.slice(0,mid),logRows,endpoint,rowKey);
  const r2=await uploadChunkResilient(chunk.slice(mid),logRows,endpoint,rowKey);
  return {created:r1.created+r2.created,updated:r1.updated+r2.updated,failed:r1.failed+r2.failed};
}
function fmtSecs(s){
  s=Math.max(0,Math.round(s));
  if(s<60)return s+'s';
  const m=Math.floor(s/60),r=s%60;
  if(m<60)return m+'m '+r+'s';
  const h=Math.floor(m/60),rm=m%60;
  return h+'h '+rm+'m';
}
function bupShow(prefix){prefix=prefix||'bup';const el=$(prefix+'-panel')||$('bulk-upload-progress');if(el)el.style.display='block';}
function bupHide(prefix){prefix=prefix||'bup';const el=$(prefix+'-panel')||$('bulk-upload-progress');if(el)el.style.display='none';}
function bupUpdate(opts){
  const prefix=opts.prefix||'bup';
  const {status,done,total,startTime,failed}=opts;
  const statusEl=$(prefix+'-status');
  if(statusEl)statusEl.textContent=status+(failed?` — ⚠️ ${failed} failed`:'');
  if($(prefix+'-count'))$(prefix+'-count').textContent=`${done} / ${total}`;
  if($(prefix+'-bar'))$(prefix+'-bar').style.width=(total?Math.round(done/total*100):0)+'%';
  const elapsedSec=(Date.now()-startTime)/1000;
  if($(prefix+'-elapsed'))$(prefix+'-elapsed').textContent='Elapsed: '+fmtSecs(elapsedSec);
  if($(prefix+'-eta')){
    if(done>0&&done<total){
      const rate=done/elapsedSec; // rows/sec
      const remaining=(total-done)/rate;
      $(prefix+'-eta').textContent='Estimated remaining: '+fmtSecs(remaining);
    } else if(done>=total){
      $(prefix+'-eta').textContent='Done in '+fmtSecs(elapsedSec);
    } else {
      $(prefix+'-eta').textContent='Estimated remaining: calculating…';
    }
  }
}
async function uploadProducts(file){
  if(!file)return;
  const startTime=Date.now();
  bupShow();
  bupUpdate({status:'⏳ Reading file…',done:0,total:0,startTime});
  const rows=await readExcel(file);
  const logRows=[];
  let skipped=0;

  // Build rows first, keyed by barcode, so duplicate barcodes WITHIN the
  // same file collapse to a single row (the last occurrence wins). Only
  // barcode is used for duplicate detection — name/brand/etc never cause
  // a row to be skipped or flagged as a dup.
  const byBarcode=new Map();
  const order=[];
  rows.forEach(r=>{
    const rowNorm={};Object.keys(r).forEach(k=>{rowNorm[normKey(k)]=r[k];});
    const get=f=>pickField(rowNorm,FIELD_KEYS[f]);
    const barcode=cleanId(get('barcode'));
    const name=String(get('name')||'').trim();
    if(!barcode){
      skipped++;
      logRows.push({barcode:'(blank)',name:name||'(blank)',status:'failed',reason:'missing Barcode in file — row skipped before upload'});
      return;
    }
    if(!name){
      skipped++;
      logRows.push({barcode,name:'(blank)',status:'failed',reason:'missing Name in file — row skipped before upload'});
      return;
    }
    const item={barcode,name,brand:get('brand')||'ANTA',category:get('category')||'',department:get('department')||'',season:get('season')||'',gender:get('gender')||'',size:get('size')||'',color:get('color')||'',cost:+(get('cost')||0),retail:+(get('retail')||0),reorder:+(get('reorder')||5),active:true};
    const origPriceRaw=get('originalprice');
    if(origPriceRaw!==''&&origPriceRaw!==undefined)item.originalPrice=+origPriceRaw||0;
    if(byBarcode.has(barcode)){
      logRows.push({barcode,name:byBarcode.get(barcode).name,status:'skipped',reason:'duplicate barcode in file — overwritten by a later row with the same barcode'});
    } else {
      order.push(barcode);
    }
    byBarcode.set(barcode,item);
  });
  const items=order.map(bc=>byBarcode.get(bc));

  if(!items.length){
    bupHide();
    toast('❌ No valid rows found — check that the file has Barcode and Name columns (see Template)','error');
    downloadEventLog(logRows);
    return;
  }
  const dupCount=rows.length-skipped-items.length;
  const parts=[];
  if(skipped)parts.push(skipped+' row(s) skipped — missing Barcode/Name');
  if(dupCount>0)parts.push(dupCount+' duplicate barcode(s) collapsed');
  if(parts.length)toast('⚠️ '+parts.join('; '),'warn');

  // Upload in chunks so large files (thousands of rows) don't time out in
  // one request. Every chunk is retried/split on failure (see
  // uploadChunkResilient), and the progress panel stays visible with a
  // live count + elapsed/estimated time until the whole file is done.
  const CHUNK=200;
  let created=0,updated=0,failed=0;
  for(let i=0;i<items.length;i+=CHUNK){
    const chunk=items.slice(i,i+CHUNK);
    const doneSoFar=Math.min(i+CHUNK,items.length);
    bupUpdate({status:'⏳ Uploading products… keep this tab open',done:i,total:items.length,startTime,failed});
    const r=await uploadChunkResilient(chunk,logRows,'/api/products/bulk',null);
    created+=r.created;updated+=r.updated;failed+=r.failed;
    bupUpdate({status:'⏳ Uploading products… keep this tab open',done:doneSoFar,total:items.length,startTime,failed});
  }
  bupUpdate({status:'✅ Upload complete',done:items.length,total:items.length,startTime,failed});
  setTimeout(bupHide,4000);
  if(created||updated){
    toast('✅ Uploaded — '+created+' created, '+updated+' updated'+(failed?(', '+failed+' failed — see downloaded event log'):''), failed?'warn':'ok');
  } else {
    toast('❌ Upload failed — 0 products saved. Event log downloaded — check the Reason column.','error');
  }
  downloadEventLog(logRows);
  await loadAll();
  renderProducts();
}
function plPreset(){const p=($('pl-period')||{}).value||'month',d=today(),now=new Date();if(!$('pl-from'))return;if(p==='today'){$('pl-from').value=d;$('pl-to').value=d;}else if(p==='week'){const ws=new Date(now);ws.setDate(now.getDate()-now.getDay());$('pl-from').value=ws.toISOString().split('T')[0];$('pl-to').value=d;}else if(p==='month'){$('pl-from').value=d.slice(0,7)+'-01';$('pl-to').value=d;}else{$('pl-from').value=d.slice(0,4)+'-01-01';$('pl-to').value=d;}}
async function loadPL(){const qs=new URLSearchParams();if($('pl-from')?.value)qs.set('from',$('pl-from').value);if($('pl-to')?.value)qs.set('to',$('pl-to').value);if($('pl-store')?.value)qs.set('store',$('pl-store').value);const pl=await api('/api/ho/pl?'+qs);if(!pl||!pl.ok){toast('P&L failed','error');return;}window.__plData=pl;if($('pl-kpis'))$('pl-kpis').innerHTML=[['Revenue',fmt(pl.revenue),''],['COGS',fmt(pl.cogs),'amber'],['Gross Profit',fmt(pl.grossProfit),'green'],['GM%',((pl.grossMargin||0)*100).toFixed(1)+'%','blue'],['Expenses',fmt(pl.totalExpenses),'purple'],['EBITDA',fmt(pl.ebitda),'teal'],['Depreciation',fmt(pl.depreciationExpense||0),'amber'],['Net Profit',fmt(pl.netProfit),'green']].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');const rows=[['Net Revenue','netRevenue'],['COGS','cogs'],['Gross Profit','grossProfit'],['Gross Margin %','grossMargin',true],['Total Expenses','totalExpenses'],['EBITDA','ebitda'],['Depreciation Expense','depreciationExpense'],['Net Profit','netProfit']];if($('pl-table'))$('pl-table').innerHTML=rows.map(([label,key,pct])=>`<tr style="${key==='ebitda'||key==='grossProfit'||key==='netProfit'?'font-weight:800;background:var(--gray0)':''}"><td>${label}</td><td class="text-right fw7">${pct?((pl[key]||0)*100).toFixed(1)+'%':fmt(pl[key]||0)}</td><td class="text-right">${pct?'':pl.netRevenue?((pl[key]||0)/pl.netRevenue*100).toFixed(1)+'%':'—'}</td></tr>`).join('');}
async function loadExpenses(){const el=$('exp-ho-table')||$('exp-table');if(!el)return;const qs=new URLSearchParams();const sid=$('exp-store-filter')&&$('exp-store-filter').value;if(sid&&sid!=='all')qs.set('store_id',sid);const res=await api('/api/expenses?limit=300'+(qs.toString()?'&'+qs.toString():''));const rows=(res&&res.data)||DATA.expenses||[];DATA.expenses=rows.map(e=>({...e,Date:e.date||e.Date,Amount:e.amount!=null?e.amount:e.Amount,Store:e.store||e.Store,StoreID:e.storeId||e.StoreID,Category:e.category||e.Category,Description:e.description||e.Description||'',PayMethod:e.payMethod||e.PayMethod||''}));el.innerHTML=DATA.expenses.map(e=>`<tr><td>${e.Date||''}</td><td>${e.Store||''}</td><td>${e.Category||''}</td><td>${e.Description||''}</td><td class="fw7">${fmt(e.Amount||0)}</td><td>${e.PayMethod||''}</td><td data-role="admin,accountant"><button class="btn btn-ghost btn-sm" onclick="editExpense('${e.id}')">✏️</button> <button class="btn btn-ghost btn-sm" onclick="deleteExpense('${e.id}')">🗑️</button></td></tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3)">No expenses</td></tr>';applyRoleUI();}

function rptPreset(){const p=($('rpt-preset')||{}).value||'today',d=today(),now=new Date();if(!$('rpt-from'))return;if(p==='today'){$('rpt-from').value=d;$('rpt-to').value=d;}else if(p==='yesterday'){const y=new Date(now);y.setDate(y.getDate()-1);const yd=y.toISOString().split('T')[0];$('rpt-from').value=yd;$('rpt-to').value=yd;}else if(p==='week'){const ws=new Date(now);ws.setDate(now.getDate()-now.getDay());$('rpt-from').value=ws.toISOString().split('T')[0];$('rpt-to').value=d;}else{$('rpt-from').value=d.slice(0,7)+'-01';$('rpt-to').value=d;}}
async function uploadBackupSales(file){
  if(!file)return;
  const rowsRaw=await readExcel(file);
  const lines=rowsRaw.map(r=>({
    invoiceNo:String(r['Invoice No.']||r.invoiceNo||'').trim(),
    date:String(r.Date||r.date||'').slice(0,10),
    store:String(r.Store||r.store||'').trim(),
    cashier:String(r.Cashier||r.cashier||'').trim(),
    barcode:cleanId(r.Barcode||r.barcode||''),
    qty:+(r.Qty||r.qty||1),
    unitPrice:+(r['Unit Price']||r.unitPrice||0),
    paymentMethod:String(r['Payment Method']||r.paymentMethod||'Cash').trim(),
    amountReceived:+(r['Amount Received']||r.amountReceived||0),
  })).filter(l=>l.invoiceNo&&l.barcode&&l.date);
  if(!lines.length){toast('No valid rows found — check the file has Invoice No., Date, Barcode columns','error');return;}
  if(!confirm(`Import ${lines.length} line(s) as real sales? Stock will be reduced accordingly. Already-imported invoices are skipped automatically.`))return;
  const res=await api('/api/sales/bulk-import',{method:'POST',body:{lines}});
  if(res&&res.ok){
    let msg=`✅ Imported ${res.imported} invoice(s).`;
    if(res.skippedDuplicate)msg+=` ${res.skippedDuplicate} already imported (skipped).`;
    if(res.skippedUnknownBarcodes&&res.skippedUnknownBarcodes.length)msg+=` ⚠️ Unknown barcodes skipped: ${res.skippedUnknownBarcodes.join(', ')}`;
    if($('backup-sales-result'))$('backup-sales-result').innerHTML=msg;
    toast('✅ Import complete');
    await loadAll();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Import failed'),'error');
}
async function loadReports(){const qs=new URLSearchParams();if($('rpt-from')?.value)qs.set('from',$('rpt-from').value);if($('rpt-to')?.value)qs.set('to',$('rpt-to').value);if($('rpt-store')?.value&&$('rpt-store').value!=='all')qs.set('store',$('rpt-store').value);const res=await api('/api/reports?'+qs);if(!res||!res.ok){toast('Report failed','error');return;}window.__lastReport=res;if($('rpt-kpis'))$('rpt-kpis').innerHTML=[['Revenue',fmt(res.revenue),''],['Net',fmt(res.net),'blue'],['Invoices',res.invoices,'green'],['ATV',fmt(res.atv),'amber'],['Units',res.units,'purple'],['Cost',fmt(res.totalCost||0),''],['Profit',fmt(res.totalProfit||0),'green'],['Margin',(res.margin||0)+'%','teal'],['Returns',fmt(res.returns),'']].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');const pm=res.paymentBreakdown||{},rev=res.revenue||0;if($('rpt-pay'))$('rpt-pay').innerHTML=Object.entries(pm).map(([m,v])=>{const pct=rev?Math.round(v/rev*100):0;return`<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:11px"><span>${m}</span><span class="fw7">${fmt(v)} (${pct}%)</span></div><div style="background:var(--gray1);border-radius:4px;height:7px"><div style="background:var(--accent2);width:${pct}%;height:100%;border-radius:4px"></div></div></div>`;}).join('')||'<div style="color:var(--gray3);padding:14px;text-align:center">No data</div>';if($('rpt-prod'))$('rpt-prod').innerHTML=(res.productBreakdown||[]).map(p=>`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--gray1);font-size:11px"><span class="fw7">${p.name}</span><span>${p.qty} · ${fmt(p.revenue)}</span></div>`).join('')||'<div style="color:var(--gray3);padding:14px;text-align:center">No data</div>';if($('rpt-txns'))$('rpt-txns').innerHTML=(res.transactions||[]).slice(0,150).map(x=>`<tr><td class="fw7">${x.id}</td><td>${x.date||''}</td><td>${x.time||''}</td><td>${x.store||''}</td><td>${x.customer||''}</td><td style="text-align:center">${x.items||0}</td><td style="text-align:center">${x.units||0}</td><td style="font-size:10px;font-family:monospace;max-width:160px">${x.barcodeList||''}</td><td style="font-size:10px;max-width:220px">${x.productList||''}</td><td>${fmt(x.subtotal||0)}</td><td>${fmt(x.discount||0)}</td><td>${fmt(x.cost||0)}</td><td class="fw7" style="color:var(--green)">${fmt(x.profit||0)}</td><td>${x.margin||0}%</td><td>${x.payment||''}</td><td>${x.payRef||''}</td><td class="fw7">${fmt(x.total||0)}</td></tr>`).join('')||'<tr><td colspan="17" style="text-align:center;color:var(--gray3);padding:14px">None</td></tr>';}
function exportRpt(){const rows=(window.__lastReport&&window.__lastReport.transactions)||[];const esc=v=>{const s=String(v==null?'':v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};const header=['Invoice','Date','Time','Store','Customer','Items','Units','Barcode','Products','Subtotal','Discount','Cost','Profit','Margin%','Payment','Ref','Total'];const from=$('rpt-from')?.value||'',to=$('rpt-to')?.value||'';const csv=[header.join(',')].concat(rows.map(x=>[x.id,x.date,x.time,x.store,x.customer,x.items,x.units,x.barcodeList,x.productList,x.subtotal,x.discount,x.cost,x.profit,x.margin,x.payment,x.payRef,x.total].map(esc).join(','))).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const suffix=(from||to)?`_${from||'start'}_to_${to||'today'}`:'';a.download='anta_ho_sales_report'+suffix+'_'+today()+'.csv';a.click();}
async function runWithElapsedTimer(btn,label,fn){
  // Shows a live "⏳ Working… Ns" ticker right on the button that triggered
  // it — same idea as the upload progress bar, just for single-call admin
  // actions (recalculate/reset/delete-all) so a cold-start wait never
  // looks like the button did nothing.
  const original=btn?btn.innerHTML:'';
  let secs=0;
  const timer=setInterval(()=>{secs++;if(btn)btn.innerHTML=`⏳ ${label}… ${secs}s`;},1000);
  if(btn){btn.disabled=true;btn.innerHTML=`⏳ ${label}… 0s`;}
  try{
    return await fn();
  } finally {
    clearInterval(timer);
    if(btn){btn.disabled=false;btn.innerHTML=original;}
  }
}
async function resetAllProductStockData(btn){
  if(!confirm('☢️ FULL RESET — this permanently deletes ALL Products, HO Warehouse stock, Supplier GRN history, Send-to-Store GRN history, every store\'s Inventory, and Stock Transfers.\n\nUsers, PINs, Stores, Banks, Capital/Balance Sheet entries, Expenses, and past Sales/Returns/Exchanges are NOT affected.\n\nThis CANNOT be undone. Continue?'))return;
  const typed=prompt('To confirm, type RESET (all caps) below:');
  if(typed!=='RESET'){toast('Cancelled — text didn\'t match','warn');return;}
  const res=await runWithElapsedTimer(btn,'Resetting everything',()=>api('/api/ho/reset-all-product-stock-data',{method:'POST'}));
  if(res&&res.ok){
    const d=res.deleted||{};
    toast(`✅ Full reset done — ${d.products||0} products, ${d.ho_warehouse||0} warehouse rows, ${d.supplier_grn||0} supplier GRN lines, ${d.store_grn||0} store GRN lines, ${d.inventory||0} inventory rows cleared`);
    await loadAll();
    if(currentScreenName()==='inventory-ho')renderInvAll();
    if(currentScreenName()==='warehouse')renderWarehouse();
    if(currentScreenName()==='supplier-grn'){sgrnHistCurrentPage=1;await fetchAndRenderSGRNHist();}
    if(currentScreenName()==='products')await fetchAndRenderProductsPage();
  } else {
    toast('❌ '+((res&&(res.detail||res.msg))||'Reset failed'),'error');
  }
}
async function resetAllStores(btn){
  if(!confirm('Reset ALL stores\' stock to 0? This clears every store\'s inventory counters (grn/sold/returns/on-hand) in one go — Sales/Returns/Exchange records themselves are NOT deleted, only the stock summary. This cannot be undone. Continue?'))return;
  if(!confirm('Are you absolutely sure? This affects ALL stores at once.'))return;
  const res=await runWithElapsedTimer(btn,'Resetting',()=>api('/api/inventory/reset-all-stores',{method:'POST'}));
  if(res&&res.ok){toast(`✅ Reset done — ${res.deleted} row(s) cleared`);renderInvAll();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Reset failed'),'error');
}
async function deleteAllWarehouse(btn){
  if(!confirm('Delete ALL HO Warehouse stock rows? Products in Product Master are NOT deleted — only warehouse stock counters. This cannot be undone. Continue?'))return;
  const res=await runWithElapsedTimer(btn,'Deleting',()=>api('/api/ho/warehouse/all',{method:'DELETE'}));
  if(res&&res.ok){toast(`✅ Deleted ${res.deleted} row(s)`);await loadAll();renderWarehouse();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Delete failed'),'error');
}
async function deleteAllGrnLines(btn){
  if(!confirm('Delete ALL Supplier GRN lines? HO Warehouse supplier-in stock resets to 0 for every product (stock already sent to stores is untouched). This cannot be undone. Continue?'))return;
  const res=await runWithElapsedTimer(btn,'Deleting',()=>api('/api/ho/supplier-grn-lines/all',{method:'DELETE'}));
  if(res&&res.ok){toast(`✅ Deleted ${res.deleted} line(s)`);selectedGrnLines=new Set();await loadAll();sgrnHistCurrentPage=1;await fetchAndRenderSGRNHist();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Delete failed'),'error');
}
async function loadHOHandovers(){
  const storeSel=$('handover-store-filter');
  const storeId=storeSel&&storeSel.value&&storeSel.value!=='all'?storeSel.value:'';
  const qs=storeId?('&store_id='+encodeURIComponent(storeId)):'';
  const [pendingRes,receivedRes]=await Promise.all([
    api('/api/handover/list?status=pending'+qs),
    api('/api/handover/list?status=received'+qs),
  ]);
  const pendEl=$('handover-pending-list');
  const pending=(pendingRes&&pendingRes.data)||[];
  if(pendEl)pendEl.innerHTML=pending.length?pending.map(h=>`
    <div style="border:1.5px solid var(--amber);border-radius:10px;padding:13px;margin-bottom:10px;background:#fffbeb">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div><b style="color:var(--navy)">${h.handoverId}</b> · ${h.storeName} · ${h.date}</div>
        <span style="font-size:10px;color:var(--gray4)">Submitted by ${h.submittedBy} at ${h.submittedAt}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px;font-size:12px">
        <div>Invoices<br><b>${h.invoiceCount}</b></div>
        <div>Units<br><b>${h.unitsSold}</b></div>
        <div>Total Sales<br><b>${fmt(h.totalSales)}</b></div>
        <div>Expected Cash<br><b style="color:var(--green)">${fmt(h.cashSales)}</b></div>
      </div>
      ${(h.bankSales||[]).length?`<div style="font-size:11px;color:var(--gray4);margin-bottom:8px">Bank/Card: ${h.bankSales.map(b=>b.bank+' '+fmt(b.amount)).join(', ')}</div>`:''}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="form-input" type="number" step="0.01" placeholder="Counted cash amount" id="count-${h.handoverId}" style="width:180px">
        <input class="form-input" placeholder="Notes (optional)" id="note-${h.handoverId}" style="width:200px">
        <button class="btn btn-green btn-sm" onclick="receiveHandoverAction('${h.handoverId}')">✅ Receive</button>
      </div>
    </div>`).join(''):'<div style="text-align:center;padding:18px;color:var(--gray3);font-size:12px">No pending handovers 🎉</div>';

  const received=(receivedRes&&receivedRes.data)||[];
  if($('handover-received-table'))$('handover-received-table').innerHTML=received.map(h=>{
    const v=h.variance||0;
    const color=Math.abs(v)<0.01?'var(--green)':(v<0?'var(--red)':'var(--amber)');
    return `<tr><td class="fw7">${h.handoverId}</td><td>${h.date}</td><td>${h.storeName}</td><td>${fmt(h.cashSales)}</td><td>${fmt(h.countedCash)}</td><td style="color:${color};font-weight:700">${v>=0?'+':''}${fmt(v)}</td><td>${h.receivedBy}</td></tr>`;
  }).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:13px">None yet</td></tr>';
}
async function receiveHandoverAction(handoverId){
  const countedCash=parseFloat(($('count-'+handoverId)&&$('count-'+handoverId).value)||'');
  if(isNaN(countedCash)){toast('Enter the counted cash amount','error');return;}
  const notes=($('note-'+handoverId)&&$('note-'+handoverId).value)||'';
  if(!confirm(`Confirm receiving ${handoverId} with counted cash ${countedCash}?`))return;
  const res=await api('/api/handover/receive',{method:'POST',body:{handoverId,countedCash,notes}});
  if(res&&res.ok){toast('✅ Handover received');loadHOHandovers();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function recalculateStoreInventory(btn){
  const storeId=$('recalc-store')&&$('recalc-store').value;
  if(!storeId){toast('Select a store','error');return;}
  const storeName=(DATA.stores.find(s=>s.StoreID===storeId)||{}).Name||storeId;
  if(!confirm(`Recalculate stock for ${storeName}? This rebuilds it strictly from actually-received GRN history — sales/returns/exchanges are untouched. Safe, but do this once you're sure the store's GRN history is correct.`))return;
  const res=await runWithElapsedTimer(btn,'Recalculating',()=>api('/api/inventory/recalculate?store_id='+encodeURIComponent(storeId),{method:'POST'}));
  if(res&&res.ok){toast(`✅ Fixed — ${res.updated} product(s) corrected for ${storeName}`);renderInvAll();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Recalculate failed'),'error');
}
let invAllPageSize=20,invAllCurrentPage=1,invAllSearchQuery='',invAllTotalCount=0,invAllStores=[];
async function fetchAndRenderInvAll(){
  const offset=(invAllCurrentPage-1)*invAllPageSize;
  const qs=new URLSearchParams({limit:String(invAllPageSize),offset:String(offset)});
  if(invAllSearchQuery)qs.set('q',invAllSearchQuery);
  const countQs=new URLSearchParams();if(invAllSearchQuery)countQs.set('q',invAllSearchQuery);
  const el=$('inv-all-table');
  if(el)el.innerHTML='<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:14px">⏳ Loading…</td></tr>';
  try{
    const [res,countRes]=await Promise.all([
      api('/api/ho/inventory-all?'+qs.toString()),
      api('/api/ho/inventory-all/count?'+countQs.toString()),
    ]);
    if(el&&res&&res.data){
      invAllStores=res.stores||[];
      el.innerHTML=res.data.map(r=>`<tr><td style="font-family:monospace;font-size:10px">${r.barcode}</td><td class="fw7">${r.name}</td><td>${r.ho}</td>${invAllStores.map(s=>`<td style="text-align:center">${(r.stores&&r.stores[s.store_id])||0}</td>`).join('')}<td class="fw7">${r.total}</td></tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:14px">No products found</td></tr>';
    } else if(el){
      el.innerHTML='<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:14px">No data</td></tr>';
    }
    invAllTotalCount=(countRes&&typeof countRes.count==='number')?countRes.count:0;
  }catch(_e){
    if(el)el.innerHTML='<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:14px">Failed to load</td></tr>';
    invAllTotalCount=0;
  }
  renderInvAllPagination();
}
function searchInvAll(query){
  clearTimeout(window._invAllSearchDebounce);
  window._invAllSearchDebounce=setTimeout(()=>{invAllSearchQuery=String(query||'').trim();invAllCurrentPage=1;fetchAndRenderInvAll();},180);
}
function renderInvAllPagination(){
  const container=$('inv-all-pagination');
  if(!container)return;
  const totalPages=Math.max(1,Math.ceil(invAllTotalCount/invAllPageSize));
  invAllCurrentPage=Math.max(1,Math.min(invAllCurrentPage,totalPages));
  let html='<div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">';
  if(invAllCurrentPage>1)html+=`<button class="btn btn-ghost btn-sm" onclick="invAllCurrentPage--;fetchAndRenderInvAll()">← Previous</button>`;
  html+=`<span style="font-size:11px;color:var(--gray4)">Page ${invAllCurrentPage} of ${totalPages} · ${invAllTotalCount} product(s)${invAllSearchQuery?` match "${invAllSearchQuery}"`:''}</span>`;
  if(invAllCurrentPage<totalPages)html+=`<button class="btn btn-ghost btn-sm" onclick="invAllCurrentPage++;fetchAndRenderInvAll()">Next →</button>`;
  html+='</div>';
  container.innerHTML=html;
}
function renderInvAll(){fetchAndRenderInvAll();}
async function exportInvAll(){
  toast('⏳ Preparing export…','info');
  const qs=new URLSearchParams({limit:String(Math.max(invAllTotalCount,1))});
  if(invAllSearchQuery)qs.set('q',invAllSearchQuery);
  const res=await api('/api/ho/inventory-all?'+qs.toString());
  if(!res||!res.data){toast('❌ Export failed','error');return;}
  const stores=res.stores||invAllStores||[];
  const rows=res.data.map(r=>{
    const o={barcode:r.barcode,name:r.name,ho:r.ho,total:r.total};
    stores.forEach(s=>{o[s.store_id]=(r.stores&&r.stores[s.store_id])||0;});
    return o;
  });
  const header=[['Barcode','barcode'],['Name','name'],['HO Stock','ho'],...stores.map(s=>[s.name||s.store_id,s.store_id]),['Total Stock','total']];
  _csvDownload(rows,header,'inventory_all_stores_'+today()+'.csv');
}
function renderStoresAdmin(){const el=$('stores-table')||$('stores-admin-table')||$('sa-table');if(!el)return;const rows=DATA.stores||[];el.innerHTML=rows.map(s=>`<tr><td class="fw7">${s.StoreID||s.store_id||''}</td><td>${s.Name||s.name||''}</td><td>${s.City||s.city||''}</td><td>${s.Manager||s.manager||''}</td><td>${s.Phone||s.phone||''}</td><td><span class="badge badge-green">${(s.Active==='N'||s.active===false)?'Inactive':'Active'}</span></td><td><button class="btn btn-ghost btn-sm" onclick="editStore('${s.StoreID||s.store_id||''}')">Edit</button></td></tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:14px">No stores yet</td></tr>';}
function showAddStore(){const f=$('store-form')||$('add-store-form');if(f)f.style.display='flex';['st-id','st-nm','st-city','st-addr','st-mgr','st-ph'].forEach(id=>{const el=$(id);if(el){el.value='';if(id==='st-id')el.disabled=false;}});} 
function editStore(id){const s=(DATA.stores||[]).find(x=>(x.StoreID||x.store_id)===id);const f=$('store-form')||$('add-store-form');if(!s||!f)return;f.style.display='flex';if($('st-id')){$('st-id').value=s.StoreID||s.store_id||'';$('st-id').disabled=true;}if($('st-nm'))$('st-nm').value=s.Name||s.name||'';if($('st-city'))$('st-city').value=s.City||s.city||'';if($('st-addr'))$('st-addr').value=s.Address||s.address||'';if($('st-mgr'))$('st-mgr').value=s.Manager||s.manager||'';if($('st-ph'))$('st-ph').value=s.Phone||s.phone||'';}
function closeStoreForm(){const f=$('store-form')||$('add-store-form');if(f)f.style.display='none';if($('st-id'))$('st-id').disabled=false;}
async function saveStore(){const idEl=$('st-id'),nmEl=$('st-nm');const body={store_id:(idEl&&idEl.value||'').trim(),name:(nmEl&&nmEl.value||'').trim(),city:($('st-city')&&$('st-city').value)||'',address:($('st-addr')&&$('st-addr').value)||'',manager:($('st-mgr')&&$('st-mgr').value)||'',phone:($('st-ph')&&$('st-ph').value)||'',active:true};if(!body.store_id||!body.name){toast('Store ID + Name required','error');return;}const res=await api('/api/stores',{method:'POST',body});if(res&&(res.store_id||res.ok!==false)&&!res.detail){toast('✅ Store saved');closeStoreForm();await loadAll();renderStoresAdmin();renderDash&&renderDash();}else{const msg=(res&&(res.detail||res.msg))||'Failed';toast(typeof msg==='string'?msg:'Failed','error');}}
function switchUserTab(tab){
  const empBtn=$('ut-tab-emp'),loginBtn=$('ut-tab-login');
  if(empBtn)empBtn.style.borderBottomColor=tab==='emp'?'var(--navy)':'transparent';
  if(loginBtn)loginBtn.style.borderBottomColor=tab==='login'?'var(--navy)':'transparent';
  if($('ut-panel-emp'))$('ut-panel-emp').style.display=tab==='emp'?'block':'none';
  if($('ut-panel-login'))$('ut-panel-login').style.display=tab==='login'?'block':'none';
}
function renderUsers(){
  const empEl=$('users-table-emp');
  if(empEl)empEl.innerHTML=DATA.users.map(u=>`<tr><td class="fw7">${u.Name}</td><td>${u.StoreName||u.StoreID}</td><td><span class="badge badge-blue">${u.Role}</span></td><td>${u.StandardSalary>0?fmt(u.StandardSalary):'—'}</td><td><span class="badge ${u.Active==='N'?'badge-red':'badge-green'}">${u.Active==='N'?'Inactive':'Active'}</span></td><td><button class="btn btn-ghost btn-sm" onclick="editUser('${u.UserID}')">✏️ Edit</button></td></tr>`).join('');
  const loginEl=$('users-table-login');
  if(loginEl)loginEl.innerHTML=DATA.users.map(u=>`<tr><td class="fw7">${u.Name}</td><td>${u.StoreName||u.StoreID}</td><td>${u.UserID}</td><td style="font-family:monospace;color:var(--accent2)">${u.EmployeeCode||'—'}</td><td><span class="badge ${u.PosLoginEnabled?'badge-green':'badge-gray'}">${u.PosLoginEnabled?'Enabled':'Off — payroll only'}</span></td><td><button class="btn btn-ghost btn-sm" onclick="editUser('${u.UserID}')">✏️</button> <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="toggleUserActive('${u.UserID}')">${u.Active==='N'?'✅ Activate':'🚫 Deactivate'}</button> <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteUserRow('${u.UserID}')">🗑️ Delete</button></td></tr>`).join('');
}
async function deleteUserRow(userId){
  const u=DATA.users.find(x=>x.UserID===userId);
  if(!u)return;
  if(!confirm(`Delete ${u.Name} permanently? This cannot be undone — their PIN will stop working immediately. (Their Employee Advances/Payroll history stays intact.)`))return;
  const res=await api('/api/auth/users/'+encodeURIComponent(userId),{method:'DELETE'});
  if(res&&res.ok){toast('🗑️ Deleted');await loadAll();renderUsers();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
let editingUserId=null;
function showAddUser(){editingUserId=null;if($('user-form')){$('user-form').style.display='flex';['u-nm','u-pin','u-empcode','u-salary','u-commission'].forEach(id=>{if($(id))$(id).value='';});if($('u-role'))$('u-role').value='cashier';if($('u-pin'))$('u-pin').placeholder='4-digit PIN';if($('u-empcode'))$('u-empcode').placeholder='e.g. EMP1234 (leave blank to auto-generate)';if($('u-login-enabled'))$('u-login-enabled').checked=true;toggleUserPinField();const t=document.querySelector('#user-form .modal-title');if(t)t.textContent='➕ Add User';}}
function toggleUserPinField(){
  const enabled=$('u-login-enabled')?$('u-login-enabled').checked:true;
  if($('u-pin-group'))$('u-pin-group').style.display=enabled?'block':'none';
}
function onRoleChange(){
  const role=$('u-role')?$('u-role').value:'';
  if(role==='cleaner'&&$('u-login-enabled')&&$('u-login-enabled').checked&&!editingUserId){
    $('u-login-enabled').checked=false;
    toggleUserPinField();
    toast('ℹ️ POS/HO Login turned off by default for Cleaner — this role usually doesn\'t need system access. Check the box above if this one does.','info');
  }
}
function editUser(userId){
  const u=DATA.users.find(x=>x.UserID===userId);
  if(!u){toast('User not found','error');return;}
  editingUserId=userId;
  if($('user-form'))$('user-form').style.display='flex';
  if($('u-nm'))$('u-nm').value=u.Name||'';
  if($('u-role'))$('u-role').value=u.Role||'cashier';
  if($('u-store'))$('u-store').value=u.StoreID||'';
  if($('u-pin')){$('u-pin').value='';$('u-pin').placeholder='Leave blank to keep current PIN';}
  if($('u-empcode'))$('u-empcode').value=u.EmployeeCode||'';
  if($('u-salary'))$('u-salary').value=u.StandardSalary||0;
  if($('u-commission'))$('u-commission').value=u.CommissionRate||0;
  if($('u-login-enabled'))$('u-login-enabled').checked=u.PosLoginEnabled!==false;
  toggleUserPinField();
  const t=document.querySelector('#user-form .modal-title');if(t)t.textContent='✏️ Edit User — '+u.Name;
}
async function toggleUserActive(userId){
  const u=DATA.users.find(x=>x.UserID===userId);
  if(!u)return;
  const newActive=u.Active==='N';
  if(!confirm(`${newActive?'Activate':'Deactivate'} ${u.Name}?`))return;
  const res=await api('/api/auth/users',{method:'POST',body:{user_id:userId,store_id:u.StoreID,store_name:u.StoreName,name:u.Name,role:u.Role,active:newActive,posLoginEnabled:u.PosLoginEnabled}});
  if(res&&res.user_id){toast('✅ Updated');await loadAll();renderUsers();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function closeUserForm(){if($('user-form'))$('user-form').style.display='none';editingUserId=null;}
async function saveUser(){
  const btn=$('save-user-btn');
  if(btn&&btn.disabled)return; // already saving — ignore extra clicks
  if(btn){btn.disabled=true;btn.textContent='⏳ Saving…';}
  const storeId=$('u-store').value;
  const loginEnabled=$('u-login-enabled')?$('u-login-enabled').checked:true;
  const body={
    store_id:storeId,
    store_name:storeId==='HO'?'Head Office':((DATA.stores.find(s=>s.StoreID===storeId)||{}).Name||''),
    name:$('u-nm').value.trim(),
    role:$('u-role').value,
    active:true,
    posLoginEnabled:loginEnabled,
    employeeCode:($('u-empcode')&&$('u-empcode').value.trim())||undefined,
    standardSalary:+(($('u-salary')&&$('u-salary').value)||0),
    commissionRate:+(($('u-commission')&&$('u-commission').value)||0),
  };
  if(editingUserId)body.user_id=editingUserId;
  const pin=$('u-pin').value.trim();
  if(pin)body.pin=pin;
  if(!body.name){toast('Name required','error');if(btn){btn.disabled=false;btn.textContent='💾 Save User';}return;}
  if(!editingUserId&&loginEnabled&&!pin){toast('PIN required when POS/HO Login is enabled','error');if(btn){btn.disabled=false;btn.textContent='💾 Save User';}return;}
  const res=await api('/api/auth/users',{method:'POST',body});
  if(btn){btn.disabled=false;btn.textContent='💾 Save User';}
  if(res&&res.user_id){toast(editingUserId?'✅ User updated':'✅ User saved');closeUserForm();await loadAll();renderUsers();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function renderBanks(){const el=$('banks-table')||$('b-table');if(el)el.innerHTML=DATA.banks.map(b=>`<tr><td class="fw7">${b.BankID}</td><td>${b.Name}</td><td>${b.Device||'—'}</td><td><span class="badge badge-green">Active</span></td></tr>`).join('');}
function showAddBank(){if($('bank-form')){$('bank-form').style.display='flex';['b-nm','b-acc','b-dev'].forEach(id=>{if($(id))$(id).value='';});if($('b-act'))$('b-act').value='Y';}}function editBank(){}
function closeBankForm(){if($('bank-form'))$('bank-form').style.display='none';}
async function saveBank(){const body={name:$('b-nm').value.trim(),account_no:$('b-acc')?.value||'',device:$('b-dev')?.value||'',active:($('b-act')?.value||'Y')==='Y'};if(!body.name){toast('Name required','error');return;}const res=await api('/api/banks',{method:'POST',body});if(res&&res.bank_id){toast('✅ Bank saved');closeBankForm();await loadAll();renderBanks();}else toast('❌ '+((res&&res.msg)||'Failed'),'error');}
async function loadBalanceSheet(){const res=await api('/api/ho/balance-sheet');if(!res||!res.ok){toast('BS failed','error');return;}window.__bsData=res;const row=i=>`<tr><td>${i.label}${i.auto?' <span style="font-size:9px;color:var(--accent2)">auto</span>':` <button class="btn btn-ghost btn-sm" style="padding:1px 5px;font-size:10px" onclick="deleteBSEntry('${i.id}')" title="Delete">🗑️</button>`}</td><td class="text-right fw7">${fmt(i.value)}</td></tr>`;const set=(id,h)=>{if($(id))$(id).innerHTML=h;};const setT=(id,v)=>{if($(id))$(id).textContent=v;};set('bs-current-assets',(res.currentAssets||[]).map(row).join(''));set('bs-fixed-assets',(res.fixedAssets||[]).length?(res.fixedAssets||[]).map(row).join(''):'<tr><td style="color:var(--gray3);font-size:11px">No fixed assets</td><td></td></tr>');set('bs-liabilities',(res.liabilities||[]).map(row).join(''));set('bs-equity',(res.equity||[]).map(row).join(''));setT('bs-total-assets',fmt(res.totalAssets||0));setT('bs-total-liab',fmt(res.totalLiabilities||0));setT('bs-total-equity',fmt(res.totalEquity||0));setT('bs-total-le',fmt(res.totalLiabEquity||0));}

async function deleteBSEntry(id){
  if(!id){return;}
  if(!confirm('Delete this Balance Sheet entry? This cannot be undone.'))return;
  const res=await api(`/api/ho/bs-entries/${encodeURIComponent(id)}`,{method:'DELETE'});
  if(res&&res.ok){toast('✅ Deleted');await loadBalanceSheet();}
  else toast('❌ Failed','error');
}
async function saveBSEntry(){const type=$('bse-type').value,desc=$('bse-desc').value.trim(),amt=parseFloat($('bse-amt').value)||0,date=$('bse-date')?.value||today();if(!desc||!amt){toast('Fill fields','error');return;}const res=await api('/api/ho/bs-entries',{method:'POST',body:{type,description:desc,amount:amt,date}});if(res&&res.ok){toast('✅ Saved');['bse-desc','bse-amt'].forEach(id=>{if($(id))$(id).value='';});loadBalanceSheet();}else toast('❌ Failed','error');}
function _csvDownload(rows,header,filename){
  const esc=v=>{const s=String(v==null?'':v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  const csv=[header.map(h=>h[0]).join(',')].concat(rows.map(r=>header.map(h=>esc(r[h[1]])).join(','))).join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=filename;a.click();
}
function exportSGRN(){
  _csvDownload(DATA.supplierGRNs||[],[['GRN ID','GRNID'],['Date','Date'],['Supplier','Supplier'],['Invoice','InvoiceNo'],['Barcode','Barcode'],['Product','Name'],['Qty','Qty'],['Cost','UnitCost']],'supplier_grn_'+today()+'.csv');
}
function exportStGRN(){
  _csvDownload(DATA.storeGRNs||[],[['GRN ID','GRNID'],['Date','Date'],['Store','StoreName'],['Barcode','Barcode'],['Product','Name'],['Issued','QtyIssued'],['Received','QtyReceived'],['Status','Status']],'send_to_store_grn_'+today()+'.csv');
}
async function exportProducts(){
  toast('⏳ Preparing export — fetching full product catalog…','info');
  const all=await api('/api/products?active_only=false');
  if(!Array.isArray(all)){toast('❌ Export failed','error');return;}
  _csvDownload(all,[['Barcode','barcode'],['Name','name'],['Brand','brand'],['Category','category'],['Department','department'],['Season','season'],['Gender','gender'],['Size','size'],['Color','color'],['Cost','cost'],['Original Price','originalPrice'],['Retail','retail'],['Reorder','reorder']],'products_'+today()+'.csv');
}
function saveBSEntries(){}
function exportBS(){
  const bs=window.__bsData;
  if(!bs){toast('Load the Balance Sheet first','error');return;}
  const rows=[
    ...(bs.currentAssets||[]).map(i=>({section:'Current Assets',...i})),
    ...(bs.fixedAssets||[]).map(i=>({section:'Fixed Assets',...i})),
    ...(bs.liabilities||[]).map(i=>({section:'Liabilities',...i})),
    ...(bs.equity||[]).map(i=>({section:'Equity',...i})),
  ];
  _csvDownload(rows,[['Section','section'],['Item','label'],['Amount','value']],'balance_sheet_'+today()+'.csv');
}
function cfPreset(){const p=($('cf-period')||{}).value||'month',d=today();if(!$('cf-from'))return;if(p==='year'){$('cf-from').value=d.slice(0,4)+'-01-01';$('cf-to').value=d;}else{$('cf-from').value=d.slice(0,7)+'-01';$('cf-to').value=d;}}
async function loadCashFlow(){const qs=new URLSearchParams();if($('cf-from')?.value)qs.set('from',$('cf-from').value);if($('cf-to')?.value)qs.set('to',$('cf-to').value);qs.set('opening',String(parseFloat($('cf-opening-input')?.value)||0));const res=await api('/api/ho/cashflow?'+qs);if(!res||!res.ok){toast('CF failed','error');return;}window.__cfData=res;const row=i=>`<tr><td>${i.label}</td><td class="text-right fw7" style="color:${i.value>=0?'var(--green)':'var(--red)'}">${fmt(i.value)}</td></tr>`;const rowDel=i=>`<tr><td>${i.label} <button class="btn btn-ghost btn-sm" style="padding:1px 5px;font-size:10px" onclick="deleteCFEntry('${i.id}')" title="Delete">🗑️</button></td><td class="text-right fw7" style="color:${i.value>=0?'var(--green)':'var(--red)'}">${fmt(i.value)}</td></tr>`;const set=(id,h)=>{if($(id))$(id).innerHTML=h;};const setT=(id,v,c)=>{if($(id)){$(id).textContent=v;if(c)$(id).style.color=c;}};set('cf-operating',(res.operating||[]).map(row).join(''));setT('cf-op-total',fmt(res.operatingTotal||0),(res.operatingTotal||0)>=0?'var(--green)':'var(--red)');set('cf-investing',(res.investing||[]).length?(res.investing||[]).map(rowDel).join(''):'<tr><td style="color:var(--gray3);font-size:11px">No entries</td><td></td></tr>');setT('cf-inv-total',fmt(res.investingTotal||0));set('cf-financing',(res.financing||[]).length?(res.financing||[]).map(rowDel).join(''):'<tr><td style="color:var(--gray3);font-size:11px">No entries</td><td></td></tr>');setT('cf-fin-total',fmt(res.financingTotal||0));setT('cf-opening',fmt(res.opening||0));setT('cf-net',fmt(res.netCashFlow||0),(res.netCashFlow||0)>=0?'#4caf50':'#f44336');setT('cf-closing',fmt(res.closing||0));if($('cf-status'))$('cf-status').textContent=(res.closing||0)>=0?'✅ Positive':'⚠️ Negative';}

async function deleteCFEntry(id){
  if(!id){return;}
  if(!confirm('Delete this Cash Flow entry? If it was auto-created from a Capital or Fixed Asset entry, that source entry will lose its cash-flow link (edit it again to recreate it). This cannot be undone.'))return;
  const res=await api(`/api/ho/cf-items/${encodeURIComponent(id)}`,{method:'DELETE'});
  if(res&&res.ok){toast('✅ Deleted');await loadCashFlow();}
  else toast('❌ Failed','error');
}
async function addCFItem(type){const d=$(type==='investing'?'cf-inv-desc':'cf-fin-desc'),a=$(type==='investing'?'cf-inv-amt':'cf-fin-amt');if(!d||!a||!d.value)return;const res=await api('/api/ho/cf-items',{method:'POST',body:{section:type,label:d.value,value:parseFloat(a.value)||0}});if(res&&res.ok){d.value='';a.value='';loadCashFlow();toast('✅ Added');}}
function calcCF(){loadCashFlow();}
function saveCFItems(){}
function exportCF(){
  const cf=window.__cfData;
  if(!cf){toast('Load the Cash Flow statement first','error');return;}
  const rows=[
    ...(cf.operating||[]).map(i=>({section:'Operating',...i})),
    ...(cf.investing||[]).map(i=>({section:'Investing',...i})),
    ...(cf.financing||[]).map(i=>({section:'Financing',...i})),
  ];
  _csvDownload(rows,[['Section','section'],['Item','label'],['Amount','value']],'cash_flow_'+today()+'.csv');
}

// ---------- Printable reports (P&L / Balance Sheet / Cash Flow) ----------
function _reportHeader(title,subtitle){
  const company=(DATA.settings&&DATA.settings.company)||'ANTA Shoes';
  return `
    <div style="text-align:center;margin-bottom:26px;border-bottom:2px solid #1a2540;padding-bottom:16px">
      <div style="font-size:24px;font-weight:900;color:#1a2540">${company}</div>
      <div style="font-size:16px;font-weight:700;margin-top:4px">${title}</div>
      <div style="font-size:12px;color:#666;margin-top:3px">${subtitle}</div>
    </div>`;
}
function _reportFooter(){
  const now=new Date();
  return `<div style="text-align:center;margin-top:36px;font-size:10px;color:#999;border-top:1px solid #ddd;padding-top:10px">Generated ${now.toLocaleDateString()} ${now.toLocaleTimeString()} · ANTA Shoes System</div>`;
}
function _reportSectionTable(sectionTitle,rows,opts={}){
  if(!rows||!rows.length)return '';
  const rowsHtml=rows.map(r=>`<tr style="${r.bold?'font-weight:800;background:#f3f4f6':''}"><td style="width:70%;padding:7px 4px;border-bottom:1px solid #eee">${r.label}</td><td style="width:30%;padding:7px 4px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap">${r.value}</td></tr>`).join('');
  return `
    <div style="margin-bottom:18px">
      ${sectionTitle?`<div style="font-size:12px;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">${sectionTitle}</div>`:''}
      <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:13px">${rowsHtml}</table>
    </div>`;
}
function _reportSummaryRow(label,value,opts={}){
  const big=opts.big?'font-weight:900;font-size:15px':'font-weight:700;font-size:13px';
  const border=opts.topBorder?'border-top:2px solid #1a2540;padding-top:8px':'';
  return `<table style="width:100%;table-layout:fixed;margin-top:${opts.topBorder?'14px':'4px'};${border}"><tr><td style="width:70%;${big}">${label}</td><td style="width:30%;text-align:right;${big};white-space:nowrap">${value}</td></tr></table>`;
}
function _showPrintReport(html){
  const modal=document.getElementById('report-print-modal');
  if(!modal){toast('Print container missing','error');return;}
  modal.innerHTML=`<div style="max-width:750px;margin:0 auto;padding:40px 50px;font-family:Arial,sans-serif;color:#111">${html}</div>`;
  setTimeout(()=>window.print(),50);
}

function printPL(){
  const pl=window.__plData;
  if(!pl){toast('Load the P&L first','error');return;}
  const from=$('pl-from')?.value||'—', to=$('pl-to')?.value||'—';
  const storeSel=$('pl-store');
  const storeLabel=(storeSel&&storeSel.selectedOptions&&storeSel.selectedOptions[0]&&storeSel.selectedOptions[0].text)||'All Stores';
  const pct=v=>pl.netRevenue?((v||0)/pl.netRevenue*100).toFixed(1)+'% of revenue':'';
  const rows=[
    {label:'Net Revenue',value:fmt(pl.netRevenue)},
    {label:'Cost of Goods Sold (COGS)',value:fmt(pl.cogs)},
    {label:'Gross Profit',value:fmt(pl.grossProfit)+`  (${((pl.grossMargin||0)*100).toFixed(1)}% margin)`,bold:true},
    {label:'Total Operating Expenses',value:fmt(pl.totalExpenses)},
    {label:'EBITDA',value:fmt(pl.ebitda),bold:true},
    {label:'Depreciation Expense',value:fmt(pl.depreciationExpense||0)},
    {label:'Net Profit',value:fmt(pl.netProfit),bold:true},
  ];
  const html=_reportHeader('Profit &amp; Loss Statement',`${storeLabel} · ${from} to ${to}`)
    + _reportSectionTable('',rows)
    + _reportFooter();
  _showPrintReport(html);
}

function printBS(){
  const bs=window.__bsData;
  if(!bs){toast('Load the Balance Sheet first','error');return;}
  const asOf=$('bs-date')?.value||today();
  const row=i=>({label:i.label,value:fmt(i.value)});
  const html=_reportHeader('Balance Sheet',`As of ${asOf}`)
    + `<div style="font-size:14px;font-weight:800;color:#2e7d32;margin:0 0 8px">ASSETS</div>`
    + _reportSectionTable('Current Assets',(bs.currentAssets||[]).map(row))
    + _reportSectionTable('Fixed Assets',(bs.fixedAssets||[]).map(row))
    + _reportSectionTable('',[{label:'TOTAL ASSETS',value:fmt(bs.totalAssets||0),bold:true}])
    + `<div style="font-size:14px;font-weight:800;color:#c62828;margin:20px 0 8px">LIABILITIES</div>`
    + _reportSectionTable('',(bs.liabilities||[]).map(row))
    + _reportSectionTable('',[{label:'TOTAL LIABILITIES',value:fmt(bs.totalLiabilities||0),bold:true}])
    + `<div style="font-size:14px;font-weight:800;color:#7c3aed;margin:20px 0 8px">CAPITAL &amp; EQUITY</div>`
    + _reportSectionTable('',(bs.equity||[]).map(row))
    + _reportSectionTable('',[{label:'TOTAL EQUITY',value:fmt(bs.totalEquity||0),bold:true}])
    + _reportSummaryRow('TOTAL LIABILITIES + EQUITY',fmt(bs.totalLiabEquity||0),{big:true,topBorder:true})
    + _reportFooter();
  _showPrintReport(html);
}

function printCF(){
  const cf=window.__cfData;
  if(!cf){toast('Load the Cash Flow statement first','error');return;}
  const from=$('cf-from')?.value||'—', to=$('cf-to')?.value||'—';
  const row=i=>({label:i.label,value:fmt(i.value)});
  const html=_reportHeader('Cash Flow Statement',`${from} to ${to}`)
    + _reportSectionTable('Operating Activities',(cf.operating||[]).map(row))
    + _reportSectionTable('',[{label:'Net Operating Cash Flow',value:fmt(cf.operatingTotal||0),bold:true}])
    + _reportSectionTable('Investing Activities',(cf.investing||[]).map(row))
    + _reportSectionTable('',[{label:'Net Investing Cash Flow',value:fmt(cf.investingTotal||0),bold:true}])
    + _reportSectionTable('Financing Activities',(cf.financing||[]).map(row))
    + _reportSectionTable('',[{label:'Net Financing Cash Flow',value:fmt(cf.financingTotal||0),bold:true}])
    + _reportSummaryRow('Opening Cash Balance',fmt(cf.opening||0),{topBorder:true})
    + _reportSummaryRow('Net Cash Flow',fmt(cf.netCashFlow||0))
    + _reportSummaryRow('Closing Cash Balance',fmt(cf.closing||0),{big:true})
    + _reportFooter();
  _showPrintReport(html);
}
async function saveSupplier(){const name=$('sup-name').value.trim();if(!name){toast('Enter name','error');return;}const res=await api('/api/ho/suppliers',{method:'POST',body:{name,contact:$('sup-contact').value,limit:parseFloat($('sup-limit').value)||0,terms:$('sup-terms').value}});if(res&&res.ok){toast('✅ Supplier saved');['sup-name','sup-contact','sup-limit'].forEach(id=>{if($(id))$(id).value='';});await loadAll();renderSupplierAccounts();}else toast('❌ Failed','error');}
async function saveSupplierTxn(){const supId=$('sup-txn-supplier').value,amt=parseFloat($('sup-txn-amt').value)||0;if(!supId||!amt){toast('Select supplier + amount','error');return;}const res=await api('/api/ho/supplier-txns',{method:'POST',body:{supplierId:supId,date:$('sup-txn-date').value,type:$('sup-txn-type').value,amount:amt,ref:$('sup-txn-ref').value}});if(res&&res.ok){toast('✅ Recorded');['sup-txn-amt','sup-txn-ref'].forEach(id=>{if($(id))$(id).value='';});await loadAll();renderSupplierAccounts();}else toast('❌ Failed','error');}
async function paySupplierFX(){
  const supId=$('pay-sup-supplier')?$('pay-sup-supplier').value:'';
  const amt=parseFloat($('pay-sup-amt')&&$('pay-sup-amt').value)||0;
  const currency=($('pay-sup-currency')&&$('pay-sup-currency').value)||'LYD';
  const rate=+(($('pay-sup-rate')&&$('pay-sup-rate').value)||1);
  if(!supId||!amt){toast('Select supplier + amount','error');return;}
  const res=await api(`/api/ho/suppliers/${encodeURIComponent(supId)}/pay`,{method:'POST',body:{
    supplierId:supId,amount:amt,currency,exchangeRate:rate,
    date:($('pay-sup-date')&&$('pay-sup-date').value)||undefined,
    reference:($('pay-sup-ref')&&$('pay-sup-ref').value)||'',
  }});
  if(res&&res.ok){
    let msg=`✅ Paid — ${fmt(res.amountLYD)} LYD`;
    if(Math.abs(res.exchangeDifference)>=0.01)msg+=` · Exchange ${res.exchangeDifference>0?'Loss':'Gain'}: ${fmt(Math.abs(res.exchangeDifference))} LYD (posted to P&L)`;
    if($('pay-sup-result'))$('pay-sup-result').innerHTML=msg;
    toast('✅ Payment recorded');
    ['pay-sup-amt','pay-sup-ref'].forEach(id=>{if($(id))$(id).value='';});
    await loadAll();renderSupplierAccounts();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function populateSupplierSelect(){const opts=suppliers.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');if($('sup-txn-supplier'))$('sup-txn-supplier').innerHTML=opts;if($('po-supplier'))$('po-supplier').innerHTML=opts;if($('pay-sup-supplier'))$('pay-sup-supplier').innerHTML=opts;}
function renderSupplierAccounts(){
  const totalPayable=suppliers.reduce((a,s)=>a+Math.max(s.balance||0,0),0);
  const totalCredit=suppliers.reduce((a,s)=>a+Math.max(-(s.balance||0),0),0);
  const withBalance=suppliers.filter(s=>(s.balance||0)>0).length;
  if($('sup-kpis'))$('sup-kpis').innerHTML=[
    ['Total Payable',fmt(totalPayable),'red'],
    ['Total Suppliers',suppliers.length,''],
    ['Suppliers with Balance Due',withBalance,'amber'],
    ['Credit Owed to Us',fmt(totalCredit),'green'],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');
  if($('sup-balances'))$('sup-balances').innerHTML=suppliers.map(b=>`<tr style="cursor:pointer" onclick="openSupStatement('${b.id}')"><td class="fw7">${b.name}</td><td>${b.terms||''}</td><td>${fmt(b.invoiced||0)}</td><td class="text-green">${fmt(b.paid||0)}</td><td class="fw7" style="color:${b.balance>0?'var(--red)':b.balance<0?'var(--green)':'var(--navy)'}">${fmt(Math.abs(b.balance||0))} ${b.balance>0?'DUE':b.balance<0?'CREDIT':''}</td><td><span class="badge ${b.balance<=0?'badge-green':'badge-amber'}">${b.balance<=0?'Paid':'Pending'}</span></td></tr>`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:16px">No suppliers</td></tr>';
  if($('sup-txns'))$('sup-txns').innerHTML=supplierTxns.slice(0,15).map(t=>`<tr><td>${t.date}</td><td>${t.supplierName}</td><td><span class="badge ${t.type==='payment'?'badge-green':'badge-amber'}">${t.type}</span></td><td class="fw7">${fmt(t.amount)}</td><td>${t.ref||'—'}</td><td><button class="btn btn-ghost btn-sm" onclick="deleteSupplierTxn('${t.id}')">🗑️</button></td></tr>`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:16px">No txns</td></tr>';
  populateSupplierSelect();
}
let __supStmtId=null;
function openSupStatement(supId){
  const sup=suppliers.find(s=>s.id===supId);
  if(!sup)return;
  __supStmtId=supId;
  const txns=supplierTxns.filter(t=>t.supplierId===supId||t.supplier_id===supId).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  if($('sup-stmt-title'))$('sup-stmt-title').textContent='🧾 '+sup.name+' — Statement';
  if($('sup-stmt-sub'))$('sup-stmt-sub').textContent=`${sup.terms||''} · ${sup.contact||'No contact on file'}`;
  let bal=0;
  const rows=txns.map(t=>{
    const isDebit=t.type==='payment'||t.type==='credit'; // reduces what we owe
    if(isDebit)bal-=Math.abs(t.amount||0);else bal+=Math.abs(t.amount||0);
    return {...t,runningBalance:bal};
  });
  if($('sup-stmt-kpis'))$('sup-stmt-kpis').innerHTML=[
    ['Total Invoiced',fmt(sup.invoiced||0),''],
    ['Total Paid',fmt(sup.paid||0),'green'],
    ['Current Balance',fmt(Math.abs(sup.balance||0))+(sup.balance>0?' DUE':sup.balance<0?' CREDIT':''),sup.balance>0?'red':'green'],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value" style="font-size:16px">${v}</div></div>`).join('');
  const typeBadge=t=>({invoice:'badge-amber',payment:'badge-green',credit:'badge-blue'}[t]||'badge-gray');
  if($('sup-stmt-table'))$('sup-stmt-table').innerHTML=rows.map(t=>`<tr>
    <td>${t.date}</td><td><span class="badge ${typeBadge(t.type)}">${t.type}</span></td><td style="font-size:11px">${t.ref||'—'}</td>
    <td class="text-right">${t.type==='invoice'?fmt(t.amount):''}</td>
    <td class="text-right text-green">${t.type!=='invoice'?fmt(t.amount):''}</td>
    <td class="text-right fw7">${fmt(Math.abs(t.runningBalance))}${t.runningBalance>0?' DUE':t.runningBalance<0?' CR':''}</td>
  </tr>`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:16px">No transactions yet</td></tr>';
  $('sup-statement-modal').style.display='flex';
}
function closeSupStatement(){$('sup-statement-modal').style.display='none';__supStmtId=null;}
function printSupStatement(){
  const sup=suppliers.find(s=>s.id===__supStmtId);
  if(!sup)return;
  const company=(DATA.settings&&DATA.settings.company)||'ANTA Shoes';
  const tableHtml=$('sup-stmt-table').innerHTML;
  const html=`<div style="max-width:700px;margin:0 auto;padding:40px 50px;font-family:Arial,sans-serif;color:#111">
    <div style="text-align:center;margin-bottom:24px;border-bottom:2px solid #1a2540;padding-bottom:14px">
      <div style="font-size:22px;font-weight:900;color:#1a2540">${company}</div>
      <div style="font-size:15px;font-weight:700;margin-top:4px">Supplier Statement — ${sup.name}</div>
      <div style="font-size:11px;color:#666;margin-top:2px">${sup.terms||''} · Generated ${new Date().toLocaleString()}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="border-bottom:2px solid #333;text-align:left">
      <th style="padding:6px 4px">Date</th><th style="padding:6px 4px">Type</th><th style="padding:6px 4px">Ref</th>
      <th style="padding:6px 4px;text-align:right">Debit</th><th style="padding:6px 4px;text-align:right">Credit</th><th style="padding:6px 4px;text-align:right">Balance</th>
    </tr></thead><tbody>${tableHtml.replace(/<span class="badge[^>]*>/g,'<span>')}</tbody></table>
    <div style="text-align:right;margin-top:16px;font-weight:900;font-size:15px">Balance Due: ${fmt(Math.abs(sup.balance||0))}</div>
  </div>`;
  const modal=document.getElementById('report-print-modal');
  if(!modal){toast('Print container missing','error');return;}
  modal.innerHTML=html;
  setTimeout(()=>window.print(),80);
}

async function deleteSupplierTxn(id){
  if(!confirm('Delete this supplier transaction? This will change the supplier\'s balance. This cannot be undone.'))return;
  const res=await api(`/api/ho/supplier-txns/${encodeURIComponent(id)}`,{method:'DELETE'});
  if(res&&res.ok){toast('✅ Deleted');await loadAll();renderSupplierAccounts();}
  else toast('❌ Failed','error');
}
function exportSupplierBalances(){
  _csvDownload(suppliers,[['Supplier','name'],['Terms','terms'],['Total Invoiced','invoiced'],['Total Paid','paid'],['Balance','balance']],'supplier_balances_'+today()+'.csv');
}
function exportSupplierTxns(){
  _csvDownload(supplierTxns,[['Date','date'],['Supplier','supplierName'],['Type','type'],['Amount','amount'],['Reference','ref']],'supplier_transactions_'+today()+'.csv');
}
function saveSuppliers(){}function saveSupplierTxns(){}function getSupplierTxns(){return supplierTxns;}function getSupplierBalances(){return suppliers;}

// ---------- Purchase Orders ----------
function addPOLine(){poLines.push({barcode:'',name:'',qty:1,cost:0});renderPOLines();}
function renderPOLines(){
  if(!$('po-lines'))return;
  $('po-lines').innerHTML=poLines.map((l,i)=>`<tr>
    <td><input class="form-input" style="width:120px;padding:4px 7px;font-size:11px" value="${l.barcode}" oninput="poLines[${i}].barcode=this.value"></td>
    <td><input class="form-input" style="padding:4px 7px;font-size:11px" value="${l.name}" oninput="poLines[${i}].name=this.value"></td>
    <td><input class="form-input" type="number" style="width:65px;padding:4px 7px" value="${l.qty}" oninput="poLines[${i}].qty=+this.value;calcPOTotal()"></td>
    <td><input class="form-input" type="number" style="width:85px;padding:4px 7px" value="${l.cost}" oninput="poLines[${i}].cost=+this.value;calcPOTotal()"></td>
    <td><button class="btn btn-ghost btn-sm" onclick="poLines.splice(${i},1);renderPOLines()">✕</button></td>
  </tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:13px">Add lines</td></tr>';
  calcPOTotal();
}
function calcPOTotal(){
  const total=poLines.reduce((a,l)=>a+((+l.qty||0)*(+l.cost||0)),0);
  if($('po-total'))$('po-total').textContent='Total: '+fmt(total);
}
function downloadPOTemplate(){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['Barcode,Name,Qty,UnitCost\n8001000000001,ANTA Running Pro,20,120\n'],{type:'text/csv'}));
  a.download='purchase_order_template.csv';a.click();
}
async function uploadPOExcel(file){
  if(!file)return;
  const rows=await readExcel(file);
  rows.forEach(r=>poLines.push({barcode:cleanId(r.Barcode||r.barcode),name:String(r.Name||r.name||'').trim(),qty:+(r.Qty||r.qty||1),cost:+(r.UnitCost||r.Cost||r.unitcost||r.cost||0)}));
  renderPOLines();
  toast('✅ '+rows.length+' line(s) added — review below, then Create Purchase Order');
}
function dropPO(e){e.preventDefault();e.currentTarget.classList.remove('over');if(e.dataTransfer.files[0])uploadPOExcel(e.dataTransfer.files[0]);}
async function savePO(){
  const supplierId=$('po-supplier').value;
  if(!supplierId){toast('Select a supplier','error');return;}
  const lines=poLines.filter(l=>l.barcode&&l.qty);
  if(!lines.length){toast('Add at least one line item','error');return;}
  const advanceOn=$('po-advance-toggle').checked;
  const advance=advanceOn?(parseFloat($('po-advance-amt').value)||0):0;
  const meta={date:$('po-date').value||today(),expectedDate:$('po-expected').value||'',supplierId};
  const poid='PO-'+Date.now();
  const startTime=Date.now();
  const logRows=[];
  const CHUNK=300;
  let saved=0,failed=0;
  bupShow('po-bup');
  bupUpdate({prefix:'po-bup',status:'⏳ Saving Purchase Order… keep this tab open',done:0,total:lines.length,startTime});
  for(let i=0;i<lines.length;i+=CHUNK){
    const chunk=lines.slice(i,i+CHUNK);
    const body={...meta,poId:poid,lines:chunk.map(l=>({barcode:l.barcode,name:l.name,qty:+l.qty,cost:+l.cost})),advancePaid:i===0?advance:0};
    const res=await api('/api/ho/purchase-orders',{method:'POST',body});
    if(res&&res.ok&&Array.isArray(res.results)){
      res.results.forEach(r=>logRows.push(r));
      saved+=res.results.filter(r=>r.status==='saved').length;
      failed+=res.results.filter(r=>r.status==='failed').length;
    } else {
      chunk.forEach(l=>logRows.push({barcode:l.barcode||'?',name:l.name||'',status:'failed',reason:(res&&(res.detail||res.msg))||'request failed — no response from server'}));
      failed+=chunk.length;
    }
    bupUpdate({prefix:'po-bup',status:'⏳ Saving Purchase Order… keep this tab open',done:Math.min(i+CHUNK,lines.length),total:lines.length,startTime,failed});
  }
  bupUpdate({prefix:'po-bup',status:'✅ Done',done:lines.length,total:lines.length,startTime,failed});
  setTimeout(()=>bupHide('po-bup'),2500);
  if(saved){
    toast(`✅ Purchase Order ${poid} — ${saved} item(s) saved`+(failed?`, ${failed} failed — see downloaded log`:''),failed?'warn':'ok');
    poLines=[];renderPOLines();
    if($('po-advance-toggle'))$('po-advance-toggle').checked=false;
    if($('po-advance-row'))$('po-advance-row').style.display='none';
    if($('po-advance-amt'))$('po-advance-amt').value='';
    await loadAll();
    loadPOs();
  } else {
    toast('❌ Purchase Order save failed — 0 items saved. Check the downloaded log for the reason.','error');
  }
  if(logRows.length)downloadEventLog(logRows);
}
function exportPOs(){
  const rows=[];
  __poList.forEach(po=>po.lines.forEach(l=>rows.push({poId:po.id,supplier:po.supplierName,status:po.status,date:po.date,barcode:l.barcode,name:l.name,qtyOrdered:l.qtyOrdered,qtyReceived:l.qtyReceived,unitCost:l.unitCost,lineTotal:l.lineTotal})));
  _csvDownload(rows,[['PO ID','poId'],['Supplier','supplier'],['Status','status'],['Date','date'],['Barcode','barcode'],['Name','name'],['Qty Ordered','qtyOrdered'],['Qty Received','qtyReceived'],['Unit Cost','unitCost'],['Line Total','lineTotal']],'purchase_orders_'+today()+'.csv');
}

// ---------- Auto-PO / Reorder Suggestions ----------
let __reorderList=[];
async function openReorderSuggest(){
  const res=await api('/api/ho/reorder-suggestions');
  if(!res||!res.ok){toast('Failed to load suggestions','error');return;}
  __reorderList=res.data||[];
  if($('reorder-suggest-table'))$('reorder-suggest-table').innerHTML=__reorderList.map((s,i)=>`<tr>
    <td><input type="checkbox" class="reorder-chk" data-i="${i}" checked></td>
    <td style="font-family:monospace;font-size:10px">${s.barcode}</td>
    <td>${s.name}</td>
    <td>${s.totalStock}${s.alreadyOnOrder?` <span style="color:var(--gray4);font-size:10px">(+${s.alreadyOnOrder} on order)</span>`:''}</td>
    <td><input class="form-input" type="number" style="width:75px;padding:4px 7px" id="reorder-qty-${i}" value="${s.suggestedQty}"></td>
    <td>${fmt(s.lastCost)}</td>
  </tr>`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:16px">Nothing needs reordering right now 🎉</td></tr>';
  $('reorder-suggest-modal').style.display='flex';
}
function closeReorderSuggest(){$('reorder-suggest-modal').style.display='none';}
function toggleAllReorder(cb){document.querySelectorAll('.reorder-chk').forEach(c=>c.checked=cb.checked);}
function addSuggestedToPO(){
  const checked=[...document.querySelectorAll('.reorder-chk:checked')];
  if(!checked.length){toast('Select at least one item','error');return;}
  let added=0;
  checked.forEach(c=>{
    const i=+c.dataset.i;
    const s=__reorderList[i];
    const qty=+($('reorder-qty-'+i)?.value)||s.suggestedQty;
    if(qty<=0)return;
    const existing=poLines.find(l=>l.barcode===s.barcode);
    if(existing){existing.qty=(+existing.qty||0)+qty;}
    else{poLines.push({barcode:s.barcode,name:s.name,qty,cost:s.lastCost});}
    added++;
  });
  renderPOLines();
  closeReorderSuggest();
  toast(`✅ ${added} item(s) added to the PO form below`);
}

// ---------- Stock Aging ----------
let __agingList=[];
async function loadStockAging(){
  const days=$('aging-threshold')?$('aging-threshold').value:60;
  const res=await api('/api/ho/stock-aging?days_threshold='+encodeURIComponent(days));
  if(!res||!res.ok){toast('Failed to load stock aging','error');return;}
  __agingList=res.data||[];
  if($('aging-kpis'))$('aging-kpis').innerHTML=[
    ['Slow-Moving Items',__agingList.length,'amber'],
    ['Dead Stock Value',fmt(res.totalDeadStockValue||0),'red'],
    ['Never Sold',__agingList.filter(r=>r.neverSold).length,''],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');
  if($('aging-table'))$('aging-table').innerHTML=__agingList.map(r=>`<tr>
    <td style="font-family:monospace;font-size:10px">${r.barcode}</td><td class="fw7">${r.name}</td><td>${r.category||''}</td>
    <td>${r.stock}</td><td>${fmt(r.stockValue)}</td>
    <td>${r.neverSold?'<span class="badge badge-red">Never sold</span>':r.lastSoldDate}</td>
    <td>${r.neverSold?'—':(r.daysIdle+' days')}</td>
  </tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:16px">Nothing slow-moving — good sell-through! 🎉</td></tr>';
}
function exportStockAging(){
  _csvDownload(__agingList,[['Barcode','barcode'],['Name','name'],['Category','category'],['Stock','stock'],['Stock Value','stockValue'],['Last Sold','lastSoldDate'],['Days Idle','daysIdle'],['Never Sold','neverSold']],'stock_aging_'+today()+'.csv');
}

// ---------- Audit Log ----------
let __auditList=[];
async function loadAuditLog(){
  const qs=new URLSearchParams();
  const et=$('audit-entity-filter')?$('audit-entity-filter').value:'all';
  const ac=$('audit-action-filter')?$('audit-action-filter').value:'all';
  const q=$('audit-search')?$('audit-search').value:'';
  if(et&&et!=='all')qs.set('entity_type',et);
  if(ac&&ac!=='all')qs.set('action',ac);
  if(q)qs.set('q',q);
  const res=await api('/api/ho/audit-log?'+qs);
  if(!res||!res.ok){toast('Failed to load audit log','error');return;}
  __auditList=res.data||[];
  const actionBadge=a=>({create:'badge-green',update:'badge-amber',delete:'badge-red'}[a]||'badge-gray');
  if($('audit-table'))$('audit-table').innerHTML=__auditList.map((l,i)=>{
    const dt=l.timestamp?new Date(l.timestamp+'Z').toLocaleString():'';
    return `<tr><td style="font-size:10px;white-space:nowrap">${dt}</td><td>${l.userName||'—'}</td><td><span class="badge badge-blue">${l.role||''}</span></td><td><span class="badge ${actionBadge(l.action)}">${l.action}</span></td><td>${l.entityType}</td><td style="font-size:11px">${l.summary}</td><td>${(l.oldValue||l.newValue)?`<button class="btn btn-ghost btn-sm" onclick="viewAuditDetail(${i})">👁️</button>`:''}</td></tr>`;
  }).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:16px">No audit entries found</td></tr>';
}
function viewAuditDetail(i){
  const l=__auditList[i];
  if(!l)return;
  let html=`<div style="margin-bottom:8px"><b>${l.summary}</b></div><div style="color:var(--gray4);font-size:11px;margin-bottom:10px">${l.userName} (${l.role}) · ${new Date(l.timestamp+'Z').toLocaleString()}</div>`;
  const fmtJson=s=>{try{const o=JSON.parse(s);return Object.entries(o).map(([k,v])=>`<div style="padding:3px 0;border-bottom:1px solid var(--gray1)"><span style="color:var(--gray4)">${k}:</span> <b>${v}</b></div>`).join('');}catch(e){return s;}};
  if(l.oldValue){html+=`<div style="font-weight:700;font-size:11px;margin:8px 0 4px;color:var(--red)">Before</div>${fmtJson(l.oldValue)}`;}
  if(l.newValue){html+=`<div style="font-weight:700;font-size:11px;margin:8px 0 4px;color:var(--green)">After</div>${fmtJson(l.newValue)}`;}
  if($('audit-detail-body'))$('audit-detail-body').innerHTML=html;
  $('audit-detail-modal').style.display='flex';
}
function closeAuditDetail(){$('audit-detail-modal').style.display='none';}
function exportAuditLog(){
  _csvDownload(__auditList,[['Timestamp','timestamp'],['User','userName'],['Role','role'],['Action','action'],['Type','entityType'],['Entity ID','entityId'],['Summary','summary']],'audit_log_'+today()+'.csv');
}

// ---------- Barcode Label Printing ----------
let __lblQueue=[],__lblSearchResults=[],__lblSearchTimer=null;
function searchLabelProduct(q){
  clearTimeout(__lblSearchTimer);
  const drop=$('lbl-drop');
  if(!q||q.length<2){if(drop)drop.style.display='none';return;}
  __lblSearchTimer=setTimeout(()=>{
    const ql=q.toLowerCase();
    __lblSearchResults=(DATA.products||[]).filter(p=>(p.Barcode||'').toLowerCase().includes(ql)||(p.Name||'').toLowerCase().includes(ql)).slice(0,25);
    if(!drop)return;
    drop.innerHTML=__lblSearchResults.map((p,i)=>`<div style="padding:7px 9px;border-bottom:1px solid var(--gray1);cursor:pointer;font-size:11px" onclick="addLabelByIdx(${i})"><b>${p.Name}</b><br><span style="color:var(--gray4);font-family:monospace">${p.Barcode}</span> · ${fmt(p.Retail||0)}</div>`).join('')||'<div style="padding:9px;font-size:11px;color:var(--gray4)">No match</div>';
    drop.style.display='block';
  },200);
}
function addLabelByIdx(i){
  const p=__lblSearchResults[i];
  if(!p)return;
  addLabelToQueue(p.Barcode,p.Name,p.Retail||0,1);
  if($('lbl-drop'))$('lbl-drop').style.display='none';
  if($('lbl-search'))$('lbl-search').value='';
}
function addLabelToQueue(barcode,name,price,qty){
  const existing=__lblQueue.find(l=>l.barcode===barcode);
  if(existing){existing.qty=(+existing.qty||0)+(+qty||1);}
  else{__lblQueue.push({barcode,name,price:price||0,qty:qty||1});}
  renderLabelQueue();
}
function renderLabelQueue(){
  if($('lbl-queue'))$('lbl-queue').innerHTML=__lblQueue.map((l,i)=>`<tr>
    <td style="font-family:monospace;font-size:10px">${l.barcode}</td><td>${l.name}</td><td>${fmt(l.price)}</td>
    <td><input class="form-input" type="number" style="width:60px;padding:4px 7px" value="${l.qty}" min="1" oninput="__lblQueue[${i}].qty=+this.value;updateLabelTotal()"></td>
    <td><button class="btn btn-ghost btn-sm" onclick="__lblQueue.splice(${i},1);renderLabelQueue()">✕</button></td>
  </tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:13px">Search and add products to print labels</td></tr>';
  updateLabelTotal();
}
function updateLabelTotal(){
  const total=__lblQueue.reduce((a,l)=>a+(+l.qty||0),0);
  if($('lbl-total-count'))$('lbl-total-count').textContent=total+' label'+(total===1?'':'s')+' queued';
}
function clearLabelQueue(){__lblQueue=[];renderLabelQueue();}
function loadLabelsFromLines(lines){
  __lblQueue=[];
  (lines||[]).forEach(l=>{
    const prod=(DATA.products||[]).find(p=>p.Barcode===l.barcode);
    addLabelToQueue(l.barcode,l.name||(prod?prod.Name:l.barcode),prod?prod.Retail:0,l.qty||1);
  });
  show('barcode-labels');
  toast('🏷️ Loaded '+__lblQueue.length+' item(s) into the label queue');
}
function printBarcodeLabels(){
  if(!__lblQueue.length){toast('Add at least one product to the queue','error');return;}
  if(typeof JsBarcode==='undefined'){toast('Barcode library still loading — try again in a moment','error');return;}
  const cols=+($('lbl-layout')?.value)||4;
  const company=(DATA.settings&&DATA.settings.company)||'ANTA Shoes';
  let labelsHtml='';
  let idx=0;
  __lblQueue.forEach(item=>{
    for(let n=0;n<(+item.qty||1);n++){
      labelsHtml+=`<div class="lbl-cell" style="border:1px dashed #bbb;padding:8px 6px;text-align:center;break-inside:avoid">
        <div style="font-size:9px;font-weight:700;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${company}</div>
        <div style="font-size:10px;font-weight:600;margin:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.name}</div>
        <svg class="lbl-barcode" id="lbl-svg-${idx}" data-code="${item.barcode}"></svg>
        <div style="font-size:11px;font-weight:800;margin-top:2px">${fmt(item.price)}</div>
      </div>`;
      idx++;
    }
  });
  const modal=document.getElementById('report-print-modal');
  modal.innerHTML=`<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:6px">${labelsHtml}</div>`;
  document.querySelectorAll('.lbl-barcode').forEach(svg=>{
    try{JsBarcode(svg,svg.dataset.code,{format:'CODE128',width:1.4,height:34,fontSize:10,margin:2,displayValue:true});}catch(e){}
  });
  setTimeout(()=>window.print(),150);
}
async function loadPOs(){
  const status=$('po-status-filter')?$('po-status-filter').value:'all';
  const res=await api('/api/ho/purchase-orders?status='+encodeURIComponent(status));
  if(!res||!res.ok){toast('Failed to load purchase orders','error');return;}
  __poList=res.data||[];
  const statusBadge=s=>({open:'badge-blue',partially_received:'badge-amber',received:'badge-green',cancelled:'badge-gray'}[s]||'badge-gray');
  const statusLabel=s=>({open:'Open',partially_received:'Partially Received',received:'Received',cancelled:'Cancelled'}[s]||s);
  if($('po-table'))$('po-table').innerHTML=__poList.map(po=>{
    const canReceive=po.status==='open'||po.status==='partially_received';
    const canCancel=po.status==='open';
    const hasReceived=po.status==='received'||po.status==='partially_received';
    const actions=[
      canReceive?`<button class="btn btn-green btn-sm" onclick="quickReceiveFullPO('${po.id}')">⚡ Receive All</button> <button class="btn btn-ghost btn-sm" onclick="openPOReceive('${po.id}')">📥 Review &amp; Receive</button>`:'',
      canCancel?`<button class="btn btn-ghost btn-sm" onclick="cancelPOUI('${po.id}')">🚫 Cancel</button>`:'',
      hasReceived?`<button class="btn btn-ghost btn-sm" onclick="printLabelsForPO('${po.id}')">🏷️ Labels</button>`:'',
    ].filter(Boolean).join(' ');
    return `<tr><td style="font-family:monospace;font-size:10px">${po.id}</td><td>${po.supplierName}</td><td>${fmt(po.total)}</td><td>${fmt(po.advancePaid)}</td><td><span class="badge ${statusBadge(po.status)}">${statusLabel(po.status)}</span></td><td>${actions||'—'}</td></tr>`;
  }).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:16px">No purchase orders</td></tr>';
}
function printLabelsForPO(poId){
  const po=__poList.find(p=>p.id===poId);
  if(!po){toast('Not found','error');return;}
  const lines=po.lines.filter(l=>l.qtyReceived>0).map(l=>({barcode:l.barcode,name:l.name,qty:l.qtyReceived}));
  if(!lines.length){toast('Nothing received yet on this PO','error');return;}
  loadLabelsFromLines(lines);
}
async function quickReceiveFullPO(poId){
  if(!confirm('Receive the FULL remaining quantity for every item on this PO, exactly as ordered? Use "Review & Receive" instead if you need to adjust quantities.'))return;
  const res=await api(`/api/ho/purchase-orders/${encodeURIComponent(poId)}/receive`,{method:'POST',body:{date:today()}});
  if(res&&res.ok){
    toast(`✅ Received in full — stock and cost updated (GRN ${res.grnId})`);
    await loadAll();
    loadPOs();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function openPOReceive(poId){
  const po=__poList.find(p=>p.id===poId);
  if(!po){toast('Not found','error');return;}
  __poReceiveTarget=poId;
  if($('po-receive-info'))$('po-receive-info').textContent=`${po.id} — ${po.supplierName} — Total ${fmt(po.total)}, Paid ${fmt(po.advancePaid)}`;
  if($('po-receive-date'))$('po-receive-date').value=today();
  const outstandingLines=po.lines.filter(l=>l.outstanding>0);
  if($('po-receive-lines'))$('po-receive-lines').innerHTML=outstandingLines.map((l,i)=>`<tr>
    <td style="font-family:monospace;font-size:10px">${l.barcode}</td><td>${l.name}</td><td>${l.outstanding}</td>
    <td><input class="form-input" type="number" style="width:80px;padding:4px 7px" id="po-recv-qty-${i}" data-barcode="${l.barcode}" value="${l.outstanding}" max="${l.outstanding}" min="0"></td>
  </tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:var(--gray3)">Nothing outstanding</td></tr>';
  $('po-receive-form').style.display='flex';
}
function closePOReceive(){$('po-receive-form').style.display='none';__poReceiveTarget=null;}
async function confirmPOReceive(){
  if(!__poReceiveTarget)return;
  const inputs=document.querySelectorAll('[id^="po-recv-qty-"]');
  const lines=[...inputs].map(inp=>({barcode:inp.dataset.barcode,qty:+inp.value||0})).filter(l=>l.qty>0);
  if(!lines.length){toast('Enter at least one quantity to receive','error');return;}
  const po=__poList.find(p=>p.id===__poReceiveTarget);
  const namesByBarcode={};
  if(po)po.lines.forEach(l=>{namesByBarcode[l.barcode]=l.name;});
  lines.forEach(l=>{l.name=namesByBarcode[l.barcode]||l.barcode;});
  const res=await api(`/api/ho/purchase-orders/${encodeURIComponent(__poReceiveTarget)}/receive`,{method:'POST',body:{date:$('po-receive-date').value||today(),lines}});
  if(res&&res.ok){
    toast('✅ Received — stock and cost updated');
    window.__lastReceivedPOLines=lines;
    closePOReceive();
    await loadAll();
    loadPOs();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function cancelPOUI(poId){
  if(!confirm('Cancel this Purchase Order? This cannot be undone.'))return;
  const res=await api(`/api/ho/purchase-orders/${encodeURIComponent(poId)}/cancel`,{method:'POST'});
  if(res&&res.ok){toast('✅ Cancelled');loadPOs();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}

// ---------- Customers (CRM / Loyalty) ----------
let __custList=[],__custDetailId=null;
async function loadCustomersHO(){
  const q=$('cust-search')?$('cust-search').value:'';
  const res=await api('/api/customers?'+(q?('q='+encodeURIComponent(q)):'')+'&limit=200');
  if(!res||!res.ok){toast('Failed to load customers','error');return;}
  __custList=res.data||[];
  const totalSpent=__custList.reduce((a,c)=>a+(+c.totalSpent||0),0);
  const totalPoints=__custList.reduce((a,c)=>a+(+c.loyaltyPoints||0),0);
  if($('cust-kpis'))$('cust-kpis').innerHTML=[
    ['Total Customers',__custList.length,''],
    ['Total Spent (all)',fmt(totalSpent),'green'],
    ['Outstanding Points',totalPoints.toFixed(0),'amber'],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');
  renderCustTable(__custList);
}
function renderCustTable(list){
  if($('cust-table'))$('cust-table').innerHTML=list.map(c=>`<tr>
    <td class="fw7">${c.name}</td><td>${c.phone||'—'}</td><td>${c.visitCount||0}</td>
    <td>${fmt(c.totalSpent||0)}</td><td>${(c.loyaltyPoints||0).toFixed(0)} <span style="color:var(--gray4);font-size:10px">(${fmt(c.loyaltyPointsValue||0)})</span></td>
    <td>${c.lastVisit||'—'}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="openCustDetail('${c.id}')">👁️ View</button> <button class="btn btn-ghost btn-sm" onclick="openCustStatement('${c.id}')">📄 Statement</button></td>
  </tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:16px">No customers yet</td></tr>';
}
async function openCustStatement(id){
  const res=await api(`/api/ho/customers/${encodeURIComponent(id)}/statement`);
  if(!res||!res.ok){toast('Failed to load statement','error');return;}
  const rows=(res.lines||[]).map(l=>`<tr><td style="padding:5px 0">${l.date}</td><td>${l.type} — ${l.reference}</td><td style="text-align:right">${l.debit?fmt(l.debit):''}</td><td style="text-align:right">${l.credit?fmt(l.credit):''}</td><td style="text-align:right;font-weight:700">${fmt(l.balance)}</td></tr>`).join('');
  const html=`<div style="max-width:600px;margin:0 auto;padding:30px;font-family:Arial,sans-serif;color:#111">
    <div style="text-align:center;margin-bottom:20px;border-bottom:2px solid #1a2540;padding-bottom:12px">
      <div style="font-size:20px;font-weight:900;color:#1a2540">Customer Account Statement</div>
      <div style="font-size:13px;margin-top:3px">${res.customerName} ${res.phone?'— '+res.phone:''}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="border-bottom:1px solid #ccc;text-align:left"><th style="padding:5px 0">Date</th><th>Transaction</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th><th style="text-align:right">Balance</th></tr></thead>
    <tbody>${rows||'<tr><td colspan="5" style="text-align:center;padding:14px;color:#999">No transactions yet</td></tr>'}</tbody></table>
    <div style="display:flex;justify-content:space-between;align-items:center;background:#1a2540;color:#fff;border-radius:8px;padding:12px 16px;margin-top:14px">
      <span style="font-weight:700">CLOSING BALANCE</span><span style="font-size:19px;font-weight:900">${fmt(res.closingBalance)}</span>
    </div>
  </div>`;
  const modal=document.getElementById('report-print-modal');
  if(!modal){toast('Print container missing','error');return;}
  modal.innerHTML=html;
  setTimeout(()=>window.print(),80);
}
async function loadTopCustomers(){
  const res=await api('/api/customers-top/list?limit=20');
  if(!res||!res.ok){toast('Failed','error');return;}
  __custList=res.data||[];
  renderCustTable(__custList);
  toast('🏆 Showing top customers by total spent');
}
async function openCustDetail(id){
  const res=await api(`/api/customers/${encodeURIComponent(id)}`);
  if(!res||!res.ok){toast('Not found','error');return;}
  __custDetailId=id;
  if($('cust-detail-title'))$('cust-detail-title').textContent=`🧑 ${res.name}`;
  if($('cust-detail-kpis'))$('cust-detail-kpis').innerHTML=[
    ['Visits',res.visitCount||0,''],
    ['Total Spent',fmt(res.totalSpent||0),'green'],
    ['Points',(res.loyaltyPoints||0).toFixed(0)+' ('+fmt(res.loyaltyPointsValue||0)+')','amber'],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');
  if($('cd-name'))$('cd-name').value=res.name||'';
  if($('cd-phone'))$('cd-phone').value=res.phone||'';
  if($('cd-email'))$('cd-email').value=res.email||'';
  if($('cd-notes'))$('cd-notes').value=res.notes||'';
  if($('cust-history'))$('cust-history').innerHTML=(res.purchaseHistory||[]).map(h=>`<tr><td class="fw7">${h.invoice}</td><td>${h.date}</td><td>${h.store||''}</td><td>${fmt(h.total)}</td><td style="color:var(--green)">${h.pointsEarned||0}</td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:12px">No purchases yet</td></tr>';
  $('cust-detail-modal').style.display='flex';
}
function closeCustDetail(){$('cust-detail-modal').style.display='none';__custDetailId=null;}
async function saveCustomerEdit(){
  if(!__custDetailId)return;
  const body={name:$('cd-name').value.trim(),phone:$('cd-phone').value.trim(),email:$('cd-email').value.trim(),notes:$('cd-notes').value.trim()};
  if(!body.name){toast('Name required','error');return;}
  const res=await api(`/api/customers/${encodeURIComponent(__custDetailId)}`,{method:'PUT',body});
  if(res&&res.ok){toast('✅ Updated');closeCustDetail();loadCustomersHO();}
  else toast('❌ Failed','error');
}
function exportCustomers(){
  _csvDownload(__custList,[['Name','name'],['Phone','phone'],['Email','email'],['Visits','visitCount'],['Total Spent','totalSpent'],['Loyalty Points','loyaltyPoints'],['Points Value','loyaltyPointsValue'],['Last Visit','lastVisit']],'customers_'+today()+'.csv');
}


async function saveCapitalEntry(){const type=$('cap-type').value,date=$('cap-date').value,amt=parseFloat($('cap-amt').value)||0,desc=$('cap-desc').value.trim();if(!amt||!desc){toast('Fill fields','error');return;}const editId=$('cap-editid')?$('cap-editid').value:'';const res=editId?await api(`/api/ho/capital/${encodeURIComponent(editId)}`,{method:'PUT',body:{type,date,amount:amt,description:desc}}):await api('/api/ho/capital',{method:'POST',body:{type,date,amount:amt,description:desc}});if(res&&res.ok){toast(editId?'✅ Updated':'✅ Saved');['cap-amt','cap-desc'].forEach(id=>{if($(id))$(id).value='';});if($('cap-editid'))$('cap-editid').value='';const btn=document.querySelector('[onclick="saveCapitalEntry()"]');if(btn)btn.textContent='💾 Save';await loadAll();renderCapital();}else toast('❌ Failed','error');}
function renderCapital(){const invested=capitalEntries.filter(c=>c.type==='investment').reduce((a,c)=>a+(+c.amount||0),0);const withdrawn=capitalEntries.filter(c=>c.type==='withdrawal').reduce((a,c)=>a+(+c.amount||0),0);const loans=capitalEntries.filter(c=>c.type==='loan').reduce((a,c)=>a+(+c.amount||0),0);const loanRepaid=capitalEntries.filter(c=>c.type==='loan-repay').reduce((a,c)=>a+(+c.amount||0),0);const netProfit=(DATA.dashboard?.netRevenue||0)-DATA.expenses.reduce((a,e)=>a+(+e.Amount||0),0);const totalEquity=invested-withdrawn+loans-loanRepaid+netProfit;if($('cap-kpis'))$('cap-kpis').innerHTML=[['Total Invested',fmt(invested),'green'],['Total Withdrawn',fmt(withdrawn),''],['Net Loans',fmt(loans-loanRepaid),'amber'],['Net Profit',fmt(netProfit),'blue'],['Total Equity',fmt(totalEquity),'purple']].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');if($('cap-table'))$('cap-table').innerHTML=capitalEntries.map(c=>{const isOut=c.type==='withdrawal'||c.type==='loan-repay';return`<tr><td><span class="badge badge-blue">${c.type}</span></td><td>${c.date}</td><td>${c.desc}</td><td class="text-right fw7" style="color:${isOut?'var(--red)':'var(--green)'}">${isOut?'-':'+'} ${fmt(c.amount)}</td><td><button class="btn btn-ghost btn-sm" onclick="editCapital('${c.id}')">✏️</button> <button class="btn btn-ghost btn-sm" onclick="deleteCapital('${c.id}')">🗑️</button></td></tr>`;}).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:16px">No entries</td></tr>';}

function editCapital(id){
  const c=capitalEntries.find(x=>x.id===id);
  if(!c){toast('Not found','error');return;}
  if($('cap-type'))$('cap-type').value=c.type;
  if($('cap-date'))$('cap-date').value=c.date;
  if($('cap-amt'))$('cap-amt').value=c.amount;
  if($('cap-desc'))$('cap-desc').value=c.desc;
  if(!$('cap-editid')){
    const hidden=document.createElement('input');hidden.type='hidden';hidden.id='cap-editid';
    document.querySelector('[onclick="saveCapitalEntry()"]').insertAdjacentElement('beforebegin',hidden);
  }
  $('cap-editid').value=id;
  const btn=document.querySelector('[onclick="saveCapitalEntry()"]');
  if(btn){btn.textContent='💾 Update';btn.scrollIntoView({behavior:'smooth',block:'center'});}
}
async function deleteCapital(id){
  if(!confirm('Delete this capital entry? Its linked Cash Flow entry will also be removed. This cannot be undone.'))return;
  const res=await api(`/api/ho/capital/${encodeURIComponent(id)}`,{method:'DELETE'});
  if(res&&res.ok){toast('✅ Deleted');await loadAll();renderCapital();}
  else toast('❌ Failed','error');
}
function exportCapital(){
  _csvDownload(capitalEntries,[['Type','type'],['Date','date'],['Description','desc'],['Amount','amount']],'capital_entries_'+today()+'.csv');
}

let __faList=[];
async function loadFixedAssets(){
  const res=await api('/api/ho/fixed-assets');
  if(!res||!res.ok){toast('Failed to load fixed assets','error');return;}
  __faList=res.data||[];
  if($('fa-kpis'))$('fa-kpis').innerHTML=[
    ['Total Cost',fmt(res.totalCost||0),''],
    ['Accumulated Depreciation',fmt(res.totalAccumulatedDepreciation||0),'amber'],
    ['Net Book Value',fmt(res.totalBookValue||0),'green'],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');
  if($('fa-table'))$('fa-table').innerHTML=__faList.map(a=>{
    const status=a.disposed?'<span class="badge badge-gray">Disposed</span>':(a.fullyDepreciated?'<span class="badge badge-amber">Fully Depreciated</span>':'<span class="badge badge-green">Active</span>');
    const actions=a.disposed?'—':`<button class="btn btn-ghost btn-sm" onclick="editFixedAsset('${a.id}')">✏️</button> <button class="btn btn-ghost btn-sm" onclick="disposeFixedAssetUI('${a.id}')">📦 Dispose</button> <button class="btn btn-ghost btn-sm" onclick="deleteFixedAssetUI('${a.id}')">🗑️</button>`;
    return `<tr><td class="fw7">${a.name}</td><td>${a.category||''}</td><td>${a.storeId||'HO'}</td><td>${a.purchaseDate}</td><td>${fmt(a.cost)}</td><td>${fmt(a.monthlyDepreciation)}</td><td>${fmt(a.accumulatedDepreciation)}</td><td class="fw7">${fmt(a.bookValue)}</td><td>${status}</td><td data-role="admin,accountant">${actions}</td></tr>`;
  }).join('') || '<tr><td colspan="10" style="text-align:center;color:var(--gray3);padding:16px">No fixed assets yet</td></tr>';
  applyRoleUI();
}

async function saveFixedAsset(){
  const name=$('fa-name').value.trim();
  const cost=parseFloat($('fa-cost').value)||0;
  const life=parseFloat($('fa-life').value)||0;
  if(!name||cost<=0||life<=0){toast('Fill name, cost, and useful life','error');return;}
  const body={
    name, category:$('fa-category').value, storeId:$('fa-store').value||'HO',
    purchaseDate:$('fa-date').value||today(), cost, salvageValue:parseFloat($('fa-salvage').value)||0,
    usefulLifeYears:life, notes:$('fa-notes').value.trim(), recordCashOutflow:$('fa-cash').checked,
  };
  const editId=$('fa-editid')?$('fa-editid').value:'';
  const res=editId
    ? await api(`/api/ho/fixed-assets/${encodeURIComponent(editId)}`,{method:'PUT',body})
    : await api('/api/ho/fixed-assets',{method:'POST',body});
  if(res&&res.ok){
    toast(editId?'✅ Asset updated':'✅ Asset saved');
    ['fa-name','fa-notes'].forEach(id=>{if($(id))$(id).value='';});
    if($('fa-cost'))$('fa-cost').value='';
    if($('fa-salvage'))$('fa-salvage').value='0';
    if($('fa-life'))$('fa-life').value='5';
    if($('fa-editid'))$('fa-editid').value='';
    const btn=document.querySelector('[onclick="saveFixedAsset()"]');
    if(btn)btn.textContent='💾 Save Asset';
    await loadFixedAssets();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}

function editFixedAsset(id){
  const a=__faList.find(x=>x.id===id);
  if(!a){toast('Not found','error');return;}
  if($('fa-name'))$('fa-name').value=a.name;
  if($('fa-category'))$('fa-category').value=a.category||'Other';
  if($('fa-store'))$('fa-store').value=a.storeId||'HO';
  if($('fa-date'))$('fa-date').value=a.purchaseDate;
  if($('fa-cost'))$('fa-cost').value=a.cost;
  if($('fa-life'))$('fa-life').value=a.usefulLifeYears;
  if($('fa-salvage'))$('fa-salvage').value=a.salvageValue||0;
  if($('fa-notes'))$('fa-notes').value=a.notes||'';
  if(!$('fa-editid')){
    const hidden=document.createElement('input');hidden.type='hidden';hidden.id='fa-editid';
    document.querySelector('[onclick="saveFixedAsset()"]').insertAdjacentElement('beforebegin',hidden);
  }
  $('fa-editid').value=id;
  const btn=document.querySelector('[onclick="saveFixedAsset()"]');
  if(btn){btn.textContent='💾 Update Asset';btn.scrollIntoView({behavior:'smooth',block:'center'});}
}

async function disposeFixedAssetUI(assetId){
  if(!confirm('Mark this asset as disposed? Depreciation will stop as of today.'))return;
  const res=await api(`/api/ho/fixed-assets/${encodeURIComponent(assetId)}/dispose`,{method:'POST'});
  if(res&&res.ok){toast('✅ Marked disposed');await loadFixedAssets();}
  else toast('❌ Failed','error');
}
async function deleteFixedAssetUI(assetId){
  if(!confirm('Delete this asset permanently? Its linked Cash Flow entry will also be removed. This cannot be undone — if you just want to retire it, use Dispose instead.'))return;
  const res=await api(`/api/ho/fixed-assets/${encodeURIComponent(assetId)}`,{method:'DELETE'});
  if(res&&res.ok){toast('✅ Deleted');await loadFixedAssets();}
  else toast('❌ Failed','error');
}
function exportFixedAssets(){
  _csvDownload(__faList,[['Name','name'],['Category','category'],['Store','storeId'],['Purchase Date','purchaseDate'],['Cost','cost'],['Salvage Value','salvageValue'],['Useful Life (yrs)','usefulLifeYears'],['Monthly Depreciation','monthlyDepreciation'],['Accumulated Depreciation','accumulatedDepreciation'],['Book Value','bookValue'],['Disposed','disposed']],'fixed_assets_'+today()+'.csv');
}

// ---------- Prepaid / Deferred Expenses ----------
let __ppdList=[];
function populatePrepaidStoreSelect(){
  const el=$('ppd-store');
  if(!el)return;
  const opts='<option value="HO">Head Office</option>'+(DATA.stores||[]).map(s=>`<option value="${s.StoreID||s.store_id}">${s.Name||s.name}</option>`).join('');
  el.innerHTML=opts;
}
async function loadPrepaidExpenses(){
  const res=await api('/api/ho/prepaid-expenses');
  if(!res||!res.ok){toast('Failed to load prepaid expenses','error');return;}
  __ppdList=res.data||[];
  if($('ppd-kpis'))$('ppd-kpis').innerHTML=[
    ['Total Paid',fmt(res.totalAmount||0),''],
    ['Amortized So Far',fmt(res.totalAmortized||0),'amber'],
    ['Remaining Balance',fmt(res.totalRemaining||0),'green'],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');
  if($('ppd-table'))$('ppd-table').innerHTML=__ppdList.map(p=>{
    const status=p.writtenOff?'<span class="badge badge-gray">Written Off</span>':(p.fullyAmortized?'<span class="badge badge-amber">Fully Amortized</span>':'<span class="badge badge-green">Active</span>');
    const actions=p.writtenOff?'—':`<button class="btn btn-ghost btn-sm" onclick="editPrepaidExpense('${p.id}')">✏️</button> <button class="btn btn-ghost btn-sm" onclick="writeOffPrepaidExpense('${p.id}')">📦 Write Off</button> <button class="btn btn-ghost btn-sm" onclick="deletePrepaidExpense('${p.id}')">🗑️</button>`;
    return `<tr><td class="fw7">${p.name}</td><td>${p.category||''}</td><td>${p.storeId||'HO'}</td><td>${p.startDate}</td><td>${fmt(p.totalAmount)}</td><td>${fmt(p.monthlyAmortization)}</td><td>${fmt(p.amortizedToDate)}</td><td class="fw7">${fmt(p.remainingBalance)}</td><td>${status}</td><td data-role="admin,accountant">${actions}</td></tr>`;
  }).join('') || '<tr><td colspan="10" style="text-align:center;color:var(--gray3);padding:16px">No prepaid expenses yet</td></tr>';
  applyRoleUI();
}
async function savePrepaidExpense(){
  const name=$('ppd-name').value.trim();
  const amount=parseFloat($('ppd-amount').value)||0;
  const months=parseInt($('ppd-months').value)||0;
  if(!name||amount<=0||months<=0){toast('Fill name, amount, and coverage months','error');return;}
  const body={
    name, category:$('ppd-category').value, storeId:$('ppd-store').value||'HO',
    startDate:$('ppd-date').value||today(), totalAmount:amount, months,
    notes:$('ppd-notes').value.trim(), recordCashOutflow:$('ppd-cash').checked,
  };
  const editId=$('ppd-editid')?$('ppd-editid').value:'';
  const res=editId
    ? await api(`/api/ho/prepaid-expenses/${encodeURIComponent(editId)}`,{method:'PUT',body})
    : await api('/api/ho/prepaid-expenses',{method:'POST',body});
  if(res&&res.ok){
    toast(editId?'✅ Prepaid expense updated':'✅ Prepaid expense saved');
    ['ppd-name','ppd-notes'].forEach(id=>{if($(id))$(id).value='';});
    if($('ppd-amount'))$('ppd-amount').value='';
    if($('ppd-months'))$('ppd-months').value='12';
    if($('ppd-editid'))$('ppd-editid').value='';
    const btn=document.querySelector('[onclick="savePrepaidExpense()"]');
    if(btn)btn.textContent='💾 Save Prepaid Expense';
    await loadPrepaidExpenses();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function editPrepaidExpense(id){
  const p=__ppdList.find(x=>x.id===id);
  if(!p){toast('Not found','error');return;}
  if($('ppd-name'))$('ppd-name').value=p.name;
  if($('ppd-category'))$('ppd-category').value=p.category||'Other';
  if($('ppd-store'))$('ppd-store').value=p.storeId||'HO';
  if($('ppd-date'))$('ppd-date').value=p.startDate;
  if($('ppd-amount'))$('ppd-amount').value=p.totalAmount;
  if($('ppd-months'))$('ppd-months').value=p.months;
  if($('ppd-notes'))$('ppd-notes').value=p.notes||'';
  if(!$('ppd-editid')){
    const hidden=document.createElement('input');hidden.type='hidden';hidden.id='ppd-editid';
    document.querySelector('[onclick="savePrepaidExpense()"]').insertAdjacentElement('beforebegin',hidden);
  }
  $('ppd-editid').value=id;
  const btn=document.querySelector('[onclick="savePrepaidExpense()"]');
  if(btn){btn.textContent='💾 Update Prepaid Expense';btn.scrollIntoView({behavior:'smooth',block:'center'});}
}
async function writeOffPrepaidExpense(id){
  if(!confirm('Write off this prepaid expense early? Amortization will stop as of today (e.g. contract cancelled or refunded).'))return;
  const res=await api(`/api/ho/prepaid-expenses/${encodeURIComponent(id)}/write-off`,{method:'POST'});
  if(res&&res.ok){toast('✅ Marked written off');await loadPrepaidExpenses();}
  else toast('❌ Failed','error');
}
async function deletePrepaidExpense(id){
  if(!confirm('Delete this prepaid expense permanently? Its linked Cash Flow entry will also be removed. This cannot be undone — if you just want to stop it early, use Write Off instead.'))return;
  const res=await api(`/api/ho/prepaid-expenses/${encodeURIComponent(id)}`,{method:'DELETE'});
  if(res&&res.ok){toast('✅ Deleted');await loadPrepaidExpenses();}
  else toast('❌ Failed','error');
}
function exportPrepaidExpenses(){
  _csvDownload(__ppdList,[['Name','name'],['Category','category'],['Store','storeId'],['Start Date','startDate'],['Total Amount','totalAmount'],['Coverage Months','months'],['Monthly Amortization','monthlyAmortization'],['Amortized To Date','amortizedToDate'],['Remaining Balance','remainingBalance'],['Written Off','writtenOff']],'prepaid_expenses_'+today()+'.csv');
}

// ---------- Employee Advances / Loans ----------
let __advList=[],__advDetailId=null;
function populateAdvStoreSelect(){
  const el=$('adv-store');
  if(!el)return;
  el.innerHTML='<option value="HO">Head Office</option>'+(DATA.stores||[]).map(s=>`<option value="${s.StoreID||s.store_id}">${s.Name||s.name}</option>`).join('');
}
async function loadEmployeeAdvances(){
  const res=await api('/api/ho/employee-advances');
  if(!res||!res.ok){toast('Failed to load employee advances','error');return;}
  __advList=res.data||[];
  if($('adv-kpis'))$('adv-kpis').innerHTML=[
    ['Total Advanced',fmt(res.totalAdvanced||0),''],
    ['Total Repaid',fmt(res.totalRepaid||0),'green'],
    ['Outstanding (Receivable)',fmt(res.totalOutstanding||0),'amber'],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');
  const statusBadge=s=>({outstanding:'badge-amber',paid:'badge-green',written_off:'badge-red'}[s]||'badge-gray');
  const statusLabel=s=>({outstanding:'Outstanding',paid:'Fully Repaid',written_off:'Written Off'}[s]||s);
  if($('adv-table'))$('adv-table').innerHTML=__advList.map(a=>`<tr style="cursor:pointer" onclick="openAdvDetail('${a.id}')">
    <td class="fw7">${a.employeeName}</td><td>${a.storeId}</td><td>${a.date}</td><td>${a.reason||'—'}</td>
    <td>${fmt(a.amount)}</td><td class="text-green">${fmt(a.repaidAmount)}</td>
    <td class="fw7" style="color:${a.balance>0.005&&!a.writtenOff?'var(--red)':'var(--navy)'}">${fmt(a.balance)}</td>
    <td><span class="badge ${statusBadge(a.status)}">${statusLabel(a.status)}</span></td>
    <td data-role="admin,accountant" onclick="event.stopPropagation()"><button class="btn btn-ghost btn-sm" onclick="openAdvDetail('${a.id}')">👁️</button></td>
  </tr>`).join('')||'<tr><td colspan="9" style="text-align:center;color:var(--gray3);padding:16px">No advances yet</td></tr>';
}
async function saveEmployeeAdvance(){
  const name=($('adv-name')&&$('adv-name').value.trim())||'';
  const amount=+(($('adv-amount')&&$('adv-amount').value)||0);
  if(!name){toast('Employee name required','error');return;}
  if(!amount||amount<=0){toast('Amount must be greater than 0','error');return;}
  const body={
    employeeName:name, storeId:($('adv-store')&&$('adv-store').value)||'HO',
    date:($('adv-date')&&$('adv-date').value)||today(), amount,
    reason:($('adv-reason')&&$('adv-reason').value)||'', notes:($('adv-notes')&&$('adv-notes').value)||'',
    recordCashOutflow:$('adv-cash')?$('adv-cash').checked:true,
  };
  const res=await api('/api/ho/employee-advances',{method:'POST',body});
  if(res&&res.ok){
    toast('✅ Advance recorded');
    ['adv-name','adv-amount','adv-reason','adv-notes'].forEach(id=>{if($(id))$(id).value='';});
    await loadAll();loadEmployeeAdvances();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function openAdvDetail(id){
  const a=__advList.find(x=>x.id===id);
  if(!a)return;
  __advDetailId=id;
  if($('adv-detail-title'))$('adv-detail-title').textContent='🤲 '+a.employeeName;
  if($('adv-detail-kpis'))$('adv-detail-kpis').innerHTML=[
    ['Advanced',fmt(a.amount),''],['Repaid',fmt(a.repaidAmount),'green'],['Balance',fmt(a.balance),a.balance>0.005?'amber':'green'],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value" style="font-size:16px">${v}</div></div>`).join('');
  const res=await api(`/api/ho/employee-advances/${encodeURIComponent(id)}/repayments`);
  const reps=(res&&res.data)||[];
  if($('adv-repay-history'))$('adv-repay-history').innerHTML=reps.map(r=>`<tr><td>${r.date}</td><td class="fw7">${fmt(r.amount)}</td><td><span class="badge badge-blue">${r.method}</span></td><td style="font-size:11px">${r.notes||'—'}</td></tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:var(--gray3);padding:12px">No repayments yet</td></tr>';
  const closed=a.writtenOff||a.balance<=0.005;
  if($('adv-repay-form'))$('adv-repay-form').style.display=closed?'none':'grid';
  if($('adv-writeoff-btn'))$('adv-writeoff-btn').style.display=closed?'none':'inline-flex';
  $('adv-detail-modal').style.display='flex';
}
function closeAdvDetail(){$('adv-detail-modal').style.display='none';__advDetailId=null;}
async function recordAdvRepayment(){
  if(!__advDetailId)return;
  const amount=+(($('adv-repay-amt')&&$('adv-repay-amt').value)||0);
  if(!amount||amount<=0){toast('Enter a valid amount','error');return;}
  const body={amount,method:($('adv-repay-method')&&$('adv-repay-method').value)||'Cash',date:today()};
  const res=await api(`/api/ho/employee-advances/${encodeURIComponent(__advDetailId)}/repay`,{method:'POST',body});
  if(res&&res.ok){
    toast('✅ Repayment recorded — new balance '+fmt(res.newBalance));
    if($('adv-repay-amt'))$('adv-repay-amt').value='';
    await loadAll();await loadEmployeeAdvances();openAdvDetail(__advDetailId);
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function writeOffAdvance(){
  if(!__advDetailId)return;
  if(!confirm('Write off the remaining balance of this advance? This books it as a Bad Debt expense on the P&L and cannot be undone.'))return;
  const res=await api(`/api/ho/employee-advances/${encodeURIComponent(__advDetailId)}/write-off`,{method:'POST'});
  if(res&&res.ok){
    toast(`📦 Written off ${fmt(res.writtenOffAmount)}`);
    closeAdvDetail();await loadAll();loadEmployeeAdvances();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function deleteAdvance(){
  if(!__advDetailId)return;
  if(!confirm('Delete this advance and all its repayment history? This cannot be undone.'))return;
  const res=await api(`/api/ho/employee-advances/${encodeURIComponent(__advDetailId)}`,{method:'DELETE'});
  if(res&&res.ok){
    toast('🗑️ Deleted');closeAdvDetail();await loadAll();loadEmployeeAdvances();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function exportEmployeeAdvances(){
  _csvDownload(__advList,[['Employee','employeeName'],['Store','storeId'],['Date','date'],['Reason','reason'],['Amount','amount'],['Repaid','repaidAmount'],['Balance','balance'],['Status','status']],'employee_advances_'+today()+'.csv');
}

// ---------- Accrued Expenses ----------
let __acrList=[];
function populateAccStoreSelect(){
  const el=$('acr-store');
  if(!el)return;
  el.innerHTML='<option value="HO">Head Office</option>'+(DATA.stores||[]).map(s=>`<option value="${s.StoreID||s.store_id}">${s.Name||s.name}</option>`).join('');
}
async function loadAccruedExpenses(){
  const res=await api('/api/ho/accrued-expenses');
  if(!res||!res.ok){toast('Failed to load accrued expenses','error');return;}
  __acrList=res.data||[];
  if($('acr-kpis'))$('acr-kpis').innerHTML=[
    ['Unsettled (Payable)',fmt(res.totalUnsettled||0),'amber'],
    ['Total Entries',__acrList.length,''],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');
  if($('acr-table'))$('acr-table').innerHTML=__acrList.map(a=>`<tr>
    <td class="fw7">${a.name}</td><td>${a.category}</td><td>${a.storeId}</td><td>${a.date}</td><td>${fmt(a.amount)}</td>
    <td><span class="badge ${a.settled?'badge-green':'badge-amber'}">${a.settled?'Paid':'Unpaid'}</span></td>
    <td data-role="admin,accountant">${a.settled?'—':`<button class="btn btn-green btn-sm" onclick="settleAccrued('${a.id}')">✅ Mark Paid</button> <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteAccrued('${a.id}')">🗑️</button>`}</td>
  </tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:16px">No accrued expenses yet</td></tr>';
}
async function saveAccruedExpense(){
  const name=($('acr-name')&&$('acr-name').value.trim())||'';
  const amount=+(($('acr-amount')&&$('acr-amount').value)||0);
  if(!name){toast('Name required','error');return;}
  if(!amount||amount<=0){toast('Amount must be greater than 0','error');return;}
  const body={
    name, category:($('acr-category')&&$('acr-category').value)||'Other', storeId:($('acr-store')&&$('acr-store').value)||'HO',
    date:($('acr-date')&&$('acr-date').value)||today(), amount, notes:($('acr-notes')&&$('acr-notes').value)||'',
  };
  const res=await api('/api/ho/accrued-expenses',{method:'POST',body});
  if(res&&res.ok){
    toast('✅ Accrued expense recorded');
    ['acr-name','acr-amount','acr-notes'].forEach(id=>{if($(id))$(id).value='';});
    await loadAll();loadAccruedExpenses();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function settleAccrued(id){
  if(!confirm('Mark this as paid? This records the real cash outflow now.'))return;
  const res=await api(`/api/ho/accrued-expenses/${encodeURIComponent(id)}/settle`,{method:'POST'});
  if(res&&res.ok){toast('✅ Marked as paid');await loadAll();loadAccruedExpenses();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function deleteAccrued(id){
  if(!confirm('Delete this accrued expense? This also removes its P&L expense entry.'))return;
  const res=await api(`/api/ho/accrued-expenses/${encodeURIComponent(id)}`,{method:'DELETE'});
  if(res&&res.ok){toast('🗑️ Deleted');await loadAll();loadAccruedExpenses();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function exportAccruedExpenses(){
  _csvDownload(__acrList,[['Name','name'],['Category','category'],['Store','storeId'],['Date','date'],['Amount','amount'],['Settled','settled']],'accrued_expenses_'+today()+'.csv');
}

// ---------- Cashier Shifts ----------
let __shiftList=[];
async function loadShifts(){
  const status=$('shift-status-filter')?$('shift-status-filter').value:'';
  const res=await api('/api/shifts'+(status?('?status='+status):''));
  if(!res||!res.ok){toast('Failed to load shifts','error');return;}
  __shiftList=res.data||[];
  const openCount=__shiftList.filter(s=>s.status==='open').length;
  const totalVariance=__shiftList.filter(s=>s.status==='closed').reduce((a,s)=>a+Math.abs(s.variance||0),0);
  const shortages=__shiftList.filter(s=>s.status==='closed'&&(s.variance||0)<-0.01).length;
  if($('shift-kpis'))$('shift-kpis').innerHTML=[
    ['Open Shifts',openCount,'amber'],
    ['Total Shifts',__shiftList.length,''],
    ['Shifts with Shortage',shortages,shortages>0?'red':'green'],
    ['Total Variance (abs)',fmt(totalVariance),''],
  ].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');
  if($('shift-table'))$('shift-table').innerHTML=__shiftList.map(s=>{
    const vColor=s.variance==null?'':(Math.abs(s.variance)<0.01?'var(--green)':s.variance<0?'var(--red)':'var(--amber)');
    return `<tr><td class="fw7">${s.cashierName}</td><td>${s.storeName}</td><td style="font-size:11px">${(s.openedAt||'').slice(0,16).replace('T',' ')}</td><td style="font-size:11px">${s.closedAt?(s.closedAt.slice(0,16).replace('T',' ')):'—'}</td><td>${fmt(s.openingCash)}</td><td>${fmt(s.cashSales)}</td><td>${s.status==='closed'?fmt(s.expectedCash):'—'}</td><td>${s.countedCash!=null?fmt(s.countedCash):'—'}</td><td class="fw7" style="color:${vColor}">${s.variance!=null?fmt(s.variance):'—'}</td><td><span class="badge ${s.status==='open'?'badge-amber':'badge-green'}">${s.status}</span></td></tr>`;
  }).join('')||'<tr><td colspan="10" style="text-align:center;color:var(--gray3);padding:16px">No shifts yet</td></tr>';
}
function exportShifts(){
  _csvDownload(__shiftList,[['Cashier','cashierName'],['Store','storeName'],['Opened','openedAt'],['Closed','closedAt'],['Opening Cash','openingCash'],['Cash Sales','cashSales'],['Cash Refunds','cashRefunds'],['Additions','cashAdditions'],['Withdrawals','cashWithdrawals'],['Expected','expectedCash'],['Counted','countedCash'],['Variance','variance'],['Status','status']],'cashier_shifts_'+today()+'.csv');
}

// ---------- Stock Count / Physical Adjustments ----------
let __scList=[],__scCurrent=null;
function populateSCStoreSelect(){
  const opts=(DATA.stores||[]).map(s=>`<option value="${s.StoreID||s.store_id}">${s.Name||s.name}</option>`).join('');
  if($('sc-store'))$('sc-store').innerHTML=opts;
  if($('qa-store'))$('qa-store').innerHTML=opts;
}
async function loadStockCounts(){
  const res=await api('/api/stock-counts');
  if(!res||!res.ok){toast('Failed to load counts','error');return;}
  __scList=res.data||[];
  if($('sc-list'))$('sc-list').innerHTML=__scList.map(c=>`<tr><td class="fw7" style="font-size:11px">${c.id}</td><td>${c.storeName}</td><td>${c.date}</td><td>${c.countedLines}/${c.totalLines}</td><td>${c.varianceLines>0?`<span class="badge badge-amber">${c.varianceLines}</span>`:'—'}</td><td><span class="badge ${c.status==='approved'?'badge-green':'badge-amber'}">${c.status}</span></td><td>
    <button class="btn btn-ghost btn-sm" id="sc-eye-${c.id}" onclick="toggleStockCount('${c.id}')">👁️</button>
    ${c.status==='draft'?`<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteStockCount('${c.id}')">🗑️</button>`:''}
  </td></tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:14px">No counts yet</td></tr>';
}
async function toggleStockCount(id){
  const card=$('sc-detail-card');
  if(__scCurrent&&__scCurrent.id===id&&card.style.display==='block'){
    card.style.display='none';
    __scCurrent=null;
    return;
  }
  openStockCount(id);
}
async function deleteStockCount(id){
  if(!confirm(`Delete count ${id}? This cannot be undone.`))return;
  const res=await api(`/api/stock-counts/${encodeURIComponent(id)}`,{method:'DELETE'});
  if(res&&res.ok){
    toast('🗑️ Deleted');
    if(__scCurrent&&__scCurrent.id===id){$('sc-detail-card').style.display='none';__scCurrent=null;}
    loadStockCounts();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function startStockCount(){
  const storeId=$('sc-store')?$('sc-store').value:'';
  const storeName=$('sc-store')?$('sc-store').options[$('sc-store').selectedIndex]?.text:'';
  if(!storeId){toast('Select a store','error');return;}
  const res=await api('/api/stock-counts/start',{method:'POST',body:{storeId,storeName}});
  if(res&&res.ok){
    toast(`✅ Count started — ${res.lineCount} item(s) snapshotted`);
    await loadStockCounts();
    openStockCount(res.id);
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function openStockCount(id){
  const res=await api(`/api/stock-counts/${encodeURIComponent(id)}`);
  if(!res||!res.ok){toast('Failed to load','error');return;}
  __scCurrent=res;
  __scCategoriesDirty=false;
  if($('sc-detail-title'))$('sc-detail-title').textContent=`📋 ${res.id} — ${res.storeName} (${res.status})`;
  if($('sc-upload-section'))$('sc-upload-section').style.display=res.status==='draft'?'block':'none';
  if(!__scEmployees[res.storeId]){
    const ur=await api('/api/auth/users');
    const all=(ur&&(ur.data||ur))||[];
    __scEmployees[res.storeId]=Array.isArray(all)?all.filter(u=>u.store_id===res.storeId&&u.active!==false):[];
  }
  renderVarianceTable(res.lines||[]);
  $('sc-detail-card').style.display='block';
  $('sc-detail-card').scrollIntoView({behavior:'smooth',block:'start'});
}
let __scEmployees={};
let __scCategoriesDirty=false;
let __scSort={key:null,dir:1};
function sortSC(key){
  if(__scSort.key===key)__scSort.dir*=-1;
  else{__scSort.key=key;__scSort.dir=1;}
  renderVarianceTable(__scCurrent.lines);
}
function renderVarianceTable(lines){
  const locked=!__scCurrent||__scCurrent.status!=='draft';
  const emps=(__scCurrent&&__scEmployees[__scCurrent.storeId])||[];
  const filterText=($('sc-filter')&&$('sc-filter').value||'').toLowerCase();
  const filterStatus=$('sc-filter-status')?$('sc-filter-status').value:'';

  let rows=lines.map(l=>({
    ...l,
    value:round2((l.variance||0)*(l.cost||0)),
    absShortageValue:l.variance!=null&&l.variance<0?round2(Math.abs(l.variance)*(l.cost||0)):0,
  }));

  if(filterText)rows=rows.filter(l=>l.barcode.toLowerCase().includes(filterText)||l.name.toLowerCase().includes(filterText));
  if(filterStatus==='shortage')rows=rows.filter(l=>l.variance!=null&&l.variance<0);
  else if(filterStatus==='overage')rows=rows.filter(l=>l.variance!=null&&l.variance>0);
  else if(filterStatus==='unscanned')rows=rows.filter(l=>l.physicalQty==null);

  if(__scSort.key){
    const k=__scSort.key,d=__scSort.dir;
    rows.sort((a,b)=>{
      const av=a[k],bv=b[k];
      if(av==null&&bv==null)return 0;
      if(av==null)return 1;
      if(bv==null)return -1;
      if(typeof av==='string')return av.localeCompare(bv)*d;
      return (av-bv)*d;
    });
  }

  let totalShortageValue=0;
  const rowsHtml=rows.map((l,i)=>{
    const isNew=l.systemQty===0&&l.physicalQty>0&&l.variance===l.physicalQty;
    const vColor=l.variance==null?'var(--gray4)':l.variance>0?'var(--green)':l.variance<0?'var(--red)':'var(--gray4)';
    const isShortage=l.variance!=null&&l.variance<0;
    if(isShortage)totalShortageValue+=l.absShortageValue;
    let categoryCell='—';
    const allocSummary=(l.allocations&&l.allocations.length)?l.allocations.map(a=>`${(emps.find(e=>e.user_id===a.employeeUserId)?.name)||a.employeeUserId} ${a.percent}%`).join(', '):'';
    if(isShortage&&!locked){
      categoryCell=`<select class="form-input" style="padding:3px 6px;font-size:10.5px" id="sc-cat-${i}" data-barcode="${l.barcode}" onchange="__scCategoriesDirty=true">
        <option value="shrinkage" ${l.category==='shrinkage'?'selected':''}>Shrinkage (company loss)</option>
        <option value="split" ${l.category==='split'?'selected':''}>Split (multi-employee %)</option>
        <option value="investigation" ${l.category==='investigation'?'selected':''}>Under Investigation</option>
      </select>
      <button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px;margin-top:3px" onclick="openAllocModal('${l.barcode}')">👥 ${allocSummary?'Edit Split: '+allocSummary:'Configure Split'}</button>`;
    } else if(isShortage){
      categoryCell=`${l.category==='split'?('Split — '+allocSummary):l.category} <button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px" onclick="openReclassify('${l.barcode}')">🔄 Reclassify</button>`;
    }
    return `<tr><td style="font-family:monospace;font-size:10px">${l.barcode}</td><td>${l.name}${isNew?' <span class="badge badge-blue">New</span>':''}</td><td>${l.systemQty}</td><td>${l.physicalQty!=null?l.physicalQty:'<span style="color:var(--gray3)">not scanned</span>'}</td><td class="fw7" style="color:${vColor}">${l.variance!=null?(l.variance>0?'+':'')+l.variance:'—'}</td><td>${fmt(l.cost||0)}</td><td class="fw7" style="color:${vColor}">${l.variance?fmt(Math.abs(l.value)):'—'}</td><td>${categoryCell}</td></tr>`;
  }).join('');
  if($('sc-lines-table'))$('sc-lines-table').innerHTML=rowsHtml||'<tr><td colspan="8" style="text-align:center;color:var(--gray3);padding:14px">No items match</td></tr>';
  const summaryEl=$('sc-shortage-summary');
  if(summaryEl)summaryEl.textContent=totalShortageValue>0?`⚠️ Total shortage value: ${fmt(totalShortageValue)}`:'';
}
function round2(n){return Math.round(n*100)/100;}
async function openReclassify(barcode){
  if(!__scCurrent)return;
  const emps=__scEmployees[__scCurrent.storeId]||[];
  const empList=emps.map((e,i)=>`${i+1}. ${e.name}`).join('\n');
  const choice=prompt(`Reclassify this shortage to:\n1 = Shrinkage (company loss)\n2 = Split (one or more employees, custom %)\n3 = Under Investigation\n\nType 1, 2, or 3:`);
  if(!choice)return;
  let category=null;
  const allocations=[];
  if(choice.trim()==='1')category='shrinkage';
  else if(choice.trim()==='2')category='split';
  else if(choice.trim()==='3')category='investigation';
  else{toast('Invalid choice','error');return;}
  if(category==='split'){
    if(!emps.length){toast('No employees found for this store','error');return;}
    let addMore=true;
    while(addMore){
      const empChoice=prompt(`Select employee (${allocations.length} added so far):\n${empList}\n\nType the number:`);
      if(!empChoice)break;
      const idx=parseInt(empChoice,10)-1;
      if(isNaN(idx)||!emps[idx]){toast('Invalid employee selection','error');return;}
      const pct=prompt(`What % of the shortage value is ${emps[idx].name} responsible for?`);
      const p=+pct;
      if(!p||p<=0){toast('Invalid percentage','error');return;}
      const month=prompt('Deduct from which payroll month? (YYYY-MM, optional)','')||'';
      allocations.push({employeeUserId:emps[idx].user_id,percent:p,deductionMonth:month});
      addMore=confirm('Add another employee to this split?');
    }
    if(!allocations.length){toast('At least one employee is required for Split','error');return;}
  }
  const res=await api(`/api/stock-counts/${encodeURIComponent(__scCurrent.id)}/lines/${encodeURIComponent(barcode)}/reclassify`,{method:'POST',body:{category,allocations}});
  if(res&&res.ok){toast('✅ Reclassified');await loadAll();openStockCount(__scCurrent.id);}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function toggleEmpSelect(i){
  const cat=$('sc-cat-'+i)?.value;
  const empSel=$('sc-emp-'+i);
  if(empSel)empSel.style.display=(cat==='employee_fault'||cat==='store_staff')?'block':'none';
}
let __allocBarcode=null,__allocRows=[];
function openAllocModal(barcode){
  if(!__scCurrent)return;
  const line=(__scCurrent.lines||[]).find(l=>l.barcode===barcode);
  if(!line)return;
  __allocBarcode=barcode;
  __allocRows=(line.allocations&&line.allocations.length)?line.allocations.map(a=>({...a})):[{employeeUserId:'',percent:'',deductionMonth:''}];
  if($('sc-alloc-title'))$('sc-alloc-title').textContent=`👥 Split — ${line.name} (${line.barcode})`;
  renderAllocRows();
  $('sc-alloc-modal').style.display='flex';
}
function closeAllocModal(){$('sc-alloc-modal').style.display='none';__allocBarcode=null;}
function renderAllocRows(){
  const emps=(__scCurrent&&__scEmployees[__scCurrent.storeId])||[];
  const empOptions=e=>emps.map(emp=>`<option value="${emp.user_id}" ${e.employeeUserId===emp.user_id?'selected':''}>${emp.name}</option>`).join('');
  if($('sc-alloc-rows'))$('sc-alloc-rows').innerHTML=__allocRows.map((r,i)=>`
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <select class="form-input" style="flex:2;padding:5px 7px" onchange="__allocRows[${i}].employeeUserId=this.value"><option value="">Select employee…</option>${empOptions(r)}</select>
      <input class="form-input" type="number" style="width:70px;padding:5px 7px" placeholder="%" value="${r.percent}" oninput="__allocRows[${i}].percent=+this.value;renderAllocTotal()">
      <input class="form-input" type="month" style="width:130px;padding:5px 7px" value="${r.deductionMonth||''}" onchange="__allocRows[${i}].deductionMonth=this.value" title="Which payroll month to deduct from">
      <button class="btn btn-ghost btn-sm" onclick="removeAllocRow(${i})">✕</button>
    </div>`).join('');
  renderAllocTotal();
}
function renderAllocTotal(){
  const total=__allocRows.reduce((a,r)=>a+(+r.percent||0),0);
  const companyPct=Math.max(0,100-total);
  if($('sc-alloc-total')){
    $('sc-alloc-total').style.color=total>100?'var(--red)':'var(--navy)';
    $('sc-alloc-total').textContent=total>100?`⚠️ ${total}% allocated — exceeds 100%, reduce a row`:`Employees: ${total}% · Company share: ${companyPct}%`;
  }
}
function addAllocRow(){__allocRows.push({employeeUserId:'',percent:'',deductionMonth:''});renderAllocRows();}
function removeAllocRow(i){__allocRows.splice(i,1);if(!__allocRows.length)__allocRows.push({employeeUserId:'',percent:'',deductionMonth:''});renderAllocRows();}
async function saveAllocations(){
  if(!__scCurrent||!__allocBarcode)return;
  const valid=__allocRows.filter(r=>r.employeeUserId&&+r.percent>0).map(r=>({employeeUserId:r.employeeUserId,percent:+r.percent,deductionMonth:r.deductionMonth||''}));
  const total=valid.reduce((a,r)=>a+r.percent,0);
  if(total>100.001){toast('❌ Percentages exceed 100% — reduce a row','error');return;}
  const res=await api(`/api/stock-counts/${encodeURIComponent(__scCurrent.id)}/lines/${encodeURIComponent(__allocBarcode)}/allocations`,{method:'PUT',body:{allocations:valid}});
  if(res&&res.ok){
    toast(`✅ Split saved — company share ${res.companyPercent}%`);
    closeAllocModal();
    __scCategoriesDirty=false;
    openStockCount(__scCurrent.id);
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function saveLineCategories(){
  if(!__scCurrent)return;
  const selects=document.querySelectorAll('[id^="sc-cat-"]');
  const lines=[];
  for(const sel of selects){
    const category=sel.value;
    if(category==='split'){
      const line=(__scCurrent.lines||[]).find(l=>l.barcode===sel.dataset.barcode);
      if(!line||!line.allocations||!line.allocations.length){
        toast(`❌ "${sel.dataset.barcode}" is set to Split but has no employees configured — click "Configure Split" first`,'error');
        return;
      }
      continue; // already saved via its own allocations endpoint
    }
    lines.push({barcode:sel.dataset.barcode,category});
  }
  const res=await api(`/api/stock-counts/${encodeURIComponent(__scCurrent.id)}/lines`,{method:'PUT',body:{lines}});
  if(res&&res.ok){toast(`✅ ${res.updated} categories saved`);__scCategoriesDirty=false;openStockCount(__scCurrent.id);}
  else toast('❌ Failed to save categories','error');
}
function downloadCountTemplate(){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['Barcode,Qty\n8001000000001,1\n8001000000001,1\n'],{type:'text/csv'}));
  a.download='stock_take_scan_template.csv';a.click();
}
async function uploadCountFile(file){
  if(!file||!__scCurrent)return;
  const rows=await readExcel(file);
  const lines=rows.map(r=>({barcode:cleanId(r.Barcode||r.barcode),qty:+(r.Qty||r.qty||1)})).filter(l=>l.barcode);
  if(!lines.length){toast('No valid barcode rows found in file','error');return;}
  const res=await api(`/api/stock-counts/${encodeURIComponent(__scCurrent.id)}/upload`,{method:'POST',body:{lines}});
  if(res&&res.ok){
    toast(`✅ ${res.totalScanned} unique barcode(s) processed — ${res.matched} matched, ${res.newItemsFound} new item(s) found`);
    openStockCount(__scCurrent.id);loadStockCounts();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Upload failed'),'error');
}
function exportVarianceReport(){
  if(!__scCurrent)return;
  _csvDownload(__scCurrent.lines||[],[['Barcode','barcode'],['Product','name'],['System Qty','systemQty'],['Physical Qty','physicalQty'],['Variance','variance']],`variance_report_${__scCurrent.id}_${today()}.csv`);
}
function approveStockCount(){
  if(!__scCurrent)return;
  if(__scCategoriesDirty){
    toast('❌ Save categories first — you changed a category/employee selection that hasn\'t been saved yet.','error');
    return;
  }
  const emps=__scEmployees[__scCurrent.storeId]||[];
  const shortageLines=(__scCurrent.lines||[]).filter(l=>l.variance!=null&&l.variance<0);
  const totalValue=shortageLines.reduce((a,l)=>a+Math.abs(l.variance)*(l.cost||0),0);
  if($('sc-approve-total'))$('sc-approve-total').textContent=shortageLines.length?`⚠️ ${shortageLines.length} shortage line(s) — total value ${fmt(totalValue)}`:'✅ No shortages on this count.';
  if($('sc-approve-table'))$('sc-approve-table').innerHTML=shortageLines.map(l=>{
    const allocSummary=(l.allocations&&l.allocations.length)?l.allocations.map(a=>`${(emps.find(e=>e.user_id===a.employeeUserId)?.name)||a.employeeUserId} ${a.percent}%`).join(', '):'';
    const catLabel=l.category==='split'?`Split — ${allocSummary}`:l.category;
    return `<tr><td style="font-family:monospace;font-size:10px">${l.barcode}</td><td>${l.name}</td><td class="fw7" style="color:var(--red)">${l.variance}</td><td>${fmt(Math.abs(l.variance)*(l.cost||0))}</td><td>${catLabel}</td></tr>`;
  }).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:14px">No shortages — nothing to classify</td></tr>';
  $('sc-approve-modal').style.display='flex';
}
function closeApproveModal(){$('sc-approve-modal').style.display='none';}
async function confirmApproveFlow(){
  if(!__scCurrent)return;
  const res=await api(`/api/stock-counts/${encodeURIComponent(__scCurrent.id)}/approve`,{method:'POST'});
  if(res&&res.ok){
    toast(`✅ Approved — ${res.linesAdjusted} item(s) adjusted`);
    closeApproveModal();
    await loadAll();openStockCount(__scCurrent.id);loadStockCounts();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function submitQuickAdjust(){
  const barcode=($('qa-barcode')&&$('qa-barcode').value.trim())||'';
  const storeId=$('qa-store')?$('qa-store').value:'';
  const storeName=$('qa-store')?$('qa-store').options[$('qa-store').selectedIndex]?.text:'';
  const newQty=+(($('qa-qty')&&$('qa-qty').value)||'');
  const reason=($('qa-reason')&&$('qa-reason').value.trim())||'';
  if(!barcode||!storeId||isNaN(newQty)||!reason){toast('Barcode, store, quantity, and reason are all required','error');return;}
  const res=await api('/api/stock-counts/quick-adjust',{method:'POST',body:{barcode,storeId,storeName,newQty,reason}});
  if(res&&res.ok){
    toast(res.status==='no_change'?'No change — quantity already matches':'✅ Adjustment applied — new qty '+res.newQty);
    ['qa-barcode','qa-qty','qa-reason'].forEach(id=>{if($(id))$(id).value='';});
    await loadAll();
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}

// ---------- Payroll ----------
let __prList=[],__prCurrent=null;
function populatePRStoreSelect(){
  if($('pr-store'))$('pr-store').innerHTML='<option value="HO">Head Office</option>'+(DATA.stores||[]).map(s=>`<option value="${s.StoreID||s.store_id}">${s.Name||s.name}</option>`).join('');
  if($('pr-month')&&!$('pr-month').value)$('pr-month').value=today().slice(0,7);
}
async function loadPayrollRuns(){
  const res=await api('/api/payroll/runs');
  if(!res||!res.ok)return;
  __prList=res.data||[];
  if($('pr-list'))$('pr-list').innerHTML=__prList.map(r=>`<tr><td class="fw7">${r.month}</td><td>${r.storeName}</td><td>${r.employeeCount||0} · ${fmt(r.totalNetPay||0)}</td><td><span class="badge ${r.status==='finalized'?'badge-green':'badge-amber'}">${r.status}</span></td><td><button class="btn btn-ghost btn-sm" onclick="togglePayrollRun('${r.id}')">👁️</button></td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:14px">No payroll runs yet</td></tr>';
}
async function startPayrollRun(){
  const storeId=$('pr-store')?$('pr-store').value:'';
  const storeName=$('pr-store')?$('pr-store').options[$('pr-store').selectedIndex]?.text:'';
  const month=$('pr-month')?$('pr-month').value:'';
  if(!storeId||!month){toast('Select a store and month','error');return;}
  const res=await api('/api/payroll/runs',{method:'POST',body:{storeId,storeName,month}});
  if(res&&res.ok){await loadPayrollRuns();openPayrollRun(res.id);}
  else toast('❌ Failed','error');
}
async function togglePayrollRun(id){
  const card=$('pr-detail-card');
  if(__prCurrent&&__prCurrent.id===id&&card.style.display==='block'){
    card.style.display='none';
    __prCurrent=null;
    return;
  }
  openPayrollRun(id);
}
async function openPayrollRun(id){
  const res=await api(`/api/payroll/runs/${encodeURIComponent(id)}`);
  if(!res||!res.ok){toast('Failed to load','error');return;}
  __prCurrent=res;
  if($('pr-detail-title'))$('pr-detail-title').textContent=`💵 ${res.storeName} — ${res.month} (${res.status})`;
  const locked=res.status!=='draft';
  if($('pr-entries-table'))$('pr-entries-table').innerHTML=(res.entries||[]).map((e,i)=>{
    const advDed=e.advanceDeduction||e.suggestedDeduction||0;
    return `<tr>
    <td style="font-family:monospace;font-size:10px">${e.employeeCode||'—'}</td>
    <td class="fw7">${e.employeeName}</td><td>${e.role}</td>
    <td style="font-size:10.5px">${e.attendanceRatio!=null?`${e.attendancePresent}/${e.attendanceMarkedDays} (${(e.attendanceRatio*100).toFixed(0)}%)${e.lateCount>0?`<br><span style="color:var(--amber)">${e.lateCount} late</span>`:''}`:'<span style="color:var(--gray3)">not marked</span>'}</td>
    <td><input class="form-input" type="number" style="width:85px;padding:4px 7px" id="pr-base-${i}" data-emp="${e.employeeUserId}" value="${e.baseSalary}" oninput="recalcPayrollRow(${i})" ${locked?'disabled':''}></td>
    <td><input class="form-input" type="number" style="width:80px;padding:4px 7px" id="pr-allow-${i}" value="${e.allowances}" oninput="recalcPayrollRow(${i})" ${locked?'disabled':''}></td>
    <td class="fw7" id="pr-gross-${i}">${fmt(e.grossPay)}</td>
    <td style="color:${e.outstandingAdvances>0?'var(--red)':'var(--gray4)'}">${fmt(e.outstandingAdvances)}</td>
    <td><input class="form-input" type="number" style="width:85px;padding:4px 7px" id="pr-adv-${i}" value="${advDed}" oninput="recalcPayrollRow(${i})" ${locked?'disabled':''}></td>
    <td><input class="form-input" type="number" style="width:80px;padding:4px 7px" id="pr-other-${i}" value="${e.otherDeduction}" oninput="recalcPayrollRow(${i})" ${locked?'disabled':''}> <input class="form-input" style="width:120px;padding:4px 7px;margin-top:3px" id="pr-othernote-${i}" placeholder="reason (required if >0)" value="${e.otherDeductionNote||''}" ${locked?'disabled':''}></td>
    <td class="fw7" id="pr-totded-${i}">${fmt(e.totalDeductions)}</td>
    <td class="fw7" id="pr-net-${i}" style="color:var(--green)">${fmt(e.netPay)}</td>
    <td><select class="form-input" style="padding:4px 7px" id="pr-method-${i}" ${locked?'disabled':''}><option ${e.paymentMethod==='Cash'?'selected':''}>Cash</option><option ${e.paymentMethod==='Bank Transfer'?'selected':''}>Bank Transfer</option></select></td>
    <td>${e.saved?`<button class="btn btn-ghost btn-sm" onclick="printPayslip(${i})">🖨️</button>`:''}</td>
  </tr>`;
  }).join('')||'<tr><td colspan="14" style="text-align:center;color:var(--gray3);padding:14px">No employees at this store</td></tr>';
  renderPayrollTotals(res.totals);
  $('pr-detail-card').style.display='block';
  $('pr-detail-card').scrollIntoView({behavior:'smooth',block:'start'});
}
function recalcPayrollRow(i){
  const base=+(($('pr-base-'+i)&&$('pr-base-'+i).value)||0);
  const allow=+(($('pr-allow-'+i)&&$('pr-allow-'+i).value)||0);
  const adv=+(($('pr-adv-'+i)&&$('pr-adv-'+i).value)||0);
  const other=+(($('pr-other-'+i)&&$('pr-other-'+i).value)||0);
  const gross=base+allow, totDed=adv+other, net=gross-totDed;
  if($('pr-gross-'+i))$('pr-gross-'+i).textContent=fmt(gross);
  if($('pr-totded-'+i))$('pr-totded-'+i).textContent=fmt(totDed);
  if($('pr-net-'+i))$('pr-net-'+i).textContent=fmt(net);
}
function renderPayrollTotals(t){
  if(!t)return;
  if($('pr-totals-row'))$('pr-totals-row').innerHTML=`<tr style="font-weight:800;background:var(--gray0)">
    <td colspan="4">TOTAL</td><td>${fmt(t.baseSalary)}</td><td>${fmt(t.allowances)}</td><td>${fmt(t.grossPay)}</td><td></td>
    <td>${fmt(t.advanceDeduction)}</td><td>${fmt(t.otherDeduction)}</td><td>${fmt(t.totalDeductions)}</td><td style="color:var(--green)">${fmt(t.netPay)}</td><td colspan="2"></td>
  </tr>`;
}
async function savePayrollEntries(){
  if(!__prCurrent)return;
  const baseInputs=document.querySelectorAll('[id^="pr-base-"]');
  const entries=[];
  for(const inp of baseInputs){
    const i=inp.id.split('-')[2];
    const otherDed=+(($('pr-other-'+i)&&$('pr-other-'+i).value)||0);
    const otherNote=($('pr-othernote-'+i)&&$('pr-othernote-'+i).value.trim())||'';
    if(otherDed>0&&!otherNote){toast(`❌ A note is required for ${__prCurrent.entries[i].employeeName}'s Other Deduction`,'error');return;}
    entries.push({
      employeeUserId:inp.dataset.emp,
      baseSalary:+inp.value||0,
      allowances:+(($('pr-allow-'+i)&&$('pr-allow-'+i).value)||0),
      advanceDeduction:+(($('pr-adv-'+i)&&$('pr-adv-'+i).value)||0),
      otherDeduction:otherDed,
      otherDeductionNote:otherNote,
      paymentMethod:($('pr-method-'+i)&&$('pr-method-'+i).value)||'Cash',
    });
  }
  const res=await api(`/api/payroll/runs/${encodeURIComponent(__prCurrent.id)}/entries`,{method:'PUT',body:{entries}});
  if(res&&res.ok){toast('✅ Saved');openPayrollRun(__prCurrent.id);}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function finalizePayrollRun(){
  if(!__prCurrent)return;
  if(!confirm('Finalize this payroll run? This will actually deduct each Advance Deduction from the employee\'s Employee Advance balance as a Salary Deduction. This cannot be undone.'))return;
  await savePayrollEntries();
  const res=await api(`/api/payroll/runs/${encodeURIComponent(__prCurrent.id)}/finalize`,{method:'POST'});
  if(res&&res.ok){toast('✅ Payroll finalized — deductions applied');await loadAll();openPayrollRun(__prCurrent.id);loadPayrollRuns();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function exportPayrollSheet(){
  if(!__prCurrent)return;
  _csvDownload(__prCurrent.entries||[],[['Code','employeeCode'],['Employee','employeeName'],['Role','role'],['Base Salary','baseSalary'],['Allowances','allowances'],['Gross Pay','grossPay'],['Advance Deduction','advanceDeduction'],['Other Deduction','otherDeduction'],['Other Deduction Note','otherDeductionNote'],['Total Deductions','totalDeductions'],['Net Pay','netPay'],['Payment Method','paymentMethod']],`payroll_${__prCurrent.storeName}_${__prCurrent.month}.csv`);
}
function printPayslip(i){
  const e=__prCurrent.entries[i];
  const brand=window.__brandName||'ANTA Shoes';
  const html=`<div style="max-width:480px;margin:0 auto;padding:30px;font-family:Arial,sans-serif;color:#111">
    <div style="text-align:center;margin-bottom:20px;border-bottom:2px solid #1a2540;padding-bottom:12px">
      <div style="font-size:20px;font-weight:900;color:#1a2540">${brand}</div>
      <div style="font-size:13px;margin-top:3px">Payslip — ${__prCurrent.month}</div>
    </div>
    <table style="width:100%;font-size:12px;margin-bottom:14px"><tbody>
      <tr><td style="padding:3px 0;color:#666">Employee</td><td style="text-align:right;font-weight:700">${e.employeeName} (${e.employeeCode||'—'})</td></tr>
      <tr><td style="padding:3px 0;color:#666">Role</td><td style="text-align:right">${e.role}</td></tr>
      <tr><td style="padding:3px 0;color:#666">Store</td><td style="text-align:right">${__prCurrent.storeName}</td></tr>
    </tbody></table>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>
      <tr><td style="padding:5px 0">Base Salary</td><td style="text-align:right">${fmt(e.baseSalary)}</td></tr>
      <tr><td style="padding:5px 0">Allowances</td><td style="text-align:right">${fmt(e.allowances)}</td></tr>
      <tr style="border-top:1px solid #ccc;font-weight:700"><td style="padding:5px 0">Gross Pay</td><td style="text-align:right">${fmt(e.grossPay)}</td></tr>
      <tr><td style="padding:5px 0;color:#a33">Advance Deduction (stock shortage/loan)</td><td style="text-align:right;color:#a33">-${fmt(e.advanceDeduction)}</td></tr>
      <tr><td style="padding:5px 0;color:#a33">Other Deduction${e.otherDeductionNote?' — '+e.otherDeductionNote:''}</td><td style="text-align:right;color:#a33">-${fmt(e.otherDeduction)}</td></tr>
      <tr style="border-top:1px solid #ccc;font-weight:700"><td style="padding:5px 0">Total Deductions</td><td style="text-align:right">-${fmt(e.totalDeductions)}</td></tr>
    </tbody></table>
    <div style="display:flex;justify-content:space-between;align-items:center;background:#1a2540;color:#fff;border-radius:8px;padding:12px 16px;margin-top:14px">
      <span style="font-weight:700">NET PAY</span><span style="font-size:19px;font-weight:900">${fmt(e.netPay)}</span>
    </div>
    <div style="margin-top:10px;font-size:11px;color:#666">Payment Method: ${e.paymentMethod}</div>
  </div>`;
  const modal=document.getElementById('report-print-modal');
  if(!modal){toast('Print container missing','error');return;}
  modal.innerHTML=html;
  setTimeout(()=>window.print(),80);
}

// ---------- Attendance ----------
let __attDayList=[];
function populateAttStoreSelects(){
  const opts=(DATA.stores||[]).map(s=>`<option value="${s.StoreID||s.store_id}">${s.Name||s.name}</option>`).join('');
  ['att-store','att-upload-store','att-sum-store'].forEach(id=>{if($(id))$(id).innerHTML=opts;});
  const todayStr=today();
  if($('att-date')&&!$('att-date').value)$('att-date').value=todayStr;
  if($('att-sum-month')&&!$('att-sum-month').value)$('att-sum-month').value=todayStr.slice(0,7);
}
async function loadAttendanceDay(){
  const storeId=$('att-store')?$('att-store').value:'';
  const date=$('att-date')?$('att-date').value:'';
  if(!storeId||!date)return;
  const res=await api(`/api/attendance/day?storeId=${encodeURIComponent(storeId)}&date=${encodeURIComponent(date)}`);
  if(!res||!res.ok)return;
  __attDayList=res.data||[];
  const statusOpts=s=>['present','late','half_day','day_off','leave','absent'].map(v=>`<option value="${v}" ${s===v?'selected':''}>${v==='day_off'?'Day Off (paid)':v.replace('_',' ')}</option>`).join('');
  if($('att-day-table'))$('att-day-table').innerHTML=__attDayList.map((e,i)=>`<tr><td class="fw7">${e.employeeName} <span style="color:var(--gray4);font-size:10px">(${e.employeeCode||'—'})</span><input type="hidden" id="att-emp-${i}" value="${e.employeeUserId}"></td><td><select class="form-input" style="padding:4px 7px" id="att-status-${i}">${statusOpts(e.status)}</select></td></tr>`).join('')||'<tr><td colspan="2" style="text-align:center;color:var(--gray3);padding:14px">No employees at this store</td></tr>';
}
async function saveAttendanceDay(){
  const storeId=$('att-store')?$('att-store').value:'';
  const date=$('att-date')?$('att-date').value:'';
  const records=__attDayList.map((e,i)=>({employeeUserId:$('att-emp-'+i).value,status:$('att-status-'+i).value}));
  const res=await api('/api/attendance/mark',{method:'POST',body:{storeId,date,records}});
  if(res&&res.ok){toast(`✅ Attendance saved for ${res.saved} employee(s)`);loadAttendanceSummary();}
  else toast('❌ Failed','error');
}
function downloadAttendanceTemplate(){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['Employee Code,Date,Status\nEMP1234,2026-09-01,present\nEMP1234,2026-09-02,absent\n'],{type:'text/csv'}));
  a.download='attendance_template.csv';a.click();
}
async function uploadAttendanceFile(file){
  if(!file)return;
  const storeId=$('att-upload-store')?$('att-upload-store').value:'';
  if(!storeId){toast('Select a store first','error');return;}
  const rowsRaw=await readExcel(file);
  const rows=rowsRaw.map(r=>({employeeCode:cleanId(r['Employee Code']||r.employeeCode||''),date:String(r.Date||r.date||'').slice(0,10),status:String(r.Status||r.status||'present').trim()})).filter(r=>r.employeeCode&&r.date);
  if(!rows.length){toast('No valid rows found in file','error');return;}
  const res=await api('/api/attendance/upload',{method:'POST',body:{storeId,rows}});
  if(res&&res.ok){toast(`✅ ${res.saved} saved, ${res.skipped} skipped`);loadAttendanceSummary();}
  else toast('❌ Upload failed','error');
}
async function loadAttendanceSummary(){
  const storeId=$('att-sum-store')?$('att-sum-store').value:'';
  const month=$('att-sum-month')?$('att-sum-month').value:'';
  if(!storeId||!month)return;
  const res=await api(`/api/attendance/summary?storeId=${encodeURIComponent(storeId)}&month=${encodeURIComponent(month)}`);
  if(!res||!res.ok)return;
  if($('att-summary-table'))$('att-summary-table').innerHTML=(res.data||[]).map(e=>`<tr><td style="font-family:monospace;font-size:10px">${e.employeeCode||'—'}</td><td class="fw7">${e.employeeName}</td><td>${e.present}</td><td>${e.late}</td><td>${e.halfDay}</td><td style="color:${e.dayOffOverEntitlement>0?'var(--amber)':'var(--gray4)'}">${e.dayOff}/${e.dayOffEntitlement}${e.dayOffOverEntitlement>0?' ⚠️':''}</td><td style="color:${e.absent>0?'var(--red)':'var(--gray4)'}">${e.absent}</td><td>${e.leave}</td><td>${e.markedDays}/${e.totalWorkingDays}</td><td class="fw7">${e.attendanceRatio!=null?(e.attendanceRatio*100).toFixed(0)+'%':'—'}</td><td style="color:${e.lateFineTotal>0?'var(--red)':'var(--gray4)'}">${e.lateFineTotal>0?fmt(e.lateFineTotal):'—'}</td></tr>`).join('')||'<tr><td colspan="11" style="text-align:center;color:var(--gray3);padding:14px">No employees</td></tr>';
}

// ---------- Cost Centers & Projects ----------
let __ccList=[],__prjList=[];
function populateCCStoreSelect(){
  if($('prj-store'))$('prj-store').innerHTML='<option value="">Company-wide</option>'+(DATA.stores||[]).map(s=>`<option value="${s.StoreID||s.store_id}">${s.Name||s.name}</option>`).join('');
  if($('ccrpt-from')&&!$('ccrpt-from').value)$('ccrpt-from').value=today().slice(0,8)+'01';
  if($('ccrpt-to')&&!$('ccrpt-to').value)$('ccrpt-to').value=today();
}
async function loadCostCenters(){
  const res=await api('/api/ho/cost-centers');
  if(!res||!res.ok)return;
  __ccList=res.data||[];
  if($('cc-table'))$('cc-table').innerHTML=__ccList.map(c=>`<tr><td class="fw7">${c.code}</td><td>${c.name}</td><td><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteCostCenter(${c.id})">🗑️</button></td></tr>`).join('')||'<tr><td colspan="3" style="text-align:center;color:var(--gray3);padding:10px">None yet</td></tr>';
}
async function addCostCenter(){
  const code=($('cc-code')&&$('cc-code').value.trim().toUpperCase())||'';
  const name=($('cc-name')&&$('cc-name').value.trim())||'';
  if(!code||!name){toast('Code and Name required','error');return;}
  const res=await api('/api/ho/cost-centers',{method:'POST',body:{code,name}});
  if(res&&res.ok){toast('✅ Added');$('cc-code').value='';$('cc-name').value='';loadCostCenters();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function deleteCostCenter(id){
  if(!confirm('Delete this Cost Center?'))return;
  const res=await api('/api/ho/cost-centers/'+id,{method:'DELETE'});
  if(res&&res.ok){toast('🗑️ Deleted');loadCostCenters();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed — maybe still in use'),'error');
}
async function loadProjects(){
  const res=await api('/api/ho/projects');
  if(!res||!res.ok)return;
  __prjList=res.data||[];
  if($('prj-table'))$('prj-table').innerHTML=__prjList.map(p=>`<tr><td class="fw7">${p.name}</td><td>${p.storeId||'Company-wide'}</td><td><span class="badge ${p.status==='active'?'badge-green':'badge-gray'}">${p.status}</span></td><td><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteProject('${p.id}')">🗑️</button></td></tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:var(--gray3);padding:10px">None yet</td></tr>';
}
async function addProject(){
  const name=($('prj-name')&&$('prj-name').value.trim())||'';
  const storeId=$('prj-store')?$('prj-store').value:'';
  if(!name){toast('Project name required','error');return;}
  const res=await api('/api/ho/projects',{method:'POST',body:{name,storeId}});
  if(res&&res.ok){toast('✅ Added');$('prj-name').value='';loadProjects();}
  else toast('❌ Failed','error');
}
async function deleteProject(id){
  if(!confirm('Delete this Project?'))return;
  const res=await api('/api/ho/projects/'+encodeURIComponent(id),{method:'DELETE'});
  if(res&&res.ok){toast('🗑️ Deleted');loadProjects();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed — maybe still in use'),'error');
}
async function loadCCReport(){
  const from=$('ccrpt-from')?$('ccrpt-from').value:'';
  const to=$('ccrpt-to')?$('ccrpt-to').value:'';
  const res=await api(`/api/ho/pl-by-costcenter?dateFrom=${from}&dateTo=${to}`);
  if(!res||!res.ok)return;
  if($('ccrpt-table'))$('ccrpt-table').innerHTML=(res.data||[]).map(d=>`<tr><td>${d.costCenterName}</td><td class="fw7">${fmt(d.totalExpense)}</td></tr>`).join('')+`<tr style="font-weight:800;background:var(--gray0)"><td>TOTAL</td><td>${fmt(res.grandTotal)}</td></tr>`;
}
async function loadProjectReport(){
  const res=await api('/api/ho/pl-by-project');
  if(!res||!res.ok)return;
  if($('prjrpt-table'))$('prjrpt-table').innerHTML=(res.data||[]).map(d=>`<tr><td>${d.projectName}</td><td class="fw7">${fmt(d.totalExpense)}</td></tr>`).join('')||'<tr><td colspan="2" style="text-align:center;color:var(--gray3);padding:10px">No project-tagged expenses yet</td></tr>';
}

// ---------- Cheques ----------
async function loadCheques(){
  const dir=$('chq-filter')?$('chq-filter').value:'';
  const res=await api('/api/cheques'+(dir?`?direction=${dir}`:''));
  if(!res||!res.ok)return;
  if($('chq-table'))$('chq-table').innerHTML=(res.data||[]).map(c=>`<tr>
    <td><span class="badge ${c.direction==='receivable'?'badge-green':'badge-amber'}">${c.direction}</span></td>
    <td>${c.chequeNumber||'—'}</td><td>${c.partyName}</td><td class="fw7">${fmt(c.amount)}</td><td>${c.dueDate}</td>
    <td><span class="badge ${c.status==='cleared'?'badge-green':c.status==='bounced'?'badge-red':c.status==='cancelled'?'badge-gray':'badge-amber'}">${c.status}</span></td>
    <td>
      ${c.status==='pending'?`<button class="btn btn-ghost btn-sm" onclick="updateChequeStatus('${c.id}','deposited')">🏦 Deposit</button>`:''}
      ${c.status==='deposited'?`<button class="btn btn-ghost btn-sm" style="color:var(--green)" onclick="updateChequeStatus('${c.id}','cleared')">✅ Cleared</button> <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="updateChequeStatus('${c.id}','bounced')">⚠️ Bounced</button>`:''}
      ${(c.status==='pending')?`<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="updateChequeStatus('${c.id}','cancelled')">✕</button>`:''}
    </td>
  </tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:14px">No cheques yet</td></tr>';
}
async function loadChequesDueSoon(){
  const res=await api('/api/cheques/due-soon?days=7');
  if(!res||!res.ok)return;
  if($('chq-due-table'))$('chq-due-table').innerHTML=(res.data||[]).map(c=>`<tr><td>${c.partyName}</td><td class="fw7">${fmt(c.amount)}</td><td>${c.dueDate}</td><td><span class="badge ${c.direction==='receivable'?'badge-green':'badge-amber'}">${c.direction}</span></td></tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:var(--gray3);padding:10px">None due soon</td></tr>';
}
async function addCheque(){
  const amount=+(($('chq-amount')&&$('chq-amount').value)||0);
  const due=$('chq-due')?$('chq-due').value:'';
  const party=($('chq-party')&&$('chq-party').value.trim())||'';
  if(!amount||!due||!party){toast('Party, Amount, and Due Date required','error');return;}
  const res=await api('/api/cheques',{method:'POST',body:{
    direction:$('chq-direction').value,chequeNumber:$('chq-number').value,bankName:$('chq-bank').value,
    partyName:party,partyType:$('chq-direction').value==='receivable'?'customer':'supplier',
    amount,dueDate:due,
  }});
  if(res&&res.ok){toast('✅ Cheque saved');['chq-number','chq-bank','chq-party','chq-amount','chq-due'].forEach(id=>{if($(id))$(id).value='';});loadCheques();loadChequesDueSoon();}
  else toast('❌ Failed','error');
}
async function updateChequeStatus(id,status){
  if(status==='bounced'&&!confirm('Mark this cheque as bounced?'))return;
  const res=await api(`/api/cheques/${encodeURIComponent(id)}/status?status=${status}`,{method:'PUT'});
  if(res&&res.ok){toast('✅ Updated');loadCheques();loadChequesDueSoon();}
  else toast('❌ Failed','error');
}

// ---------- Budget vs Actual ----------
async function loadBudgetReport(){
  const month=$('bud-month')?$('bud-month').value:'';
  if(!month)return;
  const res=await api(`/api/ho/budget-vs-actual?month=${month}`);
  if(!res||!res.ok)return;
  if($('bud-table'))$('bud-table').innerHTML=(res.data||[]).map(d=>`<tr><td class="fw7">${d.category}</td><td>${fmt(d.budget)}</td><td>${fmt(d.actual)}</td><td style="color:${d.variance<0?'var(--red)':'var(--green)'}">${d.variance>0?'+':''}${fmt(d.variance)}${d.variancePercent!=null?` (${d.variancePercent}%)`:''}</td></tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:var(--gray3);padding:14px">No budgets or expenses this month</td></tr>';
}
async function setBudget(){
  const month=$('bud-month')?$('bud-month').value:'';
  const category=($('bud-cat')&&$('bud-cat').value.trim())||'';
  const amount=+(($('bud-amt')&&$('bud-amt').value)||0);
  if(!month||!category||!amount){toast('Month, Category, and Amount required','error');return;}
  const res=await api('/api/ho/budgets',{method:'POST',body:{month,category,amount}});
  if(res&&res.ok){toast('✅ Budget set');$('bud-cat').value='';$('bud-amt').value='';loadBudgetReport();}
  else toast('❌ Failed','error');
}
let __twmPOList=[],__twmList=[],__twmCurrent=null;
async function populateTWMPOSelect(){
  const res=await api('/api/ho/purchase-orders?status=all');
  __twmPOList=(res&&res.data)||[];
  if($('twm-po'))$('twm-po').innerHTML='<option value="">Select a PO…</option>'+__twmPOList.filter(p=>p.status!=='cancelled').map(p=>`<option value="${p.id}">${p.id} — ${p.supplierName} (${p.status})</option>`).join('');
  if($('twm-date'))$('twm-date').value=today();
}
function loadPOLinesForInvoice(){
  const poId=$('twm-po')?$('twm-po').value:'';
  const po=__twmPOList.find(p=>p.id===poId);
  if(!po){if($('twm-lines'))$('twm-lines').innerHTML='';return;}
  if($('twm-lines'))$('twm-lines').innerHTML=po.lines.map((l,i)=>`<tr>
    <td style="font-family:monospace;font-size:10px">${l.barcode}<input type="hidden" id="twm-name-${i}" value="${l.name}"></td>
    <td>${l.name}</td>
    <td><input class="form-input" type="number" style="width:75px;padding:4px 7px" id="twm-qty-${i}" value="${l.qtyReceived||l.qtyOrdered}"></td>
    <td><input class="form-input" type="number" style="width:85px;padding:4px 7px" id="twm-cost-${i}" value="${l.unitCost}"></td>
  </tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:var(--gray3);padding:12px">No lines</td></tr>';
  window.__twmCurrentLines=po.lines;
}
async function saveSupplierInvoice(){
  const poId=$('twm-po')?$('twm-po').value:'';
  if(!poId||!window.__twmCurrentLines){toast('Select a PO first','error');return;}
  const lines=window.__twmCurrentLines.map((l,i)=>({
    barcode:l.barcode,name:l.name,
    qtyBilled:+(($('twm-qty-'+i)&&$('twm-qty-'+i).value)||0),
    unitCostBilled:+(($('twm-cost-'+i)&&$('twm-cost-'+i).value)||0),
  })).filter(l=>l.qtyBilled>0);
  if(!lines.length){toast('Enter at least one billed line','error');return;}
  const body={poId,invoiceNumber:($('twm-invnum')&&$('twm-invnum').value)||'',date:($('twm-date')&&$('twm-date').value)||today(),lines};
  const res=await api('/api/ho/supplier-invoices',{method:'POST',body});
  if(res&&res.ok){
    toast('✅ Invoice saved — see match results below');
    if($('twm-invnum'))$('twm-invnum').value='';
    await loadSupplierInvoices();
    openInvoiceMatch(res.id);
  } else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function loadSupplierInvoices(){
  const status=$('twm-status-filter')?$('twm-status-filter').value:'';
  const res=await api('/api/ho/supplier-invoices'+(status?('?status='+status):''));
  if(!res||!res.ok)return;
  __twmList=res.data||[];
  const statusBadge=s=>({pending:'badge-amber',approved:'badge-green',disputed:'badge-red'}[s]||'badge-gray');
  if($('twm-list'))$('twm-list').innerHTML=__twmList.map(i=>`<tr>
    <td class="fw7" style="font-size:11px">${i.invoiceNumber||i.id}</td><td style="font-size:11px">${i.poId}</td><td>${i.supplierName}</td><td>${fmt(i.totalAmount)}</td>
    <td>${i.hasDiscrepancy?'<span class="badge badge-red">⚠️ Mismatch</span>':'<span class="badge badge-green">✅ Match</span>'}</td>
    <td><span class="badge ${statusBadge(i.status)}">${i.status}</span></td>
    <td><button class="btn btn-ghost btn-sm" onclick="openInvoiceMatch('${i.id}')">👁️</button></td>
  </tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:14px">No supplier invoices yet</td></tr>';
}
async function openInvoiceMatch(id){
  const res=await api(`/api/ho/supplier-invoices/${encodeURIComponent(id)}/match`);
  if(!res||!res.ok){toast('Failed to load match','error');return;}
  __twmCurrent=res;
  if($('twm-detail-title'))$('twm-detail-title').textContent=`🔍 ${res.invoiceNumber||res.id} — ${res.supplierName} (${res.status})`;
  if($('twm-discrepancy-banner'))$('twm-discrepancy-banner').style.display=res.hasDiscrepancy&&res.status==='pending'?'block':'none';
  if($('twm-match-table'))$('twm-match-table').innerHTML=(res.lines||[]).map(l=>`<tr style="${l.flagged?'background:var(--red-light)':''}">
    <td style="font-family:monospace;font-size:10px">${l.barcode}</td><td>${l.name}</td>
    <td>${l.orderedQty}</td><td>${l.receivedQty}</td><td class="fw7">${l.billedQty}</td>
    <td>${l.poCost!=null?fmt(l.poCost):'—'}</td><td class="fw7">${l.billedCost!=null?fmt(l.billedCost):'—'}</td>
    <td>${l.flagged?'<span class="badge badge-red">⚠️</span>':'<span class="badge badge-green">✅</span>'}</td>
  </tr>`).join('')||'<tr><td colspan="8" style="text-align:center;color:var(--gray3);padding:14px">No lines</td></tr>';
  $('twm-detail-card').style.display='block';
  $('twm-detail-card').scrollIntoView({behavior:'smooth',block:'start'});
}
async function approveInvoiceFlow(){
  if(!__twmCurrent)return;
  let overrideReason='';
  if(__twmCurrent.hasDiscrepancy){
    overrideReason=prompt('This invoice has a PO/GRN mismatch. Enter a reason to approve it for payment anyway:','')||'';
    if(!overrideReason.trim()){toast('Approval cancelled — reason required','warn');return;}
  } else if(!confirm('Approve this invoice for payment?')) return;
  const res=await api(`/api/ho/supplier-invoices/${encodeURIComponent(__twmCurrent.id)}/approve`,{method:'POST',body:{overrideReason}});
  if(res&&res.ok){toast('✅ Approved for payment');openInvoiceMatch(__twmCurrent.id);loadSupplierInvoices();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
async function disputeInvoice(){
  if(!__twmCurrent)return;
  if(!confirm('Mark this invoice as disputed? It will be held from payment until resolved.'))return;
  const res=await api(`/api/ho/supplier-invoices/${encodeURIComponent(__twmCurrent.id)}/dispute`,{method:'POST'});
  if(res&&res.ok){toast('🚫 Marked as disputed');openInvoiceMatch(__twmCurrent.id);loadSupplierInvoices();}
  else toast('❌ Failed','error');
}

function saveCapital(){}
async function testConn(){const url=($('api-url')&&$('api-url').value.trim())||CFG.apiUrl;CFG.apiUrl=url.replace(/\/$/,'');localStorage.setItem('anta_ho_api',CFG.apiUrl);const div=$('conn-res');if(div){div.style.display='block';div.innerHTML='⏳ Testing...';}const res=await api('/api/health');if(res&&res.ok){if(div){div.innerHTML='✅ Connected! '+res.app+' v'+res.version;div.style.color='var(--green)';}setSyncStatus('online','Connected');toast('✅ Connected');if($('server-info'))$('server-info').textContent='DB: '+(res.db||'sqlite')+' · modules: '+(res.modules||[]).join(',');}else{if(div){div.innerHTML='❌ Failed';div.style.color='var(--red)';}toast('❌ Failed','error');}}
async function saveThresholds(){
  const body={
    discountApprovalThreshold:+(($('thr-discount')&&$('thr-discount').value)||15),
    returnApprovalThreshold:+(($('thr-return')&&$('thr-return').value)||100),
    stockCountAdminThreshold:+(($('thr-shortage')&&$('thr-shortage').value)||500),
    storeStaffLiabilityPercent:+(($('thr-staffpct')&&$('thr-staffpct').value)||50),
    monthlyDayoffEntitlement:+(($('thr-dayoff')&&$('thr-dayoff').value)||4),
    lateFineAmount:+(($('thr-latefine')&&$('thr-latefine').value)||10),
  };
  const res=await api('/api/settings',{method:'PUT',body});
  if(res&&res.ok)toast('✅ Thresholds saved');
  else toast('❌ Failed to save','error');
}
function syncThemeFromServer(appThemeJson){
  if(!appThemeJson)return;
  try{
    const c=JSON.parse(appThemeJson);
    const local=localStorage.getItem('anta_theme');
    if(JSON.stringify(c)!==local){
      applyTheme(deriveTheme(c.navy,c.accent,c.accent2));
      localStorage.setItem('anta_theme',JSON.stringify(c));
    }
  }catch(e){}
}
function renderThemeUI(){
  const current=JSON.parse(localStorage.getItem('anta_theme')||'null')||THEME_PRESETS[0];
  if($('theme-navy'))$('theme-navy').value=current.navy;
  if($('theme-accent'))$('theme-accent').value=current.accent;
  if($('theme-accent2'))$('theme-accent2').value=current.accent2;
  if($('theme-preset-grid'))$('theme-preset-grid').innerHTML=THEME_PRESETS.map((p,i)=>`
    <div onclick="applyPresetTheme(${i})" style="cursor:pointer;border:2px solid ${current.navy===p.navy&&current.accent===p.accent?'var(--accent2)':'var(--gray1)'};border-radius:10px;padding:8px;text-align:center;transition:.15s" title="${p.name}">
      <div style="display:flex;height:26px;border-radius:6px;overflow:hidden;margin-bottom:6px">
        <div style="flex:2;background:${p.navy}"></div><div style="flex:1;background:${p.accent}"></div><div style="flex:1;background:${p.accent2}"></div>
      </div>
      <div style="font-size:10px;font-weight:700;color:var(--gray5)">${p.name}</div>
    </div>`).join('');
}
function applyPresetTheme(i){
  const p=THEME_PRESETS[i];
  saveTheme(p.navy,p.accent,p.accent2);
  toast(`🎨 ${p.name} theme applied`);
  renderThemeUI();
}
function previewTheme(){
  const navy=$('theme-navy').value,accent=$('theme-accent').value,accent2=$('theme-accent2').value;
  applyTheme(deriveTheme(navy,accent,accent2));
}
function applyCustomTheme(){
  const navy=$('theme-navy').value,accent=$('theme-accent').value,accent2=$('theme-accent2').value;
  saveTheme(navy,accent,accent2);
  toast('✅ Custom theme saved');
  renderThemeUI();
}
function resetThemeUI(){
  resetTheme();
  toast('↩️ Reset to default theme');
  renderThemeUI();
}
async function loadSettingsForm(){
  const res=await api('/api/settings');
  if(!res||!res.ok)return;
  syncThemeFromServer(res.appTheme);
  _pendingLogoDataUrl=undefined;
  if($('co-name'))$('co-name').value=res.company_name||'';
  if($('co-currency'))$('co-currency').value=res.currency||'LYD';
  if($('thr-discount'))$('thr-discount').value=res.discountApprovalThreshold!=null?res.discountApprovalThreshold:15;
  if($('thr-return'))$('thr-return').value=res.returnApprovalThreshold!=null?res.returnApprovalThreshold:100;
  if($('thr-shortage'))$('thr-shortage').value=res.stockCountAdminThreshold!=null?res.stockCountAdminThreshold:500;
  if($('thr-staffpct'))$('thr-staffpct').value=res.storeStaffLiabilityPercent!=null?res.storeStaffLiabilityPercent:50;
  if($('thr-dayoff'))$('thr-dayoff').value=res.monthlyDayoffEntitlement!=null?res.monthlyDayoffEntitlement:4;
  if($('thr-latefine'))$('thr-latefine').value=res.lateFineAmount!=null?res.lateFineAmount:10;
  const img=$('logo-preview-img'),ph=$('logo-preview-placeholder');
  if(res.company_logo){
    if(img){img.src=res.company_logo;img.style.display='block';}
    if(ph)ph.style.display='none';
  } else {
    if(img){img.style.display='none';img.src='';}
    if(ph)ph.style.display='block';
  }
}
function applyBranding(b){
  // Blank stays blank on purpose — no "ANTA" is forced on anyone who
  // hasn't set their own company name/logo in Settings.
  const name=(b&&b.company_name)||'';
  const logo=(b&&b.company_logo)||'';
  const logoBox=$('brand-logo'),logoText=$('brand-text'),loginBox=$('login-logo-box'),loginTitle=$('login-title-text');
  const initial=name?name.trim().charAt(0).toUpperCase():'';
  [logoBox,loginBox].forEach(el=>{
    if(!el)return;
    el.style.background=logo?'#fff':'';
    if(logo){el.innerHTML=`<img src="${logo}" style="width:100%;height:100%;object-fit:contain;padding:3px;border-radius:inherit">`;}
    else{el.innerHTML=initial;}
  });
  if(logoText)logoText.textContent=name;
  if(loginTitle)loginTitle.textContent=name?name+' — Head Office':'Head Office';
  if(document.title)document.title=name?name+' — Head Office':'Head Office';
}
async function loadBranding(){
  const res=await api('/api/settings/branding');
  if(res&&res.ok)applyBranding(res);
}
let _pendingLogoDataUrl=undefined; // undefined = unchanged, '' = remove, string = new logo
function onLogoFileSelected(file){
  if(!file)return;
  if(file.size>300*1024){toast('❌ Logo too large — keep it under ~200KB','error');return;}
  const reader=new FileReader();
  reader.onload=()=>{
    _pendingLogoDataUrl=reader.result;
    const img=$('logo-preview-img'),ph=$('logo-preview-placeholder');
    if(img){img.src=_pendingLogoDataUrl;img.style.display='block';}
    if(ph)ph.style.display='none';
  };
  reader.readAsDataURL(file);
}
function removeLogo(){
  _pendingLogoDataUrl='';
  const img=$('logo-preview-img'),ph=$('logo-preview-placeholder');
  if(img){img.style.display='none';img.src='';}
  if(ph)ph.style.display='block';
}
async function saveSettings(){
  const name=($('co-name')&&$('co-name').value)||'';
  const currency=($('co-currency')&&$('co-currency').value)||'LYD';
  const body={company_name:name,currency};
  if(_pendingLogoDataUrl!==undefined)body.company_logo=_pendingLogoDataUrl;
  const res=await api('/api/settings',{method:'PUT',body});
  if(res&&res.ok){
    toast('✅ Saved');
    // Apply immediately from what was actually just submitted — don't
    // wait on (or fully trust) the server round-trip for the UI update,
    // so the sidebar/login branding changes instantly, no refresh needed.
    applyBranding({
      company_name:name,
      company_logo:_pendingLogoDataUrl!==undefined?_pendingLogoDataUrl:(res.company_logo||''),
    });
    _pendingLogoDataUrl=undefined;
    show('dashboard');
  } else {
    toast('❌ '+((res&&(res.detail||res.msg))||'Save failed'),'error');
  }
}
async function exportAll(){
  toast('⏳ Preparing backup — fetching full product catalog…','info');
  const allProducts=await api('/api/products?active_only=false'); // full list, on-demand, export only — never cached in DATA
  const exportData={...DATA,products:Array.isArray(allProducts)?allProducts:DATA.products};
  const data=JSON.stringify({exportDate:new Date().toISOString(),DATA:exportData,suppliers,supplierTxns,capitalEntries},null,2);
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type:'application/json'}));a.download='anta_ho_backup_'+today()+'.json';a.click();
  toast('✅ Exported');
}
function readExcel(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=e=>{try{const data=new Uint8Array(e.target.result);const wb=XLSX.read(data,{type:'array'});const ws=wb.Sheets[wb.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(ws,{defval:'',raw:true}).map(row=>{const o={};Object.keys(row).forEach(k=>{const key=k.trim();let v=row[k];if(typeof v==='string')v=v.trim();if(/barcode|bar\s*code|sku|item\s*code|product\s*code/i.test(key)&&typeof v==='number'){v=v.toFixed(0);}o[key]=v;});return o;});resolve(rows);}catch(err){reject(err);}};reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(file);});}
function startAutoRefresh(){}
function updateClock(){if($('clock'))$('clock').textContent=new Date().toLocaleDateString('en-GB')+' · '+new Date().toTimeString().slice(0,5);}
setInterval(updateClock,1000);updateClock();
document.addEventListener('keydown',e=>{
  const ls=$('login-screen');
  if(!ls||ls.style.display==='none')return;
  if(e.key==='Enter'){pinSubmit();return;}
  if(e.key==='Backspace'){e.preventDefault();pinClear();return;}
  if(/^[0-9]$/.test(e.key)){pinPress(e.key);return;}
});
(async function boot(){
  const saved=localStorage.getItem('anta_ho_api'); if(saved)CFG.apiUrl=saved;
  try{await loadBranding();}catch(_e){}
  if(CFG.token){
    const me=await api('/api/auth/me');
    const role=me&&me.user&&(me.user.role||'');
    if(me&&me.ok&&me.user&&(role==='admin'||role==='manager'||role==='accountant'||role==='merchandiser'||role==='warehouse')){
      currentUser=me.user; try{applyRoleUI();}catch(_e){}
      if($('login-screen'))$('login-screen').style.display='none';
      const app=$('app'); if(app){app.style.display='flex';app.classList.add('open');}
      try{await loadAll();}catch(_e){}
      try{show('dashboard');}catch(_e){}
      startHoAutoRefresh();
      return;
    }
    // stale token
    CFG.token=''; localStorage.removeItem('anta_ho_token');
  }
  const stores=await api('/api/auth/stores');
  const sel=$('login-store');
  if(sel){
    let list=Array.isArray(stores)?stores.slice():[];
    if(!list.some(s=>s.store_id==='HO')) list.push({store_id:'HO',name:'Head Office'});
    sel.innerHTML=list.map(s=>`<option value="${s.store_id}">${s.name}</option>`).join('');
    sel.value='HO';
  }
  try{applyLang();}catch(e){}
})();


/* ===== v5 HO extensions: expenses form, promos, COA, license, i18n, roles ===== */
function applyRoleUI(){
  const role=(currentUser&&currentUser.role)||'';
  document.querySelectorAll('[data-role]').forEach(el=>{
    const need=(el.getAttribute('data-role')||'').split(',').map(s=>s.trim()).filter(Boolean);
    el.style.display = (!need.length || role==='admin' || need.includes(role)) ? '' : 'none';
  });
  const roleLabels={admin:'HO ADMIN',manager:'MANAGER',accountant:'ACCOUNTANT',merchandiser:'MERCHANDISER',warehouse:'WAREHOUSE'};
  const tag=$('ho-role-tag');
  if(tag)tag.textContent=roleLabels[role]||role.toUpperCase()||'HO';
  const nameEl=$('ho-user-name');
  if(nameEl)nameEl.textContent=(currentUser&&currentUser.name)||'';
  const uname=(currentUser&&currentUser.name)||'';
  if($('account-name'))$('account-name').textContent=uname||'Account';
  if($('account-avatar'))$('account-avatar').textContent=uname?uname.trim().charAt(0).toUpperCase():'A';
  if($('account-menu-name'))$('account-menu-name').textContent=uname||'—';
  if($('account-menu-role'))$('account-menu-role').textContent=roleLabels[role]||role.toUpperCase()||'HO';
}
function toggleAccountMenu(ev){
  if(ev)ev.stopPropagation();
  const m=$('account-menu');
  if(!m)return;
  const opening=m.style.display==='none';
  closeAllTopMenus();
  m.style.display=opening?'block':'none';
}
function toggleNotifPanel(ev){
  if(ev)ev.stopPropagation();
  const p=$('notif-panel');
  if(!p)return;
  const opening=p.style.display==='none';
  closeAllTopMenus();
  if(opening){p.style.display='block';renderNotifList();}
}
function closeAllTopMenus(){
  if($('account-menu'))$('account-menu').style.display='none';
  if($('notif-panel'))$('notif-panel').style.display='none';
}
document.addEventListener('click',(e)=>{
  if(!e.target.closest('#notif-panel,#notif-bell,#account-menu,#account-btn'))closeAllTopMenus();
});
function hoLogout(){
  if(!confirm('Logout from HO?'))return;
  CFG.token='';
  localStorage.removeItem('anta_ho_token');
  currentUser=null;
  if(_hoAutoRefreshTimer){clearInterval(_hoAutoRefreshTimer);_hoAutoRefreshTimer=null;}
  location.reload();
}
/* ===== HO i18n AR/EN ===== */
const HO_I18N = {
  en: {
    dashboard:'HO Dashboard', 'stores-view':'All Stores', warehouse:'HO Warehouse', 'supplier-grn':'Supplier GRN',
    'store-grn':'Send to Stores (GRN)', transfer:'Store Transfer', products:'Product Master', pl:'P&L Statement',
    'balance-sheet':'Balance Sheet', cashflow:'Cash Flow', 'supplier-accounts':'Supplier Accounts',
    'expenses-ho':'Expenses', accounts:'Chart of Accounts', promotions:'Promotions', license:'License',
    capital:'Capital & Equity', 'fixed-assets':'Fixed Assets', 'prepaid-expenses':'Prepaid Expenses', reports:'Sales Reports', 'inventory-ho':'Inventory — All',
    'stores-admin':'Manage Stores', users:'Users & PINs', banks:'Banks & Payments', settings:'Settings',
    customers:'Customers', 'stock-aging':'Stock Aging', 'audit-log':'Audit Log', 'barcode-labels':'Barcode Labels',
    'purchase-orders':'Purchase Orders', handovers:'Cash Handovers',
    overview:'Overview', stock:'Stock Management', finance:'Finance', admin:'Admin', products_sec:'Products',
    reports_sec:'Reports', lang_btn:'العربية / EN', switch_ar:'تم التبديل إلى العربية', switch_en:'Switched to English',
    logout:'Logout', refresh:'Refresh'
  },
  ar: {
    dashboard:'لوحة المكتب الرئيسي', 'stores-view':'كل المتاجر', warehouse:'مستودع المكتب', 'supplier-grn':'استلام من المورد',
    'store-grn':'إرسال للمتاجر', transfer:'تحويل بين المتاجر', products:'كتالوج المنتجات', pl:'الأرباح والخسائر',
    'balance-sheet':'الميزانية العمومية', cashflow:'التدفق النقدي', 'supplier-accounts':'حسابات الموردين',
    'expenses-ho':'المصروفات', accounts:'دليل الحسابات', promotions:'العروض', license:'الترخيص',
    capital:'رأس المال', 'fixed-assets':'الأصول الثابتة', reports:'تقارير المبيعات', 'inventory-ho':'المخزون — الكل',
    'stores-admin':'إدارة المتاجر', users:'المستخدمون والرمز', banks:'البنوك والمدفوعات', settings:'الإعدادات',
    customers:'العملاء', 'stock-aging':'تقادم المخزون', 'audit-log':'سجل التدقيق', 'barcode-labels':'ملصقات الباركود',
    'purchase-orders':'أوامر الشراء', handovers:'تسليم النقدية',
    overview:'نظرة عامة', stock:'إدارة المخزون', finance:'المالية', admin:'الإدارة', products_sec:'المنتجات',
    reports_sec:'التقارير', lang_btn:'EN / العربية', switch_ar:'تم التبديل إلى العربية', switch_en:'تم التبديل إلى الإنجليزية',
    logout:'تسجيل الخروج', refresh:'تحديث'
  }
};
function hoT(key){
  const lang = localStorage.getItem('anta_lang') || 'en';
  const pack = HO_I18N[lang] || HO_I18N.en;
  return (pack && pack[key]) || (HO_I18N.en && HO_I18N.en[key]) || key;
}
function applyLang(){
  try {
    const lang = localStorage.getItem('anta_lang') || 'en';
    const r = document.getElementById('html-root') || document.documentElement;
    r.setAttribute('lang', lang);
    r.setAttribute('dir', lang==='ar' ? 'rtl' : 'ltr');
    if (document.body) document.body.setAttribute('dir', lang==='ar' ? 'rtl' : 'ltr');

    document.querySelectorAll('.nav-item[onclick]').forEach(el => {
      const oc = el.getAttribute('onclick') || '';
      const m = oc.match(/show\('([^']+)'\)/);
      if (!m) return;
      const key = m[1];
      const label = hoT(key);
      const ico = el.querySelector('.ico');
      el.innerHTML = '';
      if (ico) el.appendChild(ico);
      el.appendChild(document.createTextNode(' ' + label));
    });
    document.querySelectorAll('.nav-sec').forEach(el => {
      const raw = (el.getAttribute('data-sec') || el.textContent || '').trim().toLowerCase();
      const map = {
        'overview':'overview', 'stock management':'stock', 'products':'products_sec',
        'finance':'finance', 'reports':'reports_sec', 'admin':'admin'
      };
      const k = map[raw] || map[el.textContent.trim().toLowerCase()];
      if (k) {
        if (!el.getAttribute('data-sec')) el.setAttribute('data-sec', el.textContent.trim());
        el.textContent = hoT(k);
      }
    });
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      if (k) el.textContent = hoT(k);
    });
    const btn = document.querySelector('button[onclick="toggleLang()"]');
    if (btn) btn.textContent = hoT('lang_btn');
    const st = document.getElementById('screen-title');
    if (st && window.__lastScreen) st.textContent = hoT(window.__lastScreen);
  } catch (e) { console.warn('applyLang', e); }
}
function toggleLang(){
  const cur = localStorage.getItem('anta_lang') || 'en';
  const next = cur === 'en' ? 'ar' : 'en';
  localStorage.setItem('anta_lang', next);
  applyLang();
  try {
    const active = document.querySelector('.nav-item.active');
    if (active) {
      const oc = active.getAttribute('onclick') || '';
      const m = oc.match(/show\('([^']+)'\)/);
      if (m && typeof show === 'function') show(m[1]);
    }
  } catch (e) {}
  toast(next === 'ar' ? hoT('switch_ar') : hoT('switch_en'));
}

async function populateExpenseCCDropdowns(){
  const ccRes=await api('/api/ho/cost-centers');
  if(ccRes&&ccRes.ok&&$('ho-exp-cc'))$('ho-exp-cc').innerHTML='<option value="">—</option>'+(ccRes.data||[]).map(c=>`<option value="${c.code}">${c.name}</option>`).join('');
  const prjRes=await api('/api/ho/projects');
  if(prjRes&&prjRes.ok&&$('ho-exp-prj'))$('ho-exp-prj').innerHTML='<option value="">—</option>'+(prjRes.data||[]).filter(p=>p.status==='active').map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
}
async function saveHoExpense(){
  const amount=parseFloat($('ho-exp-amt')&&$('ho-exp-amt').value)||0;
  if(!amount){toast('Amount required','error');return;}
  const storeSel=$('ho-exp-store');
  const editId=$('ho-exp-editid')?$('ho-exp-editid').value:'';
  const body={
    date:($('ho-exp-date')&&$('ho-exp-date').value)||today(),
    storeId:(storeSel&&storeSel.value)||'HO',
    store:(storeSel&&storeSel.selectedOptions&&storeSel.selectedOptions[0]&&storeSel.selectedOptions[0].text)||'HO',
    category:($('ho-exp-cat')&&$('ho-exp-cat').value)||'Other',
    description:($('ho-exp-desc')&&$('ho-exp-desc').value)||'',
    amount:amount,
    payMethod:($('ho-exp-pay')&&$('ho-exp-pay').value)||'Cash',
    reference:($('ho-exp-ref')&&$('ho-exp-ref').value)||'',
    costCenterId:($('ho-exp-cc')&&$('ho-exp-cc').value)||'',
    projectId:($('ho-exp-prj')&&$('ho-exp-prj').value)||'',
  };
  const res=editId
    ? await api(`/api/expenses/${encodeURIComponent(editId)}`,{method:'PUT',body:body})
    : await api('/api/expenses',{method:'POST',body:body});
  if(res&&res.ok){
    toast(editId?'✅ Expense updated':'✅ Expense saved');
    if($('ho-exp-amt'))$('ho-exp-amt').value='';
    if($('ho-exp-desc'))$('ho-exp-desc').value='';
    if($('ho-exp-editid'))$('ho-exp-editid').value='';
    const btn=document.querySelector('[onclick="saveHoExpense()"]');
    if(btn)btn.textContent='💾 Save Expense';
    await loadAll();
    loadExpenses();
  } else {
    const msg=(res&& (res.detail||res.msg)) || 'Failed';
    toast(typeof msg==='string'?msg:'Failed','error');
  }
}
function editExpense(id){
  const e=(DATA.expenses||[]).find(x=>x.id===id);
  if(!e){toast('Not found','error');return;}
  if($('ho-exp-date'))$('ho-exp-date').value=e.date||e.Date||today();
  if($('ho-exp-store'))$('ho-exp-store').value=e.storeId||e.StoreID||'HO';
  if($('ho-exp-cat'))$('ho-exp-cat').value=e.category||e.Category||'Other';
  if($('ho-exp-amt'))$('ho-exp-amt').value=e.amount!=null?e.amount:e.Amount;
  if($('ho-exp-pay'))$('ho-exp-pay').value=e.payMethod||e.PayMethod||'Cash';
  if($('ho-exp-ref'))$('ho-exp-ref').value=e.reference||'';
  if($('ho-exp-desc'))$('ho-exp-desc').value=e.description||e.Description||'';
  if(!$('ho-exp-editid')){
    const hidden=document.createElement('input');hidden.type='hidden';hidden.id='ho-exp-editid';
    document.querySelector('[onclick="saveHoExpense()"]').insertAdjacentElement('beforebegin',hidden);
  }
  $('ho-exp-editid').value=id;
  const btn=document.querySelector('[onclick="saveHoExpense()"]');
  if(btn)btn.textContent='💾 Update Expense';
  btn.scrollIntoView({behavior:'smooth',block:'center'});
}
async function deleteExpense(id){
  if(!confirm('Delete this expense? This cannot be undone.'))return;
  const res=await api(`/api/expenses/${encodeURIComponent(id)}`,{method:'DELETE'});
  if(res&&res.ok){toast('✅ Deleted');await loadAll();loadExpenses();}
  else toast('❌ Failed','error');
}
function exportExpenses(){
  _csvDownload(DATA.expenses||[],[['Date','date'],['Store','store'],['Category','category'],['Description','description'],['Amount','amount'],['Payment','payMethod'],['Reference','reference']],'expenses_'+today()+'.csv');
}
async function loadPromosHO(){
  const res=await api('/api/promotions');
  const rows=(res&&res.data)||[];
  const el=$('promo-table'); if(!el)return;
  el.innerHTML=rows.map(p=>{
    const period=(p.startDate||p.endDate)?((p.startDate||'…')+' '+(p.startTime||'00:00')+' → '+(p.endDate||'…')+' '+(p.endTime||'23:59')):'Always';
    return `<tr>
    <td>${p.name}</td><td>${p.type}</td><td>${p.value}</td>
    <td>${p.targetType}:${p.targetValue||'-'}</td>
    <td style="font-size:11px">${period}</td>
    <td>${p.active?'✅':'⛔'}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="togglePromo('${p.id}')">${p.active?'Disable':'Enable'}</button></td>
  </tr>`;}).join('')||'<tr><td colspan="7">No promotions</td></tr>';
}
async function savePromo(){
  const body={
    name:($('promo-name')&&$('promo-name').value)||'',
    type:($('promo-type')&&$('promo-type').value)||'percent',
    value:parseFloat($('promo-value')&&$('promo-value').value)||0,
    targetType:($('promo-target-type')&&$('promo-target-type').value)||'all',
    targetValue:($('promo-target-value')&&$('promo-target-value').value)||'',
    startDate:($('promo-start-date')&&$('promo-start-date').value)||'',
    startTime:($('promo-start-time')&&$('promo-start-time').value)||'',
    endDate:($('promo-end-date')&&$('promo-end-date').value)||'',
    endTime:($('promo-end-time')&&$('promo-end-time').value)||'',
    active:true
  };
  if(!body.name){toast('Name required','error');return;}
  const res=await api('/api/promotions',{method:'POST',body:body});
  if(res&&res.ok){toast('Promotion saved');loadPromosHO();} else toast('Failed','error');
}
async function togglePromo(id){
  const res=await api('/api/promotions/'+encodeURIComponent(id)+'/toggle',{method:'POST',body:{}});
  if(res&&res.ok){loadPromosHO();toast(res.active?'Activated':'Deactivated');}
}
let __tbRows=[],__jeRows=[];
async function loadCOA(){
  const res=await api('/api/accounts/coa');
  const el=$('coa-table'); if(!el)return;
  el.innerHTML=((res&&res.data)||[]).map(a=>`<tr><td class="fw7" style="font-family:monospace">${a.code}</td><td>${a.name}</td><td><span class="badge badge-blue">${a.type}</span></td><td>${a.active?'✅':'—'}</td></tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:var(--gray3);padding:14px">No accounts</td></tr>';
}
async function loadTrialBalance(){
  const res=await api('/api/accounts/trial-balance');
  if(!res||!res.ok)return;
  __tbRows=res.data||[];
  if($('tb-status'))$('tb-status').innerHTML=res.balanced
    ?`<span class="badge badge-green">✅ Balanced</span> <span style="color:var(--gray4)">Total Debit ${fmt(res.totalDebit)} = Total Credit ${fmt(res.totalCredit)}</span>`
    :`<span class="badge badge-red">⚠️ Out of balance</span> <span style="color:var(--gray4)">Debit ${fmt(res.totalDebit)} vs Credit ${fmt(res.totalCredit)}</span>`;
  if($('tb-table'))$('tb-table').innerHTML=(res.data||[]).map(r=>`<tr><td class="fw7" style="font-family:monospace">${r.code}</td><td>${r.name}</td><td><span class="badge badge-blue">${r.type}</span></td><td class="text-right">${fmt(r.debit)}</td><td class="text-right">${fmt(r.credit)}</td><td class="text-right fw7">${fmt(Math.abs(r.balance))}${r.balance<0?' CR':''}</td></tr>`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:14px">No activity yet</td></tr>';
}
function exportTrialBalance(){
  _csvDownload(__tbRows,[['Code','code'],['Account','name'],['Type','type'],['Debit','debit'],['Credit','credit'],['Balance','balance']],'trial_balance_'+today()+'.csv');
}
async function loadJournals(){
  const src=$('je-filter')?$('je-filter').value:'';
  const res=await api('/api/accounts/journals?limit=100'+(src?('&source_type='+encodeURIComponent(src)):''));
  const el=$('je-list'); if(!el)return;
  const rows=(res&&res.data)||[];
  __jeRows=rows;
  const srcBadge=t=>({sale:'badge-green',expense:'badge-amber',manual:'badge-blue'}[t]||'badge-gray');
  el.innerHTML=rows.map(j=>{
    const totalDr=(j.lines||[]).reduce((a,l)=>a+(+l.debit||0),0);
    return `<div style="border:1px solid var(--gray1);border-radius:8px;padding:10px 12px;margin-bottom:7px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div><b>${j.id}</b> <span style="color:var(--gray4);font-size:11px">${j.date}</span> <span class="badge ${srcBadge(j.sourceType)}">${j.sourceType}</span></div>
        <div style="font-size:11px;color:var(--gray4)">${j.sourceId}</div>
      </div>
      <div style="font-size:11px;color:var(--gray4);margin-bottom:6px">${j.memo||''}</div>
      <table style="font-size:11.5px"><tbody>${(j.lines||[]).map(l=>`<tr><td style="font-family:monospace;padding:2px 6px 2px 0">${l.accountCode}</td><td style="padding:2px 6px">${l.accountName}</td><td class="text-right" style="padding:2px 6px">${l.debit?fmt(l.debit):''}</td><td class="text-right" style="padding:2px 0;color:var(--gray4)">${l.credit?fmt(l.credit):''}</td></tr>`).join('')}</tbody></table>
    </div>`;
  }).join('')||'<div style="text-align:center;color:var(--gray3);padding:20px">No journal entries yet</div>';
}
function exportJournals(){
  const flat=[];
  __jeRows.forEach(j=>(j.lines||[]).forEach(l=>flat.push({
    entry:j.id, date:j.date, sourceType:j.sourceType, sourceId:j.sourceId, memo:j.memo,
    accountCode:l.accountCode, accountName:l.accountName, debit:l.debit, credit:l.credit,
  })));
  _csvDownload(flat,[['Entry','entry'],['Date','date'],['Source Type','sourceType'],['Source ID','sourceId'],['Memo','memo'],['Account Code','accountCode'],['Account Name','accountName'],['Debit','debit'],['Credit','credit']],'journal_entries_'+today()+'.csv');
}
async function loadLicense(){
  const res=await api('/api/license/status');
  const el=$('lic-status'); if(!el)return;
  if(!res){el.textContent='Unavailable';return;}
  el.innerHTML=`Locked: <b>${res.locked?'YES':'NO'}</b><br>Expiry: ${res.expiry||'-'}<br>Key: ${res.key||'-'}<br>${res.reason||''}`;
}
async function activateLicense(){
  const key=($('lic-key')&&$('lic-key').value)||'';
  const res=await api('/api/license/activate',{method:'POST',body:{key:key,tenant:'ALL'}});
  toast(res&&res.ok?'Activated':((res&&res.msg)||'Failed'), res&&res.ok?'ok':'error');
  loadLicense();
}
async function generateLicense(){
  const year=new Date().getFullYear();
  const res=await api('/api/license/generate',{method:'POST',body:{year:year,tenant:'ALL'}});
  if(res&&res.key){if($('lic-key'))$('lic-key').value=res.key;toast('Key generated');} else toast('Failed','error');
}
async function lockLicense(locked){
  const res=await api('/api/license/lock',{method:'POST',body:{locked:!!locked,reason:locked?'Remote lock':'Unlocked'}});
  toast(res&&res.ok?(locked?'Locked':'Unlocked'):'Failed', res&&res.ok?'ok':'error');
  loadLicense();
}

function renderPaginationControls(totalPages){
  const container=$('prod-pagination');
  if(!container)return;
  totalPages=Math.max(1,totalPages);
  let html='<div style="display:flex;align-items:center;gap:5px;margin-top:13px;flex-wrap:wrap">';
  if(prodCurrentPage>1)html+=`<button class="btn btn-ghost btn-sm" onclick="prodCurrentPage--;renderProducts()">← Previous</button>`;
  const maxButtons=7;
  let startPage=Math.max(1,prodCurrentPage-Math.floor(maxButtons/2));
  let endPage=Math.min(totalPages,startPage+maxButtons-1);
  if(endPage-startPage<maxButtons-1)startPage=Math.max(1,endPage-maxButtons+1);
  if(startPage>1){html+=`<button class="btn btn-ghost btn-sm" onclick="prodCurrentPage=1;renderProducts()">1</button>`;if(startPage>2)html+='<span style="color:var(--gray3)">...</span>';}
  for(let i=startPage;i<=endPage;i++)html+=(i===prodCurrentPage)?`<button class="btn btn-primary btn-sm" style="min-width:30px">${i}</button>`:`<button class="btn btn-ghost btn-sm" onclick="prodCurrentPage=${i};renderProducts()" style="min-width:30px">${i}</button>`;
  if(endPage<totalPages){if(endPage<totalPages-1)html+='<span style="color:var(--gray3)">...</span>';html+=`<button class="btn btn-ghost btn-sm" onclick="prodCurrentPage=${totalPages};renderProducts()">${totalPages}</button>`;}
  if(prodCurrentPage<totalPages)html+=`<button class="btn btn-ghost btn-sm" onclick="prodCurrentPage++;renderProducts()">Next →</button>`;
  html+=`<span style="margin-left:auto;font-size:11px;color:var(--gray4)">Page ${prodCurrentPage} of ${totalPages} · ${prodTotalCount} product(s) match${prodSearchQuery?` "${prodSearchQuery}"`:''}</span></div>`;
  container.innerHTML=html;
  updateProdSelectedInfo();
}
let prodSearchDebounce=null;
function searchProducts(query){
  clearTimeout(prodSearchDebounce);
  prodSearchDebounce=setTimeout(()=>{prodSearchQuery=String(query||'').trim();prodCurrentPage=1;fetchAndRenderProductsPage();},180);
}
function doProductSearch(){
  clearTimeout(prodSearchDebounce);
  prodSearchQuery=($('prod-search')&&$('prod-search').value||'').trim();
  prodCurrentPage=1;
  fetchAndRenderProductsPage();
}
function clearProductSearch(){
  clearTimeout(prodSearchDebounce);
  if($('prod-search'))$('prod-search').value='';
  prodSearchQuery='';
  prodCurrentPage=1;
  fetchAndRenderProductsPage();
}
function updateProdSelectedInfo(){
  const el=$('prod-selected-info');
  if(!el)return;
  el.textContent=selectedProducts.size?`✅ ${selectedProducts.size} product(s) selected · ${prodTotalCount} total match`:`${prodTotalCount} product(s) total`;
}