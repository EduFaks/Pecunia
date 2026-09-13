import builtins
import re
import uuid
from datetime import UTC, date, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from pecunia import period
from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.account import Account
from pecunia.models.category import Category
from pecunia.models.contact import Contact
from pecunia.models.subscription import Subscription, SubscriptionStatus
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select

# Reuse the transaction domain's FK-lookup exceptions so the router maps a
# foreign account/category/contact to the same 404 codes the rest of the app
# uses (ACCOUNT_NOT_FOUND / CATEGORY_NOT_FOUND / CONTACT_NOT_FOUND).
from pecunia.services.transactions import (
    AccountNotFoundError,
    CategoryNotFoundError,
    ContactNotFoundError,
)

# Sentinel distinguishing "field absent from the PATCH body" from "field
# explicitly set to null" for the nullable columns
# (logo/started_on/contact_id/account_id/category_id).
UNSET = object()

# A logo is a base64 data-URI image, downscaled client-side — the exact same
# rule as a contact avatar (Track H): require the expected prefix and cap the
# size, since it is stored inline in the row rather than behind an image
# service. Same size constant as ContactService's avatar (64KB).
_LOGO_PREFIX = re.compile(r"^data:image/(png|jpeg|webp);base64,")
MAX_LOGO_BYTES = 64 * 1024

_VALID_STATUSES = frozenset(s.value for s in SubscriptionStatus)

# Occurrences per year for each billing cycle — the annualization factor.
_ANNUAL_FACTOR = {"weekly": 52, "monthly": 12, "quarterly": 4, "yearly": 1}


class NonPositiveAmountError(Exception):
    """Raised when a subscription's amount_minor <= 0 — a subscription cost is a
    positive integer in minor units (CONVENTIONS §4). The router maps this to
    422 SUBSCRIPTION_NONPOSITIVE."""


class LogoInvalidError(Exception):
    """Raised when a subscription's logo is not a `data:image/(png|jpeg|webp);
    base64,…` data-URI or exceeds the ~64KB cap. The router maps this to 422
    LOGO_INVALID (same rule as a contact avatar)."""


def _validate_logo(logo: str | None) -> None:
    """Guard a subscription logo when one is set: it must be a base64 data-URI
    of an allowed image type and stay within the size cap. None passes (a
    subscription renders a monogram fallback when absent)."""
    if logo is None:
        return
    if not _LOGO_PREFIX.match(logo):
        raise LogoInvalidError()
    if len(logo.encode("utf-8")) > MAX_LOGO_BYTES:
        raise LogoInvalidError()


def annual_minor(amount_minor: int, freq: str) -> int:
    """Annualized cost in integer minor units: `amount_minor` × occurrences per
    year (weekly 52, monthly 12, quarterly 4, yearly 1). Exact — no rounding,
    so it never drifts (CONVENTIONS §4). Raises ValueError on an unknown
    frequency."""
    try:
        return amount_minor * _ANNUAL_FACTOR[freq]
    except KeyError:
        raise ValueError(f"unknown billing frequency: {freq!r}") from None


def monthly_minor(amount_minor: int, freq: str) -> int:
    """Per-month cost in integer minor units: the annualized figure divided by
    12, rounded to the nearest minor unit with Python's built-in `round()`
    (banker's rounding — round-half-to-even). Every frequency normalizes through
    the one annual figure, so they all share this single, defined rounding
    rule."""
    return round(annual_minor(amount_minor, freq) / 12)


