// ============================================================
// ANTA SHOES — Google Apps Script v3
// SETUP: Paste → Run setupAllSheets → Deploy as Web App (Anyone)
// ============================================================
const SECRET = 'ANTA2026';

function doGet(e) {
  try {
    const p = e.parameter;
    if (p.key !== SECRET) return out({ok:false, msg:'Unauthorized'});
    switch(p.action) {
      case 'ping':       return out({ok:true, t: new Date().toISOString()});
      case 'sales':      return out({ok:true, data: rows('Sales', p)});
      case 'products':   return out({ok:true, data: sheet2arr('Products')});
      case 'stores':     return out({ok:true, data: sheet2arr('Stores')});
      case 'banks':      return out({ok:true, data: sheet2arr('Banks')});
      case 'users':      return out({ok:true, data: sheet2arr('Users')});
      case 'inventory':  return out({ok:true, data: rows('Inventory', p)});
      case 'grns':       return out({ok:true, data: rows('Store_GRN', p)});
      case 'expenses':   return out({ok:true, data: rows('Expenses', p)});
      case 'warehouse':  return out({ok:true, data: sheet2arr('HO_Warehouse')});
      case 'dashboard':  return out(dashboard(p));
      default:           return out({ok:false, msg:'Unknown: '+p.action});
    }
  } catch(e) { return out({ok:false, msg:e.toString()}); }
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.key !== SECRET) return out({ok:false, msg:'Unauthorized'});
    switch(d.action) {
      case 'sale':      return out(saveSale(d));
      case 'return':    return out(saveReturn(d));
      case 'exchange':  return out(saveExchange(d));
      case 'claim':     return out(saveClaim(d));
      case 'expense':   return out(saveExpense(d));
      case 'product':   return out(saveProduct(d));
      case 'grn_receive': return out(receiveGRN(d));
      case 'issue_grn': return out(issueGRN(d));
      case 'verify_pin': return out(verifyPIN(d));
      case 'save_store': return out(saveStore(d));
      case 'save_user':  return out(saveUser(d));
      case 'save_bank':  return out(saveBank(d));
      case 'supplier_grn': return out(supplierGRN(d));
      default: return out({ok:false, msg:'Unknown: '+d.action});
    }
  } catch(e) { return out({ok:false, msg:e.toString()}); }
}

function out(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Sheet helpers ─────────────────────────────────────────────
function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function getSheet(name) {
  return ss().getSheetByName(name) || ss().insertSheet(name);
}

function sheet2arr(name) {
  const sh = getSheet(name);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const hdrs = vals[0];
  return vals.slice(1).filter(r => r.some(c => c !== '')).map(r => {
    const o = {};
    hdrs.forEach((h,i) => o[h] = r[i]);
    return o;
  });
}

function rows(sheetName, p) {
  let data = sheet2arr(sheetName);
  if (p && p.store && p.store !== 'all') {
    data = data.filter(r => r.Store === p.store || r.StoreID === p.store || r.StoreName === p.store);
  }
  if (p && p.from) data = data.filter(r => String(r.Date) >= p.from);
  if (p && p.to)   data = data.filter(r => String(r.Date) <= p.to);
  if (p && p.month) data = data.filter(r => String(r.Date).startsWith(p.month));
  if (p && p.status) data = data.filter(r => r.Status === p.status);
  return data;
}

function appendRow(name, rowArr) {
  getSheet(name).appendRow(rowArr);
}

function findRowIdx(name, col, val) {
  const sh = getSheet(name);
  const data = sh.getDataRange().getValues();
  const hdrs = data[0];
  const ci = hdrs.indexOf(col);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][ci]) === String(val)) return i + 1;
  }
  return -1;
}

function updateRow(name, rowIdx, colName, val) {
  const sh = getSheet(name);
  const hdrs = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const ci = hdrs.indexOf(colName);
  if (ci >= 0) sh.getRange(rowIdx, ci+1).setValue(val);
}

const N = () => new Date().toISOString();

