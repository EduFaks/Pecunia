import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.audit.actions import Actions
from pecunia.events import DomainEvent, event_bus
from pecunia.models.account import Account, AccountType
from pecunia.models.asset import Asset, AssetType, AssetValuation
from pecunia.models.budget import Budget, BudgetPeriod
from pecunia.models.category import Category
from pecunia.models.contact import Contact
from pecunia.models.loan import Loan, LoanPayment
from pecunia.models.net_worth_snapshot import NetWorthSnapshot
from pecunia.models.portfolio import Holding, HoldingPrice, Portfolio
from pecunia.models.project import Project, ProjectItem, ProjectStatus, ProjectType
from pecunia.models.scheduled_transaction import ScheduledTransaction, ScheduleFrequency
from pecunia.models.subscription import Subscription
from pecunia.models.transaction import Transaction
from pecunia.models.transfer import Transfer
from pecunia.services.scoping import scoped_select
from pecunia.services.snapshots import SnapshotService

# (model, plural key) for every finance table, in children-before-parents
# order — the order remove_demo_data deletes in (task brief demo-removal-scope
# decision) and the order demo_counts/seed report in. Contacts sit after
# transactions (transactions.contact_id → contacts) and before categories
# (contacts.default_category_id → categories). Contacts/categories are last:
# transactions/budgets/contacts only reference them via ON DELETE SET NULL
# (never CASCADE), so deleting them after their referencing rows is a
# defensive convention, not an FK requirement.
_TABLES = (
    # net_worth_snapshots is a pure leaf (references only workspaces CASCADE,
    # nothing references it) so it can be deleted first. Like contacts/categories/
    # transfers it lives in _TABLES (counted, removed) but stays out of the
    # manually-built `counts` the seed returns (see seed_demo_data).
    (NetWorthSnapshot, "net_worth_snapshots"),
    # scheduled_transactions references accounts (CASCADE) and categories/
    # contacts (SET NULL); deleting it before those parents keeps children-
    # before-parents order and gives an accurate rowcount (deleting accounts
    # first would cascade the schedules away before they're counted). Like
    # contacts/categories/transfers/net_worth_snapshots it lives in _TABLES
    # (counted, removed) but stays out of the manually-built `counts` the seed
    # returns (see seed_demo_data).
    (ScheduledTransaction, "scheduled_transactions"),
    # Portfolio chain, children before parents: holding_prices → holdings →
    # portfolios (holding_prices.holding_id → holdings CASCADE; holdings.
    # portfolio_id → portfolios CASCADE; all → workspaces CASCADE). Like
    # contacts/categories/transfers/net_worth_snapshots/scheduled_transactions
    # they live in _TABLES (counted, removed) but stay out of the manually-
    # built `counts` the seed returns (see seed_demo_data).
    (HoldingPrice, "holding_prices"),
    (Holding, "holdings"),
    (Portfolio, "portfolios"),
    # Loan chain, children before parents: loan_payments → loans
    # (loan_payments.loan_id → loans CASCADE; both → workspaces CASCADE). Like
    # contacts/categories/transfers/net_worth_snapshots/scheduled_transactions/
    # the portfolio chain they live in _TABLES (counted, removed) but stay out
    # of the manually-built `counts` the seed returns (see seed_demo_data).
    (LoanPayment, "loan_payments"),
    (Loan, "loans"),
    # Subscriptions reference accounts/contacts/categories (all SET NULL) and
    # workspaces (CASCADE); deleting them before those parents keeps children-
    # before-parents order. Like contacts/categories/transfers/net_worth_snapshots/
    # scheduled_transactions/the portfolio & loan chains they live in _TABLES
    # (counted, removed) but stay out of the manually-built `counts` the seed
    # returns (see seed_demo_data).
    (Subscription, "subscriptions"),
    (AssetValuation, "asset_valuations"),
    (ProjectItem, "project_items"),
    (Transaction, "transactions"),
    # Transfers after transactions (legs reference transfers via transfer_id
    # CASCADE) and before accounts (transfers reference accounts via
    # from/to_account_id CASCADE) — children before parents. Like contacts/
    # categories, transfers live in _TABLES (counted, removed) but stay out of
    # the manually-built `counts` the seed returns (see seed_demo_data).
    (Transfer, "transfers"),
    (Asset, "assets"),
    (Project, "projects"),
    (Account, "accounts"),
    (Budget, "budgets"),
    (Contact, "contacts"),
    (Category, "categories"),
)

