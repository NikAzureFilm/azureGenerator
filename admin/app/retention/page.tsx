import Nav from '@/app/components/Nav';
import ActivityChart from '@/app/components/ActivityChart';
import GrowthChart from '@/app/components/GrowthChart';
import Kpi from '@/app/components/Kpi';
import RetentionTable from '@/app/components/RetentionTable';
import { requireAdmin } from '@/lib/auth';
import { num, pct, shortDate } from '@/lib/format';
import {
  fetchDailyActivity,
  fetchFunnel,
  fetchGrowthWeekly,
  fetchRetentionCohorts,
} from '@/lib/metrics';
import { buildCohortMatrix, latestCohortSummary } from '@/lib/retention';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function cohortDeltaCopy(delta: number | null) {
  if (delta === null) return 'first comparable cohort in range';
  const points = `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} pts`;
  return `${points} vs previous eligible cohort`;
}

function weekCountLabel(weeks: number) {
  return `${weeks} week${weeks === 1 ? '' : 's'}`;
}

function cohortRetentionSubline(
  summary: ReturnType<typeof latestCohortSummary>,
  offset: number,
) {
  if (!summary) {
    return <>Need a cohort at least {weekCountLabel(offset)} old.</>;
  }

  return (
    <>
      {shortDate(summary.cohortWeek)} cohort - {num(summary.active)} of{' '}
      {num(summary.cohortSize)} active {weekCountLabel(offset)} later
      <br />
      {cohortDeltaCopy(summary.deltaFromPrevious)}
    </>
  );
}

export default async function RetentionPage() {
  const admin = await requireAdmin();

  const [growth, cohorts, funnel, daily] = await Promise.all([
    fetchGrowthWeekly(12),
    fetchRetentionCohorts(12),
    fetchFunnel(),
    fetchDailyActivity(90),
  ]);

  const base = Math.max(funnel.signed_up, 1);
  const cohortMatrix = buildCohortMatrix(cohorts);
  const w1 = latestCohortSummary(cohortMatrix, 1);
  const w4 = latestCohortSummary(cohortMatrix, 4);
  const currentPaidShare = funnel.currently_subscribed / base;

  const steps = [
    { label: 'Signed up', value: funnel.signed_up },
    { label: 'Generated anything', value: funnel.generated_anything },
    { label: 'Ever subscribed', value: funnel.ever_subscribed },
  ];

  return (
    <div className="wrap">
      <Nav active="retention" email={admin.email} />

      <div className="section-title">Retention</div>
      <div className="sub retention-intro">
        Retention means a user consumed tokens in that week. W0 is the signup
        week.
      </div>

      <div className="kpi grid">
        <Kpi
          label="W1 retention"
          value={w1 ? pct(w1.retention) : '-'}
          sub={cohortRetentionSubline(w1, 1)}
        />
        <Kpi
          label="W4 retention"
          value={w4 ? pct(w4.retention) : '-'}
          sub={cohortRetentionSubline(w4, 4)}
        />
        <Kpi
          label="Signup -> generated anything"
          value={pct(funnel.generated_anything / base)}
          sub={
            <>
              {num(funnel.generated_anything)} of {num(funnel.signed_up)} users
              <br />
              CAD, mesh, or image generation
            </>
          }
        />
        <Kpi
          label="Signup -> ever subscribed"
          value={pct(funnel.ever_subscribed / base)}
          sub={
            <>
              {num(funnel.ever_subscribed)} lifetime paid users
              <br />
              Current paid share: {pct(currentPaidShare)}
            </>
          }
        />
      </div>

      <div className="section-title">Weekly retention cohorts</div>
      <div className="card retention-guide">
        <div className="label">How to read this table</div>
        <div className="retention-legend">
          <span>
            <span className="legend-swatch high" />
            darker green = higher retention
          </span>
          <span>
            <span className="legend-swatch zero" />
            0.0% = week reached, no activity
          </span>
          <span>
            <span className="legend-swatch future" />- = cohort has not reached
            that week yet
          </span>
        </div>
      </div>
      <RetentionTable data={cohorts} />

      <div className="section-title">Conversion funnel</div>
      <div className="card">
        <div className="label">Historical lifecycle share of all signups</div>
        <div style={{ marginTop: 12 }}>
          {steps.map((step) => {
            const fraction = step.value / base;
            return (
              <div className="fbar-row" key={step.label}>
                <div className="fbar-label">{step.label}</div>
                <div className="fbar-track">
                  <div
                    className="fbar"
                    style={{ width: `${Math.max(2, fraction * 100)}%` }}
                  />
                </div>
                <div className="fbar-val mono">
                  {num(step.value)}{' '}
                  <span className="muted">({pct(fraction)})</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="cols-2 grid" style={{ marginTop: 14 }}>
        <Kpi
          label="Current paying share"
          value={pct(currentPaidShare)}
          sub={
            <>
              {num(funnel.currently_subscribed)} users currently active or trial
            </>
          }
        />
        <Kpi
          label="Canceled users (current status)"
          value={num(funnel.canceled)}
          sub={<>Count only. This is not a time-based churn rate.</>}
        />
      </div>

      <div className="section-title">Supporting signals</div>
      <GrowthChart data={growth} />

      <div style={{ marginTop: 14 }}>
        <ActivityChart data={daily} />
      </div>
    </div>
  );
}