// ── DASHBOARD ─────────────────────────────────────────────────
function dashboard(p) {
  const store = p && p.store ? p.store : 'all';
  const salesData = sheet2arr('Sales');
  const retData   = sheet2arr('Returns');

  const fSales = store==='all' ? salesData : salesData.filter(s=>s.Store===store||s.StoreID===store);
  const fRets  = store==='all' ? retData   : retData.filter(r=>r.Store===store||r.StoreID===store);

  const totalRev = fSales.reduce((a,s)=>a+(parseFloat(s.Total)||0),0);
  const totalRet = fRets.reduce((a,r)=>a+(parseFloat(r.Amount)||0),0);
  const totalInv = fSales.length;

  // Store breakdown
  const storeMap = {};
  salesData.forEach(s => {
    const k = s.Store || s.StoreID;
    if (!storeMap[k]) storeMap[k] = {store:k, revenue:0, invoices:0, returns:0};
    storeMap[k].revenue  += parseFloat(s.Total)||0;
    storeMap[k].invoices++;
  });
  retData.forEach(r => {
    const k = r.Store || r.StoreID;
    if (storeMap[k]) storeMap[k].returns += parseFloat(r.Amount)||0;
  });

  // Payment breakdown
  const payMap = {};
  fSales.forEach(s => { payMap[s.Payment] = (payMap[s.Payment]||0) + (parseFloat(s.Total)||0); });

  // Low stock from inventory
  const inv  = sheet2arr('Inventory');
  const prods = sheet2arr('Products');
  const low = inv.filter(i => {
    const p2 = prods.find(p2 => String(p2.Barcode) === String(i.Barcode));
    return (parseInt(i.OnHand)||0) <= (parseInt(p2&&p2.Reorder)||5);
  }).map(i => ({barcode:i.Barcode, name:i.Name||i.Barcode, store:i.Store, onHand:i.OnHand}));

  // Today's sales
  const today = new Date().toISOString().split('T')[0];
  const todaySales = fSales.filter(s => String(s.Date) === today);
  const todayRev = todaySales.reduce((a,s)=>a+(parseFloat(s.Total)||0),0);

  return {
    ok: true,
    totalRevenue: totalRev,
    totalInvoices: totalInv,
    totalReturns: totalRet,
    netRevenue: totalRev - totalRet,
    atv: totalInv ? totalRev/totalInv : 0,
    todayRevenue: todayRev,
    todayInvoices: todaySales.length,
    storeBreakdown: Object.values(storeMap),
    paymentBreakdown: payMap,
    lowStock: low.slice(0,20),
    recentSales: fSales.slice(-10).reverse(),
    lastUpdated: N()
  };
}

// ── SALES ─────────────────────────────────────────────────────
function saveSale(d) {
  const t = d.data;
  if (!t || !t.id) return {ok:false, msg:'No data'};
  // Check duplicate by ID + Store
  const existing = sheet2arr('Sales').find(r => r.InvoiceID === t.id && r.Store === t.store);
  if (existing) return {ok:true, msg:'duplicate'};
  appendRow('Sales', [
    t.id, t.date, t.time, t.store, t.storeId||'',
    t.customer||'Walk-in', JSON.stringify(t.items||[]),
    t.subtotal||0, t.discount||0, t.total||0,
    t.payment, t.payRef||'', 'sale', N()
  ]);
  // Update inventory
  (t.items||[]).forEach(item => {
    updateInv(item.barcode, t.store, t.storeId||'', item.name||'', 'sale', item.qty||1);
  });
  return {ok:true, id:t.id};
}

// ── RETURNS ───────────────────────────────────────────────────
function saveReturn(d) {
  const r = d.data;
  if (!r) return {ok:false, msg:'No data'};
  appendRow('Returns', [
    r.ref, r.date, r.time||'', r.store, r.storeId||'',
    r.origInvoice||'', r.barcode, r.productName||'',
    r.qty||1, r.amount||0, r.method, r.reason||'', N()
  ]);
  updateInv(r.barcode, r.store, r.storeId||'', r.productName||'', 'return', r.qty||1);
  return {ok:true, ref:r.ref};
}

// ── EXCHANGE ──────────────────────────────────────────────────
function saveExchange(d) {
  const ex = d.data;
  if (!ex) return {ok:false, msg:'No data'};
  appendRow('Exchanges', [
    ex.ref, ex.date, ex.time||'', ex.store, ex.storeId||'',
    ex.customer||'', ex.oldBarcode, ex.oldName||'', ex.oldQty||1,
    ex.newBarcode, ex.newName||'', ex.newQty||1,
    ex.diff||0, ex.payment||'Cash', N()
  ]);
  updateInv(ex.oldBarcode, ex.store, ex.storeId||'', ex.oldName||'', 'return', ex.oldQty||1);
  updateInv(ex.newBarcode, ex.store, ex.storeId||'', ex.newName||'', 'sale', ex.newQty||1);
  return {ok:true, ref:ex.ref};
}

