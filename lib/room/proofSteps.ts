import type { ProofStepKind, SignalCategory } from '@prisma/client';
import type { SupplyPosture } from '@/lib/deal/provider';

/**
 * The smallest reversible thing we can honestly ask for next.
 *
 * The previous system had one answer to this — a seven-day trial — and applied
 * it to everything. It is the right ask for roughly one route in three, and on
 * the others it reads as a form letter, because it is one. A distribution buyer
 * asked for a seven-day trial of a case of gloves has been sent something
 * nobody thought about.
 *
 * Two rules decide what comes out of here:
 *
 *   The step must test the thing we are actually unsure about. If the material
 *   uncertainty is whether their spec matches what we can source, a site
 *   walkthrough tests nothing.
 *
 *   The step must be one we could actually deliver if they said yes today.
 *   Offering a pilot with no provider committed is a promise made on somebody
 *   else's behalf, and the answer when it is called in is that we cannot.
 *
 * `NONE` is a real and frequent answer. A room whose honest next step is "we
 * would like to ask you three questions" is better than one offering a pilot
 * that would have to be walked back.
 */

export type ProofStep = {
  kind: ProofStepKind;
  /** What the prospect is being asked for, in one line, in their language. */
  ask: string;
  /** What it costs them to say yes. Named plainly; this is the whole point. */
  commitment: string;
  /** What it settles. If this is empty the step is theatre. */
  tests: string;
};

export type ProofStepDecision = {
  step: ProofStep;
  /** Why this one and not the others. Shown to the owner, not the prospect. */
  reason: string;
  /** Steps ruled out because we could not currently deliver them. */
  withheld: Array<{ kind: ProofStepKind; because: string }>;
};

/**
 * The ladder, cheapest and most reversible first.
 *
 * Order matters: the recommendation walks this list and takes the first step
 * that both tests the open question and can actually be delivered, so a
 * cheaper step is always preferred to a more committing one that would also
 * have worked.
 */
export const LADDER: Record<Exclude<ProofStepKind, 'NONE'>, ProofStep> = {
  VENDOR_CAPABILITY_REVIEW: {
    kind: 'VENDOR_CAPABILITY_REVIEW',
    ask: 'Send us your vendor requirements so we can tell you whether we clear them.',
    commitment: 'An email. No commercial commitment of any kind.',
    tests: 'Whether we can be set up as a supplier at all, before either side spends time on price.',
  },
  SITE_WALKTHROUGH: {
    kind: 'SITE_WALKTHROUGH',
    ask: 'A walkthrough of one site so a price is based on the building rather than a guess.',
    commitment: 'An hour of somebody\'s time. No obligation to buy anything.',
    tests: 'The scope. A service price written without seeing the site is a number, not a quote.',
  },
  PRELIMINARY_QUOTE: {
    kind: 'PRELIMINARY_QUOTE',
    ask: 'A preliminary price against the scope as we currently understand it.',
    commitment: 'Nothing. It is a number to react to.',
    tests: 'Whether we are in the range they can work with, before anybody invests in detail.',
  },
  SAMPLE_ORDER: {
    kind: 'SAMPLE_ORDER',
    ask: 'A sample of the exact specification, so it can be checked against what you use now.',
    commitment: 'Accepting a sample. Nothing beyond it.',
    tests: 'Whether the specification actually matches — the thing most likely to be wrong.',
  },
  SMALL_INITIAL_SHIPMENT: {
    kind: 'SMALL_INITIAL_SHIPMENT',
    ask: 'One small order at the quoted price, before anything is agreed for the year.',
    commitment: 'One order, at a price fixed in advance.',
    tests: 'Delivery, paperwork and the receiving process, at a size where a problem is cheap.',
  },
  ONE_TIME_SERVICE: {
    kind: 'ONE_TIME_SERVICE',
    ask: 'One service visit, priced on its own, with no ongoing arrangement.',
    commitment: 'One job. No contract, no notice period.',
    tests: 'The work itself, which is the only thing a reference cannot settle.',
  },
  SINGLE_LOCATION_PILOT: {
    kind: 'SINGLE_LOCATION_PILOT',
    ask: 'One site, on the agreed scope, before it goes anywhere near the rest.',
    commitment: 'One location for an agreed period. Cancellable.',
    tests: 'Whether the service holds up week after week, which a single visit cannot show.',
  },
  LIMITED_SCOPE_SUBCONTRACT: {
    kind: 'LIMITED_SCOPE_SUBCONTRACT',
    ask: 'One defined package of the work, on your paper, before any wider commitment.',
    commitment: 'A single scope of work, priced and bounded.',
    tests: 'Whether we mobilise, document and finish the way your prime contract requires.',
  },
  PAID_DIAGNOSTIC: {
    kind: 'PAID_DIAGNOSTIC',
    ask: 'A paid assessment, credited against the work if you go ahead.',
    commitment: 'A fee, refundable against the job.',
    tests: 'A complicated situation properly, when a free look would be too shallow to be useful.',
  },
};

