import type { ReactNode } from "react";

/**
 * Temporary token / typography showcase — the first visual proof of the
 * Pecunia identity (minimal-tech: near-black/grey/white, one white accent,
 * system type). Every color, radius, shadow and easing curve rendered here
 * comes from a Tailwind utility mapped to a `--pc-*` token in
 * `src/styles/global.css`; the only raw hex values below are the swatch
 * captions displaying each token's literal value as documentation text
 * (CONVENTIONS §9.3's named exception), never a color a component computes
 * from.
 *
 * This route is a diagnostic, not a product screen — it will be replaced
 * once real routes exist, but it stays useful as a living reference.
 */

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Minor units (cents), per docs/CONVENTIONS.md §4 — money is never a float. */
function money(cents: number): string {
  return currency.format(cents / 100);
}

type LedgerRow = {
  date: string;
  description: string;
  counterparty: string;
  cents: number;
};

const ledger: LedgerRow[] = [
  { date: "09.02", description: "Consulting retainer", counterparty: "Meridian & Co.", cents: 425_000 },
  { date: "09.04", description: "Office lease", counterparty: "Ashworth Property Group", cents: -180_000 },
  { date: "09.06", description: "Interest, savings sweep", counterparty: "Pecunia Treasury", cents: 1_432 },
  { date: "09.09", description: "Client refund", counterparty: "Halden Partners", cents: -32_000 },
];

const netCents = ledger.reduce((sum, row) => sum + row.cents, 0);

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
      {children}
    </span>
  );
}

function SectionHeading({
  index,
  title,
  description,
}: {
  index: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-8 flex flex-col gap-2 border-t border-hairline pt-6 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8">
      <div className="flex items-baseline gap-4">
        <span className="font-mono text-sm text-ink-faint">{index}</span>
        <h2 className="font-display text-2xl font-medium text-ink">{title}</h2>
      </div>
      {description ? (
        <p className="max-w-sm text-sm text-ink-2 sm:text-right">{description}</p>
      ) : null}
    </div>
  );
}

function Swatch({
  name,
  value,
  swatchClassName,
}: {
  name: string;
  value: string;
  swatchClassName: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div
        className={`h-16 w-full rounded-pc border border-hairline ${swatchClassName}`}
        aria-hidden="true"
      />
      <div className="font-mono text-xs leading-relaxed">
        <div className="text-ink">--pc-{name}</div>
        <div className="text-ink-faint">{value}</div>
      </div>
    </div>
  );
}

