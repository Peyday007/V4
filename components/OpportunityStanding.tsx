'use client';

import { useState } from 'react';
import { Badge } from './ui';
import { CLASS_BADGE } from '@/lib/evidence/claims';
import type { EvidenceClass } from '@prisma/client';

/**
 * The routine opportunity experience.
 *
 * The page this replaces opened with four meters reading percentages nobody
 * had established — a closing probability of 10% that was a column default, an
 * information-completeness score to two significant figures — and put the one
 * thing anybody opens the page for three scrolls down.
 *
 * The order is the argument. Standing in a sentence. The single earliest thing
 * blocking it. The money path, or the reason there is no money to show. The
 * buyer and provider tracks side by side, because they run independently and
 * the deal dies when either stalls. Then the plan. Diagnostics last and folded
 * away, because they matter for the ten minutes a month when something is
 * wrong, not the ten minutes a day somebody spends working.
 *
 * "Explain this" is a mode rather than a tooltip. Every claim on the page can
 * say where it came from, and turning it on turns them all on at once — so an
 * owner who distrusts one number can check the whole page in one gesture
 * instead of hunting for the little question mark beside each.
 */

type Presented =
  | { show: true; evidence: EvidenceClass; label: string; source: string }
  | { show: false; evidence: EvidenceClass; instead: string; toConfirm: string | null };

type Stage = {
  key: string;
  label: string;
  state: string;
  because: string;
  nextAction: string | null;
  owner: string;
  completionCondition: string;
  evidenceRequired: string;
  needsAuthority: boolean;
  deadline: string | null;
};

export type StandingProps = {
  organisation: string;
  standing: { sentence: string; progress: { done: number; total: number }; reasoning: string[] };
  blocker: Stage | null;
  waitingOn: Stage[];
  money: {
    defensible: boolean;
    sentence: string;
    steps: Array<{ label: string; presentation: Presented; toConfirm: string | null }>;
  };
  buyerTrack: Array<{ label: string; presentation: Presented }>;
  providerTrack: Array<{ label: string; presentation: Presented }>;
  plan: Stage[];
  /** Raw diagnostics, folded away. */
  diagnostics: Array<{ label: string; value: string }>;
  /**
   * Every term on this record, explained against this record.
   *
   * Not a glossary. "Strong trigger: an event that usually creates a need" is
   * a dictionary entry; the operator's question is why *this* one is a strong
   * trigger and what to do about it, so each explanation is built from the
   * record's own value and names the organisation.
   */
  explanations: Array<{
    term: string;
    value: string;
    meaning: string;
    whyItMatters: string;
    howItWasWorkedOut: string;
    standing: string;
    standingLabel: string;
    howToUseIt: string;
    whatWouldImproveIt: string | null;
  }>;
};

