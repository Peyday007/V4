import { prisma } from '@/lib/db';
import { MINI_PATHS, type MiniPath } from '@/lib/universe/registry';

/**
 * Starting from what a provider can actually do, and working towards who buys it.
 *
 * Everything else in this engine runs the other way: a public record says
 * something happened, a playbook reads a requirement into it, and a provider is
 * found afterwards. That works when a source publishes the trigger. It cannot
 * work at all for the paths where nothing is published — where the demand is
 * real, recurring and entirely invisible until somebody asks.
 *
 * So this runs backwards, and the discipline that makes it honest is the whole
 * design:
 *
 *   It starts from *verified* capacity only. A directory listing saying a
 *   company does janitorial work is that company's claim about itself, filtered
 *   through somebody who did not check. Reverse search from an unverified claim
 *   would generate a week of calling built on a hunch about a hunch, so a
 *   provider whose capacity nobody has established produces one output: go and
 *   establish it.
 *
 *   It never produces a buyer. There is no event, no trigger, and nobody has
 *   said they need anything, so an opportunity here would be fabricated demand
 *   with a company name attached — the exact failure this product exists to
 *   avoid. What it produces is research work: named buyer types, in a named
 *   place, with the specific questions that would turn a hypothesis into a
 *   requirement somebody stated.
 *
 *   It says what would make it wrong. Every brief carries the reason it might
 *   be a waste of a morning, because a market-development thesis with no
 *   falsifier is a belief rather than a plan.
 *
 * The result is deliberately less exciting than a queue of opportunities. It is
 * a queue of *questions*, and the answers to those questions are what the
 * demand-first engine cannot reach.
 */

// ---------------------------------------------------------------------------
// What we actually know about a provider
// ---------------------------------------------------------------------------

export type SupplyPosition = {
  companyId: string;
  name: string;
  location: string | null;
  stateCode: string | null;
  /** Capabilities a person established, never a directory's say-so. */
  verifiedCapabilities: Array<{ name: string; verifiedAt: Date; how: string }>;
  /** Capabilities the company claims and nobody has checked. */
  claimedCapabilities: string[];
  /** Stated spare capacity, where somebody has recorded and verified one. */
  capacity: Array<{ what: string; verifiedAt: Date | null; detail: string }>;
  territories: string[];
};

export async function supplyPosition(params: {
  orgId: string;
  companyId: string;
}): Promise<SupplyPosition | null> {
  const company = await prisma.company.findFirst({
    where: { id: params.companyId, orgId: params.orgId },
    select: {
      id: true,
      legalName: true,
      cityName: true,
      stateCode: true,
      capabilities: {
        select: {
          status: true,
          verifiedAt: true,
          notes: true,
          capability: { select: { name: true } },
        },
      },
      supplyOffers: {
        select: {
          description: true,
          quantity: true,
          unit: true,
          location: true,
          availableFrom: true,
          availableTo: true,
          verifiedAt: true,
          status: true,
        },
      },
      subCapacity: {
        select: {
          capabilities: true,
          territories: true,
          crewCount: true,
          earliestStart: true,
          verifiedAt: true,
          status: true,
        },
      },
    },
  });
  if (!company) return null;

  const verified = company.capabilities
    .filter((c) => c.verifiedAt !== null && c.status === 'CONFIRMED')
    .map((c) => ({
      name: c.capability.name,
      verifiedAt: c.verifiedAt as Date,
      how: c.notes ?? 'Confirmed against this account, though how was not recorded.',
    }));

  const claimed = company.capabilities
    .filter((c) => c.verifiedAt === null || c.status !== 'CONFIRMED')
    .map((c) => c.capability.name);

  const capacity: SupplyPosition['capacity'] = [
    ...company.supplyOffers.map((s) => ({
      what: s.description,
      verifiedAt: s.verifiedAt,
      detail: [
        s.quantity !== null ? `${Number(s.quantity).toLocaleString()}${s.unit ? ` ${s.unit}` : ''}` : null,
        s.location,
        s.availableFrom ? `from ${s.availableFrom.toISOString().slice(0, 10)}` : null,
        s.availableTo ? `until ${s.availableTo.toISOString().slice(0, 10)}` : null,
      ].filter(Boolean).join(' · '),
    })),
    ...company.subCapacity.map((s) => ({
      what: s.capabilities.join(', ') || 'Crew capacity',
      verifiedAt: s.verifiedAt,
      detail: [
        s.crewCount !== null ? `${s.crewCount} crew` : null,
        s.territories.length > 0 ? s.territories.join(', ') : null,
        s.earliestStart ? `available from ${s.earliestStart.toISOString().slice(0, 10)}` : null,
      ].filter(Boolean).join(' · '),
    })),
  ];

  return {
    companyId: company.id,
    name: company.legalName,
    location: [company.cityName, company.stateCode].filter(Boolean).join(', ') || null,
    stateCode: company.stateCode,
    verifiedCapabilities: verified,
    claimedCapabilities: claimed,
    capacity,
    territories: company.subCapacity.flatMap((s) => s.territories),
  };
}

