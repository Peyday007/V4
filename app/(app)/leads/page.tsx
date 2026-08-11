import Link from 'next/link';
import type { DataOrigin } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { getActivePaths } from '@/lib/paths';
import { buildBoard, missingEvidence, type BoardAccount, type RenderedHypothesis } from '@/lib/discovery/board';
import { describeDiscoveryTime, type Freshness } from '@/lib/discovery/eventTime';
import { TIER_LABEL, TIER_ORDER } from '@/lib/discovery/tiers';
import { Badge, Empty, humanize, relativeDays } from '@/components/ui';
import { DiscoveryStatus } from '@/components/DiscoveryStatus';
import { hasCredential } from '@/lib/discovery/http';

export const dynamic = 'force-dynamic';

/**
 * Discovered accounts and what we think they might be.
 *
 * One card per business. Its path candidacies sit beneath it, because a
 * healthcare facility can legitimately be both a cleaning prospect and a
 * consumables prospect without being two companies.
 *
 * Nothing on this page computes a score. Everything shown was written by the
 * assessment run, and a record the assessment has not reached shows no number
 * at all — the previous version fell back to a second scorer here, and that
 * fallback is what produced a board of near-identical 88s ranked on the date
 * we happened to fetch them.
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

const FRESHNESS_TONE: Record<Freshness, string> = {
  FRESH: 'success',
  RECENT: 'accent',
  AGEING: 'warning',
  STALE: 'danger',
};

/**
 * Tier drives the eye before the score does.
 *
 * A priority number invites comparison between records; the tier says whether
 * the comparison is worth making at all. Tier D is deliberately given no
 * colour — it is the default state of a discovered organisation, not an
 * achievement, and a board of grey badges should look like what it is.
 */
const TIER_TONE: Record<string, string> = {
  ACTIVE_DEMAND: 'success',
  STRONG_TRIGGER: 'warning',
  PREDICTED_NEED: 'accent',
  DIRECTORY_PROSPECT: '',
  REJECTED: 'danger',
};

const VERDICT_TONE: Record<string, string> = {
  CREDIBLE: 'success',
  SUSPECT: 'warning',
  NOT_CREDIBLE: 'danger',
};