// ── CLAIM ─────────────────────────────────────────────────────
function saveClaim(d) {
  const cl = d.data;
  if (!cl) return {ok:false, msg:'No data'};
  appendRow('Claims', [
    cl.ref, cl.date, cl.time||'', cl.store, cl.storeId||'',
    cl.barcode, cl.productName||'', cl.qty||1,
    cl.type||'Damage', cl.value||0, cl.supplier||'', cl.notes||'', N()
  ]);
  updateInv(cl.barcode, cl.store, cl.storeId||'', cl.productName||'', 'claim', cl.qty||1);
  return {ok:true, ref:cl.ref};
}

// ── EXPENSE (HO only) ─────────────────────────────────────────
function saveExpense(d) {
  const ex = d.data;
  if (!ex) return {ok:false, msg:'No data'};
  const id = 'EXP-' + Date.now();
  appendRow('Expenses', [
    id, ex.date, ex.storeId||'HO', ex.store||'HO',
    ex.category, ex.subCategory||'', ex.description||'',
    ex.amount||0, ex.payMethod||'Cash', ex.reference||'', ex.notes||'', N()
  ]);
  return {ok:true, id};
}

// ── INVENTORY ─────────────────────────────────────────────────
function updateInv(barcode, store, storeId, name, action, qty) {
  if (!barcode || !qty) return;
  const sh = getSheet('Inventory');
  const data = sh.getDataRange().getValues();
  const hdrs = data[0];
  let rowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0])===String(barcode) && String(data[i][2])===String(store)) {
      rowIdx = i+1; break;
    }
  }
  if (rowIdx === -1) {
    sh.appendRow([barcode, name, store, storeId, 0, 0, 0, 0, 0, 0, 0, N()]);
    rowIdx = sh.getLastRow();
  }
  // Cols: Barcode=0,Name=1,Store=2,StoreID=3,GRN_In=4,Sales_Out=5,Returns_In=6,ExchOut=7,ExchIn=8,Claims=9,OnHand=10
  const colMap = {grn:5,sale:6,return:7,exchin:9,exchout:8,claim:10};
  const ci = colMap[action];
  if (ci) {
    const cur = parseFloat(sh.getRange(rowIdx,ci).getValue())||0;
    sh.getRange(rowIdx,ci).setValue(cur+qty);
  }
  // Recalc OnHand
  const row = sh.getRange(rowIdx,1,1,11).getValues()[0];
  const oh = (row[4]||0)-(row[5]||0)+(row[6]||0)-(row[7]||0)+(row[8]||0)-(row[9]||0);
  sh.getRange(rowIdx,11).setValue(oh);
  sh.getRange(rowIdx,12).setValue(N());
}

// ── PRODUCTS ──────────────────────────────────────────────────
function saveProduct(d) {
  const p = d.data;
  if (!p || !p.barcode) return {ok:false, msg:'No barcode'};
  const row = [p.barcode, p.name, p.brand||'ANTA', p.category||'',
               p.size||'', p.cost||0, p.retail||0, p.reorder||5,
               p.opening||0, p.active||'Y', N()];
  const idx = findRowIdx('Products','Barcode',p.barcode);
  if (idx > 0) getSheet('Products').getRange(idx,1,1,row.length).setValues([row]);
  else appendRow('Products', row);
  return {ok:true};
}

// ── GRN ───────────────────────────────────────────────────────
function supplierGRN(d) {
  const lines = d.lines || [];
  let count = 0;
  lines.forEach(l => {
    appendRow('Supplier_GRN', [d.grnId, d.date, d.supplier||'', d.invoiceNo||'',
      l.barcode, l.name||'', l.qty||0, l.cost||0, (l.qty||0)*(l.cost||0), d.notes||'', N()]);
    updateHOWarehouse(l.barcode, l.name||'', l.qty||0, 'in');
    count++;
  });
  return {ok:true, count};
}

function issueGRN(d) {
  const lines = d.lines || [];
  let count = 0, errors = [];
  lines.forEach(l => {
    const wh = sheet2arr('HO_Warehouse').find(w=>String(w.Barcode)===String(l.barcode));
    const hoStock = wh ? (parseInt(wh.OnHand)||0) : 0;
    if (hoStock < (l.qty||0)) { errors.push(l.barcode+' insufficient ('+hoStock+')'); return; }
    appendRow('Store_GRN', [d.grnId, d.date, d.storeId, d.storeName,
      l.barcode, l.name||'', l.qty||0, 0, 'pending', d.notes||'', N(), '']);
    updateHOWarehouse(l.barcode, l.name||'', l.qty||0, 'out');
    count++;
  });
  return {ok:true, count, errors};
}

