# ANTA POS API Reference

Base URL: `http://<host>:8765`  
Auth: `Authorization: Bearer <jwt>` (from `/api/auth/login`)  
Interactive docs: `/docs` (Swagger UI)

## Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/ping` | No | Liveness |
| GET | `/api/auth/stores` | No | Stores for login dropdown |
| POST | `/api/auth/login` | No | `{store_id, pin}` → JWT |
| GET | `/api/auth/me` | Yes | Current user |
| GET | `/api/auth/users` | manager+ | List users |
| POST | `/api/auth/users` | admin | Create/update user |

## Catalog

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/products` | Yes | Products (+ per-store stock) |
| POST | `/api/products` | manager+ | Upsert product |
| POST | `/api/products/bulk` | manager+ | Bulk upsert products (row-by-row savepoints — one bad row never costs the rest; returns `results[]` for a pass/fail event log) |
| POST | `/api/products/bulk-delete` | manager+ | Delete multiple products by barcode |
| GET | `/api/categories` | Yes | Product category list |
| POST | `/api/categories` | manager+ | Add a category `{name}` |
| DELETE | `/api/categories/{name}` | manager+ | Remove a category |
| GET | `/api/banks` | Yes | Payment methods |
| POST | `/api/banks` | admin | Upsert bank |
| GET | `/api/stores/all` | Yes | All stores |
| POST | `/api/stores` | admin | Upsert store |

## Transactions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/sales` | Yes | Create sale + decrement stock |
| GET | `/api/sales` | Yes | List sales (`from`, `to`, `store`) |
| POST | `/api/returns` | Yes | Return + restock |
| GET | `/api/returns` | Yes | List returns |
| POST | `/api/exchanges` | Yes | Exchange |
| GET | `/api/exchanges` | Yes | List exchanges |
| POST | `/api/claims` | Yes | Damage/claim write-off |
| GET | `/api/claims` | Yes | List claims |
| POST | `/api/expenses` | Yes | Save expense |
| GET | `/api/expenses` | Yes | List expenses |

## Inventory & GRN

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/inventory` | Yes | Store stock ledger view |
| POST | `/api/inventory/ensure` | Yes | Materialize opening stock |
| GET | `/api/grns` | Yes | Store GRN lines (`status=pending`) |
| POST | `/api/grns/receive` | Yes | Receive GRN line into store |
| POST | `/api/grns/issue` | manager+ | HO → store transfer GRN |
| POST | `/api/grns/supplier` | manager+ | Supplier receipt → HO warehouse |
| GET | `/api/warehouse` | manager+ | HO warehouse levels |

## Reports & settings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/dashboard` | Yes | KPIs, low stock, recent sales |
| GET | `/api/reports` | Yes | Date-range report |
| GET | `/api/settings` | Yes | Policy / currency |
| PUT | `/api/settings` | Yes | Update policy |
| GET | `/api/health` | No | App version + DB type |

## Sale payload example

```json
POST /api/sales
{
  "customer": "Walk-in",
  "items": [
    {"barcode": "8001000000001", "name": "ANTA Running Pro", "qty": 1, "price": 250, "cost": 120, "discount": 0, "lineTotal": 250}
  ],
  "subtotal": 250,
  "globalDiscount": 0,
  "discount": 0,
  "total": 250,
  "payment": "Cash",
  "payRef": "",
  "storeId": "s1",
  "store": "Store 1 — Tripoli"
}
```


## Head Office (`/api/ho/*`) — admin/manager

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ho/warehouse` | HO warehouse |
| POST | `/api/ho/supplier-grn` | Supplier → HO |
| POST | `/api/ho/store-grn` | HO → store GRN |
| POST | `/api/ho/transfer` | Store transfer |
| GET | `/api/ho/inventory-all` | All-store stock |
| GET | `/api/ho/pl` | Profit & Loss |
| GET | `/api/ho/balance-sheet` | Balance sheet |
| GET | `/api/ho/cashflow` | Cash flow |
| GET/POST | `/api/ho/suppliers` | Suppliers |
| GET/POST | `/api/ho/supplier-txns` | Supplier ledger |
| GET/POST | `/api/ho/capital` | Capital entries |
| GET/POST | `/api/ho/bs-entries` | Manual BS lines |
| GET/POST | `/api/ho/cf-items` | CF items |