function ScoreCell({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: '1.1rem' }}>{Math.round(value * 100)}</div>
      {note && <div className="tiny dim">{note}</div>}
    </div>
  );
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: { origin?: string; path?: string; market?: string };
}) {
  const user = await requirePagePermission('discovery.read');

  const originFilter = (searchParams.origin ?? 'LIVE_DISCOVERY').toUpperCase();
  const showAllOrigins = originFilter === 'ALL';
  const originWhere = showAllOrigins ? {} : { origin: originFilter as DataOrigin };

  const [paths, markets, liveSources, hypotheses, unassessed, counts] = await Promise.all([
    getActivePaths(user.orgId),
    prisma.market.findMany({ where: { orgId: user.orgId }, orderBy: { isDefault: 'desc' } }),
    prisma.dataSource.findMany({ where: { orgId: user.orgId, isLive: true }, orderBy: { name: 'asc' } }),
    prisma.pathHypothesis.findMany({
      where: {
        orgId: user.orgId,
        company: originWhere,
        ...(searchParams.path ? { path: { key: searchParams.path } } : {}),
        ...(searchParams.market ? { signals: { some: { marketId: searchParams.market } } } : {}),
      },
      include: {
        path: true,
        company: { include: { contacts: { orderBy: { createdAt: 'asc' } } } },
        signals: { include: { dataSource: true, market: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { priorityScore: 'desc' },
      take: 300,
    }),
    // Records that exist but have never been assessed. They are counted and
    // named, never scored — an unassessed record with a number beside it is
    // exactly the defect this page had.
    prisma.discoverySignal.count({
      where: {
        orgId: user.orgId,
        status: { in: ['NEW', 'TRIAGED'] },
        hypothesisId: null,
        ...originWhere,
      },
    }),
    prisma.discoverySignal.groupBy({
      by: ['origin'],
      where: { orgId: user.orgId, status: { in: ['NEW', 'TRIAGED'] } },
      _count: true,
    }),
  ]);

  const byOrigin = Object.fromEntries(counts.map((c) => [c.origin, c._count])) as Record<string, number>;
  const liveCount = byOrigin.LIVE_DISCOVERY ?? 0;

  // Collapse hypotheses onto their account. The hypothesis table already holds
  // one row per (company, path), so two sources finding the same business
  // cannot produce two cards here however many signals they wrote.
  const accountsById = new Map<string, BoardAccount>();
  for (const h of hypotheses) {
    const company = h.company;
    const existing = accountsById.get(company.id);
    const contact = company.contacts[0];
    const account: BoardAccount =
      existing ??
      {
        companyId: company.id,
        name: company.legalName,
        cityName: company.cityName,
        stateCode: company.stateCode,
        phone: company.phone ?? contact?.phone ?? null,
        email: contact?.email ?? null,
        website: company.website,
        origin: company.origin,
        externalPlaceId: company.externalPlaceId,
        normalizedPhone: company.normalizedPhone,
        normalizedAddress: company.normalizedAddress,
        hypotheses: [],
      };

    const explanation = (h.scoreExplanation ?? {}) as Record<string, string>;
    const withUrl = h.signals.find((s) => s.sourceUrl);
    // Only a source-stated date is eligible. `observedAt` is deliberately not
    // read anywhere in this file.
    const published = h.signals
      .map((s) => s.sourcePublishedAt)
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    account.hypotheses.push({
      id: h.id,
      pathId: h.pathId,
      pathName: h.path.name,
      leadRole: h.signals[0]?.leadRole ?? 'BUYER',
      stage: h.stage,
      accountFit: h.accountFitScore,
      intent: h.intentScore,
      contactability: h.contactabilityScore,
      fulfilment: h.fulfillmentReadinessScore,
      priority: Math.round(h.priorityScore),
      tier: h.tier,
      tierReason: h.tierReason ?? '',
      rejectionFlags: h.rejectionFlags,
      buyingWindow: h.buyingWindow,
      scoreExplanation: explanation,
      requiredService: h.signals[0]?.requiredService ?? null,
      missing: missingEvidence({
        needEvidence: h.needEvidence,
        decisionMakerId: h.decisionMakerId,
        timingEvidence: h.timingEvidence,
        accountFit: h.accountFitScore,
        nextStep: h.nextStep,
      }),
      sourceNames: [...new Set(h.signals.map((s) => s.dataSource?.name).filter((n): n is string => Boolean(n)))],
      sourceUrl: withUrl?.sourceUrl ?? null,
      sourcePublishedAt: published,
      firstDiscoveredAt: h.firstDiscoveredAt,
      lastSeenAt: h.lastSeenAt,
      lastIntentSignalAt: h.lastIntentSignalAt,
      signalCount: h.signals.length,
      evidence: [...new Set(h.signals.flatMap((s) => s.classificationEvidence))].slice(0, 6),
      marketName: h.signals.find((s) => s.market)?.market?.name ?? null,
      isLiveSource: h.signals.some((s) => s.dataSource?.isLive),
    });

    if (!existing) accountsById.set(company.id, account);
  }

  const board = buildBoard({ accounts: [...accountsById.values()], unassessedSignals: unassessed });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Discovered accounts</h1>
          <p>
            One card per business. Each card lists the paths we think it might belong to, and every number beside it was
            produced by the assessment run — nothing on this page is scored at render time.
          </p>
        </div>
        <Badge tone={liveCount > 0 ? 'success' : 'warning'}>{liveCount} live records</Badge>
      </div>

      {/* The funnel in the terms that cannot flatter it. "Pipeline" counts a
          scraped company and an open solicitation the same; these do not. */}
      <div className="card">
        <div className="tiny dim">What discovery actually produced</div>
        <div className="grid grid-4 mt">
          <div className="stat">
            <div className="stat-label">Raw records</div>
            <div className="stat-value" style={{ fontSize: '1.3rem' }}>{board.pipeline.rawRecords}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Accounts</div>
            <div className="stat-value" style={{ fontSize: '1.3rem' }}>{board.pipeline.accounts}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Path hypotheses</div>
            <div className="stat-value" style={{ fontSize: '1.3rem' }}>{board.pipeline.hypotheses}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Worth contacting</div>
            <div className="stat-value" style={{ fontSize: '1.3rem' }}>{board.pipeline.actionable}</div>
            <div className="tiny dim">tier A + B only</div>
          </div>
        </div>

        <div className="row mt">
          {board.pipeline.byTier
            .filter((t) => t.count > 0)
            .map((t) => (
              <Badge key={t.tier} tone={TIER_TONE[t.tier]}>
                {t.label}: {t.count}
              </Badge>
            ))}
        </div>

        {board.noDemandFound && (
          <div className="alert warning small mt">
            <strong>No demand evidence anywhere on this board.</strong> {board.noDemandFound}
          </div>
        )}
      </div>

      {/* The run's own assessment of its output, shown on load rather than
          only after someone thinks to press a button. A degenerate board that
          announces itself is recoverable; a silent one is not. */}
      <div className={`card`}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="tiny dim">Can these scores be ranked?</div>
            <div className="row mt">
              <Badge tone={VERDICT_TONE[board.diagnostics.verdict] ?? ''}>{board.diagnostics.verdict.replace('_', ' ')}</Badge>
              <span className="small">{board.diagnostics.verdictReason}</span>
            </div>
          </div>
          <div className="tiny dim" style={{ textAlign: 'right', lineHeight: 1.7 }}>
            {board.counts.accounts} account(s)<br />
            {board.counts.hypotheses} path hypothes{board.counts.hypotheses === 1 ? 'is' : 'es'}<br />
            {board.counts.signals} raw record(s), {board.counts.duplicateSignals} collapsed as duplicates<br />
            {board.counts.quarantined} held back · {board.counts.unassessedSignals} unassessed
          </div>
        </div>

        {board.rankingRefusedBecause && (
          <div className="alert danger small mt">
            <strong>Not presenting a ranking.</strong> {board.rankingRefusedBecause}
          </div>
        )}

        {board.diagnostics.warnings.length > 0 && (
          <ul className="list-reset tiny muted mt" style={{ lineHeight: 1.7 }}>
            {board.diagnostics.warnings.map((w) => (
              <li key={`${w.dimension}-${w.finding}`}>
                <Badge tone={w.severity === 'CRITICAL' ? 'danger' : w.severity === 'WARNING' ? 'warning' : ''}>
                  {w.severity.toLowerCase()}
                </Badge>{' '}
                <strong>{humanize(w.dimension)}:</strong> {w.finding} {w.likelyCause}
              </li>
            ))}
          </ul>
        )}

        {board.diagnostics.dataQuality.length > 0 && (
          <ul className="list-reset tiny muted mt" style={{ lineHeight: 1.7 }}>
            {board.diagnostics.dataQuality.map((q) => (
              <li key={q.kind}>
                <strong>{humanize(q.kind)}:</strong> {q.finding}
                {q.examples.length > 0 && <span className="dim"> — {q.examples.join('; ')}</span>}
              </li>
            ))}
          </ul>
        )}

        {board.counts.unassessedSignals > 0 && (
          <div className="alert warning small mt">
            {board.counts.unassessedSignals} record(s) have been ingested but not assessed, so they carry no score and
            are not shown below. Run <strong>Re-audit existing records</strong> to score them.
          </div>
        )}
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

      {board.accounts.length === 0 ? (
        <div className="card">
          <Empty>
            {board.counts.unassessedSignals > 0
              ? 'Records are waiting to be assessed. Run the re-audit above to score them.'
              : 'Nothing matching this filter.'}
          </Empty>
        </div>
      ) : (
        board.accounts.map((account) => {
          const origin = ORIGIN_LABEL[account.origin as DataOrigin] ?? ORIGIN_LABEL.MANUAL;
          const location = [account.cityName, account.stateCode].filter(Boolean).join(', ');
          // The account inherits its strongest candidacy's tier: one path with
          // a live solicitation makes the whole account worth a call.
          const bestTier = TIER_ORDER.find((tier) => account.hypotheses.some((h) => h.tier === tier))
            ?? 'DIRECTORY_PROSPECT';

          return (
            <div className="card" key={account.companyId}>
              <div className="card-title">
                <div>
                  <h2 style={{ marginBottom: '0.3rem' }}>
                    <Link href={`/companies/${account.companyId}`}>{account.name}</Link>
                  </h2>
                  <div className="row">
                    <Badge tone={TIER_TONE[bestTier] ?? ''}>{TIER_LABEL[bestTier]}</Badge>
                    <Badge tone={origin.tone}>{origin.label}</Badge>
                    {account.hypotheses.map((h) => (
                      <Badge key={h.id} tone="accent">{h.pathName}</Badge>
                    ))}
                    {account.quarantined && <Badge tone="danger">held back</Badge>}
                  </div>
                  <div className="tiny dim mt">
                    {/* The account's own location, never the market that surfaced it. */}
                    {location || 'location unknown'}
                    {account.hypotheses[0]?.marketName && <> · searched under {account.hypotheses[0].marketName}</>}
                    {account.collapsedSignals > 0 && (
                      <> · {account.collapsedSignals} duplicate record(s) collapsed into this account</>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {board.ranked && account.topPriority !== null && !account.quarantined ? (
                    <>
                      <div className="stat-value">{account.topPriority}</div>
                      <div className="tiny dim">priority</div>
                    </>
                  ) : (
                    <div className="tiny dim">{account.quarantined ? 'not ranked' : 'ranking withheld'}</div>
                  )}
                </div>
              </div>

              {account.quarantined && (
                <div className="alert warning tiny">
                  <strong>Identity cannot be verified:</strong> {account.quarantineReason}. Held out of ranking and out
                  of the credibility check rather than merged with anything or deleted.
                </div>
              )}

              {account.hypotheses.map((h) => (
                <HypothesisBlock key={h.id} h={h} />
              ))}

              <div className="divider" />

              <div className="row">
                <div className="tiny dim" style={{ flex: 1 }}>
                  {account.phone ? `☎ ${account.phone}` : account.email ? `✉ ${account.email}` : 'no contact yet'}
                  {account.website && ' · website on file'}
                </div>
              </div>

              {account.phone && (
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

/**
 * One path candidacy. Deliberately verbose about what it is not: the heading
 * above the service string carries the epistemic status, so a category match
 * cannot be skim-read as something the business told us.
 */
function HypothesisBlock({ h }: { h: RenderedHypothesis }) {
  return (
    <div className="mt" style={{ borderTop: '1px solid var(--border, #2a2a2a)', paddingTop: '0.75rem' }}>
      <div className="row">
        <Badge tone={TIER_TONE[h.tier] ?? ''}>{h.tierLabel}</Badge>
        <Badge tone={STAGE_TONE[h.stage] ?? ''}>{humanize(h.stage)}</Badge>
        <Badge>{h.pathName}</Badge>
        <Badge>{humanize(h.leadRole)}</Badge>
        {h.recency.known && h.recency.freshness ? (
          <Badge tone={FRESHNESS_TONE[h.recency.freshness]}>{h.recency.freshness.toLowerCase()}</Badge>
        ) : (
          <Badge>recency unknown</Badge>
        )}
        <Badge tone={h.need.asserted ? 'accent' : ''}>{h.need.asserted ? 'source fact' : 'our inference'}</Badge>
        <span className="tiny dim" style={{ marginLeft: 'auto' }}>priority {h.priority}</span>
      </div>

      <div className="tiny muted mt">
        <strong>Why this tier:</strong> {h.tierReason}
      </div>
      {h.rejectionFlags.length > 0 && (
        <div className="alert danger tiny mt">
          <strong>Rejected:</strong> {h.rejectionFlags.join('; ')}. Kept searchable, kept out of the work queue.
        </div>
      )}
      <div className="tiny dim">
        Outreach this evidence justifies: {h.outreach.channels.join(', ') || 'none'} — {h.outreach.note}
        {h.buyingWindow && h.buyingWindow !== 'UNKNOWN' && <> · buying window {humanize(h.buyingWindow)}</>}
      </div>

      {h.requiredService && (
        <div className="small mt">
          <strong>{h.need.heading}:</strong> {h.requiredService}
          <div className="tiny dim">{h.need.basis}</div>
        </div>
      )}

      <div className="grid grid-2 mt">
        <div>
          <div className="grid grid-4">
            <ScoreCell label="Account fit" value={h.accountFit} />
            <ScoreCell label="Intent" value={h.intent} note={h.intent === 0 ? 'caps priority at 35' : undefined} />
            <ScoreCell label="Contactability" value={h.contactability} />
            <ScoreCell label="Fulfilment" value={h.fulfilment} />
          </div>
          <ul className="list-reset tiny muted mt" style={{ lineHeight: 1.6 }}>
            {Object.entries(h.scoreExplanation).map(([key, reason]) => (
              <li key={key}>
                <strong>{humanize(key)}:</strong> {reason}
              </li>
            ))}
          </ul>
          {h.missing.length > 0 && (
            <div className="alert warning tiny mt">
              Not a qualified lead. Still missing {h.missing.join(', ')}.
            </div>
          )}
        </div>

        <div>
          <div className="tiny dim">Provenance</div>
          <div className="tiny muted" style={{ lineHeight: 1.7 }}>
            Source: {h.sourceNames.join(', ') || 'unknown'}
            {!h.isLiveSource && ' (fixture — not a real source)'}
            {h.signalCount > 1 && ` · ${h.signalCount} records collapsed`}
            <br />
            {/* Event time and discovery time, labelled as different things,
                because presenting the second as the first is what made every
                record look current. */}
            {h.recency.label}
            <br />
            {describeDiscoveryTime(h.firstDiscoveredAt)} Last seen {relativeDays(h.lastSeenAt)}.
            {h.lastIntentSignalAt && <> Last intent signal {relativeDays(h.lastIntentSignalAt)}.</>}
            <br />
            {h.sourceUrl ? (
              <a href={h.sourceUrl} target="_blank" rel="noreferrer noopener">
                Open the original record ↗
              </a>
            ) : (
              <span className="dim">No source link — this record cannot be verified externally.</span>
            )}
          </div>

          {h.evidence.length > 0 && (
            <>
              <div className="tiny dim mt">Evidence for the classification</div>
              <div className="tiny mono muted">{h.evidence.join(' · ')}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterChip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className={`filter-chip${active ? ' active' : ''}`}>
      {children}
    </Link>
  );
}
