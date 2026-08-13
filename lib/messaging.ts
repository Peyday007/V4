import type { CallType, MessageChannel } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { audit, recordActivity } from '@/lib/audit';
import { normalizePhone, withinCallingHours } from '@/lib/compliance';
import { countSegments, getSms } from '@/lib/providers/sms';
import { assertProductionOnly } from '@/lib/safety/outbound';
import { getEmail } from '@/lib/providers/email';
import { recordDecision } from '@/lib/ai/decisions';
import { smsCost } from '@/lib/ai/outreach';

export type MessagingCheck = { allowed: boolean; reasons: string[] };

/**
 * Whether a contact may be texted right now.
 *
 * Deliberately stricter than the call gate. Calling a business number is
 * generally permitted; texting one is not, absent prior express consent —
 * and an SMS arrives with a notification at whatever hour it lands, which is
 * why the quiet-hours window here is narrower than calling hours.
 */
export async function checkSmsAllowed(params: {
  orgId: string;
  contactId: string;
  at?: Date;
}): Promise<MessagingCheck> {
  const at = params.at ?? new Date();
  const config = await getOrgConfig(params.orgId);
  const reasons: string[] = [];

  const contact = await prisma.contact.findFirst({
    where: { id: params.contactId, orgId: params.orgId },
  });
  if (!contact) return { allowed: false, reasons: ['Contact not found'] };

  const phone = normalizePhone(contact.mobile ?? contact.phone);
  if (!phone) reasons.push('No mobile number on record');
  if (!contact.hasMobile) {
    reasons.push('Number is not confirmed mobile — SMS to a landline is silently discarded and still billed');
  }
  if (config.outreachRules.smsRequiresOptIn && !contact.consentToSms) {
    reasons.push('No SMS opt-in on file. Texting without prior express consent is not permitted.');
  }

  const suppressed = await prisma.suppressionEntry.findFirst({
    where: {
      orgId: params.orgId,
      scope: { in: ['DO_NOT_SMS', 'DO_NOT_CONTACT'] },
      OR: [{ contactId: params.contactId }, phone ? { phone } : { phone: undefined }].filter(Boolean) as object[],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] }],
    },
  });
  if (suppressed) reasons.push(`Suppressed for SMS: ${suppressed.reason}`);

  const hours = withinCallingHours(contact.timezone, at, {
    ...config.callingRules,
    earliestHourLocal: config.outreachRules.smsEarliestHourLocal,
    latestHourLocal: config.outreachRules.smsLatestHourLocal,
  });
  if (!hours.ok && hours.reason) reasons.push(hours.reason.replace('calling', 'texting'));

  // Frequency: a text is easy to send and easy to resent.
  const weekAgo = new Date(at.getTime() - 7 * 86_400_000);
  const recent = await prisma.message.count({
    where: { orgId: params.orgId, contactId: params.contactId, channel: 'SMS', direction: 'outbound', sentAt: { gte: weekAgo } },
  });
  if (recent >= config.outreachRules.maxSmsPerContactPerWeek) {
    reasons.push(`Already texted ${recent} time(s) this week, at the configured limit of ${config.outreachRules.maxSmsPerContactPerWeek}`);
  }

  return { allowed: reasons.length === 0, reasons };
}

const OPT_OUT_FOOTER = ' Reply STOP to opt out.';

