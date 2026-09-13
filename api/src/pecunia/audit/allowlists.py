from typing import Any

# Per-resource field allowlists for audit before/after payloads. Only these
# fields are ever copied into an audit row — secrets are structurally
# unreachable because they are not listed. test_no_secret_leak enforces this.
ALLOWLISTS: dict[str, frozenset[str]] = {
    "user": frozenset({"id", "email", "name", "display_name"}),
    "workspace": frozenset({"id", "name"}),
    "settings": frozenset(
        {"base_currency", "locale", "date_format", "number_format", "timezone", "first_day_of_week"}
    ),
    "account": frozenset({"id", "name", "type", "currency", "initial_balance_minor", "is_demo"}),
    "transaction": frozenset(
        {
            "id", "account_id", "category_id", "contact_id", "project_id", "transfer_id",
            "amount_minor", "currency", "description", "occurred_on", "is_demo",
        }
    ),
    "transfer": frozenset(
        {
            "id", "from_account_id", "to_account_id", "amount_minor", "currency",
            "description", "occurred_on", "is_demo",
        }
    ),
    "project": frozenset(
        {"id", "name", "status", "type", "currency", "target_amount_minor", "is_demo"}
    ),
    "project_item": frozenset(
        {"id", "project_id", "transaction_id", "name", "amount_minor", "is_demo"}
    ),
    "asset": frozenset({"id", "name", "type", "currency", "is_demo"}),
    "asset_valuation": frozenset({"id", "asset_id", "value_minor", "as_of", "source", "is_demo"}),
    "portfolio": frozenset({"id", "name", "currency", "description", "is_demo"}),
    # quantity is a Decimal — project() str()-serializes it (it is not one of
    # str/int/float/bool), so it lands in the audit payload as e.g. "12.5".
    "holding": frozenset(
        {"id", "portfolio_id", "name", "symbol", "quantity", "coingecko_id", "is_demo"}
    ),
    "holding_price": frozenset(
        {"id", "holding_id", "unit_price_minor", "as_of", "source", "is_demo"}
    ),
    "loan": frozenset(
        {
            "id", "name", "direction", "principal_minor", "currency",
            "interest_rate_bps", "planned_payment_minor", "payment_frequency",
            "next_due", "opened_on", "description", "contact_id", "is_demo",
        }
    ),
    "loan_payment": frozenset(
        {"id", "loan_id", "transaction_id", "amount_minor", "paid_on", "note", "is_demo"}
    ),
    "budget": frozenset(
        {"id", "name", "category_id", "period", "amount_minor", "currency", "is_demo"}
    ),
    "category": frozenset({"id", "name", "kind", "color", "icon", "is_demo"}),
    # avatar is deliberately excluded — bulky base64 image data, non-sensitive
    # but no business in an audit payload (plan / CONVENTIONS §7).
    "contact": frozenset({"id", "name", "default_category_id", "type", "is_demo"}),
    "net_worth_snapshot": frozenset(
        {"id", "captured_on", "currency", "net_worth_minor", "is_demo"}
    ),
    "scheduled_transaction": frozenset(
        {
            "id", "account_id", "category_id", "contact_id", "amount_minor", "currency",
            "description", "frequency", "interval_count", "next_due", "end_date",
            "is_active", "is_demo",
        }
    ),
    # logo is deliberately excluded — bulky base64 image data, non-sensitive but
    # no business in an audit payload (plan / CONVENTIONS §7), same as contact
    # avatar.
    "subscription": frozenset(
        {
            "id", "name", "amount_minor", "currency", "billing_frequency",
            "next_renewal", "started_on", "status", "contact_id", "account_id",
            "category_id", "is_demo",
        }
    ),
}


def project(resource_type: str, obj: Any) -> dict[str, Any]:
    """Copy only the allow-listed fields of obj (an ORM instance or dict) into a
    plain dict suitable for an audit payload."""
    fields = ALLOWLISTS.get(resource_type, frozenset())
    get = obj.get if isinstance(obj, dict) else lambda k: getattr(obj, k, None)
    out: dict[str, Any] = {}
    for f in fields:
        val = get(f)
        if val is not None:
            out[f] = str(val) if not isinstance(val, (str, int, float, bool)) else val
    return out
