/**
 * Pure helpers shared between the forecast tab's Task-4 pieces (the
 * `ForecastScreen` lowest-point/recovery tiles and `MonthBreakdown`) — kept
 * here, framework-free, so "which point/label goes with this date" and
 * "what rows make up this month" are unit-testable without rendering
 * anything, the same "exported pure function next to the component that
 * uses it" move `safeToSpendBar.ts`/`balances.ts` already make in this app.
 */

import type { CardBillLabel, ProjectionComponents, ProjectionPoint } from "./useForecast";

/** The projected month-end point matching an ISO date, or `undefined` when
 * that date isn't one of `points`' own axis values. Both `lowest_point` and
 * `recovery` can land on TODAY's seeded actual balance rather than any
 * plotted point (`ProjectionChart`'s own docstring makes the same point for
 * its reference dots), so every caller has to handle "no match" rather than
 * assume one. */
export function findPointByDate(points: ProjectionPoint[], date: string): ProjectionPoint | undefined {
  return points.find((point) => point.date === date);
}

/** The largest credit-card bill folded into a month, or `undefined` when
 * that month has none — "biggest" surfaces one short note (the lowest-point
 * tile's "após fatura <label>"), not an exhaustive list of every card. */
export function biggestCardBillLabel(labels: CardBillLabel[]): CardBillLabel | undefined {
  if (labels.length === 0) {
    return undefined;
  }
  return labels.reduce((biggest, label) => (label.amount_minor > biggest.amount_minor ? label : biggest));
}

/** `MonthBreakdown`'s default selected date: the lowest-point month when it
 * is genuinely one of the projected points, else the first projected month
 * — the brief's "default = the lowest-point month, else the first projected
 * month." `undefined` only when there are no points to default to at all
 * (the screen never renders `MonthBreakdown` in that case anyway). */
export function defaultBreakdownDate(points: ProjectionPoint[], lowestPointDate: string): string | undefined {
  if (findPointByDate(points, lowestPointDate)) {
    return lowestPointDate;
  }
  return points[0]?.date;
}

export type BreakdownTone = "positive" | "negative";

/** One rendered line in `MonthBreakdown`'s "o que compõe" list — `minor` is
 * always a non-negative magnitude (every `ProjectionComponents` field is
 * stored that way, `api/src/pecunia/services/projection.py`'s `project`),
 * with the +/− glyph and emerald/coral tone carried separately so a caller
 * renders them explicitly rather than relying on the number's own sign
 * (mirrors `SafeToSpendCard`'s `SIGN_POSITIVE`/`SIGN_NEGATIVE` idiom). */
export interface BreakdownRow {
  key: string;
  label: string;
  minor: number;
  tone: BreakdownTone;
  /** A short muted sub-line under the label — only the variable-spend row
   * carries one ("média de N meses"). */
  caption?: string;
}

/** "N mês"/"N meses" — the same singular/plural idiom `ForecastScreen`'s own
 * `monthWord` already uses for the runway hero, duplicated here rather than
 * imported so this module stays a standalone, dependency-free pure-logic
 * file (the app's established move for small one-line helpers, e.g.
 * `SafeToSpendCard`'s `capitalize`). */
function monthWord(n: number): string {
  return n === 1 ? "mês" : "meses";
}

/**
 * The non-zero rows behind one projected month's `components` — the ordered
 * income / subscriptions / loans / card-bills / variable breakdown
 * `MonthBreakdown` renders. `cardBillLabels` is expanded into one row per
 * card when present (so "fatura Nubank" and "fatura BTG" both show rather
 * than one opaque total — the sum of every label's `amount_minor` always
 * equals `components.card_bills_minor`, since the service only ever appends
 * a label for a bill it actually added, `ProjectionService._fold_card_bills`),
 * falling back to a single aggregate "fatura" row when a card bill landed
 * with no label at all. A component with a zero amount is omitted entirely
 * — a $0 subscriptions month has nothing to say about subscriptions.
 */
export function breakdownRows(
  components: ProjectionComponents,
  cardBillLabels: CardBillLabel[],
  variableLookbackMonths: number,
): BreakdownRow[] {
  const rows: BreakdownRow[] = [];

  if (components.income_minor !== 0) {
    rows.push({ key: "income", label: "renda", minor: components.income_minor, tone: "positive" });
  }
  if (components.subscriptions_minor !== 0) {
    rows.push({
      key: "subscriptions",
      label: "assinaturas e recorrentes",
      minor: components.subscriptions_minor,
      tone: "negative",
    });
  }
  if (components.loans_minor !== 0) {
    rows.push({ key: "loans", label: "empréstimos", minor: components.loans_minor, tone: "negative" });
  }

  if (cardBillLabels.length > 0) {
    cardBillLabels.forEach((bill, index) => {
      if (bill.amount_minor === 0) {
        return;
      }
      rows.push({
        key: `card-bill-${index}`,
        label: `fatura ${bill.label}`,
        minor: bill.amount_minor,
        tone: "negative",
      });
    });
  } else if (components.card_bills_minor !== 0) {
    rows.push({
      key: "card-bills",
      label: "fatura",
      minor: components.card_bills_minor,
      tone: "negative",
    });
  }

  if (components.variable_minor !== 0) {
    rows.push({
      key: "variable",
      label: "variável médio",
      minor: components.variable_minor,
      tone: "negative",
      caption: `média de ${variableLookbackMonths} ${monthWord(variableLookbackMonths)}`,
    });
  }

  return rows;
}
