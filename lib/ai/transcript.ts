import type { FactStatus, OpportunityType } from '@prisma/client';
import { num0, prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { detectSensitiveData, recordActivity } from '@/lib/audit';
import { suppressContact } from '@/lib/compliance';
import { deriveScopeFromEvidence, inferRequiredCapabilities } from './capabilities';
import { configureDeal } from './dealConfig';
import { recordDecision } from './decisions';
import { raiseEscalation } from './escalation';
import {
  computeTalkRatio,
  extractCommitments,
  extractComplianceConcerns,
  extractFacts,
  extractObjections,
  summarizeTranscript,
  type Segment,
} from './extractors';
import { findMatches } from './matching';
import { determineNextAction } from './nextAction';
import { scoreOpportunity } from './scoring';

export const TRANSCRIPT_VERSION = 'transcript_intelligence@3';

export type TranscriptProcessingResult = {
  factsExtracted: number;
  factsApplied: number;
  contradictions: number;
  commitments: number;
  unauthorizedCommitments: number;
  objections: number;
  complianceConcerns: string[];
  recordsUpdated: string[];
  summary: string;
};

/**
 * Post-call pipeline. Runs after every transcript lands:
 * extract -> record with provenance -> reconcile against existing facts ->
 * apply to the graph -> rescore -> rematch -> reconfigure -> next action.
 *
 * The caller does no data entry. Everything below happens on its own.
 */
export async function processTranscript(transcriptId: string): Promise<TranscriptProcessingResult> {
  const transcript = await prisma.transcript.findUniqueOrThrow({
    where: { id: transcriptId },
    include: {
      call: {
        include: {
          caller: true,
          contact: true,
          assignment: { include: { company: true, opportunity: true } },
        },
      },
    },
  });

  const call = transcript.call;
  const assignment = call.assignment;
  const orgId = call.orgId;
  const companyId = assignment?.companyId ?? null;
  const contactId = call.contactId ?? assignment?.contactId ?? null;
  const opportunityId = assignment?.opportunityId ?? null;
  const config = await getOrgConfig(orgId);

  const segments = (transcript.segments as unknown as Segment[]) ?? [];
  const callerName = call.caller?.name;

  const result: TranscriptProcessingResult = {
    factsExtracted: 0,
    factsApplied: 0,
    contradictions: 0,
    commitments: 0,
    unauthorizedCommitments: 0,
    objections: 0,
    complianceConcerns: [],
    recordsUpdated: [],
    summary: '',
  };

  // --- Redaction sweep before anything is persisted or logged -------------
  const sensitive = detectSensitiveData(transcript.text);
  if (sensitive.length > 0) {
    await prisma.transcript.update({
      where: { id: transcriptId },
      data: { redactions: sensitive.map((kind) => ({ kind, action: 'flagged_for_review' })) as object },
    });
  }

  // --- Summary and talk ratio --------------------------------------------
  const summary = summarizeTranscript(segments);
  const talkRatio = computeTalkRatio(segments, callerName);
  result.summary = summary;
  await prisma.transcript.update({ where: { id: transcriptId }, data: { summary, processedAt: new Date() } });
  await prisma.call.update({ where: { id: call.id }, data: { talkRatio } });

  // --- Facts ---------------------------------------------------------------
  const extractions = extractFacts(segments, callerName);
  result.factsExtracted = extractions.length;

  const staleness = config.stalenessRules;
  for (const extraction of extractions) {
    const timestampSec = segments.find((s) => s.text === extraction.sourceQuote)?.startSec ?? null;

    // Reconcile: an earlier fact with the same key and a different value is a
    // contradiction, not an overwrite. Both rows survive; the old one is marked.
    const prior = await prisma.extractedFact.findFirst({
      where: { orgId, factKey: extraction.factKey, companyId, supersededById: null, status: { notIn: ['CONTRADICTED', 'STALE'] } },
      orderBy: { capturedAt: 'desc' },
    });

    let status: FactStatus = extraction.status;
    if (prior && prior.factValue !== extraction.factValue) {
      const priorIsConfirmed = prior.status === 'CONFIRMED';
      status = priorIsConfirmed ? 'CONTRADICTED' : extraction.status;
      await prisma.extractedFact.update({
        where: { id: prior.id },
        data: { status: priorIsConfirmed ? 'CONTRADICTED' : 'STALE' },
      });
      result.contradictions += 1;
    }

    const fact = await prisma.extractedFact.create({
      data: {
        orgId,
        transcriptId,
        callId: call.id,
        companyId,
        contactId,
        opportunityId,
        factKey: extraction.factKey,
        factValue: extraction.factValue,
        valueJson: (extraction.valueJson ?? {}) as object,
        status,
        confidence: extraction.confidence,
        sourceQuote: extraction.sourceQuote.slice(0, 1000),
        timestampSec,
        reverifyAfter: reverifyDate(extraction.factKey, staleness),
        extractorVersion: TRANSCRIPT_VERSION,
      },
    });

    if (prior && prior.factValue !== extraction.factValue) {
      await prisma.extractedFact.update({ where: { id: prior.id }, data: { supersededById: fact.id } });
    }
  }

  // --- Apply facts to the graph -------------------------------------------
  if (companyId) {
    const applied = await applyFacts({
      orgId,
      companyId,
      contactId,
      opportunityId,
      opportunityType: assignment?.opportunity?.type ?? 'UNCLASSIFIED',
      transcript: { text: transcript.text },
      extractions,
    });
    result.factsApplied = applied.applied;
    result.recordsUpdated = applied.recordsUpdated;
  }

  // --- Commitments ---------------------------------------------------------
  const commitments = extractCommitments(segments, callerName);
  result.commitments = commitments.length;
  for (const commitment of commitments) {
    await prisma.commitment.create({
      data: {
        orgId,
        callId: call.id,
        contactId,
        opportunityId,
        madeBy: commitment.madeBy,
        text: commitment.text.slice(0, 500),
        isAuthorized: commitment.isAuthorized,
      },
    });
    if (!commitment.isAuthorized) result.unauthorizedCommitments += 1;
  }

  if (result.unauthorizedCommitments > 0) {
    const flagged = commitments.filter((c) => !c.isAuthorized);
    await raiseEscalation({
      orgId,
      opportunityId,
      reason: 'UNAUTHORIZED_COMMITMENT',
      title: `Caller made ${flagged.length} unauthorised commitment(s) on a call`,
      detail:
        `On the call with ${assignment?.company.legalName ?? 'this contact'}, the following statements exceeded caller authority:\n` +
        flagged.map((c) => `• ${c.issue ?? 'Unauthorised commitment'}: "${c.text}"`).join('\n') +
        '\n\nReview the recording and decide whether the statement needs to be corrected with the contact.',
      severity: 'CRITICAL',
      evidence: flagged,
    });
  }

  // --- Objections ----------------------------------------------------------
  const objections = extractObjections(segments, callerName);
  result.objections = objections.length;
  for (const objection of objections) {
    await prisma.objection.create({
      data: { orgId, callId: call.id, contactId, category: objection.category, text: objection.text.slice(0, 500) },
    });
  }

  // --- Compliance ----------------------------------------------------------
  const concerns = extractComplianceConcerns(segments);
  result.complianceConcerns = [...new Set(concerns.map((c) => c.concern))];
  for (const concern of concerns) {
    if (concern.concern === 'do_not_call_request' && contactId) {
      await suppressContact({ orgId, contactId, scope: 'DO_NOT_CALL', reason: `Requested on call: "${concern.text.slice(0, 200)}"`, source: 'call' });
      await prisma.call.update({ where: { id: call.id }, data: { outcome: 'DO_NOT_CALL' } });
    }
    if (concern.concern === 'do_not_contact_request' && contactId) {
      await suppressContact({ orgId, contactId, scope: 'DO_NOT_CONTACT', reason: `Requested on call: "${concern.text.slice(0, 200)}"`, source: 'call' });
    }
    if (concern.concern === 'recording_refusal' && contactId) {
      await prisma.contact.update({ where: { id: contactId }, data: { consentToRecord: false } });
    }
    if (concern.concern === 'legal_matter' || concern.concern === 'conflict_of_interest' || concern.concern === 'contractual_restriction') {
      await raiseEscalation({
        orgId,
        opportunityId,
        reason: concern.concern === 'conflict_of_interest' ? 'DISPUTE_DEVELOPING' : 'LEGAL_OR_REGULATORY',
        title: `${concern.concern.replace(/_/g, ' ')} raised on a call`,
        detail: `The contact said: "${concern.text.slice(0, 400)}". This needs a human judgement before the deal advances.`,
        severity: 'HIGH',
      });
    }
  }

  // --- Close out the assignment and re-run the loop ------------------------
  if (assignment) {
    await prisma.callAssignment.update({
      where: { id: assignment.id },
      data: { status: 'COMPLETED', completedAt: new Date(), attemptCount: { increment: 1 } },
    });
  }

  await recordActivity({
    orgId,
    opportunityId,
    companyId,
    contactId,
    userId: call.callerId,
    actorType: 'ai',
    verb: 'transcript.processed',
    summary: `Call analysed: ${result.factsExtracted} fact(s), ${result.commitments} commitment(s), ${result.objections} objection(s)`,
    payload: { transcriptId, talkRatio, contradictions: result.contradictions },
  });

  await recordDecision({
    orgId,
    opportunityId,
    process: 'transcript_intelligence',
    decision: `Extracted ${result.factsExtracted} fact(s) and updated ${result.recordsUpdated.length} record(s)`,
    reason: summary.slice(0, 1000),
    inputs: { transcriptId, segmentCount: segments.length },
    outputs: result as unknown as Record<string, unknown>,
    confidence: extractions.length ? extractions.reduce((s, e) => s + e.confidence, 0) / extractions.length : 0.3,
    rulesApplied: ['deterministic_extractors', 'fact_reconciliation', 'commitment_authority_check'],
    modelName: 'deterministic',
    promptVersion: TRANSCRIPT_VERSION,
  });

  if (opportunityId) {
    await scoreOpportunity(opportunityId);
    await findMatches(opportunityId);
    await configureDeal(opportunityId);
    await scoreOpportunity(opportunityId);
    await determineNextAction(opportunityId);
  }

  return result;
}

function reverifyDate(factKey: string, rules: { pricingDays: number; availabilityDays: number; capacityDays: number }): Date | null {
  if (factKey.startsWith('pricing.') || factKey === 'supply.unit_cost') {
    return new Date(Date.now() + rules.pricingDays * 86_400_000);
  }
  if (factKey.startsWith('supply.')) return new Date(Date.now() + rules.availabilityDays * 86_400_000);
  if (factKey.startsWith('capacity.')) return new Date(Date.now() + rules.capacityDays * 86_400_000);
  return null;
}

type ApplyArgs = {
  orgId: string;
  companyId: string;
  contactId: string | null;
  opportunityId: string | null;
  opportunityType: OpportunityType;
  transcript: { text: string };
  extractions: Array<{ factKey: string; factValue: string; valueJson?: Record<string, unknown>; status: FactStatus; confidence: number }>;
};

/**
 * Writes extracted facts onto the business graph. Each write is narrow and
 * explicit — no blanket merges — so a wrong extraction damages one field, not
 * a whole record.
 */
async function applyFacts(args: ApplyArgs): Promise<{ applied: number; recordsUpdated: string[] }> {
  const { orgId, companyId, opportunityId, extractions, transcript } = args;
  const updated = new Set<string>();
  let applied = 0;

  const byKey = new Map<string, typeof extractions>();
  for (const extraction of extractions) {
    const bucket = byKey.get(extraction.factKey) ?? [];
    bucket.push(extraction);
    byKey.set(extraction.factKey, bucket);
  }
  const first = (key: string) => byKey.get(key)?.[0];
  const all = (key: string) => byKey.get(key) ?? [];

  // --- Buyer need ----------------------------------------------------------
  if (opportunityId) {
    const opportunity = await prisma.opportunity.findUnique({
      where: { id: opportunityId },
      include: { buyerNeed: true, parties: { where: { isPrimary: true } } },
    });
    // Only demand-side opportunities get a buyer need. A supplier-qualification
    // call produces availability and pricing, not a requirement — recording it
    // as a buyer need would invent demand that nobody expressed.
    const primaryRole = opportunity?.parties[0]?.role ?? 'BUYER';
    const isDemandSide = !['SUPPLIER', 'DISTRIBUTOR', 'CARRIER', 'SUBCONTRACTOR'].includes(primaryRole);
    if (opportunity && isDemandSide) {
      const needData: Record<string, unknown> = {};
      const providerIssues = all('need.provider_issue').map((e) => e.factValue.slice(0, 200));
      const frequency = first('need.frequency')?.factValue;
      const currentProvider = first('need.current_provider')?.factValue;
      const startDate = parseDate(first('need.start_date')?.factValue);
      const deadline = parseDate(first('need.deadline')?.factValue);
      const monthly = first('pricing.monthly_amount');
      const oneOff = first('pricing.amount');
      const switching = first('need.switching_willingness')?.factValue;

      if (frequency) needData.frequency = frequency;
      if (currentProvider) needData.currentProvider = currentProvider;
      if (providerIssues.length) needData.currentProviderIssues = providerIssues;
      if (startDate) needData.startDate = startDate;
      if (deadline) needData.deadline = deadline;
      if (switching) needData.openToAlternatives = switching === 'open';
      if (monthly?.valueJson?.amount) {
        const amount = Number(monthly.valueJson.amount);
        needData.estimatedValue = frequency === 'recurring' ? amount * 12 : amount;
      } else if (oneOff?.valueJson?.amount) {
        // A price quoted without a period is the value of the job itself.
        needData.estimatedValue = Number(oneOff.valueJson.amount);
      }

      if (Object.keys(needData).length > 0) {
        if (opportunity.buyerNeed) {
          // Backfill required capabilities if the need was created without any;
          // matching cannot rank candidates against an empty requirement list.
          if (opportunity.buyerNeed.requiredCapabilities.length === 0) {
            // The conversation is usually where the actual trades get named,
            // so infer from what was said as well as the recorded scope.
            const spoken = extractions.map((e) => `${e.factKey} ${e.factValue}`).join(' ');
            const inferredCapabilities = await inferRequiredCapabilities(
              orgId,
              `${opportunity.buyerNeed.scope} ${spoken} ${transcript.text}`,
            );
            if (inferredCapabilities.length > 0) needData.requiredCapabilities = inferredCapabilities;
          }
          const remaining = recomputeMissingFields({ ...opportunity.buyerNeed, ...needData } as never);
          await prisma.buyerNeed.update({
            where: { id: opportunity.buyerNeed.id },
            data: { ...needData, status: remaining.length === 0 ? 'CONFIRMED' : 'CLAIMED', confidence: remaining.length === 0 ? 0.9 : 0.65, missingFields: remaining },
          });
        } else {
          const signal = opportunity.signalId
            ? await prisma.discoverySignal.findUnique({ where: { id: opportunity.signalId }, include: { evidence: true } })
            : null;
          const scope = deriveScopeFromEvidence({
            signalDetail: signal?.detail,
            evidenceExcerpt: signal?.evidence?.excerpt,
            evidenceTitle: signal?.evidence?.title,
            opportunityName: opportunity.name,
          });
          const need = await prisma.buyerNeed.create({
            data: {
              orgId,
              companyId,
              opportunityType: args.opportunityType,
              title: opportunity.name,
              scope,
              requiredCapabilities: await inferRequiredCapabilities(orgId, scope),
              location: opportunity.location,
              state: opportunity.state,
              status: 'CLAIMED',
              confidence: 0.6,
              ...needData,
            } as never,
          });
          const remaining = recomputeMissingFields(need as never);
          await prisma.buyerNeed.update({ where: { id: need.id }, data: { missingFields: remaining } });
          await prisma.opportunity.update({ where: { id: opportunityId }, data: { buyerNeedId: need.id } });
        }
        updated.add('BuyerNeed');
        applied += Object.keys(needData).length;
      }
    }
  }

  // --- Subcontractor capacity ---------------------------------------------
  const crewCount = first('capacity.crew_count');
  const minimum = first('capacity.minimum_contract');
  const territories = all('capacity.territories').map((e) => e.factValue);
  const shifts = [...new Set(all('capacity.shift_availability').map((e) => e.factValue))];
  const licenses = all('capacity.license').map((e) => e.factValue);
  const earliestStart = parseDate(first('capacity.earliest_start')?.factValue);
  const insuranceFacts = extractions.filter((e) => e.factKey.startsWith('capacity.insurance_limit'));

  if (crewCount || minimum || territories.length || shifts.length || licenses.length || earliestStart || insuranceFacts.length) {
    const existing = await prisma.subcontractorCapacity.findFirst({ where: { orgId, companyId } });
    const config = await getOrgConfig(orgId);
    const data: Record<string, unknown> = {
      status: 'CLAIMED',
      confidence: 0.7,
      staleAfter: new Date(Date.now() + config.stalenessRules.capacityDays * 86_400_000),
    };
    if (crewCount?.valueJson?.count) data.crewCount = Number(crewCount.valueJson.count);
    if (minimum?.valueJson?.amount) data.minimumContract = Number(minimum.valueJson.amount);
    if (territories.length) data.territories = [...new Set([...(existing?.territories ?? []), ...territories])];
    if (shifts.length) data.shiftAvailability = [...new Set([...(existing?.shiftAvailability ?? []), ...shifts])];
    if (licenses.length) data.licenses = [...new Set([...(existing?.licenses ?? []), ...licenses])];
    if (earliestStart) data.earliestStart = earliestStart;
    if (insuranceFacts.length > 0) {
      const limits: Record<string, number> = { ...((existing?.insuranceLimits as Record<string, number>) ?? {}) };
      for (const fact of insuranceFacts) {
        const amount = Number(fact.valueJson?.amount);
        if (!Number.isFinite(amount)) continue;
        const coverage = String(fact.valueJson?.coverage ?? 'unspecified');
        const field =
          coverage === 'workers_comp' ? 'workersComp'
          : coverage === 'auto_liability' ? 'autoLiability'
          : coverage === 'umbrella' ? 'umbrella'
          : 'generalLiability';
        limits[field] = amount;
      }
      data.insuranceLimits = limits;
    }

    if (existing) {
      await prisma.subcontractorCapacity.update({ where: { id: existing.id }, data });
    } else {
      await prisma.subcontractorCapacity.create({ data: { orgId, companyId, ...data } as never });
    }
    updated.add('SubcontractorCapacity');
    applied += Object.keys(data).length - 3;
  }

  // --- Supplier availability ----------------------------------------------
  const quantity = first('supply.quantity');
  const unitCost = first('supply.unit_cost');
  if (quantity || unitCost) {
    const existing = await prisma.supplierAvailability.findFirst({ where: { orgId, companyId } });
    const config = await getOrgConfig(orgId);
    const data: Record<string, unknown> = {
      status: 'CLAIMED',
      confidence: 0.7,
      verifiedAt: new Date(),
      staleAfter: new Date(Date.now() + config.stalenessRules.availabilityDays * 86_400_000),
    };
    if (quantity?.valueJson?.quantity) {
      data.quantity = Number(quantity.valueJson.quantity);
      data.unit = String(quantity.valueJson.unit ?? 'each');
    }
    if (unitCost?.valueJson?.amount) data.unitCost = Number(unitCost.valueJson.amount);

    if (existing) {
      await prisma.supplierAvailability.update({ where: { id: existing.id }, data });
    } else {
      await prisma.supplierAvailability.create({
        data: { orgId, companyId, description: 'Availability stated on call', ...data } as never,
      });
    }
    updated.add('SupplierAvailability');
    applied += 1;
  }

  // --- Contact -------------------------------------------------------------
  const phone = first('contact.phone');
  if (phone && args.contactId) {
    await prisma.contact.update({
      where: { id: args.contactId },
      data: { lastInteractionAt: new Date() },
    });
    updated.add('Contact');
  } else if (args.contactId) {
    await prisma.contact.update({ where: { id: args.contactId }, data: { lastInteractionAt: new Date() } });
    updated.add('Contact');
  }

  // --- Company movability --------------------------------------------------
  const switching = first('need.switching_willingness')?.factValue;
  const issues = all('need.provider_issue');
  if (switching || issues.length) {
    const reasons = issues.map((i) => i.factValue.slice(0, 160));
    const movability =
      switching === 'locked' ? 'RELATIONSHIP_LOCKED' : issues.length >= 2 || switching === 'open' ? 'ACTIVELY_MOVABLE' : 'CONDITIONALLY_MOVABLE';
    await prisma.company.update({
      where: { id: companyId },
      data: {
        movability,
        movabilityScore: movability === 'ACTIVELY_MOVABLE' ? 0.85 : movability === 'CONDITIONALLY_MOVABLE' ? 0.55 : 0.1,
        movabilityReasons: reasons.length ? reasons : [`Stated position on switching: ${switching}`],
        lastVerifiedAt: new Date(),
        accountStage: 'CONTACTED',
      },
    });
    updated.add('Company');
    applied += 1;
  } else {
    await prisma.company.update({ where: { id: companyId }, data: { lastVerifiedAt: new Date() } });
  }

  return { applied, recordsUpdated: [...updated] };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (iso) return new Date(`${value}T00:00:00Z`);
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    const date = new Date(parsed);
    // Bare "October 1" parses into the current year; roll forward if past.
    if (date < new Date()) date.setFullYear(date.getFullYear() + 1);
    return date;
  }
  return null;
}

/** A need is only CONFIRMED when the fields a quote depends on are present. */
export function recomputeMissingFields(need: {
  scope?: string | null;
  location?: string | null;
  startDate?: Date | null;
  frequency?: string | null;
  estimatedValue?: unknown;
  currentProvider?: string | null;
  requiredCapabilities?: string[];
}): string[] {
  const missing: string[] = [];
  if (!need.scope || need.scope.length < 10) missing.push('Scope of work');
  if (!need.location) missing.push('Location');
  if (!need.startDate) missing.push('Start date');
  if (!need.frequency) missing.push('Frequency (one-time, recurring, overflow or emergency)');
  if (num0(need.estimatedValue) <= 0) missing.push('Budget or estimated value');
  if (!need.currentProvider) missing.push('Current provider');
  if (!need.requiredCapabilities?.length) missing.push('Required capabilities');
  return missing;
}
