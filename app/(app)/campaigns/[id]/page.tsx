import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { can } from '@/lib/auth/session';
import { loadCampaign } from '@/lib/campaign/service';
import { TASK_INTENT, type TaskKind } from '@/lib/campaign/execute';
import { needsBudget } from '@/lib/campaign/model';
import { CLASS_BADGE } from '@/lib/evidence/claims';
import { ActionButton } from '@/components/ActionButton';
import { CampaignAssignment } from '@/components/CampaignAssignment';
import { campaignProgress, previewCampaignAssignment } from '@/lib/campaign/assign';
import { Badge, Empty, humanize, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * One campaign, as an operating document rather than a record.
 *
 * The order is the argument, and it is the order somebody deciding whether to
 * keep spending on this needs:
 *
 *   What it believes, and what would make it wrong. The contrary evidence sits
 *   beside the supporting evidence rather than below it, because a thesis with
 *   nothing against it has not been tested, it has been asserted.
 *
 *   What finding out costs, and who said that was allowed. A campaign that can
 *   spend without a named authority is a campaign nobody is accountable for.
 *
 *   What it produced, all the way to money that arrived — with the first empty
 *   rung named, because "nine hundred routes, no collected profit" and "nine
 *   hundred routes, no conversations" are different failures wanting different
 *   fixes.
 *
 *   What would end it, and whether that has happened yet. A kill condition
 *   nobody can see is a note; one on the page with its current value beside it
 *   is a control.
 *
 * Everything on it that is a claim carries its evidence class, on the same rule
 * as the rest of the product.
 */
export default async function CampaignPage({ params }: { params: { id: string } }) {
  const user = await requirePagePermission('campaign.read');

  const loaded = await prisma.campaign
    .findFirst({ where: { id: params.id, orgId: user.orgId }, select: { id: true } })
    .then((c) => (c ? loadCampaign({ orgId: user.orgId, campaignId: params.id }) : null));
  if (!loaded) notFound();

  const { campaign, outcome, readiness, conditions } = loaded;
  const mayWrite = can(user, 'campaign.write');
  const mayAuthorise = can(user, 'campaign.authorise');

  // What it is trying to reach, and who could work it. Loaded with the page
  // rather than behind a click, because a campaign that shows its activity and
  // not its targets is how one that quotes well and collects nothing survives.
  const [progress, assignment, callers] = await Promise.all([
    campaignProgress({ orgId: user.orgId, campaignId: campaign.id }),
    previewCampaignAssignment({ orgId: user.orgId, campaignId: campaign.id }),
    prisma.user.findMany({
      where: { orgId: user.orgId, isActive: true, callerProfile: { isNot: null } },
      orderBy: { name: 'asc' },
      take: 50,
      select: { id: true, name: true, callerProfile: { select: { dataMode: true } } },
    }),
  ]);

  const [tasks, routes] = await Promise.all([
    prisma.campaignTask.findMany({
      where: { orgId: user.orgId, campaignId: campaign.id },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 60,
      select: {
        id: true, kind: true, intent: true, status: true, result: true,
        evidenceClass: true, sourceUrl: true, because: true, completedAt: true,
        company: { select: { legalName: true } },
      },
    }),
    prisma.routeHypothesis.findMany({
      where: { orgId: user.orgId, campaignId: campaign.id, status: { notIn: ['EXPIRED', 'REJECTED'] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, headline: true, status: true, company: { select: { legalName: true } } },
    }),
  ]);

  const supporting = campaign.evidence.filter((e) => e.kind === 'SUPPORTING');
  const contrary = campaign.evidence.filter((e) => e.kind === 'CONTRARY');

  // The chain, so the page can show where it stopped rather than only the last
  // number on it.
  const chain: Array<{ label: string; value: number; money?: boolean }> = [
    { label: 'Routes generated', value: outcome.routesGenerated },
    { label: 'Conversations held', value: outcome.conversationsHeld },
    { label: 'Requirements confirmed', value: outcome.requirementsConfirmed },
    { label: 'Providers verified', value: outcome.providersVerified },
    { label: 'Quotes sent', value: outcome.quotesSent },
    { label: 'Commitments won', value: outcome.commitmentsWon },
    { label: 'Collected gross profit', value: outcome.collectedGrossProfit, money: true },
  ];

  return (
    <>
      <div className="page-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row mb">
            <Badge tone={stateTone(campaign.state)}>{humanize(campaign.state)}</Badge>
            <Badge>{humanize(campaign.route)}</Badge>
            {campaign.dataMode === 'TEST' && <Badge tone="warning">practice</Badge>}
          </div>
          <h1>{campaign.name}</h1>
          <p>
            {campaign.targetStates.join(', ') || 'no target geography'} · {campaign.requiredCapability}
            {campaign.authorityBy && <> · authorised by {campaign.authorityBy.name}</>}
          </p>
        </div>
        <Link href="/campaigns" className="btn secondary">All campaigns</Link>
      </div>

      {/* ---- what it believes ------------------------------------------- */}
      <div className="card" data-testid="campaign-thesis">
        <h2>What this believes</h2>
        <p className="pre-wrap">{campaign.thesis}</p>
        <h4 className="mt">Why now</h4>
        <p className="pre-wrap small muted">{campaign.whyNow}</p>

        <div className="grid grid-2 mt">
          <div>
            <h4>Who buys</h4>
            <p className="small muted pre-wrap">{campaign.buyerProfile}</p>
          </div>
          <div>
            <h4>Who delivers</h4>
            <p className="small muted pre-wrap">{campaign.providerProfile}</p>
          </div>
        </div>
      </div>

      {/* ---- evidence, both ways ---------------------------------------- */}
      <div className="two-col">
        <div className="card" data-testid="campaign-supporting">
          <div className="card-title">
            <h2>Evidence for</h2>
            <span className="tiny dim">{supporting.length}</span>
          </div>
          {supporting.length === 0 ? (
            <Empty>Nothing supports this yet, which makes the thesis an opinion.</Empty>
          ) : (
            <EvidenceList rows={supporting} />
          )}
        </div>

        <div className="card" data-testid="campaign-contrary">
          <div className="card-title">
            <h2>Evidence against</h2>
            <span className="tiny dim">{contrary.length}</span>
          </div>
          {contrary.length === 0 ? (
            <Empty>
              Nothing has been recorded against this. A thesis with no contrary evidence has not been tested —
              it has been asserted, and the first thing that goes wrong will be a surprise.
            </Empty>
          ) : (
            <EvidenceList rows={contrary} />
          )}
        </div>
      </div>

      {/* ---- what finding out costs ------------------------------------- */}
      <div className="card" data-testid="campaign-cost">
        <h2>What finding out costs</h2>
        <div className="grid grid-4">
          <div className="stat">
            <div className="stat-label">Testing time</div>
            <div className="stat-value">{campaign.testingHours}h</div>
            <div className="tiny dim">{campaign.testingCostBasis}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Testing cost</div>
            <div className="stat-value">{money(campaign.testingCostCents / 100)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Spend authority</div>
            <div className="stat-value">
              {campaign.budgetCents === null
                ? <span className="small dim">none</span>
                : money(campaign.budgetCents / 100)}
            </div>
            <div className="tiny dim">
              {campaign.authorityBy
                ? `granted by ${campaign.authorityBy.name}`
                : 'nobody has granted spend authority'}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Spent so far</div>
            <div className="stat-value">{money(outcome.spendCents / 100)}</div>
            <div className="tiny dim">
              {outcome.returnOnSpend === null
                ? 'nothing spent, so there is no return to state'
                : `${money(outcome.returnOnSpend)} collected per pound spent`}
            </div>
          </div>
        </div>
      </div>

      {/* ---- channels, each with its authority --------------------------- */}
      <div className="card" data-testid="campaign-channels">
        <div className="card-title">
          <h2>Channels</h2>
          <span className="tiny dim">Anything that moves money needs a named authority and a measurable outcome</span>
        </div>
        {campaign.channels.length === 0 ? (
          <Empty>No channels are configured, so this campaign reaches nobody.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="table tiny">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>State</th>
                  <th className="num">Authorised</th>
                  <th className="num">Spent</th>
                  <th>Authority</th>
                  <th>Measured by</th>
                </tr>
              </thead>
              <tbody>
                {campaign.channels.map((channel) => (
                  <tr key={channel.id} data-testid={`channel-${channel.kind}`}>
                    <td><strong>{humanize(channel.kind)}</strong></td>
                    <td>
                      <Badge tone={channel.enabled ? 'success' : ''}>
                        {channel.enabled ? 'enabled' : 'off'}
                      </Badge>
                    </td>
                    <td className="num">
                      {channel.budgetCents === null
                        ? <span className="dim">{needsBudget(channel.kind) ? 'none — cannot spend' : 'not applicable'}</span>
                        : money(channel.budgetCents / 100)}
                    </td>
                    <td className="num">{money(channel.spentCents / 100)}</td>
                    <td className="tiny dim">
                      {channel.authorisedById
                        ? (channel.authorityNote ?? 'authorised')
                        : needsBudget(channel.kind)
                          ? 'Nobody authorised this, so nothing may be spent on it.'
                          : 'No spend, so no authority needed.'}
                    </td>
                    <td className="tiny dim">
                      {channel.outcomeMetric
                        ? humanize(channel.outcomeMetric)
                        : needsBudget(channel.kind)
                          ? 'Nothing downstream is measuring this. Spend on it would be a donation.'
                          : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- what came back ---------------------------------------------- */}
      <div className="card" data-testid="campaign-outcome">
        <div className="card-title">
          <h2>What came back</h2>
          <span className="tiny dim">
            {outcome.daysRunning > 0 ? `${outcome.daysRunning} day(s) running` : 'not started'}
          </span>
        </div>
        <div className="table-scroll">
          <table className="table tiny">
            <tbody>
              {chain.map((rung) => {
                const isFirstEmpty = outcome.firstEmptyStage === rung.label.toLowerCase();
                return (
                  <tr key={rung.label} data-testid={`rung-${rung.label.replace(/\s+/g, '-').toLowerCase()}`}>
                    <td style={{ width: '14rem' }}>{rung.label}</td>
                    <td className="num">
                      {rung.value === 0
                        ? <span className="dim">none</span>
                        : <strong>{rung.money ? money(rung.value) : rung.value}</strong>}
                    </td>
                    <td>
                      {isFirstEmpty && (
                        <Badge tone="warning">
                          first empty rung — everything above it worked, this is where it stopped
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {outcome.firstEmptyStage === null && (
          <div className="alert success small mt">
            Every rung has something in it, including collected gross profit. This campaign has been proved,
            not merely progressed.
          </div>
        )}
      </div>

      {/* ---- where it stands against its own thresholds ------------------ */}
      {progress && progress.targets.length > 0 && (
        <div className="card" data-testid="campaign-targets">
          <div className="card-title">
            <h2>Where it stands against what it set out to do</h2>
            <span className="tiny dim">Taken from its own conditions, so the two cannot disagree</span>
          </div>
          <p className="tiny dim">
            A target nobody attached a consequence to is a wish. These are the thresholds this campaign already
            said would stop it or grow it, read against what has actually happened.
          </p>
          <div className="table-scroll">
            <table className="table tiny">
              <thead>
                <tr>
                  <th>What</th>
                  <th className="num">Now</th>
                  <th className="num">Threshold</th>
                  <th>Where that leaves it</th>
                </tr>
              </thead>
              <tbody>
                {progress.targets.map((target) => (
                  <tr key={`${target.kind}-${target.metric}`} data-testid={`target-${target.metric}`}>
                    <td>
                      <Badge tone={target.kind === 'KILL' ? 'danger' : 'success'}>{humanize(target.kind)}</Badge>{' '}
                      {humanize(target.metric).toLowerCase()}
                    </td>
                    <td className="num">{target.current}</td>
                    <td className="num">{target.target}</td>
                    <td className="tiny">
                      {target.standing}
                      {target.daysUntilJudged !== null && target.daysUntilJudged > 0 && (
                        <div className="dim">{target.daysUntilJudged} day(s) before this is read.</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <CampaignAssignment
        campaignId={campaign.id}
        assignment={'error' in assignment ? null : assignment}
        callers={callers.map((c) => ({
          id: c.id,
          name: c.name,
          mode: c.callerProfile?.dataMode ?? 'PRODUCTION',
        }))}
        canAssign={can(user, 'call.assignment.write')}
      />

      {/* ---- what would end it ------------------------------------------- */}
      <div className="card" data-testid="campaign-conditions">
        <div className="card-title">
          <h2>What would end it, and what would grow it</h2>
          <span className="tiny dim">Evaluated on a schedule, not when somebody remembers</span>
        </div>
        {conditions.length === 0 ? (
          <Empty>
            No conditions are set, so nothing will stop this campaign except a person noticing. That is the
            state every campaign that overran its budget was in the day before.
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="table tiny">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Condition</th>
                  <th className="num">Now</th>
                  <th>Standing</th>
                </tr>
              </thead>
              <tbody>
                {conditions.map((condition) => (
                  <tr key={condition.id} data-testid={`condition-${condition.kind}`}>
                    <td>
                      <Badge tone={condition.kind === 'KILL' ? 'danger' : 'success'}>
                        {humanize(condition.kind)}
                      </Badge>
                    </td>
                    <td>
                      {condition.statement}
                      <div className="tiny dim">
                        {humanize(condition.metric)} {humanize(condition.comparator).toLowerCase()}{' '}
                        {condition.threshold}
                        {condition.afterDays > 0 && `, after ${condition.afterDays} day(s)`}
                      </div>
                    </td>
                    <td className="num">
                      {condition.evaluation.value === null
                        ? <span className="dim">no value</span>
                        : condition.evaluation.value}
                    </td>
                    <td className="tiny">
                      {condition.met
                        ? <Badge tone={condition.kind === 'KILL' ? 'danger' : 'success'}>met</Badge>
                        : <span className="dim">{condition.evaluation.because}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- the work it generated --------------------------------------- */}
      <div className="card" data-testid="campaign-work">
        <div className="card-title">
          <h2>Work it generated</h2>
          <span className="tiny dim">
            {tasks.filter((t) => t.status === 'PENDING').length} outstanding of {tasks.length} shown
          </span>
        </div>
        {tasks.length === 0 ? (
          <Empty>
            {campaign.state === 'RUNNING' || campaign.state === 'EXPANDED'
              ? 'Nothing has been generated yet. Generating work is the first thing a running campaign does.'
              : `A ${humanize(campaign.state).toLowerCase()} campaign generates nothing. It starts producing work when it starts running.`}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="table tiny">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Concerns</th>
                  <th>State</th>
                  <th>What it found</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <strong>{humanize(task.kind)}</strong>
                      <div className="tiny dim">{TASK_INTENT[task.kind as TaskKind] ?? task.intent}</div>
                    </td>
                    <td className="dim">{task.company?.legalName ?? 'the route'}</td>
                    <td><Badge tone={task.status === 'DONE' ? 'success' : task.status === 'FAILED' ? 'danger' : ''}>{humanize(task.status)}</Badge></td>
                    <td>
                      {task.result ? (
                        <>
                          {task.result} <Badge>{CLASS_BADGE[task.evidenceClass]}</Badge>
                          {task.sourceUrl && (
                            <> · <a href={task.sourceUrl} target="_blank" rel="noreferrer noopener">source ↗</a></>
                          )}
                        </>
                      ) : (
                        // A task that found nothing says why. The alternative is
                        // a blank cell, which reads as "not tried" and is the
                        // reason the same lookup gets requested four times.
                        <span className="dim">{task.because ?? 'Not attempted yet.'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {routes.length > 0 && (
        <div className="card">
          <div className="card-title">
            <h2>Routes it produced</h2>
            <span className="tiny dim">{outcome.routesGenerated} in total</span>
          </div>
          <ul className="list-reset small muted" style={{ lineHeight: 1.7 }}>
            {routes.map((route) => (
              <li key={route.id}>
                · <Link href={`/demand/opportunity/${route.id}`}>{route.company.legalName}</Link> — {route.headline}{' '}
                <span className="dim">({humanize(route.status).toLowerCase()})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- what may be done to it -------------------------------------- */}
      {mayWrite && (
        <div className="card" data-testid="campaign-actions">
          <h2>Actions</h2>

          {!readiness.ready && (
            <div className="alert warning small" data-testid="campaign-blockers">
              <strong>This cannot run yet — {readiness.blockers.length} thing(s) missing:</strong>
              <ul className="list-reset mt">
                {readiness.blockers.map((blocker) => (
                  <li key={blocker.field}>• <strong>{blocker.field}:</strong> {blocker.because}</li>
                ))}
              </ul>
            </div>
          )}

          {!mayAuthorise && (
            <p className="tiny dim">
              Starting a campaign commits time and, where a paid channel is enabled, money. You can draft and
              generate work; somebody with campaign authority has to start it.
            </p>
          )}

          <div className="row">
            {campaign.state === 'DRAFT' && (
              <ActionButton
                endpoint={`/api/campaigns/${campaign.id}`}
                body={{ action: 'transition', to: 'AWAITING_AUTHORITY' }}
              >
                Submit for authority
              </ActionButton>
            )}
            {mayAuthorise && (campaign.state === 'AWAITING_AUTHORITY' || campaign.state === 'PAUSED') && (
              <ActionButton
                endpoint={`/api/campaigns/${campaign.id}`}
                body={{ action: 'transition', to: 'RUNNING' }}
                className="primary"
              >
                Authorise and start
              </ActionButton>
            )}
            {(campaign.state === 'RUNNING' || campaign.state === 'EXPANDED') && (
              <>
                <ActionButton
                  endpoint={`/api/campaigns/${campaign.id}`}
                  body={{ action: 'generate_work' }}
                  className="primary"
                >
                  Generate work
                </ActionButton>
                <ActionButton endpoint={`/api/campaigns/${campaign.id}`} body={{ action: 'run_tasks' }}>
                  Run outstanding tasks
                </ActionButton>
                <ActionButton
                  endpoint={`/api/campaigns/${campaign.id}`}
                  body={{ action: 'transition', to: 'PAUSED' }}
                  className="secondary"
                >
                  Pause
                </ActionButton>
                <ActionButton
                  endpoint={`/api/campaigns/${campaign.id}`}
                  body={{ action: 'transition', to: 'KILLED' }}
                  className="danger"
                  promptFor={{ key: 'reason', label: 'Why is this being killed? The learning is the only thing it produced for certain.' }}
                >
                  Kill
                </ActionButton>
                <ActionButton
                  endpoint={`/api/campaigns/${campaign.id}`}
                  body={{ action: 'conclude' }}
                  promptFor={{ key: 'learning', label: 'What did this establish? (at least a sentence)' }}
                >
                  Conclude
                </ActionButton>
              </>
            )}
          </div>

          {campaign.endedReason && (
            <div className="alert info small mt">
              <strong>How it ended:</strong> {campaign.endedReason}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function EvidenceList({
  rows,
}: {
  rows: Array<{
    id: string;
    claim: string;
    evidenceClass: keyof typeof CLASS_BADGE;
    sourceUrl: string | null;
    observedAt: Date | null;
    note: string | null;
  }>;
}) {
  return (
    <ul className="list-reset small" style={{ lineHeight: 1.7 }}>
      {rows.map((row) => (
        <li key={row.id} style={{ padding: '0.35rem 0', borderBottom: '1px solid var(--border)' }}>
          {row.claim} <Badge>{CLASS_BADGE[row.evidenceClass]}</Badge>
          <div className="tiny dim">
            {row.sourceUrl ? (
              <a href={row.sourceUrl} target="_blank" rel="noreferrer noopener">source ↗</a>
            ) : (
              'No source recorded, so this rests on somebody\'s reading.'
            )}
            {/* The date the source stated, never our own clock — a claim dated
                by when we happened to read it is not dated. */}
            {row.observedAt && ` · stated ${row.observedAt.toISOString().slice(0, 10)}`}
            {row.note && ` · ${row.note}`}
          </div>
        </li>
      ))}
    </ul>
  );
}

function stateTone(state: string): string {
  if (state === 'RUNNING' || state === 'EXPANDED') return 'success';
  if (state === 'KILLED') return 'danger';
  if (state === 'AWAITING_AUTHORITY' || state === 'PAUSED') return 'warning';
  return '';
}
