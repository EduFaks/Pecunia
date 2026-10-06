"""Recurring-charge detection (Track W). A clock-free, suggest-and-confirm
detector: it NEVER writes — it reads a workspace's imported expenses and
proposes `SubscriptionCandidate`s the user confirms through the normal
subscription create form. The core (`detect_candidates`) is a pure function
over lightweight `DetectTxn` rows so the grouping/cadence rules are unit-
testable without a database; `SubscriptionDetector` is the thin DB wrapper.

Money is integer minor units; a charge is a NEGATIVE `amount_minor`, and a
candidate reports the POSITIVE magnitude (the subscription cost). Recurrence
keys on the provider `merchant` (Track W's captured column), never the noisy
free-text description.
"""

import statistics
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date

from pecunia import period

# Amount cluster tolerance: an occurrence counts toward a merchant's recurring
# charge when its magnitude is within ±10% of the group's representative
# amount — absorbs small price bumps / fx drift without merging genuinely
# different charges from the same merchant.
_AMOUNT_TOLERANCE = 0.10

# Cadence buckets keyed on the MEDIAN gap (days) between consecutive charges.
# (low, high, frequency) — inclusive bounds, non-overlapping, generous enough
# to absorb weekend/holiday posting drift.
_CADENCE_BUCKETS = [
    (5, 9, "weekly"),
    (23, 37, "monthly"),
    (76, 106, "quarterly"),
    (335, 395, "yearly"),
]

# Every individual gap must also fall in the SAME bucket as the median — this
# rejects an irregular set (e.g. one 16-day and one 45-day gap) whose median
# would otherwise masquerade as monthly.


@dataclass(frozen=True)
class DetectTxn:
    merchant: str
    currency: str
    amount_minor: int  # signed; a charge is negative
    occurred_on: date
    category_id: uuid.UUID | None


@dataclass(frozen=True)
class ExistingSub:
    name: str
    currency: str
    amount_minor: int  # positive magnitude
    billing_frequency: str


@dataclass(frozen=True)
class SubscriptionCandidate:
    merchant: str
    suggested_name: str
    amount_minor: int  # positive magnitude
    currency: str
    billing_frequency: str
    occurrences: int
    first_seen: date
    last_seen: date
    suggested_next_renewal: date
    suggested_category_id: uuid.UUID | None


def _representative_amount(magnitudes: list[int]) -> int:
    """The group's modal magnitude; ties fall back to the (rounded) median so a
    two-charge group with two different amounts still yields a stable center."""
    counts = Counter(magnitudes)
    top = max(counts.values())
    modal = [amt for amt, n in counts.items() if n == top]
    if len(modal) == 1:
        return modal[0]
    return round(statistics.median(magnitudes))


def _bucket_for(gap_days: int) -> str | None:
    for low, high, freq in _CADENCE_BUCKETS:
        if low <= gap_days <= high:
            return freq
    return None


def _infer_frequency(days: list[date]) -> str | None:
    """Infer a cadence from sorted occurrence dates, or None when the spacing
    isn't a recognizable regular cycle. Requires the median gap to land in a
    bucket AND every individual gap to share that bucket."""
    if len(days) < 2:
        return None
    ordered = sorted(days)
    gaps = [(b - a).days for a, b in zip(ordered, ordered[1:])]
    median_gap = statistics.median(gaps)
    freq = _bucket_for(round(median_gap))
    if freq is None:
        return None
    if all(_bucket_for(g) == freq for g in gaps):
        return freq
    return None


def _matches_existing(cand_merchant: str, cand_amount: int, cand_currency: str,
                      cand_freq: str, existing: list[ExistingSub]) -> bool:
    for sub in existing:
        if sub.currency != cand_currency or sub.billing_frequency != cand_freq:
            continue
        if sub.name.casefold() != cand_merchant.casefold():
            continue
        if abs(sub.amount_minor - cand_amount) <= round(cand_amount * _AMOUNT_TOLERANCE):
            return True
    return False


def detect_candidates(
    txns: list[DetectTxn], *, today: date, existing: list[ExistingSub]
) -> list[SubscriptionCandidate]:
    groups: dict[tuple[str, str], list[DetectTxn]] = defaultdict(list)
    for t in txns:
        if t.amount_minor >= 0 or not t.merchant:
            continue  # only expenses with a merchant
        groups[(t.merchant, t.currency)].append(t)

    candidates: list[SubscriptionCandidate] = []
    for (merchant, currency), rows in groups.items():
        representative = _representative_amount([abs(r.amount_minor) for r in rows])
        tol = round(representative * _AMOUNT_TOLERANCE)
        kept = [r for r in rows if abs(abs(r.amount_minor) - representative) <= tol]
        if len(kept) < 2:
            continue
        freq = _infer_frequency([r.occurred_on for r in kept])
        if freq is None:
            continue
        if _matches_existing(merchant, representative, currency, freq, existing):
            continue
        kept_sorted = sorted(kept, key=lambda r: r.occurred_on)
        first_seen = kept_sorted[0].occurred_on
        last_seen = kept_sorted[-1].occurred_on
        cat_counts = Counter(r.category_id for r in kept if r.category_id is not None)
        suggested_category_id = cat_counts.most_common(1)[0][0] if cat_counts else None
        candidates.append(
            SubscriptionCandidate(
                merchant=merchant,
                suggested_name=merchant,
                amount_minor=representative,
                currency=currency,
                billing_frequency=freq,
                occurrences=len(kept),
                first_seen=first_seen,
                last_seen=last_seen,
                suggested_next_renewal=period.advance(last_seen, freq),
                suggested_category_id=suggested_category_id,
            )
        )
    candidates.sort(key=lambda c: c.amount_minor, reverse=True)
    return candidates


import sqlalchemy as sa  # noqa: E402  (grouped here to keep the pure core import-light)
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from pecunia.models.subscription import Subscription, SubscriptionStatus  # noqa: E402
from pecunia.models.transaction import Transaction  # noqa: E402
from pecunia.services.scoping import scoped_select  # noqa: E402


class SubscriptionDetector:
    """Reads a workspace's imported expenses and proposes recurring-charge
    candidates. Read-only — writes nothing. Clock-free (`today` passed in)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def suggest(
        self, workspace_id: uuid.UUID, *, today: date
    ) -> list[SubscriptionCandidate]:
        stmt = scoped_select(Transaction, workspace_id).where(
            Transaction.external_id.is_not(None),   # imported only
            Transaction.amount_minor < 0,           # expenses
            Transaction.transfer_id.is_(None),      # not a transfer leg
            Transaction.deleted_at.is_(None),       # not tombstoned
            Transaction.merchant.is_not(None),      # has a merchant to key on
        )
        rows = (await self.db.execute(stmt)).scalars().all()
        txns = [
            DetectTxn(
                merchant=r.merchant,
                currency=r.currency,
                amount_minor=r.amount_minor,
                occurred_on=r.occurred_on,
                category_id=r.category_id,
            )
            for r in rows
        ]
        sub_rows = (
            await self.db.execute(
                scoped_select(Subscription, workspace_id).where(
                    Subscription.status == SubscriptionStatus.ACTIVE.value
                )
            )
        ).scalars().all()
        existing = [
            ExistingSub(
                name=s.name, currency=s.currency,
                amount_minor=s.amount_minor, billing_frequency=s.billing_frequency,
            )
            for s in sub_rows
        ]
        return detect_candidates(txns, today=today, existing=existing)
