import re
from typing import Annotated

from pydantic import AfterValidator, Field

CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def validate_currency(code: str) -> str:
    if not CURRENCY_RE.match(code):
        raise ValueError("currency must be a 3-letter uppercase ISO-4217 code")
    return code


CurrencyStr = Annotated[str, AfterValidator(validate_currency)]

# A money field stored as a BigInteger minor-unit column (cents). Bounds it to
# what Postgres bigint / the DB driver can actually hold — an out-of-range
# amount fails Pydantic validation (422) instead of a raw DB error (500).
# Deliberately unconstrained on sign: a credit-card initial balance, for
# example, can be negative.
MinorInt = Annotated[int, Field(ge=-9_223_372_036_854_775_808, le=9_223_372_036_854_775_807)]

# ISO 4217 currencies whose minor unit has a digit count other than the usual
# 2 — the same set web/src/lib/money.ts derives from `Intl.NumberFormat`'s
# `minimumFractionDigits` on the frontend. Python has no built-in ICU
# currency table, so this is a small hand-maintained mirror rather than a new
# dependency; used by the crypto price provider (Track Q) to convert
# CoinGecko's major-unit float price into integer minor units correctly for
# a currency like JPY (0 decimals) or BHD (3).
_ZERO_DECIMAL_CURRENCIES = frozenset(
    {
        "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "MGA", "PYG",
        "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
    }
)
_THREE_DECIMAL_CURRENCIES = frozenset({"BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"})


def currency_minor_unit_exponent(currency: str) -> int:
    """The number of minor-unit digits for an ISO 4217 currency code: 0 for
    JPY, 3 for BHD, 2 for everything else (the default)."""
    code = currency.upper()
    if code in _ZERO_DECIMAL_CURRENCIES:
        return 0
    if code in _THREE_DECIMAL_CURRENCIES:
        return 3
    return 2