// ---------------------------------------------------------------------------
// From capacity to questions
// ---------------------------------------------------------------------------

/**
 * A piece of demand-development work, generated from real capacity.
 *
 * Not an opportunity. Nobody has said they need anything, and the brief says so
 * in its own words rather than in a badge somebody might not read.
 */
export type DemandDevelopmentBrief = {
  miniPathKey: string;
  label: string;
  /** Why this provider fits this path, from what was actually verified. */
  becauseThisProvider: string;
  /** Who buys this. Types, never named companies — nobody has been checked. */
  buyerTypes: string[];
  /** Where to look, from the provider's own geography. */
  geography: string;
  /** What has to be established before this is a requirement rather than a guess. */
  toEstablish: string[];
  /** What would show this is not worth pursuing. Stated up front. */
  wouldFalsifyIt: string;
  /** Why an intermediary is worth anything here at all. */
  intermediaryAdvantage: string;
};

/**
 * Whether a provider's verified capability plausibly serves a path.
 *
 * Text matching, and deliberately conservative: a miss costs a brief that
 * nobody writes, and a false match costs a morning of calling on a thesis with
 * nothing behind it. Matching is done against the path's own words rather than
 * against a taxonomy, because the catalogue's capability names come from the
 * outside world and do not follow one.
 */
function servesPath(capability: string, path: MiniPath): boolean {
  const words = capability.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  if (words.length === 0) return false;
  const haystack = [
    path.label,
    path.subvertical,
    path.vertical,
    ...path.providerTypes,
  ].join(' ').toLowerCase();
  return words.some((word) => haystack.includes(word));
}

/**
 * The questions that turn a supply position into a stated requirement.
 *
 * Written as things to ask a person, not as fields to fill in. A research task
 * saying "establish demand" is not a task; one saying "ring three importers in
 * this metro and ask what they do when a container lands early" is.
 */
