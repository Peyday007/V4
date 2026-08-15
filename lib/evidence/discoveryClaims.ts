import type { ClaimInput } from './ledger';

/**
 * What discovery actually claims when it builds a route, written down.
 *
 * Before this, a route arrived with a dozen populated columns and no record of
 * which were facts. `needIsConfirmed` was a boolean; `estimatedGrossProfit` was
 * a number; `fulfilmentStatus` was a string. All three were the engine's
 * conclusions, two of them rested on a category prior, and nothing on the row
 * distinguished any of that from a figure a buyer had stated on a call.
 *
 * So the pipeline now says what it is claiming and how it came to claim it. The
 * distinctions are the ones an operator would draw if they were doing this by
 * hand:
 *
 *   The event happened. That is a published record with a date and a URL, and
 *   it is the only thing on a fresh route that is confirmed.
 *
 *   Somebody needs something. Confirmed only when the source states it — a
 *   solicitation, an inbound request. A permit for a new warehouse does not
 *   confirm that anyone needs overflow storage; a playbook concluded that, and
 *   the claim says so, with the reasoning and the call that would settle it.
 *
 *   The money. Always an inference at this stage, always carrying its basis,
 *   and never presented as a figure until a provider has priced it.
 *
 *   The gaps. Recorded as claims rather than omitted, because an absent row is
 *   invisible and a recorded absence has an owner and a next action.
 *
 * Pure, so it can be checked without a database, and so the same function
 * produces the claims for a real event and for a walkthrough.
 */

export type DiscoveryClaimInput = {
  routeId: string;
  companyId: string;
  organisation: string;
  event: {
    type: string;
    headline: string;
    sourceUrl: string | null;
    connector: string;
    eventDate: Date | null;
  };
  playbook: { key: string; label: string; route: string };
  /** Whether the source states the need, or a playbook concluded it. */
  needIsConfirmed: boolean;
  /** The playbook's reasoning, in the operator's language. */
  rationale: string;
  buyerRole: string;
  window: { label: string; closesAt: Date | null } | null;
  fulfilment: { status: string; reason: string; providerCount: number };
  economics: {
    buyerPrice: number | null;
    providerCost: number | null;
    grossProfit: number | null;
    basis: string | null;
  };
  compliance: { status: string; gaps: string[] };
  structure: { structure: string; reason: string };
};

/**
 * A phrase naming where a claim can be checked.
 *
 * A connector name is not a source. "Chicago building permits" is checkable;
 * "municipal_open_data" is an implementation detail, and putting it on screen
 * teaches an operator that provenance is not for them.
 */
function sourcePhrase(event: DiscoveryClaimInput['event']): string {
  const dated = event.eventDate ? ` dated ${event.eventDate.toISOString().slice(0, 10)}` : '';
  return event.sourceUrl
    ? `Published record${dated}, at ${event.sourceUrl}`
    : `Published record${dated} from ${event.connector}, with no durable link`;
}

