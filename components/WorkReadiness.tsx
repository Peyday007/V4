'use client';

import Link from 'next/link';
import { Badge } from './ui';

/**
 * The pre-shift check.
 *
 * Says whether they can start and, where they cannot, whose problem it is. A
 * screen that says only "no work" invites a caller to assume they did something
 * wrong, and the two most common reasons — nobody assigned them a packet, and a
 * save of ours failed — are neither of them theirs.
 */
type Readiness = {
  ready: boolean;
  blocker: string | null;
  notices: string[];
  openPackets: number;
  itemsWaiting: number;
  openIncidents: number;
};

type Gate = {
  mayReceiveNew: boolean;
  message: string;
  correction: string | null;
  systemFault: boolean;
};

type Packet = {
  packetId: string;
  name: string;
  status: string;
  expiresAt: string | null;
  total: number;
  worked: number;
  waiting: number;
};

export function WorkReadiness({
  callerName,
  readiness,
  gate,
  packets,
}: {
  callerName: string;
  readiness: Readiness;
  gate: Gate;
  packets: Packet[];
}) {
  const canStart = readiness.ready && gate.mayReceiveNew;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Good to go, {callerName.split(' ')[0]}</h1>
          <p>
            {readiness.itemsWaiting} opportunit{readiness.itemsWaiting === 1 ? 'y' : 'ies'} waiting across{' '}
            {readiness.openPackets} packet{readiness.openPackets === 1 ? '' : 's'}.
          </p>
        </div>
        {canStart && <Link href="/work/call" className="btn">Start calling</Link>}
      </div>

      {!gate.mayReceiveNew && (
        <div className={`alert ${gate.systemFault ? 'warning' : ''}`}>
          <strong>{gate.message}</strong>
          {gate.correction && <div style={{ marginTop: '0.3rem' }}>{gate.correction}</div>}
          {gate.systemFault ? (
            <div className="tiny mt">This is ours to fix. It is not counted against you.</div>
          ) : (
            <Link href="/work/call" className="btn secondary tiny mt">Finish that record</Link>
          )}
        </div>
      )}

      {gate.mayReceiveNew && readiness.blocker && (
        <div className="alert small">{readiness.blocker}</div>
      )}

      {readiness.notices.map((notice) => (
        <div key={notice} className="alert small">{notice}</div>
      ))}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Your packets</h2>
        {packets.length === 0 ? (
          <p className="small muted">Nothing assigned to you yet.</p>
        ) : (
          <table className="table tiny">
            <thead>
              <tr><th>Packet</th><th>Status</th><th>Worked</th><th>Left</th><th>Expires</th></tr>
            </thead>
            <tbody>
              {packets.map((p) => (
                <tr key={p.packetId}>
                  <td><strong>{p.name}</strong></td>
                  <td><Badge tone={p.status === 'OPEN' ? 'success' : ''}>{p.status.toLowerCase()}</Badge></td>
                  <td>{p.worked} of {p.total}</td>
                  <td>{p.waiting}</td>
                  <td className="dim">{p.expiresAt ? p.expiresAt.slice(0, 10) : 'no expiry'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
