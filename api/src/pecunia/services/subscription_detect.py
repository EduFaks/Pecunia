"""Recurring-charge detection (Track W). A clock-free, suggest-and-confirm
detector: it NEVER writes — it reads a workspace's imported expenses and
proposes `SubscriptionCandidate`s the user confirms through the normal
subscription create form. The core (`detect_candidates`) is a pure function
over lightweight `DetectTxn` rows so the grouping/cadence rules are unit-
testable without a database; `SubscriptionDetector` is the thin DB wrapper.

Money is integer minor units; a charge is a NEGATIVE `amount_minor`, and a
candidate reports the POSITIVE magnitude (the subscription cost). Recurrence
keys on the provider `merchant` (Track W's captured column), or on a normalized
`description` when the provider gives no merchant (Pluggy free tier).
"""

import re
import statistics
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date
from itertools import pairwise

from pecunia import period

# Leading payment-aggregator prefix, e.g. "IFD*", "PAG*", "MP*", "PP *", "DL*".
_PREFIX_RE = re.compile(r"^[a-z0-9]{2,6}\*\s*")
# PIX / transfer verb phrases that precede the real counterparty — longest first.
_VERB_PREFIXES = (
    "pix enviado para ", "pix enviado - ", "pix enviado ",
    "pix recebido de ", "pix recebido - ", "pix recebido ",
    "transferencia para ", "transferência para ",
    "pagamento para ", "ted para ", "doc para ",
    "compra no debito ", "compra no credito ", "compra ",
    "pagto ", "debito automatico ", "debito ",
)
# Dates (d/yyyy, dd/mm, dd/mm/yyyy, yyyy-mm-dd), parcela markers (nn/nn), long digit runs
# (ids/cnpj/cpf), and card tails (****1234).
_NOISE_RE = re.compile(
    r"\b\d{1,2}/\d{2,4}(?:/\d{2,4})?\b" # dates + parcela nn/nn (including mm/yyyy format)
    r"|\b\d{4}-\d{2}-\d{2}\b"            # iso date
    r"|\*+\d{2,}"                        # card tail ****1234
    r"|\b\d{5,}\b"                       # long id/cnpj/cpf run
)


def normalize_description(description: str) -> str:
    """Stable grouping key derived from a transaction's free-text description —
    the fallback when the provider gives no structured merchant (Pluggy free
    tier). Lowercases, strips a payment-aggregator prefix ("IFD*…"), strips a
    leading PIX/transfer verb phrase to keep just the counterparty, removes
    dates / parcela markers / long id runs / card tails, drops punctuation, and
    collapses whitespace. Returns the raw lowercased description if that would
    otherwise be empty, so a candidate always has a key."""
    s = description.strip().lower()
    s = _PREFIX_RE.sub("", s)
    for verb in _VERB_PREFIXES:
        if s.startswith(verb):
            s = s[len(verb):]
            break
    s = _NOISE_RE.sub(" ", s)
    s = re.sub(r"[^a-z0-9à-ÿ ]+", " ", s)   # keep letters (incl. accents), digits, spaces
    s = re.sub(r"\s+", " ", s).strip()
    return s or description.strip().lower()


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
    merchant: str | None
    description: str
    currency: str
    amount_minor: int  # signed; a charge is negative
    occurred_on: date
    category_id: uuid.UUID | None
    account_id: uuid.UUID  # every imported transaction has one — NOT NULL


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
    suggested_account_id: uuid.UUID | None


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
    gaps = [(b - a).days for a, b in pairwise(ordered)]
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
    # Group by (key, label, currency) where key is the merchant or normalized
    # description, and label is the display name (merchant or title-cased normalized).
    groups: dict[tuple[str, str, str], list[DetectTxn]] = defaultdict(list)
    for t in txns:
        if t.amount_minor >= 0:
            continue  # only expenses
        # Determine grouping key and label
        if t.merchant:
            key = t.merchant
            label = t.merchant
        else:
            norm = normalize_description(t.description)
            key = norm
            label = norm.title()
        groups[(key, label, t.currency)].append(t)

    candidates: list[SubscriptionCandidate] = []
    for (key, label, currency), rows in groups.items():
        representative = _representative_amount([abs(r.amount_minor) for r in rows])
        tol = round(representative * _AMOUNT_TOLERANCE)
        kept = [r for r in rows if abs(abs(r.amount_minor) - representative) <= tol]
        if len(kept) < 2:
            continue
        freq = _infer_frequency([r.occurred_on for r in kept])
        if freq is None:
            continue
        if _matches_existing(key, representative, currency, freq, existing):
            continue
        kept_sorted = sorted(kept, key=lambda r: r.occurred_on)
        first_seen = kept_sorted[0].occurred_on
        last_seen = kept_sorted[-1].occurred_on
        cat_counts = Counter(r.category_id for r in kept if r.category_id is not None)
        suggested_category_id = cat_counts.most_common(1)[0][0] if cat_counts else None
        # account_id is NOT NULL on every imported transaction, so with ≥2 kept
        # rows there's always a modal account — same Counter idiom as above.
        acct_counts = Counter(r.account_id for r in kept)
        suggested_account_id = acct_counts.most_common(1)[0][0]
        candidates.append(
            SubscriptionCandidate(
                merchant=label,
                suggested_name=label,
                amount_minor=representative,
                currency=currency,
                billing_frequency=freq,
                occurrences=len(kept),
                first_seen=first_seen,
                last_seen=last_seen,
                suggested_next_renewal=period.advance(last_seen, freq),
                suggested_category_id=suggested_category_id,
                suggested_account_id=suggested_account_id,
            )
        )
    candidates.sort(key=lambda c: c.amount_minor, reverse=True)
    return candidates


from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.models.subscription import Subscription, SubscriptionStatus
from pecunia.models.transaction import Transaction
from pecunia.services.scoping import scoped_select


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
        )
        rows = (await self.db.execute(stmt)).scalars().all()
        txns = [
            DetectTxn(
                merchant=r.merchant,
                description=r.description,
                currency=r.currency,
                amount_minor=r.amount_minor,
                occurred_on=r.occurred_on,
                category_id=r.category_id,
                account_id=r.account_id,
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
