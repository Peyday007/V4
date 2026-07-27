import { prisma } from '@/lib/db';

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[redacted:api-key]'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, 'Bearer [redacted]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted:ssn]'],
  [/\b(?:\d[ -]*?){13,16}\b/g, '[redacted:card]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted:email]'],
];

/** Strip secrets and obvious sensitive identifiers before logging. */
export function redactForLogs(input: string): string {
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), input);
}

export function detectSensitiveData(text: string): string[] {
  const hits: string[] = [];
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) hits.push('possible_ssn');
  if (/\b(?:\d[ -]*?){13,16}\b/.test(text)) hits.push('possible_payment_card');
  if (/\brouting\s*(?:number|#)\b/i.test(text)) hits.push('possible_bank_routing');
  if (/\baccount\s*(?:number|#)\s*[:#]?\s*\d{6,}/i.test(text)) hits.push('possible_bank_account');
  if (/\bpassword\b\s*(?:is|:)/i.test(text)) hits.push('possible_credential');
  return hits;
}

export type AuditInput = {
  orgId: string;
  userId?: string | null;
  actorType?: 'user' | 'ai' | 'system';
  action: string;
  entityType: string;
  entityId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
};

/** Append-only. Audit writes must never block the caller's primary result. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        orgId: input.orgId,
        userId: input.userId ?? null,
        actorType: input.actorType ?? 'user',
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  } catch (error) {
    console.error('[audit] failed to write audit event', redactForLogs(String(error)));
  }
}

export type ActivityInput = {
  orgId: string;
  opportunityId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  userId?: string | null;
  actorType?: 'user' | 'ai' | 'system';
  verb: string;
  summary: string;
  payload?: Record<string, unknown>;
};

export async function recordActivity(input: ActivityInput): Promise<void> {
  await prisma.activityEvent.create({
    data: {
      orgId: input.orgId,
      opportunityId: input.opportunityId ?? null,
      companyId: input.companyId ?? null,
      contactId: input.contactId ?? null,
      userId: input.userId ?? null,
      actorType: input.actorType ?? 'ai',
      verb: input.verb,
      summary: input.summary,
      payload: (input.payload ?? {}) as object,
    },
  });
  if (input.opportunityId) {
    await prisma.opportunity.update({
      where: { id: input.opportunityId },
      data: { lastActivityAt: new Date() },
    });
  }
}