export const NO_STEP: ProofStep = {
  kind: 'NONE',
  ask: 'A short conversation to answer the questions above.',
  commitment: 'A phone call.',
  tests: 'What we do not yet know well enough to price or promise anything.',
};

/**
 * Which steps are inherently possible on this route.
 *
 * A sample is meaningless on a subcontract and a mobilisation package is
 * meaningless on a stationery order, and offering either is how a prospect
 * learns the sender did not read their own record.
 */
const BY_ROUTE: Record<string, ProofStepKind[]> = {
  DISTRIBUTION: ['VENDOR_CAPABILITY_REVIEW', 'SAMPLE_ORDER', 'PRELIMINARY_QUOTE', 'SMALL_INITIAL_SHIPMENT'],
  BROKERAGE: ['VENDOR_CAPABILITY_REVIEW', 'SITE_WALKTHROUGH', 'PRELIMINARY_QUOTE', 'ONE_TIME_SERVICE', 'SINGLE_LOCATION_PILOT', 'PAID_DIAGNOSTIC'],
  SUBCONTRACTING: ['VENDOR_CAPABILITY_REVIEW', 'PRELIMINARY_QUOTE', 'LIMITED_SCOPE_SUBCONTRACT'],
  GENERAL: ['VENDOR_CAPABILITY_REVIEW', 'PRELIMINARY_QUOTE'],
};

export type ProofStepInput = {
  route: SignalCategory | string;
  /** Where the supply side has got to. Decides what we can actually deliver. */
  supply: Pick<SupplyPosture, 'secured' | 'best' | 'liveCount'>;
  /** Whether a provider cost is on file and still valid. */
  costUsable: boolean;
  /** Whether the buyer requirement is complete enough to price. */
  requirementReady: boolean;
  /** Whether they have already told us the specification. */
  hasSpecification: boolean;
  /** Whether we know their vendor onboarding requirements. */
  vendorRequirementsKnown: boolean;
  /** Whether a price has already gone to them. */
  quoteAlreadySent: boolean;
};

/**
 * Steps that put work in front of a provider, and therefore cannot be offered
 * unless one has agreed to do it.
 *
 * The distinction is not fussiness. Every one of these, accepted, is a date in
 * somebody's calendar that we would have to fill.
 */
const NEEDS_A_COMMITTED_PROVIDER: ProofStepKind[] = [
  'SMALL_INITIAL_SHIPMENT',
  'ONE_TIME_SERVICE',
  'SINGLE_LOCATION_PILOT',
  'LIMITED_SCOPE_SUBCONTRACT',
  'PAID_DIAGNOSTIC',
];

/**
 * Steps that need a provider willing to turn up, but not yet contracted. A
 * walkthrough is somebody's afternoon, and it is still a real ask.
 */
const NEEDS_A_LIVE_PROVIDER: ProofStepKind[] = ['SITE_WALKTHROUGH', 'SAMPLE_ORDER'];

