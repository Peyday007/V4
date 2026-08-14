/**
 * How much of the portfolio is one thing wearing several hats.
 *
 * The audit that started this found 54 production routes that looked like a
 * commercial portfolio and were two demand events refracted — one into 42
 * hypotheses, one into 12 — with 85% of the whole thing concentrated in
 * janitorial work because a single hardcoded line in an audit script said so.
 * Nothing in the product noticed, because nothing in the product was counting.
 *
 * Two rules do most of the work here, and both are counting rules rather than
 * scores:
 *
 *   Several hypotheses from one event are one opportunity. A board showing
 *   three routes to the same buyer is showing one phone call three times, and
 *   a portfolio "diversified" across three routes from one licence record is
 *   not diversified at all.
 *
 *   Concentration is only interesting against something. A business that does
 *   one thing in one city is concentrated by construction and should not be
 *   nagged about it; a business whose entire pipeline depends on one source
 *   that could be republished tomorrow has a real exposure. So each measure
 *   says what would actually happen if the thing it names went away.
 *
 * Deliberately no score and no grade. An exposure is a sentence about what
 * breaks, or it is nothing.
 */

import { prisma } from '@/lib/db';
import { DEFAULT_JURISDICTIONS } from '@/lib/demand/connectors/municipalOpenData';
import { DEFAULT_SOLICITATION_DATASETS } from '@/lib/demand/connectors/municipalSolicitations';

export type Exposure = {
  /** What is concentrated: a category, a city, a source, a buyer. */
  dimension: string;
  /** The single largest holder within it. */
  largest: string;
  share: number;
  count: number;
  total: number;
  /** What happens if this one thing goes away. The only reason to care. */
  ifItGoes: string;
  /** True when this is worth an owner's attention rather than just true. */
  material: boolean;
};

export type PortfolioShape = {
  routes: number;
  /**
   * Distinct events behind those routes. The gap between this and `routes` is
   * how much of the portfolio is one thing counted several times.
   */
  opportunities: number;
  refraction: number;
  exposures: Exposure[];
  /** One sentence an owner can act on, or an honest statement of emptiness. */
  verdict: string;
};

/**
 * Below this a portfolio is too small for concentration to mean anything.
 *
 * Four routes all in one city is not an exposure, it is a Tuesday. Reporting
 * it as a risk teaches an owner to ignore the panel by the time it matters.
 */
const MEANINGFUL_SIZE = 8;

/** A share above this is worth saying out loud. */
const MATERIAL_SHARE = 0.5;

