"""`BankSyncService` (Task 4, Track T): links a Pluggy provider account to a
Pecunia account (existing or freshly created), imports its transaction
history, anchors the account's initial balance so the derived balance
matches the provider's reported one, and re-syncs on a schedule — dedup by
`external_id` (tombstone-aware: a soft-deleted imported row is never
recreated), with per-connection error isolation so one failing bank never
blocks the others.

Contract: methods flush, never commit — the caller (router, or the daily
scheduler) owns the transaction boundary (CONVENTIONS §2). `BankProviderError`
propagates uncaught from `discover`/`link_account` (the router maps it to
503); `sync_workspace` captures it per connection instead, so the rest of the
workspace's connections still sync. Clock-free: `today` is passed in, never
read from the clock here — `last_synced_at`/`provider_balance_as_of` are
timestamps (like soft-delete), not "business dates", so `datetime.now(UTC)`
is fine for those."""

import logging
import uuid
from datetime import UTC, date, datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.account import Account, AccountType
from pecunia.models.bank_sync import (
    BankAccountLink,
    BankCategoryMapping,
    BankConnection,
    BankConnectionStatus,
)
from pecunia.models.category import Category
from pecunia.models.transaction import Transaction
from pecunia.services.accounts import AccountService
from pecunia.services.banksync.provider import (
    BankItemNotFoundError,
    BankProvider,
    BankProviderError,
    ProviderAccount,
)
from pecunia.services.scoping import get_scoped, scoped_select
from pecunia.services.transactions import (
    AccountNotFoundError,
    CategoryNotFoundError,
    CurrencyMismatchError,
    TransactionService,
)

logger = logging.getLogger(__name__)

# A subsequent sync widens its window this many days before the last
# successful sync, to catch a transaction that posted late (e.g. a pending
# charge that settled after the previous run already passed its date) —
# never earlier than the link's own `sync_from` floor, though. 30 days
# (rather than a tighter 7) covers realistic card-posting delays at trivial
# cost for personal scale — dedupe (external_id) absorbs the wider re-fetch.
SYNC_OVERLAP_DAYS = 30


class ConnectionNotFoundError(Exception):
    """Raised when a bank connection doesn't exist in the caller's workspace.
    The router maps this to 404."""


class LinkNotFoundError(Exception):
    """Raised when a bank account link doesn't exist in the caller's
    workspace. The router maps this to 404."""


class AccountAlreadyLinkedError(Exception):
    """Raised when the target account already has a bank account link (an
    account is either fully manual or fully synced, never both). The router
    maps this to 409 ACCOUNT_ALREADY_LINKED."""


class PluggyAccountAlreadyLinkedError(Exception):
    """Raised when the provider account is already linked to some account in
    this workspace. The router maps this to 409 PLUGGY_ACCOUNT_ALREADY_LINKED."""


class PluggyAccountNotFoundError(Exception):
    """Raised when the requested item/account isn't among what the provider
    currently reports. The router maps this to 404 PLUGGY_ACCOUNT_NOT_FOUND."""


def _account_type(provider_account: ProviderAccount) -> str:
    """CREDIT -> credit_card; a BANK account whose subtype is SAVINGS_ACCOUNT
    -> savings; everything else (checking, and any subtype we don't
    specifically recognize) -> checking."""
    if provider_account.type == "CREDIT":
        return AccountType.CREDIT_CARD
    if provider_account.type == "BANK" and provider_account.subtype == "SAVINGS_ACCOUNT":
        return AccountType.SAVINGS
    return AccountType.CHECKING


