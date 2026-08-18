-- ANTA Shoes POS v4 — Reference schema (SQLite dialect)
-- Tables are created automatically by SQLAlchemy on first run.
-- Use this file for documentation or manual PostgreSQL adaptation.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  city VARCHAR(64) DEFAULT '',
  address VARCHAR(255) DEFAULT '',
  manager VARCHAR(128) DEFAULT '',
  phone VARCHAR(64) DEFAULT '',
  active BOOLEAN DEFAULT 1,
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id VARCHAR(32) NOT NULL UNIQUE,
  store_id VARCHAR(32) NOT NULL REFERENCES stores(store_id),
  store_name VARCHAR(128) DEFAULT '',
  name VARCHAR(128) NOT NULL,
  role VARCHAR(32) DEFAULT 'cashier',
  pin_hash VARCHAR(255) NOT NULL,
  active BOOLEAN DEFAULT 1,
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  account_no VARCHAR(64) DEFAULT '',
  device VARCHAR(128) DEFAULT '',
  active BOOLEAN DEFAULT 1,
  icon VARCHAR(16) DEFAULT '💳'
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  brand VARCHAR(64) DEFAULT 'ANTA',
  category VARCHAR(64) DEFAULT 'Footwear',
  size VARCHAR(64) DEFAULT '',
  color VARCHAR(64) DEFAULT '',
  department VARCHAR(64) DEFAULT '',
  season VARCHAR(64) DEFAULT '',
  gender VARCHAR(32) DEFAULT '',
  cost FLOAT DEFAULT 0,
  retail FLOAT DEFAULT 0,
  reorder INTEGER DEFAULT 5,
  opening INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT 1,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode VARCHAR(64) NOT NULL,
  name VARCHAR(255) DEFAULT '',
  store VARCHAR(128) DEFAULT '',
  store_id VARCHAR(32) NOT NULL,
  grn_in INTEGER DEFAULT 0,
  sales_out INTEGER DEFAULT 0,
  returns_in INTEGER DEFAULT 0,
  exch_out INTEGER DEFAULT 0,
  exch_in INTEGER DEFAULT 0,
  claims INTEGER DEFAULT 0,
  on_hand INTEGER DEFAULT 0,
  updated_at DATETIME,
  UNIQUE(barcode, store_id)
);

CREATE TABLE IF NOT EXISTS ho_warehouse (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) DEFAULT '',
  supplier_in INTEGER DEFAULT 0,
  store_out INTEGER DEFAULT 0,
  on_hand INTEGER DEFAULT 0,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id VARCHAR(64) NOT NULL,
  date VARCHAR(16) NOT NULL,
  time VARCHAR(8) DEFAULT '',
  store VARCHAR(128) DEFAULT '',
  store_id VARCHAR(32) NOT NULL,
  customer VARCHAR(128) DEFAULT 'Walk-in',
  items_json TEXT DEFAULT '[]',
  subtotal FLOAT DEFAULT 0,
  discount FLOAT DEFAULT 0,
  global_discount FLOAT DEFAULT 0,
  total FLOAT DEFAULT 0,
  payment VARCHAR(64) DEFAULT 'Cash',
  pay_ref VARCHAR(128) DEFAULT '',
  type VARCHAR(16) DEFAULT 'sale',
  created_at DATETIME,
  UNIQUE(invoice_id, store_id)
);

CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_id VARCHAR(64) NOT NULL UNIQUE,
  date VARCHAR(16) NOT NULL,
  time VARCHAR(8) DEFAULT '',
  store VARCHAR(128) DEFAULT '',
  store_id VARCHAR(32) NOT NULL,
  orig_invoice VARCHAR(64) DEFAULT '',
  barcode VARCHAR(64) NOT NULL,
  product_name VARCHAR(255) DEFAULT '',
  qty INTEGER DEFAULT 1,
  amount FLOAT DEFAULT 0,
  method VARCHAR(64) DEFAULT 'Cash',
  reason VARCHAR(255) DEFAULT '',
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS exchanges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_id VARCHAR(64) NOT NULL UNIQUE,
  date VARCHAR(16) NOT NULL,
  time VARCHAR(8) DEFAULT '',
  store VARCHAR(128) DEFAULT '',
  store_id VARCHAR(32) NOT NULL,
  customer VARCHAR(128) DEFAULT '',
  old_barcode VARCHAR(64) NOT NULL,
  old_name VARCHAR(255) DEFAULT '',
  old_qty INTEGER DEFAULT 1,
  new_barcode VARCHAR(64) NOT NULL,
  new_name VARCHAR(255) DEFAULT '',
  new_qty INTEGER DEFAULT 1,
  diff FLOAT DEFAULT 0,
  payment VARCHAR(64) DEFAULT 'Cash',
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_id VARCHAR(64) NOT NULL UNIQUE,
  date VARCHAR(16) NOT NULL,
  time VARCHAR(8) DEFAULT '',
  store VARCHAR(128) DEFAULT '',
  store_id VARCHAR(32) NOT NULL,
  barcode VARCHAR(64) NOT NULL,
  product_name VARCHAR(255) DEFAULT '',
  qty INTEGER DEFAULT 1,
  type VARCHAR(64) DEFAULT 'Damage',
  value FLOAT DEFAULT 0,
  supplier VARCHAR(128) DEFAULT '',
  notes TEXT DEFAULT '',
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exp_id VARCHAR(64) NOT NULL UNIQUE,
  date VARCHAR(16) NOT NULL,
  store_id VARCHAR(32) DEFAULT 'HO',
  store VARCHAR(128) DEFAULT 'HO',
  category VARCHAR(64) DEFAULT '',
  sub_category VARCHAR(64) DEFAULT '',
  description VARCHAR(255) DEFAULT '',
  amount FLOAT DEFAULT 0,
  pay_method VARCHAR(64) DEFAULT 'Cash',
  reference VARCHAR(128) DEFAULT '',
  notes TEXT DEFAULT '',
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS supplier_grn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_id VARCHAR(64) NOT NULL,
  date VARCHAR(16) NOT NULL,
  supplier VARCHAR(128) DEFAULT '',
  invoice_no VARCHAR(64) DEFAULT '',
  barcode VARCHAR(64) NOT NULL,
  name VARCHAR(255) DEFAULT '',
  qty INTEGER DEFAULT 0,
  unit_cost FLOAT DEFAULT 0,
  total_cost FLOAT DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS store_grn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_id VARCHAR(64) NOT NULL,
  date VARCHAR(16) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  store_name VARCHAR(128) DEFAULT '',
  barcode VARCHAR(64) NOT NULL,
  name VARCHAR(255) DEFAULT '',
  qty_issued INTEGER DEFAULT 0,
  qty_received INTEGER DEFAULT 0,
  status VARCHAR(32) DEFAULT 'pending',
  notes TEXT DEFAULT '',
  issued_at DATETIME,
  received_at DATETIME
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_id VARCHAR(64) NOT NULL UNIQUE,
  date VARCHAR(16) NOT NULL,
  from_store_id VARCHAR(32) NOT NULL,
  from_store VARCHAR(128) DEFAULT '',
  to_store_id VARCHAR(32) NOT NULL,
  to_store VARCHAR(128) DEFAULT '',
  barcode VARCHAR(64) NOT NULL,
  name VARCHAR(255) DEFAULT '',
  qty INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  status VARCHAR(32) DEFAULT 'pending',
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key VARCHAR(64) NOT NULL UNIQUE,
  value TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS invoice_counters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id VARCHAR(32) NOT NULL UNIQUE,
  next_inv INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME,
  action VARCHAR(64) NOT NULL,
  store VARCHAR(128) DEFAULT '',
  status VARCHAR(64) DEFAULT ''
);

-- Indexes
CREATE INDEX IF NOT EXISTS ix_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS ix_sales_store ON sales(store_id);
CREATE INDEX IF NOT EXISTS ix_inv_store ON inventory(store_id);
CREATE INDEX IF NOT EXISTS ix_store_grn_status ON store_grn(status);


-- v5 additions: accounting, promotions
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code VARCHAR(16) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(32) DEFAULT 'asset',
  active BOOLEAN DEFAULT 1,
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_no VARCHAR(32) NOT NULL UNIQUE,
  date VARCHAR(16) NOT NULL,
  memo VARCHAR(255) DEFAULT '',
  source_type VARCHAR(32) DEFAULT '',
  source_id VARCHAR(64) DEFAULT '',
  posted BOOLEAN DEFAULT 1,
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit FLOAT DEFAULT 0,
  credit FLOAT DEFAULT 0,
  memo VARCHAR(255) DEFAULT ''
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promo_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(32) NOT NULL,
  value FLOAT DEFAULT 0,
  target_type VARCHAR(32) DEFAULT 'all',
  target_value VARCHAR(128) DEFAULT '',
  active BOOLEAN DEFAULT 1,
  start_date VARCHAR(16) DEFAULT '',
  end_date VARCHAR(16) DEFAULT '',
  created_at DATETIME
);
