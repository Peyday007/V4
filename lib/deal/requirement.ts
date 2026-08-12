import type { BuyerRequirement, BudgetMechanism, Prisma, SignalCategory } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordDealEvent, diffOf, newCorrelationId } from './events';

/**
 * What the buyer said they need, kept as versions.
 *
 * Two rules shape everything below, and both come from watching the previous
 * system lose information it had already paid for:
 *
 *   A requirement that has been priced is frozen. Editing it in place makes an
 *   old quote look wrong when it was right for the scope it was written
 *   against. A new version is written instead, and the quote keeps pointing at
 *   the version it priced.
 *
 *   A fact the buyer stated outranks a fact we inferred. A later call that
 *   guesses at the quantity does not overwrite a quantity the buyer gave us on
 *   an earlier one; the attempted overwrite is recorded and declined, and the
 *   operator is told, because silently losing the better fact is worse than
 *   carrying a visible disagreement.
 */

/** Fields whose value changes the price. A change to any of these forces a new version. */
export const MATERIAL_FIELDS = [
  'specification',
  'quantity',
  'unit',
  'frequency',
  'locationCount',
  'locations',
  'startsAt',
  'constraints',
] as const;

export type RequirementFields = {
  summary?: string | null;
  specification?: string | null;
  quantity?: string | null;
  unit?: string | null;
  frequency?: string | null;
  locationCount?: number | null;
  locations?: string | null;
  startsAt?: Date | null;
  decisionBy?: Date | null;
  timingNote?: string | null;
  processNotes?: string | null;
  constraints?: string[];
  incumbent?: string | null;
  incumbentNotes?: string | null;
  decisionMakerContactId?: string | null;
  decisionMakerRole?: string | null;
  authorityConfirmed?: boolean;
  budgetMechanism?: BudgetMechanism;
  budgetAmount?: Prisma.Decimal | number | null;
  budgetBasis?: string | null;
};

export type RequirementInput = RequirementFields & {
  /** Field names the buyer actually stated, in their own words. */
  confirmed: string[];
};

export type CaptureResult = {
  requirement: BuyerRequirement;
  /** 'created' | 'versioned' | 'merged' | 'unchanged' */
  action: 'created' | 'versioned' | 'merged' | 'unchanged';
  /** Fields a lower-confidence source tried to overwrite and was refused. */
  declinedOverwrites: string[];
};

// ---------------------------------------------------------------------------
// Reading a requirement out of a call
// ---------------------------------------------------------------------------

/** Discovery keys that mean the buyer described a need, per route. */
const NEED_KEYS: Record<string, string[]> = {
  DISTRIBUTION: ['productCategory', 'specification', 'quantity'],
  BROKERAGE: ['scope', 'frequency', 'locations'],
  SUBCONTRACTING: ['capacityGap', 'tradeCapability', 'projectOrAward'],
  GENERAL: [],
};

/**
 * Turn what a caller wrote down into a requirement, or return null.
 *
 * Null is the common and correct answer. A no-answer, a gatekeeper and a wrong
 * number all produce no requirement, and manufacturing an empty one so the
 * screen has something to show is exactly the fabrication this system is not
 * allowed to do.
 */