class BankSyncService:
    """Bank-sync business logic. Contract: methods flush, never commit — the
    caller (router) owns the transaction boundary (CONVENTIONS §2).
    `BankProviderError` propagates from `discover`/`link_account`;
    `sync_workspace` captures it per connection instead."""

    def __init__(self, db: AsyncSession, provider: BankProvider):
        self.db = db
        self.provider = provider

    async def discover_item(self, workspace_id: uuid.UUID, item_id: str) -> dict:
        """Discover a single Pluggy item by id (Meu Pluggy's free tier has no
        client-wide item listing — `BankItemNotFoundError` propagates
        uncaught here, the router maps it to 404 PLUGGY_ITEM_NOT_FOUND)."""
        links = (
            (await self.db.execute(scoped_select(BankAccountLink, workspace_id)))
            .scalars()
            .all()
        )
        linked_account_by_pluggy_id = {link.pluggy_account_id: link.account_id for link in links}

        connection = await self.provider.fetch_connection(item_id)
        provider_accounts = await self.provider.fetch_accounts(connection.item_id)
        return {
            "item_id": connection.item_id,
            "institution_name": connection.institution_name,
            "status": connection.status,
            "accounts": [
                {
                    "pluggy_account_id": acc.pluggy_account_id,
                    "type": acc.type,
                    "subtype": acc.subtype,
                    "name": acc.name,
                    "number": acc.number,
                    "balance_minor": acc.balance_minor,
                    "currency": acc.currency,
                    "credit_limit_minor": acc.credit_limit_minor,
                    "bill_close_date": acc.bill_close_date,
                    "bill_due_date": acc.bill_due_date,
                    "linked_account_id": linked_account_by_pluggy_id.get(acc.pluggy_account_id),
                }
                for acc in provider_accounts
            ],
        }

    async def link_account(
        self,
        workspace_id: uuid.UUID,
        *,
        pluggy_item_id: str,
        pluggy_account_id: str,
        sync_from: date,
        today: date,
        account_id: uuid.UUID | None = None,
        new_account_name: str | None = None,
    ) -> BankAccountLink:
        # 1. Resolve the provider's view of this item/account. Either side
        # missing means the caller named something the provider doesn't (or
        # no longer) know about — a BankItemNotFoundError here is just that,
        # translated to this method's own not-found contract rather than
        # propagating the provider-shaped exception (discover_item, by
        # contrast, lets it propagate — see that method's docstring).
        try:
            connection_data = await self.provider.fetch_connection(pluggy_item_id)
        except BankItemNotFoundError:
            raise PluggyAccountNotFoundError() from None
        provider_accounts = await self.provider.fetch_accounts(pluggy_item_id)
        provider_account = next(
            (a for a in provider_accounts if a.pluggy_account_id == pluggy_account_id), None
        )
        if provider_account is None:
            raise PluggyAccountNotFoundError()

        # 2. Guards — an account is either fully manual or fully synced, and
        # a provider account is linked at most once per workspace.
        if account_id is not None:
            already_linked = await self.db.scalar(
                scoped_select(BankAccountLink, workspace_id).where(
                    BankAccountLink.account_id == account_id
                )
            )
            if already_linked is not None:
                raise AccountAlreadyLinkedError()
        pluggy_already_linked = await self.db.scalar(
            scoped_select(BankAccountLink, workspace_id).where(
                BankAccountLink.pluggy_account_id == pluggy_account_id
            )
        )
        if pluggy_already_linked is not None:
            raise PluggyAccountAlreadyLinkedError()

        # 3. Upsert the BankConnection by (workspace, item).
        connection = await self.db.scalar(
            scoped_select(BankConnection, workspace_id).where(
                BankConnection.pluggy_item_id == pluggy_item_id
            )
        )
        if connection is None:
            connection = BankConnection(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                pluggy_item_id=pluggy_item_id,
                institution_name=connection_data.institution_name,
                status=BankConnectionStatus.OK.value,
            )
            self.db.add(connection)
            await self.db.flush()
            await event_bus.publish(
                self.db,
                DomainEvent(
                    action=Actions.BANK_CONNECTION_CREATED,
                    resource_type="bank_connection",
                    resource_id=str(connection.id),
                    workspace_id=workspace_id,
                    after=project("bank_connection", connection),
                ),
            )

        # 4. Resolve the Pecunia account: an existing one (currency-checked)
        # or a new one derived from the provider account.
        if account_id is not None:
            account = await get_scoped(self.db, Account, account_id, workspace_id)
            if account is None:
                raise AccountNotFoundError()
            if account.currency != provider_account.currency:
                raise CurrencyMismatchError()
        else:
            account = await AccountService(self.db).create(
                workspace_id,
                name=new_account_name or provider_account.name,
                type=_account_type(provider_account),
                currency=provider_account.currency,
            )

        # 5. Create the link, carrying the provider's reported figures.
        link = BankAccountLink(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            connection_id=connection.id,
            account_id=account.id,
            pluggy_account_id=pluggy_account_id,
            sync_from=sync_from,
            provider_balance_minor=provider_account.balance_minor,
            provider_balance_as_of=datetime.now(UTC),
            credit_limit_minor=provider_account.credit_limit_minor,
            bill_close_date=provider_account.bill_close_date,
            bill_due_date=provider_account.bill_due_date,
        )
        self.db.add(link)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.BANK_ACCOUNT_LINKED,
                resource_type="bank_account_link",
                resource_id=str(link.id),
                workspace_id=workspace_id,
                after=project("bank_account_link", link),
            ),
        )

        # 6. First import.
        await self._sync_link(link, from_date=sync_from, today=today)

        # 7. Anchor ONCE, after importing (never before — anchoring first
        # would double-count the transactions about to be imported).
        # Row-locked: a link_account racing another mutation of this same
        # account (e.g. a concurrent reconcile()) must not read a
        # not-yet-committed balance and compute a stale adjustment (finding
        # 3). `populate_existing` refreshes `account` in place with the
        # locked, possibly-newer column values.
        account = (
            await self.db.execute(
                scoped_select(Account, workspace_id)
                .where(Account.id == account.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
        account_svc = AccountService(self.db)
        # AccountService.balance() sums a Postgres numeric (SUM(bigint)) and
        # comes back as Decimal — coerce to a plain int before it touches
        # initial_balance_minor (a BigInteger column) or an event payload
        # (Decimal isn't JSON-serializable).
        derived_balance = int(await account_svc.balance(account))
        before = project("account", account)
        account.initial_balance_minor += provider_account.balance_minor - derived_balance
        account.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.ACCOUNT_BALANCE_RECONCILED,
                resource_type="account",
                resource_id=str(account.id),
                workspace_id=workspace_id,
                before=before,
                after=project("account", account),
            ),
        )

        # 8. The link succeeded end to end — reflect that on the connection.
        connection.status = BankConnectionStatus.OK.value
        connection.last_error = None
        connection.last_synced_at = datetime.now(UTC)
        await self.db.flush()

        return link

    async def sync_workspace(self, workspace_id: uuid.UUID, *, today: date) -> dict:
        stored_connections = (
            (await self.db.execute(scoped_select(BankConnection, workspace_id)))
            .scalars()
            .all()
        )
        created = 0
        skipped = 0
        errors: list[str] = []

        for connection in stored_connections:
            try:
                try:
                    connection_data = await self.provider.fetch_connection(
                        connection.pluggy_item_id
                    )
                    item_status: str | None = connection_data.status
                except BankItemNotFoundError:
                    # The item vanished from the provider entirely (e.g. the
                    # user removed it directly in Pluggy) — distinct from any
                    # known status string (finding 10). Not a generic outage:
                    # handled inline here (item_status stays a sentinel for
                    # the branch below), not by the outer except, so the
                    # per-link import still runs and this still counts as a
                    # completed (not failed) sync round.
                    item_status = None

                provider_accounts = await self.provider.fetch_accounts(connection.pluggy_item_id)
                provider_accounts_by_id = {a.pluggy_account_id: a for a in provider_accounts}

                links = (
                    (
                        await self.db.execute(
                            scoped_select(BankAccountLink, workspace_id).where(
                                BankAccountLink.connection_id == connection.id
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                # Per-link isolation (finding 7): one link's own import
                # failure — a provider error scoped to just that account, or
                # a CurrencyMismatchError from one FX transaction on a card
                # whose account currency doesn't match — must not abort its
                # siblings. Unlike the outer except below (a break at the
                # connection level, before any link here was even attempted),
                # this is "we got partway through this connection's links".
                link_errors: list[str] = []
                for link in links:
                    window_start = link.sync_from
                    if connection.last_synced_at is not None:
                        window_start = max(
                            link.sync_from,
                            connection.last_synced_at.date() - timedelta(days=SYNC_OVERLAP_DAYS),
                        )
                    provider_account = provider_accounts_by_id.get(link.pluggy_account_id)
                    try:
                        # Import FIRST, only then adopt the provider's
                        # reported balance/card fields — writing them before
                        # a successful import would let a raised _sync_link
                        # leave a flushed balance on a link whose
                        # transactions were never actually fetched, opening
                        # a false divergence that Reconcile "fixes" and the
                        # next real sync double-counts (finding 2).
                        link_created, link_skipped = await self._sync_link(
                            link, from_date=window_start, today=today
                        )
                    except (BankProviderError, CurrencyMismatchError) as exc:
                        link_errors.append(str(exc))
                        logger.warning(
                            "Bank sync failed for link %s on connection %s (%s): %s",
                            link.pluggy_account_id,
                            connection.pluggy_item_id,
                            connection.institution_name,
                            exc,
                        )
                        continue
                    created += link_created
                    skipped += link_skipped
                    if provider_account is not None:
                        link.provider_balance_minor = provider_account.balance_minor
                        link.provider_balance_as_of = datetime.now(UTC)
                        link.credit_limit_minor = provider_account.credit_limit_minor
                        link.bill_close_date = provider_account.bill_close_date
                        link.bill_due_date = provider_account.bill_due_date
                errors.extend(link_errors)

                if link_errors:
                    # A failed link overrides whatever the item status would
                    # otherwise have implied — a healthy Pluggy connection
                    # with one bad link is still a connection this sync
                    # round did not fully complete.
                    connection.status = BankConnectionStatus.ERROR.value
                    connection.last_error = link_errors[0]
                elif item_status is None:
                    # The item vanished from the provider's own listing
                    # entirely (e.g. the user removed it in Pluggy) —
                    # distinct from any known status string (finding 10).
                    connection.status = BankConnectionStatus.ERROR.value
                    connection.last_error = "ITEM_NOT_FOUND"
                elif item_status in ("UPDATED", "UPDATING"):
                    # UPDATING is Pluggy still refreshing this item — not an
                    # error, just not "done" yet (finding 10).
                    connection.status = BankConnectionStatus.OK.value
                    connection.last_error = None
                else:
                    connection.status = BankConnectionStatus.ERROR.value
                    connection.last_error = item_status
                # Only a genuinely fresh (UPDATED) round with every link
                # clean advances the watermark — an item stuck in
                # LOGIN_ERROR/UPDATING/vanished never raises here (its data
                # is just stale or partial), so without this guard the
                # window would silently slide past an outage and the
                # eventually-repaired login would never re-fetch what it
                # missed (finding 1 + finding 7).
                if item_status == "UPDATED" and not link_errors:
                    connection.last_synced_at = datetime.now(UTC)
                await self.db.flush()
                await event_bus.publish(
                    self.db,
                    DomainEvent(
                        action=Actions.BANK_SYNC_COMPLETED,
                        resource_type="bank_connection",
                        resource_id=str(connection.id),
                        workspace_id=workspace_id,
                        after=project("bank_connection", connection),
                    ),
                )
            except BankProviderError as exc:
                errors.append(str(exc))
                logger.warning(
                    "Bank sync failed for connection %s (%s): %s",
                    connection.pluggy_item_id,
                    connection.institution_name,
                    exc,
                )
                connection.status = BankConnectionStatus.ERROR.value
                connection.last_error = str(exc)
                await self.db.flush()
                await event_bus.publish(
                    self.db,
                    DomainEvent(
                        action=Actions.BANK_SYNC_FAILED,
                        resource_type="bank_connection",
                        resource_id=str(connection.id),
                        workspace_id=workspace_id,
                        after=project("bank_connection", connection),
                    ),
                )
                continue

        return {
            "connections": len(stored_connections),
            "created": created,
            "skipped": skipped,
            "errors": errors,
        }

    async def _sync_link(
        self, link: BankAccountLink, *, from_date: date, today: date
    ) -> tuple[int, int]:
        rows = await self.provider.fetch_transactions(link.pluggy_account_id, from_date=from_date)
        posted = [row for row in rows if row.status == "POSTED"]
        if not posted:
            return (0, 0)

        external_ids = [row.external_id for row in posted]
        # NOT filtered by deleted_at — a soft-deleted imported row is a
        # tombstone: it stays deleted on re-sync rather than resurrecting.
        existing_ids = set(
            (
                await self.db.execute(
                    sa.select(Transaction.external_id).where(
                        Transaction.account_id == link.account_id,
                        Transaction.external_id.in_(external_ids),
                    )
                )
            )
            .scalars()
            .all()
        )

        mappings = (
            (await self.db.execute(scoped_select(BankCategoryMapping, link.workspace_id)))
            .scalars()
            .all()
        )
        category_by_pluggy_category = {m.pluggy_category: m.category_id for m in mappings}

        tx_service = TransactionService(self.db)
        created = 0
        skipped = 0
        for row in posted:
            if row.external_id in existing_ids:
                skipped += 1
                continue
            await tx_service.create(
                link.workspace_id,
                account_id=link.account_id,
                amount_minor=row.amount_minor,
                currency=row.currency,
                description=row.description,
                occurred_on=row.date,
                category_id=category_by_pluggy_category.get(row.pluggy_category),
                external_id=row.external_id,
            )
            created += 1
        return (created, skipped)

    async def list_connections(self, workspace_id: uuid.UUID) -> list[dict]:
        connections = (
            (await self.db.execute(scoped_select(BankConnection, workspace_id)))
            .scalars()
            .all()
        )
        account_svc = AccountService(self.db)
        result = []
        for connection in connections:
            links = (
                (
                    await self.db.execute(
                        scoped_select(BankAccountLink, workspace_id).where(
                            BankAccountLink.connection_id == connection.id
                        )
                    )
                )
                .scalars()
                .all()
            )
            link_dicts = []
            for link in links:
                account = await get_scoped(self.db, Account, link.account_id, workspace_id)
                derived_balance_minor = (
                    int(await account_svc.balance(account)) if account else None
                )
                link_dicts.append(
                    {
                        "id": link.id,
                        "connection_id": link.connection_id,
                        "account_id": link.account_id,
                        "account_name": account.name if account else None,
                        "account_currency": account.currency if account else None,
                        "pluggy_account_id": link.pluggy_account_id,
                        "sync_from": link.sync_from,
                        "provider_balance_minor": link.provider_balance_minor,
                        "provider_balance_as_of": link.provider_balance_as_of,
                        "derived_balance_minor": derived_balance_minor,
                        "credit_limit_minor": link.credit_limit_minor,
                        "bill_close_date": link.bill_close_date,
                        "bill_due_date": link.bill_due_date,
                    }
                )
            result.append(
                {
                    "id": connection.id,
                    "pluggy_item_id": connection.pluggy_item_id,
                    "institution_name": connection.institution_name,
                    "status": connection.status,
                    "last_error": connection.last_error,
                    "last_synced_at": connection.last_synced_at,
                    "links": link_dicts,
                }
            )
        return result

    async def reconcile(
        self, workspace_id: uuid.UUID, link_id: uuid.UUID, *, today: date
    ) -> Transaction | None:
        link = await get_scoped(self.db, BankAccountLink, link_id, workspace_id)
        if link is None:
            raise LinkNotFoundError()
        # Row-locked: a double-clicked Reconcile, or one racing the daily
        # sync job's own anchor step, must serialize on this Account row
        # rather than both reading the same pre-adjustment balance and each
        # posting their own "gap" (finding 3). `populate_existing` ensures we
        # see the lock-winner's committed values, not a stale snapshot.
        account = (
            await self.db.execute(
                scoped_select(Account, workspace_id)
                .where(Account.id == link.account_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if account is None:
            raise LinkNotFoundError()
        account_svc = AccountService(self.db)
        balance = int(await account_svc.balance(account))
        gap = (link.provider_balance_minor or 0) - balance
        if gap == 0:
            return None
        before = project("account", account)
        transaction = await TransactionService(self.db).create(
            workspace_id,
            account_id=account.id,
            amount_minor=gap,
            currency=account.currency,
            description="Ajuste de reconciliação",
            occurred_on=today,
            external_id=None,
        )
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.ACCOUNT_BALANCE_RECONCILED,
                resource_type="account",
                resource_id=str(account.id),
                workspace_id=workspace_id,
                before=before,
                after=project("account", account),
            ),
        )
        return transaction

    async def unlink(self, workspace_id: uuid.UUID, link_id: uuid.UUID) -> None:
        link = await get_scoped(self.db, BankAccountLink, link_id, workspace_id)
        if link is None:
            raise LinkNotFoundError()
        before = project("bank_account_link", link)
        await self.db.delete(link)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.BANK_ACCOUNT_UNLINKED,
                resource_type="bank_account_link",
                resource_id=str(link_id),
                workspace_id=workspace_id,
                before=before,
            ),
        )

    async def delete_connection(self, workspace_id: uuid.UUID, connection_id: uuid.UUID) -> None:
        connection = await get_scoped(self.db, BankConnection, connection_id, workspace_id)
        if connection is None:
            raise ConnectionNotFoundError()
        before = project("bank_connection", connection)
        # BankAccountLink rows CASCADE at the DB level (connection_id FK).
        await self.db.delete(connection)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.BANK_CONNECTION_DELETED,
                resource_type="bank_connection",
                resource_id=str(connection_id),
                workspace_id=workspace_id,
                before=before,
            ),
        )

    async def list_mappings(self, workspace_id: uuid.UUID) -> list[BankCategoryMapping]:
        return (
            (await self.db.execute(scoped_select(BankCategoryMapping, workspace_id)))
            .scalars()
            .all()
        )

    async def replace_mappings(
        self, workspace_id: uuid.UUID, mappings: list[tuple[str, uuid.UUID]]
    ) -> list[BankCategoryMapping]:
        # Validate every category BEFORE mutating anything — an invalid
        # mapping must leave the existing set untouched.
        for _, category_id in mappings:
            category = await get_scoped(self.db, Category, category_id, workspace_id)
            if category is None:
                raise CategoryNotFoundError()

        existing = (
            (await self.db.execute(scoped_select(BankCategoryMapping, workspace_id)))
            .scalars()
            .all()
        )
        for row in existing:
            await self.db.delete(row)
        await self.db.flush()

        new_rows = []
        for pluggy_category, category_id in mappings:
            row = BankCategoryMapping(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                pluggy_category=pluggy_category,
                category_id=category_id,
            )
            self.db.add(row)
            new_rows.append(row)
        await self.db.flush()

        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.BANK_CATEGORY_MAPPINGS_REPLACED,
                resource_type="bank_category_mapping",
                workspace_id=workspace_id,
                after={"count": len(mappings)},
            ),
        )
        return new_rows
