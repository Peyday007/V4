import Link from 'next/link';
import type { DataOrigin } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { getActivePaths } from '@/lib/paths';
import { freshnessOf, scoreLead, type Freshness } from '@/lib/discovery/leadScore';
import { Badge, Empty, humanize, relativeDays } from '@/components/ui';
import { DiscoveryStatus } from '@/components/DiscoveryStatus';
import { hasCredential } from '@/lib/discovery/http';

export const dynamic = 'force-dynamic';

/**
 * Discovered leads, ranked.
 *
 * The board shows opportunities that have been qualified. This shows what
 * discovery found before anyone has looked at it, which is a different thing
 * and needs to stay visibly different — including whether the record came from
 * a real source or from the demonstration seed.
 */

const ORIGIN_LABEL: Record<DataOrigin, { label: string; tone: string }> = {
  LIVE_DISCOVERY: { label: 'Live', tone: 'success' },
  IMPORTED: { label: 'Imported', tone: 'accent' },
  MANUAL: { label: 'Manual', tone: '' },
  SEED_DEMO: { label: 'Demo — not real', tone: 'danger' },
};

const STAGE_TONE: Record<string, string> = {
  DISCOVERED_ACCOUNT: '',
  OPPORTUNITY_HYPOTHESIS: '',
  INTENT_DETECTED: 'warning',
  QUALIFIED_LEAD: 'success',
  ACTIVE_OPPORTUNITY: 'success',
  DISQUALIFIED: 'danger',
  NURTURE: 'accent',
};

function ScoreCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: '1.1rem' }}>{Math.round(value * 100)}</div>
    </div>
  );
}

