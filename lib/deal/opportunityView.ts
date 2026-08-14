import type { DealPlan } from './plan';
import type { DealRecord } from './record';
import { standingOf, moneyPath } from './standing';
import { buyerPriceOf, providerCostOf, grossProfitOf, presentMoney } from '@/lib/evidence/economics';
import { gradeProviderClaim, gradeRequirementField, presentText } from '@/lib/evidence/claims';
import { confirmed, unknown, present, type Evidenced } from '@/lib/evidence/class';
import type { StandingProps } from '@/components/OpportunityStanding';

/**
 * Everything the opportunity page shows, graded before it gets there.
 *
 * Assembled on the server so the rule cannot be forgotten at a render site.
 * The component receives values that have already been through the evidence
 * test and knows only how to lay them out — which means a new panel added
 * later cannot accidentally print a raw number, because there are no raw
 * numbers in what it is handed.
 */
export function buildOpportunityView(input: {
  organisation: string;
  plan: DealPlan;
  record: DealRecord;
  /** Closed deals of this kind, for judging whether a probability means anything. */
  closedComparables: number;
}): StandingProps {
  const { plan, record } = input;

  const standing = standingOf(plan, { organisation: input.organisation });

  // --- money -------------------------------------------------------------
  const quote = record.quotes.live;
  const money = quote
    ? {
        basis: quote.basis,
        buyerPrice: quote.buyerPrice === null ? null : Number(quote.buyerPrice),
        providerCost: quote.providerCost === null ? null : Number(quote.providerCost),
        costSideMissing: quote.costSideMissing,
      }
    : { basis: 'PRIOR' as const, buyerPrice: null, providerCost: null, costSideMissing: true };

  const collected = collectedOf(record);

  const path = moneyPath({
    buyerPrice: buyerPriceOf(money),
    providerCost: providerCostOf(money),
    grossProfit: grossProfitOf(money),
    collected,
  });

  // --- the buyer track ----------------------------------------------------
  const requirement = record.requirement.current;
  // The record already separates what the buyer stated from what we read.
  const confirmedFields = record.requirement.confirmed;

  const buyerTrack = [
    row('Who they are', confirmed(input.organisation, 'From the source record that named them.')),
    row(
      'Reachable',
      plan.stages.find((s) => s.key === 'RESOLVED_CONTACT')?.state === 'DONE'
        ? confirmed('Yes', 'A published number or address is on the record.')
        : unknown<string>(
            'No contact route has been established.',
            'Find a published number, or ask the enrichment path to resolve one.',
          ),
    ),
    row(
      'Requirement',
      requirement
        ? gradeRequirementField({
            field: 'specification',
            value: requirement.specification ?? null,
            confirmedFields,
            derivedFrom: 'the source event',
          })
        : unknown<string>('No requirement has been captured.', 'Ask what they actually need on the next call.'),
    ),
    row(
      'Quantity',
      requirement
        ? gradeRequirementField({
            field: 'quantity',
            value: requirement.quantity === null ? null : Number(requirement.quantity),
            confirmedFields,
            derivedFrom: 'a scale figure the source published',
          })
        : unknown<string>('No quantity is known.', 'Ask on the next call.'),
    ),
  ];

  // --- the provider track -------------------------------------------------
  const candidates = record.supply.candidates;
  const best = candidates.find((c) => c.capabilityVerifiedAt) ?? candidates[0] ?? null;

  const providerTrack = [
    row(
      'Candidates',
      candidates.length > 0
        ? confirmed(String(candidates.length), 'Providers attached to this route.')
        : unknown<string>(
            'No provider has been attached, so this cannot be quoted however the buyer conversation goes.',
            'Source a provider who holds the capability.',
          ),
    ),
    row(
      'Capability',
      best
        ? gradeProviderClaim({
            claim: best.providerName,
            capabilityVerifiedAt: best.capabilityVerifiedAt ?? null,
            verifiedBy: null,
            sourceUrl: null,
          })
        : unknown<string>('Nobody has claimed the capability.', 'Recruit or find a provider.'),
    ),
    row(
      'Cost',
      providerCostOf(money),
    ),
    row(
      'Cost expires',
      best?.costExpiresAt
        ? confirmed(best.costExpiresAt.toISOString().slice(0, 10), 'The date the provider put on their price.')
        : unknown<string>('No cost has an expiry, so none of it can be relied on.', 'Ask the provider how long it holds.'),
    ),
  ];

  // --- diagnostics, folded away -------------------------------------------
  const diagnostics: Array<{ label: string; value: string }> = [
    { label: 'route id', value: record.routeId ?? '—' },
    { label: 'quote state', value: quote?.state ?? 'none' },
    { label: 'economics basis', value: quote?.basis ?? 'none' },
    { label: 'cost side missing', value: String(quote?.costSideMissing ?? true) },
    { label: 'candidates', value: String(candidates.length) },
    { label: 'stages done', value: `${plan.progress.done}/${plan.progress.total}` },
    ...plan.blockedCapabilities.map((b) => ({ label: `blocked: ${b.what}`, value: b.reason })),
  ];

  return {
    organisation: input.organisation,
    standing: {
      sentence: standing.sentence,
      progress: standing.progress,
      reasoning: standing.reasoning,
    },
    blocker: standing.blocker ? serialiseStage(standing.blocker) : null,
    waitingOn: standing.waitingOn.map(serialiseStage),
    money: {
      defensible: path.defensible,
      sentence: path.sentence,
      steps: path.steps.map((s) => ({
        label: s.label,
        presentation: s.presentation,
        toConfirm: s.toConfirm,
      })),
    },
    buyerTrack,
    providerTrack,
    plan: plan.stages.map(serialiseStage),
    diagnostics,
  };
}

function row(label: string, value: Evidenced<string | number>) {
  return { label, presentation: presentText(value) };
}

function serialiseStage(stage: DealPlan['stages'][number]) {
  return {
    key: stage.key,
    label: stage.label,
    state: stage.state,
    because: stage.because,
    nextAction: stage.nextAction,
    owner: stage.owner,
    completionCondition: stage.completionCondition,
    evidenceRequired: stage.evidenceRequired,
    needsAuthority: stage.needsAuthority,
    deadline: stage.deadline ? stage.deadline.toISOString() : null,
  };
}

/**
 * Money that actually arrived.
 *
 * Read from settled inbound payments rather than from a deal's stage, because
 * a deal marked delivered is a claim about work and a settled payment is a
 * fact about a bank.
 */
function collectedOf(record: DealRecord): Evidenced<number> {
  const collected = record.deal.money?.collected ?? null;
  if (collected === null || collected === 0) {
    return unknown<number>(
      'No money has been collected on this deal.',
      'It appears here when an inbound payment settles.',
    );
  }
  return confirmed(Number(collected), 'Settled inbound payments against this deal.');
}
