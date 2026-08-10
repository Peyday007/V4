import type { MarketScope } from '@prisma/client';
import { prisma } from '@/lib/db';
import { US_STATES } from './connectors/nppes';

/**
 * Market presets.
 *
 * The platform operates nationwide. That is a statement about the sources —
 * NPPES, USAspending, Places and SAM.gov all answer national questions — and
 * about the default configuration, which is a national market rather than one
 * city with aspirations.
 *
 * Named metros exist alongside it because coverage and attention are different
 * problems. A national sweep finds leads everywhere; an active metro is where
 * callers are actually working this month. Both are rows, and an operation can
 * run any combination.
 */

export type MarketPreset = {
  name: string;
  slug: string;
  scope: MarketScope;
  kind: string;
  state?: string;
  states?: string[];
  centerLat?: number;
  centerLng?: number;
  radiusMeters?: number;
  cities?: string[];
  counties?: string[];
  isDefault?: boolean;
  isEnabled?: boolean;
  sourceConfig?: Record<string, unknown>;
};

/** Nationwide coverage. The default, and the thing that makes the claim true. */
export const NATIONAL_MARKET: MarketPreset = {
  name: 'United States (nationwide)',
  slug: 'us-nationwide',
  scope: 'NATIONAL',
  kind: 'national',
  // Empty states under NATIONAL scope means every state; connectors partition
  // it themselves rather than requiring fifty rows.
  states: [],
  isDefault: true,
  isEnabled: true,
  sourceConfig: {
    // Applies to every state unless a narrower market overrides it.
    awardNaics: ['561720', '561790', '561210', '561740'],
    samNaics: ['561720', '561790', '561210', '561740', '423850'],
  },
};

/**
 * Named metros across different states, deliberately mixing large urban
 * markets with smaller and non-urban ones. These are starting points a user
 * edits or deletes, not a fixed list — and none of them is privileged in code.
 */
