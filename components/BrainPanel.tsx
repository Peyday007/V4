import { ActionButton } from '@/components/ActionButton';
import { Badge } from '@/components/ui';
import { ageMinutes, type BrainView } from '@/lib/brain/view';

/**
 * What Brain makes of this opportunity.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is optimistic
 * ---------------------------------------------------------------------------
 *
 * Every sentence on this panel came from Brain and is rendered as Brain wrote
 * it. There is no local copy that says "researching…" while Brain says
 * something else, no progress bar over a number nobody measured, and no state
 * this component can put the record into by itself. Where Brain has not formed
 * a view, the panel says so — which is a real answer and the commonest one.
 *
 * The freshness label is not decoration. A `STALE` reading is the last thing
 * this site heard and is shown *with its age*, because a stored opinion
 * rendered as a live one is the failure this whole panel exists to avoid.
 *
 * The one button is the one command. It appears only when Brain itself offers
 * it — `nextAction` comes from Brain's projection, so a record already being
 * worked on has no button, and pressing it twice is one command on Brain's
 * side whatever this component does.
 */

const STATE_LABEL: Record<string, string> = {
  NOT_EVALUATED: 'Not evaluated',
  QUEUED: 'On Brain’s list',
  IN_PROGRESS: 'Being researched',
  NEEDS_PERSON: 'Needs a person',
  COMPLETED: 'Finished',
  FAILED: 'Stopped',
};

const STATE_TONE: Record<string, string> = {
  NOT_EVALUATED: '',
  QUEUED: 'accent',
  IN_PROGRESS: 'accent',
  NEEDS_PERSON: 'warning',
  COMPLETED: 'success',
  FAILED: 'danger',
};

function Freshness({ view }: { view: BrainView }) {
  if (view.freshness === 'CURRENT') {
    return <span className="small muted">Read from Brain just now</span>;
  }
  if (view.freshness === 'STALE') {
    const age = ageMinutes(view.observedAt);
    return (
      <span className="small muted">
        Last heard {age === null ? 'some time ago' : `${age} minute(s) ago`}
        {view.reason ? ` — ${view.reason}` : ''}
      </span>
    );
  }
  if (view.freshness === 'NOT_CONNECTED') {
    return <span className="small muted">This site is not connected to a Brain.</span>;
  }
  return <span className="small muted">{view.reason ?? 'Brain could not be reached.'}</span>;
}

export function BrainPanel({
  view,
  opportunityId,
  canCommand,
}: {
  view: BrainView;
  opportunityId: string;
  canCommand: boolean;
}) {
  if (view.freshness === 'NOT_CONNECTED') return null;

  const label = view.state ? (STATE_LABEL[view.state] ?? view.state) : null;
  const tone = view.state ? (STATE_TONE[view.state] ?? '') : '';

  return (
    <section className="card" data-testid="brain-panel" data-brain-state={view.state ?? ''}
      data-brain-freshness={view.freshness} style={{ marginTop: '1rem' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>Brain</h2>
        <span data-testid="brain-freshness"><Freshness view={view} /></span>
      </div>

      {view.freshness === 'UNAVAILABLE' && !view.state && (
        <p className="small muted" style={{ marginTop: '0.6rem' }}>
          Nothing has been heard from Brain about this record, so there is nothing to show.
          This is not a statement about the opportunity.
        </p>
      )}

      {label && (
        <div className="row mb" style={{ marginTop: '0.6rem' }}>
          <Badge tone={tone}><span data-testid="brain-state">{label}</span></Badge>
          {view.priority && <Badge tone="accent">{view.priority}</Badge>}
          {view.confidence !== null && view.confidence !== undefined && (
            <span className="small muted">Confidence {view.confidence}/100</span>
          )}
        </div>
      )}

      {/* Brain's own sentence about the state, never one composed here. */}
      {view.stateReason && (
        <p data-testid="brain-state-reason" style={{ marginTop: '0.4rem' }}>{view.stateReason}</p>
      )}

      {view.brainReason && (
        <p className="small" style={{ marginTop: '0.4rem' }}>
          <strong>Why Brain ranks it there:</strong> {view.brainReason}
        </p>
      )}

      {view.research?.conclusion && (
        <div className="alert" style={{ marginTop: '0.6rem' }}>
          <strong>What the research found.</strong> {view.research.conclusion}
          {view.research.filedUnder && (
            <div className="small muted" style={{ marginTop: '0.3rem' }}>
              Filed under “{view.research.filedUnder}”.
            </div>
          )}
        </div>
      )}

      {view.commandedByName && view.commandedAt && (
        <p className="small muted" style={{ marginTop: '0.4rem' }}>
          Asked for by {view.commandedByName} on{' '}
          {view.commandedAt.toISOString().slice(0, 10)}.
        </p>
      )}

      {/* The button exists only while Brain offers the action. A record already
          on its list has none, so there is nothing to press twice. */}
      {canCommand && view.nextAction === 'RESEARCH_FURTHER' && view.freshness === 'CURRENT' && (
        <div data-testid="brain-command" style={{ marginTop: '0.8rem' }}>
          <ActionButton
            endpoint={`/api/opportunities/${opportunityId}/brain`}
            body={{ command: 'RESEARCH_FURTHER' }}
            className="primary"
          >
            Ask Brain to research this
          </ActionButton>
        </div>
      )}

      {view.brain && (
        <div className="small muted" data-testid="brain-identity" style={{ marginTop: '0.8rem' }}>
          {view.brain}
          {view.brainId ? ` · ${view.brainId}` : ''}
        </div>
      )}
    </section>
  );
}
