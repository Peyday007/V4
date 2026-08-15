import type { DemandEventType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { DEFAULT_JURISDICTIONS } from './connectors/municipalOpenData';
import { DEFAULT_SOLICITATION_DATASETS } from './connectors/municipalSolicitations';

/**
 * What this engine can actually collect, state by state, for all fifty.
 *
 * The claim this exists to prevent is a specific one: a federal award API is
 * nationwide, so a product wired to one is tempted to describe itself as
 * operating nationwide. It does not. It operates wherever a source is
 * configured and answering, and today that is three cities in three states.
 * Every other state is a plan, and the difference between a plan and a
 * capability is the whole of this file.
 *
 * So all fifty are listed. Most report that nothing is configured, which is
 * true and is the only way an owner can see the shape of what is missing rather
 * than inferring it from an empty board. Each one carries the exact next action,
 * because "no coverage in Nebraska" is a fact and "no coverage in Nebraska,
 * and the way to get it is a municipal open-data portal for Omaha or Lincoln"
 * is a decision.
 *
 * Nothing here is scraped, and nothing here proposes scraping. Fifty brittle
 * scrapers to turn a map green would be worse than an honest map: they would
 * break silently, one at a time, and the map would stay green.
 */

export type CoverageStatus =
  /** A configured source is answering and producing events. */
  | 'WORKING'
  /** Configured, and something is stopping it. An owner action, usually. */
  | 'BLOCKED'
  /** Nothing is configured here. Engineering, not configuration. */
  | 'NOT_CONFIGURED';

export type StateSource = {
  label: string;
  domain: string;
  produces: DemandEventType;
  status: 'WORKING' | 'BLOCKED';
  /** Why it is blocked, verbatim from the connector configuration. */
  because: string | null;
};

export type StateCoverage = {
  code: string;
  name: string;
  status: CoverageStatus;
  sources: StateSource[];
  /** Event types this state can currently produce. */
  produces: DemandEventType[];
  /** Real records, never a projection. */
  observed: { events: number; routes: number; lastEventAt: Date | null };
  /** The exact next action, in the owner's language. */
  toCover: string;
};

export type CoverageMatrix = {
  states: StateCoverage[];
  working: number;
  blocked: number;
  notConfigured: number;
  /** The sentence that has to be read before any coverage claim. */
  verdict: string;
};

/**
 * Every state, so the ones with nothing are visible rather than absent.
 *
 * A matrix that only listed the three states with sources would answer "where
 * do we operate" and hide "where do we not", and the second question is the one
 * an owner planning expansion is actually asking.
 */
const STATES: Array<[string, string]> = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'],
  ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'],
  ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];

/**
 * The largest metro in each state without a source, named so the next action is
 * concrete.
 *
 * "Configure a source for Wyoming" is advice nobody can act on. "Cheyenne or
 * Casper publish business licences; check whether either is on Socrata or
 * ArcGIS" is a morning's work with a known end. Only the metro is asserted —
 * whether a portal exists there is exactly what the action asks somebody to
 * find out, and claiming it does would be inventing a source.
 */
const LARGEST_METRO: Record<string, string> = {
  AL: 'Birmingham or Huntsville', AK: 'Anchorage', AZ: 'Phoenix or Tucson', AR: 'Little Rock',
  CA: 'Los Angeles or San Diego', CO: 'Denver', CT: 'Hartford or Bridgeport', DE: 'Wilmington',
  FL: 'Jacksonville, Miami or Tampa', GA: 'Atlanta', HI: 'Honolulu', ID: 'Boise',
  IL: 'Chicago', IN: 'Indianapolis', IA: 'Des Moines', KS: 'Wichita or Kansas City',
  KY: 'Louisville or Lexington', LA: 'New Orleans or Baton Rouge', ME: 'Portland', MD: 'Baltimore',
  MA: 'Boston', MI: 'Detroit or Grand Rapids', MN: 'Minneapolis or Saint Paul', MS: 'Jackson',
  MO: 'Kansas City or St Louis', MT: 'Billings', NE: 'Omaha or Lincoln', NV: 'Las Vegas or Reno',
  NH: 'Manchester', NJ: 'Newark or Jersey City', NM: 'Albuquerque', NY: 'New York City or Buffalo',
  NC: 'Charlotte or Raleigh', ND: 'Fargo', OH: 'Columbus, Cleveland or Cincinnati', OK: 'Oklahoma City or Tulsa',
  OR: 'Portland', PA: 'Philadelphia or Pittsburgh', RI: 'Providence', SC: 'Charleston or Columbia',
  SD: 'Sioux Falls', TN: 'Nashville or Memphis', TX: 'Houston, Dallas, San Antonio or Austin',
  UT: 'Salt Lake City', VT: 'Burlington', VA: 'Virginia Beach or Richmond', WA: 'Seattle',
  WV: 'Charleston', WI: 'Milwaukee or Madison', WY: 'Cheyenne or Casper',
};