export function requirementFromDiscovery(
  route: SignalCategory | string,
  discovery: Record<string, unknown>,
): RequirementInput | null {
  const text = (key: string): string | null => {
    const value = discovery[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const flag = (key: string): boolean => discovery[key] === true || discovery[key] === 'true';

  const confirmed: string[] = [];
  const fields: RequirementFields = {};

  const confirmedNeed = text('confirmedNeed');
  const routeNeed = (NEED_KEYS[route] ?? []).map(text).find((v) => v !== null) ?? null;

  // The summary is the buyer's own account of the need. Without one there is
  // no requirement to record, whatever else the caller typed.
  const summary = confirmedNeed ?? routeNeed;
  if (!summary) return null;
  fields.summary = summary;
  confirmed.push('summary');

  const assign = (field: keyof RequirementFields, value: string | null, key: string) => {
    if (value === null) return;
    (fields as Record<string, unknown>)[field] = value;
    confirmed.push(String(field));
    void key;
  };

  if (route === 'DISTRIBUTION') {
    assign('specification', text('specification'), 'specification');
    assign('quantity', text('quantity'), 'quantity');
    assign('frequency', text('reorderCycle'), 'reorderCycle');
    assign('locations', text('deliveryLocation'), 'deliveryLocation');
    assign('incumbent', text('currentSupplier'), 'currentSupplier');
    assign('decisionMakerRole', text('purchasingAuthority'), 'purchasingAuthority');
    const timing = text('deliveryDate') ?? text('timing');
    if (timing) {
      fields.timingNote = timing;
      const parsed = confidentDate(timing);
      if (parsed) fields.startsAt = parsed;
      confirmed.push('timingNote');
    }
    const vendor = text('vendorRequirements');
    if (vendor) {
      fields.constraints = [vendor];
      confirmed.push('constraints');
    }
    if (flag('sampleOrQuoteRequested')) {
      fields.budgetMechanism = 'QUOTE_REQUESTED';
      confirmed.push('budgetMechanism');
    }
  } else if (route === 'BROKERAGE') {
    assign('specification', text('scope'), 'scope');
    assign('locations', text('locations'), 'locations');
    assign('frequency', text('frequency'), 'frequency');
    assign('incumbent', text('incumbent'), 'incumbent');
    assign('processNotes', text('decisionParticipants'), 'decisionParticipants');
    assign('budgetBasis', text('budgetProcess'), 'budgetProcess');
    const decision = text('contractEnd') ?? text('timing');
    if (decision) {
      fields.timingNote = decision;
      const parsed = confidentDate(decision);
      if (parsed) fields.decisionBy = parsed;
      confirmed.push('timingNote');
    }
    const constraints: string[] = [];
    const vendor = text('vendorRequirements');
    if (vendor) constraints.push(vendor);
    if (flag('siteVisitRequired')) constraints.push('Site visit required before a price can be given.');
    if (constraints.length > 0) {
      fields.constraints = constraints;
      confirmed.push('constraints');
    }
    if (text('budgetProcess')) confirmed.push('budgetBasis');
  } else if (route === 'SUBCONTRACTING') {
    assign('specification', text('capacityGap') ?? text('tradeCapability'), 'capacityGap');
    assign('locations', text('geography'), 'geography');
    assign('processNotes', text('onboardingContact'), 'onboardingContact');
    assign('budgetBasis', text('rateStructure'), 'rateStructure');
    const mobilise = text('mobilisationDate') ?? text('timing');
    if (mobilise) {
      fields.timingNote = mobilise;
      const parsed = confidentDate(mobilise);
      if (parsed) fields.startsAt = parsed;
      confirmed.push('timingNote');
    }
    const credentials = text('credentials');
    if (credentials) {
      fields.constraints = [credentials];
      confirmed.push('constraints');
    }
  }

  // Common fields apply to every route.
  const authority = text('decisionAuthority');
  if (authority) {
    fields.decisionMakerRole = authority;
    fields.authorityConfirmed = true;
    confirmed.push('decisionMakerRole', 'authorityConfirmed');
  }
  if (!fields.timingNote) {
    const timing = text('timing');
    if (timing) {
      fields.timingNote = timing;
      confirmed.push('timingNote');
    }
  }

  return { ...fields, confirmed: Array.from(new Set(confirmed)) };
}

/**
 * A date, only when the text unambiguously is one.
 *
 * "Q2", "after budget season" and "when the contract ends" are answers, not
 * dates. `new Date(...)` will happily turn several of them into something, and
 * a scheduled follow-up built on that lands on a day nobody chose.
 */
export function confidentDate(text: string): Date | null {
  const trimmed = text.trim();
  // ISO, or an unambiguous numeric date with a four-digit year.
  const iso = /^\d{4}-\d{2}-\d{2}(T|$)/;
  const slashed = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
  const named = /^[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}$/;

  if (!iso.test(trimmed) && !slashed.test(trimmed) && !named.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Writing a requirement
// ---------------------------------------------------------------------------

export type CaptureOptions = {
  orgId: string;
  routeId: string;
  input: RequirementInput;
  actorId?: string | null;
  actorType?: 'user' | 'system' | 'ai';
  capturedBy?: 'caller' | 'owner' | 'system';
  sourceAttemptId?: string | null;
  evidence?: string | null;
};

export async function captureRequirement(options: CaptureOptions): Promise<CaptureResult> {
  try {
    return await writeCapture(options);
  } catch (error) {
    // Two captures for the same route landing together — a caller saving a call
    // while the owner edits the same requirement. One wins on the partial
    // unique index.
    //
    // Retried once rather than refused, because the loser here is usually a
    // caller mid-call whose answers would otherwise be dropped on the floor.
    // The retry re-reads the requirement the winner just wrote and merges into
    // it, which is the same thing that would have happened had the two arrived
    // a second apart. A second failure is genuinely exceptional and is allowed
    // to surface.
    if (isUniqueViolation(error)) return writeCapture(options);
    throw error;
  }
}

async function writeCapture(options: CaptureOptions): Promise<CaptureResult> {
  const correlationId = newCorrelationId();

  return prisma.$transaction(async (tx) => {
    const current = await tx.buyerRequirement.findFirst({
      where: { routeId: options.routeId, state: 'CURRENT' },
      include: { _count: { select: { quotes: true } } },
    });

    if (!current) {
      const created = await tx.buyerRequirement.create({
        data: {
          orgId: options.orgId,
          routeId: options.routeId,
          version: (await nextVersion(tx, options.routeId)),
          state: 'CURRENT',
          summary: options.input.summary ?? 'Requirement recorded without a summary.',
          ...writableFields(options.input),
          confirmedFields: options.input.confirmed,
          capturedBy: options.capturedBy ?? 'caller',
          capturedById: options.actorId ?? null,
          sourceAttemptId: options.sourceAttemptId ?? null,
        },
      });

      await recordDealEvent(tx, {
        orgId: options.orgId,
        routeId: options.routeId,
        kind: 'requirement.captured',
        actorType: options.actorType ?? 'user',
        actorId: options.actorId,
        subjectType: 'BuyerRequirement',
        subjectId: created.id,
        summary: `Buyer requirement v${created.version} recorded: ${created.summary}`,
        after: diffOf(null, writableFields(options.input) as Record<string, unknown>).after,
        evidence: options.evidence ?? null,
        confidence: options.input.confirmed.length > 0 ? 'stated_by_buyer' : 'inferred',
        correlationId,
      });

      return { requirement: created, action: 'created' as const, declinedOverwrites: [] };
    }

    // Merge, refusing to let an unconfirmed value replace a confirmed one.
    const merged: Record<string, unknown> = {};
    const declined: string[] = [];
    const incoming = writableFields(options.input) as Record<string, unknown>;

    for (const [field, value] of Object.entries(incoming)) {
      if (value === null || value === undefined) continue;
      const existing = (current as unknown as Record<string, unknown>)[field];
      if (sameValue(existing, value)) continue;

      const existingWasConfirmed = current.confirmedFields.includes(field);
      const incomingIsConfirmed = options.input.confirmed.includes(field);
      const existingIsEmpty = existing === null || existing === undefined
        || (Array.isArray(existing) && existing.length === 0);

      if (existingWasConfirmed && !incomingIsConfirmed && !existingIsEmpty) {
        declined.push(field);
        continue;
      }
      merged[field] = value;
    }

    if (Object.keys(merged).length === 0) {
      if (declined.length > 0) {
        await recordDealEvent(tx, {
          orgId: options.orgId,
          routeId: options.routeId,
          kind: 'requirement.overwrite_declined',
          actorType: options.actorType ?? 'user',
          actorId: options.actorId,
          subjectType: 'BuyerRequirement',
          subjectId: current.id,
          summary: `Kept the buyer's own words for ${declined.join(', ')} over a later unconfirmed value.`,
          before: {},
          after: { declined },
          correlationId,
        });
      }
      return { requirement: current, action: 'unchanged' as const, declinedOverwrites: declined };
    }

    const materialChange = MATERIAL_FIELDS.some((field) => field in merged);
    const alreadyPriced = current._count.quotes > 0;

    if (!materialChange && !alreadyPriced) {
      const updated = await tx.buyerRequirement.update({
        where: { id: current.id },
        data: {
          ...merged,
          confirmedFields: Array.from(new Set([...current.confirmedFields, ...options.input.confirmed])),
        },
      });
      const delta = diffOf(current as unknown as Record<string, unknown>, merged);
      await recordDealEvent(tx, {
        orgId: options.orgId,
        routeId: options.routeId,
        kind: 'requirement.detail_added',
        actorType: options.actorType ?? 'user',
        actorId: options.actorId,
        subjectType: 'BuyerRequirement',
        subjectId: updated.id,
        summary: `Added ${Object.keys(merged).join(', ')} to requirement v${updated.version}.`,
        before: delta.before,
        after: delta.after,
        evidence: options.evidence ?? null,
        correlationId,
      });
      return { requirement: updated, action: 'merged' as const, declinedOverwrites: declined };
    }

    // A material change, or a requirement somebody has already priced. Either
    // way the old version stays exactly as it was and a new one is written.
    const reason = alreadyPriced && !materialChange
      ? 'Requirement already priced; detail changes are kept as a new version.'
      : `Scope changed: ${MATERIAL_FIELDS.filter((f) => f in merged).join(', ')}.`;

    // Retire the old version *first*. The unique index on `state = 'CURRENT'`
    // is checked at the end of each statement, not at the end of the
    // transaction, so creating the new row while the old one is still current
    // would fail on the index rather than succeed and be tidied up afterwards.
    await tx.buyerRequirement.update({
      where: { id: current.id },
      data: { state: 'SUPERSEDED', supersededAt: new Date(), supersedeReason: reason },
    });

    const next = await tx.buyerRequirement.create({
      data: {
        orgId: options.orgId,
        routeId: options.routeId,
        version: await nextVersion(tx, options.routeId),
        state: 'CURRENT',
        summary: (merged.summary as string | undefined) ?? current.summary,
        specification: pick(merged, current, 'specification'),
        quantity: pick(merged, current, 'quantity'),
        unit: pick(merged, current, 'unit'),
        frequency: pick(merged, current, 'frequency'),
        locationCount: pick(merged, current, 'locationCount'),
        locations: pick(merged, current, 'locations'),
        startsAt: pick(merged, current, 'startsAt'),
        decisionBy: pick(merged, current, 'decisionBy'),
        timingNote: pick(merged, current, 'timingNote'),
        processNotes: pick(merged, current, 'processNotes'),
        constraints: (pick(merged, current, 'constraints') as string[] | null) ?? [],
        incumbent: pick(merged, current, 'incumbent'),
        incumbentNotes: pick(merged, current, 'incumbentNotes'),
        decisionMakerContactId: pick(merged, current, 'decisionMakerContactId'),
        decisionMakerRole: pick(merged, current, 'decisionMakerRole'),
        authorityConfirmed: (pick(merged, current, 'authorityConfirmed') as boolean | null) ?? false,
        budgetMechanism: (pick(merged, current, 'budgetMechanism') as BudgetMechanism | null) ?? 'UNKNOWN',
        budgetAmount: pick(merged, current, 'budgetAmount'),
        budgetBasis: pick(merged, current, 'budgetBasis'),
        confirmedFields: Array.from(new Set([...current.confirmedFields, ...options.input.confirmed])),
        capturedBy: options.capturedBy ?? 'caller',
        capturedById: options.actorId ?? null,
        sourceAttemptId: options.sourceAttemptId ?? null,
      },
    });

    // Now the new version exists, point the old one at it so the chain reads
    // forward from any version to the live one.
    await tx.buyerRequirement.update({
      where: { id: current.id },
      data: { supersededById: next.id },
    });

    const delta = diffOf(current as unknown as Record<string, unknown>, merged);
    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: options.routeId,
      kind: 'requirement.versioned',
      actorType: options.actorType ?? 'user',
      actorId: options.actorId,
      subjectType: 'BuyerRequirement',
      subjectId: next.id,
      summary: `Requirement v${current.version} superseded by v${next.version}. ${reason}`,
      before: delta.before,
      after: delta.after,
      evidence: options.evidence ?? null,
      correlationId,
    });

    return { requirement: next, action: 'versioned' as const, declinedOverwrites: declined };
  });
}

export async function withdrawRequirement(options: {
  orgId: string;
  routeId: string;
  reason: string;
  actorId?: string | null;
}): Promise<BuyerRequirement | null> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.buyerRequirement.findFirst({
      where: { routeId: options.routeId, orgId: options.orgId, state: 'CURRENT' },
    });
    if (!current) return null;

    const updated = await tx.buyerRequirement.update({
      where: { id: current.id },
      data: { state: 'WITHDRAWN', withdrawnReason: options.reason },
    });

    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: options.routeId,
      kind: 'requirement.withdrawn',
      actorId: options.actorId,
      subjectType: 'BuyerRequirement',
      subjectId: updated.id,
      summary: `Buyer withdrew the requirement: ${options.reason}`,
      before: { state: 'CURRENT' },
      after: { state: 'WITHDRAWN' },
      correlationId: newCorrelationId(),
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Whether this requirement can carry a price yet, and what is missing.
 *
 * Separate from state on purpose: a requirement can be the current one and
 * still not be priceable, and the operator needs the list of missing things
 * rather than a disabled button with no explanation.
 */
export function priceability(requirement: BuyerRequirement | null): {
  ready: boolean;
  missing: string[];
} {
  if (!requirement) {
    return { ready: false, missing: ['No buyer requirement recorded. Nothing to price.'] };
  }
  if (requirement.state === 'WITHDRAWN') {
    return { ready: false, missing: ['The buyer withdrew this requirement.'] };
  }

  const missing: string[] = [];
  if (!requirement.specification) missing.push('What exactly they need (specification or scope).');
  if (!requirement.quantity && !requirement.frequency && !requirement.locations) {
    missing.push('How much, how often, or where — at least one has to be known to size the work.');
  }
  if (!requirement.timingNote && !requirement.startsAt && !requirement.decisionBy) {
    missing.push('When they need it, or when they decide.');
  }
  if (!requirement.authorityConfirmed) missing.push('Who signs. A price sent to the wrong person is not a quote.');

  return { ready: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Postgres unique violation, as Prisma reports it. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'P2002';
}

async function nextVersion(tx: Prisma.TransactionClient, routeId: string): Promise<number> {
  const highest = await tx.buyerRequirement.findFirst({
    where: { routeId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  return (highest?.version ?? 0) + 1;
}

/** Only the fields a capture is allowed to set. Keeps provenance out of merges. */
function writableFields(input: RequirementFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys: Array<keyof RequirementFields> = [
    'summary', 'specification', 'quantity', 'unit', 'frequency', 'locationCount', 'locations',
    'startsAt', 'decisionBy', 'timingNote', 'processNotes', 'constraints', 'incumbent',
    'incumbentNotes', 'decisionMakerContactId', 'decisionMakerRole', 'authorityConfirmed',
    'budgetMechanism', 'budgetAmount', 'budgetBasis',
  ];
  for (const key of keys) {
    const value = input[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The merged value if this capture changed the field, otherwise the value the
 * previous version carried. Typed against the model so a renamed column is a
 * compile error rather than a silently-dropped field on the new version.
 */
function pick<K extends keyof BuyerRequirement>(
  merged: Record<string, unknown>,
  current: BuyerRequirement,
  field: K,
): BuyerRequirement[K] {
  if (field in merged) return merged[field as string] as BuyerRequirement[K];
  return current[field];
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return String(a) === String(b);
  }
  return a === b;
}
