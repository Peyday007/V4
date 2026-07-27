import { prisma } from '@/lib/db';
import { getOrgConfig, type OrgConfig } from '@/lib/config';

export type ContactabilityCheck = {
  allowed: boolean;
  reasons: string[];
  recordingAllowed: boolean;
  recordingBasis: string;
  requiresAnnouncement: boolean;
};

/** Normalises to digits so suppression matching is not defeated by formatting. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length === 10 ? digits : digits || null;
}

function localHour(timezone: string, at: Date): { hour: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '12');
  const weekdayName = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour: hour === 24 ? 0 : hour, weekday: weekdayMap[weekdayName] ?? 1 };
}

export function withinCallingHours(
  timezone: string,
  at: Date,
  rules: OrgConfig['callingRules'],
): { ok: boolean; reason?: string } {
  const { hour, weekday } = localHour(timezone, at);
  if (!rules.allowedWeekdays.includes(weekday)) {
    return { ok: false, reason: `Outside permitted calling days (local weekday ${weekday})` };
  }
  if (hour < rules.earliestHourLocal || hour >= rules.latestHourLocal) {
    return {
      ok: false,
      reason: `Outside calling hours (local ${hour}:00, permitted ${rules.earliestHourLocal}:00–${rules.latestHourLocal}:00)`,
    };
  }
  return { ok: true };
}

/**
 * Single gate every outbound call passes through: suppression lists, consent,
 * calling hours, attempt limits, and jurisdiction-aware recording consent.
 */
export async function checkContactability(params: {
  orgId: string;
  contactId?: string | null;
  phone?: string | null;
  /** Two-letter state of the contact, used for recording-consent rules. */
  state?: string | null;
  at?: Date;
}): Promise<ContactabilityCheck> {
  const at = params.at ?? new Date();
  const config = await getOrgConfig(params.orgId);
  const reasons: string[] = [];

  const contact = params.contactId
    ? await prisma.contact.findFirst({
        where: { id: params.contactId, orgId: params.orgId },
        include: { company: { include: { locations: true } } },
      })
    : null;

  const phone = normalizePhone(params.phone ?? contact?.phone ?? contact?.mobile);
  if (!phone) reasons.push('No phone number on record');

  // Suppression: explicit do-not-call entries win over everything else.
  const suppressions = await prisma.suppressionEntry.findMany({
    where: {
      orgId: params.orgId,
      scope: { in: ['DO_NOT_CALL', 'DO_NOT_CONTACT'] },
      OR: [
        params.contactId ? { contactId: params.contactId } : { contactId: undefined },
        phone ? { phone } : { phone: undefined },
      ].filter(Boolean) as object[],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] }],
    },
  });
  if (suppressions.length > 0) {
    reasons.push(`Contact is suppressed: ${suppressions.map((s) => s.reason).join('; ')}`);
  }

  if (contact && !contact.consentToCall) reasons.push('Contact has withdrawn call consent');

  const timezone = contact?.timezone ?? 'America/New_York';
  const hours = withinCallingHours(timezone, at, config.callingRules);
  if (!hours.ok && hours.reason) reasons.push(hours.reason);

  // Recording consent. Where all-party consent applies, we require explicit
  // recorded consent from the contact; otherwise an announcement suffices.
  const state = params.state ?? contact?.company.locations.find((l) => l.isHeadquarters)?.state ?? null;
  const allPartyState = state ? config.callingRules.recordingRequiresBothPartyConsent.includes(state) : false;
  let recordingAllowed: boolean;
  let recordingBasis: string;
  if (allPartyState) {
    recordingAllowed = contact?.consentToRecord === true;
    recordingBasis = recordingAllowed
      ? `All-party consent state (${state}); explicit contact consent on file`
      : `All-party consent state (${state}); no explicit consent recorded — do not record`;
  } else {
    recordingAllowed = contact?.consentToRecord !== false;
    recordingBasis = recordingAllowed
      ? `Single-party consent jurisdiction${state ? ` (${state})` : ''}; announcement required`
      : 'Contact declined recording';
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    recordingAllowed,
    recordingBasis,
    requiresAnnouncement: recordingAllowed,
  };
}

export const RECORDING_ANNOUNCEMENT =
  'This call may be recorded for quality and record-keeping purposes. Please let me know if you would prefer that I not record.';

/** Records a do-not-call request captured during a conversation. */
export async function suppressContact(params: {
  orgId: string;
  contactId: string;
  scope: 'DO_NOT_CALL' | 'DO_NOT_EMAIL' | 'DO_NOT_SMS' | 'DO_NOT_CONTACT';
  reason: string;
  source?: string;
}): Promise<void> {
  const contact = await prisma.contact.findFirst({
    where: { id: params.contactId, orgId: params.orgId },
  });
  if (!contact) return;

  await prisma.suppressionEntry.create({
    data: {
      orgId: params.orgId,
      contactId: params.contactId,
      phone: normalizePhone(contact.phone),
      email: contact.email,
      scope: params.scope,
      reason: params.reason,
      source: params.source ?? 'call',
    },
  });

  await prisma.contact.update({
    where: { id: params.contactId },
    data: {
      consentToCall: params.scope === 'DO_NOT_CALL' || params.scope === 'DO_NOT_CONTACT' ? false : contact.consentToCall,
      consentToEmail: params.scope === 'DO_NOT_EMAIL' || params.scope === 'DO_NOT_CONTACT' ? false : contact.consentToEmail,
    },
  });

  await prisma.callAssignment.updateMany({
    where: { orgId: params.orgId, contactId: params.contactId, status: { in: ['PENDING', 'ASSIGNED'] } },
    data: { status: 'BLOCKED_BY_COMPLIANCE' },
  });
}