function receiveGRN(d) {
  const sh = getSheet('Store_GRN');
  const data = sh.getDataRange().getValues();
  const hdrs = data[0];
  const gIdx = hdrs.indexOf('GRNID');
  const bIdx = hdrs.indexOf('Barcode');
  const qrIdx = hdrs.indexOf('QtyReceived');
  const stIdx = hdrs.indexOf('Status');
  const rtIdx = hdrs.indexOf('ReceivedAt');
  const nmIdx = hdrs.indexOf('Name');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][gIdx])===String(d.grnId) && String(data[i][bIdx])===String(d.barcode)) {
      sh.getRange(i+1,qrIdx+1).setValue(d.qty||0);
      sh.getRange(i+1,stIdx+1).setValue('received');
      sh.getRange(i+1,rtIdx+1).setValue(N());
      updateInv(d.barcode, d.storeName, d.storeId, data[i][nmIdx]||'', 'grn', d.qty||0);
      break;
    }
  }
  return {ok:true};
}

function updateHOWarehouse(barcode, name, qty, dir) {
  const sh = getSheet('HO_Warehouse');
  const data = sh.getDataRange().getValues();
  const hdrs = data[0];
  let rowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(barcode)) { rowIdx = i+1; break; }
  }
  if (rowIdx === -1) {
    sh.appendRow([barcode, name, 0, 0, 0, N()]);
    rowIdx = sh.getLastRow();
  }
  const inCol  = hdrs.indexOf('Supplier_In')+1;
  const outCol = hdrs.indexOf('Store_Out')+1;
  const ohCol  = hdrs.indexOf('OnHand')+1;
  const upCol  = hdrs.indexOf('UpdatedAt')+1;
  const curIn  = parseFloat(sh.getRange(rowIdx,inCol).getValue())||0;
  const curOut = parseFloat(sh.getRange(rowIdx,outCol).getValue())||0;
  if (dir==='in')  sh.getRange(rowIdx,inCol).setValue(curIn+qty);
  if (dir==='out') sh.getRange(rowIdx,outCol).setValue(curOut+qty);
  const nIn  = dir==='in'  ? curIn+qty  : curIn;
  const nOut = dir==='out' ? curOut+qty : curOut;
  sh.getRange(rowIdx,ohCol).setValue(nIn-nOut);
  sh.getRange(rowIdx,upCol).setValue(N());
}

// ── USERS / STORES / BANKS ────────────────────────────────────
function verifyPIN(d) {
  const users = sheet2arr('Users');
  const u = users.find(u => String(u.StoreID)===String(d.storeId) && String(u.PIN)===String(d.pin) && u.Active==='Y');
  if (u) return {ok:true, user:{name:u.Name, role:u.Role, storeId:u.StoreID, storeName:u.StoreName}};
  return {ok:false, msg:'Wrong PIN'};
}

function saveStore(d) {
  const s = d.data;
  const row = [s.storeId, s.name, s.city||'', s.address||'', s.manager||'', s.phone||'', 'Y', N()];
  const idx = findRowIdx('Stores','StoreID',s.storeId);
  if (idx>0) getSheet('Stores').getRange(idx,1,1,row.length).setValues([row]);
  else appendRow('Stores', row);
  return {ok:true};
}

function saveUser(d) {
  const u = d.data;
  const row = [u.userId||'U'+Date.now(), u.storeId, u.storeName, u.name, u.role, u.pin, 'Y', N()];
  const idx = findRowIdx('Users','UserID',u.userId||'');
  if (idx>0) getSheet('Users').getRange(idx,1,1,row.length).setValues([row]);
  else appendRow('Users', row);
  return {ok:true};
}

function saveBank(d) {
  const b = d.data;
  const row = [b.bankId||'B'+Date.now(), b.name, b.accountNo||'', b.device||'', b.active||'Y'];
  const idx = findRowIdx('Banks','BankID',b.bankId||'');
  if (idx>0) getSheet('Banks').getRange(idx,1,1,row.length).setValues([row]);
  else appendRow('Banks', row);
  return {ok:true};
}