function questionsFor(path: MiniPath, place: string): string[] {
  return [
    `Ring ${path.buyerTypes.slice(0, 2).join(' and ').toLowerCase()} in ${place} and ask what they currently do `
    + `when ${lowerFirst(path.whatCreatesDemand)}`,
    'Ask who they use now, what it costs them, and what they dislike about it. An incumbent nobody complains '
    + 'about is a closed door and knowing that early is worth the call.',
    'Ask how often it happens. A problem that arises twice a year is not an account.',
    `Establish whether they would buy this from somebody who is not the provider — that is the whole question `
    + `for an intermediary, and ${lowerFirst(path.intermediaryAdvantage)}`,
  ];
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Demand-development work from what a provider can actually do.
 *
 * Returns an empty list rather than a speculative one when nothing has been
 * verified. Silence would be wrong — see `reverseSearch`, which turns that case
 * into the one piece of work that does make sense.
 */
export function briefsFor(position: SupplyPosition): DemandDevelopmentBrief[] {
  if (position.verifiedCapabilities.length === 0) return [];

  const place = position.location ?? 'their own area';
  const briefs: DemandDevelopmentBrief[] = [];

  for (const path of MINI_PATHS) {
    // Market development is a lane a path either supports or does not. A path
    // that only works off a published trigger cannot be entered from the supply
    // side, and pretending otherwise is how a taxonomy becomes a promise.
    if (!path.lanes.includes('MARKET_DEVELOPMENT')) continue;

    const matched = position.verifiedCapabilities.filter((c) => servesPath(c.name, path));
    if (matched.length === 0) continue;

    const capacityLine = position.capacity.find((c) => c.verifiedAt !== null);

    briefs.push({
      miniPathKey: path.key,
      label: path.label,
      becauseThisProvider:
        `${position.name} has verified ${matched.map((m) => m.name.toLowerCase()).join(' and ')}`
        + `${capacityLine ? `, and ${lowerFirst(capacityLine.what)} was checked on `
          + `${capacityLine.verifiedAt!.toISOString().slice(0, 10)}` : ''}. `
        + 'That is a supply side that exists. Nobody has said they want it.',
      buyerTypes: path.buyerTypes,
      geography: place,
      toEstablish: questionsFor(path, place),
      wouldFalsifyIt:
        'Three conversations in which the buyer already has this handled, at a price we could not beat, with '
        + 'somebody they are happy with. That is not a slow start — it is an answer, and it should close this '
        + 'thesis rather than justify a fourth call.',
      intermediaryAdvantage: path.intermediaryAdvantage,
    });
  }

  return briefs;
}

export type ReverseSearchResult =
  | {
      usable: true;
      position: SupplyPosition;
      briefs: DemandDevelopmentBrief[];
      /** What this is and is not, in the words the screen shows. */
      standing: string;
    }
  | {
      usable: false;
      position: SupplyPosition | null;
      /** Why nothing can be generated, and the one thing that would change it. */
      because: string;
      toUnblock: string;
    };

/**
 * Reverse search, with the refusals it needs to be worth anything.
 *
 * The refusals matter more than the results. A provider nobody has verified,
 * or one whose capability serves no path this engine can enter from the supply
 * side, produces a clear "no, and here is why" rather than a thin list — a
 * market-development queue that fills up regardless of input is a queue that
 * teaches its reader to ignore it.
 */
export async function reverseSearch(params: {
  orgId: string;
  companyId: string;
}): Promise<ReverseSearchResult> {
  const position = await supplyPosition(params);
  if (!position) {
    return {
      usable: false,
      position: null,
      because: 'That company is not on this account.',
      toUnblock: 'Check the identifier, or add the provider first.',
    };
  }

  if (position.verifiedCapabilities.length === 0) {
    return {
      usable: false,
      position,
      because:
        position.claimedCapabilities.length > 0
          ? `${position.name} claims ${position.claimedCapabilities.slice(0, 3).join(', ')}, and nobody has `
            + 'checked any of it. A directory entry is the company describing itself; building a week of '
            + 'calling on it would be a hypothesis resting on a hypothesis.'
          : `Nothing is recorded about what ${position.name} can actually do.`,
      toUnblock:
        `Ring ${position.name}, establish one capability and what spare capacity they have this month, and `
        + 'record it against them. One verified capability is enough to start.',
    };
  }

  const briefs = briefsFor(position);
  if (briefs.length === 0) {
    return {
      usable: false,
      position,
      because:
        `${position.name}'s verified capabilities do not match any commercial path this engine can enter from `
        + 'the supply side. Some paths only work off a published trigger, and no amount of provider capacity '
        + 'creates one.',
      toUnblock:
        'Either verify a capability that does match a supply-side path, or work this provider from the demand '
        + 'side when a trigger appears.',
    };
  }

  return {
    usable: true,
    position,
    briefs,
    standing:
      'These are questions, not opportunities. Nothing here is demand: no event has happened, nobody has asked '
      + 'for anything, and the buyer types are categories rather than companies. What makes them worth a '
      + 'morning is that the supply side is real and verified, which is the half of a deal that usually takes '
      + 'longest to find.',
  };
}
