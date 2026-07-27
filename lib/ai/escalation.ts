import type { EscalationReason, Priority } from '@prisma/client';
import { num0, prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { recordActivity } from '@/lib/audit';
import { recordDecision } from './decisions';

export const ESCALATION_VERSION = 'escalation@2';

export type RaiseEscalationInput = {
  orgId: string;
  opportunityId?: string | null;
  reason: EscalationReason;
  title: string;
  detail: string;
  severity?: Priority;
  evidence?: unknown[];
  raisedById?: string | null;
  raisedByProcess?: string;
};

/** Raises an escalation, de-duplicating against an open one of the same kind. */
export async function raiseEscalation(input: RaiseEscalationInput): Promise<string | null> {
  const existing = await prisma.escalation.findFirst({
    where: {
      orgId: input.orgId,
      opportunityId: input.opportunityId ?? undefined,
      reason: input.reason,
      status: { in: ['OPEN', 'ACKNOWLEDGED'] },
    },
  });
  if (existing) return existing.id;

  const escalation = await prisma.escalation.create({
    data: {
      orgId: input.orgId,
      opportunityId: input.opportunityId ?? null,
      reason: input.reason,
      severity: input.severity ?? 'HIGH',
      title: input.title,
      detail: input.detail,
      evidence: (input.evidence ?? []) as object,
      raisedById: input.raisedById ?? null,
      raisedByProcess: input.raisedByProcess ?? 'ai',
    },
  });

  if (input.opportunityId) {
    await prisma.opportunity.update({
      where: { id: input.opportunityId },
      data: { status: 'ESCALATED', primaryBlocker: input.title },
    });
    await recordActivity({
      orgId: input.orgId,
      opportunityId: input.opportunityId,
      verb: 'escalation.raised',
      summary: input.title,
      payload: { reason: input.reason, escalationId: escalation.id },
    });
  }

  // Notify everyone who can actually resolve it.
  const managers = await prisma.user.findMany({
    where: { orgId: input.orgId, isActive: true, role: { key: { in: ['OWNER', 'DEAL_MANAGER', 'FINANCE_COMPLIANCE'] } } },
    select: { id: true },
  });
  await prisma.notification.createMany({
    data: managers.map((m) => ({
      orgId: input.orgId,
      userId: m.id,
      kind: 'escalation',
      title: input.title,
      body: input.detail.slice(0, 400),
      link: input.opportunityId ? `/opportunities/${input.opportunityId}` : '/escalations',
    })),
  });

  await recordDecision({
    orgId: input.orgId,
    opportunityId: input.opportunityId,
    process: 'escalation',
    decision: `Escalated: ${input.reason}`,
    reason: input.detail,
    confidence: 0.9,
    rulesApplied: ['governance_escalation_rules'],
    modelName: 'deterministic',
    promptVersion: ESCALATION_VERSION,
  });

  return escalation.id;
}

/**
 * Governance sweep (spec §26). Runs over a deal's current state and raises
 * everything that requires human judgement before the deal can move.
 */
export async function evaluateGovernance(opportunityId: string): Promise<string[]> {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    include: {
      deal: { include: { margins: true } },
      matches: { where: { isSelected: true }, include: { candidate: true } },
      buyerNeed: true,
      quotes: true,
      commitments: true,
      scores: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  const config = await getOrgConfig(opportunity.orgId);
  const raised: string[] = [];

  const add = async (reason: EscalationReason, title: string, detail: string, severity: Priority = 'HIGH') => {
    const id = await raiseEscalation({ orgId: opportunity.orgId, opportunityId, reason, title, detail, severity });
    if (id) raised.push(id);
  };

  const deal = opportunity.deal;
  const score = opportunity.scores[0];

  if (deal) {
    const value = num0(deal.buyerPrice);
    const gp = num0(deal.grossProfit);
    const marginPct = deal.grossMarginPct ?? (value > 0 ? (gp / value) * 100 : 0);

    // A configured deal over the limit needs an actual approval record, not
    // only an escalation. The escalation tells a manager to look; the approval
    // is the decision the deal cannot proceed without.
    if (deal.isConfigurable && deal.requiredApprovals.length > 0) {
      await ensureDealApproval(opportunity.orgId, opportunityId, deal.id, {
        value,
        grossProfit: gp,
        marginPct,
        reasons: deal.requiredApprovals,
        opportunityName: opportunity.name,
        belowFloor: marginPct < config.marginRules.minimumGrossMarginPct,
      });
    }

    if (value > 0 && marginPct < config.marginRules.minimumGrossMarginPct) {
      await add(
        'MARGIN_BELOW_THRESHOLD',
        `Margin ${marginPct.toFixed(1)}% is below the ${config.marginRules.minimumGrossMarginPct}% floor`,
        `Buyer price $${value.toFixed(0)} against costs of $${(value - gp).toFixed(0)} yields ${marginPct.toFixed(1)}% gross margin. ` +
          'The deal cannot proceed at this margin without an explicit exception.',
      );
    }
    if (value > config.approvalLimits.dealValueRequiringApproval) {
      await add(
        'CONTRACT_VALUE_LIMIT',
        `Deal value $${value.toFixed(0)} exceeds the $${config.approvalLimits.dealValueRequiringApproval} approval limit`,
        'Contract value requires management approval before terms are communicated externally.',
      );
    }
    if (opportunity.type === 'DISTRIBUTION' && num0(deal.supplierCost) > config.approvalLimits.cashExposureLimit) {
      await add(
        'CASH_EXPOSURE',
        `Cash exposure $${num0(deal.supplierCost).toFixed(0)} exceeds the configured limit`,
        'Inventory must be purchased before customer payment is collected. Finance review required.',
      );
    }
    if (deal.missingTerms.length > 0) {
      await add(
        'UNCLEAR_SPECIFICATION',
        `${deal.missingTerms.length} deal term(s) still unknown`,
        `Cannot be finalised without: ${deal.missingTerms.join(', ')}.`,
        'MEDIUM',
      );
    }
  }

  const selected = opportunity.matches[0];
  if (selected) {
    const insuranceGap = selected.missingInformation.some((m) => /insurance|certificate/i.test(m));
    const licenceGap = selected.missingInformation.some((m) => /licen/i.test(m));
    if (insuranceGap) {
      await add(
        'INSUFFICIENT_INSURANCE',
        `Insurance not verified for ${selected.candidate.legalName}`,
        'The selected fulfillment partner has no verified certificate of insurance on file. Do not release work.',
      );
    }
    if (licenceGap) {
      await add(
        'INSUFFICIENT_LICENSING',
        `Licensing not verified for ${selected.candidate.legalName}`,
        'The scope requires licensure and the candidate licence has not been verified with the issuing authority.',
      );
    }
  }

  const unauthorized = opportunity.commitments.filter((c) => !c.isAuthorized);
  if (unauthorized.length > 0) {
    await add(
      'UNAUTHORIZED_COMMITMENT',
      `${unauthorized.length} unauthorised commitment(s) made on a call`,
      unauthorized.map((c) => `• ${c.text}`).join('\n'),
      'CRITICAL',
    );
  }

  if (score && score.compositeScore < 0.25 && opportunity.informationCompleteness < 0.3) {
    await add(
      'LOW_CONFIDENCE',
      'Too little confirmed information to act safely',
      `Composite score ${score.compositeScore.toFixed(2)} with ${(opportunity.informationCompleteness * 100).toFixed(0)}% information completeness. ` +
        `Outstanding: ${opportunity.missingInformation.join(', ')}.`,
      'MEDIUM',
    );
  }

  // Contradicted facts mean two sources disagree — a person must adjudicate.
  const contradicted = await prisma.extractedFact.count({ where: { opportunityId, status: 'CONTRADICTED' } });
  if (contradicted > 0) {
    await add(
      'CONFLICTING_INFORMATION',
      `${contradicted} contradicted fact(s) on this opportunity`,
      'Two sources disagree on a material fact. Review the fact ledger and confirm which is correct before proceeding.',
    );
  }

  return raised;
}

/**
 * Creates (once) the pending approval a configured deal needs before its terms
 * can go anywhere. Idempotent so repeated governance sweeps do not stack
 * duplicate decisions in front of a manager.
 */
async function ensureDealApproval(
  orgId: string,
  opportunityId: string,
  dealId: string,
  detail: {
    value: number;
    grossProfit: number;
    marginPct: number;
    reasons: string[];
    opportunityName: string;
    belowFloor: boolean;
  },
): Promise<void> {
  const existing = await prisma.approval.findFirst({
    where: { orgId, dealId, type: { in: ['DEAL_TERMS', 'MARGIN_EXCEPTION'] }, status: 'PENDING' },
  });
  if (existing) return;

  await prisma.approval.create({
    data: {
      orgId,
      opportunityId,
      dealId,
      type: detail.belowFloor ? 'MARGIN_EXCEPTION' : 'DEAL_TERMS',
      title: `Approve deal terms — ${detail.opportunityName}`,
      summary:
        `Buyer price $${detail.value.toLocaleString()}, gross profit $${detail.grossProfit.toLocaleString()} ` +
        `(${detail.marginPct.toFixed(1)}% margin). Triggered by: ${detail.reasons.join('; ')}. ` +
        'No pricing, scope or terms may be communicated externally until this is decided.',
      amount: detail.value,
      requiredRole: 'DEAL_MANAGER',
    },
  });

  const managers = await prisma.user.findMany({
    where: { orgId, isActive: true, role: { key: { in: ['OWNER', 'DEAL_MANAGER'] } } },
    select: { id: true },
  });
  await prisma.notification.createMany({
    data: managers.map((m) => ({
      orgId,
      userId: m.id,
      kind: 'approval',
      title: `Approval needed: ${detail.opportunityName}`,
      body: `$${detail.value.toLocaleString()} deal awaiting a decision.`,
      link: '/approvals',
    })),
  });
}
