import type {
  CampaignChannelKind,
  CampaignComparator,
  CampaignConditionKind,
  CampaignMetric,
  CampaignState,
  EvidenceClass,
  SignalCategory,
} from '@prisma/client';

/**
 * What makes a campaign runnable, and what makes it honest.
 *
 * A campaign is a thesis about where money is, plus the machinery to find out
 * whether it is there. The machinery is the easy part. The discipline is in
 * refusing to run one that has not said what would make it wrong, what finding
 * out costs, and who agreed to pay — because a campaign missing any of those
 * runs forever on somebody's optimism and cannot be judged afterwards.
 *
 * Every rule here is a refusal. None of them makes a campaign better; they
 * stop a campaign that is not yet a campaign from generating work and spending
 * money as though it were.
 */

export type CampaignReadiness = {
  ready: boolean;
  /** Everything missing, in the order it should be filled in. */
  blockers: Array<{ field: string; because: string }>;
  /** True and worth saying, but not blocking. */
  warnings: string[];
};

export type CampaignDraft = {
  name: string;
  thesis: string;
  whyNow: string;
  route: SignalCategory;
  targetStates: string[];
  buyerProfile: string;
  providerProfile: string;
  requiredCapability: string;
  testingHours: number;
  testingCostCents: number;
  testingCostBasis: string;
  budgetCents: number | null;
  authorityGrantedById: string | null;
  evidence: Array<{ kind: 'SUPPORTING' | 'CONTRARY'; claim: string; evidenceClass: EvidenceClass; sourceUrl: string | null }>;
  channels: Array<{ kind: CampaignChannelKind; enabled: boolean; budgetCents: number | null; authorisedById: string | null; outcomeMetric: CampaignMetric | null }>;
  conditions: Array<{ kind: CampaignConditionKind; metric: CampaignMetric; comparator: CampaignComparator; threshold: number; afterDays: number; statement: string }>;
};

/**
 * Capabilities that must be argued for rather than assumed.
 *
 * The portfolio audit found 85% of a board in janitorial work, traceable to a
 * single hardcoded default. A campaign naming a cleaning capability is fine —
 * it is the business — but it has to rest on evidence like any other claim,
 * because the failure was never that cleaning is wrong. It was that nothing
 * else was ever considered, and nothing noticed.
 */
const NEEDS_ARGUING = /janitor|clean|custodial|sanitat/i;

/** States a campaign may not reach, because no working source covers them. */
export function unreachableTargets(targets: string[], reachable: string[]): string[] {
  return targets.filter((t) => !reachable.includes(t.toUpperCase()));
}

/**
 * Whether this campaign may start generating work.
 *
 * Ordered by dependency rather than severity: a campaign with no thesis cannot
 * usefully be told its budget is missing, and an owner working down a list
 * should never be sent back up it.
 */
