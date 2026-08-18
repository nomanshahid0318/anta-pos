# Installation & Deployment

## Requirements

- Python 3.10+ (3.11/3.12 recommended)
- Windows 10/11 for EXE build
- Optional: PostgreSQL 14+ or MySQL 8+ for multi-store server deploy

---

## 1. Web application (server)

### Install

```bash
cd anta_pos
python -m venv .venv

# Windows
.venv\Scripts\activate
# Linux/macOS
source .venv/bin/activate

pip install -r backend/requirements.txt
python scripts/init_db.py
```

### Run

```bash
python run_web.py
# → Portal:       http://127.0.0.1:8765/
# → Store POS:    http://127.0.0.1:8765/pos/
# → Head Office:  http://127.0.0.1:8765/ho/
# → API docs:     http://127.0.0.1:8765/docs
```

Bind on LAN for store PCs:

```bash
python run_web.py --host 0.0.0.0 --port 8765
```

### Production (example with uvicorn workers)

```bash
cd backend
uvicorn app.main:app --host 0.0.0.0 --port 8765 --workers 2
```

Or reverse-proxy with Nginx:

```nginx
server {
  listen 80;
  server_name pos.yourdomain.com;
  location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

### PostgreSQL (optional)

```bash
# Create DB
createdb anta_pos

export ANTA_DATABASE_URL="postgresql+psycopg2://user:pass@localhost/anta_pos"
pip install psycopg2-binary
python scripts/init_db.py
python run_web.py
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTA_SECRET_KEY` | dev key | JWT signing secret — **change in production** |
| `ANTA_DATABASE_URL` | `sqlite:///.../database/anta_pos.db` | DB connection |
| `ANTA_HOST` | `127.0.0.1` | Bind host |
| `ANTA_PORT` | `8765` | Bind port |
| `ANTA_CORS_ORIGINS` | `*` | Comma-separated origins |

---

## 2. Windows EXE (standalone desktop)

### Build on a Windows machine

```bat
scripts\build_windows_exe.bat
```

Or manually:

```bat
pip install -r backend\requirements.txt
pip install -r desktop\requirements-desktop.txt
pyinstaller desktop\build_exe.spec --noconfirm
```

Output: `dist\ANTA_POS.exe`

### Run EXE

1. Copy `ANTA_POS.exe` to the store PC.
2. Double-click — a window opens with the POS UI.
3. SQLite DB is created at `data\anta_pos.db` next to the EXE.
4. No Google account, no Sheets, no browser install required (uses OS WebView2 / Edge).

### Desktop without packaging

```bash
pip install -r backend/requirements.txt
pip install -r desktop/requirements-desktop.txt
python run_desktop.py
```

---

## 3. Default logins (seed data)

| Store | Role | PIN |
|-------|------|-----|
| Head Office (HO) | admin | `0000` |
| Store 1 — Tripoli | cashier | `1111` |
| Store 1 — Tripoli | manager | `1199` |
| Store 2 — Benghazi | cashier | `2222` |
| Store 2 — Benghazi | manager | `2299` |
| Store 3 — Misrata | cashier | `3333` |
| Store 3 — Misrata | manager | `3399` |

**Change PINs immediately in production** (admin can update users via API or DB).

---

## 4. Migrate existing Google Sheets data

### Option A — Excel export

1. In Google Sheets: **File → Download → Microsoft Excel (.xlsx)**
2. Run:

```bash
python scripts/migrate_from_sheets.py --xlsx ./ANTA_export.xlsx
```

### Option B — CSV per tab

Export each sheet as CSV into a folder (`Sales.csv`, `Products.csv`, …):

```bash
python scripts/migrate_from_sheets.py --csv-dir ./export
```

### Option C — Live Apps Script pull (one-time)

```bash
python scripts/migrate_from_sheets.py \
  --apps-script-url "https://script.google.com/macros/s/XXXX/exec" \
  --key ANTA2026
```

Migration is **idempotent** for sales/users/products (skips duplicate invoice IDs / upserts master data).

---

## 5. Verify

### Store POS
1. Open `http://127.0.0.1:8765/pos/`
2. Login S1 / PIN `1111`
3. Complete a cash sale

### Head Office
1. Open `http://127.0.0.1:8765/ho/`
2. Login HO / PIN `0000`
3. Load Live Data → Supplier GRN → Send to Stores → P&L

API health: `GET /api/health` (modules: pos, ho)