# Transactions: (days before the reference date, account slot, amount_minor,
# description, contact name, category name). Spans the trailing ~2 months, mixes
# inflow/outflow, and splits everyday spend across checking and the credit
# card. The category name is looked up against the workspace's existing
# categories at seed time (see _category_lookup) — never inserted here —
# so it's just the DEFAULT_CATEGORIES name that best fits the row, or None
# for the two internal transfers, which aren't income/expense at all.
# The contact name is resolved to a Contact entity id at seed time (see
# _CONTACTS / _contact_id): every contact name below has a matching Contact
# row, so every demo transaction ends up with a contact_id.
_TRANSACTIONS = [
    (58, "checking", 450_000, "Salary", "Acme Corp Payroll", "Salary"),
    (55, "checking", -12_500, "Groceries", "Green Valley Market", "Groceries"),
    (54, "savings", 50_000, "Monthly savings transfer", "Internal Transfer", None),
    (52, "credit_card", -8_900, "Streaming subscriptions", "Netflix / Spotify", "Entertainment"),
    (50, "checking", -18_000, "Rent contribution", "Sunset Apartments", "Housing"),
    (48, "credit_card", -6_200, "Dining out", "Ramen House", "Dining"),
    (46, "checking", -4_500, "Utilities", "City Power & Water", "Utilities"),
    (44, "credit_card", -3_100, "Coffee", "Corner Cafe", "Dining"),
    (42, "checking", -22_000, "Car insurance", "SafeDrive Insurance", "Transport"),
    (40, "credit_card", -15_400, "Home supplies", "Home & Hardware Co", "Shopping"),
    (37, "checking", -9_800, "Phone bill", "Telco Wireless", "Utilities"),
    (34, "checking", -12_500, "Groceries", "Green Valley Market", "Groceries"),
    (30, "credit_card", -7_600, "Gym membership", "FitLife Gym", "Health"),
    (28, "checking", -25_000, "Sim rig parts", "RaceTech Simulators", "Shopping"),
    (26, "checking", 15_000, "Freelance payment", "Client Invoice #221", "Other Income"),
    (24, "credit_card", -4_300, "Dining out", "Ramen House", "Dining"),
    (21, "checking", -12_800, "Groceries", "Green Valley Market", "Groceries"),
    (18, "savings", 50_000, "Monthly savings transfer", "Internal Transfer", None),
    (14, "checking", -6_700, "Pharmacy", "Downtown Pharmacy", "Health"),
    (10, "credit_card", -9_200, "Electronics", "ByteMart", "Shopping"),
    (6, "checking", -3_400, "Coffee", "Corner Cafe", "Dining"),
    (2, "checking", -11_000, "Groceries", "Green Valley Market", "Groceries"),
]

# The demo budget is a Groceries budget (see seed_demo_data) — this is the
# category name it's categorized under, same lookup-by-name as transactions.
_BUDGET_CATEGORY_NAME = "Groceries"