export function campaignReadiness(input: {
  draft: CampaignDraft;
  /** States a currently-working source can produce events in. */
  reachableStates: string[];
}): CampaignReadiness {
  const { draft } = input;
  const blockers: CampaignReadiness['blockers'] = [];
  const warnings: string[] = [];

  // --- 1. is there a thesis at all ---------------------------------------
  if (draft.thesis.trim().length < 40) {
    blockers.push({
      field: 'thesis',
      because:
        'A thesis short enough to fit on a label is a category, not a claim. Say what you believe is '
        + 'happening, to whom, and why it is worth money.',
    });
  }
  if (draft.whyNow.trim().length < 20) {
    blockers.push({
      field: 'whyNow',
      because: 'A thesis with no timing is a standing wish. Say what makes this the moment rather than any other.',
    });
  }

  // --- 2. has it been argued against -------------------------------------
  const contrary = draft.evidence.filter((e) => e.kind === 'CONTRARY');
  const supporting = draft.evidence.filter((e) => e.kind === 'SUPPORTING');

  if (supporting.length === 0) {
    blockers.push({
      field: 'evidence',
      because: 'Nothing supports this yet. One observation with a source and a date is the minimum.',
    });
  }
  if (contrary.length === 0) {
    blockers.push({
      field: 'evidence',
      because:
        'No contrary evidence. A thesis nobody has argued against has not been thought about — write down '
        + 'what would make it wrong, even if you do not believe it.',
    });
  }

  const observedWithoutSource = draft.evidence.filter(
    (e) => e.evidenceClass === 'EXTERNALLY_OBSERVED' && !e.sourceUrl,
  );
  if (observedWithoutSource.length > 0) {
    blockers.push({
      field: 'evidence',
      because:
        `${observedWithoutSource.length} claim(s) are marked as externally observed with no source. `
        + 'Either link the record or mark them as inference.',
    });
  }

  // --- 3. who and where ---------------------------------------------------
  if (draft.buyerProfile.trim().length < 15) {
    blockers.push({ field: 'buyerProfile', because: 'Describe the buyer so a caller would recognise one.' });
  }
  if (draft.providerProfile.trim().length < 15) {
    blockers.push({
      field: 'providerProfile',
      because:
        'No provider side. A campaign with no answer to "who does the work" is a lead-generation exercise, '
        + 'and finding that out at the quote is the expensive way.',
    });
  }
  if (draft.targetStates.length === 0) {
    blockers.push({ field: 'targetStates', because: 'Name at least one place. "Everywhere" is not a market.' });
  } else {
    const unreachable = unreachableTargets(draft.targetStates, input.reachableStates);
    if (unreachable.length === draft.targetStates.length) {
      blockers.push({
        field: 'targetStates',
        because:
          `No working source covers ${unreachable.join(', ')}. This campaign would generate nothing until a `
          + 'source for those places is working — fix that first, or target somewhere reachable.',
      });
    } else if (unreachable.length > 0) {
      warnings.push(
        `${unreachable.join(', ')} cannot currently be reached by any working source, so this campaign will `
        + `only produce work in ${draft.targetStates.filter((t) => !unreachable.includes(t)).join(', ')}.`,
      );
    }
  }

  // --- 4. the capability, argued rather than defaulted --------------------
  if (!draft.requiredCapability.trim()) {
    blockers.push({
      field: 'requiredCapability',
      because: 'Name the capability the work needs. Leaving it blank is how everything becomes cleaning.',
    });
  } else if (NEEDS_ARGUING.test(draft.requiredCapability)) {
    const argued = draft.evidence.some((e) => NEEDS_ARGUING.test(e.claim));
    if (!argued) {
      blockers.push({
        field: 'requiredCapability',
        because:
          'This campaign targets cleaning work and no evidence mentions it. That is the default the portfolio '
          + 'kept falling into. Cite something that says this buyer needs this trade, or choose another.',
      });
    }
  }

  // --- 5. what finding out costs -----------------------------------------
  if (draft.testingHours <= 0) {
    blockers.push({
      field: 'testingHours',
      because: 'Every test costs attention. An estimate of zero hours means it has not been thought through.',
    });
  }
  if (!draft.testingCostBasis.trim()) {
    blockers.push({
      field: 'testingCostBasis',
      because: 'Say how the cost was arrived at, so somebody can argue with it.',
    });
  }

  // --- 6. authority -------------------------------------------------------
  const paid = draft.channels.filter((c) => c.enabled && needsBudget(c.kind));
  for (const channel of paid) {
    if (!channel.budgetCents || channel.budgetCents <= 0) {
      blockers.push({
        field: `channel:${channel.kind}`,
        because: `${channel.kind} spends money and has no budget. It cannot be enabled without one.`,
      });
    }
    if (!channel.authorisedById) {
      blockers.push({
        field: `channel:${channel.kind}`,
        because: `${channel.kind} spends money and nobody has authorised it. A budget with no name behind it is not authority.`,
      });
    }
    if (!channel.outcomeMetric) {
      blockers.push({
        field: `channel:${channel.kind}`,
        because:
          `${channel.kind} has no measurable outcome. Paid placement with nothing downstream to count is a `
          + 'donation — name what it is supposed to move.',
      });
    }
  }
  if (draft.channels.filter((c) => c.enabled).length === 0) {
    blockers.push({ field: 'channels', because: 'No channel is enabled, so this campaign cannot reach anybody.' });
  }

  const totalChannelBudget = draft.channels
    .filter((c) => c.enabled)
    .reduce((sum, c) => sum + (c.budgetCents ?? 0), 0);
  if (draft.budgetCents !== null && totalChannelBudget > draft.budgetCents) {
    blockers.push({
      field: 'budgetCents',
      because:
        `The channels are authorised for ${money(totalChannelBudget)} between them and the campaign's authority `
        + `is ${money(draft.budgetCents)}. The parts cannot exceed the whole.`,
    });
  }

  // --- 7. how it ends -----------------------------------------------------
  const kills = draft.conditions.filter((c) => c.kind === 'KILL');
  const expands = draft.conditions.filter((c) => c.kind === 'EXPAND');
  if (kills.length === 0) {
    blockers.push({
      field: 'conditions',
      because:
        'No kill condition. A campaign that cannot say what would stop it runs until somebody remembers to '
        + 'look, which in practice is never.',
    });
  }
  if (expands.length === 0) {
    warnings.push(
      'No expansion condition. The campaign can succeed and nothing will happen automatically as a result.',
    );
  }
  for (const condition of kills) {
    if (condition.afterDays <= 0) {
      warnings.push(
        `"${condition.statement}" can fire on day one, before the campaign has had a chance to produce `
        + 'anything. Consider a grace period.',
      );
    }
  }

  return { ready: blockers.length === 0, blockers, warnings };
}