export async function portfolioShape(params: {
  orgId: string;
  dataMode?: 'PRODUCTION' | 'TEST';
}): Promise<PortfolioShape> {
  const routes = await prisma.routeHypothesis.findMany({
    where: {
      orgId: params.orgId,
      dataMode: params.dataMode ?? 'PRODUCTION',
      status: { notIn: ['EXPIRED', 'REJECTED'] },
    },
    select: {
      eventId: true,
      companyId: true,
      requiredCapability: true,
      route: true,
      playbookKey: true,
      event: { select: { connector: true, stateCode: true, type: true } },
      company: {
        select: {
          legalName: true,
          stateCode: true,
          // The primary one where marked, else whichever is attached. An
          // industry is a join row here, not a column.
          industries: {
            select: { industry: { select: { name: true } } },
            orderBy: { isPrimary: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  const total = routes.length;
  const opportunities = new Set(routes.map((r) => r.eventId)).size;

  if (total === 0) {
    return {
      routes: 0,
      opportunities: 0,
      refraction: 0,
      exposures: [],
      verdict:
        'Nothing to be concentrated in. The portfolio is empty, which is a collection problem rather than a '
        + 'balance one — see the demand board for which stage stopped.',
    };
  }

  const exposures = [
    largestShare('commercial category', routes, (r) => category(r.requiredCapability),
      (name, share) =>
        `${(share * 100).toFixed(0)}% of live work is ${name}. If that trade goes quiet, or the one provider `
        + 'who covers it stops answering, most of the pipeline stops with it.'),
    largestShare('source', routes, (r) => r.event.connector,
      (name, share) =>
        `${(share * 100).toFixed(0)}% of live work came from ${name}. A portal that republishes a dataset `
        + 'takes that share of the pipeline with it, and the first sign is an empty board.'),
    largestShare('geography', routes, (r) => r.company.stateCode ?? r.event.stateCode ?? 'unknown',
      (name, share) =>
        `${(share * 100).toFixed(0)}% of live work is in ${name}. Fine if that is the market; an exposure if `
        + 'it is an accident of which portals happen to be working.'),
    largestShare('buyer', routes, (r) => r.company.legalName,
      (name, share) =>
        `${(share * 100).toFixed(0)}% of live work is with ${name}. One relationship going cold takes that `
        + 'much of the pipeline.'),
    largestShare('industry', routes, (r) => r.company.industries[0]?.industry.name ?? 'unstated',
      (name, share) =>
        `${(share * 100).toFixed(0)}% of buyers are in ${name}. An industry with a bad quarter takes that `
        + 'share with it, and they tend to have bad quarters together.'),
    largestShare('commercial route', routes, (r) => String(r.route),
      (name, share) =>
        `${(share * 100).toFixed(0)}% of live work transacts as ${lower(name)}. Every route carries its own `
        + 'working capital and delivery risk, so this is how much of the business is exposed to one of them.'),
    // The one that makes the others look better than they are. Several routes
    // can differ in category, place and buyer and still rest on the same
    // hypothesis — "a new licence means somebody needs a first clean" — and if
    // that hypothesis is wrong they are all wrong at once.
    largestShare('underlying play', routes, (r) => r.playbookKey,
      (name, share) =>
        `${(share * 100).toFixed(0)}% of live work rests on the same play (${name}). It can look diverse by `
        + 'category, place and buyer and still be one bet: if the hypothesis behind that play is wrong, all of '
        + 'it is wrong together.'),
    largestShare('event type', routes, (r) => String(r.event.type),
      (name, share) =>
        `${(share * 100).toFixed(0)}% of live work came from one kind of event (${lower(name)}). A source that `
        + 'stops publishing that kind takes the lot.'),
  ].filter((e): e is Exposure => e !== null);

  return {
    routes: total,
    opportunities,
    refraction: total - opportunities,
    exposures,
    verdict: verdictFor({ total, opportunities, exposures }),
  };
}

function largestShare<T>(
  dimension: string,
  rows: T[],
  key: (row: T) => string,
  describe: (name: string, share: number) => string,
): Exposure | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row) || 'unstated';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const [largest, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!largest) return null;

  const share = count / rows.length;
  return {
    dimension,
    largest,
    share,
    count,
    total: rows.length,
    ifItGoes: describe(largest, share),
    // A single holder of a dimension with only one distinct value is a
    // description of the business, not a concentration to act on.
    material: rows.length >= MEANINGFUL_SIZE && share >= MATERIAL_SHARE && counts.size > 1,
  };
}

function lower(text: string): string {
  return text.toLowerCase().replace(/_/g, ' ');
}

/** The commercial thing being sold, from the capability the route requires. */
export function category(capability: string | null): string {
  const c = (capability ?? '').toLowerCase();
  if (!c) return 'unstated';
  if (/janitor|clean|custodial|sanitat|consumable/.test(c)) return 'cleaning / janitorial';
  if (/construct|build|fit-?out|renovat/.test(c)) return 'construction';
  if (/landscap|ground|snow/.test(c)) return 'grounds';
  if (/secur|guard/.test(c)) return 'security';
  if (/haul|freight|transport|logistic|carrier/.test(c)) return 'logistics';
  if (/steel|metal|lumber|material|supply|distribut/.test(c)) return 'materials / distribution';
  if (/hvac|plumb|electric|mechanic|facilit/.test(c)) return 'building trades';
  if (/staff|labour|labor|personnel/.test(c)) return 'staffing';
  return c.slice(0, 30);
}

function verdictFor(input: { total: number; opportunities: number; exposures: Exposure[] }): string {
  const parts: string[] = [];
  const refraction = input.total - input.opportunities;

  // Refraction first, because it is the one that makes every other number
  // above look better than it is.
  if (refraction > 0) {
    const pct = ((refraction / input.total) * 100).toFixed(0);
    parts.push(
      `${input.total} route(s) rest on ${input.opportunities} distinct event(s): ${pct}% of the board is one `
      + 'opportunity counted more than once. Callers get one of each organisation at a time, so this is a '
      + 'reporting distortion rather than wasted calls — but the portfolio is smaller than it looks.',
    );
  }

  const material = input.exposures.filter((e) => e.material);
  if (input.total < MEANINGFUL_SIZE) {
    parts.push(
      `Only ${input.total} live route(s) — too few for concentration to mean anything yet. A small portfolio is `
      + 'concentrated by arithmetic, not by choice.',
    );
  } else if (material.length === 0) {
    parts.push('No single category, source, place or buyer holds more than half the live work.');
  } else {
    parts.push(...material.map((e) => e.ifItGoes));
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * What the engine can actually reach, as opposed to what it is configured for.
 *
 * Concentration answers "how balanced is what we have". This answers the
 * question underneath it, which turned out to matter more: how balanced
 * *could* it be. A portfolio 100% in Illinois is not a discipline problem if
 * Illinois is the only state a working source covers — it is the shape the
 * collection layer forces, and telling an owner to diversify without telling
 * them that would send them looking for a fault in how work is chosen when the
 * fault is in what arrives.
 *
 * Read from the shipped configuration rather than from what has been
 * collected, so it is honest on an empty board — which is precisely when
 * somebody needs it.
 */
export type Coverage = {
  /** States a currently-usable source can produce events in. */
  reachable: string[];
  /** States configured but parked, with why. */
  unreachable: Array<{ state: string; label: string; because: string }>;
  /** The sentence an owner needs before they read a concentration figure. */
  verdict: string;
};

export function coverage(input: {
  jurisdictions: Array<{ state: string; label: string; unusableReason?: string }>;
  portals: Array<{ state: string; label: string; unusableReason?: string }>;
}): Coverage {
  const all = [...input.jurisdictions, ...input.portals];
  const reachable = [...new Set(all.filter((d) => !d.unusableReason).map((d) => d.state))].sort();
  const unreachable = all
    .filter((d) => d.unusableReason)
    // A state is only unreachable when nothing working covers it.
    .filter((d) => !reachable.includes(d.state))
    .map((d) => ({ state: d.state, label: d.label, because: d.unusableReason! }));

  const verdict =
    reachable.length === 0
      ? 'No configured source can currently produce an event anywhere. Concentration is not the question; '
        + 'collection is.'
      : `Live work can only come from ${reachable.join(', ')}, because those are the states a working source `
        + `covers. Any concentration in those places is the shape collection forces, not a choice about what `
        + `to pursue`
        + (unreachable.length > 0
          ? `; ${unreachable.length} configured jurisdiction(s) are parked and produce nothing.`
          : '.');

  return { reachable, unreachable, verdict };
}

/** Coverage from the shipped configuration, which is the only honest source. */
export function configuredCoverage(): Coverage {
  return coverage({
    jurisdictions: DEFAULT_JURISDICTIONS,
    portals: DEFAULT_SOLICITATION_DATASETS,
  });
}
