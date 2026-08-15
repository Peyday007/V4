import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requirePageAny } from '@/lib/auth/page';
import { callerDetail } from '@/lib/caller/roster';
import { Badge, Empty } from '@/components/ui';
import { CallerDetailActions } from '@/components/CallerDetailActions';
import { callerLearning } from '@/lib/caller/learning';
import { IncidentResolution } from '@/components/IncidentResolution';

export const dynamic = 'force-dynamic';

const PIN_TONE: Record<string, string | undefined> = {
  ACTIVE: 'success', NONE: undefined, LOCKED: 'warning', REVOKED: 'danger',
};

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

/**
 * One caller, in full.
 *
 * The floor answers "who is on and what are they holding". This answers the
 * questions that come next and do not fit on a card: what have they actually
 * done, what did they promise, what is blocked, and what happens if I take
 * their access away.
 *
 * The order is deliberate. Access and status first, because that is what
 * somebody opening this page usually came to change. Then the work in hand,
 * then the history — and the history is last because it is the part nobody
 * needs until something has gone wrong.
 */
export default async function CallerDetailPage({ params }: { params: { callerId: string } }) {
  const user = await requirePageAny('call.assignment.read.all', 'admin.users');

  const detail = await callerDetail({ orgId: user.orgId, callerId: params.callerId });
  if (!detail) notFound();

  // What their calls established, rather than how many they made. A call count
  // measures effort; this measures what came back.
  const learning = await callerLearning({ orgId: user.orgId, callerId: params.callerId });

  const [attempts, callbacks] = await Promise.all([
    prisma.outreachAttempt.findMany({
      where: { orgId: user.orgId, userId: params.callerId },
      orderBy: { occurredAt: 'desc' },
      take: 25,
      select: {
        id: true, disposition: true, occurredAt: true, notes: true, dataMode: true,
        route: {
          select: {
            id: true,
            company: { select: { legalName: true, operatingName: true } },
          },
        },
      },
    }),
    prisma.packetItem.findMany({
      where: {
        orgId: user.orgId, callerId: params.callerId,
        status: { in: ['PENDING', 'IN_PROGRESS'] },
        route: { outreach: { snoozeUntil: { not: null } } },
      },
      orderBy: { createdAt: 'asc' },
      take: 25,
      select: {
        id: true,
        route: {
          select: {
            id: true,
            company: { select: { legalName: true, operatingName: true } },
            outreach: { select: { snoozeUntil: true } },
          },
        },
      },
    }),
  ]);

  const now = Date.now();

  return (
    <>
      <div className="page-header">
        <div>
          <h1>
            {detail.name}
            {detail.mode === 'TEST' && <> <Badge tone="warning">TEST</Badge></>}
            {!detail.isActive && <> <Badge tone="danger">deactivated</Badge></>}
          </h1>
          <p>
            {detail.email} · {detail.timezone}
            {detail.label ? ` · ${detail.label}` : ''}
          </p>
        </div>
        <Link href="/callers" className="btn secondary" data-testid="back-to-floor">Back to the floor</Link>
      </div>

      {/* --- at a glance --------------------------------------------------- */}
      <div className="card" data-testid="detail-summary">
        <div className="row" style={{ gap: '1.5rem', flexWrap: 'wrap' }}>
          <Fact label="Access">
            <Badge tone={PIN_TONE[detail.pin.status]}>{detail.pin.status.toLowerCase().replace(/_/g, ' ')}</Badge>
          </Fact>
          <Fact label="Waiting">{detail.waiting}</Fact>
          <Fact label="Worked today">{detail.workedToday}</Fact>
          <Fact label="Callbacks due">{detail.overdueCallbacks}</Fact>
          <Fact label="Open packets">{detail.openPackets}</Fact>
          <Fact label="Last call">{ago(detail.lastAttemptAt)}</Fact>
          <Fact label="Last sign-in">{ago(detail.lastSignInAt)}</Fact>
        </div>

        {detail.pin.issuedAt && (
          <p className="tiny dim" data-testid="pin-provenance">
            PIN issued {ago(detail.pin.issuedAt)}{detail.pin.issuedBy ? ` by ${detail.pin.issuedBy}` : ''}
            {detail.pin.lastUsedAt ? `, last used ${ago(detail.pin.lastUsedAt)}` : ', never used'}.
            The PIN itself is not stored and cannot be read back.
          </p>
        )}
        {detail.pin.lockedUntil && new Date(detail.pin.lockedUntil).getTime() > now && (
          <div className="alert small" data-testid="pin-locked">
            Locked out after too many wrong PINs, until {new Date(detail.pin.lockedUntil).toISOString().slice(11, 16)} UTC.
            Issuing a new PIN clears it immediately.
          </div>
        )}
        {detail.restrictions > 0 && (
          <div className="alert small" data-testid="detail-restrictions">
            {detail.restrictions} capability restriction(s) in force from the system manager.
          </div>
        )}
      </div>

      <CallerDetailActions
        callerId={detail.callerId}
        name={detail.name}
        isActive={detail.isActive}
        pinStatus={detail.pin.status}
      />

      {/* --- what their calls established ---------------------------------- */}
      <div className="card" data-testid="detail-learning">
        <div className="card-title">
          <h2>What their calls established</h2>
          <span className="tiny dim">What came back, not how many were made</span>
        </div>
        <p className="small" data-testid="detail-learning-sentence">{learning.sentence}</p>

        {learning.strongest.length > 0 && (
          <div className="mt">
            <div className="tiny dim">What they most often get answered</div>
            <div className="row tiny mt" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
              {learning.strongest.map((s) => (
                <span key={s.what} className="badge">{s.what}: <strong>{s.count}</strong></span>
              ))}
            </div>
          </div>
        )}

        {/* A caller who disproves a thesis has done better work than one who
            confirms a requirement nobody will buy, and this is the only place
            that shows it. */}
        {learning.disproved.length > 0 && (
          <div className="mt" data-testid="detail-learning-disproved">
            <div className="tiny dim">Hypotheses they closed, with the reason</div>
            <ul className="list-reset small mt" style={{ lineHeight: 1.7 }}>
              {learning.disproved.slice(0, 8).map((d) => (
                <li key={`${d.organisation}-${d.on}`}>
                  <strong>{d.organisation}</strong> — {d.because} <span className="dim">({d.on})</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {learning.disputes.length > 0 && (
          <div className="alert warning small mt" data-testid="detail-learning-disputes">
            <strong>{learning.disputes.length} answer(s) disagree with what somebody else was told.</strong>
            <ul className="list-reset tiny mt" style={{ paddingLeft: '1rem' }}>
              {learning.disputes.slice(0, 5).map((d) => (
                <li key={`${d.organisation}-${d.on}`}>{d.organisation}: {d.statement}</li>
              ))}
            </ul>
            <div className="tiny mt">
              Not a fault. Two people were told different things and one call settles it.
            </div>
          </div>
        )}
      </div>

      {/* --- ours to fix ---------------------------------------------------- */}
      <div className="card" data-testid="detail-incidents">
        <h2 style={{ marginTop: 0 }}>System failures on their work</h2>
        <p className="small muted">
          Ours, not theirs. A caller with an unresolved save failure is held out of new work and is never counted
          as idle for it.
        </p>
        {detail.incidents.length === 0 ? (
          <Empty>Nothing of ours is blocking them.</Empty>
        ) : (
          <table className="table tiny">
            <thead><tr><th>When</th><th>What broke</th><th /></tr></thead>
            <tbody>
              {detail.incidents.map((i) => (
                <tr key={i.id} data-testid="detail-incident">
                  <td className="dim">{ago(i.createdAt)}</td>
                  <td>
                    <Badge tone="danger">{i.kind.toLowerCase().replace(/_/g, ' ')}</Badge>
                    <div className="dim">{i.detail.slice(0, 200)}</div>
                  </td>
                  <td><IncidentResolution callerId={detail.callerId} incidentId={i.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- promises ------------------------------------------------------- */}
      <div className="card" data-testid="detail-callbacks">
        <h2 style={{ marginTop: 0 }}>Callbacks they owe</h2>
        {callbacks.length === 0 ? (
          <Empty>No dated promises outstanding.</Empty>
        ) : (
          <table className="table tiny">
            <thead><tr><th>Organisation</th><th>Due</th><th /></tr></thead>
            <tbody>
              {callbacks.map((c) => {
                const due = c.route.outreach?.snoozeUntil;
                const overdue = due ? due.getTime() < now : false;
                return (
                  <tr key={c.id} data-testid="detail-callback">
                    <td>{c.route.company.operatingName ?? c.route.company.legalName}</td>
                    <td className={overdue ? 'warn' : 'dim'}>
                      {due ? due.toISOString().slice(0, 16).replace('T', ' ') : '—'}
                      {overdue ? ' · overdue' : ''}
                    </td>
                    <td>
                      <Link href={`/demand/opportunity/${c.route.id}`} className="btn secondary tiny">Open</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* --- packets -------------------------------------------------------- */}
      <div className="card" data-testid="detail-packets">
        <h2 style={{ marginTop: 0 }}>Packet history</h2>
        {detail.packets.length === 0 ? (
          <Empty>They have never been assigned a packet.</Empty>
        ) : (
          <table className="table tiny">
            <thead><tr><th>Packet</th><th>Assigned</th><th>Status</th><th>Waiting</th><th>Worked</th></tr></thead>
            <tbody>
              {detail.packets.map((p) => (
                <tr key={p.id} data-testid="detail-packet">
                  <td>{p.name}</td>
                  <td className="dim">{p.assignedAt.slice(0, 10)}</td>
                  <td>{p.status.toLowerCase()}</td>
                  <td>{p.waiting}</td>
                  <td>{p.worked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- attempts ------------------------------------------------------- */}
      <div className="card" data-testid="detail-attempts">
        <h2 style={{ marginTop: 0 }}>Recent calls</h2>
        <p className="small muted">
          Append-only. Nothing here is edited or removed when somebody is deactivated.
        </p>
        {attempts.length === 0 ? (
          <Empty>No calls recorded yet.</Empty>
        ) : (
          <table className="table tiny">
            <thead><tr><th>When</th><th>Organisation</th><th>Outcome</th><th>Notes</th></tr></thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id} data-testid="detail-attempt">
                  <td className="dim">{a.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
                  <td>
                    {a.route.company.operatingName ?? a.route.company.legalName}
                    {a.dataMode === 'TEST' && <> <Badge tone="warning">TEST</Badge></>}
                  </td>
                  <td>{a.disposition.toLowerCase().replace(/_/g, ' ')}</td>
                  <td className="dim">{a.notes ? a.notes.slice(0, 120) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="tiny dim">{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{children}</div>
    </div>
  );
}
