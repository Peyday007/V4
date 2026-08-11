import { prisma } from '@/lib/db';
import type { RawDemandEvent } from '../events';
import type { DemandConnector, DemandFetchContext, DemandFetchResult } from '../connector';

/**
 * Inbound requests and operator-entered events.
 *
 * The only Tier A source that needs no third party, and the strongest evidence
 * the system can hold: somebody asked. A web form, a forwarded email, a phone
 * enquiry written up, or an operator recording something they learned — a
 * conversation at a trade counter, a sign in a window, a tip from a provider.
 *
 * This exists because the demand engine must not be defined by any external
 * API. Municipal open data can be republished and federal contracting is
 * deliberately out of scope; an operator who hears that the unit next door is
 * being fitted out has a real dated event, and the pipeline should treat it
 * exactly like a machine-discovered one — same verification, same routes, same
 * friction assessment, same economics.
 *
 * The connector reads from a staging table rather than the network. Records
 * arrive through the intake API, which is where authentication and validation
 * live; by the time they reach here they are ordinary source records with an
 * origin of MANUAL and no special privileges.
 */

export class InboundIntakeConnector implements DemandConnector {
  readonly key = 'inbound_intake';
  readonly name = 'Inbound requests and operator-entered events';
  readonly accessBasis =
    'First-party data: requests sent to us, and events recorded by the operator. No external access involved.';
  readonly termsUrl = '';
  readonly credentialEnvVar = null;
  readonly requiresJurisdictionConfig = false;
  readonly eventFamilies = [
    'Active solicitations, RFQs and vendor requests',
    'Subcontractor and capacity requests',
    'Facility openings learned first-hand',
  ];
  readonly pollIntervalMinutes = 15;

  async fetch(context: DemandFetchContext): Promise<DemandFetchResult> {
    // Staged intake rows are ordinary SourceEvidence with a known process, so
    // there is one evidence table rather than a parallel one for hand entry.
    const staged = await prisma.sourceEvidence.findMany({
      where: {
        createdByProcess: 'demand.intake',
        demandEventId: null,
        ...(context.since ? { discoveredAt: { gte: context.since } } : {}),
      },
      orderBy: { discoveredAt: 'asc' },
      take: context.maxRecords,
    });

    const events: RawDemandEvent[] = [];
    const warnings: string[] = [];

    for (const row of staged) {
      const payload = row.rawPayload as Record<string, unknown>;
      const event = parseIntake(payload, row.id, row.sourceUrl);
      if (!event) {
        // An intake row without a date cannot become Tier A however it
        // arrived. Saying so beats silently downgrading it.
        warnings.push(`Intake ${row.id} has no usable event date and was skipped.`);
        continue;
      }
      events.push(event);
    }

    return { events, recordsExamined: staged.length, nextCursor: null, warnings };
  }
}

/**
 * Turns a staged intake payload into an event.
 *
 * Returns null when the date is missing, rather than defaulting to the moment
 * the form was submitted. A submission time is our clock, and this pipeline
 * has exactly one rule it will not bend.
 */
export function parseIntake(
  payload: Record<string, unknown>,
  recordId: string,
  sourceUrl: string | null,
): RawDemandEvent | null {
  const str = (key: string): string => (typeof payload[key] === 'string' ? (payload[key] as string).trim() : '');
  const date = (key: string): Date | null => {
    const raw = payload[key];
    if (typeof raw !== 'string' || !raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const organisation = str('organisation') || str('company');
  const eventDate = date('eventDate');
  if (!organisation || !eventDate) return null;

  const type = (str('type') || 'INBOUND_REQUEST') as RawDemandEvent['type'];
  const summary = str('summary') || str('detail');

  const parties: RawDemandEvent['parties'] = [
    { role: type === 'SUBCONTRACTOR_REQUEST' ? 'PRIME_CONTRACTOR' : 'BUYER', name: organisation },
  ];
  const incumbent = str('incumbent');
  if (incumbent) parties.push({ role: 'INCUMBENT_PROVIDER', name: incumbent });

  return {
    type,
    sourceRecordId: recordId,
    sourceUrl: sourceUrl ?? undefined,
    headline: str('headline') || `${organisation} — ${summary.slice(0, 60)}`,
    summary,
    eventDate,
    deadlineAt: date('deadline'),
    opensAt: date('opensAt'),
    cityName: str('city') || null,
    stateCode: str('state') || null,
    postalCode: str('postalCode') || null,
    addressLine1: str('address') || null,
    parties,
    // Everything an inbound request states is stated by the party themselves,
    // which is the highest assertion tier available short of a signed order.
    confirmedFacts: [
      `${organisation} stated: ${summary}`,
      ...(str('contactName') ? [`Named contact: ${str('contactName')}`] : []),
      ...(date('deadline') ? [`Deadline given: ${date('deadline')!.toISOString().slice(0, 10)}`] : []),
    ],
    inferredFacts: [],
    confidence: 0.95,
    relatedCapabilities: Array.isArray(payload.capabilities)
      ? (payload.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
      : [],
    rawPayload: payload,
    // Deliberately no natural key. Our evidence row id identifies *our record*,
    // not the event, and using it here would defeat deduplication in both
    // directions: two people reporting one opening would become two events,
    // and an intake describing the same opening as a licence record would
    // never collapse onto it. Without one the key falls through to
    // organisation + address + date, which is what actually identifies the
    // thing that happened.
    naturalKey: null,
    evidenceId: recordId,
  };
}