function Showcase() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      {/* Masthead */}
      <header className="border-b border-hairline">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5 sm:px-8">
          <span className="font-mono text-sm uppercase tracking-[0.3em] text-ink">
            PECUNIA
          </span>
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
            Identity spec · v1
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-32 sm:px-8">
        {/* Hero */}
        <section className="border-b border-hairline py-20">
          <Eyebrow>Design tokens &amp; typography — for internal review</Eyebrow>
          <h1 className="mt-6 font-display text-6xl font-medium leading-[1.05] text-ink sm:text-8xl">
            A ledger, rendered
            <br />
            in black &amp; white.
          </h1>
          <p className="mt-8 max-w-xl text-base leading-relaxed text-ink-2 sm:text-lg">
            Near-black grounds, cool grey ink, and a single white accent
            reserved for the things you can act on. Value movement is told
            only by muted emerald and coral — never decoration.
          </p>
        </section>

        {/* Grounds & hairlines */}
        <section>
          <SectionHeading
            index="§01"
            title="Grounds & hairlines"
            description="Four near-black depths and two cool, near-invisible dividers."
          />
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Swatch name="canvas" value="#0a0a0b" swatchClassName="bg-canvas" />
            <Swatch name="surface-1" value="#151517" swatchClassName="bg-surface-1" />
            <Swatch name="surface-2" value="#1d1d20" swatchClassName="bg-surface-2" />
            <Swatch name="surface-3" value="#262629" swatchClassName="bg-surface-3" />
          </div>
          <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
              <div className="font-mono text-xs text-ink-faint">--pc-hairline</div>
              <div className="mt-1 font-mono text-xs text-ink-faint">
                rgba(255, 255, 255, 0.09)
              </div>
            </div>
            <div className="rounded-pc-lg border border-hairline-strong bg-surface-1 p-6">
              <div className="font-mono text-xs text-ink-faint">
                --pc-hairline-strong
              </div>
              <div className="mt-1 font-mono text-xs text-ink-faint">
                rgba(255, 255, 255, 0.15)
              </div>
            </div>
          </div>
        </section>

        {/* Ink & accent */}
        <section className="mt-20">
          <SectionHeading
            index="§02"
            title="Ink & accent"
            description="Three ink weights for hierarchy; white is the only interactive color."
          />
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
            <Swatch name="text" value="#f5f5f5" swatchClassName="bg-ink" />
            <Swatch name="text-secondary" value="#a0a0a5" swatchClassName="bg-ink-2" />
            <Swatch name="text-faint" value="#6b6b70" swatchClassName="bg-ink-faint" />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-3">
            <Swatch name="accent" value="#fafafa" swatchClassName="bg-accent" />
            <Swatch
              name="accent-hover"
              value="#e4e4e7"
              swatchClassName="bg-accent-hover"
            />
            <Swatch
              name="accent-soft"
              value="rgba(255, 255, 255, 0.10)"
              swatchClassName="bg-accent-soft"
            />
          </div>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <button
              type="button"
              className="rounded-pc bg-accent px-5 py-2.5 font-sans text-sm font-medium text-on-accent transition-colors duration-150 ease-pc hover:bg-accent-hover"
            >
              Open ledger
            </button>
            <span className="font-mono text-xs text-ink-faint">
              tab to this button — the white focus ring uses --pc-focus; the
              label uses --pc-on-accent for contrast on the white fill
            </span>
          </div>
        </section>

        {/* Signature: the statement */}
        <section className="mt-20">
          <SectionHeading
            index="§03"
            title="Value movement"
            description="Muted emerald for money in, coral for money out — reserved for real deltas."
          />
          <div className="overflow-hidden rounded-pc-lg border border-hairline bg-surface-2 shadow-pc-2">
            <div className="flex items-center justify-between border-b border-hairline px-6 py-4">
              <span className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
                Statement — sample account
              </span>
              <span className="font-mono text-xs text-ink-faint">SEP 2026</span>
            </div>
            <ul>
              {ledger.map((row) => (
                <li key={row.description} className="border-b border-hairline last:border-b-0">
                  <button
                    type="button"
                    className="flex w-full items-center gap-4 px-6 py-4 text-left transition-colors duration-150 ease-pc hover:bg-accent-soft"
                  >
                    <span className="font-mono text-xs text-ink-faint">{row.date}</span>
                    <span className="flex-1">
                      <span className="block text-sm text-ink">{row.description}</span>
                      <span className="block text-xs text-ink-faint">
                        {row.counterparty}
                      </span>
                    </span>
                    <span
                      className={`font-mono text-sm tabular-figures ${
                        row.cents >= 0 ? "text-positive" : "text-negative"
                      }`}
                    >
                      {row.cents >= 0 ? "+" : "−"}
                      {money(Math.abs(row.cents))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between bg-surface-3 px-6 py-4">
              <span className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
                Net
              </span>
              <span
                className={`font-mono text-base font-medium tabular-figures ${
                  netCents >= 0 ? "text-positive" : "text-negative"
                }`}
              >
                {netCents >= 0 ? "+" : "−"}
                {money(Math.abs(netCents))}
              </span>
            </div>
          </div>
        </section>

        {/* Type scale */}
        <section className="mt-20">
          <SectionHeading
            index="§04"
            title="Type scale"
            description="One system sans stack for display and body — hierarchy is weight and size, not a second typeface."
          />
          <div className="flex flex-col gap-6 divide-y divide-hairline">
            <div className="flex flex-col gap-2 pb-6 sm:flex-row sm:items-baseline sm:gap-8">
              <span className="w-32 shrink-0 font-mono text-xs text-ink-faint">
                Display XL / 96
              </span>
              <span className="font-display text-8xl font-semibold leading-none text-ink">
                Reserve
              </span>
            </div>
            <div className="flex flex-col gap-2 py-6 sm:flex-row sm:items-baseline sm:gap-8">
              <span className="w-32 shrink-0 font-mono text-xs text-ink-faint">
                Display L / 60
              </span>
              <span className="font-display text-6xl font-medium leading-none text-ink">
                Statement
              </span>
            </div>
            <div className="flex flex-col gap-2 py-6 sm:flex-row sm:items-baseline sm:gap-8">
              <span className="w-32 shrink-0 font-mono text-xs text-ink-faint">
                Display M / 36
              </span>
              <span className="font-display text-4xl font-medium leading-none text-ink">
                Net position
              </span>
            </div>
            <div className="flex flex-col gap-2 pt-6 sm:flex-row sm:items-baseline sm:gap-8">
              <span className="w-32 shrink-0 font-mono text-xs text-ink-faint">
                Display S / 24
              </span>
              <span className="font-display text-2xl font-semibold leading-none text-ink">
                Workspace
              </span>
            </div>
          </div>
        </section>

        {/* Body & data */}
        <section className="mt-20">
          <SectionHeading
            index="§05"
            title="Body & data"
            description="System sans for prose; the system monospace for anything meant to be scanned or audited."
          />
          <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
            <p className="max-w-md text-base leading-relaxed text-ink-2">
              Pecunia keeps a private ledger for people who already know what
              their money is doing — the interface gets out of the way and
              lets the numbers carry the weight. Every figure that can move is
              set in tabular digits, so a column of statements always lines
              up, whether it is read on a wide desk or a narrow phone.
            </p>
            <div className="rounded-pc border border-hairline bg-surface-1 p-5">
              <table className="w-full font-mono text-xs tabular-figures text-ink-2">
                <tbody>
                  <tr className="border-b border-hairline">
                    <td className="py-2 pr-4 text-ink-faint">workspace_id</td>
                    <td className="py-2 text-right text-ink">7f2a…e91c</td>
                  </tr>
                  <tr className="border-b border-hairline">
                    <td className="py-2 pr-4 text-ink-faint">accounts</td>
                    <td className="py-2 text-right text-ink">0000006</td>
                  </tr>
                  <tr className="border-b border-hairline">
                    <td className="py-2 pr-4 text-ink-faint">currency</td>
                    <td className="py-2 text-right text-ink">USD</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-ink-faint">as_of</td>
                    <td className="py-2 text-right text-ink">2026-09-11T00:00Z</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Radius, shadow, motion */}
        <section className="mt-20">
          <SectionHeading
            index="§06"
            title="Radius, elevation & motion"
            description="Two radii, two shadows, one easing curve — used sparingly."
          />
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <div className="flex flex-col gap-3">
              <div className="h-16 rounded-pc border border-hairline bg-surface-2" />
              <span className="font-mono text-xs text-ink-faint">--pc-radius / 6px</span>
            </div>
            <div className="flex flex-col gap-3">
              <div className="h-16 rounded-pc-lg border border-hairline bg-surface-2" />
              <span className="font-mono text-xs text-ink-faint">
                --pc-radius-lg / 10px
              </span>
            </div>
            <div className="flex flex-col gap-3">
              <div className="h-16 rounded-pc bg-surface-2 shadow-pc-1" />
              <span className="font-mono text-xs text-ink-faint">--pc-shadow-1</span>
            </div>
            <div className="flex flex-col gap-3">
              <div className="h-16 rounded-pc bg-surface-2 shadow-pc-2" />
              <span className="font-mono text-xs text-ink-faint">--pc-shadow-2</span>
            </div>
          </div>
          <p className="mt-6 font-mono text-xs text-ink-faint">
            --pc-ease: cubic-bezier(0.4, 0, 0.2, 1) — every transition above uses it,
            and every transition is skipped when prefers-reduced-motion is set.
          </p>
        </section>
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6 text-xs text-ink-faint sm:px-8">
          <span className="font-mono">© Pecunia — private ledger</span>
          <span className="font-mono">plan-05 / task-1</span>
        </div>
      </footer>
    </div>
  );
}

export default Showcase;
