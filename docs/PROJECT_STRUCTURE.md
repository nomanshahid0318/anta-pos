# ANTA Shoes POS v4 — Project Structure

```
anta_pos/
├── backend/                 # FastAPI REST API
│   ├── app/
│   │   ├── main.py          # App factory, static file serving, CORS
│   │   ├── config.py        # Settings (env: ANTA_*)
│   │   ├── database.py      # SQLAlchemy engine/session
│   │   ├── models.py        # ORM models (replaces all Sheets)
│   │   ├── schemas.py       # Pydantic request/response models
│   │   ├── auth.py          # PIN hashing + JWT
│   │   ├── seed.py          # Default stores/users/banks/products
│   │   ├── utils.py
│   │   ├── routers/
│   │   │   ├── auth_routes.py
│   │   │   ├── catalog.py       # products, banks, stores
│   │   │   ├── sales.py         # sales/returns/exchanges/claims/expenses
│   │   │   ├── inventory_routes.py  # inventory + GRN + warehouse
│   │   │   └── reports.py       # dashboard + reports + settings
│   │   └── services/
│   │       └── inventory.py     # stock ledger updates
│   └── requirements.txt
├── frontend/
│   ├── portal.html          # Landing
│   ├── index.html           # Store POS
│   ├── css/ + js/
│   └── ho/                  # Head Office UI
│       ├── index.html
│       ├── css/styles.css
│       └── js/app.js
├── desktop/                 # Windows desktop wrapper
│   ├── main.py              # Starts API + pywebview window
│   ├── build_exe.spec       # PyInstaller spec
│   └── requirements-desktop.txt
├── database/
│   ├── schema.sql           # Reference SQL schema
│   └── anta_pos.db          # Created on first run (SQLite)
├── scripts/
│   ├── init_db.py
│   ├── migrate_from_sheets.py
│   └── build_windows_exe.bat
├── docs/
│   ├── PROJECT_STRUCTURE.md
│   ├── INSTALLATION.md
│   └── API.md
├── run_web.py               # Web server entry
├── run_desktop.py           # Desktop entry
└── README.md
```

## Architecture

```
Browser / Desktop Window
        │  HTTPS/HTTP + JWT
        ▼
   FastAPI (backend)
        │
        ▼
   SQLAlchemy ORM
        │
   SQLite (default)  or  PostgreSQL / MySQL
```

## Removed

- Google Apps Script backend
- Google Sheets as data store
- Client-side secret key / Apps Script URL settings
- Offline sync queue to Sheets (data is written directly to DB)

## Roles

| Role     | Capabilities                                      |
|----------|---------------------------------------------------|
| cashier  | Sales, returns, exchange, claims, GRN receive, view inventory/reports for own store |
| manager  | cashier + products, issue GRN, users (own store)  |
| admin    | Full access, all stores, banks, warehouse, users  |
```
