import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Pill from "../../components/ui/Pill";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import type { ReactNode } from "react";
import { DateText, MoneyText } from "../../lib/preferences";
import ContactBadge from "../contacts/ContactBadge";
import { useContacts } from "../contacts/useContacts";
import { useTransactionList } from "../transactions/useTransactions";
import { bpsToPct } from "./interest";
import LoanForm from "./LoanForm";
import LoanPayoffBar from "./LoanPayoffBar";
import PaymentForm from "./PaymentForm";
import {
  useDeleteLoan,
  useDeletePayment,
  useLoan,
  useLoanPayments,
  useUpdateLoanPayment,
} from "./useLoans";
import type { LoanDirection, LoanPaymentOut, PaymentFrequency } from "./useLoans";

const DIRECTION_LABELS: Record<LoanDirection, string> = {
  borrowed: "Borrowed",
  lent: "Lent",
};

const FREQUENCY_LABELS: Record<PaymentFrequency, string> = {
  weekly: "weekly",
  monthly: "monthly",
  quarterly: "quarterly",
  yearly: "yearly",
};

/** A single "term" line in the loan's summary grid — rendered only when its
 * value is present. */
function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">{label}</dt>
      <dd className="mt-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

/**
 * `/loans/:id` — one loan's detail: header (name, Borrowed/Lent `Pill`,
 * currency, hero remaining balance, payoff bar), a terms grid (planned
 * payment + frequency, next due, interest rate, opened on, the linked
 * counterparty contact as a `ContactBadge`), the payments
 * ledger table (amount, date, note) with a **Record payment** action
 * (`PaymentForm`) and a per-payment delete, plus inline edit/delete for the
 * loan itself. Deletes (payment or loan) route through `ConfirmDialog`.
 */
function LoanDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [isEditingLoan, setIsEditingLoan] = useState(false);
  const [confirmingLoanDelete, setConfirmingLoanDelete] = useState(false);
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);
  const [deletingPayment, setDeletingPayment] = useState<LoanPaymentOut | null>(null);

  const loanQuery = useLoan(id);
  const paymentsQuery = useLoanPayments(id);
  const deleteLoan = useDeleteLoan();
  const deletePayment = useDeletePayment(id ?? "");
  const updatePayment = useUpdateLoanPayment(id ?? "");

  // Resolve the loan's linked contact (the counterparty) to a real contact so
  // the terms grid can show its `ContactBadge`. Archived included, so a
  // contact archived after being linked still resolves — the same rationale as
  // `ContactPicker`'s own read.
  const contactsQuery = useContacts(true);
  const linkedContact =
    (contactsQuery.data?.items ?? []).find((contact) => contact.id === loanQuery.data?.contact_id) ??
    null;

  // Resolve a payment's linked transaction (its `transaction_id`) to a real
  // transaction so the ledger can show its description/amount/date — the
  // read-side mirror of `PaymentForm`'s attach picker, the same self-contained
  // lookup `TransactionsScreen` uses for a row's project/contact. A bounded
  // recent page; a linked transaction older than it falls back to a plain
  // "Linked transaction" label but stays unlinkable.
  const transactionsQuery = useTransactionList();
  const transactionsById = new Map(
    (transactionsQuery.data?.items ?? []).map((transaction) => [transaction.id, transaction]),
  );

  async function handleUnlink(payment: LoanPaymentOut) {
    try {
      await updatePayment.mutateAsync({ paymentId: payment.id, payload: { transaction_id: null } });
      showToast("Transaction unlinked.", { variant: "positive" });
    } catch {
      showToast("Couldn't unlink the transaction. Please try again.", { variant: "negative" });
    }
  }

  async function handleDeleteLoan() {
    if (!id) {
      return;
    }
    try {
      await deleteLoan.mutateAsync(id);
      showToast("Loan deleted.");
      navigate("/loans");
    } catch {
      showToast("Couldn't delete this loan. Please try again.", { variant: "negative" });
    } finally {
      setConfirmingLoanDelete(false);
    }
  }

  async function handleDeletePayment() {
    if (!deletingPayment) {
      return;
    }
    try {
      await deletePayment.mutateAsync(deletingPayment.id);
      showToast("Payment deleted.");
    } catch {
      showToast("Couldn't delete this payment. Please try again.", { variant: "negative" });
    } finally {
      setDeletingPayment(null);
    }
  }

  if (loanQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading loan" />
      </div>
    );
  }

  if (loanQuery.isError || !loanQuery.data) {
    return <Callout variant="negative">Couldn't load this loan.</Callout>;
  }

  const loan = loanQuery.data;
  const payments = paymentsQuery.data?.items ?? [];
  const interestPct = bpsToPct(loan.interest_rate_bps);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
            {loan.currency} · Loan
            <Pill>{DIRECTION_LABELS[loan.direction]}</Pill>
          </p>
          <h1 className="mt-1 font-display text-2xl text-ink">{loan.name}</h1>
          <MoneyText
            minor={loan.remaining_minor}
            currency={loan.currency}
            variant="hero"
            className="mt-2 block text-3xl"
          />
          <p className="mt-1 text-xs text-ink-faint">remaining</p>
          {loan.description ? (
            <p className="mt-2 max-w-prose text-sm text-ink-2">{loan.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setIsEditingLoan((editing) => !editing)}>
            {isEditingLoan ? "Cancel" : "Edit"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={deleteLoan.isPending}
            onClick={() => setConfirmingLoanDelete(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      <LoanPayoffBar
        paidTotalMinor={loan.paid_total_minor}
        principalMinor={loan.principal_minor}
        remainingMinor={loan.remaining_minor}
        currency={loan.currency}
      />

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Term label="Principal">
          <MoneyText minor={loan.principal_minor} currency={loan.currency} />
        </Term>
        {loan.planned_payment_minor != null ? (
          <Term label="Planned payment">
            <MoneyText minor={loan.planned_payment_minor} currency={loan.currency} />
            {loan.payment_frequency ? (
              <span className="text-ink-faint"> {FREQUENCY_LABELS[loan.payment_frequency]}</span>
            ) : null}
          </Term>
        ) : null}
        {loan.next_due ? (
          <Term label="Next due">
            <DateText iso={loan.next_due} />
          </Term>
        ) : null}
        {interestPct !== null ? <Term label="Interest rate">{interestPct}%</Term> : null}
        {loan.opened_on ? (
          <Term label="Opened on">
            <DateText iso={loan.opened_on} />
          </Term>
        ) : null}
        {loan.contact_id ? (
          <Term label="Contact">
            {/* Renders nothing until the contacts list resolves the id. */}
            <ContactBadge contact={linkedContact} className="text-sm" />
          </Term>
        ) : null}
      </dl>

      {confirmingLoanDelete ? (
        <ConfirmDialog
          title={`Delete "${loan.name}"?`}
          description="This permanently deletes the loan and its entire payment history. This can't be undone."
          confirmLabel="Delete loan"
          onConfirm={() => void handleDeleteLoan()}
          onCancel={() => setConfirmingLoanDelete(false)}
          isConfirming={deleteLoan.isPending}
        />
      ) : null}

      {deletingPayment ? (
        <ConfirmDialog
          title="Delete this payment?"
          description="This permanently removes the payment from the ledger and restores the remaining balance. This can't be undone."
          confirmLabel="Delete payment"
          onConfirm={() => void handleDeletePayment()}
          onCancel={() => setDeletingPayment(null)}
          isConfirming={deletePayment.isPending}
        />
      ) : null}

      {isEditingLoan ? (
        <Card>
          <h2 className="font-display text-lg text-ink">Edit loan</h2>
          <div className="mt-4">
            <LoanForm
              loan={loan}
              onCancel={() => setIsEditingLoan(false)}
              onSuccess={() => {
                setIsEditingLoan(false);
                showToast("Loan updated.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      {isRecordingPayment ? (
        <Card>
          <h2 className="font-display text-lg text-ink">Record payment</h2>
          <div className="mt-4">
            <PaymentForm
              loanId={loan.id}
              currency={loan.currency}
              onCancel={() => setIsRecordingPayment(false)}
              onSuccess={() => {
                setIsRecordingPayment(false);
                showToast("Payment recorded.", { variant: "positive" });
              }}
            />
          </div>
        </Card>
      ) : null}

      <div>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg text-ink">Payments</h2>
          <Button size="sm" onClick={() => setIsRecordingPayment(true)}>
            Record payment
          </Button>
        </div>

        {paymentsQuery.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner label="Loading payments" />
          </div>
        ) : paymentsQuery.isError ? (
          <Callout variant="negative" className="mt-4">
            Couldn't load this loan's payments. Try again.
          </Callout>
        ) : payments.length === 0 ? (
          <EmptyState
            className="mt-4"
            title="No payments yet"
            body="Record this loan's first payment to start tracking its payoff progress."
            action={<Button onClick={() => setIsRecordingPayment(true)}>Record a payment</Button>}
          />
        ) : (
          <div className="mt-4 overflow-x-auto rounded-pc-lg border border-hairline bg-surface-1">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-ink-faint">
                  <th scope="col" className="px-4 py-3 font-mono text-xs uppercase tracking-[0.1em]">
                    Date
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right font-mono text-xs uppercase tracking-[0.1em]"
                  >
                    Amount
                  </th>
                  <th scope="col" className="px-4 py-3 font-mono text-xs uppercase tracking-[0.1em]">
                    Note
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {payments.map((payment) => {
                  const linkedTransaction = payment.transaction_id
                    ? transactionsById.get(payment.transaction_id)
                    : undefined;
                  return (
                    <tr key={payment.id}>
                      <td className="px-4 py-3 text-ink-2">
                        <DateText iso={payment.paid_on} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <MoneyText minor={payment.amount_minor} currency={loan.currency} />
                      </td>
                      <td className="px-4 py-3 text-ink-2">
                        {payment.note ? payment.note : <span className="text-ink-faint">—</span>}
                        {payment.transaction_id ? (
                          <span className="mt-1 flex items-center gap-1.5 font-mono text-xs text-ink-faint">
                            <span aria-hidden>↳</span>
                            {linkedTransaction ? (
                              <>
                                <span className="truncate text-ink-2">
                                  {linkedTransaction.description}
                                </span>
                                <MoneyText
                                  minor={linkedTransaction.amount_minor}
                                  currency={linkedTransaction.currency}
                                  colorBySign
                                />
                              </>
                            ) : (
                              <span className="text-ink-2">Linked transaction</span>
                            )}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {payment.transaction_id ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={updatePayment.isPending}
                              onClick={() => void handleUnlink(payment)}
                            >
                              Unlink
                            </Button>
                          ) : null}
                          <Button variant="ghost" size="sm" onClick={() => setDeletingPayment(payment)}>
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default LoanDetail;
