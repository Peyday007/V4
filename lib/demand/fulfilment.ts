import { prisma } from '@/lib/db';
import { matchCapability } from '@/lib/discovery/capabilityMatch';

/**
 * Can we actually deliver this?
 *
 * The previous answer was a count of companies holding a matching capability
 * name, which conflates six different questions. A provider three states away
 * with no insurance on file and no stated capacity is not the same answer as
 * one twenty minutes down the road who has done this work before.
 *
 * Six checks, each reported separately so a gap names itself:
 *
 *   capability   — do they do this kind of work
 *   geography    — can they reach the site
 *   capacity     — do they have crews free
 *   credentials  — insurance, licence, bonding
 *   pricing      — do we know what they charge
 *   timing       — can they start inside the buying window
 *
 * A missing provider never rejects the demand. It produces a sourcing task and
 * blocks serious pursuit, and the demand is kept until its own window closes —
 * rejecting it instead would mean the supply network can never grow toward the
 * work that exists.
 */

export type ProviderCandidate = {
  id: string;
  name: string;
  stateCode: string | null;
  cityName: string | null;
  capabilities: string[];
  serviceTerritories: string[];
  hasInsurance: boolean;
  hasLicences: boolean;
  /** Whether we hold any pricing for them at all. */
  hasPricing: boolean;
  /** Stated crew capacity, where we hold it. */
  statedCapacity: number | null;
  lastVerifiedAt: Date | null;
};

export type FulfilmentCheck = {
  name: string;
  /** Null when the input is genuinely unknown rather than failing. */
  passed: boolean | null;
  detail: string;
};

export type FulfilmentAssessment = {
  status: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE' | 'UNKNOWN';
  reason: string;
  checks: FulfilmentCheck[];
  /** Providers that cleared capability and geography, best first. */
  matched: ProviderCandidate[];
  /**
   * Providers we have actually checked recently — insurance on file and a
   * verification inside the freshness horizon.
   *
   * Kept apart from `matched` because they answer different questions. A
   * candidate found in a directory is a lead on the supply side; a provider we
   * have verified is someone we can commit to a buyer. Telling a caller the
   * first is the second is how a promise gets made that cannot be kept.
   */
  verified: ProviderCandidate[];
  /** What to go and do when nobody clears. */
  sourcingTask: string | null;
  /** Blocks promotion to serious pursuit. */
  blocksPursuit: boolean;
};

/**
 * How stale a verification can be before capacity is unknown again.
 *
 * Crew availability is the fastest-decaying fact in this business: a provider
 * who had two crews free last quarter has no relevance to next week.
 */
const CAPACITY_FRESH_DAYS = 45;

export async function loadProviders(orgId: string): Promise<ProviderCandidate[]> {
  const rows = await prisma.company.findMany({
    where: { orgId, companyRole: { in: ['SUBCONTRACTOR', 'SUPPLIER', 'DISTRIBUTOR', 'MANUFACTURER', 'CARRIER'] } },
    select: {
      id: true,
      legalName: true,
      stateCode: true,
      cityName: true,
      serviceTerritories: true,
      insurance: true,
      licenses: true,
      certifications: true,
      lastVerifiedAt: true,
      fulfillmentCapacity: true,
      capabilities: { select: { capability: { select: { name: true } } } },
      products: { select: { id: true }, take: 1 },
      locations: { select: { state: true, city: true }, take: 1 },
    },
  });

  return rows.map((row) => {
    const insurance = (row.insurance ?? {}) as Record<string, unknown>;
    const licences = Array.isArray(row.licenses) ? row.licenses : [];
    const capacity = (row.fulfillmentCapacity ?? {}) as Record<string, unknown>;
    const crews = typeof capacity.crews === 'number' ? capacity.crews : null;

    return {
      id: row.id,
      name: row.legalName,
      stateCode: row.stateCode ?? row.locations[0]?.state ?? null,
      cityName: row.cityName ?? row.locations[0]?.city ?? null,
      capabilities: row.capabilities.map((c) => c.capability.name),
      serviceTerritories: row.serviceTerritories,
      hasInsurance: Object.keys(insurance).length > 0,
      hasLicences: licences.length > 0 || row.certifications.length > 0,
      hasPricing: row.products.length > 0,
      statedCapacity: crews,
      lastVerifiedAt: row.lastVerifiedAt,
    };
  });
}

