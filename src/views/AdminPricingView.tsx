import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatTokenCost, formatUsd } from '@shared/tokenCosts';

type AdminPricingRow = {
  id: string;
  label: string;
  description: string;
  provider: string;
  providerCostUsd: number;
  tokens: number;
  customerRevenueUsd: number;
  grossMarginUsd: number;
  grossMarginPercent: number | null;
  notes: string | null;
};

type AdminPricingResponse = {
  tokenUsdValue: number;
  markupMultiplier: number;
  rows: AdminPricingRow[];
};

function formatPercent(value: number | null): string {
  if (value === null) return '-';
  return `${Math.round(value * 100)}%`;
}

export function AdminPricingView() {
  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['admin-pricing'],
    queryFn: async (): Promise<AdminPricingResponse> => {
      const { data, error } = await supabase.functions.invoke('admin-pricing');
      if (error) throw error;
      return data as AdminPricingResponse;
    },
    retry: false,
  });

  return (
    <main className="min-h-full overflow-auto bg-adam-bg-dark text-adam-text-primary">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-10 md:px-8">
        <section className="flex flex-col gap-4 border-b border-adam-neutral-800 pb-8">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-adam-neutral-700 bg-adam-neutral-900 text-adam-blue">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-kumbh-sans text-3xl font-light text-white md:text-4xl">
              Admin Pricing
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-adam-text-secondary">
              Internal provider costs, token pricing, and gross margin. This
              data is served from protected Supabase secrets and is not bundled
              into the customer frontend.
            </p>
          </div>
        </section>

        {isLoading && (
          <div className="rounded-lg border border-adam-neutral-800 bg-adam-neutral-950 p-5 text-sm text-adam-text-secondary">
            Loading admin pricing...
          </div>
        )}

        {error && (
          <div className="flex flex-col gap-4 rounded-lg border border-red-900/70 bg-red-950/30 p-5 text-sm text-red-200 md:flex-row md:items-center md:justify-between">
            <p>
              Admin pricing is unavailable. Check that your account email is in
              `ADMIN_EMAILS` and `ADMIN_PRICING_CONFIG_JSON` is set in Supabase
              secrets.
            </p>
            <button
              type="button"
              className="w-fit rounded-lg border border-red-800 px-3 py-2 text-xs font-medium text-red-100 transition-colors hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {isFetching ? 'Retrying...' : 'Retry'}
            </button>
          </div>
        )}

        {data && (
          <>
            <section className="grid gap-4 md:grid-cols-3">
              <Metric
                label="Token value"
                value={formatUsd(data.tokenUsdValue)}
              />
              <Metric label="Markup" value={`${data.markupMultiplier}x`} />
              <Metric label="Tracked features" value={`${data.rows.length}`} />
            </section>

            <section className="overflow-hidden rounded-lg border border-adam-neutral-800 bg-adam-neutral-950">
              <div className="hidden grid-cols-[1.2fr_1fr_0.7fr_0.7fr_0.7fr_0.7fr] gap-3 border-b border-adam-neutral-800 px-4 py-3 text-xs font-medium uppercase tracking-normal text-adam-text-secondary md:grid">
                <span>Feature</span>
                <span>Provider</span>
                <span>API cost</span>
                <span>Revenue</span>
                <span>Margin</span>
                <span>Tokens</span>
              </div>

              {data.rows.map((row, index) => (
                <div
                  key={`${row.id}-${index}`}
                  className="grid gap-3 border-adam-neutral-800 p-4 text-sm md:grid-cols-[1.2fr_1fr_0.7fr_0.7fr_0.7fr_0.7fr] md:items-center"
                  style={{ borderTopWidth: index === 0 ? 0 : 1 }}
                >
                  <div>
                    <div className="font-medium text-white">{row.label}</div>
                    <p className="mt-1 text-xs leading-5 text-adam-text-secondary">
                      {row.notes || row.description}
                    </p>
                  </div>
                  <div className="text-xs text-adam-text-secondary">
                    {row.provider}
                  </div>
                  <Value label="API" value={formatUsd(row.providerCostUsd)} />
                  <Value
                    label="Revenue"
                    value={formatUsd(row.customerRevenueUsd)}
                  />
                  <Value
                    label="Margin"
                    value={`${formatUsd(row.grossMarginUsd)} (${formatPercent(
                      row.grossMarginPercent,
                    )})`}
                  />
                  <div className="font-medium text-adam-blue">
                    {formatTokenCost(row.tokens)}
                  </div>
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-adam-neutral-800 bg-adam-neutral-950 p-4">
      <div className="text-xs text-adam-text-secondary">{label}</div>
      <div className="mt-2 text-lg font-medium text-white">{value}</div>
    </div>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 md:block">
      <span className="text-xs text-adam-text-secondary md:hidden">
        {label}
      </span>
      <span className="font-medium text-white">{value}</span>
    </div>
  );
}