export function recommendProofStep(input: ProofStepInput): ProofStepDecision {
  const available = BY_ROUTE[input.route] ?? BY_ROUTE.GENERAL;
  const withheld: Array<{ kind: ProofStepKind; because: string }> = [];

  const deliverable = available.filter((kind) => {
    if (NEEDS_A_COMMITTED_PROVIDER.includes(kind) && !input.supply.secured) {
      withheld.push({
        kind,
        because: 'No provider has committed to this work, so accepting it would be a promise we cannot keep.',
      });
      return false;
    }
    if (NEEDS_A_LIVE_PROVIDER.includes(kind) && input.supply.liveCount === 0) {
      withheld.push({
        kind,
        because: 'There is no live provider candidate, so nobody would attend or ship.',
      });
      return false;
    }
    if (kind === 'PRELIMINARY_QUOTE' && !input.costUsable) {
      withheld.push({
        kind,
        because: 'No usable provider cost, so any price sent would be ours to guess at.',
      });
      return false;
    }
    return true;
  });

  // Walk the ladder in order, taking the first deliverable step that settles
  // the question actually in front of us.
  const wants = (kind: ProofStepKind) => deliverable.includes(kind);

  if (!input.vendorRequirementsKnown && wants('VENDOR_CAPABILITY_REVIEW')) {
    return {
      step: LADDER.VENDOR_CAPABILITY_REVIEW,
      reason: 'We do not know their vendor requirements. Nothing else is worth arranging until we know whether we can be set up at all.',
      withheld,
    };
  }

  if (!input.hasSpecification) {
    if (wants('SAMPLE_ORDER')) {
      return {
        step: LADDER.SAMPLE_ORDER,
        reason: 'The specification is not confirmed, and a sample settles that faster than another conversation about it.',
        withheld,
      };
    }
    if (wants('SITE_WALKTHROUGH')) {
      return {
        step: LADDER.SITE_WALKTHROUGH,
        reason: 'The scope is not confirmed. A service price written without seeing the site is a number rather than a quote.',
        withheld,
      };
    }
    return {
      step: NO_STEP,
      reason: 'We do not yet know what they need well enough to offer anything specific, and the honest next step is to ask.',
      withheld,
    };
  }

  if (!input.requirementReady) {
    return {
      step: NO_STEP,
      reason: 'The requirement is incomplete. Offering a step now would commit us against a scope that is partly our assumption.',
      withheld,
    };
  }

  if (!input.quoteAlreadySent && wants('PRELIMINARY_QUOTE')) {
    return {
      step: LADDER.PRELIMINARY_QUOTE,
      reason: 'Enough is known to price it, and a number is the cheapest thing for them to react to.',
      withheld,
    };
  }

  // They have a price. Now the smallest real commitment that tests delivery.
  for (const kind of ['SMALL_INITIAL_SHIPMENT', 'ONE_TIME_SERVICE', 'SINGLE_LOCATION_PILOT', 'LIMITED_SCOPE_SUBCONTRACT'] as const) {
    if (wants(kind)) {
      return {
        step: LADDER[kind],
        reason: 'They have a price and the supply side can stand behind it, so the next question is whether the delivery holds up.',
        withheld,
      };
    }
  }

  return {
    step: NO_STEP,
    reason: withheld.length > 0
      ? 'Every step that would fit is one we could not currently deliver. The room asks a question instead of making an offer.'
      : 'Nothing on the ladder fits this route at this stage.',
    withheld,
  };
}

/** Labels for the owner-facing UI, so no screen invents its own phrasing. */
export const PROOF_STEP_LABELS: Record<ProofStepKind, string> = {
  SAMPLE_ORDER: 'Sample order',
  SMALL_INITIAL_SHIPMENT: 'Small initial shipment',
  SINGLE_LOCATION_PILOT: 'Single-location pilot',
  ONE_TIME_SERVICE: 'One-time service',
  SITE_WALKTHROUGH: 'Site walkthrough',
  PRELIMINARY_QUOTE: 'Preliminary quote',
  LIMITED_SCOPE_SUBCONTRACT: 'Limited-scope subcontract',
  VENDOR_CAPABILITY_REVIEW: 'Vendor capability review',
  PAID_DIAGNOSTIC: 'Paid diagnostic',
  NONE: 'No offer — a question instead',
};
