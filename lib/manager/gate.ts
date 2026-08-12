import type { WorkCapability } from '@prisma/client';
import { prisma } from '@/lib/db';
import { CAPABILITY_LABELS } from './rules';

/**
 * The one function that makes any of this real.
 *
 * A restriction that exists only as a row on a manager's screen is not a
 * restriction, and a circuit breaker nobody consults is a log line. This is
 * called at the routes that actually perform the work, and it is the reason
 * the rest of the layer is worth writing.
 *
 * Two different refusals come out of here and they must never be confused,
 * because they say opposite things about the person reading them:
 *
 *   `system` — the capability is stopped for everybody. Nobody is in trouble,
 *   the work is not lost, and somebody is fixing it. Phrased so a caller who
 *   hits it at nine in the morning knows immediately that their day is not
 *   their fault.
 *
 *   `restricted` — this person, this capability, with the reason and the way
 *   back out of it in the same sentence. A restriction that does not say how it
 *   ends is a suspension nobody authorised.
 */

export type GateVerdict = {
  allowed: boolean;
  kind: 'ok' | 'system' | 'restricted';
  /** Shown to whoever hit it, in full. */
  message: string;
  capability: WorkCapability;
  /** Set for a restriction, so the screen can show the way out. */
  restorationRule?: string | null;
  since?: Date | null;
};

export async function capabilityGate(params: {
  orgId: string;
  userId: string;
  capability: WorkCapability;
  now?: Date;
}): Promise<GateVerdict> {
  const now = params.now ?? new Date();

  // System health first, always. Asking "is this person allowed" before "is
  // this working at all" is how an outage arrives on somebody's record.
  const breaker = await prisma.circuitBreaker.findFirst({
    where: { orgId: params.orgId, capability: params.capability, state: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  });

  if (breaker) {
    const probeAllowed = Boolean(breaker.retryAt && breaker.retryAt <= now);
    if (!probeAllowed) {
      return {
        allowed: false,
        kind: 'system',
        capability: params.capability,
        since: breaker.openedAt,
        message: `${sentenceCase(CAPABILITY_LABELS[params.capability])} is stopped at our end, not yours. ${breaker.openedBecause ?? ''} Nothing you were doing is lost and none of this counts against you. It will come back on its own, or somebody will turn it back on.`.replace(/\s+/g, ' ').trim(),
      };
    }
  }

  const restriction = await prisma.intervention.findFirst({
    where: {
      orgId: params.orgId,
      callerId: params.userId,
      capability: params.capability,
      state: 'ACTIVE',
      // Shadow rows are calibration. They must never stop anybody.
      shadow: false,
    },
    orderBy: { enforcedAt: 'desc' },
  });

  if (restriction) {
    return {
      allowed: false,
      kind: 'restricted',
      capability: params.capability,
      restorationRule: restriction.restorationRule,
      since: restriction.enforcedAt,
      message: `${sentenceCase(CAPABILITY_LABELS[params.capability])} is paused on your account. ${restriction.reason} It ends when: ${restriction.restorationRule ?? 'a manager reviews it'}.`,
    };
  }

  return {
    allowed: true,
    kind: 'ok',
    capability: params.capability,
    message: 'Allowed.',
  };
}

/**
 * Everything stopping one person right now.
 *
 * Used by the readiness check and the caller's own screen, so a caller is told
 * at the start of the day rather than at the moment they press the button.
 */
export async function stopsFor(params: {
  orgId: string;
  userId: string;
  capabilities: WorkCapability[];
  now?: Date;
}): Promise<GateVerdict[]> {
  const verdicts = await Promise.all(
    params.capabilities.map((capability) =>
      capabilityGate({ orgId: params.orgId, userId: params.userId, capability, now: params.now })),
  );
  return verdicts.filter((v) => !v.allowed);
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