const FRESHNESS_TONE: Record<Freshness, string> = {
  FRESH: 'success',
  RECENT: 'accent',
  AGEING: 'warning',
  STALE: 'danger',
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: { origin?: string; path?: string; market?: string };
}) {
  const user = await requirePagePermission('discovery.read');

  const originFilter = (searchParams.origin ?? 'LIVE_DISCOVERY').toUpperCase();
  const showAllOrigins = originFilter === 'ALL';

  const [paths, markets, liveSources, signals, counts] = await Promise.all([
    getActivePaths(user.orgId),
    prisma.market.findMany({ where: { orgId: user.orgId }, orderBy: { isDefault: 'desc' } }),
    prisma.dataSource.findMany({ where: { orgId: user.orgId, isLive: true }, orderBy: { name: 'asc' } }),
    prisma.discoverySignal.findMany({
      where: {
        orgId: user.orgId,
        status: { in: ['NEW', 'TRIAGED'] },
        ...(showAllOrigins ? {} : { origin: originFilter as DataOrigin }),
        ...(searchParams.path ? { path: { key: searchParams.path } } : {}),
        ...(searchParams.market ? { marketId: searchParams.market } : {}),
      },
      include: {
        company: { include: { contacts: { take: 1, orderBy: { createdAt: 'asc' } } } },
        path: true,
        market: true,
        dataSource: true,
        hypothesis: { include: { path: true } },
      },
      orderBy: { observedAt: 'desc' },
      take: 200,
    }),
    prisma.discoverySignal.groupBy({
      by: ['origin'],
      where: { orgId: user.orgId, status: { in: ['NEW', 'TRIAGED'] } },
      _count: true,
    }),
  ]);

  const byOrigin = Object.fromEntries(counts.map((c) => [c.origin, c._count])) as Record<string, number>;
  const liveCount = byOrigin.LIVE_DISCOVERY ?? 0;

  // Ranking happens here rather than in SQL because the score depends on path
  // weights and on contact availability, neither of which is a column.
  const ranked = signals
    .map((signal) => {
      const contact = signal.company?.contacts[0];
      const hint = (signal.contactHint ?? {}) as { phone?: string; email?: string };
      const phone = contact?.phone ?? hint.phone ?? null;
      const email = contact?.email ?? hint.email ?? null;

      const score = scoreLead(
        {
          strength: signal.strength,
          confidence: signal.confidence,
          observedAt: signal.observedAt,
          lastSeenAt: signal.lastSeenAt,
          origin: signal.origin,
          leadRole: signal.leadRole,
          segment: signal.segment,
          hasPhone: Boolean(phone),
          hasEmail: Boolean(email),
          hasSourceUrl: Boolean(signal.sourceUrl),
          requiredService: signal.requiredService,
          sourceIsLive: signal.dataSource?.isLive ?? false,
        },
        signal.path,
      );

      return { signal, score, phone, email };
    })
    .sort((a, b) => b.score.score - a.score.score);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Discovered leads</h1>
          <p>
            What the connectors found, ranked by how workable each one is rather than by when it arrived. Every lead
            links back to the record it came from, so any ranking here can be checked against the source in one click.
          </p>
        </div>
        <Badge tone={liveCount > 0 ? 'success' : 'warning'}>{liveCount} live</Badge>
      </div>

      <DiscoveryStatus
        liveLeads={liveCount}
        sources={liveSources.map((source) => ({
          id: source.id,
          name: source.name,
          isEnabled: source.isEnabled,
          // Whether the key is present, never its value.
          credentialMissing: !hasCredential(source.credentialEnvVar),
          lastRunAt: source.lastRunAt?.toISOString() ?? null,
          lastRecordCount: source.lastRecordCount,
          lastRunStatus: source.lastRunStatus,
          consecutiveFailures: source.consecutiveFailures,
        }))}
      />

      <div className="filter-bar">
        <FilterChip href="/leads?origin=LIVE_DISCOVERY" active={originFilter === 'LIVE_DISCOVERY'}>
          Live {byOrigin.LIVE_DISCOVERY ? `(${byOrigin.LIVE_DISCOVERY})` : ''}
        </FilterChip>
        <FilterChip href="/leads?origin=IMPORTED" active={originFilter === 'IMPORTED'}>
          Imported {byOrigin.IMPORTED ? `(${byOrigin.IMPORTED})` : ''}
        </FilterChip>
        <FilterChip href="/leads?origin=SEED_DEMO" active={originFilter === 'SEED_DEMO'}>
          Demo {byOrigin.SEED_DEMO ? `(${byOrigin.SEED_DEMO})` : ''}
        </FilterChip>
        <FilterChip href="/leads?origin=ALL" active={showAllOrigins}>
          All
        </FilterChip>
      </div>

      {(paths.length > 0 || markets.length > 1) && (
        <div className="filter-bar">
          <FilterChip href={`/leads?origin=${originFilter}`} active={!searchParams.path && !searchParams.market}>
            Every path
          </FilterChip>
          {paths.map((path) => (
            <FilterChip
              key={path.id}
              href={`/leads?origin=${originFilter}&path=${path.key}`}
              active={searchParams.path === path.key}
            >
              {path.name}
            </FilterChip>
          ))}
          {markets.length > 1 &&
            markets.map((market) => (
              <FilterChip
                key={market.id}
                href={`/leads?origin=${originFilter}&market=${market.id}`}
                active={searchParams.market === market.id}
              >
                {market.name}
              </FilterChip>
            ))}
        </div>
      )}

      {ranked.length === 0 ? (
        <div className="card">
          <Empty>Nothing matching this filter.</Empty>
        </div>
      ) : (
        ranked.map(({ signal, score, phone, email }) => {
          const origin = ORIGIN_LABEL[signal.origin];
          const freshness = freshnessOf(signal.observedAt);

          return (
            <div className="card" key={signal.id}>
              <div className="card-title">
                <div>
                  <h2 style={{ marginBottom: '0.3rem' }}>
                    {signal.company ? (
                      <Link href={`/companies/${signal.company.id}`}>{signal.company.legalName}</Link>
                    ) : (
                      signal.headline
                    )}
                  </h2>
                  <div className="row">
                    <Badge tone={origin.tone}>{origin.label}</Badge>
                    {signal.path && <Badge tone="accent">{signal.path.name}</Badge>}
                    <Badge>{humanize(signal.leadRole)}</Badge>
                    <Badge>{humanize(signal.segment)}</Badge>
                    <Badge tone={FRESHNESS_TONE[freshness]}>{freshness.toLowerCase()}</Badge>
                    {signal.hypothesis && (
                      <Badge tone={STAGE_TONE[signal.hypothesis.stage] ?? ''}>{humanize(signal.hypothesis.stage)}</Badge>
                    )}
                    <Badge tone={signal.tier === 'USER_CONFIRMED' ? 'success' : signal.tier === 'SOURCE_FACT' ? 'accent' : ''}>
                      {signal.tier === 'SOURCE_FACT' ? 'source fact' : signal.tier === 'USER_CONFIRMED' ? 'confirmed' : 'our inference'}
                    </Badge>
                  </div>
                  <div className="tiny dim mt">
                    {/* The lead's own location, never the market that surfaced it. */}
                    {[signal.cityName ?? signal.company?.cityName, signal.stateCode ?? signal.company?.stateCode]
                      .filter(Boolean)
                      .join(', ') || 'location unknown'}
                    {signal.market && <> · searched under {signal.market.name}</>}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="stat-value">{signal.hypothesis?.priorityScore ?? score.score}</div>
                  <div className="tiny dim">priority</div>
                </div>
              </div>

              {signal.requiredService && (
                <div className="small">
                  <strong>Need:</strong> {signal.requiredService}
                </div>
              )}

              {signal.whyRelevant && <p className="small muted">{signal.whyRelevant}</p>}

              <div className="grid grid-2">
                <div>
                  <div className="tiny dim">Scores, kept separate</div>
                  {signal.hypothesis ? (
                    <>
                      <div className="grid grid-4">
                        <ScoreCell label="Account fit" value={signal.hypothesis.accountFitScore} />
                        <ScoreCell label="Intent" value={signal.hypothesis.intentScore} />
                        <ScoreCell label="Contactability" value={signal.hypothesis.contactabilityScore} />
                        <ScoreCell label="Fulfilment" value={signal.hypothesis.fulfillmentReadinessScore} />
                      </div>
                      <ul className="list-reset tiny muted mt" style={{ lineHeight: 1.6 }}>
                        {Object.entries((signal.hypothesis.scoreExplanation ?? {}) as Record<string, string>).map(
                          ([key, reason]) => (
                            <li key={key}>
                              <strong>{humanize(key)}:</strong> {reason}
                            </li>
                          ),
                        )}
                      </ul>
                      {signal.hypothesis.stage !== 'QUALIFIED_LEAD' && (
                        <div className="alert warning tiny mt">
                          Not a qualified lead. Still needed: need, decision-maker, timing, fit and an agreed next step —
                          whichever of those are unticked below.
                        </div>
                      )}
                    </>
                  ) : (
                    <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
                      {score.components
                        .slice()
                        .sort((a, b) => b.contribution - a.contribution)
                        .map((component) => (
                          <li key={component.label}>
                            <strong>{component.label}:</strong> {component.reason}
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="tiny dim">Provenance</div>
                  <div className="tiny muted" style={{ lineHeight: 1.7 }}>
                    Source: {signal.dataSource?.name ?? 'unknown'}
                    {signal.dataSource && !signal.dataSource.isLive && ' (fixture — not a real source)'}
                    <br />
                    {signal.sourcePublishedAt
                      ? `Source published ${relativeDays(signal.sourcePublishedAt)}`
                      : 'Source gave no publication date'}
                    <br />
                    First discovered {relativeDays(signal.firstDiscoveredAt)} · last seen {relativeDays(signal.lastSeenAt)}
                    {signal.hypothesis?.lastIntentSignalAt && (
                      <> · last intent signal {relativeDays(signal.hypothesis.lastIntentSignalAt)}</>
                    )}
                    <br />
                    {signal.sourceUrl ? (
                      <a href={signal.sourceUrl} target="_blank" rel="noreferrer noopener">
                        Open the original record ↗
                      </a>
                    ) : (
                      <span className="dim">No source link — this lead cannot be verified externally.</span>
                    )}
                  </div>

                  {signal.classificationEvidence.length > 0 && (
                    <>
                      <div className="tiny dim mt">Evidence for the classification</div>
                      <div className="tiny mono muted">{signal.classificationEvidence.join(' · ')}</div>
                    </>
                  )}
                </div>
              </div>

              <div className="divider" />

              <div className="row">
                <div className="small" style={{ flex: 1 }}>
                  <strong>Next:</strong> {signal.recommendedAction ?? 'Qualify before assigning a call.'}
                </div>
                <div className="tiny dim">
                  {phone ? `☎ ${phone}` : email ? `✉ ${email}` : 'no contact yet'}
                </div>
              </div>

              {phone && (
                <div className="tiny dim">
                  Discovered contact details are not consent to contact. Calling hours, suppression and SMS opt-in are
                  enforced when a call or message is actually placed.
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}

function FilterChip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className={`filter-chip${active ? ' active' : ''}`}>
      {children}
    </Link>
  );
}
