import type { ProofStepKind, SignalCategory } from '@prisma/client';
import { prisma } from '@/lib/db';
import { supplyPosture, costIsUsable } from '@/lib/deal/provider';
import { priceability } from '@/lib/deal/requirement';
import { recommendProofStep, type ProofStep, type ProofStepDecision } from './proofSteps';

/**
 * What a Deal Room actually says.
 *
 * One function builds this, and the admin preview and the public page both
 * render its output through the same component. That is not a tidiness
 * preference — it is the only way "what the prospect sees" is knowable. Two
 * renderers drift within a week, and the one nobody looks at is the one the
 * customer gets.
 *
 * The standard every line here is written to: the page has to be worth reading
 * with all the buttons removed. So there is no urgency that we invented, no
 * savings figure we cannot substantiate, no "audit" we did not perform, and no
 * pain-agitation paragraph. What there is instead is the dated thing that
 * happened, what we know about it, what we are guessing, and what we would need
 * to ask — which is genuinely useful to a facilities manager and impossible to
 * write without having done the work.
 *
 * Every claim carries where it came from. A prospect who can see that we read
 * their permit filing and did not read their mind is a prospect who can trust
 * the rest of the page.
 */

export type RoomFact = {
  label: string;
  value: string;
  /** Where it came from, in words a prospect can check. */
  source: string;
};

export type RoomSection = {
  heading: string;
  /** Things a named source stated. Never our conclusions. */
  facts: RoomFact[];
  /** Our reading of them, labelled as ours wherever it appears. */
  ours: string[];
  /** What we do not know, said plainly rather than papered over. */
  questions: string[];
};

export type RoomContent = {
  organisation: string;
  location: string | null;
  route: string;
  /** One line, factual, no adjectives we cannot defend. */
  headline: string;
  /**
   * Why they are hearing from us, grounded in a dated event. If this cannot be
   * written from a real record, the room should not be sent.
   */
  why: { text: string; eventDate: string | null; source: string; sourceUrl: string | null } | null;
  sections: RoomSection[];
  /** The price, only when one has actually gone to them. */
  price: { version: number; amount: string; terms: string | null; validUntil: string | null } | null;
  proofStep: ProofStep;
  /** Owner-facing. Never rendered on the public page. */
  proofStepReason: string;
  withheldSteps: Array<{ kind: ProofStepKind; because: string }>;
  /** True when there is not enough real material to send anything. */
  tooThinToSend: boolean;
  thinReasons: string[];
  builtAt: string;
};