# Demo contacts (is_demo=True): every distinct contact name used by
# _TRANSACTIONS, promoted to a first-class Contact row with a type
# (person|company — most are companies; the landlord and the freelance client
# are people) and a sensible default category (contact name, default category
# name — None where no default fits, e.g. the internal transfers). Their
# default_category_id is looked up by name against the workspace's categories,
# same as _TRANSACTIONS (_category_lookup) — a name with no match just leaves
# default_category_id null. Avatars are left null (the UI renders a monogram
# fallback). seed_demo_data attaches contact_id to every demo transaction by
# matching its contact name to one of these rows, so no demo transaction is
# ever contact-less and the dataset shows contacts (and their default
# categories) in action.
_CONTACTS: list[tuple[str, str | None, str]] = [
    ("Green Valley Market", "Groceries", "company"),     # grocery store
    ("Acme Corp Payroll", "Salary", "company"),          # the employer
    ("Internal Transfer", None, "company"),              # savings transfers — no category
    ("Netflix / Spotify", "Entertainment", "company"),   # streaming services
    ("Sunset Apartments", "Housing", "person"),          # the landlord — an individual
    ("Ramen House", "Dining", "company"),                # restaurant
    ("City Power & Water", "Utilities", "company"),      # utility company
    ("Corner Cafe", "Dining", "company"),                # cafe
    ("SafeDrive Insurance", "Transport", "company"),     # vehicle insurer
    ("Home & Hardware Co", "Shopping", "company"),       # hardware store
    ("Telco Wireless", "Utilities", "company"),          # phone carrier
    ("FitLife Gym", "Health", "company"),                # gym
    ("RaceTech Simulators", "Shopping", "company"),      # sim-rig parts
    ("Client Invoice #221", "Other Income", "person"),   # freelance client — an individual
    ("Downtown Pharmacy", "Health", "company"),          # pharmacy
    ("ByteMart", "Shopping", "company"),                 # electronics store
]


async def _category_lookup(db: AsyncSession, workspace_id: uuid.UUID) -> dict[str, Category]:
    """Name -> Category for the workspace's existing, non-archived
    categories. Demo reuses these to categorize its transactions/budget
    instead of inserting its own (see seed_demo_data) — a name with no match
    (e.g. the owner renamed/archived a default before running demo) is
    handled by the caller falling back to an uncategorized (null) row rather
    than erroring."""
    categories = (
        await db.execute(
            scoped_select(Category, workspace_id).where(Category.archived_at.is_(None))
        )
    ).scalars().all()
    # First match wins on a name collision (e.g. the same name re-used across
    # kinds) — good enough for demo's purposes, which only ever look up a
    # DEFAULT_CATEGORIES name that's unambiguous in the untouched set.
    lookup: dict[str, Category] = {}
    for category in categories:
        lookup.setdefault(category.name, category)
    return lookup


class DemoAlreadyPresentError(Exception):
    """Raised by seed_demo_data when demo rows already exist for the
    workspace. The router maps this to 409 DEMO_ALREADY_PRESENT."""


async def demo_counts(db: AsyncSession, workspace_id: uuid.UUID) -> dict[str, int]:
    """Counts of is_demo=true rows per finance table for this workspace. Used
    both as the seed's already-present guard and as GET /demo's `present` +
    `counts` computation — `present` is true iff any count is nonzero."""
    counts: dict[str, int] = {}
    for model, key in _TABLES:
        n = await db.scalar(
            select(func.count())
            .select_from(model)
            .where(model.workspace_id == workspace_id, model.is_demo.is_(True))
        )
        counts[key] = int(n or 0)
    return counts


