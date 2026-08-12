import Link from 'next/link';
import { Badge } from './ui';
import type { ChainHealth as ChainHealthData, ChainStage } from '@/lib/health/chain';

/**
 * Where the machine is actually stopped.
 *
 * Placed above everything else on the admin page on purpose. Every other panel
 * answers "is my stage working", and the question an owner arrives with is
 * "why is nothing happening" — which no single-stage panel can answer, because
 * the break is always one stage upstream of wherever they are looking.
 *
 * The design rule is that exactly one thing is emphasised: the first break on
 * the demand track, plus the supply track's own verdict, because supply is a
 * parallel concern and a provider gap is real whether or not the phone rang
 * today. Everything downstream of a break is shown greyed and unjudged, so
 * nobody spends an afternoon on a symptom.
 */

const TONE: Record<string, string> = {
  OK: 'success',
  DEGRADED: 'warning',
  BLOCKED: 'danger',
  IDLE: '',
  DOWNSTREAM: '',
  NOT_BUILT: '',
};

const LABEL: Record<string, string> = {
  OK: 'flowing',
  DEGRADED: 'degraded',
  BLOCKED: 'stopped',
  IDLE: 'idle',
  DOWNSTREAM: 'downstream',
  NOT_BUILT: 'not built',
};

function StageRow({ stage, dimmed }: { stage: ChainStage; dimmed: boolean }) {
  return (
    <tr style={dimmed ? { opacity: 0.55 } : undefined}>
      <td style={{ whiteSpace: 'nowrap' }}>
        <Badge tone={TONE[stage.status]}>{LABEL[stage.status]}</Badge>
      </td>
      <td>
        <strong>{stage.label}</strong>
        <div className="dim" style={{ lineHeight: 1.5 }}>{stage.detail}</div>
        {stage.remedy && (
          <div className="tiny" style={{ lineHeight: 1.5, marginTop: '0.2rem' }}>→ {stage.remedy}</div>
        )}
        {stage.measures.length > 0 && (
          <div className="tiny dim" style={{ marginTop: '0.2rem' }}>
            {stage.measures.map((m) => `${m.label}: ${m.value}`).join(' · ')}
          </div>
        )}
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {stage.href ? (
          <Link className="btn secondary tiny" href={stage.href}>Open</Link>
        ) : (
          <span className="tiny dim">—</span>
        )}
      </td>
    </tr>
  );
}

export function ChainHealth({ health }: { health: ChainHealthData }) {
  const demand = health.stages.filter((s) => s.track === 'demand');
  const supply = health.stages.filter((s) => s.track === 'supply');
  const money = health.stages.filter((s) => s.track === 'money');
  const breakIndex = health.firstBreak ? demand.indexOf(health.firstBreak) : -1;

  return (
    <div className="card">
      <div>
        <h2 style={{ margin: 0 }}>Where the machine is stopped</h2>
        <p className="small muted" style={{ maxWidth: '46rem' }}>
          The chain in the order work moves through it. Every other panel on this page reports on its own stage
          honestly, which is exactly why none of them can answer “why is nothing happening” — the break is always
          upstream of wherever you are looking.
        </p>
      </div>

      {/* One headline. Not a dashboard of eight amber lights. */}
      {health.firstBreak ? (
        <div className="alert danger">
          <strong>{health.firstBreak.label}</strong> — {health.firstBreak.detail}
          {health.firstBreak.remedy && <div style={{ marginTop: '0.3rem' }}>{health.firstBreak.remedy}</div>}
        </div>
      ) : (
        <div className="alert success small">
          Demand is flowing all the way to work a caller can pick up.
        </div>
      )}

      {health.supplyBreak && (
        <div className="alert warning small">
          <strong>Supply, separately</strong> — {health.supplyBreak.detail}
          {health.supplyBreak.remedy && <div style={{ marginTop: '0.3rem' }}>{health.supplyBreak.remedy}</div>}
        </div>
      )}

      <div className="table-scroll mt">
        <table className="table tiny">
          <tbody>
            {demand.map((stage, i) => (
              <StageRow key={stage.key} stage={stage} dimmed={breakIndex >= 0 && i > breakIndex} />
            ))}
            {supply.map((stage) => (
              <StageRow key={stage.key} stage={stage} dimmed={false} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Stated rather than omitted. A chain that stops before anybody is paid
          cannot tell you which source made money, because it has no stage where
          money is recorded. */}
      <div className="tiny dim mt">
        Not built yet — no opportunity can complete a transaction through this system:{' '}
        {money.map((s) => s.label.toLowerCase()).join(', ')}. Until these exist, no source, route or caller can be
        credited with profit.
      </div>
    </div>
  );
}