export function discoveryClaims(input: DiscoveryClaimInput): ClaimInput[] {
  const claims: ClaimInput[] = [];
  const source = sourcePhrase(input.event);
  const common = {
    routeId: input.routeId,
    companyId: input.companyId,
    observedAt: input.event.eventDate,
    sourceRef: input.event.sourceUrl,
  };

  // --- the one thing that is actually confirmed ----------------------------
  //
  // A published record with a date and an identifier. Everything below is built
  // on this, and nothing below is as strong as it.
  claims.push({
    ...common,
    about: 'DEMAND',
    key: 'demand.event',
    statement: `${input.event.headline}`,
    value: { type: input.event.type, headline: input.event.headline },
    standing: input.event.sourceUrl ? 'CONFIRMED' : 'INFERRED',
    sourceKind: 'PUBLISHED_RECORD',
    sourceLabel: source,
    // A record with no durable link cannot be reopened by somebody who does not
    // trust us, which is the only test provenance has to pass.
    correctiveAction: input.event.sourceUrl
      ? null
      : 'Find the published record and attach its link, or treat this event as unverified.',
    confidence: input.event.sourceUrl ? null : 0.6,
  });

  // --- whether anybody needs anything --------------------------------------
  if (input.needIsConfirmed) {
    claims.push({
      ...common,
      about: 'BUYER',
      key: 'buyer.need',
      statement: `${input.organisation} states a requirement: ${input.event.headline}`,
      value: { confirmed: true },
      standing: 'CONFIRMED',
      sourceKind: 'PUBLISHED_RECORD',
      sourceLabel: `${source}. The source states the requirement rather than implying it.`,
    });
  } else {
    claims.push({
      ...common,
      about: 'BUYER',
      key: 'buyer.need',
      statement: `${input.organisation} may need ${input.playbook.label.toLowerCase()}. Nobody has said so.`,
      value: { confirmed: false, playbook: input.playbook.key },
      standing: 'INFERRED',
      sourceKind: 'ENGINE_INFERENCE',
      sourceLabel: `Concluded by the ${input.playbook.label} playbook. ${input.rationale}`,
      // Deliberately concrete. "Verify the need" is not an action; ringing them
      // and asking the one question is.
      correctiveAction: `Ring ${input.organisation} and ask whether this is something they need. `
        + 'Until somebody says yes, this is our reading of a public record.',
      confidence: 0.4,
    });
  }

  claims.push({
    ...common,
    about: 'BUYER',
    key: 'buyer.role',
    statement: `The buying side of this deal is a ${input.buyerRole.toLowerCase().replace(/_/g, ' ')}.`,
    value: { role: input.buyerRole },
    standing: 'INFERRED',
    sourceKind: 'ENGINE_INFERENCE',
    sourceLabel: `The ${input.playbook.label} playbook reads this event type as demand from a `
      + `${input.buyerRole.toLowerCase().replace(/_/g, ' ')}.`,
    correctiveAction: 'Confirm on the call who actually holds the budget for this.',
    confidence: 0.5,
  });

  // --- timing ---------------------------------------------------------------
  if (input.window) {
    claims.push({
      ...common,
      about: 'TIMING',
      key: 'timing.window',
      statement: input.window.label,
      value: { closesAt: input.window.closesAt?.toISOString() ?? null },
      standing: 'INFERRED',
      sourceKind: 'ENGINE_INFERENCE',
      sourceLabel: `Worked out from the event date and the ${input.playbook.label} playbook's typical window.`,
      correctiveAction: 'Ask when they need this by. A stated date replaces a modelled one.',
      confidence: 0.45,
    });
  } else {
    claims.push({
      ...common,
      about: 'TIMING',
      key: 'timing.window',
      statement: 'When they need this is not known.',
      standing: 'UNKNOWN',
      sourceKind: 'ABSENCE',
      sourceLabel: 'The event carries no date this playbook can turn into a buying window.',
      correctiveAction: 'Ask when they need it. A date is what separates a lead from a deal.',
    });
  }

  // --- the other side of the deal ------------------------------------------
  claims.push({
    ...common,
    about: 'PROVIDER',
    key: 'provider.supply',
    statement:
      input.fulfilment.providerCount > 0
        ? `${input.fulfilment.providerCount} provider(s) in the catalogue could plausibly deliver this.`
        : 'Nobody in the catalogue has been matched to deliver this.',
    value: { status: input.fulfilment.status, count: input.fulfilment.providerCount },
    standing: input.fulfilment.providerCount > 0 ? 'INFERRED' : 'UNKNOWN',
    sourceKind: input.fulfilment.providerCount > 0 ? 'ENGINE_INFERENCE' : 'ABSENCE',
    sourceLabel: input.fulfilment.reason,
    // A catalogue match is a capability listing, not a commitment. The
    // difference is one phone call and it is the difference between a deal and
    // an embarrassment.
    correctiveAction:
      input.fulfilment.providerCount > 0
        ? 'Ring a matched provider and establish that they have capacity and will quote. A directory listing '
          + 'is their claim about themselves, not availability.'
        : 'Find providers who can deliver this, or drop the route. There is no deal without a supply side.',
    confidence: input.fulfilment.providerCount > 0 ? 0.35 : null,
  });

  // --- money ----------------------------------------------------------------
  //
  // Recorded as inference whatever the basis, because at discovery nobody has
  // quoted anything. The basis is on the claim so the figure can be argued with
  // rather than merely disbelieved.
  const money: Array<[string, number | null, string]> = [
    ['economics.buyerPrice', input.economics.buyerPrice, 'What the buyer would pay'],
    ['economics.providerCost', input.economics.providerCost, 'What the provider would charge'],
    ['economics.grossProfit', input.economics.grossProfit, 'What would be left'],
  ];
  for (const [key, value, label] of money) {
    if (value === null) {
      claims.push({
        ...common,
        about: 'ECONOMICS',
        key,
        statement: `${label} is not known.`,
        standing: 'UNKNOWN',
        sourceKind: 'ABSENCE',
        sourceLabel: input.economics.basis
          ? `No figure could be estimated on the ${input.economics.basis} basis.`
          : 'Nothing on this route supports an estimate.',
        correctiveAction:
          key === 'economics.providerCost'
            ? 'Get a provider to price it.'
            : 'Establish the scope on the call, then price it.',
      });
      continue;
    }
    claims.push({
      ...common,
      about: 'ECONOMICS',
      key,
      statement: `${label}: about $${Math.round(value).toLocaleString()}.`,
      value: { amount: value, basis: input.economics.basis },
      standing: 'INFERRED',
      sourceKind: 'ENGINE_INFERENCE',
      sourceLabel: `Modelled on the ${input.economics.basis ?? 'unstated'} basis. Nobody has quoted this.`,
      correctiveAction:
        key === 'economics.providerCost'
          ? 'Ask a provider for a real price. Until then this is a category average.'
          : 'Confirm the scope with the buyer, then get it priced.',
      confidence: 0.3,
    });
  }

  // --- compliance and structure --------------------------------------------
  claims.push({
    ...common,
    about: 'COMPLIANCE',
    key: 'compliance.status',
    statement:
      input.compliance.gaps.length > 0
        ? `Cannot currently satisfy: ${input.compliance.gaps.join(', ')}.`
        : 'No compliance requirement is known to block this.',
    value: { status: input.compliance.status, gaps: input.compliance.gaps },
    standing: input.compliance.status === 'UNKNOWN' ? 'UNKNOWN' : 'INFERRED',
    sourceKind: input.compliance.status === 'UNKNOWN' ? 'ABSENCE' : 'ENGINE_INFERENCE',
    sourceLabel: `Read from the ${input.playbook.label} playbook's requirements against what is known.`,
    correctiveAction:
      input.compliance.gaps.length > 0
        ? `Establish whether ${input.compliance.gaps[0]} is genuinely required here, and whether a provider `
          + 'already holds it.'
        : 'Ask on the call what they require of a vendor. Insurance limits and onboarding kill more deals '
          + 'than price does.',
  });

  claims.push({
    ...common,
    about: 'STRUCTURE',
    key: 'structure.chosen',
    statement: `Proposed structure: ${input.structure.structure.toLowerCase().replace(/_/g, ' ')}.`,
    value: { structure: input.structure.structure },
    standing: 'INFERRED',
    sourceKind: 'ENGINE_INFERENCE',
    sourceLabel: input.structure.reason,
    correctiveAction:
      'Confirm who would contract with whom. The structure decides who carries the liability and who funds '
      + 'the gap, and it is not the connector\'s decision.',
    confidence: 0.5,
  });

  return claims;
}
