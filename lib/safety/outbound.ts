import { prisma } from '@/lib/db';

/**
 * Nothing sandbox ever leaves the building.
 *
 * The isolation triggers stop test and production data mixing *inside* the
 * database. This is the other half: the moment where a record turns into an
 * action in the world — a phone ringing, an email arriving, a directory being
 * queried, a webhook firing. A test fixture reaching one of those is worse than
 * a mixed row, because it cannot be rolled back. "+1 555 0100" is not a real
 * number today, but the sandbox exists so an owner can practise, and practice
 * against a record somebody later edits into a real phone number is exactly the
 * accident this prevents.
 *
 * The guard is deliberately one function with one name. A wiring test scans
 * every file that calls a provider's `send`, `placeCall` or lookup and asserts
 * it also calls `assertProductionOnly` — so an entry point added next year
 * fails the suite rather than quietly becoming the first way out.
 *
 * It resolves the mode from the database rather than trusting a caller's
 * parameter. A boolean passed down through four layers is a boolean that will
 * eventually arrive wrong.
 */

export class SandboxBlockedError extends Error {
  readonly statusCode = 422;
  constructor(readonly action: string, readonly subject: string) {
    super(
      `Refused: ${action} was asked to act on ${subject}, which is sandbox data. `
      + 'Practice records never produce a real call, message, lookup or webhook. '
      + 'Nothing was sent and nothing was recorded as sent.',
    );
    this.name = 'SandboxBlockedError';
  }
}

/** Anything that can identify the record an outbound action is about. */
export type OutboundSubject = {
  routeId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  sessionId?: string | null;
  roomId?: string | null;
  packetItemId?: string | null;
};

/**
 * Refuse when any identified record is sandbox data.
 *
 * Every identifier given is checked, not the first one that resolves: an email
 * addressed to a production contact *about* a test route is still an email
 * about an invented company, and refusing only on the contact would let it
 * through.
 */
export async function assertProductionOnly(
  subject: OutboundSubject,
  action: string,
): Promise<void> {
  const offenders: string[] = [];

  if (subject.routeId) {
    const route = await prisma.routeHypothesis.findUnique({
      where: { id: subject.routeId },
      select: { dataMode: true },
    });
    if (route?.dataMode === 'TEST') offenders.push('a test opportunity');
  }

  if (subject.companyId) {
    const company = await prisma.company.findUnique({
      where: { id: subject.companyId },
      select: { dataMode: true },
    });
    if (company?.dataMode === 'TEST') offenders.push('a test company');
  }

  if (subject.contactId) {
    const contact = await prisma.contact.findUnique({
      where: { id: subject.contactId },
      select: { company: { select: { dataMode: true } } },
    });
    if (contact?.company?.dataMode === 'TEST') offenders.push('a contact at a test company');
  }

  if (subject.sessionId) {
    const session = await prisma.callSession.findUnique({
      where: { id: subject.sessionId },
      select: { route: { select: { dataMode: true } } },
    });
    if (session?.route?.dataMode === 'TEST') offenders.push('a call on a test opportunity');
  }

  if (subject.roomId) {
    const room = await prisma.dealRoom.findUnique({
      where: { id: subject.roomId },
      select: { route: { select: { dataMode: true } } },
    });
    if (room?.route?.dataMode === 'TEST') offenders.push('a deal room for a test opportunity');
  }

  if (subject.packetItemId) {
    const item = await prisma.packetItem.findUnique({
      where: { id: subject.packetItemId },
      select: { dataMode: true },
    });
    if (item?.dataMode === 'TEST') offenders.push('a test packet item');
  }

  if (offenders.length > 0) {
    throw new SandboxBlockedError(action, offenders.join(' and '));
  }
}

/**
 * The same question, answered rather than thrown.
 *
 * For paths that need to *degrade* instead of failing — a caller working the
 * sandbox should still see a call screen, with the dialler visibly inert,
 * rather than an error.
 */
export async function isSandbox(subject: OutboundSubject): Promise<boolean> {
  try {
    await assertProductionOnly(subject, 'check');
    return false;
  } catch (error) {
    if (error instanceof SandboxBlockedError) return true;
    throw error;
  }
}