export function OpportunityStanding(props: StandingProps) {
  const [explain, setExplain] = useState(false);

  return (
    <div data-testid="opportunity-standing">
      {/* ---- standing ---- */}
      <div className="card">
        <div className="card-title">
          <h2>Where this stands</h2>
          <div className="row">
            <span className="tiny dim">
              {props.standing.progress.done} of {props.standing.progress.total} steps
            </span>
            <button
              type="button"
              className="btn secondary tiny"
              data-testid="explain-toggle"
              aria-pressed={explain}
              onClick={() => setExplain((v) => !v)}
            >
              {explain ? 'Hide explanations' : 'Explain this'}
            </button>
          </div>
        </div>

        <p className="pre-wrap" data-testid="standing-sentence" style={{ fontSize: '1.05rem' }}>
          {props.standing.sentence}
        </p>

        {explain && (
          <div className="alert info small" data-testid="standing-explanation">
            <strong>How that was worked out:</strong>
            <ul className="list-reset mt">
              {props.standing.reasoning.map((r) => (
                <li key={r}>• {r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ---- the one blocker ---- */}
      {props.blocker && (
        <div className="card" data-testid="earliest-blocker">
          <h2>What is blocking it</h2>
          <p className="small">
            <strong>{props.blocker.label}.</strong> {props.blocker.because}
          </p>
          {props.blocker.nextAction && (
            <div className="alert warning small">
              <strong>Next:</strong> {props.blocker.nextAction}
              <div className="tiny dim mt">
                {props.blocker.owner}
                {props.blocker.needsAuthority && ' · needs somebody with authority'}
                {props.blocker.deadline && ` · by ${props.blocker.deadline.slice(0, 10)}`}
              </div>
            </div>
          )}
          {explain && (
            <div className="tiny dim">
              Finished when: {props.blocker.completionCondition} Evidence required:{' '}
              {props.blocker.evidenceRequired}
            </div>
          )}
        </div>
      )}

      {/* ---- money ---- */}
      <div className="card" data-testid="money-path">
        <div className="card-title">
          <h2>The money</h2>
          <Badge tone={props.money.defensible ? 'success' : 'warning'}>
            {props.money.defensible ? 'defensible' : 'not yet defensible'}
          </Badge>
        </div>
        <p className="small">{props.money.sentence}</p>

        <div className="table-scroll mt">
          <table className="table tiny">
            <tbody>
              {props.money.steps.map((step) => (
                <tr key={step.label} data-testid={`money-${step.label.replace(/\s+/g, '-').toLowerCase()}`}>
                  <td style={{ width: '9rem' }}>{step.label}</td>
                  <td>
                    {step.presentation.show ? (
                      <>
                        <strong>{step.presentation.label}</strong>{' '}
                        <Badge>{CLASS_BADGE[step.presentation.evidence]}</Badge>
                        {explain && <div className="tiny dim">{step.presentation.source}</div>}
                      </>
                    ) : (
                      /* Never a dash and never a zero. A suppressed figure has
                         to say what is missing, or the page has only become
                         quieter rather than more honest. */
                      <span className="dim">{step.presentation.instead}</span>
                    )}
                    {!step.presentation.show && step.toConfirm && (
                      <div className="tiny mt">
                        <strong>To fix:</strong> {step.toConfirm}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- the two tracks ---- */}
      <div className="two-col">
        <Track title="Buyer" rows={props.buyerTrack} explain={explain} testId="buyer-track" />
        <Track title="Provider" rows={props.providerTrack} explain={explain} testId="provider-track" />
      </div>

      {/* ---- the plan ---- */}
      <div className="card" data-testid="action-plan">
        <h2>The plan</h2>
        <ol className="list-reset">
          {props.plan.map((stage) => (
            <li key={stage.key} style={{ padding: '0.45rem 0', borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: '0.5rem' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{stage.label}</strong>
                  <div className="small muted">{stage.because}</div>
                  {stage.nextAction && <div className="small mt">→ {stage.nextAction}</div>}
                  {explain && (
                    <div className="tiny dim mt">
                      Finished when: {stage.completionCondition} · Evidence: {stage.evidenceRequired}
                    </div>
                  )}
                </div>
                <Badge
                  tone={
                    stage.state === 'DONE' ? 'success'
                      : stage.state === 'BLOCKED' ? 'danger'
                        : stage.state === 'WAITING_EXTERNAL' ? 'warning' : ''
                  }
                >
                  {stage.state.toLowerCase().replace(/_/g, ' ')}
                </Badge>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* ---- what every word on this page means, for this record ---- */}
      {explain && props.explanations.length > 0 && (
        <div className="card" data-testid="explanations">
          <div className="card-title">
            <h2>What these words mean here</h2>
            <span className="tiny dim">
              Built from this record, not from a glossary — two deals showing the same badge get different
              answers when the reasons differ
            </span>
          </div>
          {props.explanations.map((e) => (
            <div
              key={`${e.term}-${e.value}`}
              data-testid={`explanation-${e.term.toLowerCase().replace(/\s+/g, '-')}`}
              style={{ padding: '0.6rem 0', borderBottom: '1px solid var(--border)' }}
            >
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{e.term}: {e.value}</strong>
                {/* The distinction the screen cannot make on its own: a tier, a
                    friction level and a margin all look equally official and
                    are not the same kind of thing at all. */}
                <Badge tone={e.standing === 'FACT' ? 'success' : e.standing === 'ABSENCE' ? 'warning' : ''}>
                  {e.standingLabel}
                </Badge>
              </div>
              <p className="small mt">{e.meaning}</p>
              <p className="small muted"><strong>Why it matters:</strong> {e.whyItMatters}</p>
              <p className="tiny dim"><strong>How it was worked out:</strong> {e.howItWasWorkedOut}</p>
              <p className="small"><strong>What to do with it:</strong> {e.howToUseIt}</p>
              {e.whatWouldImproveIt && (
                <p className="tiny"><strong>What would improve it:</strong> {e.whatWouldImproveIt}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---- diagnostics, folded ---- */}
      {props.diagnostics.length > 0 && (
        <div className="card">
          <details data-testid="diagnostics">
            <summary className="small dim">
              Raw diagnostics ({props.diagnostics.length}) — for when something looks wrong
            </summary>
            <table className="table tiny mt">
              <tbody>
                {props.diagnostics.map((d) => (
                  <tr key={d.label}>
                    <td className="muted nowrap">{d.label}</td>
                    <td className="mono">{d.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </div>
  );
}

/**
 * One side of the deal.
 *
 * Buyer and provider are separate tracks rather than one list because they
 * proceed independently — a confirmed requirement does not move the provider
 * side an inch — and the commonest way a deal quietly dies is one track
 * running well while the other has not started, which is invisible when the
 * two are interleaved.
 */
function Track({
  title,
  rows,
  explain,
  testId,
}: {
  title: string;
  rows: Array<{ label: string; presentation: Presented }>;
  explain: boolean;
  testId: string;
}) {
  const established = rows.filter((r) => r.presentation.show).length;
  return (
    <div className="card" data-testid={testId}>
      <div className="card-title">
        <h2>{title}</h2>
        <span className="tiny dim">{established} of {rows.length} established</span>
      </div>
      {rows.length === 0 ? (
        <p className="small dim">Nothing on this side yet.</p>
      ) : (
        <table className="table tiny">
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td className="muted nowrap" style={{ width: '10rem' }}>{row.label}</td>
                <td>
                  {row.presentation.show ? (
                    <>
                      {row.presentation.label} <Badge>{CLASS_BADGE[row.presentation.evidence]}</Badge>
                      {explain && <div className="tiny dim">{row.presentation.source}</div>}
                    </>
                  ) : (
                    <span className="dim">{row.presentation.instead}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
