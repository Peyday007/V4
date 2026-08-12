import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { buildBrief } from '@/lib/manager/brief';
import { CAPABILITY_LABELS, RUNG_LABELS } from '@/lib/manager/rules';
import { Badge, Empty } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The System Manager, for a person.
 *
 * Everything on this page is written to be argued with. A conclusion says who
 * produced it and which version of the rules; a question shows the innocent
 * explanations alongside the observation; an intervention that is doing nothing
 * says so in the same size type as one that is in force.
 *
 * That last one is the easiest to get wrong. A screen that lists shadow-mode
 * decisions next to enforced ones without distinguishing them teaches an owner
 * that the system is stricter than it is — and then, when shadow mode comes off,
 * nothing on the screen changes and nobody notices that it now bites.
 */
export default async function ManagerPage() {
  const user = await requirePagePermission('analytics.caller.read.all');

  const [brief, cases, interventions, breakers, readiness] = await Promise.all([
    buildBrief({ orgId: user.orgId, period: 'DAILY' }),
    prisma.consistencyCase.findMany({
      where: { orgId: user.orgId, state: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: 40,
      include: { caller: { select: { name: true } }, route: { select: { id: true, headline: true } } },
    }),
    prisma.intervention.findMany({
      where: { orgId: user.orgId, state: { in: ['SHADOW', 'PROPOSED', 'ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
      take: 40,
      include: { caller: { select: { name: true } } },
    }),
    prisma.circuitBreaker.findMany({
      where: { orgId: user.orgId, state: 'OPEN' },
      orderBy: { openedAt: 'desc' },
    }),
    prisma.shiftReadiness.findMany({
      where: { orgId: user.orgId, shiftDate: { gte: new Date(Date.now() - 2 * 86_400_000) } },
      orderBy: { checkedAt: 'desc' },
      include: { caller: { select: { name: true } } },
      take: 20,
    }),
  ]);

  const enforced = interventions.filter((i) => i.state === 'ACTIVE' && !i.shadow);
  const shadowed = interventions.filter((i) => i.shadow);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>System manager</h1>
          <p>{brief.headline}</p>
        </div>
        <Badge tone={breakers.length > 0 ? 'danger' : cases.length > 0 ? 'warning' : 'success'}>
          {breakers.length > 0 ? `${breakers.length} stopped` : `${cases.length} open`}
        </Badge>
      </div>

      {/* --- what is stopped, and whose fault it is not ------------------- */}
      <div className="card" data-testid="breakers">
        <h2 style={{ marginTop: 0 }}>Capabilities stopped</h2>
        {breakers.length === 0 ? (
          <Empty>Nothing is stopped. Every capability we watch is passing work.</Empty>
        ) : (
          <>
            <p className="small">
              These are ours. Nobody is in trouble for work that could not be done while a capability was down, and
              nothing attempted during one of these counts against the person who attempted it.
            </p>
            <table className="table tiny">
              <thead><tr><th>Capability</th><th>Since</th><th>Why</th></tr></thead>
              <tbody>
                {breakers.map((b) => (
                  <tr key={b.id} data-testid="breaker">
                    <td>{CAPABILITY_LABELS[b.capability]}</td>
                    <td>{b.openedAt?.toISOString().slice(0, 16).replace('T', ' ')}</td>
                    <td>{b.openedBecause}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* --- the owner's own decisions ------------------------------------ */}
      <div className="card" data-testid="owner-decisions">
        <h2 style={{ marginTop: 0 }}>Waiting on somebody&rsquo;s authority</h2>
        {brief.ownerDecisions.length === 0 ? (
          <Empty>Nothing is waiting on a decision.</Empty>
        ) : (
          <ul className="small">
            {brief.ownerDecisions.map((decision, at) => (
              <li key={at} data-testid="owner-decision">
                <strong>{decision.what}</strong>
                {decision.waitingSince && <span className="tiny dim"> · waiting {decision.waitingSince}</span>}
                <div className="tiny">{decision.why}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- questions, not findings -------------------------------------- */}
      <div className="card" data-testid="cases">
        <h2 style={{ marginTop: 0 }}>Records that do not line up</h2>
        <p className="tiny dim">
          Each of these is a question. The same observation is produced by a dropped save, an ordinary short call and
          somebody padding their numbers, and the record cannot tell them apart — so every one carries the innocent
          explanations alongside it, and nothing here is anybody&rsquo;s fault until a person says so.
        </p>
        {cases.length === 0 ? (
          <Empty>Nothing is out of line.</Empty>
        ) : (
          cases.map((row) => (
            <div className="alert small" key={row.id} data-testid="case">
              <div className="row">
                <Badge>{row.kind.toLowerCase().replace(/_/g, ' ')}</Badge>
                <span className="tiny dim" data-testid="case-actor">
                  concluded by {row.producedBy}@{row.ruleVersion} · {Math.round(row.confidence * 100)}% sure the
                  records disagree
                </span>
              </div>
              <p style={{ marginBottom: 4 }}><strong>Observed:</strong> {row.observed}</p>
              <p style={{ marginBottom: 4 }}><strong>Expected:</strong> {row.expected}</p>
              <div className="tiny" data-testid="benign">
                <strong>Ordinary reasons this happens:</strong>
                <ul>
                  {(row.benignAlternatives as string[]).map((alt, at) => <li key={at}>{alt}</li>)}
                </ul>
              </div>
              <p className="tiny dim">
                {row.caller ? `About ${row.caller.name}.` : 'Not attributed to anybody.'}
                {row.answer ? ` They said: “${row.answer}”` : row.askedAt ? ' Asked, no answer yet.' : ' Not yet put to them.'}
              </p>
              {row.route && (
                <Link href={`/demand/opportunity/${row.route.id}`} className="btn sm">Open the opportunity</Link>
              )}
            </div>
          ))
        )}
      </div>

      {/* --- in force ------------------------------------------------------ */}
      <div className="card" data-testid="enforced">
        <h2 style={{ marginTop: 0 }}>In force</h2>
        {enforced.length === 0 ? (
          <Empty>Nothing is restricting anybody.</Empty>
        ) : (
          <table className="table tiny">
            <thead><tr><th>Who</th><th>Rung</th><th>Capability</th><th>Ends when</th></tr></thead>
            <tbody>
              {enforced.map((i) => (
                <tr key={i.id} data-testid="active-intervention">
                  <td>{i.caller?.name ?? '—'}</td>
                  <td>{RUNG_LABELS[i.rung]}</td>
                  <td>{i.capability ? CAPABILITY_LABELS[i.capability] : '—'}</td>
                  <td data-testid="restoration">{i.restorationRule ?? 'Not stated — this should not be possible.'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- shadow mode --------------------------------------------------- */}
      <div className="card" data-testid="shadow">
        <h2 style={{ marginTop: 0 }}>Recorded, doing nothing</h2>
        <p className="tiny dim">
          These are decisions the rules would have made. They are deliberately not in force: rules that have never run
          against real work do not get to take work away from real people, and the way to find out whether they are
          right is to let them run silently and read what they would have done.
        </p>
        {shadowed.length === 0 ? (
          <Empty>Nothing has been decided in shadow.</Empty>
        ) : (
          <table className="table tiny">
            <thead><tr><th>Who</th><th>Rung</th><th>State</th><th>Why</th></tr></thead>
            <tbody>
              {shadowed.map((i) => (
                <tr key={i.id} data-testid="shadow-intervention">
                  <td>{i.caller?.name ?? '—'}</td>
                  <td>{RUNG_LABELS[i.rung]}</td>
                  <td>
                    <Badge>{i.state === 'PROPOSED' ? 'proposed, not applied' : 'shadow, no effect'}</Badge>
                  </td>
                  <td>
                    {i.reason}
                    <div className="tiny dim">decided by {i.producedBy}@{i.ruleVersion}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- readiness ----------------------------------------------------- */}
      <div className="card" data-testid="readiness">
        <h2 style={{ marginTop: 0 }}>Who could start work</h2>
        {readiness.length === 0 ? (
          <Empty>No readiness checks in the last two days.</Empty>
        ) : (
          <table className="table tiny">
            <thead><tr><th>Caller</th><th>State</th><th>Ready to call</th><th>Blocked by</th></tr></thead>
            <tbody>
              {readiness.map((r) => (
                <tr key={r.id} data-testid="readiness-row">
                  <td>{r.caller.name}</td>
                  <td>
                    <Badge tone={r.state === 'BLOCKED_BY_SYSTEM' ? 'danger' : r.state === 'READY' ? 'success' : 'warning'}>
                      {r.state.toLowerCase().replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td>{r.workReady}</td>
                  <td>
                    {(r.blockers as Array<{ whose: string; what: string }>).length === 0
                      ? '—'
                      : (r.blockers as Array<{ whose: string; what: string }>).map((b, at) => (
                          <div key={at} data-testid="blocker">
                            <strong>{b.whose === 'ours' ? 'ours' : 'theirs'}:</strong> {b.what}
                          </div>
                        ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- strengths ----------------------------------------------------- */}
      <div className="card" data-testid="strengths">
        <h2 style={{ marginTop: 0 }}>Worth copying</h2>
        {brief.strengths.length === 0 ? (
          <Empty>No strength claims this period.</Empty>
        ) : (
          brief.strengths.map((s, at) => (
            <div className="alert small" key={at} data-testid="strength">
              <strong>{s.callerName}: {s.what}</strong>
              <div className="tiny">{s.evidence}</div>
              <div className="tiny dim">{s.suggestion}</div>
            </div>
          ))
        )}
      </div>

      {/* --- what was not concluded ---------------------------------------- */}
      <div className="card" data-testid="withheld">
        <h2 style={{ marginTop: 0 }}>What this could not tell you</h2>
        {brief.withheld.length === 0 ? (
          <Empty>Nothing was withheld.</Empty>
        ) : (
          <ul className="small">
            {brief.withheld.map((line, at) => <li key={at} data-testid="withheld-item">{line}</li>)}
          </ul>
        )}
      </div>
    </>
  );
}