/** Sends an SMS through the compliance gate and records it for comparison. */
export async function sendSms(params: {
  orgId: string;
  contactId: string;
  body: string;
  purpose: CallType;
  opportunityId?: string | null;
  senderId?: string | null;
}): Promise<{ messageId: string; segments: number; costCents: number }> {
  // Before consent, before suppression, before anything: a sandbox record does
  // not send. Practice must never put a message in front of a real person.
  await assertProductionOnly({ contactId: params.contactId }, 'sending an SMS');

  const check = await checkSmsAllowed({ orgId: params.orgId, contactId: params.contactId });
  if (!check.allowed) {
    await recordDecision({
      orgId: params.orgId,
      opportunityId: params.opportunityId,
      process: 'messaging',
      decision: 'SMS not sent',
      reason: check.reasons.join('; '),
      confidence: 0.95,
      rulesApplied: ['sms_opt_in', 'sms_quiet_hours', 'sms_frequency_cap', 'suppression_list'],
      modelName: 'deterministic',
      promptVersion: 'messaging@1',
    });
    throw new Error(`SMS blocked: ${check.reasons.join('; ')}`);
  }

  const config = await getOrgConfig(params.orgId);
  const contact = await prisma.contact.findFirstOrThrow({ where: { id: params.contactId, orgId: params.orgId } });
  const to = contact.mobile ?? contact.phone;
  if (!to) throw new Error('No mobile number on record');

  // Every outbound message carries an opt-out. Omitting it is both a
  // compliance problem and the reason people report messages as spam.
  const body = params.body.includes('STOP') ? params.body : params.body.trimEnd() + OPT_OUT_FOOTER;
  const segments = countSegments(body);

  const result = await getSms().send({ to, body, metadata: { orgId: params.orgId, contactId: params.contactId } });

  const message = await prisma.message.create({
    data: {
      orgId: params.orgId,
      opportunityId: params.opportunityId ?? null,
      contactId: params.contactId,
      companyId: contact.companyId,
      senderId: params.senderId ?? null,
      channel: 'SMS',
      direction: 'outbound',
      status: result.status === 'failed' ? 'FAILED' : 'SENT',
      purpose: params.purpose,
      body,
      provider: getSms().name,
      providerMessageId: result.providerMessageId,
      sentAt: new Date(),
      outcome: result.status === 'failed' ? 'UNDELIVERABLE' : 'AWAITING_RESPONSE',
      segments,
      costCents: smsCost(segments, config.outreachCosts) * 100,
    },
  });

  await recordActivity({
    orgId: params.orgId,
    opportunityId: params.opportunityId ?? null,
    companyId: contact.companyId,
    contactId: params.contactId,
    userId: params.senderId ?? null,
    actorType: params.senderId ? 'user' : 'ai',
    verb: 'sms.sent',
    summary: `SMS sent (${segments} segment(s)): ${body.slice(0, 120)}`,
    payload: { messageId: message.id, purpose: params.purpose },
  });

  await audit({
    orgId: params.orgId,
    userId: params.senderId ?? null,
    action: 'sms.sent',
    entityType: 'Message',
    entityId: message.id,
    metadata: { purpose: params.purpose, segments },
  });

  return { messageId: message.id, segments, costCents: message.costCents };
}

const OPT_OUT_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|remove)\b/i;
const POSITIVE = /\b(yes|yep|yeah|sure|ok|okay|sounds good|interested|send it|please do|we do|available|can do)\b/i;
const NEGATIVE = /\b(no|not interested|no thanks|nope|all set|we're good|pass|already have|don'?t need)\b/i;

/**
 * Records an inbound reply and classifies it.
 *
 * The classification is what makes channel comparison meaningful: a delivered
 * message that nobody answered is not a success, and counting sends would make
 * SMS look infinitely better than calling.
 */
