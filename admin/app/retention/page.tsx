import { requireAdmin } from '@/lib/auth';
import {
  fetchGrowthWeekly,
  fetchRetentionCohorts,
  fetchFunnel,
  fetchDailyActivity,
} from '@/lib/metrics';
import { num, pct } from '@/lib/format';
import Nav from '@/app/components/Nav';
import Kpi from '@/app/components/Kpi';
import GrowthChart from '@/app/components/GrowthChart';
import RetentionTable from '@/app/components/RetentionTable';
import ActivityChart from '@/app/components/ActivityChart';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function RetentionPage() {
  const admin = await requireAdmin();

  const [growth, cohorts, funnel, daily] = await Promise.all([
    fetchGrowthWeekly(12),
    fetchRetentionCohorts(12),
    fetchFunnel(),
    fetchDailyActivity(90),
  ]);

  const base = funnel.signed_up || 1;
  const steps = [
    { label: 'Signed up', value: funnel.signed_up },
    { label: 'Generated something', value: funnel.generated },
    { label: 'Subscribed (active/trial)', value: funnel.subscribed },
  ];

  return (
    <div className="wrap">
      <Nav active="retention" email={admin.email} />

      <div className="section-title">Growth</div>
      <GrowthChart data={growth} />

      <div style={{ marginTop: 14 }}>
        <ActivityChart data={daily} />
      </div>

      <div className="section-title">Conversion funnel</div>
      <div className="card">
        <div className="label">Lifecycle (share of all signups)</div>
        <div style={{ marginTop: 12 }}>
          {steps.map((s) => {
            const frac = s.value / base;
            return (
              <div className="fbar-row" key={s.label}>
                <div className="fbar-label">{s.label}</div>
                <div className="fbar-track">
                  <div
                    className="fbar"
                    style={{ width: `${Math.max(2, frac * 100)}%` }}
                  />
                </div>
                <div className="fbar-val mono">
                  {num(s.value)} <span className="muted">({pct(frac)})</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="kpi grid" style={{ marginTop: 14 }}>
        <Kpi
          label="Ever subscribed"
          value={num(funnel.ever_subscribed)}
          sub={<>any status, lifetime</>}
        />
        <Kpi
          label="Canceled (lifetime)"
          value={num(funnel.canceled)}
          sub={
            <span className="muted">
              count, not a churn rate — no cancel timestamps in schema
            </span>
          }
        />
        <Kpi
          label="Signup → generated"
          value={pct(funnel.generated / base)}
          sub={<>activation rate</>}
        />
        <Kpi
          label="Signup → subscribed"
          value={pct(funnel.subscribed / base)}
          sub={<>paid conversion</>}
        />
      </div>

      <div className="section-title">Weekly retention cohorts</div>
      <div className="sub" style={{ marginBottom: 10 }}>
        Each row is a signup-week cohort; columns show the share still active
        (consuming tokens) N weeks later.
      </div>
      <RetentionTable data={cohorts} />
    </div>
  );
}