// ── SETUP ─────────────────────────────────────────────────────
const HEADERS = {
  Sales:       ['InvoiceID','Date','Time','Store','StoreID','Customer','Items_JSON','Subtotal','Discount','Total','Payment','PayRef','Type','SyncedAt'],
  Returns:     ['RefID','Date','Time','Store','StoreID','OrigInvoice','Barcode','ProductName','Qty','Amount','Method','Reason','SyncedAt'],
  Exchanges:   ['RefID','Date','Time','Store','StoreID','Customer','OldBarcode','OldName','OldQty','NewBarcode','NewName','NewQty','Diff','Payment','SyncedAt'],
  Claims:      ['RefID','Date','Time','Store','StoreID','Barcode','ProductName','Qty','Type','Value','Supplier','Notes','SyncedAt'],
  Expenses:    ['ExpID','Date','StoreID','Store','Category','SubCategory','Description','Amount','PayMethod','Reference','Notes','SyncedAt'],
  Products:    ['Barcode','Name','Brand','Category','Size','Cost','Retail','Reorder','Opening','Active','UpdatedAt'],
  Inventory:   ['Barcode','Name','Store','StoreID','GRN_In','Sales_Out','Returns_In','ExchOut','ExchIn','Claims','OnHand','UpdatedAt'],
  HO_Warehouse:['Barcode','Name','Supplier_In','Store_Out','OnHand','UpdatedAt'],
  Supplier_GRN:['GRNID','Date','Supplier','InvoiceNo','Barcode','Name','Qty','UnitCost','TotalCost','Notes','SyncedAt'],
  Store_GRN:   ['GRNID','Date','StoreID','StoreName','Barcode','Name','QtyIssued','QtyReceived','Status','Notes','IssuedAt','ReceivedAt'],
  Transfers:   ['RefID','Date','FromStoreID','FromStore','ToStoreID','ToStore','Barcode','Name','Qty','Notes','Status','CreatedAt'],
  Stores:      ['StoreID','Name','City','Address','Manager','Phone','Active','CreatedAt'],
  Users:       ['UserID','StoreID','StoreName','Name','Role','PIN','Active','CreatedAt'],
  Banks:       ['BankID','Name','AccountNo','Device','Active'],
  SyncLog:     ['Timestamp','Action','Store','Status'],
};

function setupAllSheets() {
  Object.keys(HEADERS).forEach(name => {
    const sh = getSheet(name);
    if (sh.getLastRow() === 0 || sh.getRange(1,1).getValue() === '') {
      const h = HEADERS[name];
      const r = sh.getRange(1,1,1,h.length);
      r.setValues([h]);
      r.setBackground('#1a3a6b').setFontColor('#fff').setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  // Default stores
  if (!sheet2arr('Stores').length) {
    [['s1','Store 1 — Tripoli','Tripoli'],['s2','Store 2 — Benghazi','Benghazi'],['s3','Store 3 — Misrata','Misrata']]
    .forEach(s => appendRow('Stores',[s[0],s[1],s[2],'','','','Y',new Date().toISOString()]));
  }
  // Default users
  if (!sheet2arr('Users').length) {
    [['admin','HO','Head Office','Admin','admin','0000'],
     ['u1','s1','Store 1 — Tripoli','Cashier 1','cashier','1111'],
     ['u2','s2','Store 2 — Benghazi','Cashier 2','cashier','2222'],
     ['u3','s3','Store 3 — Misrata','Cashier 3','cashier','3333'],
     ['m1','s1','Store 1 — Tripoli','Manager 1','manager','1199'],
     ['m2','s2','Store 2 — Benghazi','Manager 2','manager','2299'],
     ['m3','s3','Store 3 — Misrata','Manager 3','manager','3399']]
    .forEach(u => appendRow('Users',[u[0],u[1],u[2],u[3],u[4],u[5],'Y',new Date().toISOString()]));
  }
  // Default banks
  if (!sheet2arr('Banks').length) {
    [['b1','Cash','','','Y'],['b2','Sadad','','Sadad Terminal','Y'],
     ['b3','Mobi Cash','','Mobi Device','Y'],['b4','eDinar','','eDinar POS','Y'],
     ['b5','Al-Wahda Bank','','Bank Terminal','Y'],['b6','Al-Jumhuriya','','Bank Terminal','Y'],
     ['b7','Al-Tijari Bank','','Bank Terminal','Y'],['b8','Aman Bank','','Aman Terminal','Y'],
     ['b9','Etfai','','Etfai Device','Y'],['b10','Bank Transfer','','','Y']]
    .forEach(b => appendRow('Banks',b));
  }
  Logger.log('✅ Setup complete! Now Deploy as Web App.');
}