export function assessFulfilment(input: {
  requiredCapability: string;
  stateCode: string | null;
  cityName: string | null;
  /** When the work would need to start. Null when the window is unknown. */
  neededBy: Date | null;
  providers: ProviderCandidate[];
  now?: Date;
}): FulfilmentAssessment {
  const now = input.now ?? new Date();
  const checks: FulfilmentCheck[] = [];

  if (input.providers.length === 0) {
    return {
      status: 'UNKNOWN',
      reason:
        'The provider network is empty, so fulfilment cannot be assessed at all. This is one setup problem, not ' +
        'a verdict on this opportunity.',
      checks: [{ name: 'network', passed: null, detail: 'No providers on file.' }],
      matched: [],
      verified: [],
      sourcingTask: `Recruit at least one provider for ${input.requiredCapability.toLowerCase()} before working demand in this trade.`,
      blocksPursuit: true,
    };
  }

  // --- capability -------------------------------------------------------
  const capable = input.providers.filter(
    (p) => matchCapability(input.requiredCapability, p.capabilities).capability !== null,
  );
  checks.push({
    name: 'capability',
    passed: capable.length > 0,
    detail:
      capable.length > 0
        ? `${capable.length} provider(s) hold ${input.requiredCapability.toLowerCase()}.`
        : `Nobody on file holds ${input.requiredCapability.toLowerCase()}.`,
  });

  if (capable.length === 0) {
    return {
      status: 'UNAVAILABLE',
      reason: `No provider holds ${input.requiredCapability.toLowerCase()}. The demand stands; the supply does not exist yet.`,
      checks,
      matched: [],
      verified: [],
      sourcingTask: `Find a provider for ${input.requiredCapability.toLowerCase()}${input.stateCode ? ` in ${input.stateCode}` : ''}.`,
      blocksPursuit: true,
    };
  }

  // --- geography --------------------------------------------------------
  //
  // Same state, or an explicitly stated territory. A crew that has to travel
  // three states is not local coverage whatever their capability list says.
  const local = input.stateCode
    ? capable.filter(
        (p) =>
          p.stateCode?.toUpperCase() === input.stateCode!.toUpperCase() ||
          p.serviceTerritories.some((territory) => territory.toUpperCase().includes(input.stateCode!.toUpperCase())),
      )
    : capable;

  checks.push({
    name: 'geography',
    passed: input.stateCode ? local.length > 0 : null,
    detail: !input.stateCode
      ? 'The event has no state, so reach cannot be checked.'
      : local.length > 0
        ? `${local.length} of them cover ${input.stateCode}.`
        : `None of them cover ${input.stateCode}.`,
  });

  if (input.stateCode && local.length === 0) {
    return {
      status: 'UNAVAILABLE',
      reason: `Providers exist for this trade but none covers ${input.stateCode}.`,
      checks,
      matched: [],
      verified: [],
      sourcingTask: `Recruit a ${input.requiredCapability.toLowerCase()} provider covering ${input.stateCode}.`,
      blocksPursuit: true,
    };
  }

  // --- credentials ------------------------------------------------------
  const credentialed = local.filter((p) => p.hasInsurance);
  checks.push({
    name: 'credentials',
    passed: credentialed.length > 0 ? true : local.some((p) => p.hasInsurance || p.hasLicences) ? null : false,
    detail:
      credentialed.length > 0
        ? `${credentialed.length} carry insurance on file.`
        : 'None has insurance on file. Commercial premises will ask for a certificate before anyone sets foot on site.',
  });

  // --- capacity ---------------------------------------------------------
  //
  // Stale is unknown, not free. Crew availability is the fastest-decaying fact
  // in this business.
  const withFreshCapacity = local.filter(
    (p) =>
      p.statedCapacity !== null &&
      p.lastVerifiedAt !== null &&
      now.getTime() - p.lastVerifiedAt.getTime() < CAPACITY_FRESH_DAYS * 86_400_000,
  );
  checks.push({
    name: 'capacity',
    passed: withFreshCapacity.length > 0 ? true : null,
    detail:
      withFreshCapacity.length > 0
        ? `${withFreshCapacity.length} confirmed crew capacity within the last ${CAPACITY_FRESH_DAYS} days.`
        : 'Nobody has confirmed capacity recently. Availability is unknown, which is not the same as free.',
  });

  // --- pricing ----------------------------------------------------------
  const priced = local.filter((p) => p.hasPricing);
  checks.push({
    name: 'pricing',
    passed: priced.length > 0 ? true : null,
    detail:
      priced.length > 0
        ? `${priced.length} have pricing on file.`
        : 'No pricing on file, so any margin figure is a playbook prior rather than a calculation.',
  });

  // --- timing -----------------------------------------------------------
  const timingOk = input.neededBy ? input.neededBy.getTime() > now.getTime() : null;
  checks.push({
    name: 'timing',
    passed: timingOk,
    detail: !input.neededBy
      ? 'No start date, so lead time cannot be checked.'
      : timingOk
        ? `Work is needed by ${input.neededBy.toISOString().slice(0, 10)}, which is still ahead.`
        : `Work was needed by ${input.neededBy.toISOString().slice(0, 10)}, which has passed.`,
  });

  const matched = [...local].sort((a, b) => score(b) - score(a));

  // Verified means somebody checked, recently. Insurance on file plus a
  // verification inside the freshness horizon is the least that can honestly
  // be called "we can deliver this"; anything short of it is a candidate.
  const verified = matched.filter(
    (p) =>
      p.hasInsurance &&
      p.lastVerifiedAt !== null &&
      now.getTime() - p.lastVerifiedAt.getTime() < CAPACITY_FRESH_DAYS * 86_400_000,
  );

  const failed = checks.filter((c) => c.passed === false);
  const unknown = checks.filter((c) => c.passed === null);

  if (failed.length > 0) {
    return {
      status: 'PARTIAL',
      reason: `A provider exists but ${failed.map((c) => c.name).join(' and ')} did not clear. ${failed.map((c) => c.detail).join(' ')}`,
      checks,
      matched,
      verified,
      sourcingTask: failed.some((c) => c.name === 'credentials')
        ? `Collect a certificate of insurance from ${matched[0]?.name ?? 'a provider'} before quoting.`
        : null,
      // A credential gap is fixable with a phone call and does not stop the
      // conversation, unlike having nobody at all.
      blocksPursuit: false,
    };
  }

  // A candidate found is not a provider secured. AVAILABLE is reserved for the
  // case where somebody has actually been verified — otherwise the board would
  // tell a caller supply is in place on the strength of a directory entry.
  if (verified.length === 0) {
    return {
      status: 'PARTIAL',
      reason:
        `${matched.length} candidate provider(s) can do this work in ${input.stateCode ?? 'this area'}, but none has ` +
        'been verified. Treat them as leads on the supply side, not as capacity you can commit.',
      checks,
      matched,
      verified,
      sourcingTask: `Verify ${matched[0]?.name ?? 'a candidate provider'} — insurance and current capacity — before quoting this work.`,
      // A candidate we have not verified is still a route to delivery. It does
      // not stop the conversation, it changes what may be promised in it.
      blocksPursuit: false,
    };
  }

  return {
    status: unknown.length >= 3 ? 'PARTIAL' : 'AVAILABLE',
    reason:
      `${verified.length} verified provider(s) of ${matched.length} candidate(s) can do this work in ` +
      `${input.stateCode ?? 'this area'}. ` +
      (unknown.length > 0 ? `Still unknown: ${unknown.map((c) => c.name).join(', ')}.` : 'All checks cleared.'),
    checks,
    matched,
    verified,
    sourcingTask: null,
    blocksPursuit: false,
  };
}

/** Ranks a provider by how much we actually know about them. */
function score(p: ProviderCandidate): number {
  return (
    (p.hasInsurance ? 3 : 0) +
    (p.hasPricing ? 2 : 0) +
    (p.statedCapacity !== null ? 2 : 0) +
    (p.hasLicences ? 1 : 0) +
    (p.lastVerifiedAt ? 1 : 0)
  );
}
