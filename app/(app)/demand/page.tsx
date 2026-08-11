import Link from 'next/link';
import type { FrictionLevel, LeadTier, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { demandSourceHealth } from '@/lib/demand/run';
import { humaniseEvent } from '@/lib/demand/events';
import { thesisGaps, type Thesis } from '@/lib/demand/thesis';
import { funnelTotals, sourceScorecards } from '@/lib/demand/performance';
import { Badge, Empty, humanize, relativeDays } from '@/components/ui';
import { DemandControls } from '@/components/DemandControls';

export const dynamic = 'force-dynamic';

/**
 * The demand board.
 *
 * Organised around events and the commercial routes built on them, not around
 * companies and their categories. One account renders once, with every route
 * beneath it, and every route shows the dated event it came from and a link
 * back to the source record.
 *
 * The queues exist because tier and friction are different axes and the
 * operator needs both. Active demand that costs three months of procurement is
 * not the same work as a low-friction turnover clean, and a single ranked list
 * cannot express that.
 */

const TIER_TONE: Record<LeadTier, string> = {
  ACTIVE_DEMAND: 'success',
  STRONG_TRIGGER: 'warning',
  PREDICTED_NEED: 'accent',
  DIRECTORY_PROSPECT: '',
  REJECTED: 'danger',
};

const TIER_LABEL: Record<LeadTier, string> = {
  ACTIVE_DEMAND: 'A — active demand',
  STRONG_TRIGGER: 'B — strong trigger',
  PREDICTED_NEED: 'C — predicted',
  DIRECTORY_PROSPECT: 'D — directory',
  REJECTED: 'Rejected',
};

const FRICTION_TONE: Record<FrictionLevel, string> = {
  LOW: 'success',
  MODERATE: 'warning',
  HIGH: 'danger',
  UNKNOWN_RESEARCH_REQUIRED: '',
};

const FRICTION_LABEL: Record<FrictionLevel, string> = {
  LOW: 'low friction',
  MODERATE: 'moderate friction',
  HIGH: 'high friction',
  UNKNOWN_RESEARCH_REQUIRED: 'friction unknown — research needed',
};

const RISK_TONE: Record<string, string> = {
  LOW: 'success',
  MODERATE: 'warning',
  HIGH: 'danger',
  // Unknown gets no colour at all. Colouring it would put it on the same
  // footing as an assessment somebody actually made.
  UNKNOWN: '',
};

const ROUTE_TONE: Record<string, string> = {
  BROKERAGE: 'accent',
  DISTRIBUTION: 'accent',
  SUBCONTRACTING: 'accent',
  GENERAL: '',
};

type RouteWithEvent = Prisma.RouteHypothesisGetPayload<{
  include: {
    event: true;
    company: { include: { contacts: true } };
  };
}>;

type Queue =
  | 'low_friction'
  | 'active_demand'
  | 'strong_trigger'
  | 'research'
  | 'blocked_supply'
  | 'subcontracting'
  | 'distribution'
  | 'high_friction'
  | 'expired';

const QUEUES: Array<{ key: Queue; label: string; blurb: string }> = [
  { key: 'low_friction', label: 'Low friction', blurb: 'Dated demand a local decision-maker can say yes to.' },
  { key: 'active_demand', label: 'Active demand', blurb: 'Somebody has asked for something.' },
  { key: 'strong_trigger', label: 'Strong triggers', blurb: 'An event that usually creates the need. Nobody has asked yet.' },
  { key: 'research', label: 'Research required', blurb: 'Real demand, unknown relationship cost.' },
  { key: 'blocked_supply', label: 'Provider sourcing', blurb: 'Demand we cannot currently fulfil. The demand is kept.' },
  { key: 'subcontracting', label: 'Subcontracting', blurb: 'A prime holds the work and needs local capacity.' },
  { key: 'distribution', label: 'Distribution', blurb: 'Consumables, not crews.' },
  { key: 'high_friction', label: 'High friction', blurb: 'Real, and expensive in relationship time.' },
  { key: 'expired', label: 'Expired and rejected', blurb: 'Kept as evidence. Not work.' },
];

export default async function DemandPage({ searchParams }: { searchParams: { queue?: string } }) {
  const user = await requirePagePermission('discovery.read');
  const queue = (QUEUES.find((q) => q.key === searchParams.queue)?.key ?? 'low_friction') as Queue;

  const [health, routes, counts, eventStats, funnel, scorecards] = await Promise.all([
    demandSourceHealth(user.orgId),
    prisma.routeHypothesis.findMany({
      where: { orgId: user.orgId, ...whereFor(queue) },
      include: {
        event: true,
        company: { include: { contacts: { take: 3, orderBy: { createdAt: 'asc' } } } },
      },
      orderBy: [{ tier: 'asc' }, { windowClosesAt: 'asc' }],
      take: 120,
    }),
    prisma.routeHypothesis.findMany({
      where: { orgId: user.orgId },
      select: { tier: true, friction: true, route: true, status: true, fulfilmentStatus: true },
    }),
    prisma.demandEvent.groupBy({ by: ['lifecycle'], where: { orgId: user.orgId }, _count: true }),
    funnelTotals(user.orgId),
    sourceScorecards(user.orgId),
  ]);

  const queueCounts = Object.fromEntries(
    QUEUES.map((q) => [q.key, counts.filter((r) => matches(r, q.key)).length]),
  ) as Record<Queue, number>;

  const totalEvents = eventStats.reduce((sum, r) => sum + r._count, 0);
  const actionable = counts.filter(
    (r) => (r.tier === 'ACTIVE_DEMAND' || r.tier === 'STRONG_TRIGGER') && r.status !== 'EXPIRED',
  ).length;

  // One account, many routes. Grouping here is what stops a gym with four
  // routes rendering as four businesses.
  const byAccount = new Map<string, typeof routes>();
  for (const route of routes) {
    byAccount.set(route.companyId, [...(byAccount.get(route.companyId) ?? []), route]);
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Demand</h1>
          <p>
            Dated commercial events and the routes built on them. Every card names the event, its external date and a
            link back to the record it came from — nothing here is derived from a business simply existing.
          </p>
        </div>
        <Badge tone={actionable > 0 ? 'success' : 'warning'}>{actionable} actionable</Badge>
      </div>

      <DemandControls
        health={health}
        totalEvents={totalEvents}
        actionable={actionable}
        funnel={funnel}
        scorecards={scorecards.map((s) => ({
          connector: s.connector,
          sourceRecords: s.counts.SOURCE_RECORD,
          events: s.counts.DEMAND_EVENT,
          verifiedLeads: s.counts.VERIFIED_LEAD,
          quoted: s.counts.QUOTED,
          won: s.counts.WON,
          paid: s.counts.PAID,
          collectedGrossProfit: s.collectedGrossProfit,
          verdict: s.verdict,
        }))}
      />

      <div className="filter-bar">
        {QUEUES.map((q) => (
          <Link
            key={q.key}
            href={`/demand?queue=${q.key}`}
            className={`filter-chip${queue === q.key ? ' active' : ''}`}
          >
            {q.label} {queueCounts[q.key] > 0 ? `(${queueCounts[q.key]})` : ''}
          </Link>
        ))}
      </div>

      <p className="small muted">{QUEUES.find((q) => q.key === queue)?.blurb}</p>

      {byAccount.size === 0 ? (
        <div className="card">
          <Empty>
            {totalEvents === 0
              ? 'No demand events have been ingested yet. Run the demand sources above, or record one by hand.'
              : 'No routes in this queue. That is a result, not an error — the other queues may have work.'}
          </Empty>
        </div>
      ) : (
        [...byAccount.entries()].map(([companyId, accountRoutes]) => {
          const company = accountRoutes[0].company;
          const contact = company.contacts.find((c) => c.phone || c.email);
          const location = [company.cityName, company.stateCode].filter(Boolean).join(', ');

          return (
            <div className="card" key={companyId}>
              <div className="card-title">
                <div>
                  <h2 style={{ marginBottom: '0.3rem' }}>
                    <Link href={`/companies/${companyId}`}>{company.legalName}</Link>
                  </h2>
                  <div className="tiny dim">
                    {location || 'location unknown'} · {accountRoutes.length} commercial route
                    {accountRoutes.length === 1 ? '' : 's'} from{' '}
                    {new Set(accountRoutes.map((r) => r.eventId)).size} event
                    {new Set(accountRoutes.map((r) => r.eventId)).size === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="tiny dim" style={{ textAlign: 'right' }}>
                  {contact ? (contact.phone ? `☎ ${contact.phone}` : `✉ ${contact.email}`) : 'no contact route yet'}
                </div>
              </div>

              {accountRoutes.map((route) => (
                <RouteBlock key={route.id} route={route} />
              ))}
            </div>
          );
        })
      )}
    </>
  );
}

function RouteBlock({ route }: { route: RouteWithEvent }) {
  const event = route.event;
  const facts = (event.confirmedFacts as unknown as string[]) ?? [];
  const inferences = (event.inferredFacts as unknown as string[]) ?? [];
  const thesis = (route.thesis as unknown as Thesis | null) ?? null;
  const isHighTier = route.tier === 'ACTIVE_DEMAND' || route.tier === 'STRONG_TRIGGER';
  const gaps = isHighTier ? thesisGaps(thesis) : [];

  return (
    <div className="mt" style={{ borderTop: '1px solid var(--border, #2a2a2a)', paddingTop: '0.75rem' }}>
      <div className="row">
        <Badge tone={TIER_TONE[route.tier]}>{TIER_LABEL[route.tier]}</Badge>
        <Badge tone={FRICTION_TONE[route.friction]}>{FRICTION_LABEL[route.friction]}</Badge>
        <Badge tone={ROUTE_TONE[route.route] ?? ''}>{humanize(route.route)}</Badge>
        <Badge>{humanize(route.status)}</Badge>
        <span className="tiny dim" style={{ marginLeft: 'auto' }}>{route.playbookKey}</span>
      </div>

      <div className="small mt">
        <strong>{route.headline}</strong>
      </div>

      {/* The event, its external date, and the link. The three things that
          make this a demand record rather than a category guess. */}
      <div className="tiny muted mt" style={{ lineHeight: 1.7 }}>
        <strong>Event:</strong> {humaniseEvent(event.type)}
        {event.eventDate ? (
          <> dated <strong>{event.eventDate.toISOString().slice(0, 10)}</strong> ({relativeDays(event.eventDate)})</>
        ) : (
          <> — the source published no date, so recency is unknown</>
        )}
        <br />
        <span className="dim">
          We first saw this record {relativeDays(event.discoveredAt)}. That is our timestamp, not an event.
        </span>
        <br />
        {event.sourceUrl ? (
          <a href={event.sourceUrl} target="_blank" rel="noreferrer noopener">
            Open the source record ↗
          </a>
        ) : (
          <span className="dim">No source link — this event cannot be verified externally.</span>
        )}
        {event.deadlineAt && (
          <>
            {' · '}
            <strong>deadline {event.deadlineAt.toISOString().slice(0, 10)}</strong>
          </>
        )}
      </div>

      <div className="grid grid-2 mt">
        <div>
          <div className="tiny dim">Why this route</div>
          <div className="tiny muted" style={{ lineHeight: 1.6 }}>{route.rationale}</div>

          <div className="tiny dim mt">
            {route.needIsConfirmed ? 'Stated need' : 'Possible need — our inference'}
          </div>
          <div className="tiny muted">
            {route.requiredCapability}
            {!route.needIsConfirmed && (
              <span className="dim">
                {' '}
                — derived from the event, not from anything the buyer said.
              </span>
            )}
          </div>

          {facts.length > 0 && (
            <>
              <div className="tiny dim mt">Confirmed by the source</div>
              <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
                {facts.slice(0, 4).map((fact) => (
                  <li key={fact}>· {fact}</li>
                ))}
              </ul>
            </>
          )}

          {inferences.length > 0 && (
            <>
              <div className="tiny dim mt">Our inferences</div>
              <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
                {inferences.slice(0, 3).map((fact) => (
                  <li key={fact}>· {fact}</li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div>
          <div className="tiny dim">Friction</div>
          <div className="tiny muted" style={{ lineHeight: 1.6 }}>{route.frictionReason}</div>

          <div className="tiny dim mt">Buying window</div>
          <div className="tiny muted">
            {humanize(route.buyingWindow ?? 'UNKNOWN')}
            {route.windowOpensAt && route.windowClosesAt && (
              <span className="dim">
                {' '}
                ({route.windowOpensAt.toISOString().slice(0, 10)} → {route.windowClosesAt.toISOString().slice(0, 10)})
              </span>
            )}
          </div>

          <div className="tiny dim mt">Fulfilment</div>
          <div className="tiny muted">
            {humanize(route.fulfilmentStatus)} · {route.providerCount.toFixed(2).replace(/\.00$/, '')} provider(s)
          </div>

          <div className="tiny dim mt">Economics</div>
          <div className="tiny muted" style={{ lineHeight: 1.6 }}>
            {route.estimatedGrossProfit !== null ? (
              <>
                ~${Number(route.estimatedGrossProfit).toLocaleString()} gross profit against{' '}
                {route.estimatedHumanMinutes} minutes of human time.{' '}
              </>
            ) : (
              <>Cannot be estimated yet. </>
            )}
            <span className="dim">{route.economicsBasis}</span>
          </div>

          <div className="tiny dim mt">Structure</div>
          <div className="tiny muted" style={{ lineHeight: 1.6 }}>
            {humanize(route.commercialStructure ?? 'UNSET')} — <span className="dim">{route.structureReason}</span>
          </div>
        </div>
      </div>

      {thesis && (
        <div className="mt" style={{ background: 'var(--surface-alt, rgba(255,255,255,0.03))', padding: '0.7rem 0.85rem' }}>
          <div className="tiny dim">Lead thesis</div>
          <div className="tiny muted" style={{ lineHeight: 1.7 }}>
            <strong>Why this company:</strong> {thesis.whyThisCompany}
            <br />
            <strong>Why now:</strong> {thesis.whyNow}
            <br />
            <strong>Likely need:</strong> {thesis.likelyNeed}
            <br />
            <strong>Who to ask for:</strong> {thesis.likelyStakeholder}
            <br />
            <strong>Fulfilment:</strong> {thesis.fulfilmentRequirement}
            <br />
            <strong>Economics:</strong> {thesis.economics}
          </div>
          {thesis.uncertainties.length > 0 && (
            <>
              <div className="tiny dim mt">What could make this wrong</div>
              <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
                {thesis.uncertainties.map((u) => (
                  <li key={u}>· {u}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {isHighTier && gaps.length > 0 && (
        <div className="alert warning tiny mt">
          <strong>Thesis incomplete.</strong> Missing: {gaps.join(', ')}. Every tier A and B route is required to
          carry all of it.
        </div>
      )}

      <div className="grid grid-2 mt">
        <div>
          <div className="tiny dim">Money at risk</div>
          <div className="tiny muted" style={{ lineHeight: 1.6 }}>
            {route.maxCashExposure !== null ? (
              <>
                Up to ${Number(route.maxCashExposure).toLocaleString()} of our own money
                {route.daysCapitalExposed !== null ? ` for about ${route.daysCapitalExposed} days` : ', for an unknown period'}.
              </>
            ) : (
              'Cash exposure cannot be calculated yet.'
            )}
          </div>
        </div>
        <div>
          <div className="tiny dim">Risk</div>
          <div className="row">
            <Badge tone={RISK_TONE[route.paymentRisk]}>payment {route.paymentRisk.toLowerCase()}</Badge>
            <Badge tone={RISK_TONE[route.counterpartyRisk]}>counterparty {route.counterpartyRisk.toLowerCase()}</Badge>
            <Badge tone={route.complianceStatus === 'STRUCTURALLY_UNQUALIFIED' ? 'danger' : ''}>
              compliance {humanize(route.complianceStatus).toLowerCase()}
            </Badge>
          </div>
        </div>
      </div>

      {route.missingInfo.length > 0 && (
        <div className="alert warning tiny mt">
          <strong>Still missing:</strong> {route.missingInfo.join(', ')}.
        </div>
      )}

      <div className="row mt">
        <div className="small" style={{ flex: 1 }}>
          <strong>Next:</strong> {route.nextAction ?? 'No action set.'}
        </div>
        {route.nextActionBy && <div className="tiny dim">by {route.nextActionBy.toISOString().slice(0, 10)}</div>}
      </div>
    </div>
  );
}

function whereFor(queue: Queue) {
  switch (queue) {
    case 'low_friction':
      // Only LOW. An unknown assessment must never appear here — not knowing
      // is not the same as easy.
      return { friction: 'LOW' as const, status: { notIn: ['EXPIRED'] } };
    case 'active_demand':
      return { tier: 'ACTIVE_DEMAND' as const, status: { notIn: ['EXPIRED'] } };
    case 'strong_trigger':
      return { tier: 'STRONG_TRIGGER' as const, status: { notIn: ['EXPIRED'] } };
    case 'research':
      return { friction: 'UNKNOWN_RESEARCH_REQUIRED' as const, status: { notIn: ['EXPIRED', 'COLD'] } };
    case 'blocked_supply':
      return { status: 'BLOCKED_ON_SUPPLY' as const };
    case 'subcontracting':
      return { route: 'SUBCONTRACTING' as const, status: { notIn: ['EXPIRED'] } };
    case 'distribution':
      return { route: 'DISTRIBUTION' as const, status: { notIn: ['EXPIRED'] } };
    case 'high_friction':
      return { friction: 'HIGH' as const, status: { notIn: ['EXPIRED'] } };
    case 'expired':
      return { status: 'EXPIRED' as const };
  }
}

function matches(
  row: { tier: LeadTier; friction: FrictionLevel; route: string; status: string; fulfilmentStatus: string },
  queue: Queue,
): boolean {
  switch (queue) {
    case 'low_friction':
      return row.friction === 'LOW' && row.status !== 'EXPIRED';
    case 'active_demand':
      return row.tier === 'ACTIVE_DEMAND' && row.status !== 'EXPIRED';
    case 'strong_trigger':
      return row.tier === 'STRONG_TRIGGER' && row.status !== 'EXPIRED';
    case 'research':
      return row.friction === 'UNKNOWN_RESEARCH_REQUIRED' && row.status !== 'EXPIRED' && row.status !== 'COLD';
    case 'blocked_supply':
      return row.status === 'BLOCKED_ON_SUPPLY';
    case 'subcontracting':
      return row.route === 'SUBCONTRACTING' && row.status !== 'EXPIRED';
    case 'distribution':
      return row.route === 'DISTRIBUTION' && row.status !== 'EXPIRED';
    case 'high_friction':
      return row.friction === 'HIGH' && row.status !== 'EXPIRED';
    case 'expired':
      return row.status === 'EXPIRED';
  }
}
