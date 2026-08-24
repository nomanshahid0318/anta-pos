"""SQLAlchemy engine, session, and Base."""
from __future__ import annotations

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from .config import get_settings

settings = get_settings()

connect_args = {}
pool_kwargs = {}
if settings.database_url.startswith("sqlite"):
    connect_args = {"check_same_thread": False}
else:
    # Free/small Postgres plans still allow well over this many connections.
    # Default SQLAlchemy pool (5 + 10 overflow = 15) is too small once the
    # HO dashboard fires ~16 API calls at once — bump it so a normal page
    # load doesn't exhaust the pool and start timing out other requests
    # (including login, which needs its own connection too).
    pool_kwargs = {
        "pool_size": 15,
        "max_overflow": 25,
        "pool_timeout": 30,
        "pool_recycle": 1800,  # avoid stale connections dropped by the DB host
    }

engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    pool_pre_ping=True,
    **pool_kwargs,
)


@event.listens_for(engine, "connect")
def _sqlite_pragma(dbapi_conn, connection_record):
    if settings.database_url.startswith("sqlite"):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db() -> None:
    """Create tables and seed defaults."""
    from . import models  # noqa: F401
    from . import models_accounting  # noqa: F401
    from . import models_crm  # noqa: F401
    from . import models_audit  # noqa: F401
    from . import models_shifts  # noqa: F401
    from . import models_stockcount  # noqa: F401
    from .seed import seed_if_empty

    # Ensure parent dir exists for sqlite
    if settings.database_url.startswith("sqlite:///"):
        from pathlib import Path

        db_path = Path(settings.database_url.replace("sqlite:///", ""))
        db_path.parent.mkdir(parents=True, exist_ok=True)

    Base.metadata.create_all(bind=engine)
    _auto_migrate()
    db = SessionLocal()
    try:
        seed_if_empty(db)
    finally:
        db.close()


def _auto_migrate() -> None:
    """Add newly introduced columns to existing tables (safe, additive). Works for SQLite and Postgres.

    Every statement here has a hard timeout and its own try/except — a
    single stuck lock or slow statement must NEVER be able to hang the
    entire app's startup (which is what happened once: an ALTER TABLE +
    UPDATE sharing one long transaction hung waiting on a lock, and since
    this runs synchronously before uvicorn binds to a port, Render never
    saw an open port and the whole deploy died with no error in the logs).
    """
    from sqlalchemy import inspect, text
    from sqlalchemy.exc import OperationalError

    wanted = {
        "products": {
            "color": "VARCHAR(64) DEFAULT ''",
            "department": "VARCHAR(64) DEFAULT ''",
            "season": "VARCHAR(64) DEFAULT ''",
            "gender": "VARCHAR(32) DEFAULT ''",
            "original_price": "FLOAT DEFAULT 0",
        },
        "promotions": {
            "start_time": "VARCHAR(8) DEFAULT ''",
            "end_time": "VARCHAR(8) DEFAULT ''",
        },
        "store_grn": {
            "received_by": "VARCHAR(128) DEFAULT ''",
        },
        "capital_entries": {
            "cf_item_id": "VARCHAR(64) DEFAULT ''",
        },
        "fixed_assets": {
            "cf_item_id": "VARCHAR(64) DEFAULT ''",
        },
        "supplier_txns": {
            "po_id": "VARCHAR(64) DEFAULT ''",
        },
        "sales": {
            "customer_id": "VARCHAR(64) DEFAULT ''",
            "loyalty_discount": "FLOAT DEFAULT 0",
            "loyalty_points_earned": "FLOAT DEFAULT 0",
            "shift_id": "VARCHAR(64) DEFAULT ''",
        },
        "returns": {
            "shift_id": "VARCHAR(64) DEFAULT ''",
        },
        "inventory": {
            "adjustments": "INTEGER DEFAULT 0",
        },
    }
    is_postgres = not settings.database_url.startswith("sqlite")
    inspector = inspect(engine)
    products_needs_backfill = False

    for table, cols in wanted.items():
        try:
            existing = {c["name"] for c in inspector.get_columns(table)}
        except Exception:
            continue
        for col, ddl in cols.items():
            if col in existing:
                continue
            # Each ALTER TABLE gets its own short-lived connection/
            # transaction with a hard timeout, instead of one long
            # transaction shared across every table — so a lock on one
            # table can never block the others, or the app itself.
            try:
                with engine.begin() as conn:
                    if is_postgres:
                        conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                        conn.execute(text("SET LOCAL statement_timeout = '10s'"))
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))
                if table == "products" and col == "original_price":
                    products_needs_backfill = True
            except (OperationalError, Exception):  # noqa: BLE001 — never let a migration hiccup block startup
                pass

    # One-time backfill, in its OWN transaction (never shares one with the
    # ALTER TABLE statements above) so it can't be blocked by — or block —
    # anything else. Existing products won't have an Original Price yet
    # (defaults to 0) — seed it from their current retail price so the
    # column isn't blank for everything already in the system.
    if products_needs_backfill:
        try:
            with engine.begin() as conn:
                if is_postgres:
                    conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                    conn.execute(text("SET LOCAL statement_timeout = '15s'"))
                conn.execute(text("UPDATE products SET original_price = retail WHERE original_price = 0 OR original_price IS NULL"))
        except (OperationalError, Exception):  # noqa: BLE001
            pass

    # The Sale model has always declared invoice_id+store_id as unique,
    # but on a database whose sales table already existed before that was
    # added, create_all() never goes back and adds it — so it was never
    # actually enforced. Combined with a (now-fixed) race condition in
    # invoice number generation, that let genuinely different sales slip
    # in sharing one invoice number, showing up as confusing "half-blank"
    # duplicate rows in Sales Reports. Create the missing index now. If
    # older duplicate rows already exist they're merged first — the sale
    # with the actual payment/total kept, any zero/blank duplicate
    # sharing its invoice number removed (no items are double-counted:
    # duplicates only ever occur when one row lacks real payment data).
    try:
        existing_indexes = {i["name"] for i in inspector.get_indexes("sales")} if "sales" in inspector.get_table_names() else set()
    except Exception:  # noqa: BLE001
        existing_indexes = set()
    if "uq_sale_inv_store" not in existing_indexes:
        try:
            with engine.begin() as conn:
                if is_postgres:
                    conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                    conn.execute(text("SET LOCAL statement_timeout = '15s'"))
                conn.execute(text("""
                    DELETE FROM sales WHERE id IN (
                        SELECT s1.id FROM sales s1
                        JOIN sales s2 ON s1.invoice_id = s2.invoice_id AND s1.store_id = s2.store_id AND s1.id > s2.id
                        WHERE COALESCE(s1.total, 0) = 0 OR COALESCE(s1.payment, '') = ''
                    )
                """))
                conn.execute(text(
                    "CREATE UNIQUE INDEX uq_sale_inv_store ON sales (invoice_id, store_id)"
                ))
        except (OperationalError, Exception):  # noqa: BLE001 — if real (non-blank) duplicates
            # still exist, index creation fails safely; the race-condition
            # fix in _next_invoice() still stops any *new* ones from
            # forming even without the DB-level index.
            pass
