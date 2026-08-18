> Updated build: see `docs/CHANGELOG_v5.md` for Phases 1–6 (expenses→HO, COA, promotions, license, i18n, ESC/POS).

# ANTA Shoes System v4 (Store POS + Head Office)

Google Sheets **removed**. One SQLite/PostgreSQL backend powers:

| App | URL | Who |
|-----|-----|-----|
| Portal | `/` | Choose POS or HO |
| Store POS | `/pos/` | Cashiers / store managers |
| Head Office | `/ho/` | HO admin / managers |

## Features

**Store POS:** sales, barcode cart, discounts, multi-pay, invoice, returns, exchange, claims, receive GRN, inventory, expenses, reports, JWT PIN login.

**Head Office:** dashboard, all stores, warehouse, supplier GRN, send stock to stores, transfers, product master, P&L, balance sheet, cash flow, supplier accounts, capital, expenses, inventory-all, manage stores/users/banks.

## Quick start

```bash
cd anta_pos
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r backend/requirements.txt
python scripts/init_db.py
python run_web.py
```

Open **http://127.0.0.1:8765/**

- Store POS → Store 1 · PIN **1111**
- Head Office → HO · PIN **0000**

## Desktop / EXE

```bash
pip install -r desktop/requirements-desktop.txt
python run_desktop.py
# Windows EXE: scripts\build_windows_exe.bat → dist\ANTA_POS.exe
```

## Migrate Sheets data

```bash
python scripts/migrate_from_sheets.py --xlsx ./export.xlsx
```

## Docs

- docs/INSTALLATION.md
- docs/PROJECT_STRUCTURE.md
- docs/API.md

Set `ANTA_SECRET_KEY` and change default PINs in production.
