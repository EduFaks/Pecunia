# Track J (v1.2) — Loan ↔ Transaction Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Link a loan payment to the real account transaction that funded it, **both directions**: (a) **attach** an existing transaction when recording/editing a loan payment; (b) **apply to loan** from a transaction — pick a loan and it creates the linked payment. Mirrors the project-part↔transaction attach idiom.

**Architecture:** `LoanPayment` gains an optional `transaction_id` FK→transactions (SET NULL) with a unique-where-not-null (a transaction funds at most one loan payment). ONE backend path (loan-payment create/update accepts `transaction_id`; the derived amount/date come from the transaction when applying); two UI entry points (loan payment form picks a transaction; a transaction row "Apply to loan" picks a loan → same endpoint). Migration `0016`.

**Net-worth is a wash (correct):** a loan payment lowers the loan's remaining (debt ↓ → net worth ↑) while its linked transaction lowered the account (cash ↓ → net worth ↓) — together net worth is flat, exactly right for a debt payment. Linking doesn't double-count: the payment affects the LOAN ledger, the transaction affects the ACCOUNT ledger; they're different ledgers.

## Global Constraints
- Follow `docs/CONVENTIONS.md` (layering; services flush/routers commit; §4 money integer minor units; §6 state-conflict codes; §7 allowlists; §8 parity). Conventional commits, **no trailers**. Baseline at branch start: backend 625 pytest, web 771 vitest.
- **Invariant:** `LoanPayment.transaction_id` (when set) references a transaction in the SAME workspace; a transaction is linked to at most one loan payment (unique). Deleting the transaction SET-NULLs the payment's `transaction_id` (the payment survives; the loan's remaining is unchanged). Linking does NOT mutate the transaction.

---

### Task 1: Backend — `LoanPayment.transaction_id` (migration 0016) + link in the service/endpoint

**Files:** `api/src/pecunia/models/loan.py` (add `transaction_id` to `LoanPayment`); `api/src/pecunia/services/loans.py` (accept/validate `transaction_id` on `record_payment` + a new `update_payment`); `api/src/pecunia/api/loans.py` (payment in/out); `api/src/pecunia/audit/allowlists.py` (`loan_payment` + `transaction_id`); create `api/alembic/versions/0016_loan_payment_transaction.py`; tests `api/tests/test_migration_0016.py` + extend `test_loans.py`.

**Interfaces:**
- `LoanPayment.transaction_id`: `uuid | None` FK→transactions `ondelete=SET NULL`, indexed; `UniqueConstraint("transaction_id", name="uq_loan_payments_transaction_id")` (Postgres allows many NULLs; blocks one tx funding two payments) — mirror `project_items.transaction_id`.
- `record_payment(loan, *, amount_minor, paid_on, note=None, transaction_id=None)`: if `transaction_id` given, validate the transaction belongs to the workspace (404 `TRANSACTION_NOT_FOUND`) and isn't already linked to another loan payment (409 `TRANSACTION_ALREADY_LINKED`); set it. Add `update_payment(payment, *, ... transaction_id=UNSET)` to attach/detach on an existing payment (UNSET vs None = leave vs clear). Emit the existing `loan_payment.recorded`/a `loan_payment.updated` event.
- `LoanPaymentOut` returns `transaction_id`. The payments endpoints: `POST /loans/{id}/payments` already exists → accept optional `transaction_id`; add `PATCH /loans/{id}/payments/{pid}` (attach/detach + edit). The "apply to loan from a transaction" flow uses `POST /loans/{id}/payments` with `transaction_id` + `amount_minor`(=tx magnitude) + `paid_on`(=tx date) supplied by the caller (frontend) — no separate endpoint needed, but you MAY add a convenience `POST /transactions/{id}/apply-to-loan {loan_id}` that computes amount/date server-side from the tx and calls the same logic (cleaner UX + guarantees amount/date match the tx). Implement that convenience endpoint.

- [ ] **Step 1: Failing tests** — `test_migration_0016.py`: `loan_payments.transaction_id` FK→transactions SET NULL + unique; deleting a linked transaction SET-NULLs the payment (payment survives, loan remaining unchanged); a second payment can't take the same transaction (unique) but many NULLs allowed; `test_schema_parity` clean. `test_loans.py`: record a payment with a `transaction_id` (linked + returned); foreign tx → 404; a tx already linked → 409; `update_payment` attaches then detaches; `POST /transactions/{id}/apply-to-loan` creates a payment with amount=|tx.amount_minor|, paid_on=tx.occurred_on, transaction_id=tx.id, reducing the loan's remaining (and a foreign/already-linked tx → 404/409); deleting the tx leaves the payment with null transaction_id and unchanged remaining.
- [ ] **Step 2–4:** implement; parity + full suite green. **Step 5:** commit `feat: link loan payments to transactions both ways (migration 0016)`.

---

### Task 2: Frontend — attach on the payment form + "Apply to loan" from a transaction

**Files:** `web/src/features/loans/LoanDetail.tsx` + `PaymentForm.tsx` + `useLoans.ts` (attach a transaction to a payment; show the linked tx); `web/src/features/transactions/TransactionsScreen.tsx` (or the transaction row/detail) + `useTransactions.ts` (an "Apply to loan" action); reuse `web/src/features/transactions/TransactionPicker.tsx` (pick a tx) and a loan picker (build a small one or reuse the pattern); `web/src/lib/queries.ts` (invalidations); tests.

**Interfaces:**
- `PaymentForm` (loan side): an optional **"Link a transaction"** field using `TransactionPicker` (select-existing); when linked, the payment row in `LoanDetail` shows the linked transaction (description/amount/date) with an unlink affordance. Recording with a linked tx sends `transaction_id`.
- Transaction side: an **"Apply to loan"** row/detail action opening a small **loan picker** (list active loans); on confirm it calls `POST /transactions/{id}/apply-to-loan {loan_id}` (or the payments endpoint with the derived amount/date) → creates the linked payment. A transaction already linked shows a subtle "→ {loan}" affordance instead.
- Mutations invalidate `qk.loans` (+ the loan's payments) AND `qk.transactions()` (so the tx reflects its link) — and `["analytics"]` is not needed (net worth is a wash; but the loan's remaining/tile changes via `qk.loans`).

- [ ] **Step 1: Failing tests (vitest):** `PaymentForm` links a picked transaction (sends `transaction_id`); `LoanDetail` shows a payment's linked transaction + can unlink; the transaction "Apply to loan" action opens the loan picker and calls apply-to-loan with the chosen loan; a linked transaction shows its loan affordance; invalidations refresh loans + transactions.
- [ ] **Step 2–4:** `npm run build && lint && test` green (0 warnings). **Step 5:** commit `feat(web): link loan payments to transactions — attach + apply-to-loan`.

---

## Self-review notes
- **Coverage:** the FK + unique + validation + both service paths + the convenience apply endpoint (T1); both UI directions with the reused `TransactionPicker` + a loan picker (T2). SET NULL keeps a payment when its tx is deleted; unique prevents double-applying a tx.
- **Consistency:** mirrors `project_items.transaction_id` (attach + unique + SET NULL); state-conflict → 409, foreign → 404; money integer minor units; net worth stays a wash (no double count — separate loan vs account ledgers).
- **Deferred:** auto-suggesting a matching transaction by amount/date; bulk apply.