export async function buildRoomContent(params: {
  orgId: string;
  routeId: string;
}): Promise<RoomContent | null> {
  const route = await prisma.routeHypothesis.findFirst({
    where: { id: params.routeId, orgId: params.orgId },
    include: {
      company: { select: { legalName: true, cityName: true, stateCode: true } },
      event: {
        select: {
          headline: true, summary: true, eventDate: true, connector: true, sourceUrl: true,
          confirmedFacts: true, cityName: true, stateCode: true, type: true,
        },
      },
    },
  });
  if (!route) return null;

  const [requirement, candidates, quote] = await Promise.all([
    prisma.buyerRequirement.findFirst({ where: { routeId: route.id, state: 'CURRENT' } }),
    prisma.providerCandidate.findMany({ where: { routeId: route.id } }),
    prisma.routeQuote.findFirst({
      where: { routeId: route.id, state: { in: ['SENT', 'ACCEPTED'] } },
      orderBy: { version: 'desc' },
    }),
  ]);

  const posture = supplyPosture(candidates);
  const selected = candidates.find((c) => c.state === 'SELECTED' || c.state === 'COMMITTED') ?? null;
  const ready = priceability(requirement);

  const decision: ProofStepDecision = recommendProofStep({
    route: route.route,
    supply: posture,
    costUsable: selected !== null && costIsUsable(selected),
    requirementReady: ready.ready,
    hasSpecification: Boolean(requirement?.specification),
    vendorRequirementsKnown: (requirement?.constraints ?? []).length > 0,
    quoteAlreadySent: quote !== null,
  });

  const confirmedFacts = Array.isArray(route.event.confirmedFacts)
    ? (route.event.confirmedFacts as unknown[]).filter((f): f is string => typeof f === 'string')
    : [];

  const why = route.event.eventDate
    ? {
        text: route.event.headline,
        eventDate: route.event.eventDate.toISOString().slice(0, 10),
        source: connectorLabel(route.event.connector),
        sourceUrl: route.event.sourceUrl,
      }
    : null;

  const sections = buildSections({
    route: route.route,
    eventSummary: route.event.summary,
    confirmedFacts,
    requirement,
    posture,
    questions: ready.missing,
  });

  // A room with nothing dated behind it and nothing the buyer told us is a
  // page about a company we know nothing about. Better to say so here than to
  // let somebody discover it after it has been sent.
  const thinReasons: string[] = [];
  if (!why) thinReasons.push('The demand event has no date on it, so there is nothing specific to open with.');
  if (!requirement && confirmedFacts.length === 0) {
    thinReasons.push('Nothing has been confirmed by the source or by the buyer. The page would be entirely our inference.');
  }

  return {
    organisation: route.company.legalName,
    location: [route.company.cityName, route.company.stateCode].filter(Boolean).join(', ') || null,
    route: route.route,
    headline: route.headline,
    why,
    sections,
    price: quote && quote.buyerPrice !== null
      ? {
          version: quote.version,
          amount: `$${Number(quote.buyerPrice).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          terms: quote.paymentTerms,
          validUntil: quote.validUntil ? quote.validUntil.toISOString().slice(0, 10) : null,
        }
      : null,
    proofStep: decision.step,
    proofStepReason: decision.reason,
    withheldSteps: decision.withheld,
    tooThinToSend: thinReasons.length > 0,
    thinReasons,
    builtAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route-aware sections
// ---------------------------------------------------------------------------

function buildSections(input: {
  route: SignalCategory | string;
  eventSummary: string;
  confirmedFacts: string[];
  requirement: {
    specification: string | null; quantity: string | null; frequency: string | null;
    locations: string | null; locationCount: number | null; timingNote: string | null;
    incumbent: string | null; constraints: string[]; confirmedFields: string[];
    summary: string;
  } | null;
  posture: { secured: boolean; headline: string; liveCount: number };
  questions: string[];
}): RoomSection[] {
  const { requirement } = input;

  /** A requirement field, but only where the buyer actually said it. */
  const stated = (field: string, label: string, value: string | null | undefined): RoomFact | null => {
    if (!value) return null;
    if (!requirement?.confirmedFields.includes(field)) return null;
    return { label, value, source: 'You told us this on the phone.' };
  };

  /** The same field when it is our reading rather than theirs. */
  const inferred = (field: string, label: string, value: string | null | undefined): string | null => {
    if (!value) return null;
    if (requirement?.confirmedFields.includes(field)) return null;
    return `${label}: ${value} — our assumption, not something you told us.`;
  };

  const sections: RoomSection[] = [];

  // Section one is the same on every route: the dated thing that happened.
  sections.push({
    heading: 'What we saw',
    facts: input.confirmedFacts.slice(0, 6).map((fact) => ({
      label: 'Stated in the record',
      value: fact,
      source: 'The public filing itself, quoted rather than summarised.',
    })),
    ours: [input.eventSummary].filter(Boolean),
    questions: [],
  });

  if (input.route === 'DISTRIBUTION') {
    sections.push({
      heading: 'What you buy, as we understand it',
      facts: [
        stated('specification', 'Specification', requirement?.specification),
        stated('quantity', 'Quantity', requirement?.quantity),
        stated('frequency', 'Reorder cycle', requirement?.frequency),
        stated('locations', 'Delivery to', requirement?.locations),
        stated('incumbent', 'Currently supplied by', requirement?.incumbent),
      ].filter((f): f is RoomFact => f !== null),
      ours: [
        inferred('specification', 'Likely category', requirement?.specification),
        inferred('quantity', 'Likely volume', requirement?.quantity),
        inferred('incumbent', 'Possible incumbent', requirement?.incumbent),
      ].filter((s): s is string => s !== null),
      questions: [
        !requirement?.specification ? 'What exactly is the specification, and is substitution allowed?' : null,
        !requirement?.quantity ? 'What quantity, and how often?' : null,
        !requirement?.timingNote ? 'When do you next need to order?' : null,
        'Where does delivery go, and is there a receiving window we should work to?',
      ].filter((q): q is string => q !== null),
    });
  } else if (input.route === 'BROKERAGE') {
    sections.push({
      heading: 'The scope, as we understand it',
      facts: [
        stated('specification', 'Scope', requirement?.specification),
        stated('locations', 'Sites', requirement?.locations),
        stated('frequency', 'Frequency', requirement?.frequency),
        stated('timingNote', 'Timing', requirement?.timingNote),
        stated('incumbent', 'Current provider', requirement?.incumbent),
      ].filter((f): f is RoomFact => f !== null),
      ours: [
        inferred('specification', 'Likely scope', requirement?.specification),
        inferred('frequency', 'Likely frequency', requirement?.frequency),
        inferred('incumbent', 'Possible incumbent', requirement?.incumbent),
      ].filter((s): s is string => s !== null),
      questions: [
        !requirement?.specification ? 'What is actually in scope, and what is explicitly out?' : null,
        !requirement?.locations ? 'How many sites, and where?' : null,
        (requirement?.constraints ?? []).length === 0
          ? 'What insurance, bonding or vendor onboarding do we need to clear to work with you?'
          : null,
        'When does the current arrangement end, or when is the decision made?',
      ].filter((q): q is string => q !== null),
    });
  } else if (input.route === 'SUBCONTRACTING') {
    sections.push({
      heading: 'The work, as we understand it',
      facts: [
        stated('specification', 'Capability needed', requirement?.specification),
        stated('locations', 'Where the work is', requirement?.locations),
        stated('timingNote', 'Mobilisation', requirement?.timingNote),
      ].filter((f): f is RoomFact => f !== null),
      ours: [
        inferred('specification', 'Likely capability gap', requirement?.specification),
        inferred('locations', 'Likely geography', requirement?.locations),
      ].filter((s): s is string => s !== null),
      questions: [
        (requirement?.constraints ?? []).length === 0
          ? 'What credentials do you require — insurance limits, licences, bonding, safety record?'
          : null,
        !requirement?.timingNote ? 'What is the mobilisation window?' : null,
        'How is scope priced on this project — unit rates, lump sum, or time and materials?',
        'Who runs subcontractor onboarding, and what does it involve?',
      ].filter((q): q is string => q !== null),
    });
  }

  // The supply side, stated exactly as carefully to the prospect as to the
  // owner. A prospect told "we have a provider lined up" who later discovers
  // there was a directory listing has learned something about us that no
  // later accuracy repairs.
  sections.push({
    heading: 'Who would do the work',
    facts: input.posture.secured
      ? [{
          label: 'Provider',
          value: 'A provider has committed to this work.',
          source: 'Their own written confirmation, held on file.',
        }]
      : [],
    ours: input.posture.secured
      ? []
      : [input.posture.liveCount > 0
          ? 'We have candidates who can do this and none of them has committed to it yet. We will not tell you fulfilment is arranged until it is.'
          : 'We do not currently have a provider for this. We would rather say so than find one after you have said yes.'],
    questions: [],
  });

  if (requirement && input.questions.length > 0) {
    sections.push({
      heading: 'What we would need to know before quoting',
      facts: [],
      ours: [],
      questions: input.questions,
    });
  }

  return sections;
}

/**
 * The connector, named the way a prospect would recognise it.
 *
 * They should be able to go and look at the same record. An internal key in a
 * customer-facing page is a claim they cannot check.
 */
function connectorLabel(connector: string): string {
  const labels: Record<string, string> = {
    municipal_open_data: 'a municipal open-data record',
    municipal_solicitations: 'a published solicitation',
    contract_awards: 'a published contract award',
    google_places: 'a public business listing',
    audit_fixture: 'an internal test record',
  };
  return labels[connector] ?? 'a public record';
}