/** Channels that move money and therefore need explicit authority. */
export function needsBudget(kind: CampaignChannelKind): boolean {
  return kind === 'ADVERTISING' || kind === 'DIRECT_MAIL';
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Whether a state transition is allowed, and why not when it is not.
 *
 * Written as a table rather than scattered guards because the interesting part
 * is what is *absent*: nothing goes from DRAFT straight to RUNNING, and nothing
 * comes back from KILLED. A campaign that can be un-killed is a campaign whose
 * kill conditions mean nothing.
 */
const TRANSITIONS: Record<CampaignState, CampaignState[]> = {
  DRAFT: ['AWAITING_AUTHORITY', 'KILLED'],
  AWAITING_AUTHORITY: ['RUNNING', 'DRAFT', 'KILLED'],
  RUNNING: ['PAUSED', 'KILLED', 'EXPANDED', 'CONCLUDED'],
  PAUSED: ['RUNNING', 'KILLED', 'CONCLUDED'],
  EXPANDED: ['RUNNING', 'PAUSED', 'KILLED', 'CONCLUDED'],
  KILLED: [],
  CONCLUDED: [],
};

export function canTransition(from: CampaignState, to: CampaignState): { ok: boolean; because: string } {
  if (from === to) return { ok: false, because: `It is already ${from.toLowerCase().replace(/_/g, ' ')}.` };
  if (TRANSITIONS[from].includes(to)) return { ok: true, because: '' };

  if (from === 'KILLED') {
    return {
      ok: false,
      because:
        'A killed campaign stays killed. Its conditions fired, or somebody ended it, and reopening it would '
        + 'make both meaningless. Write a new one that says what changed.',
    };
  }
  if (from === 'CONCLUDED') {
    return { ok: false, because: 'A concluded campaign is history. Its learning is recorded; start a new one.' };
  }
  if (from === 'DRAFT' && to === 'RUNNING') {
    return {
      ok: false,
      because: 'A draft goes to authority first. Nothing runs without somebody agreeing to what it costs.',
    };
  }
  return { ok: false, because: `${from} cannot become ${to}.` };
}
