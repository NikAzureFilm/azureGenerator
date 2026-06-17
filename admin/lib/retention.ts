import type { CohortRow } from './metrics';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;

export type CohortMatrixRow = {
  cohortWeek: string;
  cohortSize: number;
  ageWeeks: number;
  activeByOffset: Map<number, number>;
};

export type CohortSummaryPoint = {
  cohortWeek: string;
  cohortSize: number;
  active: number;
  retention: number;
  deltaFromPrevious: number | null;
};

function startOfUtcWeek(value: Date): Date {
  const utc = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
  const day = utc.getUTCDay();
  const mondayOffset = (day + 6) % DAYS_PER_WEEK;
  utc.setUTCDate(utc.getUTCDate() - mondayOffset);
  return utc;
}

function parseUtcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export function buildCohortMatrix(
  data: CohortRow[],
  now: Date = new Date(),
): CohortMatrixRow[] {
  const currentWeek = startOfUtcWeek(now);
  const rows = new Map<string, CohortMatrixRow>();

  for (const row of data) {
    let cohort = rows.get(row.cohort_week);
    if (!cohort) {
      const cohortDate = parseUtcDate(row.cohort_week);
      const ageWeeks = Math.max(
        0,
        Math.floor(
          (currentWeek.getTime() - cohortDate.getTime()) /
            MS_PER_DAY /
            DAYS_PER_WEEK,
        ),
      );
      cohort = {
        cohortWeek: row.cohort_week,
        cohortSize: row.cohort_size,
        ageWeeks,
        activeByOffset: new Map<number, number>(),
      };
      rows.set(row.cohort_week, cohort);
    }
    cohort.activeByOffset.set(row.week_offset, row.active);
  }

  return Array.from(rows.values()).sort((a, b) =>
    b.cohortWeek.localeCompare(a.cohortWeek),
  );
}

export function latestCohortSummary(
  rows: CohortMatrixRow[],
  offset: number,
): CohortSummaryPoint | null {
  const eligible = rows.filter((row) => row.ageWeeks >= offset);
  if (eligible.length === 0) return null;

  const current = eligible[0];
  const previous = eligible[1];
  const active = current.activeByOffset.get(offset) ?? 0;
  const retention = current.cohortSize > 0 ? active / current.cohortSize : 0;

  let deltaFromPrevious: number | null = null;
  if (previous && previous.cohortSize > 0) {
    const previousActive = previous.activeByOffset.get(offset) ?? 0;
    deltaFromPrevious = retention - previousActive / previous.cohortSize;
  }

  return {
    cohortWeek: current.cohortWeek,
    cohortSize: current.cohortSize,
    active,
    retention,
    deltaFromPrevious,
  };
}
