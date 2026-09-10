import { createHash } from 'node:crypto';
import type { Opportunity } from '@prisma/client';
import { num } from '@/lib/db';
import { RECORD_TYPE } from './config';
import type { Delivery } from './client';

/**
 * One opportunity, reduced to what Brain needs.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately not sent
 * ---------------------------------------------------------------------------
 *
 * No contacts, no phone numbers, no email addresses, no call transcripts, no
 * costs, no margins, no quotes. Brain is the intelligence behind this site, not
 * a second copy of it — and every field sent is a field that could drift into
 * having two masters. What crosses is what Brain needs to *identify* the
 * record, *reason* about it, *prioritise* it and *project* an answer back.
 *
 * The margin is the clearest case and worth stating rather than leaving to
 * inference: it is the most commercially sensitive number on the record, it is
 * behind its own permission on this site, and no research question is improved
 * by knowing it. So it does not go.
 *
 * ---------------------------------------------------------------------------
 * The version
 * ---------------------------------------------------------------------------
 *
 * `updatedAt` is Prisma's own, moved by every write to the row. It is the
 * ordering fact on both sides: Brain refuses any delivery whose version is not
 * newer than the one it holds, so a retried, duplicated or reordered push
 * cannot regress a newer state.
 */
export function toDelivery(opportunity: Opportunity & { lane?: { name: string } | null }): Delivery {
  return {
    sourceRecordType: RECORD_TYPE,
    sourceRecordId: opportunity.id,
    sourceVersion: opportunity.updatedAt.toISOString(),
    sourceCreatedAt: opportunity.createdAt.toISOString(),
    // Site-relative. Brain validates it as such and drops anything that is not.
    sourceRef: `/opportunities/${opportunity.id}`,
    title: opportunity.name,
    summary: opportunity.summary,
    attributes: {
      type: opportunity.type,
      stage: opportunity.stage,
      status: opportunity.status,
      priority: opportunity.priority,
      state: opportunity.state ?? undefined,
      location: opportunity.location ?? undefined,
      estimatedValue: num(opportunity.estimatedValue) ?? undefined,
      expectedValue: num(opportunity.expectedValue) ?? undefined,
      closingProbability: opportunity.closingProbability,
      primaryBlocker: opportunity.primaryBlocker ?? undefined,
      missingInformation: opportunity.missingInformation,
      lane: opportunity.lane?.name ?? undefined,
    },
  };
}

/**
 * The digest of what we last sent.
 *
 * Held on this side as well as Brain's, so a push that would be a no-op is not
 * made at all. Brain would answer `unchanged` and write nothing either way —
 * this is what stops the request being sent, which on a serverless platform is
 * the part that costs something.
 *
 * Keys are sorted so a reserialization is not a change, exactly as on Brain's
 * side. The two hashes are computed from different objects and are deliberately
 * not compared to each other; each is only ever compared to its own history.
 */
export function deliveryHash(delivery: Delivery): string {
  const canonical = JSON.stringify([
    'dd.delivery.v1',
    delivery.sourceRecordId,
    delivery.sourceVersion,
    delivery.title,
    delivery.summary,
    delivery.sourceRef,
    Object.keys(delivery.attributes)
      .sort()
      .map((key) => [key, delivery.attributes[key]]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