export async function coverageMatrix(params: {
  orgId: string;
  dataMode?: 'PRODUCTION' | 'TEST';
}): Promise<CoverageMatrix> {
  const dataMode = params.dataMode ?? 'PRODUCTION';

  // Real records per state, so a state that is configured and has never
  // produced anything is distinguishable from one that has.
  const [eventRows, routeRows] = await Promise.all([
    prisma.demandEvent.groupBy({
      by: ['stateCode'],
      where: { orgId: params.orgId, dataMode },
      _count: { _all: true },
      _max: { eventDate: true },
    }),
    prisma.routeHypothesis.groupBy({
      by: ['eventId'],
      where: { orgId: params.orgId, dataMode },
      _count: { _all: true },
    }).then(async (rows) => {
      // Routes carry no state of their own, so they are attributed through the
      // event that produced them rather than through the account, which may
      // sit somewhere else entirely.
      const ids = rows.map((r) => r.eventId);
      if (ids.length === 0) return new Map<string, number>();
      const events = await prisma.demandEvent.findMany({
        where: { id: { in: ids } },
        select: { id: true, stateCode: true },
      });
      const stateById = new Map(events.map((e) => [e.id, e.stateCode ?? '—']));
      const counts = new Map<string, number>();
      for (const row of rows) {
        const state = stateById.get(row.eventId) ?? '—';
        counts.set(state, (counts.get(state) ?? 0) + row._count._all);
      }
      return counts;
    }),
  ]);

  const eventsByState = new Map(eventRows.map((r) => [r.stateCode ?? '—', r._count._all]));
  const lastByState = new Map(eventRows.map((r) => [r.stateCode ?? '—', r._max.eventDate]));

  const states: StateCoverage[] = STATES.map(([code, name]) => {
    const sources: StateSource[] = [];

    for (const j of DEFAULT_JURISDICTIONS.filter((d) => d.state === code)) {
      sources.push({
        label: j.label,
        domain: j.domain,
        produces: j.eventType,
        status: j.unusableReason ? 'BLOCKED' : 'WORKING',
        because: j.unusableReason ?? null,
      });
    }
    for (const d of DEFAULT_SOLICITATION_DATASETS.filter((s) => s.state === code)) {
      sources.push({
        label: d.label,
        domain: d.domain,
        produces: d.publishes === 'AWARDED_CONTRACT' ? 'CONTRACT_AWARD' : 'PROCUREMENT_NOTICE',
        status: d.unusableReason ? 'BLOCKED' : 'WORKING',
        because: d.unusableReason ?? null,
      });
    }

    const working = sources.filter((s) => s.status === 'WORKING');
    const status: CoverageStatus =
      working.length > 0 ? 'WORKING' : sources.length > 0 ? 'BLOCKED' : 'NOT_CONFIGURED';

    return {
      code,
      name,
      status,
      sources,
      produces: [...new Set(working.map((s) => s.produces))],
      observed: {
        events: eventsByState.get(code) ?? 0,
        routes: routeRows.get(code) ?? 0,
        lastEventAt: lastByState.get(code) ?? null,
      },
      toCover: nextAction(code, status, sources),
    };
  });

  const working = states.filter((s) => s.status === 'WORKING').length;
  const blocked = states.filter((s) => s.status === 'BLOCKED').length;

  return {
    states,
    working,
    blocked,
    notConfigured: states.length - working - blocked,
    verdict:
      `Demand can currently be collected in ${working} state(s) of 50. `
      + `${blocked} more are configured and blocked, and ${states.length - working - blocked} have no source at `
      + 'all. A federal award API being nationwide does not make this engine nationwide — it operates where a '
      + 'source is configured and answering, and nowhere else.',
  };
}

function nextAction(code: string, status: CoverageStatus, sources: StateSource[]): string {
  if (status === 'WORKING') {
    const blocked = sources.filter((s) => s.status === 'BLOCKED');
    return blocked.length === 0
      ? 'Covered. Nothing to do.'
      : `Covered, though ${blocked.length} configured source here is blocked: ${blocked[0].because}`;
  }
  if (status === 'BLOCKED') {
    return `Unblock what is already configured. ${sources.find((s) => s.because)?.because ?? ''}`.trim();
  }
  return (
    `No source is configured. ${LARGEST_METRO[code] ?? 'The largest metro'} would be the place to start: check `
    + 'whether the city publishes business licences, occupancy approvals or bid notices through an open-data '
    + 'portal, and add the dataset if it does. If it does not, this state stays uncovered rather than being '
    + 'scraped.'
  );
}