export const METRO_PRESETS: MarketPreset[] = [
  {
    name: 'Dallas–Fort Worth, TX',
    slug: 'dfw',
    scope: 'METRO',
    kind: 'metro',
    state: 'TX',
    states: ['TX'],
    centerLat: 32.7767,
    centerLng: -96.797,
    radiusMeters: 60_000,
    cities: ['Dallas', 'Fort Worth', 'Plano', 'Irving', 'Arlington', 'Garland', 'Frisco'],
    counties: ['Dallas County', 'Tarrant County', 'Collin County', 'Denton County'],
    sourceConfig: {
      socrata: [
        {
          domain: 'www.dallasopendata.com',
          datasetId: 'e7gq-4sah',
          label: 'Dallas building permit',
          dateColumn: 'issued_date',
          columns: {
            description: 'work_description',
            address: 'address',
            city: 'city',
            value: 'estimated_cost',
            workType: 'permit_type',
            permitNumber: 'permit_number',
            owner: 'owner_name',
            status: 'status',
          },
        },
      ],
    },
  },
  {
    name: 'Chicago, IL',
    slug: 'chicago',
    scope: 'METRO',
    kind: 'metro',
    state: 'IL',
    states: ['IL'],
    centerLat: 41.8781,
    centerLng: -87.6298,
    radiusMeters: 50_000,
    cities: ['Chicago', 'Evanston', 'Oak Park', 'Cicero', 'Naperville'],
    counties: ['Cook County', 'DuPage County'],
    sourceConfig: {
      socrata: [
        {
          domain: 'data.cityofchicago.org',
          datasetId: 'ydr8-5enu',
          label: 'Chicago building permit',
          dateColumn: 'issue_date',
          columns: {
            description: 'work_description',
            address: 'street_name',
            value: 'reported_cost',
            workType: 'permit_type',
            permitNumber: 'permit_',
            owner: 'contact_1_name',
          },
        },
      ],
    },
  },
  {
    name: 'New York City, NY',
    slug: 'nyc',
    scope: 'METRO',
    kind: 'metro',
    state: 'NY',
    states: ['NY', 'NJ'],
    centerLat: 40.7128,
    centerLng: -74.006,
    radiusMeters: 40_000,
    cities: ['New York', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'Newark', 'Jersey City'],
    counties: ['New York County', 'Kings County', 'Queens County'],
    sourceConfig: {
      socrata: [
        {
          domain: 'data.cityofnewyork.us',
          datasetId: 'ipu4-2q9a',
          label: 'NYC DOB permit',
          dateColumn: 'issuance_date',
          columns: {
            description: 'job_type',
            address: 'house_',
            city: 'borough',
            workType: 'work_type',
            permitNumber: 'job_',
            owner: 'owner_s_business_name',
          },
        },
      ],
    },
  },
  {
    name: 'Phoenix, AZ',
    slug: 'phoenix',
    scope: 'METRO',
    kind: 'metro',
    state: 'AZ',
    states: ['AZ'],
    centerLat: 33.4484,
    centerLng: -112.074,
    radiusMeters: 55_000,
    cities: ['Phoenix', 'Mesa', 'Scottsdale', 'Tempe', 'Chandler', 'Glendale'],
    counties: ['Maricopa County'],
  },
  {
    name: 'Atlanta, GA',
    slug: 'atlanta',
    scope: 'METRO',
    kind: 'metro',
    state: 'GA',
    states: ['GA'],
    centerLat: 33.749,
    centerLng: -84.388,
    radiusMeters: 55_000,
    cities: ['Atlanta', 'Marietta', 'Decatur', 'Sandy Springs', 'Alpharetta'],
    counties: ['Fulton County', 'DeKalb County', 'Cobb County'],
  },
  // Non-urban markets. Included because a platform validated only on large
  // metros hides the failure mode where thin coverage produces nothing and
  // nobody notices until a caller has an empty queue.
  {
    name: 'Western Kansas (rural)',
    slug: 'western-kansas',
    scope: 'COUNTY',
    kind: 'rural',
    state: 'KS',
    states: ['KS'],
    centerLat: 38.8403,
    centerLng: -99.3268,
    radiusMeters: 120_000,
    cities: ['Hays', 'Garden City', 'Dodge City', 'Great Bend', 'Liberal'],
    counties: ['Ellis County', 'Finney County', 'Ford County'],
  },
  {
    name: 'Montana (statewide)',
    slug: 'montana',
    scope: 'STATE',
    kind: 'state',
    state: 'MT',
    states: ['MT'],
    centerLat: 46.8797,
    centerLng: -110.3626,
    radiusMeters: 200_000,
    cities: ['Billings', 'Missoula', 'Great Falls', 'Bozeman', 'Helena'],
  },
];

/**
 * How widely an organisation wants to look.
 *
 * Stored as markets rather than a mode flag, because the combinations the
 * requirement calls for — national plus selected metros, several states at
 * once, a radius around one city — are all just sets of market rows. A single
 * enum would have to grow a case for each.
 */
export type DiscoveryCoverage = 'NATIONWIDE' | 'NATIONWIDE_PLUS_METROS' | 'SELECTED_MARKETS_ONLY';

export async function applyCoverage(orgId: string, coverage: DiscoveryCoverage): Promise<void> {
  switch (coverage) {
    case 'NATIONWIDE':
      await prisma.market.updateMany({ where: { orgId, scope: 'NATIONAL' }, data: { isEnabled: true } });
      await prisma.market.updateMany({ where: { orgId, scope: { not: 'NATIONAL' } }, data: { isEnabled: false } });
      break;
    case 'NATIONWIDE_PLUS_METROS':
      await prisma.market.updateMany({ where: { orgId }, data: { isEnabled: true } });
      break;
    case 'SELECTED_MARKETS_ONLY':
      // Leaves the per-market choices alone apart from switching off the
      // national sweep — which is the whole point of choosing this.
      await prisma.market.updateMany({ where: { orgId, scope: 'NATIONAL' }, data: { isEnabled: false } });
      break;
  }
}

