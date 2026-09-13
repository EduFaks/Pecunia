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
