# ANTA POS v5 — Phase updates

## Phase 1 — Core restructuring
- Removed **Expenses** from POS UI and POS cashier workflow
- Expenses now live under **Head Office** and are recorded by **admin/accountant**
- Roles: `admin` | `manager` | `cashier` | `accountant` with permission map in `auth.py`
- Seed user: accountant `acc1` / PIN `5555` (HO)

## Phase 2 — Accounts
- Chart of Accounts (`accounts` table) with Assets/Liabilities/Equity/Income/Expense
- Auto journal entries on **sales** and **expenses**
- HO screens + APIs: `/api/accounts/coa`, `/api/accounts/journals`

## Phase 3 — POS features
- Thermal receipt ESC/POS: `GET /api/receipts/sale/{invoice_id}`
- POS UI: Thermal ESC/POS button on invoice modal (Web Serial or `.bin` download)
- Store/POS name editable via `/api/settings` — **admin only**

## Phase 4 — Promotions
- Types: B1G1, B2G1, % discount, fixed amount, invoice-level % / fixed
- Admin CRUD + active/inactive toggle
- Applied automatically on sale create + `/api/promotions/preview`

## Phase 5 — License
- Yearly key format `ANTA-YYYY-XXXXXXXX`
- Activate / generate / remote lock-unlock (admin)
- Non-admin login blocked when locked/expired

## Phase 6 — Language
- English + Arabic toggle (POS + HO)
- `dir=rtl` when Arabic selected

## Phase 7 — Bulk upload reliability + categories
- `POST /api/products/bulk` now commits **row-by-row using SAVEPOINTs**
  instead of one transaction for the whole chunk — a single bad/duplicate
  row can no longer roll back the rest of an otherwise-good batch. This
  was the root cause of large uploads (e.g. 1396 rows) saving only a
  handful of rows.
- Response now includes `results[]` (per-row barcode/name/status/reason)
  in addition to the existing `created`/`updated`/`errors` totals.
- Frontend (`uploadProducts`): if a chunk request fails outright
  (network/timeout/500), it's automatically split and retried down to
  single rows instead of being abandoned — the upload takes as long as
  it needs but no longer silently drops data. Barcode/SKU columns read
  as Excel numbers are now safely converted to text for more header
  variants (previously only the literal "Barcode" header was protected),
  avoiding scientific-notation corruption (e.g. `8.001e+12`).
- Every upload now auto-downloads a `products_upload_log_*.csv` event
  log listing pass/fail + reason for every row.
- New category management: `GET/POST /api/categories`,
  `DELETE /api/categories/{name}` (stored in the existing `settings`
  table — no migration needed). Product Master screen gained a
  Categories card; new categories immediately appear in the product
  form and in the Bulk Upload template's Category dropdown.
