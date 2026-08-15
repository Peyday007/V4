import type { Claim } from '@prisma/client';
import { Badge } from './ui';
import { SOURCE_KIND_LABEL, STANDING_LABEL } from '@/lib/evidence/ledger';

/**
 * Everything this system claims about one deal, and what each claim rests on.
 *
 * The page above this already refuses to print an unsupported figure. What it
 * could not do was answer the follow-up question — *how do you know that* —
 * except in the specific places somebody had wired an explanation. This is the
 * general answer: every claim, its standing, who said it, when they said it,
 * and what would settle it.
 *
 * Two presentation rules, both learned the hard way.
 *
 * Disagreements come first and come loudly. Two people giving different answers
 * about the same requirement is the single most valuable thing this product can
 * surface and the easiest thing to lose, and it is settled by one phone call.
 *
 * Nothing is shown as a score. A ledger with eleven confirmed claims and three
 * open questions is described in those words. The moment it becomes
 * "79% complete" somebody starts managing the number.
 */

function dateOf(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : 'undated';
}

function standingTone(standing: Claim['standing']): string {
  return standing === 'CONFIRMED'
    ? 'success'
    : standing === 'CONTRADICTED'
      ? 'danger'
      : standing === 'INFERRED'
        ? 'warning'
        : '';
}

/**
 * The disagreement banner.
 *
 * Rendered separately from the ledger and above it, because an unresolved
 * contradiction makes everything downstream unsafe to quote and burying it in a
 * fold would be the same as not having it.
 */
export function ContradictionAlert({ claims }: { claims: Claim[] }) {
  const open = claims.filter((c) => c.standing === 'CONTRADICTED' && c.supersededAt === null);
  if (open.length === 0) return null;

  // Both sides of one disagreement are on the record, so group by key and show
  // the pair rather than listing the same argument twice.
  const byKey = new Map<string, Claim[]>();
  for (const claim of open) {
    byKey.set(claim.key, [...(byKey.get(claim.key) ?? []), claim]);
  }

  return (
    <div className="alert danger" data-testid="claim-contradictions">
      <strong>
        {byKey.size === 1
          ? 'Two sources disagree about this deal.'
          : `${byKey.size} things about this deal are disputed.`}
      </strong>
      <p className="small" style={{ marginBottom: '0.5rem' }}>
        Nothing resting on these is safe to quote. Each one is settled by asking again and recording the answer.
      </p>
      {[...byKey.entries()].map(([key, pair]) => (
        <div key={key} className="mt" data-testid={`contradiction-${key}`}>
          <div className="tiny dim">{key}</div>
          <ul className="list-reset small" style={{ paddingLeft: '1rem', lineHeight: 1.6 }}>
            {pair
              .slice()
              .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
              .map((claim) => (
                <li key={claim.id}>
                  “{claim.statement}” <span className="dim">— {claim.sourceLabel}</span>
                </li>
              ))}
          </ul>
          <div className="tiny">
            <strong>Next:</strong> {pair[0].correctiveAction}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ClaimLedger({ claims }: { claims: Claim[] }) {
  const current = claims.filter((c) => c.supersededAt === null);

  if (current.length === 0) {
    return (
      <div className="card" data-testid="claim-ledger">
        <div className="card-title">
          <h2>How we know any of this</h2>
        </div>
        <p className="small muted" data-testid="claim-ledger-empty">
          Nothing has been claimed about this deal yet. The ledger fills when discovery builds the route and
          again every time somebody makes a call.
        </p>
      </div>
    );
  }

  // Disagreements, then open questions, then inferences, then what is settled.
  // Ordered by what needs a person rather than alphabetically, because this is a
  // work queue as much as a record.
  const order = { CONTRADICTED: 0, UNKNOWN: 1, INFERRED: 2, CONFIRMED: 3 } as const;
  const sorted = current
    .slice()
    .sort((a, b) => order[a.standing] - order[b.standing] || a.key.localeCompare(b.key));

  const confirmed = current.filter((c) => c.standing === 'CONFIRMED').length;
  const inferred = current.filter((c) => c.standing === 'INFERRED').length;
  const unknown = current.filter((c) => c.standing === 'UNKNOWN').length;

  return (
    <div className="card" data-testid="claim-ledger">
      <div className="card-title">
        <h2>How we know any of this</h2>
        <span className="tiny dim">Every claim, and what it rests on</span>
      </div>

      {/* Counts, not a percentage. Three numbers a person can check against the
          table below beat one number nobody can. */}
      <p className="small" data-testid="claim-ledger-summary">
        {confirmed} claim(s) established, {inferred} resting on our inference, {unknown} still open.
      </p>

      <div className="table-scroll">
        <table className="table tiny">
          <thead>
            <tr>
              <th>What we claim</th>
              <th>Standing</th>
              <th>Where it came from</th>
              <th>What would settle it</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((claim) => (
              <tr key={claim.id} data-testid={`claim-${claim.key}`}>
                <td>
                  {claim.statement}
                  <div className="tiny dim">{claim.key}</div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Badge tone={standingTone(claim.standing)}>{STANDING_LABEL[claim.standing]}</Badge>
                  {/* A confidence is shown only where it means something, and
                      never as a bare percentage next to a fact. */}
                  {claim.standing === 'INFERRED' && claim.confidence !== null && (
                    <div className="tiny dim">
                      {Math.round(claim.confidence * 100)}% sure, and that figure is ours too
                    </div>
                  )}
                </td>
                <td className="tiny dim">
                  {SOURCE_KIND_LABEL[claim.sourceKind]} · {dateOf(claim.observedAt ?? claim.recordedAt)}
                  <div>{claim.sourceLabel}</div>
                  {claim.sourceRef?.startsWith('http') && (
                    <a href={claim.sourceRef} target="_blank" rel="noreferrer noopener">open the record ↗</a>
                  )}
                </td>
                <td className="tiny">
                  {claim.correctiveAction ?? <span className="dim">Nothing. It is established.</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="tiny dim mt">
        Superseded readings are kept rather than overwritten, so this record can say what we believed last month
        and what changed it. A claim a person established is never overwritten by the engine on a later pass.
      </p>
    </div>
  );
}
