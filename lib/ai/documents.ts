import type { DocumentKind } from '@prisma/client';
import { num, num0, prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { recordActivity } from '@/lib/audit';
import { recordDecision } from './decisions';

export const DOCUMENTS_VERSION = 'documents@2';

/**
 * Document kinds whose content creates real obligations. These are drafted by
 * the AI but never leave the building without a recorded human approval.
 */
export const APPROVAL_REQUIRED_KINDS: DocumentKind[] = [
  'QUOTE', 'PROPOSAL', 'STATEMENT_OF_WORK', 'PURCHASE_ORDER', 'CONTRACT', 'CHANGE_ORDER', 'FULFILLMENT_INSTRUCTIONS',
];

export type GeneratedDocument = { id: string; title: string; body: string; requiresApproval: boolean };

/**
 * Drafts a document from confirmed data.
 *
 * Where a figure is unknown, the draft says so in brackets rather than
 * inventing it. A document that quietly fills a gap with a plausible number is
 * how an operation ends up committed to terms nobody agreed to.
 */
export async function generateDocument(params: {
  orgId: string;
  opportunityId: string;
  kind: DocumentKind;
  generatedById?: string;
}): Promise<GeneratedDocument> {
  const opportunity = await prisma.opportunity.findFirstOrThrow({
    where: { id: params.opportunityId, orgId: params.orgId },
    include: {
      parties: { include: { company: { include: { contacts: true, locations: true } } } },
      buyerNeed: true,
      deal: true,
      matches: { include: { candidate: true }, orderBy: { score: 'desc' } },
      quotes: { include: { lineItems: true } },
      scores: { orderBy: { createdAt: 'desc' }, take: 1 },
      nextActions: { where: { isCurrent: true } },
      escalations: { where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } } },
    },
  });
  const config = await getOrgConfig(params.orgId);

  const buyer = opportunity.parties.find((p) => p.isPrimary)?.company ?? opportunity.parties[0]?.company ?? null;
  const selected = opportunity.matches.find((m) => m.isSelected) ?? opportunity.matches[0] ?? null;
  const unknown = (label: string) => `[${label} — NOT CONFIRMED, obtain before sending]`;

  let title: string;
  let body: string;

  switch (params.kind) {
    case 'OPPORTUNITY_BRIEF': {
      const score = opportunity.scores[0];
      title = `Opportunity brief — ${opportunity.name}`;
      body = [
        `# ${opportunity.name}`,
        '',
        `**Type:** ${opportunity.type} · **Stage:** ${opportunity.stage.replace(/_/g, ' ')} · **Status:** ${opportunity.status}`,
        `**Buyer / prime:** ${buyer?.legalName ?? unknown('Buyer')}`,
        `**Fulfillment candidate:** ${selected?.candidate.legalName ?? 'None identified'}`,
        `**Location:** ${opportunity.location ?? unknown('Location')}`,
        '',
        '## State of the deal',
        opportunity.aiExplanation ?? opportunity.summary,
        '',
        '## Economics',
        `- Estimated value: ${fmt(num(opportunity.estimatedValue))}`,
        `- Estimated gross profit: ${fmt(num(opportunity.estimatedGrossProfit))}`,
        `- Closing probability: ${(opportunity.closingProbability * 100).toFixed(0)}%`,
        `- Fulfillment confidence: ${(opportunity.fulfillmentConfidence * 100).toFixed(0)}%`,
        `- Expected value: ${fmt(num(opportunity.expectedValue))}`,
        '',
        '## What is confirmed',
        opportunity.buyerNeed
          ? `- Need is ${opportunity.buyerNeed.status.toLowerCase()}: ${opportunity.buyerNeed.scope}`
          : '- No confirmed buyer need yet.',
        selected ? `- Best candidate: ${selected.explanation}` : '- No fulfillment candidate confirmed.',
        '',
        '## What is missing',
        opportunity.missingInformation.length
          ? opportunity.missingInformation.map((m) => `- ${m}`).join('\n')
          : '- Nothing outstanding.',
        '',
        '## Blockers and escalations',
        opportunity.primaryBlocker ? `- Primary blocker: ${opportunity.primaryBlocker}` : '- No blocker recorded.',
        ...opportunity.escalations.map((e) => `- ESCALATION (${e.reason}): ${e.title}`),
        '',
        '## Next action',
        opportunity.nextActions[0]
          ? `**${opportunity.nextActions[0].type.replace(/_/g, ' ')}** — due ${opportunity.nextActions[0].dueDate.toISOString().slice(0, 10)}\n\n${opportunity.nextActions[0].reason}`
          : 'No next action set.',
        '',
        score ? `## Scoring rationale\n${(score.reasons as Array<{ dimension: string; because: string }>).map((r) => `- **${r.dimension}**: ${r.because}`).join('\n')}` : '',
      ].join('\n');
      break;
    }

    case 'SCOPE_REQUEST': {
      const contact = buyer?.contacts[0];
      title = `Scope request — ${buyer?.legalName ?? 'buyer'}`;
      body = [
        `Subject: ${opportunity.buyerNeed?.title ?? opportunity.name} — scope confirmation`,
        '',
        `${contact ? `${contact.firstName},` : 'Hello,'}`,
        '',
        `Following our conversation about ${opportunity.buyerNeed?.scope ?? unknown('scope')}, I want to make sure I have the details right before we price anything.`,
        '',
        'Could you confirm:',
        ...(opportunity.buyerNeed?.missingFields.length
          ? opportunity.buyerNeed.missingFields.map((f) => `- ${f}`)
          : ['- The full scope of work', '- All locations covered', '- Required start date', '- Any insurance or licensing requirements']),
        '',
        'Once I have that I will come back with a written scope and pricing. Nothing in this note is a quote or a commitment on either side.',
        '',
        'Thanks,',
      ].join('\n');
      break;
    }

    case 'PRICING_REQUEST': {
      const need = opportunity.buyerNeed;
      title = `Pricing request — ${selected?.candidate.legalName ?? 'supplier'}`;
      body = [
        `Subject: Pricing request — ${need?.title ?? opportunity.name}`,
        '',
        'Hello,',
        '',
        'We have a confirmed requirement and would like your pricing. Details:',
        '',
        `- Scope: ${need?.scope ?? unknown('Scope')}`,
        `- Location / delivery point: ${need?.location ?? unknown('Location')}`,
        `- Quantity: ${need?.quantity ? `${need.quantity} ${need.unit ?? ''}` : unknown('Quantity')}`,
        `- Required start / delivery: ${need?.startDate?.toISOString().slice(0, 10) ?? unknown('Date')}`,
        `- Frequency: ${need?.frequency ?? unknown('Frequency')}`,
        '',
        'Please include:',
        '1. Your unit price and total',
        '2. Whether the price is delivered or picked up, and the freight cost if separate',
        '3. Lead time',
        '4. How long the price holds',
        '5. Payment terms',
        '',
        'This is a request for pricing, not a purchase order or a commitment to buy.',
        '',
        'Thanks,',
      ].join('\n');
      break;
    }

    case 'SUBCONTRACTOR_INVITATION': {
      const need = opportunity.buyerNeed;
      title = `Subcontractor invitation — ${selected?.candidate.legalName ?? 'candidate'}`;
      body = [
        `Subject: Subcontract opportunity — ${need?.title ?? opportunity.name}`,
        '',
        'Hello,',
        '',
        `We have a ${need?.frequency ?? ''} requirement in ${need?.location ?? unknown('location')} and your firm looks like a fit.`,
        '',
        `**Scope:** ${need?.scope ?? unknown('Scope')}`,
        `**Start:** ${need?.startDate?.toISOString().slice(0, 10) ?? unknown('Start date')}`,
        `**Estimated value:** ${need?.estimatedValue ? fmt(num(need.estimatedValue)) : unknown('Value')}`,
        '',
        'To move forward we need:',
        '- Confirmation you have capacity for this scope and territory',
        '- Your certificate of insurance showing current limits',
        '- Applicable licence numbers',
        '- Your pricing for the scope above',
        '',
        'This is an invitation to price, not an award of work. No work is committed until a written agreement is executed.',
        '',
        'Thanks,',
      ].join('\n');
      break;
    }

    case 'SUBCONTRACTOR_COMPARISON':
    case 'SUPPLIER_COMPARISON': {
      title = `${params.kind === 'SUBCONTRACTOR_COMPARISON' ? 'Subcontractor' : 'Supplier'} comparison — ${opportunity.name}`;
      const rows = opportunity.matches.slice(0, 5);
      body = [
        `# Comparison for ${opportunity.name}`,
        '',
        `Buyer: ${buyer?.legalName ?? unknown('Buyer')}`,
        `Scope: ${opportunity.buyerNeed?.scope ?? unknown('Scope')}`,
        '',
        '| Candidate | Score | Est. cost | Est. GP | Fulfillment risk | Outstanding |',
        '|---|---|---|---|---|---|',
        ...rows.map(
          (m) =>
            `| ${m.candidate.legalName} | ${(m.score * 100).toFixed(0)}% | ${fmt(num(m.estimatedCost))} | ${fmt(num(m.estimatedGrossProfit))} | ${(m.fulfillmentRisk * 100).toFixed(0)}% | ${m.missingInformation.join(', ') || 'None'} |`,
        ),
        '',
        '## Notes on each candidate',
        ...rows.map((m) => `**${m.candidate.legalName}** — ${m.explanation}`),
        '',
        '_Match scores rank candidates for outreach. They are not evidence that a company is suitable, and they do not substitute for verifying insurance, licensing and capacity._',
      ].join('\n');
      break;
    }

    case 'INTERNAL_APPROVAL_SUMMARY': {
      const deal = opportunity.deal;
      title = `Approval summary — ${opportunity.name}`;
      body = [
        `# Approval requested: ${opportunity.name}`,
        '',
        `**Type:** ${opportunity.type} · **Buyer:** ${buyer?.legalName ?? unknown('Buyer')}`,
        `**Fulfillment partner:** ${selected?.candidate.legalName ?? unknown('Partner')}`,
        '',
        '## Economics',
        `- Buyer price: ${fmt(num(deal?.buyerPrice))}`,
        `- Supplier / subcontractor cost: ${fmt(num(deal?.supplierCost))}`,
        `- Freight: ${fmt(num(deal?.freightCost))}`,
        `- Gross profit: ${fmt(num(deal?.grossProfit))}`,
        `- Gross margin: ${deal?.grossMarginPct !== null && deal?.grossMarginPct !== undefined ? `${deal.grossMarginPct}%` : unknown('Margin')} (floor ${config.marginRules.minimumGrossMarginPct}%)`,
        '',
        '## Why this needs approval',
        deal?.requiredApprovals.length ? deal.requiredApprovals.map((a) => `- ${a}`).join('\n') : '- Routine review',
        '',
        '## Risks',
        deal?.risks.length ? deal.risks.map((r) => `- ${r}`).join('\n') : '- None recorded',
        '',
        '## Still unknown',
        deal?.missingTerms.length ? deal.missingTerms.map((t) => `- ${t}`).join('\n') : '- Nothing outstanding',
        '',
        '## Recommendation',
        deal?.isConfigurable
          ? 'The deal is fully configured from confirmed data and is ready for a decision.'
          : 'Do not approve yet — required terms are still unknown and are listed above.',
      ].join('\n');
      break;
    }

    case 'QUOTE': {
      const quote = opportunity.quotes.find((q) => q.direction === 'outbound');
      title = `Quote — ${buyer?.legalName ?? 'buyer'}`;
      body = [
        `# Quotation${quote ? ` ${quote.quoteNumber}` : ''}`,
        '',
        `**To:** ${buyer?.legalName ?? unknown('Buyer')}`,
        `**Date:** ${new Date().toISOString().slice(0, 10)}`,
        `**Valid until:** ${quote?.validUntil?.toISOString().slice(0, 10) ?? unknown('Validity date')}`,
        '',
        `**Scope:** ${opportunity.buyerNeed?.scope ?? unknown('Scope')}`,
        `**Location:** ${opportunity.buyerNeed?.location ?? unknown('Location')}`,
        '',
        '| Description | Qty | Unit | Unit price | Total |',
        '|---|---|---|---|---|',
        ...(quote?.lineItems.length
          ? quote.lineItems.map((li) => `| ${li.description} | ${num0(li.quantity)} | ${li.unit} | ${fmt(num(li.unitPrice))} | ${fmt(num(li.lineTotal))} |`)
          : [`| ${unknown('Line items')} | | | | |`]),
        '',
        `**Subtotal:** ${fmt(num(quote?.subtotal))}`,
        `**Freight:** ${fmt(num(quote?.freight))}`,
        `**Total:** ${fmt(num(quote?.total))}`,
        '',
        '## Terms',
        '- Pricing is valid until the date shown above.',
        '- Work is scheduled on written acceptance.',
        `- Payment terms: ${unknown('Payment terms')}`,
        '',
        '_This quotation requires internal approval before it is issued._',
      ].join('\n');
      break;
    }

    case 'BUYER_FOLLOW_UP':
    case 'QUOTE_FOLLOW_UP': {
      const contact = buyer?.contacts[0];
      const quote = opportunity.quotes.find((q) => q.direction === 'outbound');
      title = `Follow-up — ${buyer?.legalName ?? 'buyer'}`;
      body = [
        `Subject: Following up on ${quote ? `quote ${quote.quoteNumber}` : opportunity.name}`,
        '',
        `${contact ? `${contact.firstName},` : 'Hello,'}`,
        '',
        quote?.sentAt
          ? `I sent our quote on ${quote.sentAt.toISOString().slice(0, 10)} and wanted to check it reached you.`
          : 'I wanted to follow up on our conversation.',
        '',
        'Two quick questions:',
        '1. Does the scope match what you need?',
        '2. Is there anything about the pricing or terms you would want to see structured differently?',
        '',
        'If the timing is not right, tell me when to come back and I will.',
        '',
        'Thanks,',
      ].join('\n');
      break;
    }

    case 'STATEMENT_OF_WORK': {
      const deal = opportunity.deal;
      const configuration = (deal?.configuration ?? {}) as Record<string, unknown>;
      title = `Statement of work — ${opportunity.name}`;
      body = [
        '# Statement of Work',
        '',
        `**Client:** ${buyer?.legalName ?? unknown('Client')}`,
        `**Provider:** ${selected?.candidate.legalName ?? unknown('Provider')}`,
        `**Effective:** ${opportunity.buyerNeed?.startDate?.toISOString().slice(0, 10) ?? unknown('Start date')}`,
        '',
        '## Scope',
        String(configuration.scope ?? opportunity.buyerNeed?.scope ?? unknown('Scope')),
        '',
        '## Location',
        String(configuration.location ?? opportunity.buyerNeed?.location ?? unknown('Location')),
        '',
        '## Schedule',
        `Start: ${opportunity.buyerNeed?.startDate?.toISOString().slice(0, 10) ?? unknown('Start')}`,
        `Frequency: ${opportunity.buyerNeed?.frequency ?? unknown('Frequency')}`,
        '',
        '## Insurance and licensing',
        `Required: ${JSON.stringify(opportunity.buyerNeed?.insuranceRequirement ?? {})}`,
        `Provider on file: ${JSON.stringify(configuration.insurance ?? {})}`,
        '',
        '## Commercial terms',
        `Price: ${fmt(num(deal?.buyerPrice))}`,
        `Payment timing: ${unknown('Payment terms')}`,
        '',
        '_Draft. Requires legal and management approval before execution._',
      ].join('\n');
      break;
    }

    default: {
      title = `${params.kind.replace(/_/g, ' ')} — ${opportunity.name}`;
      body = [
        `# ${params.kind.replace(/_/g, ' ')}`,
        '',
        `Opportunity: ${opportunity.name}`,
        `Buyer: ${buyer?.legalName ?? unknown('Buyer')}`,
        '',
        opportunity.summary,
        '',
        '## Outstanding information',
        opportunity.missingInformation.map((m) => `- ${m}`).join('\n') || '- None',
      ].join('\n');
    }
  }

  const requiresApproval = APPROVAL_REQUIRED_KINDS.includes(params.kind);

  const document = await prisma.document.create({
    data: {
      orgId: params.orgId,
      opportunityId: params.opportunityId,
      dealId: opportunity.deal?.id ?? null,
      companyId: buyer?.id ?? null,
      kind: params.kind,
      status: requiresApproval ? 'PENDING_APPROVAL' : 'DRAFT',
      title,
      body,
      requiresApproval,
      generatedBy: params.generatedById ? 'user' : 'ai',
      modelVersion: DOCUMENTS_VERSION,
    },
  });

  if (requiresApproval) {
    await prisma.approval.create({
      data: {
        orgId: params.orgId,
        opportunityId: params.opportunityId,
        dealId: opportunity.deal?.id ?? null,
        documentId: document.id,
        type: params.kind === 'CONTRACT' ? 'CONTRACT_EXECUTION' : params.kind === 'QUOTE' ? 'PRICING' : 'DOCUMENT_SEND',
        title: `Approve: ${title}`,
        summary: `A ${params.kind.replace(/_/g, ' ').toLowerCase()} has been drafted and cannot be sent without approval.`,
        amount: num(opportunity.deal?.buyerPrice),
        requiredRole: 'DEAL_MANAGER',
      },
    });
  }

  await recordDecision({
    orgId: params.orgId,
    opportunityId: params.opportunityId,
    process: 'document_generation',
    decision: `Drafted ${params.kind}`,
    reason: requiresApproval
      ? 'Document creates a commitment and is held pending approval.'
      : 'Informational document drafted from confirmed data.',
    outputs: { documentId: document.id, requiresApproval },
    confidence: 0.7,
    rulesApplied: ['no_fabricated_terms', 'approval_required_kinds'],
    modelName: 'deterministic',
    promptVersion: DOCUMENTS_VERSION,
  });

  await recordActivity({
    orgId: params.orgId,
    opportunityId: params.opportunityId,
    verb: 'document.drafted',
    summary: `${params.kind.replace(/_/g, ' ').toLowerCase()} drafted${requiresApproval ? ' (approval required)' : ''}`,
    payload: { documentId: document.id },
  });

  return { id: document.id, title, body, requiresApproval };
}

function fmt(value: number | null): string {
  if (value === null) return '[not confirmed]';
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