class SubscriptionService:
    """Subscription business logic — a registry of recurring services you pay
    for, NOT an auto-poster (Planned remains the thing that posts recurring
    transactions). Money is integer minor units and is never summed across
    currencies (CONVENTIONS §4). Contract: methods flush, never commit — the
    caller (router) owns the transaction boundary (§2). Clock-free: dates are
    passed in, never read from the clock (§4)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    # ---- FK validation (foreign link → 404) ------------------------------- #

    async def _validate_contact(self, workspace_id: uuid.UUID, contact_id: uuid.UUID) -> None:
        if await get_scoped(self.db, Contact, contact_id, workspace_id) is None:
            raise ContactNotFoundError()

    async def _validate_account(self, workspace_id: uuid.UUID, account_id: uuid.UUID) -> None:
        if await get_scoped(self.db, Account, account_id, workspace_id) is None:
            raise AccountNotFoundError()

    async def _validate_category(self, workspace_id: uuid.UUID, category_id: uuid.UUID) -> None:
        if await get_scoped(self.db, Category, category_id, workspace_id) is None:
            raise CategoryNotFoundError()

    async def _validate_links(
        self,
        workspace_id: uuid.UUID,
        *,
        contact_id: uuid.UUID | None,
        account_id: uuid.UUID | None,
        category_id: uuid.UUID | None,
    ) -> None:
        if contact_id is not None:
            await self._validate_contact(workspace_id, contact_id)
        if account_id is not None:
            await self._validate_account(workspace_id, account_id)
        if category_id is not None:
            await self._validate_category(workspace_id, category_id)

    # ---- CRUD ------------------------------------------------------------- #

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        name: str,
        amount_minor: int,
        currency: str,
        billing_frequency: str,
        next_renewal: date,
        logo: str | None = None,
        started_on: date | None = None,
        status: str = SubscriptionStatus.ACTIVE.value,
        contact_id: uuid.UUID | None = None,
        account_id: uuid.UUID | None = None,
        category_id: uuid.UUID | None = None,
    ) -> Subscription:
        if amount_minor <= 0:
            raise NonPositiveAmountError()
        _validate_logo(logo)
        await self._validate_links(
            workspace_id,
            contact_id=contact_id,
            account_id=account_id,
            category_id=category_id,
        )
        sub = Subscription(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            logo=logo,
            amount_minor=amount_minor,
            currency=currency,
            billing_frequency=billing_frequency,
            next_renewal=next_renewal,
            started_on=started_on,
            status=status,
            contact_id=contact_id,
            account_id=account_id,
            category_id=category_id,
        )
        self.db.add(sub)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SUBSCRIPTION_CREATED,
                resource_type="subscription",
                resource_id=str(sub.id),
                workspace_id=workspace_id,
                after=project("subscription", sub),
                activity_template=Activity.SUBSCRIPTION_CREATED,
                activity_params={"name": sub.name, "currency": sub.currency},
            ),
        )
        return sub

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        contact_id: uuid.UUID | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[builtins.list[Subscription], str | None]:
        stmt = scoped_select(Subscription, workspace_id)
        if contact_id is not None:
            stmt = stmt.where(Subscription.contact_id == contact_id)
        # Soonest-renewal-first: the next thing to be billed is what the user
        # looks for. The id tiebreaker keeps a walk deterministic when several
        # subscriptions share a next_renewal (e.g. seeded together) (§6).
        stmt = stmt.order_by(Subscription.next_renewal.asc(), Subscription.id.asc())
        return await keyset_page(
            self.db,
            stmt,
            Subscription.next_renewal,
            Subscription.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
            descending=False,
        )

    async def get(
        self, workspace_id: uuid.UUID, subscription_id: uuid.UUID
    ) -> Subscription | None:
        return await get_scoped(self.db, Subscription, subscription_id, workspace_id)

    async def update(
        self,
        sub: Subscription,
        *,
        name: str | None = None,
        amount_minor: int | None = None,
        currency: str | None = None,
        billing_frequency: str | None = None,
        next_renewal: date | None = None,
        status: str | None = None,
        logo: object = UNSET,
        started_on: object = UNSET,
        contact_id: object = UNSET,
        account_id: object = UNSET,
        category_id: object = UNSET,
    ) -> Subscription:
        # Validate everything BEFORE mutating anything (mirrors the other
        # domains) so a rejected patch leaves the row untouched.
        if amount_minor is not None and amount_minor <= 0:
            raise NonPositiveAmountError()
        if logo is not UNSET:
            _validate_logo(logo)  # type: ignore[arg-type]
        if contact_id is not UNSET and contact_id is not None:
            await self._validate_contact(sub.workspace_id, contact_id)  # type: ignore[arg-type]
        if account_id is not UNSET and account_id is not None:
            await self._validate_account(sub.workspace_id, account_id)  # type: ignore[arg-type]
        if category_id is not UNSET and category_id is not None:
            await self._validate_category(sub.workspace_id, category_id)  # type: ignore[arg-type]
        before = project("subscription", sub)
        if name is not None:
            sub.name = name
        if amount_minor is not None:
            sub.amount_minor = amount_minor
        if currency is not None:
            sub.currency = currency
        if billing_frequency is not None:
            sub.billing_frequency = billing_frequency
        if next_renewal is not None:
            sub.next_renewal = next_renewal
        if status is not None:
            sub.status = status
        if logo is not UNSET:
            sub.logo = logo  # type: ignore[assignment]
        if started_on is not UNSET:
            sub.started_on = started_on  # type: ignore[assignment]
        if contact_id is not UNSET:
            sub.contact_id = contact_id  # type: ignore[assignment]
        if account_id is not UNSET:
            sub.account_id = account_id  # type: ignore[assignment]
        if category_id is not UNSET:
            sub.category_id = category_id  # type: ignore[assignment]
        sub.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SUBSCRIPTION_UPDATED,
                resource_type="subscription",
                resource_id=str(sub.id),
                workspace_id=sub.workspace_id,
                before=before,
                after=project("subscription", sub),
            ),
        )
        return sub

    async def set_status(self, sub: Subscription, status: str) -> Subscription:
        """Toggle a subscription active|canceled without touching its content. A
        canceled subscription is kept for history but drops out of the
        active-status `totals` roll-up."""
        if status not in _VALID_STATUSES:
            raise ValueError(f"unknown status: {status!r}")
        before = project("subscription", sub)
        sub.status = status
        sub.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SUBSCRIPTION_UPDATED,
                resource_type="subscription",
                resource_id=str(sub.id),
                workspace_id=sub.workspace_id,
                before=before,
                after=project("subscription", sub),
            ),
        )
        return sub

    async def renew(self, sub: Subscription) -> Subscription:
        """Advance `next_renewal` by one billing cycle and NOTHING else. A
        subscription is a tracker, not an auto-poster: no Transaction is created
        here — Planned remains the thing that posts recurring transactions. The
        advance is clock-free via `period.advance` (CONVENTIONS §4)."""
        before = project("subscription", sub)
        sub.next_renewal = period.advance(sub.next_renewal, sub.billing_frequency)
        sub.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SUBSCRIPTION_RENEWED,
                resource_type="subscription",
                resource_id=str(sub.id),
                workspace_id=sub.workspace_id,
                before=before,
                after=project("subscription", sub),
            ),
        )
        return sub

    async def delete(self, sub: Subscription) -> None:
        """Hard delete — a subscription carries no child ledger of its own."""
        before = project("subscription", sub)
        await self.db.delete(sub)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SUBSCRIPTION_DELETED,
                resource_type="subscription",
                resource_id=str(sub.id),
                workspace_id=sub.workspace_id,
                before=before,
            ),
        )

    # ---- Cost roll-up (per currency, never cross-currency, §4) ------------ #

    async def totals(
        self, workspace_id: uuid.UUID, *, status: str = SubscriptionStatus.ACTIVE.value
    ) -> dict[str, dict[str, int]]:
        """Σ of the normalized monthly + annual cost of every subscription with
        `status`, bucketed per currency: `{currency: {monthly_minor,
        annual_minor, count}}`. Money is never summed across currencies — a EUR
        subscription stays in its own EUR bucket."""
        stmt = scoped_select(Subscription, workspace_id).where(
            Subscription.status == status
        )
        rows = (await self.db.execute(stmt)).scalars().all()
        out: dict[str, dict[str, int]] = {}
        for sub in rows:
            bucket = out.setdefault(
                sub.currency, {"monthly_minor": 0, "annual_minor": 0, "count": 0}
            )
            bucket["monthly_minor"] += monthly_minor(sub.amount_minor, sub.billing_frequency)
            bucket["annual_minor"] += annual_minor(sub.amount_minor, sub.billing_frequency)
            bucket["count"] += 1
        return out
