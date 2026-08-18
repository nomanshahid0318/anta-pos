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
let isOnline=false,pinEntry='',currentUser=null;
const $=id=>document.getElementById(id);
const today=()=>new Date().toISOString().split('T')[0];
const fmt=n=>'LYD '+(+n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
function toast(msg,type='ok'){const t=$('toast');if(!t)return;t.textContent=msg;t.style.background=type==='error'?'var(--red)':type==='warn'?'#856404':type==='info'?'var(--accent2)':'var(--navy)';t.style.display='block';setTimeout(()=>t.style.display='none',3000);}
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
  const res=await api('/api/auth/login',{method:'POST',body:{store_id:storeId,pin:pinEntry}});
  const token=res&&(res.access_token||res.accessToken);
  const user=res&&res.user;
  if(token&&user){
    const role=(user.role||'').toLowerCase();
    if(role!=='admin'&&role!=='manager'&&role!=='accountant'){
      if(e){e.style.display='block';e.textContent='HO requires admin, manager or accountant';}
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
}
function show(name){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));const s=$('screen-'+name);if(s)s.classList.add('active');document.querySelectorAll('.nav-item').forEach(n=>{if(n.getAttribute('onclick')&&n.getAttribute('onclick').includes("'"+name+"'"))n.classList.add('active');});const titles={dashboard:'HO Dashboard','stores-view':'All Stores',warehouse:'HO Warehouse','supplier-grn':'Supplier GRN','store-grn':'Send Stock to Stores',transfer:'Stock Transfer',products:'Product Master',pl:'P&L Summary','expenses-ho':'Expenses',reports:'Sales Reports','inventory-ho':'Inventory — All Stores','stores-admin':'Manage Stores',users:'Users & PINs',banks:'Banks & Payments',settings:'Settings','balance-sheet':'Balance Sheet',cashflow:'Cash Flow','supplier-accounts':'Supplier Accounts',capital:'Capital & Equity'};if($('screen-title'))$('screen-title').textContent=titles[name]||name;
if(name==='dashboard')renderDash();if(name==='stores-view')renderStoresView();if(name==='warehouse')renderWarehouse();
if(name==='supplier-grn'){sgrnHistCurrentPage=1;fetchAndRenderSGRNHist();if($('sgrn-date'))$('sgrn-date').value=today();if($('sgrn-id'))$('sgrn-id').value='SGRN-'+Date.now().toString().slice(-6);}
if(name==='store-grn'){stgrnPendingCurrentPage=1;stgrnDoneCurrentPage=1;fetchAndRenderStGRNPending();fetchAndRenderStGRNDone();populateStoreSelects();if($('stgrn-date'))$('stgrn-date').value=today();if($('stgrn-id'))$('stgrn-id').value='GRN-'+Date.now().toString().slice(-6);}
if(name==='transfer'){renderTrHist();populateStoreSelects();}if(name==='products'){prodCurrentPage=1;fetchAndRenderProductsPage();}
if(name==='pl'){plPreset();populateStoreSelects('pl-store');loadPL();}if(name==='expenses-ho'){populateStoreSelects('exp-store-filter');populateStoreSelects('ho-exp-store');if($('ho-exp-date'))$('ho-exp-date').value=today();loadExpenses();}if(name==='promotions')loadPromosHO();if(name==='accounts'){loadCOA();loadJournals();}if(name==='license')loadLicense();
if(name==='reports'){rptPreset();populateStoreSelects('rpt-store');}if(name==='inventory-ho'){invAllCurrentPage=1;fetchAndRenderInvAll();}
if(name==='stores-admin')renderStoresAdmin();if(name==='users'){renderUsers();populateStoreSelects('u-store');}if(name==='banks')renderBanks();
if(name==='settings'){if($('api-url'))$('api-url').value=CFG.apiUrl;loadSettingsForm();}
if(name==='balance-sheet'){if($('bs-date'))$('bs-date').value=today();loadBalanceSheet();}
if(name==='cashflow'){cfPreset();loadCashFlow();}if(name==='handovers'){populateStoreSelects('handover-store-filter');loadHOHandovers();}if(name==='supplier-accounts'){renderSupplierAccounts();if($('sup-txn-date'))$('sup-txn-date').value=today();}
if(name==='capital'){if($('cap-date'))$('cap-date').value=today();renderCapital();}
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
try{const [dash,sales,banks,stores,users,exps,wh,sgrns,stgrns,trs,sups,suptx,caps,bs,cf]=await fetchInBatches([
()=>api('/api/dashboard'),()=>api('/api/sales?limit=500'),()=>api('/api/banks'),()=>api('/api/stores/all'),()=>api('/api/auth/users'),()=>api('/api/expenses?limit=300'),
()=>api('/api/ho/warehouse'),()=>api('/api/ho/supplier-grns'),()=>api('/api/ho/store-grns'),()=>api('/api/ho/transfers'),()=>api('/api/ho/suppliers'),()=>api('/api/ho/supplier-txns'),()=>api('/api/ho/capital'),()=>api('/api/ho/bs-entries'),()=>api('/api/ho/cf-items')],4);
if(dash&&dash.ok)DATA.dashboard=dash;
if(sales&&sales.data)DATA.sales=sales.data.map(s=>({...s,Date:s.date,Total:s.total,Payment:s.payment,Store:s.store,StoreID:s.storeId}));
if(Array.isArray(banks))DATA.banks=banks.map(b=>({BankID:b.bank_id,Name:b.name,Device:b.device,Active:b.active?'Y':'N'}));
const storeRows=Array.isArray(stores)?stores:(stores&&Array.isArray(stores.data)?stores.data:[]);if(storeRows.length||Array.isArray(stores)||(stores&&stores.data))DATA.stores=storeRows.map(s=>({StoreID:s.store_id||s.StoreID,Name:s.name||s.Name,City:s.city||s.City||'',Address:s.address||s.Address||'',Manager:s.manager||s.Manager||'',Phone:s.phone||s.Phone||'',Active:(s.active===false||s.Active==='N')?'N':'Y'}));
if(Array.isArray(users))DATA.users=users.map(u=>({UserID:u.user_id,StoreID:u.store_id,StoreName:u.store_name,Name:u.name,Role:u.role,Active:u.active?'Y':'N'}));
if(exps&&exps.data)DATA.expenses=exps.data.map(e=>({...e,Date:e.date,Amount:e.amount,Store:e.store,StoreID:e.storeId,Category:e.category,Description:e.description,PayMethod:e.payMethod}));
if(wh&&wh.data)DATA.warehouse=wh.data;if(sgrns&&sgrns.data)DATA.supplierGRNs=sgrns.data;if(stgrns&&stgrns.data)DATA.storeGRNs=stgrns.data;if(trs&&trs.data)DATA.transfers=trs.data;
if(sups&&sups.data)suppliers=sups.data;if(suptx&&suptx.data)supplierTxns=suptx.data;if(caps&&caps.data)capitalEntries=caps.data;
if(bs&&bs.data)bsEntries=bs.data.map(b=>({id:b.id,type:b.type,desc:b.desc,amount:b.amount,date:b.date}));
if(cf&&cf.data){cfItems={investing:[],financing:[]};cf.data.forEach(c=>{if(!cfItems[c.section])cfItems[c.section]=[];cfItems[c.section].push({label:c.label,value:c.value});});}
setSyncStatus('online','Loaded: '+new Date().toLocaleTimeString());if($('dash-status'))$('dash-status').textContent='Live data loaded: '+new Date().toLocaleTimeString();
renderDash();populateStoreSelects();try{await loadCategories();}catch(_e){}
if(currentScreenName()==='products'){try{await fetchAndRenderProductsPage();}catch(_e){}}
toast('✅ All data loaded!');}catch(e){setSyncStatus('offline','Error');toast('❌ '+e.message,'error');}}
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
function populateStoreSelects(id){const ids=id?[id]:['stgrn-store','tr-from','tr-to','pl-store','rpt-store','exp-store-filter','u-store','bs-store','recalc-store'];const stores=DATA.stores.length?DATA.stores.filter(s=>s.StoreID!=='HO'):[{StoreID:'s1',Name:'Store 1 — Tripoli'},{StoreID:'s2',Name:'Store 2 — Benghazi'},{StoreID:'s3',Name:'Store 3 — Misrata'}];ids.forEach(selId=>{const el=$(selId);if(!el)return;const hasAll=!['stgrn-store','tr-from','tr-to','u-store','recalc-store'].includes(selId);const storeList=selId==='u-store'?[{StoreID:'HO',Name:'Head Office'},...stores]:stores;el.innerHTML=(hasAll?'<option value="all">All Stores</option>':'')+storeList.map(s=>`<option value="${s.StoreID}">${s.Name}</option>`).join('');});}
function renderDash(){const d=DATA.dashboard;const set=(id,v)=>{const el=$(id);if(el)el.textContent=v;};if(d){set('d-rev',fmt(d.totalRevenue||0));set('d-inv',d.totalInvoices||0);set('d-net',fmt(d.netRevenue||0));set('d-atv',fmt(d.atv||0));set('d-ret',fmt(d.totalReturns||0));set('d-ret-pct',d.totalRevenue?(d.totalReturns/d.totalRevenue*100).toFixed(1)+'% return rate':'0%');set('d-ho-stock',DATA.warehouse.filter(w=>(+w.OnHand||0)>0).length);
const pm=d.paymentBreakdown||{},totR=d.totalRevenue||1;if($('d-pay'))$('d-pay').innerHTML=Object.entries(pm).map(([m,v])=>{const pct=Math.round(v/totR*100);return`<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px"><span>${m}</span><span class="fw7">${fmt(v)} (${pct}%)</span></div><div style="background:var(--gray1);border-radius:4px;height:7px"><div style="background:var(--accent2);width:${pct}%;height:100%;border-radius:4px"></div></div></div>`;}).join('')||'<div style="color:var(--gray3);font-size:11px;padding:14px;text-align:center">Load data first</div>';
if($('d-low'))$('d-low').innerHTML=(d.lowStock||[]).slice(0,8).map(i=>`<tr><td style="font-size:11px">${i.store||'—'}</td><td class="fw7" style="font-size:11px">${String(i.name||i.barcode||'').slice(0,28)}</td><td style="font-weight:800;color:${+i.onHand<=0?'var(--red)':'var(--amber)'}">${i.onHand}</td><td><button class="btn btn-green btn-sm" onclick="show('store-grn')">📦</button></td></tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:var(--gray3);padding:14px">No alerts</td></tr>';}
const stores=DATA.stores.length?DATA.stores.filter(s=>s.StoreID!=='HO'):[{StoreID:'s1',Name:'Store 1 — Tripoli'},{StoreID:'s2',Name:'Store 2 — Benghazi'},{StoreID:'s3',Name:'Store 3 — Misrata'}];
const sb=DATA.dashboard?.storeBreakdown||[];if($('store-cards'))$('store-cards').innerHTML=stores.map(s=>{const b=sb.find(x=>x.store===s.Name||x.store===s.StoreID||x.name===s.Name);return`<div class="store-card"><div style="display:flex;justify-content:space-between;margin-bottom:10px"><div style="font-weight:800;color:var(--navy)">${s.Name}</div><span class="badge ${b?'badge-green':'badge-gray'}">${b?'✅ Live':'No Data'}</span></div>${b?`<div class="store-kpis"><div class="store-kpi"><div class="store-kpi-label">Revenue</div><div class="store-kpi-value">${fmt(b.revenue||0)}</div></div><div class="store-kpi"><div class="store-kpi-label">Invoices</div><div class="store-kpi-value">${b.invoices||0}</div></div><div class="store-kpi"><div class="store-kpi-label">Returns</div><div class="store-kpi-value">${fmt(b.returns||0)}</div></div><div class="store-kpi"><div class="store-kpi-label">Net</div><div class="store-kpi-value">${fmt((b.revenue||0)-(b.returns||0))}</div></div></div>`:'<div style="text-align:center;padding:16px;color:var(--gray3);font-size:12px">No data</div>'}</div>`;}).join('');}
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
async function saveSGRN(){
  if(!sgrnLines.length){toast('Add lines','error');return;}
  const grnId=$('sgrn-id').value||('SGRN-'+Date.now().toString().slice(-6));
  const meta={grnId,date:$('sgrn-date').value,supplier:$('sgrn-supplier').value,invoiceNo:$('sgrn-inv').value,notes:$('sgrn-notes').value};
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
let selectedGrnLines=new Set();
async function fetchAndRenderSGRNHist(){
  const offset=(sgrnHistCurrentPage-1)*sgrnHistPageSize;
  const qs=new URLSearchParams({limit:String(sgrnHistPageSize),offset:String(offset)});
  if(sgrnHistSearchQuery)qs.set('q',sgrnHistSearchQuery);
  const countQs=new URLSearchParams();if(sgrnHistSearchQuery)countQs.set('q',sgrnHistSearchQuery);
  if($('sgrn-hist'))$('sgrn-hist').innerHTML='<tr><td colspan="9" style="text-align:center;color:var(--gray3);padding:13px">⏳ Loading…</td></tr>';
  try{
    const [rowsRes,countRes]=await Promise.all([
      api('/api/ho/supplier-grns?'+qs.toString()),
      api('/api/ho/supplier-grns/count?'+countQs.toString()),
    ]);
    sgrnHistPageItems=(rowsRes&&rowsRes.data)?rowsRes.data:[];
    sgrnHistTotalCount=(countRes&&typeof countRes.count==='number')?countRes.count:sgrnHistPageItems.length;
  }catch(_e){sgrnHistPageItems=[];sgrnHistTotalCount=0;toast('❌ Failed to load GRN history','error');}
  renderSGRNHistTable();
  renderSGRNHistPagination();
}
function renderSGRNHistTable(){
  if($('sgrn-hist'))$('sgrn-hist').innerHTML=sgrnHistPageItems.map(g=>{
    const checked=selectedGrnLines.has(g.id)?'checked':'';
    return `<tr><td><input type="checkbox" ${checked} onchange="toggleGrnLine(${g.id})"></td><td class="fw7">${g.GRNID}</td><td>${g.Date}</td><td>${g.Supplier}</td><td>${g.InvoiceNo||'—'}</td><td>${(g.Name||'').slice(0,28)}</td><td>${g.Qty}</td><td>${fmt(g.UnitCost||0)}</td><td><button class="btn btn-ghost btn-sm" onclick="deleteSupplierGRNLine(${g.id})" title="Delete this line only — reverses just this line's stock">🗑</button></td></tr>`;
  }).join('')||'<tr><td colspan="9" style="text-align:center;color:var(--gray3);padding:13px">No GRN lines</td></tr>';
  const selAll=$('sgrn-hist-select-all');
  if(selAll)selAll.checked=sgrnHistPageItems.length>0&&sgrnHistPageItems.every(g=>selectedGrnLines.has(g.id));
  updateSgrnHistSelectedInfo();
}
function toggleGrnLine(id){if(selectedGrnLines.has(id))selectedGrnLines.delete(id);else selectedGrnLines.add(id);renderSGRNHistTable();}
function toggleAllGrnLines(cb){
  if(cb.checked)sgrnHistPageItems.forEach(g=>selectedGrnLines.add(g.id));
  else sgrnHistPageItems.forEach(g=>selectedGrnLines.delete(g.id));
  renderSGRNHistTable();
}
async function selectAllMatchingGrnLines(){
  if(!sgrnHistTotalCount){toast('Nothing to select','warn');return;}
  if(sgrnHistTotalCount>3000&&!confirm(`Select all ${sgrnHistTotalCount} matching line(s)? This fetches the full matching list once.`))return;
  toast('⏳ Selecting all matching lines…','info');
  const qs=new URLSearchParams({limit:String(sgrnHistTotalCount)});
  if(sgrnHistSearchQuery)qs.set('q',sgrnHistSearchQuery);
  const res=await api('/api/ho/supplier-grns?'+qs.toString());
  if(res&&res.data){res.data.forEach(g=>selectedGrnLines.add(g.id));renderSGRNHistTable();toast(`✅ ${selectedGrnLines.size} line(s) selected`);}
  else toast('❌ Failed to select all — try again','error');
}
function clearGrnLineSelection(){selectedGrnLines=new Set();renderSGRNHistTable();}
function updateSgrnHistSelectedInfo(){
  const el=$('sgrn-hist-selected-info');
  if(!el)return;
  el.textContent=selectedGrnLines.size?`✅ ${selectedGrnLines.size} line(s) selected · ${sgrnHistTotalCount} total match`:`${sgrnHistTotalCount} line(s) total`;
}
async function deleteSupplierGRNLine(id){
  if(!confirm('Delete this GRN line? This reverses its qty from HO Warehouse stock.'))return;
  const res=await api('/api/ho/supplier-grn-line/'+id,{method:'DELETE'});
  if(res&&res.ok){toast('🗑️ Deleted');selectedGrnLines.delete(id);await loadAll();await fetchAndRenderSGRNHist();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Delete failed'),'error');
}
async function deleteSelectedGrnLines(){
  if(!selectedGrnLines.size){toast('No lines selected','error');return;}
  if(!confirm(`Delete ${selectedGrnLines.size} selected GRN line(s)? This reverses their qty from HO Warehouse stock. This cannot be undone.`))return;
  const res=await api('/api/ho/supplier-grn-lines/bulk-delete',{method:'POST',body:Array.from(selectedGrnLines)});
  if(res&&res.ok){toast(`🗑️ Deleted ${res.deleted} line(s)`);selectedGrnLines=new Set();await loadAll();await fetchAndRenderSGRNHist();}
  else toast('❌ Delete failed','error');
}
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

async function fetchAndRenderStGRNPending(){
  const offset=(stgrnPendingCurrentPage-1)*stgrnPendingPageSize;
  const qs=new URLSearchParams({status:'pending',limit:String(stgrnPendingPageSize),offset:String(offset)});
  if(stgrnPendingSearchQuery)qs.set('q',stgrnPendingSearchQuery);
  const countQs=new URLSearchParams({status:'pending'});if(stgrnPendingSearchQuery)countQs.set('q',stgrnPendingSearchQuery);
  if($('stgrn-pending'))$('stgrn-pending').innerHTML='<tr><td colspan="9" style="text-align:center;color:var(--gray3);padding:13px">⏳ Loading…</td></tr>';
  try{
    const [rowsRes,countRes]=await Promise.all([
      api('/api/ho/store-grns?'+qs.toString()),
      api('/api/ho/store-grns/count?'+countQs.toString()),
    ]);
    stgrnPendingPageItems=(rowsRes&&rowsRes.data)?rowsRes.data:[];
    stgrnPendingTotalCount=(countRes&&typeof countRes.count==='number')?countRes.count:stgrnPendingPageItems.length;
  }catch(_e){stgrnPendingPageItems=[];stgrnPendingTotalCount=0;toast('❌ Failed to load pending GRNs','error');}
  renderStGRNPendingTable();
  renderStGRNPendingPagination();
}
function renderStGRNPendingTable(){
  if($('stgrn-pending'))$('stgrn-pending').innerHTML=stgrnPendingPageItems.map(g=>{
    const checked=selectedStGRN.has(g.GRNID)?'checked':'';
    return `<tr><td><input type="checkbox" ${checked} onchange="toggleStGRNRow('${g.GRNID}')"></td><td class="fw7">${g.GRNID}</td><td>${g.Date}</td><td>${g.StoreName}</td><td>${(g.Name||'').slice(0,25)}</td><td>${g.QtyIssued}</td><td>—</td><td><span class="badge badge-amber">Pending</span></td><td><button class="btn btn-ghost btn-sm" onclick="deleteStoreGRN('${g.GRNID}',this)" title="Delete — mistake ho jaye to yahan se undo karein">🗑</button></td></tr>`;
  }).join('')||'<tr><td colspan="9" style="text-align:center;color:var(--gray3);padding:13px">No pending</td></tr>';
  const selAll=$('stgrn-select-all');
  if(selAll)selAll.checked=stgrnPendingPageItems.length>0&&stgrnPendingPageItems.every(g=>selectedStGRN.has(g.GRNID));
  const info=$('stgrn-selected-info');
  if(info)info.textContent=selectedStGRN.size?`✅ ${selectedStGRN.size} GRN(s) selected`:`${stgrnPendingTotalCount} pending GRN line(s) total`;
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
  const idsOnPage=[...new Set(stgrnPendingPageItems.map(g=>g.GRNID))];
  if(cb.checked)idsOnPage.forEach(id=>selectedStGRN.add(id));
  else idsOnPage.forEach(id=>selectedStGRN.delete(id));
  renderStGRNPendingTable();
}
async function selectAllMatchingStGRN(){
  if(!stgrnPendingTotalCount){toast('Nothing to select','warn');return;}
  if(stgrnPendingTotalCount>3000&&!confirm(`Select all ${stgrnPendingTotalCount} matching line(s)? This fetches the full matching list once.`))return;
  toast('⏳ Selecting all matching…','info');
  const qs=new URLSearchParams({status:'pending',limit:String(stgrnPendingTotalCount)});
  if(stgrnPendingSearchQuery)qs.set('q',stgrnPendingSearchQuery);
  const res=await api('/api/ho/store-grns?'+qs.toString());
  if(res&&res.data){res.data.forEach(g=>selectedStGRN.add(g.GRNID));renderStGRNPendingTable();toast(`✅ ${selectedStGRN.size} GRN(s) selected`);}
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
  const countQs=new URLSearchParams({status:'received'});if(stgrnDoneSearchQuery)countQs.set('q',stgrnDoneSearchQuery);
  if($('stgrn-done'))$('stgrn-done').innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:13px">⏳ Loading…</td></tr>';
  try{
    const [rowsRes,countRes]=await Promise.all([
      api('/api/ho/store-grns?'+qs.toString()),
      api('/api/ho/store-grns/count?'+countQs.toString()),
    ]);
    stgrnDonePageItems=(rowsRes&&rowsRes.data)?rowsRes.data:[];
    stgrnDoneTotalCount=(countRes&&typeof countRes.count==='number')?countRes.count:stgrnDonePageItems.length;
  }catch(_e){stgrnDonePageItems=[];stgrnDoneTotalCount=0;}
  if($('stgrn-done'))$('stgrn-done').innerHTML=stgrnDonePageItems.map(g=>`<tr><td class="fw7">${g.GRNID}</td><td>${g.Date}</td><td>${g.StoreName}</td><td>${(g.Name||'').slice(0,25)}</td><td>${g.QtyReceived}</td><td><span class="badge badge-green">Received</span></td></tr>`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:13px">None</td></tr>';
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
  const wh=(DATA.warehouse||[]).find(w=>String(w.Barcode)===String(p.Barcode));
  if($('p-op'))$('p-op').value=wh?(+wh.OnHand||0):0;
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
  if($('prod-table'))$('prod-table').innerHTML=prodPageItems.map(p=>{const m=p.Cost&&p.Retail?((p.Retail-p.Cost)/p.Retail*100).toFixed(1):'—';const wh=(DATA.warehouse||[]).find(w=>String(w.Barcode)===String(p.Barcode));const qty=wh?(+wh.OnHand||0):0;const checked=selectedProducts.has(p.Barcode)?'checked':'';return`<tr><td><input type="checkbox" ${checked} onchange="toggleProduct('${p.Barcode}')"></td><td style="font-family:monospace;font-size:10px">${p.Barcode}</td><td>${qty}</td><td>${fmt(p.Cost||0)}</td><td>${fmt(p.OriginalPrice||0)}</td><td>${fmt(p.Retail||0)}</td><td class="fw7">${p.Name}</td><td>${p.Brand||'ANTA'}</td><td>${p.Category||''}</td><td>${p.Department||''}</td><td>${p.Season||''}</td><td>${p.Gender||''}</td><td>${p.Size||'—'}</td><td>${p.Color||''}</td><td>${m}%</td><td>${p.Reorder||5}</td><td><span class="badge badge-green">Active</span></td><td><button class="btn btn-ghost btn-sm" onclick="editProduct('${p.Barcode}')">✏️</button> <button class="btn btn-ghost btn-sm" onclick="deleteProduct('${p.Barcode}')">🗑️</button></td></tr>`;}).join('')||'<tr><td colspan="18" style="text-align:center;color:var(--gray3);padding:18px">No products found</td></tr>';
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
  if($('p-op'))$('p-op').value=0;
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
    opening:+($('p-op')?.value||0),qty:+($('p-op')?.value||0),active:true,
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
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['Barcode,Name,Brand,Category,Department,Season,Gender,Size,Color,Cost,Original Price,Retail,Reorder,Qty\n8001000000009,ANTA Sample Shoe,ANTA,Running,Footwear,SS26,Men,42,White,120,180,180,5,25\n'],{type:'text/csv'}));a.download='products_template.csv';document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    return;
  }
  const wb=new ExcelJS.Workbook();
  const ws=wb.addWorksheet('Products');
  const headers=['Barcode','Name','Brand','Category','Department','Season','Gender','Size','Color','Cost','Original Price','Retail','Reorder','Qty'];
  ws.addRow(headers);
  ws.getRow(1).font={bold:true};
  ws.addRow(['8001000000009','ANTA Sample Shoe','ANTA','Running','Footwear','SS26','Men','42','White',120,180,180,5,25]);
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
    const qtyRaw=get('qty');
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
    const item={barcode,name,brand:get('brand')||'ANTA',category:get('category')||'',department:get('department')||'',season:get('season')||'',gender:get('gender')||'',size:get('size')||'',color:get('color')||'',cost:+(get('cost')||0),retail:+(get('retail')||0),reorder:+(get('reorder')||5),opening:+(qtyRaw||0),qty:+(qtyRaw||0),active:true};
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
async function loadPL(){const qs=new URLSearchParams();if($('pl-from')?.value)qs.set('from',$('pl-from').value);if($('pl-to')?.value)qs.set('to',$('pl-to').value);if($('pl-store')?.value)qs.set('store',$('pl-store').value);const pl=await api('/api/ho/pl?'+qs);if(!pl||!pl.ok){toast('P&L failed','error');return;}if($('pl-kpis'))$('pl-kpis').innerHTML=[['Revenue',fmt(pl.revenue),''],['COGS',fmt(pl.cogs),'amber'],['Gross Profit',fmt(pl.grossProfit),'green'],['GM%',((pl.grossMargin||0)*100).toFixed(1)+'%','blue'],['Expenses',fmt(pl.totalExpenses),'purple'],['EBITDA',fmt(pl.ebitda),'teal']].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');const rows=[['Net Revenue','netRevenue'],['COGS','cogs'],['Gross Profit','grossProfit'],['Gross Margin %','grossMargin',true],['Total Expenses','totalExpenses'],['EBITDA','ebitda']];if($('pl-table'))$('pl-table').innerHTML=rows.map(([label,key,pct])=>`<tr style="${key==='ebitda'||key==='grossProfit'?'font-weight:800;background:var(--gray0)':''}"><td>${label}</td><td class="text-right fw7">${pct?((pl[key]||0)*100).toFixed(1)+'%':fmt(pl[key]||0)}</td><td class="text-right">${pct?'':pl.netRevenue?((pl[key]||0)/pl.netRevenue*100).toFixed(1)+'%':'—'}</td></tr>`).join('');}
async function loadExpenses(){const el=$('exp-ho-table')||$('exp-table');if(!el)return;const qs=new URLSearchParams();const sid=$('exp-store-filter')&&$('exp-store-filter').value;if(sid&&sid!=='all')qs.set('store_id',sid);const res=await api('/api/expenses?limit=300'+(qs.toString()?'&'+qs.toString():''));const rows=(res&&res.data)||DATA.expenses||[];DATA.expenses=rows.map(e=>({...e,Date:e.date||e.Date,Amount:e.amount!=null?e.amount:e.Amount,Store:e.store||e.Store,StoreID:e.storeId||e.StoreID,Category:e.category||e.Category,Description:e.description||e.Description||'',PayMethod:e.payMethod||e.PayMethod||''}));el.innerHTML=DATA.expenses.map(e=>`<tr><td>${e.Date||''}</td><td>${e.Store||''}</td><td>${e.Category||''}</td><td>${e.Description||''}</td><td class="fw7">${fmt(e.Amount||0)}</td><td>${e.PayMethod||''}</td></tr>`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--gray3)">No expenses</td></tr>';}

function rptPreset(){const p=($('rpt-preset')||{}).value||'today',d=today(),now=new Date();if(!$('rpt-from'))return;if(p==='today'){$('rpt-from').value=d;$('rpt-to').value=d;}else if(p==='yesterday'){const y=new Date(now);y.setDate(y.getDate()-1);const yd=y.toISOString().split('T')[0];$('rpt-from').value=yd;$('rpt-to').value=yd;}else if(p==='week'){const ws=new Date(now);ws.setDate(now.getDate()-now.getDay());$('rpt-from').value=ws.toISOString().split('T')[0];$('rpt-to').value=d;}else{$('rpt-from').value=d.slice(0,7)+'-01';$('rpt-to').value=d;}}
async function loadReports(){const qs=new URLSearchParams();if($('rpt-from')?.value)qs.set('from',$('rpt-from').value);if($('rpt-to')?.value)qs.set('to',$('rpt-to').value);if($('rpt-store')?.value&&$('rpt-store').value!=='all')qs.set('store',$('rpt-store').value);const res=await api('/api/reports?'+qs);if(!res||!res.ok){toast('Report failed','error');return;}window.__lastReport=res;if($('rpt-kpis'))$('rpt-kpis').innerHTML=[['Revenue',fmt(res.revenue),''],['Net',fmt(res.net),'blue'],['Invoices',res.invoices,'green'],['ATV',fmt(res.atv),'amber'],['Units',res.units,'purple'],['Cost',fmt(res.totalCost||0),''],['Profit',fmt(res.totalProfit||0),'green'],['Margin',(res.margin||0)+'%','teal'],['Returns',fmt(res.returns),'']].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');const pm=res.paymentBreakdown||{},rev=res.revenue||0;if($('rpt-pay'))$('rpt-pay').innerHTML=Object.entries(pm).map(([m,v])=>{const pct=rev?Math.round(v/rev*100):0;return`<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:11px"><span>${m}</span><span class="fw7">${fmt(v)} (${pct}%)</span></div><div style="background:var(--gray1);border-radius:4px;height:7px"><div style="background:var(--accent2);width:${pct}%;height:100%;border-radius:4px"></div></div></div>`;}).join('')||'<div style="color:var(--gray3);padding:14px;text-align:center">No data</div>';if($('rpt-prod'))$('rpt-prod').innerHTML=(res.productBreakdown||[]).map(p=>`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--gray1);font-size:11px"><span class="fw7">${p.name}</span><span>${p.qty} · ${fmt(p.revenue)}</span></div>`).join('')||'<div style="color:var(--gray3);padding:14px;text-align:center">No data</div>';if($('rpt-txns'))$('rpt-txns').innerHTML=(res.transactions||[]).slice(0,150).map(x=>`<tr><td class="fw7">${x.id}</td><td>${x.date||''}</td><td>${x.time||''}</td><td>${x.store||''}</td><td>${x.customer||''}</td><td style="text-align:center">${x.items||0}</td><td style="text-align:center">${x.units||0}</td><td style="font-size:10px;max-width:220px">${x.productList||''}</td><td>${fmt(x.subtotal||0)}</td><td>${fmt(x.discount||0)}</td><td>${fmt(x.cost||0)}</td><td class="fw7" style="color:var(--green)">${fmt(x.profit||0)}</td><td>${x.margin||0}%</td><td>${x.payment||''}</td><td>${x.payRef||''}</td><td class="fw7">${fmt(x.total||0)}</td></tr>`).join('')||'<tr><td colspan="16" style="text-align:center;color:var(--gray3);padding:14px">None</td></tr>';}
function exportRpt(){const rows=(window.__lastReport&&window.__lastReport.transactions)||[];const esc=v=>{const s=String(v==null?'':v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};const header=['Invoice','Date','Time','Store','Customer','Items','Units','Products','Subtotal','Discount','Cost','Profit','Margin%','Payment','Ref','Total'];const csv=[header.join(',')].concat(rows.map(x=>[x.id,x.date,x.time,x.store,x.customer,x.items,x.units,x.productList,x.subtotal,x.discount,x.cost,x.profit,x.margin,x.payment,x.payRef,x.total].map(esc).join(','))).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='anta_ho_report_'+today()+'.csv';a.click();}
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
function renderStoresAdmin(){const el=$('stores-table')||$('stores-admin-table')||$('sa-table');if(!el)return;const rows=DATA.stores||[];el.innerHTML=rows.map(s=>`<tr><td class="fw7">${s.StoreID||s.store_id||''}</td><td>${s.Name||s.name||''}</td><td>${s.City||s.city||''}</td><td>${s.Manager||s.manager||''}</td><td>${s.Phone||s.phone||''}</td><td><span class="badge badge-green">${(s.Active==='N'||s.active===false)?'Inactive':'Active'}</span></td><td><button class="btn btn-ghost btn-sm" onclick="editStore('${s.StoreID||s.store_id||''}')">Edit</button></td></tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--gray3);padding:14px">No stores yet</td></tr>';}
function showAddStore(){const f=$('store-form')||$('add-store-form');if(f)f.style.display='flex';['st-id','st-nm','st-city','st-addr','st-mgr','st-ph'].forEach(id=>{const el=$(id);if(el){el.value='';if(id==='st-id')el.disabled=false;}});} 
function editStore(id){const s=(DATA.stores||[]).find(x=>(x.StoreID||x.store_id)===id);const f=$('store-form')||$('add-store-form');if(!s||!f)return;f.style.display='flex';if($('st-id')){$('st-id').value=s.StoreID||s.store_id||'';$('st-id').disabled=true;}if($('st-nm'))$('st-nm').value=s.Name||s.name||'';if($('st-city'))$('st-city').value=s.City||s.city||'';if($('st-addr'))$('st-addr').value=s.Address||s.address||'';if($('st-mgr'))$('st-mgr').value=s.Manager||s.manager||'';if($('st-ph'))$('st-ph').value=s.Phone||s.phone||'';}
function closeStoreForm(){const f=$('store-form')||$('add-store-form');if(f)f.style.display='none';if($('st-id'))$('st-id').disabled=false;}
async function saveStore(){const idEl=$('st-id'),nmEl=$('st-nm');const body={store_id:(idEl&&idEl.value||'').trim(),name:(nmEl&&nmEl.value||'').trim(),city:($('st-city')&&$('st-city').value)||'',address:($('st-addr')&&$('st-addr').value)||'',manager:($('st-mgr')&&$('st-mgr').value)||'',phone:($('st-ph')&&$('st-ph').value)||'',active:true};if(!body.store_id||!body.name){toast('Store ID + Name required','error');return;}const res=await api('/api/stores',{method:'POST',body});if(res&&(res.store_id||res.ok!==false)&&!res.detail){toast('✅ Store saved');closeStoreForm();await loadAll();renderStoresAdmin();renderDash&&renderDash();}else{const msg=(res&&(res.detail||res.msg))||'Failed';toast(typeof msg==='string'?msg:'Failed','error');}}
function renderUsers(){const el=$('users-table')||$('u-table');if(el)el.innerHTML=DATA.users.map(u=>`<tr><td class="fw7">${u.UserID}</td><td>${u.Name}</td><td>${u.StoreName||u.StoreID}</td><td><span class="badge badge-blue">${u.Role}</span></td><td><span class="badge ${u.Active==='N'?'badge-red':'badge-green'}">${u.Active==='N'?'Inactive':'Active'}</span></td><td><button class="btn btn-ghost btn-sm" onclick="editUser('${u.UserID}')">✏️</button> <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="toggleUserActive('${u.UserID}')">${u.Active==='N'?'✅ Activate':'🚫 Deactivate'}</button></td></tr>`).join('');}
let editingUserId=null;
function showAddUser(){editingUserId=null;if($('user-form')){$('user-form').style.display='flex';['u-nm','u-pin'].forEach(id=>{if($(id))$(id).value='';});if($('u-role'))$('u-role').value='cashier';if($('u-pin'))$('u-pin').placeholder='4-digit PIN';const t=document.querySelector('#user-form .modal-title');if(t)t.textContent='➕ Add User';}}
function editUser(userId){
  const u=DATA.users.find(x=>x.UserID===userId);
  if(!u){toast('User not found','error');return;}
  editingUserId=userId;
  if($('user-form'))$('user-form').style.display='flex';
  if($('u-nm'))$('u-nm').value=u.Name||'';
  if($('u-role'))$('u-role').value=u.Role||'cashier';
  if($('u-store'))$('u-store').value=u.StoreID||'';
  if($('u-pin')){$('u-pin').value='';$('u-pin').placeholder='Leave blank to keep current PIN';}
  const t=document.querySelector('#user-form .modal-title');if(t)t.textContent='✏️ Edit User — '+u.Name;
}
async function toggleUserActive(userId){
  const u=DATA.users.find(x=>x.UserID===userId);
  if(!u)return;
  const newActive=u.Active==='N';
  if(!confirm(`${newActive?'Activate':'Deactivate'} ${u.Name}?`))return;
  const res=await api('/api/auth/users',{method:'POST',body:{user_id:userId,store_id:u.StoreID,store_name:u.StoreName,name:u.Name,role:u.Role,active:newActive}});
  if(res&&res.user_id){toast('✅ Updated');await loadAll();renderUsers();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function closeUserForm(){if($('user-form'))$('user-form').style.display='none';editingUserId=null;}
async function saveUser(){
  const storeId=$('u-store').value;
  const body={
    store_id:storeId,
    store_name:storeId==='HO'?'Head Office':((DATA.stores.find(s=>s.StoreID===storeId)||{}).Name||''),
    name:$('u-nm').value.trim(),
    role:$('u-role').value,
    active:true,
  };
  if(editingUserId)body.user_id=editingUserId;
  const pin=$('u-pin').value.trim();
  if(pin)body.pin=pin;
  if(!body.name){toast('Name required','error');return;}
  if(!editingUserId&&!pin){toast('PIN required for a new user','error');return;}
  const res=await api('/api/auth/users',{method:'POST',body});
  if(res&&res.user_id){toast(editingUserId?'✅ User updated':'✅ User saved');closeUserForm();await loadAll();renderUsers();}
  else toast('❌ '+((res&&(res.detail||res.msg))||'Failed'),'error');
}
function renderBanks(){const el=$('banks-table')||$('b-table');if(el)el.innerHTML=DATA.banks.map(b=>`<tr><td class="fw7">${b.BankID}</td><td>${b.Name}</td><td>${b.Device||'—'}</td><td><span class="badge badge-green">Active</span></td></tr>`).join('');}
function showAddBank(){if($('bank-form')){$('bank-form').style.display='flex';['b-nm','b-acc','b-dev'].forEach(id=>{if($(id))$(id).value='';});if($('b-act'))$('b-act').value='Y';}}function editBank(){}
function closeBankForm(){if($('bank-form'))$('bank-form').style.display='none';}
async function saveBank(){const body={name:$('b-nm').value.trim(),account_no:$('b-acc')?.value||'',device:$('b-dev')?.value||'',active:($('b-act')?.value||'Y')==='Y'};if(!body.name){toast('Name required','error');return;}const res=await api('/api/banks',{method:'POST',body});if(res&&res.bank_id){toast('✅ Bank saved');closeBankForm();await loadAll();renderBanks();}else toast('❌ '+((res&&res.msg)||'Failed'),'error');}
async function loadBalanceSheet(){const res=await api('/api/ho/balance-sheet');if(!res||!res.ok){toast('BS failed','error');return;}const row=i=>`<tr><td>${i.label}${i.auto?' <span style="font-size:9px;color:var(--accent2)">auto</span>':''}</td><td class="text-right fw7">${fmt(i.value)}</td></tr>`;const set=(id,h)=>{if($(id))$(id).innerHTML=h;};const setT=(id,v)=>{if($(id))$(id).textContent=v;};set('bs-current-assets',(res.currentAssets||[]).map(row).join(''));set('bs-fixed-assets',(res.fixedAssets||[]).length?(res.fixedAssets||[]).map(row).join(''):'<tr><td style="color:var(--gray3);font-size:11px">No fixed assets</td><td></td></tr>');set('bs-liabilities',(res.liabilities||[]).map(row).join(''));set('bs-equity',(res.equity||[]).map(row).join(''));setT('bs-total-assets',fmt(res.totalAssets||0));setT('bs-total-liab',fmt(res.totalLiabilities||0));setT('bs-total-equity',fmt(res.totalEquity||0));setT('bs-total-le',fmt(res.totalLiabEquity||0));}
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
  _csvDownload(all,[['Barcode','barcode'],['Name','name'],['Brand','brand'],['Category','category'],['Department','department'],['Season','season'],['Gender','gender'],['Size','size'],['Color','color'],['Cost','cost'],['Original Price','originalPrice'],['Retail','retail'],['Reorder','reorder'],['Qty','opening']],'products_'+today()+'.csv');
}
function saveBSEntries(){}function exportBS(){toast('Use browser print','info');}
function cfPreset(){const p=($('cf-period')||{}).value||'month',d=today();if(!$('cf-from'))return;if(p==='year'){$('cf-from').value=d.slice(0,4)+'-01-01';$('cf-to').value=d;}else{$('cf-from').value=d.slice(0,7)+'-01';$('cf-to').value=d;}}
async function loadCashFlow(){const qs=new URLSearchParams();if($('cf-from')?.value)qs.set('from',$('cf-from').value);if($('cf-to')?.value)qs.set('to',$('cf-to').value);qs.set('opening',String(parseFloat($('cf-opening-input')?.value)||0));const res=await api('/api/ho/cashflow?'+qs);if(!res||!res.ok){toast('CF failed','error');return;}const row=i=>`<tr><td>${i.label}</td><td class="text-right fw7" style="color:${i.value>=0?'var(--green)':'var(--red)'}">${fmt(i.value)}</td></tr>`;const set=(id,h)=>{if($(id))$(id).innerHTML=h;};const setT=(id,v,c)=>{if($(id)){$(id).textContent=v;if(c)$(id).style.color=c;}};set('cf-operating',(res.operating||[]).map(row).join(''));setT('cf-op-total',fmt(res.operatingTotal||0),(res.operatingTotal||0)>=0?'var(--green)':'var(--red)');set('cf-investing',(res.investing||[]).length?(res.investing||[]).map(row).join(''):'<tr><td style="color:var(--gray3);font-size:11px">No entries</td><td></td></tr>');setT('cf-inv-total',fmt(res.investingTotal||0));set('cf-financing',(res.financing||[]).length?(res.financing||[]).map(row).join(''):'<tr><td style="color:var(--gray3);font-size:11px">No entries</td><td></td></tr>');setT('cf-fin-total',fmt(res.financingTotal||0));setT('cf-opening',fmt(res.opening||0));setT('cf-net',fmt(res.netCashFlow||0),(res.netCashFlow||0)>=0?'#4caf50':'#f44336');setT('cf-closing',fmt(res.closing||0));if($('cf-status'))$('cf-status').textContent=(res.closing||0)>=0?'✅ Positive':'⚠️ Negative';}
async function addCFItem(type){const d=$(type==='investing'?'cf-inv-desc':'cf-fin-desc'),a=$(type==='investing'?'cf-inv-amt':'cf-fin-amt');if(!d||!a||!d.value)return;const res=await api('/api/ho/cf-items',{method:'POST',body:{section:type,label:d.value,value:parseFloat(a.value)||0}});if(res&&res.ok){d.value='';a.value='';loadCashFlow();toast('✅ Added');}}
function calcCF(){loadCashFlow();}function saveCFItems(){}function exportCF(){toast('Use browser print','info');}
async function saveSupplier(){const name=$('sup-name').value.trim();if(!name){toast('Enter name','error');return;}const res=await api('/api/ho/suppliers',{method:'POST',body:{name,contact:$('sup-contact').value,limit:parseFloat($('sup-limit').value)||0,terms:$('sup-terms').value}});if(res&&res.ok){toast('✅ Supplier saved');['sup-name','sup-contact','sup-limit'].forEach(id=>{if($(id))$(id).value='';});await loadAll();renderSupplierAccounts();}else toast('❌ Failed','error');}
async function saveSupplierTxn(){const supId=$('sup-txn-supplier').value,amt=parseFloat($('sup-txn-amt').value)||0;if(!supId||!amt){toast('Select supplier + amount','error');return;}const res=await api('/api/ho/supplier-txns',{method:'POST',body:{supplierId:supId,date:$('sup-txn-date').value,type:$('sup-txn-type').value,amount:amt,ref:$('sup-txn-ref').value}});if(res&&res.ok){toast('✅ Recorded');['sup-txn-amt','sup-txn-ref'].forEach(id=>{if($(id))$(id).value='';});await loadAll();renderSupplierAccounts();}else toast('❌ Failed','error');}
function populateSupplierSelect(){if($('sup-txn-supplier'))$('sup-txn-supplier').innerHTML=suppliers.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');}
function renderSupplierAccounts(){if($('sup-balances'))$('sup-balances').innerHTML=suppliers.map(b=>`<tr><td class="fw7">${b.name}</td><td>${b.terms||''}</td><td>${fmt(b.invoiced||0)}</td><td class="text-green">${fmt(b.paid||0)}</td><td class="fw7" style="color:${b.balance>0?'var(--red)':b.balance<0?'var(--green)':'var(--navy)'}">${fmt(Math.abs(b.balance||0))} ${b.balance>0?'DUE':b.balance<0?'CREDIT':''}</td><td><span class="badge ${b.balance<=0?'badge-green':'badge-amber'}">${b.balance<=0?'Paid':'Pending'}</span></td></tr>`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--gray3);padding:16px">No suppliers</td></tr>';
if($('sup-txns'))$('sup-txns').innerHTML=supplierTxns.slice(0,15).map(t=>`<tr><td>${t.date}</td><td>${t.supplierName}</td><td><span class="badge ${t.type==='payment'?'badge-green':'badge-amber'}">${t.type}</span></td><td class="fw7">${fmt(t.amount)}</td><td>${t.ref||'—'}</td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--gray3);padding:16px">No txns</td></tr>';populateSupplierSelect();}
function saveSuppliers(){}function saveSupplierTxns(){}function getSupplierTxns(){return supplierTxns;}function getSupplierBalances(){return suppliers;}
async function saveCapitalEntry(){const type=$('cap-type').value,date=$('cap-date').value,amt=parseFloat($('cap-amt').value)||0,desc=$('cap-desc').value.trim();if(!amt||!desc){toast('Fill fields','error');return;}const res=await api('/api/ho/capital',{method:'POST',body:{type,date,amount:amt,description:desc}});if(res&&res.ok){toast('✅ Saved');['cap-amt','cap-desc'].forEach(id=>{if($(id))$(id).value='';});await loadAll();renderCapital();}else toast('❌ Failed','error');}
function renderCapital(){const invested=capitalEntries.filter(c=>c.type==='investment').reduce((a,c)=>a+(+c.amount||0),0);const withdrawn=capitalEntries.filter(c=>c.type==='withdrawal').reduce((a,c)=>a+(+c.amount||0),0);const loans=capitalEntries.filter(c=>c.type==='loan').reduce((a,c)=>a+(+c.amount||0),0);const loanRepaid=capitalEntries.filter(c=>c.type==='loan-repay').reduce((a,c)=>a+(+c.amount||0),0);const netProfit=(DATA.dashboard?.netRevenue||0)-DATA.expenses.reduce((a,e)=>a+(+e.Amount||0),0);const totalEquity=invested-withdrawn+loans-loanRepaid+netProfit;if($('cap-kpis'))$('cap-kpis').innerHTML=[['Total Invested',fmt(invested),'green'],['Total Withdrawn',fmt(withdrawn),''],['Net Loans',fmt(loans-loanRepaid),'amber'],['Net Profit',fmt(netProfit),'blue'],['Total Equity',fmt(totalEquity),'purple']].map(([l,v,c])=>`<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');if($('cap-table'))$('cap-table').innerHTML=capitalEntries.map(c=>{const isOut=c.type==='withdrawal'||c.type==='loan-repay';return`<tr><td><span class="badge badge-blue">${c.type}</span></td><td>${c.date}</td><td>${c.desc}</td><td class="text-right fw7" style="color:${isOut?'var(--red)':'var(--green)'}">${isOut?'-':'+'} ${fmt(c.amount)}</td></tr>`;}).join('')||'<tr><td colspan="4" style="text-align:center;color:var(--gray3);padding:16px">No entries</td></tr>';}
function saveCapital(){}
async function testConn(){const url=($('api-url')&&$('api-url').value.trim())||CFG.apiUrl;CFG.apiUrl=url.replace(/\/$/,'');localStorage.setItem('anta_ho_api',CFG.apiUrl);const div=$('conn-res');if(div){div.style.display='block';div.innerHTML='⏳ Testing...';}const res=await api('/api/health');if(res&&res.ok){if(div){div.innerHTML='✅ Connected! '+res.app+' v'+res.version;div.style.color='var(--green)';}setSyncStatus('online','Connected');toast('✅ Connected');if($('server-info'))$('server-info').textContent='DB: '+(res.db||'sqlite')+' · modules: '+(res.modules||[]).join(',');}else{if(div){div.innerHTML='❌ Failed';div.style.color='var(--red)';}toast('❌ Failed','error');}}
async function loadSettingsForm(){
  const res=await api('/api/settings');
  if(!res||!res.ok)return;
  _pendingLogoDataUrl=undefined;
  if($('co-name'))$('co-name').value=res.company_name||'';
  if($('co-currency'))$('co-currency').value=res.currency||'LYD';
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
    if(logo){el.innerHTML=`<img src="${logo}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;}
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
  const body={company_name:($('co-name')&&$('co-name').value)||'',currency:($('co-currency')&&$('co-currency').value)||'LYD'};
  if(_pendingLogoDataUrl!==undefined)body.company_logo=_pendingLogoDataUrl;
  const res=await api('/api/settings',{method:'PUT',body});
  if(res&&res.ok){
    toast('✅ Saved');
    _pendingLogoDataUrl=undefined;
    applyBranding(res);
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
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&$('login-screen')&&$('login-screen').style.display!=='none')pinSubmit();});
(async function boot(){
  const saved=localStorage.getItem('anta_ho_api'); if(saved)CFG.apiUrl=saved;
  try{await loadBranding();}catch(_e){}
  if(CFG.token){
    const me=await api('/api/auth/me');
    const role=me&&me.user&&(me.user.role||'');
    if(me&&me.ok&&me.user&&(role==='admin'||role==='manager'||role==='accountant')){
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
  const roleLabels={admin:'HO ADMIN',manager:'MANAGER',accountant:'ACCOUNTANT'};
  const tag=$('ho-role-tag');
  if(tag)tag.textContent=roleLabels[role]||role.toUpperCase()||'HO';
  const nameEl=$('ho-user-name');
  if(nameEl)nameEl.textContent=(currentUser&&currentUser.name)||'';
}
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
    capital:'Capital & Equity', reports:'Sales Reports', 'inventory-ho':'Inventory — All',
    'stores-admin':'Manage Stores', users:'Users & PINs', banks:'Banks & Payments', settings:'Settings',
    overview:'Overview', stock:'Stock Management', finance:'Finance', admin:'Admin', products_sec:'Products',
    reports_sec:'Reports', lang_btn:'العربية / EN', switch_ar:'تم التبديل إلى العربية', switch_en:'Switched to English',
    logout:'Logout', refresh:'Refresh'
  },
  ar: {
    dashboard:'لوحة المكتب الرئيسي', 'stores-view':'كل المتاجر', warehouse:'مستودع المكتب', 'supplier-grn':'استلام من المورد',
    'store-grn':'إرسال للمتاجر', transfer:'تحويل بين المتاجر', products:'كتالوج المنتجات', pl:'الأرباح والخسائر',
    'balance-sheet':'الميزانية العمومية', cashflow:'التدفق النقدي', 'supplier-accounts':'حسابات الموردين',
    'expenses-ho':'المصروفات', accounts:'دليل الحسابات', promotions:'العروض', license:'الترخيص',
    capital:'رأس المال', reports:'تقارير المبيعات', 'inventory-ho':'المخزون — الكل',
    'stores-admin':'إدارة المتاجر', users:'المستخدمون والرمز', banks:'البنوك والمدفوعات', settings:'الإعدادات',
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

async function saveHoExpense(){
  const amount=parseFloat($('ho-exp-amt')&&$('ho-exp-amt').value)||0;
  if(!amount){toast('Amount required','error');return;}
  const storeSel=$('ho-exp-store');
  const body={
    date:($('ho-exp-date')&&$('ho-exp-date').value)||today(),
    storeId:(storeSel&&storeSel.value)||'HO',
    store:(storeSel&&storeSel.selectedOptions&&storeSel.selectedOptions[0]&&storeSel.selectedOptions[0].text)||'HO',
    category:($('ho-exp-cat')&&$('ho-exp-cat').value)||'Other',
    description:($('ho-exp-desc')&&$('ho-exp-desc').value)||'',
    amount:amount,
    payMethod:($('ho-exp-pay')&&$('ho-exp-pay').value)||'Cash',
    reference:($('ho-exp-ref')&&$('ho-exp-ref').value)||''
  };
  const res=await api('/api/expenses',{method:'POST',body:body});
  if(res&&res.ok){
    toast('Expense saved');
    if($('ho-exp-amt'))$('ho-exp-amt').value='';
    if($('ho-exp-desc'))$('ho-exp-desc').value='';
    await loadAll();
    loadExpenses();
  } else {
    const msg=(res&& (res.detail||res.msg)) || 'Failed';
    toast(typeof msg==='string'?msg:'Failed','error');
  }
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
async function loadCOA(){
  const res=await api('/api/accounts/coa');
  const el=$('coa-table'); if(!el)return;
  el.innerHTML=((res&&res.data)||[]).map(a=>`<tr><td>${a.code}</td><td>${a.name}</td><td>${a.type}</td><td>${a.active?'✅':'-'}</td></tr>`).join('');
}
async function loadJournals(){
  const res=await api('/api/accounts/journals?limit=50');
  const el=$('je-list'); if(!el)return;
  const rows=(res&&res.data)||[];
  el.innerHTML=rows.map(j=>`<div style="border-bottom:1px solid #eee;padding:6px 0"><b>${j.id}</b> ${j.date} · ${j.sourceType} ${j.sourceId}<div style="opacity:.8">${j.memo||''}</div>${(j.lines||[]).map(l=>`<div>${l.accountCode} ${l.accountName}: Dr ${l.debit} / Cr ${l.credit}</div>`).join('')}</div>`).join('')||'No journals';
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