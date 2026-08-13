import type { DealPlan, Stage } from '@/lib/deal/plan';
import { Badge } from '@/components/ui';

/**
 * What to do about this opportunity, at the top of the page.
 *
 * The record underneath it is evidence, and evidence is what you read when you
 * are deciding whether to believe something. This is what you read when you are
 * deciding what to do — so it goes first, and the diagnostics that used to
 * occupy this space fold away behind a control for the times somebody actually
 * wants them.
 *
 * The three states are kept visually distinct because they mean different
 * things to whoever is holding the list: one rung is yours to move now, some
 * are waiting on a person outside the building, and the rest are not reachable
 * yet. A design that renders all three the same produces a to-do list full of
 * things nobody can do.
 */

function day(value: Date | string | null): string | null {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

const TONE: Record<Stage['state'], string | undefined> = {
  DONE: 'success',
  BLOCKED: 'danger',
  WAITING_EXTERNAL: 'warning',
  NOT_STARTED: undefined,
};

const STATE_WORDS: Record<Stage['state'], string> = {
  DONE: 'done',
  BLOCKED: 'ours to move',
  WAITING_EXTERNAL: 'waiting on them',
  NOT_STARTED: 'not reachable yet',
};

export function DealPlanPanel({ plan }: { plan: DealPlan }) {
  const { firstBroken, waitingOn, headline, progress } = plan;

  return (
    <div className="card" data-testid="deal-plan">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: '0.25rem' }}>What to do next</h2>
          <p className="small" style={{ margin: 0 }} data-testid="plan-headline">{headline}</p>
        </div>
        <Badge tone={firstBroken ? 'danger' : waitingOn.length > 0 ? 'warning' : 'success'}>
          {progress.done} of {progress.total} done
        </Badge>
      </div>

      {firstBroken && (
        <div className="alert small mt" data-testid="first-broken">
          <strong data-testid="first-broken-label">{firstBroken.label}</strong>
          <div style={{ marginTop: '0.35rem' }} data-testid="first-broken-action">
            {firstBroken.nextAction}
          </div>
          <div className="tiny dim mt">
            <strong>Who:</strong> {firstBroken.owner}
            {firstBroken.deadline && <> · <strong>By:</strong> {day(firstBroken.deadline)}</>}
            {firstBroken.needsAuthority && <> · <Badge tone="warning">needs authority</Badge></>}
          </div>
          <div className="tiny dim">
            <strong>Done when:</strong> {firstBroken.completionCondition}
          </div>
          <div className="tiny dim">
            <strong>Evidence:</strong> {firstBroken.evidenceRequired}
          </div>
        </div>
      )}

      {plan.blockedCapabilities.length > 0 && (
        <div className="alert danger small mt" data-testid="blocked-capabilities">
          {plan.blockedCapabilities.map((c) => (
            <div key={c.what}>
              <strong>{c.what} is not available.</strong> {c.reason}
            </div>
          ))}
        </div>
      )}

      {waitingOn.length > 0 && (
        <div className="tiny dim mt" data-testid="waiting-on">
          Waiting on somebody outside the building:{' '}
          {waitingOn.map((s) => `${s.label.toLowerCase()} — ${s.because}`).join(' ')}
        </div>
      )}

      <details className="mt" data-testid="plan-stages">
        <summary className="small">Show the whole chain</summary>
        <table className="table tiny mt">
          <thead>
            <tr><th>Stage</th><th>State</th><th>Where it stands</th><th>Next</th><th>Who</th></tr>
          </thead>
          <tbody>
            {plan.stages.map((stage) => (
              <tr key={stage.key} data-testid={`stage-${stage.key}`}>
                <td style={{ whiteSpace: 'nowrap' }}>{stage.label}</td>
                <td><Badge tone={TONE[stage.state]}>{STATE_WORDS[stage.state]}</Badge></td>
                <td className="dim">{stage.because}</td>
                <td>
                  {stage.nextAction ?? <span className="dim">—</span>}
                  {stage.nextAction && (
                    <div className="tiny dim">
                      done when: {stage.completionCondition} · evidence: {stage.evidenceRequired}
                    </div>
                  )}
                </td>
                <td className="dim" style={{ whiteSpace: 'nowrap' }}>
                  {stage.nextAction ? stage.owner : '—'}
                  {stage.deadline && stage.nextAction && (
                    <div className="tiny">by {day(stage.deadline)}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