export type MarketInstallResult = { created: string[]; existing: number };

/**
 * Installs the national market and the metro presets. Idempotent, and it never
 * re-enables or overwrites a market the operator has already configured.
 */
export async function ensureMarkets(
  orgId: string,
  options: { includeMetros?: boolean } = {},
): Promise<MarketInstallResult> {
  const existing = await prisma.market.findMany({ where: { orgId }, select: { slug: true } });
  const have = new Set(existing.map((m) => m.slug));
  const wanted = [NATIONAL_MARKET, ...(options.includeMetros === false ? [] : METRO_PRESETS)];
  const created: string[] = [];

  for (const preset of wanted) {
    if (have.has(preset.slug)) continue;
    await prisma.market.create({
      data: {
        orgId,
        name: preset.name,
        slug: preset.slug,
        scope: preset.scope,
        kind: preset.kind,
        state: preset.state ?? null,
        states: preset.states ?? [],
        centerLat: preset.centerLat ?? null,
        centerLng: preset.centerLng ?? null,
        radiusMeters: preset.radiusMeters ?? 40_000,
        cities: preset.cities ?? [],
        counties: preset.counties ?? [],
        isDefault: preset.isDefault ?? false,
        // Metro presets install enabled so nationwide coverage is real on the
        // first run rather than after a configuration step nobody knows about.
        isEnabled: preset.isEnabled ?? true,
        sourceConfig: (preset.sourceConfig ?? {}) as object,
      },
    });
    created.push(preset.slug);
  }

  return { created, existing: existing.length };
}

/**
 * Chooses the market a discovered record belongs to.
 *
 * Under a nationwide sweep every record arrives tagged with the national
 * market, which is true but useless for routing work to a caller. Re-homing it
 * onto the narrowest market that actually contains it is what makes "leads in
 * Phoenix" a question the board can answer.
 */
export function assignMarket<T extends { id: string; scope: MarketScope; state: string | null; states: string[]; cities: string[]; postalCodes: string[] }>(
  markets: T[],
  record: { state?: string | null; location?: string | null; postalCode?: string | null },
): T | null {
  const state = record.state?.trim().toUpperCase() ?? null;
  const city = record.location?.split(',')[0]?.trim().toLowerCase() ?? null;
  const postal = record.postalCode?.trim() ?? null;

  const inState = (market: T): boolean => {
    if (!state) return false;
    const marketStates = market.states.length > 0 ? market.states : market.state ? [market.state] : [];
    return marketStates.some((s) => s.toUpperCase() === state);
  };

  const contains = (market: T): boolean => {
    if (market.scope === 'NATIONAL') return true;
    if (postal && market.postalCodes.includes(postal)) return true;
    if (city && market.cities.some((name) => name.toLowerCase() === city)) return true;

    // A sub-state market must not claim a record just because the state
    // matches. Without this, a metro with a city list swallows every record in
    // its state — Lubbock lands in the Dallas metro and a caller is dispatched
    // 350 miles. Only state-wide and national markets match on state alone.
    if (market.scope === 'STATE') return inState(market);

    // County and radius markets have no city list to check against, so the
    // state is the best available containment test for them.
    if ((market.scope === 'COUNTY' || market.scope === 'RADIUS') && market.cities.length === 0) {
      return inState(market);
    }

    return false;
  };

  // Narrowest wins: a Dallas record belongs to the Dallas metro, not to the
  // national sweep that happened to surface it.
  const specificity: Record<MarketScope, number> = {
    POSTAL: 0,
    CITY: 1,
    RADIUS: 2,
    METRO: 3,
    COUNTY: 4,
    STATE: 5,
    NATIONAL: 6,
  };

  const matches = markets.filter(contains);
  if (matches.length === 0) return null;
  return matches.reduce((best, market) => (specificity[market.scope] < specificity[best.scope] ? market : best));
}

export { US_STATES };