export async function recordInboundSms(params: {
  orgId: string;
  fromNumber: string;
  body: string;
  receivedAt?: Date;
}): Promise<{ matched: boolean; optedOut: boolean }> {
  const receivedAt = params.receivedAt ?? new Date();
  const phone = normalizePhone(params.fromNumber);
  if (!phone) return { matched: false, optedOut: false };

  const contacts = await prisma.contact.findMany({ where: { orgId: params.orgId } });
  const contact = contacts.find((c) => normalizePhone(c.mobile) === phone || normalizePhone(c.phone) === phone);
  if (!contact) return { matched: false, optedOut: false };

  const optedOut = OPT_OUT_WORDS.test(params.body);
  const outcome = optedOut
    ? 'OPTED_OUT'
    : POSITIVE.test(params.body) && !NEGATIVE.test(params.body)
      ? 'REPLIED_POSITIVE'
      : NEGATIVE.test(params.body)
        ? 'REPLIED_NEGATIVE'
        : 'REPLIED_NEUTRAL';

  const original = await prisma.message.findFirst({
    where: { orgId: params.orgId, contactId: contact.id, channel: 'SMS', direction: 'outbound', repliedAt: null },
    orderBy: { sentAt: 'desc' },
  });

  await prisma.message.create({
    data: {
      orgId: params.orgId,
      contactId: contact.id,
      companyId: contact.companyId,
      opportunityId: original?.opportunityId ?? null,
      channel: 'SMS',
      direction: 'inbound',
      status: 'RECEIVED',
      purpose: original?.purpose ?? null,
      body: params.body,
      outcome,
      sentAt: receivedAt,
    },
  });

  if (original) {
    await prisma.message.update({
      where: { id: original.id },
      data: {
        outcome,
        repliedAt: receivedAt,
        inboundBody: params.body.slice(0, 1000),
        responseTimeSec: original.sentAt ? Math.round((receivedAt.getTime() - original.sentAt.getTime()) / 1000) : null,
      },
    });
  }

  if (optedOut) {
    await prisma.suppressionEntry.create({
      data: {
        orgId: params.orgId,
        contactId: contact.id,
        phone,
        scope: 'DO_NOT_SMS',
        reason: `Replied "${params.body.trim().slice(0, 40)}"`,
        source: 'sms_reply',
      },
    });
    await prisma.contact.update({ where: { id: contact.id }, data: { consentToSms: false } });
  }

  await recordActivity({
    orgId: params.orgId,
    opportunityId: original?.opportunityId ?? null,
    companyId: contact.companyId,
    contactId: contact.id,
    verb: optedOut ? 'sms.opted_out' : 'sms.replied',
    summary: `${optedOut ? 'Opt-out' : 'Reply'} received: ${params.body.slice(0, 140)}`,
    payload: { outcome },
  });

  return { matched: true, optedOut };
}

/** Marks messages that were never answered, so they count against the channel. */
export async function ageOutUnansweredMessages(orgId: string, afterHours = 72): Promise<number> {
  const cutoff = new Date(Date.now() - afterHours * 3_600_000);
  const result = await prisma.message.updateMany({
    where: { orgId, direction: 'outbound', outcome: 'AWAITING_RESPONSE', sentAt: { lt: cutoff } },
    data: { outcome: 'NO_RESPONSE' },
  });
  return result.count;
}

/** Sends an email through the shared provider and records it comparably. */
export async function sendEmailMessage(params: {
  orgId: string;
  contactId: string;
  subject: string;
  body: string;
  purpose: CallType;
  opportunityId?: string | null;
  senderId?: string | null;
}): Promise<{ messageId: string }> {
  await assertProductionOnly({ contactId: params.contactId }, 'sending an email');

  const contact = await prisma.contact.findFirstOrThrow({ where: { id: params.contactId, orgId: params.orgId } });
  if (!contact.email) throw new Error('No email address on record');
  if (!contact.consentToEmail) throw new Error('Contact has withdrawn email consent');

  const suppressed = await prisma.suppressionEntry.findFirst({
    where: { orgId: params.orgId, contactId: params.contactId, scope: { in: ['DO_NOT_EMAIL', 'DO_NOT_CONTACT'] } },
  });
  if (suppressed) throw new Error(`Suppressed for email: ${suppressed.reason}`);

  const config = await getOrgConfig(params.orgId);
  const result = await getEmail().send({ to: contact.email, subject: params.subject, body: params.body });

  const message = await prisma.message.create({
    data: {
      orgId: params.orgId,
      opportunityId: params.opportunityId ?? null,
      contactId: params.contactId,
      companyId: contact.companyId,
      senderId: params.senderId ?? null,
      channel: 'EMAIL',
      direction: 'outbound',
      status: 'SENT',
      purpose: params.purpose,
      subject: params.subject,
      body: params.body,
      provider: getEmail().name,
      providerMessageId: result.providerMessageId,
      sentAt: new Date(),
      outcome: 'AWAITING_RESPONSE',
      costCents: config.outreachCosts.emailPerMessage * 100,
    },
  });

  return { messageId: message.id };
}

export type { MessageChannel };