async def seed_demo_data(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    *,
    base_currency: str,
    today: date | None = None,
) -> dict[str, int]:
    """Insert a realistic, self-contained demo dataset — 3 accounts, ~20
    transactions over the trailing ~2 months, 1 project whose items reach its
    target, 1 vehicle asset with a declining valuation history, 1 budget —
    entirely flagged is_demo=true and priced in `base_currency`.

    Categories are never inserted here. By the time a user can reach this
    endpoint the workspace already has its real default categories (seeded
    by services.setup.initialize_instance at onboarding, is_demo=False) —
    re-seeding the same DEFAULT_CATEGORIES names would collide with them on
    the (workspace_id, name, kind) unique constraint. Instead, demo looks up
    the workspace's existing categories by name (_category_lookup) and
    assigns them onto the transactions/budget below, so the demo dataset
    comes in already categorized. A name with no match (renamed/archived by
    the owner before running demo) just leaves that row uncategorized rather
    than failing the whole seed.

    Rows are constructed directly rather than through the per-aggregate
    services: this is a bulk fixture load, not a sequence of individually
    meaningful user actions, so 22 per-row domain events would just be noise.
    Exactly one `data.demo_seeded` event is published at the end instead
    (CONVENTIONS §7 — event ids/audit still apply, just once).

    Contract: flushes, never commits — the caller (router) owns the
    transaction boundary (CONVENTIONS §2).
    """
    existing = await demo_counts(db, workspace_id)
    if any(existing.values()):
        raise DemoAlreadyPresentError()

    # CONVENTIONS §4: app-side "now" goes through datetime.now(UTC), never a
    # naive date.today() — .date() derives the calendar day from that.
    today = today or datetime.now(UTC).date()

    categories_by_name = await _category_lookup(db, workspace_id)

    checking = Account(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        name="Everyday Checking",
        type=AccountType.CHECKING.value,
        currency=base_currency,
        initial_balance_minor=350_000,
        is_demo=True,
    )
    savings = Account(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        name="Emergency Fund",
        type=AccountType.SAVINGS.value,
        currency=base_currency,
        initial_balance_minor=1_200_000,
        is_demo=True,
    )
    credit_card = Account(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        name="Rewards Credit Card",
        type=AccountType.CREDIT_CARD.value,
        currency=base_currency,
        initial_balance_minor=0,
        is_demo=True,
    )
    accounts_by_slot = {"checking": checking, "savings": savings, "credit_card": credit_card}
    accounts = [checking, savings, credit_card]
    db.add_all(accounts)
    await db.flush()

    def _category_id(name: str | None) -> uuid.UUID | None:
        category = categories_by_name.get(name) if name else None
        return category.id if category else None

    # Every distinct demo contact as a first-class Contact row, each with its
    # type (person|company) and default category resolved by name (null if the
    # contact has no default or the category was renamed/archived). Avatars are
    # left null. Flushed to get ids before the transactions below can reference
    # them via contact_id.
    contacts = [
        Contact(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            type=contact_type,
            default_category_id=_category_id(default_category_name),
            is_demo=True,
        )
        for name, default_category_name, contact_type in _CONTACTS
    ]
    db.add_all(contacts)
    await db.flush()
    contacts_by_name = {c.name: c for c in contacts}

    def _contact_id(name: str | None) -> uuid.UUID | None:
        contact = contacts_by_name.get(name) if name else None
        return contact.id if contact else None

    transactions = [
        Transaction(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            account_id=accounts_by_slot[slot].id,
            category_id=_category_id(category_name),
            contact_id=_contact_id(contact),
            amount_minor=amount_minor,
            currency=base_currency,
            description=description,
            occurred_on=today - timedelta(days=days_ago),
            is_demo=True,
        )
        for days_ago, slot, amount_minor, description, contact, category_name in _TRANSACTIONS
    ]
    db.add_all(transactions)
    transactions_by_description = {t.description: t for t in transactions}

    # One first-class transfer between two demo accounts (same currency): a
    # Transfer row plus two Transaction legs — -amount on the source (checking),
    # +amount on the destination (savings) — each carrying transfer_id. Legs
    # are excluded from income/spend (they relocate money, they don't earn or
    # spend it), so they carry no category/contact/project. Mirrors the two-leg
    # path TransferService.create will use, so the demo shows a real transfer.
    transfer = Transfer(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        from_account_id=checking.id,
        to_account_id=savings.id,
        amount_minor=50_000,
        currency=base_currency,
        description="Transfer to Emergency Fund",
        occurred_on=today - timedelta(days=12),
        is_demo=True,
    )
    db.add(transfer)
    await db.flush()
    transfer_legs = [
        Transaction(
            id=uuid.uuid4(), workspace_id=workspace_id, account_id=checking.id,
            transfer_id=transfer.id, amount_minor=-transfer.amount_minor,
            currency=base_currency, description=transfer.description,
            occurred_on=transfer.occurred_on, is_demo=True,
        ),
        Transaction(
            id=uuid.uuid4(), workspace_id=workspace_id, account_id=savings.id,
            transfer_id=transfer.id, amount_minor=transfer.amount_minor,
            currency=base_currency, description=transfer.description,
            occurred_on=transfer.occurred_on, is_demo=True,
        ),
    ]
    db.add_all(transfer_legs)
    # The two legs are ordinary transactions — they lift the transactions count.
    transactions = transactions + transfer_legs

    # A build project — spends toward an expected budget (vs. a saving goal).
    project = Project(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        name="Sim Rig Build",
        description="Building a proper racing sim rig",
        target_amount_minor=180_000,
        currency=base_currency,
        status=ProjectStatus.ACTIVE.value,
        type=ProjectType.SPENDING.value,
        is_demo=True,
    )
    db.add(project)
    await db.flush()

    # Link the sim-rig purchases to the project so "actual spend" has coverage.
    # The RaceTech parts order is additionally attached to a specific part
    # below (mark-bought), so the part-fulfillment path is demoed too.
    sim_rig_parts_tx = transactions_by_description["Sim rig parts"]
    electronics_tx = transactions_by_description["Electronics"]
    for tx in (sim_rig_parts_tx, electronics_tx):
        tx.project_id = project.id

    project_items = [
        ProjectItem(
            id=uuid.uuid4(), workspace_id=workspace_id, project_id=project.id,
            name="Direct drive wheel base", amount_minor=70_000, is_demo=True,
        ),
        ProjectItem(
            id=uuid.uuid4(), workspace_id=workspace_id, project_id=project.id,
            name="Load-cell pedals", amount_minor=45_000, is_demo=True,
        ),
        ProjectItem(
            # Marked bought: attached to a real linked transaction. The invariant
            # holds — sim_rig_parts_tx.project_id == this item's project_id.
            id=uuid.uuid4(), workspace_id=workspace_id, project_id=project.id,
            name="Rig chassis", amount_minor=65_000,
            transaction_id=sim_rig_parts_tx.id, is_demo=True,
        ),
    ]
    db.add_all(project_items)  # 70k + 45k + 65k = 180k — reaches the target exactly

    asset = Asset(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        name="Mercedes CLA 45 S",
        type=AssetType.VEHICLE.value,
        currency=base_currency,
        acquired_on=today - timedelta(days=730),
        is_demo=True,
    )
    db.add(asset)
    await db.flush()
    valuations = [
        AssetValuation(
            id=uuid.uuid4(), workspace_id=workspace_id, asset_id=asset.id,
            value_minor=6_800_000, as_of=today - timedelta(days=720),
            source="Purchase price", is_demo=True,
        ),
        AssetValuation(
            id=uuid.uuid4(), workspace_id=workspace_id, asset_id=asset.id,
            value_minor=5_900_000, as_of=today - timedelta(days=365),
            source="Market estimate", is_demo=True,
        ),
        AssetValuation(
            id=uuid.uuid4(), workspace_id=workspace_id, asset_id=asset.id,
            value_minor=5_200_000, as_of=today - timedelta(days=30),
            source="Market estimate", is_demo=True,
        ),
    ]
    db.add_all(valuations)

    # One investment portfolio (the Portfolio domain) in the base currency with
    # three holdings — an index fund held in a fractional quantity (12.5), a
    # stock, and a crypto position (0.15) — each with two manually-recorded
    # HoldingPrice points (an older price + a recent one) so both current value
    # and price history exist. quantity is a Decimal share/unit count (not
    # money); money lives in unit_price_minor. is_demo so removal cleans it up;
    # kept out of the returned `counts` (like contacts/transfers) — see _TABLES.
    portfolio = Portfolio(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        name="Brokerage",
        currency=base_currency,
        description="Long-term investment account",
        is_demo=True,
    )
    db.add(portfolio)
    await db.flush()

    # (name, symbol, quantity, older unit price, recent unit price) in minor units.
    _HOLDINGS = [
        ("Vanguard FTSE All-World", "VWRL", Decimal("12.5"), 9_500, 10_800),
        ("Apple Inc.", "AAPL", Decimal(30), 17_000, 22_500),
        ("Bitcoin", "BTC", Decimal("0.15"), 4_500_000, 6_200_000),
    ]
    holdings = [
        Holding(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            portfolio_id=portfolio.id,
            name=name,
            symbol=symbol,
            quantity=quantity,
            is_demo=True,
        )
        for name, symbol, quantity, _old, _new in _HOLDINGS
    ]
    db.add_all(holdings)
    await db.flush()
    holding_prices = [
        price
        for holding, (_n, _s, _q, old_price, new_price) in zip(holdings, _HOLDINGS)
        for price in (
            HoldingPrice(
                id=uuid.uuid4(), workspace_id=workspace_id, holding_id=holding.id,
                unit_price_minor=old_price, as_of=today - timedelta(days=180),
                source="Statement", is_demo=True,
            ),
            HoldingPrice(
                id=uuid.uuid4(), workspace_id=workspace_id, holding_id=holding.id,
                unit_price_minor=new_price, as_of=today - timedelta(days=5),
                source="Market estimate", is_demo=True,
            ),
        )
    ]
    db.add_all(holding_prices)

    # One borrowed loan (the Loans domain) in the base currency — a car loan
    # with a monthly planned payment and three payments already made, so its
    # remaining (principal − Σ payments = 2_500_000 − 135_000 = 2_365_000) is
    # below the principal and paydown progress shows. interest_rate_bps is
    # display-only (5.99% APR); next_due sits just after the anchor. is_demo so
    # removal cleans it up; kept out of the returned `counts` (like contacts/
    # transfers/the portfolio chain) — see _TABLES.
    loan = Loan(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        name="Car loan",
        direction="borrowed",
        principal_minor=2_500_000,
        currency=base_currency,
        interest_rate_bps=599,
        planned_payment_minor=45_000,
        payment_frequency="monthly",
        next_due=today + timedelta(days=5),
        opened_on=today - timedelta(days=365),
        description="Financing for the Mercedes CLA 45 S",
        is_demo=True,
    )
    db.add(loan)
    await db.flush()
    loan_payments = [
        LoanPayment(
            id=uuid.uuid4(), workspace_id=workspace_id, loan_id=loan.id,
            amount_minor=45_000, paid_on=today - timedelta(days=days_ago),
            note="Monthly payment", is_demo=True,
        )
        for days_ago in (90, 60, 30)
    ]
    db.add_all(loan_payments)

    # Three subscriptions (the Subscriptions domain) in the base currency — a
    # tracker of the recurring services the user pays for, deliberately NOT
    # auto-posted (Planned owns recurring posting; "renew" only advances the
    # date). Two monthly consumer services reuse their existing demo contact +
    # category (streaming → the Netflix / Spotify contact + Entertainment, on
    # the credit card; the gym → the FitLife Gym contact + Health, on the credit
    # card) and one yearly cloud tool has no vendor contact (Shopping, on
    # checking). next_renewal sits just after the anchor so upcoming renewals
    # show; status active; logos left null (the UI renders a monogram fallback).
    # Flagged is_demo so removal cleans them up; kept out of the returned
    # `counts` (like contacts/transfers/the portfolio & loan chains) — see
    # _TABLES.
    # (name, amount_minor, frequency, days-after-anchor, account slot, contact, category)
    _SUBSCRIPTIONS = [
        ("Netflix / Spotify", 8_900, "monthly", 7, "credit_card", "Netflix / Spotify", "Entertainment"),
        ("FitLife Gym", 7_600, "monthly", 15, "credit_card", "FitLife Gym", "Health"),
        ("Cloud Drive Pro", 120_000, "yearly", 40, "checking", None, "Shopping"),
    ]
    subscriptions = [
        Subscription(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            amount_minor=amount_minor,
            currency=base_currency,
            billing_frequency=frequency,
            next_renewal=today + timedelta(days=days_after),
            status="active",
            account_id=accounts_by_slot[slot].id,
            contact_id=_contact_id(contact_name),
            category_id=_category_id(category_name),
            is_demo=True,
        )
        for name, amount_minor, frequency, days_after, slot, contact_name, category_name in _SUBSCRIPTIONS
    ]
    db.add_all(subscriptions)

    budget = Budget(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        name="Groceries",
        category_id=_category_id(_BUDGET_CATEGORY_NAME),
        period=BudgetPeriod.MONTHLY.value,
        amount_minor=60_000,
        currency=base_currency,
        is_demo=True,
    )
    db.add(budget)
    await db.flush()

    # Two active recurring schedules (the Planned domain) — upcoming money the
    # user knows is coming, deliberately NOT posted (they're due just after the
    # anchor, so the demo shows them as upcoming, awaiting a one-click post):
    # a monthly salary (income, into checking) and a monthly rent (expense,
    # from checking). Signed amount_minor, same convention as transactions.
    # Flagged is_demo so removal cleans them up; kept out of the returned
    # `counts` (like contacts/categories/transfers/net_worth_snapshots) — see
    # _TABLES.
    schedules = [
        ScheduledTransaction(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            account_id=checking.id,
            category_id=_category_id("Salary"),
            contact_id=_contact_id("Acme Corp Payroll"),
            amount_minor=450_000,
            currency=base_currency,
            description="Monthly salary",
            frequency=ScheduleFrequency.MONTHLY.value,
            next_due=today + timedelta(days=5),
            is_active=True,
            is_demo=True,
        ),
        ScheduledTransaction(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            account_id=checking.id,
            category_id=_category_id("Housing"),
            contact_id=_contact_id("Sunset Apartments"),
            amount_minor=-180_000,
            currency=base_currency,
            description="Monthly rent",
            frequency=ScheduleFrequency.MONTHLY.value,
            next_due=today + timedelta(days=3),
            is_active=True,
            is_demo=True,
        ),
    ]
    db.add_all(schedules)
    await db.flush()

    # A ~12-point net-worth history so the demo dashboard's graph is populated
    # immediately: month-ends over the last year plus `today`, reconstructed
    # from the accounts/transactions/asset valuations just seeded. Flagged
    # is_demo so removal cleans them up. Kept out of the returned `counts`
    # (like contacts/categories/transfers) — see _TABLES.
    await SnapshotService(db).backfill(workspace_id, months=12, today=today, is_demo=True)

    counts = {
        "accounts": len(accounts),
        "transactions": len(transactions),
        "projects": 1,
        "project_items": len(project_items),
        "assets": 1,
        "asset_valuations": len(valuations),
        "budgets": 1,
    }
    await event_bus.publish(
        db,
        DomainEvent(
            action=Actions.DATA_DEMO_SEEDED,
            resource_type="workspace",
            resource_id=str(workspace_id),
            workspace_id=workspace_id,
            metadata={"base_currency": base_currency, **counts},
        ),
    )
    return counts


