import builtins
import uuid
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.asset import Asset, AssetValuation
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select

# Sentinel distinguishing "field not present in the PATCH body" from "field
# explicitly set to null" for the nullable acquired_on/source columns.
UNSET = object()


class ValuationAsOfRequiredError(Exception):
    """Raised by `create` when `value_minor` is given without `as_of` — an
    initial valuation needs a date, and the service stays clock-free
    (CONVENTIONS: no reading the clock in services), so it can't default to
    "today" itself."""


class AssetService:
    """Asset + asset valuation business logic. Contract: methods flush, never
    commit — the caller (router) owns the transaction boundary (CONVENTIONS §2)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        name: str,
        type: str,
        currency: str,
        acquired_on: date | None = None,
        value_minor: int | None = None,
        as_of: date | None = None,
    ) -> Asset:
        if value_minor is not None and as_of is None:
            raise ValuationAsOfRequiredError()
        asset = Asset(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            type=type,
            currency=currency,
            acquired_on=acquired_on,
        )
        self.db.add(asset)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.ASSET_CREATED,
                resource_type="asset",
                resource_id=str(asset.id),
                workspace_id=workspace_id,
                after=project("asset", asset),
                activity_template=Activity.ASSET_CREATED,
                activity_params={"name": asset.name, "type": asset.type},
            ),
        )
        if value_minor is not None:
            # as_of is guaranteed non-None by the check above.
            await self.add_valuation(asset, value_minor=value_minor, as_of=as_of)  # type: ignore[arg-type]
        return asset

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[Asset], str | None]:
        # UUID primary keys carry no order — paginate newest-first on
        # created_at, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = scoped_select(Asset, workspace_id).order_by(Asset.created_at.desc(), Asset.id.desc())
        return await keyset_page(
            self.db,
            stmt,
            Asset.created_at,
            Asset.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(self, workspace_id: uuid.UUID, asset_id: uuid.UUID) -> Asset | None:
        return await get_scoped(self.db, Asset, asset_id, workspace_id)

    async def update(
        self,
        asset: Asset,
        *,
        name: str | None = None,
        type: str | None = None,
        currency: str | None = None,
        acquired_on: object = UNSET,
    ) -> Asset:
        before = project("asset", asset)
        if name is not None:
            asset.name = name
        if type is not None:
            asset.type = type
        if currency is not None:
            asset.currency = currency
        if acquired_on is not UNSET:
            asset.acquired_on = acquired_on
        asset.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.ASSET_UPDATED,
                resource_type="asset",
                resource_id=str(asset.id),
                workspace_id=asset.workspace_id,
                before=before,
                after=project("asset", asset),
            ),
        )
        return asset

    async def delete(self, asset: Asset) -> None:
        """Hard delete: asset_valuations cascade at the DB level via their FK
        ondelete=CASCADE."""
        before = project("asset", asset)
        await self.db.delete(asset)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.ASSET_DELETED,
                resource_type="asset",
                resource_id=str(asset.id),
                workspace_id=asset.workspace_id,
                before=before,
            ),
        )

    async def current_value(self, asset: Asset) -> int | None:
        """Latest valuation by `as_of`, with `created_at`/`id` as deterministic
        tiebreakers for same-day valuations (CONVENTIONS §6)."""
        return await self.db.scalar(
            select(AssetValuation.value_minor)
            .where(AssetValuation.asset_id == asset.id)
            .order_by(
                AssetValuation.as_of.desc(),
                AssetValuation.created_at.desc(),
                AssetValuation.id.desc(),
            )
            .limit(1)
        )

    async def add_valuation(
        self,
        asset: Asset,
        *,
        value_minor: int,
        as_of: date,
        source: str | None = None,
    ) -> AssetValuation:
        previous = await self.current_value(asset)
        valuation = AssetValuation(
            id=uuid.uuid4(),
            workspace_id=asset.workspace_id,
            asset_id=asset.id,
            value_minor=value_minor,
            as_of=as_of,
            source=source,
        )
        self.db.add(valuation)
        await self.db.flush()
        # The new row isn't necessarily the new current value (it may be a
        # backfilled valuation with an earlier as_of) — recompute after
        # inserting, and only announce a change when the current value
        # actually moved.
        new_current = await self.current_value(asset)
        changed = previous is not None and new_current != previous
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.ASSET_VALUATION_CREATED,
                resource_type="asset_valuation",
                resource_id=str(valuation.id),
                workspace_id=asset.workspace_id,
                after=project("asset_valuation", valuation),
                activity_template=Activity.ASSET_VALUATION_CHANGED if changed else None,
                activity_params={
                    "asset": asset.name,
                    "from": previous,
                    "to": new_current,
                    "currency": asset.currency,
                }
                if changed
                else None,
            ),
        )
        return valuation

    async def list_valuations(
        self,
        workspace_id: uuid.UUID,
        asset_id: uuid.UUID,
        *,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[builtins.list[AssetValuation], str | None]:
        # UUID primary keys carry no order — paginate newest-first on as_of,
        # with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = (
            scoped_select(AssetValuation, workspace_id)
            .where(AssetValuation.asset_id == asset_id)
            .order_by(AssetValuation.as_of.desc(), AssetValuation.id.desc())
        )
        return await keyset_page(
            self.db,
            stmt,
            AssetValuation.as_of,
            AssetValuation.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get_valuation(
        self, workspace_id: uuid.UUID, valuation_id: uuid.UUID
    ) -> AssetValuation | None:
        return await get_scoped(self.db, AssetValuation, valuation_id, workspace_id)

    async def update_valuation(
        self,
        valuation: AssetValuation,
        *,
        value_minor: int | None = None,
        as_of: date | None = None,
        source: object = UNSET,
    ) -> AssetValuation:
        before = project("asset_valuation", valuation)
        if value_minor is not None:
            valuation.value_minor = value_minor
        if as_of is not None:
            valuation.as_of = as_of
        if source is not UNSET:
            valuation.source = source
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.ASSET_VALUATION_UPDATED,
                resource_type="asset_valuation",
                resource_id=str(valuation.id),
                workspace_id=valuation.workspace_id,
                before=before,
                after=project("asset_valuation", valuation),
            ),
        )
        return valuation