async def remove_demo_data(db: AsyncSession, workspace_id: uuid.UUID) -> dict[str, int]:
    """Delete exactly the is_demo=true rows for this workspace, children
    first (asset_valuations, project_items, transactions) then parents
    (assets, projects, accounts, budgets). Real (is_demo=false) rows are
    never touched.

    Scope decision (documented in the task-7 report + CONVENTIONS §7 note):
    this deletes only the demo *domain* rows. It does NOT delete
    audit_events (append-only — a DB trigger blocks it anyway) nor
    activity_entries (a historical record of what happened, same as any
    other deleted resource's activity trail). "Demo data can be cleanly
    removed" refers to the financial data that would otherwise pollute
    balances/lists — that's what this deletes; the fact that a demo was once
    seeded and later removed remains visible in audit/activity history,
    exactly like any other create-then-delete sequence in the product.

    Contract: flushes, never commits — the caller (router) owns the
    transaction boundary (CONVENTIONS §2).
    """
    counts: dict[str, int] = {}
    for model, key in _TABLES:
        result = await db.execute(
            delete(model).where(model.workspace_id == workspace_id, model.is_demo.is_(True))
        )
        counts[key] = result.rowcount or 0
    await db.flush()
    await event_bus.publish(
        db,
        DomainEvent(
            action=Actions.DATA_DEMO_REMOVED,
            resource_type="workspace",
            resource_id=str(workspace_id),
            workspace_id=workspace_id,
            metadata=counts,
        ),
    )
    return counts
