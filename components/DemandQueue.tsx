'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Badge } from './ui';

/**
 * The work queue.
 *
 * One row per opportunity, and the row answers the questions a person asks
 * before dialling: who, why now, what am I selling, can I reach them, is there
 * anyone to do the work. The full dossier still exists and is one click away —
 * it is simply not loaded until somebody asks for it, because 152 of them
 * rendered at once is what made the board unreadable.
 */

type Row = {
  routeId: string;
  companyId: string;
  organisation: string;
  cityName: string | null;
  stateCode: string | null;
  tier: string;
  route: string;
  playbookKey: string;
  headline: string;
  requiredCapability: string | null;
  needIsConfirmed: boolean;
  friction: string;
  fulfilmentStatus: string;
  status: string;
  statusReason: string | null;
  nextAction: string | null;
  profitPerHour: number | null;
  expectedGrossProfit: number | null;
  eventId: string;
  eventType: string;
  eventDate: string | null;
  deadlineAt: string | null;
  connector: string;
  buyingWindow: string | null;
  windowClosesAt: string | null;
  phone: string | null;
  email: string | null;
  outreachStatus: string;
  snoozeUntil: string | null;
  attempts: number;
  lastDisposition: string | null;
  routesForAccount: number;
  routesForEvent: number;
  enrichmentState: string;
  enrichmentBlocker: string | null;
  enrichmentSources: string[];
  enrichmentLastAttemptAt: string | null;
  enrichmentNextAttemptAt: string | null;
  enrichmentAttempts: number;
  enrichmentFix: string | null;
};

/**
 * The seven states contact resolution can be in, in the operator's words.
 *
 * The distinction that earns its place on the row is the last two against the
 * middle one: "we searched everywhere and this business publishes no number"
 * is a finished job, while "the provider was down" and "nobody set the key" are
 * both our fault and both fixable. Showing all three as an empty phone column
 * is what made a hundred and fifty records look like manual research.
 */
const ENRICHMENT: Record<string, { label: string; tone: string; hint: string }> = {
  READY: { label: 'Contact ready', tone: 'success', hint: 'A contact route was found and checked. This is callable.' },
  ENRICHING: { label: 'Enriching', tone: 'accent', hint: 'Being looked up right now.' },
  WAITING: { label: 'Queued', tone: '', hint: 'Scheduled. The worker has not reached it yet.' },
  RETRY_SCHEDULED: { label: 'Retry scheduled', tone: 'warning', hint: 'An earlier attempt did not settle it. It will be tried again automatically.' },
  AMBIGUOUS: { label: 'Ambiguous match', tone: 'warning', hint: 'More than one business fits. Needs a person to choose — retrying returns the same candidates.' },
  NONE_FOUND: { label: 'No contact found', tone: '', hint: 'Every available source was searched and none publishes a contact.' },
  FAILED: { label: 'Provider failure', tone: 'danger', hint: 'The lookup itself failed. This is not a finding about the business.' },
  STALE: { label: 'Stale contact', tone: 'warning', hint: 'The number is past the age its source can be relied on for. Being re-checked.' },
  NOT_SCHEDULED: { label: 'Not scheduled', tone: 'danger', hint: 'Not in the contact-resolution workflow. Retry to put it there.' },
};

type Summary = Record<string, number>;

/**
 * Why the board is empty, from the server.
 *
 * Computed only when there is nothing to show, because answering it costs
 * several queries and a board full of work has no use for the answer.
 */
type Emptiness = {
  nothingCollected: boolean;
  totalRoutes: number;
  totalEvents: number;
  headline: string;
  brokenStage: { stage: string; detail: string; fix: string } | null;
  sources: Array<{ connector: string; name: string; state: string; reason: string }>;
};

const VIEWS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'call_now', label: 'Call now', hint: 'Live demand, a phone number, nothing scheduled for later.' },
  { key: 'follow_up', label: 'Follow up', hint: 'Scheduled. Overdue first.' },
  { key: 'research', label: 'Research needed', hint: 'Real demand with nobody to ring. Find a contact first.' },
  { key: 'supply_needed', label: 'Supply needed', hint: 'Demand is real; we have no provider yet.' },
  { key: 'qualified', label: 'Qualified', hint: 'Worth pursuing. Out of cold calling.' },
  { key: 'all', label: 'All opportunities', hint: 'Everything the engine still considers live.' },
  { key: 'closed', label: 'Closed', hint: 'Handled elsewhere, declined, or do-not-contact.' },
  { key: 'expired', label: 'Expired', hint: 'Kept as evidence. Not work.' },
];

const SUMMARY_TILES: Array<{ key: string; label: string; view: string; tone?: string }> = [
  { key: 'call_now', label: 'Call now', view: 'call_now', tone: 'success' },
  { key: 'follow_up', label: 'Follow-ups due', view: 'follow_up', tone: 'warning' },
  { key: 'qualified', label: 'Qualified', view: 'qualified', tone: 'success' },
  { key: 'research', label: 'Research needed', view: 'research' },
  { key: 'supply_needed', label: 'Supply needed', view: 'supply_needed' },
  { key: 'active_demand', label: 'Active demand', view: 'all' },
  { key: 'strong_trigger', label: 'Strong triggers', view: 'all' },
  { key: 'expiring_soon', label: 'Expiring in 7 days', view: 'all', tone: 'danger' },
];

const TIER_TONE: Record<string, string> = {
  ACTIVE_DEMAND: 'success',
  STRONG_TRIGGER: 'warning',
  PREDICTED_NEED: 'accent',
  DIRECTORY_PROSPECT: '',
  REJECTED: 'danger',
};

const TIER_SHORT: Record<string, string> = {
  ACTIVE_DEMAND: 'A',
  STRONG_TRIGGER: 'B',
  PREDICTED_NEED: 'C',
  DIRECTORY_PROSPECT: 'D',
  REJECTED: '—',
};

const FRICTION_TONE: Record<string, string> = {
  LOW: 'success',
  MODERATE: 'warning',
  HIGH: 'danger',
  UNKNOWN_RESEARCH_REQUIRED: '',
};

const FRICTION_SHORT: Record<string, string> = {
  LOW: 'low',
  MODERATE: 'moderate',
  HIGH: 'high',
  UNKNOWN_RESEARCH_REQUIRED: 'unknown',
};

function humanise(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

function dayOnly(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

/** Days until, as a short phrase. Never derived from our own timestamps. */
function untilLabel(iso: string | null): { text: string; tone: string } {
  if (!iso) return { text: 'no window', tone: '' };
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { text: `closed ${-days}d ago`, tone: 'danger' };
  if (days === 0) return { text: 'closes today', tone: 'danger' };
  if (days <= 7) return { text: `${days}d left`, tone: 'danger' };
  if (days <= 30) return { text: `${days}d left`, tone: 'warning' };
  return { text: `${days}d left`, tone: '' };
}

export function DemandQueue({
  options,
}: {
  options: { eventTypes: string[]; connectors: string[]; states: string[] };
}) {
  const [view, setView] = useState('call_now');
  const [rows, setRows] = useState<Row[]>([]);
  const [emptiness, setEmptiness] = useState<Emptiness | null>(null);
  const [summary, setSummary] = useState<Summary>({});
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Record<string, unknown> | null>(null);

  const [search, setSearch] = useState('');
  const [tier, setTier] = useState('');
  const [route, setRoute] = useState('');
  const [eventType, setEventType] = useState('');
  const [friction, setFriction] = useState('');
  const [fulfilment, setFulfilment] = useState('');
  const [state, setState] = useState('');
  const [connector, setConnector] = useState('');
  const [urgency, setUrgency] = useState('');
  const [contactable, setContactable] = useState('');
  const [enrichment, setEnrichment] = useState('');
  const [retrying, setRetrying] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ view });
    if (search.trim()) params.set('q', search.trim());
    if (tier) params.set('tier', tier);
    if (route) params.set('route', route);
    if (eventType) params.set('eventType', eventType);
    if (friction) params.set('friction', friction);
    if (fulfilment) params.set('fulfilment', fulfilment);
    if (state) params.set('state', state);
    if (connector) params.set('connector', connector);
    if (urgency) params.set('urgency', urgency);
    if (contactable) params.set('contactable', contactable);
    if (enrichment) params.set('enrichment', enrichment);
    return params;
  }, [view, search, tier, route, eventType, friction, fulfilment, state, connector, urgency, contactable, enrichment]);

  const load = useCallback(
    async (append: boolean, offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams(query);
        params.set('cursor', String(offset));
        const response = await fetch(`/api/demand/queue?${params.toString()}`);
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
        setRows((current) => (append ? [...current, ...body.rows] : body.rows));
        setTotal(body.total);
        setCursor(body.nextCursor);
        if (body.summary) setSummary(body.summary);
        setEmptiness(body.emptiness ?? null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  // Debounced so typing in the search box does not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setExpanded(null);
      load(false, 0);
    }, 200);
    return () => clearTimeout(timer);
  }, [load]);

  /**
   * Ask for one record, or everything blocked, to be tried again now.
   *
   * A recovery tool. The normal path needs nobody to press anything — this is
   * for the minute after somebody sets a missing key and wants to see it work.
   */
  const retry = useCallback(
    async (body: { routeId?: string; allBlocked?: boolean }, key: string) => {
      setRetrying(key);
      setNotice(null);
      try {
        const response = await fetch('/api/demand/enrichment', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error ?? `Request failed (${response.status})`);
        setNotice(
          `Tried ${result.attempted} organisation(s): ${result.resolved} resolved, ${result.ambiguous} ambiguous, ` +
            `${result.unresolved} with no contact published, ${result.failed} failed. ` +
            `${result.released} route(s) became callable.` +
            (result.remaining > 0 ? ` ${result.remaining} still queued — the worker continues on its own.` : ''),
        );
        await load(false, 0);
      } catch (caught) {
        setNotice(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setRetrying(null);
      }
    },
    [load],
  );

  async function openEvidence(routeId: string) {
    if (expanded === routeId) {
      setExpanded(null);
      return;
    }
    setExpanded(routeId);
    setEvidence(null);
    const response = await fetch(`/api/demand/evidence/${routeId}`);
    setEvidence(response.ok ? await response.json() : { error: 'Could not load the evidence for this record.' });
  }

  const activeView = VIEWS.find((v) => v.key === view);

  return (
    <>
      {/* Counts that are also the filters. Each tile runs the same clause as
          the view it opens, so a number and the rows behind it agree. */}
      <div className="card">
        <div className="grid grid-4">
          {SUMMARY_TILES.map((tile) => (
            <button
              key={tile.key}
              className="stat"
              style={{ textAlign: 'left', background: 'none', border: 0, cursor: 'pointer', padding: '0.4rem' }}
              onClick={() => {
                setView(tile.view);
                if (tile.key === 'active_demand') setTier('ACTIVE_DEMAND');
                else if (tile.key === 'strong_trigger') setTier('STRONG_TRIGGER');
                else setTier('');
                setUrgency(tile.key === 'expiring_soon' ? 'week' : '');
              }}
            >
              <div className="stat-label">{tile.label}</div>
              <div className="stat-value" style={{ fontSize: '1.4rem', color: tile.tone ? undefined : 'inherit' }}>
                {summary[tile.key] ?? 0}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="filter-bar" style={{ flex: 1 }}>
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={`filter-chip${view === v.key ? ' active' : ''}`}
              onClick={() => setView(v.key)}
            >
              {v.label} {summary[v.key] !== undefined ? `(${summary[v.key]})` : ''}
            </button>
          ))}
        </div>
        <Link href="/demand/call" className="btn">
          Start calling
        </Link>
      </div>

      <p className="tiny dim">{activeView?.hint}</p>

      {/* Sticky so the filters and the count stay put while the list scrolls. */}
      <div className="card" style={{ position: 'sticky', top: 0, zIndex: 5 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
          <input
            className="input"
            style={{ minWidth: '16rem', flex: 1 }}
            placeholder="Search organisation, city, need, source text…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select value={tier} onChange={setTier} label="Any tier" options={[
            ['ACTIVE_DEMAND', 'A — active demand'],
            ['STRONG_TRIGGER', 'B — strong trigger'],
            ['PREDICTED_NEED', 'C — predicted'],
            ['DIRECTORY_PROSPECT', 'D — directory'],
          ]} />
          <Select value={route} onChange={setRoute} label="Any route" options={[
            ['BROKERAGE', 'Brokerage'], ['SUBCONTRACTING', 'Subcontracting'], ['DISTRIBUTION', 'Distribution'],
          ]} />
          <Select value={friction} onChange={setFriction} label="Any friction" options={[
            ['LOW', 'Low'], ['MODERATE', 'Moderate'], ['HIGH', 'High'],
            ['UNKNOWN_RESEARCH_REQUIRED', 'Unknown'],
          ]} />
          <Select value={fulfilment} onChange={setFulfilment} label="Any supply" options={[
            ['AVAILABLE', 'Provider available'], ['PARTIAL', 'Partial'],
            ['UNAVAILABLE', 'No provider'], ['UNKNOWN', 'Unknown'],
          ]} />
          <Select value={contactable} onChange={setContactable} label="Any contactability" options={[
            ['yes', 'Has a phone'], ['no', 'No phone'],
          ]} />
          <Select value={enrichment} onChange={setEnrichment} label="Any contact status" options={[
            ['READY', 'Contact ready'], ['ENRICHING', 'Enriching'], ['WAITING', 'Queued'],
            ['RETRY_SCHEDULED', 'Retry scheduled'], ['AMBIGUOUS', 'Ambiguous match'],
            ['NONE_FOUND', 'No contact found'], ['FAILED', 'Provider failure'],
            ['STALE', 'Stale contact'],
          ]} />
          <Select value={urgency} onChange={setUrgency} label="Any urgency" options={[
            ['overdue', 'Window closed'], ['today', 'Closes today'],
            ['week', 'Within 7 days'], ['month', 'Within 30 days'],
          ]} />
          <Select value={eventType} onChange={setEventType} label="Any event" options={options.eventTypes.map((t) => [t, humanise(t)])} />
          <Select value={state} onChange={setState} label="Anywhere" options={options.states.map((s) => [s, s])} />
          <Select value={connector} onChange={setConnector} label="Any source" options={options.connectors.map((c) => [c, humanise(c)])} />
        </div>
        <div className="tiny dim mt">
          {loading ? 'Loading…' : `${total} matching opportunit${total === 1 ? 'y' : 'ies'}`}
          {rows.length < total ? ` · showing ${rows.length}` : ''}
        </div>
      </div>

      {error && <div className="alert danger small">{error}</div>}
      {notice && <div className="alert small">{notice}</div>}

      {/* Recovery, not workflow. Everything below happens automatically; this
          is here for the minute after somebody fixes a configuration problem
          and wants to see whether it worked. */}
      {(view === 'research' || enrichment) && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
            <p className="tiny dim" style={{ margin: 0, maxWidth: '48rem' }}>
              Contact resolution runs on its own — every organisation with live demand is scheduled automatically, worked
              in priority order, and retried on a schedule that matches why it failed. Anything sitting here is waiting
              for its turn, waiting for a person to choose between candidates, or blocked on something named in the row.
            </p>
            <button
              className="btn secondary"
              disabled={retrying !== null}
              onClick={() => retry({ allBlocked: true }, 'all')}
            >
              {retrying === 'all' ? 'Working…' : 'Retry everything blocked'}
            </button>
          </div>
        </div>
      )}

      {/* An empty board has to say which of three things it is: a filter with
          nothing behind it, an engine that has collected nothing because a
          source is broken, or an engine that is working and has genuinely
          found nothing yet. Only the last is "not an error", and this used to
          claim it unconditionally — while four datasets had moved and a fifth
          was answering with a block page. */}
      {!loading && rows.length === 0 && (
        <div className="card" data-testid="board-empty">
          <p className="small">{emptiness?.headline ?? 'Nothing in this view.'}</p>

          {emptiness?.brokenStage && (
            <div className="alert warning small" data-testid="broken-stage">
              <strong>First broken stage: {emptiness.brokenStage.stage}.</strong>{' '}
              {emptiness.brokenStage.detail}
              <div className="mt">{emptiness.brokenStage.fix}</div>
            </div>
          )}

          {emptiness?.nothingCollected && !emptiness.brokenStage && (
            <p className="small muted">
              Every source ran and none reported a fault. Nothing has been published that matches what this
              business does — that is a result, not an error.
            </p>
          )}

          {emptiness && emptiness.sources.length > 0 && (
            <details className="mt">
              <summary className="tiny dim">What each source last did</summary>
              <ul className="list-reset tiny mt" style={{ lineHeight: 1.6 }}>
                {emptiness.sources.map((source) => (
                  <li key={source.connector} className="mt">
                    <Badge tone={source.state === 'working' ? 'success' : source.state === 'failing' ? 'danger' : ''}>
                      {source.state}
                    </Badge>{' '}
                    <strong>{source.name}:</strong> {source.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <a className="btn secondary mt" href="/demand/sources">Source health</a>
        </div>
      )}

      <div className="table-scroll">
        <table className="table tiny">
          <thead>
            <tr>
              <th>Organisation</th>
              <th>Tier</th>
              <th>Event</th>
              <th>Window</th>
              <th>Route / need</th>
              <th>Friction</th>
              <th>Contact</th>
              <th>Supply</th>
              <th>Outreach</th>
              <th>Next action</th>
              <th>$/hr</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const until = untilLabel(row.windowClosesAt);
              return (
                <>
                  <tr key={row.routeId}>
                    <td>
                      <strong>{row.organisation}</strong>
                      <div className="dim">
                        {[row.cityName, row.stateCode].filter(Boolean).join(', ') || 'location unknown'}
                        {/* One event producing several routes is stated, so a
                            business never reads as several businesses. */}
                        {row.routesForEvent > 1 && ` · 1 of ${row.routesForEvent} routes from this event`}
                      </div>
                    </td>
                    <td><Badge tone={TIER_TONE[row.tier]}>{TIER_SHORT[row.tier]}</Badge></td>
                    <td>
                      {humanise(row.eventType)}
                      {/* The source's date. Our first-seen date is not shown
                          here at all, so the two can never be confused. */}
                      <div className="dim">{dayOnly(row.eventDate)}</div>
                    </td>
                    <td>
                      <Badge tone={until.tone}>{until.text}</Badge>
                      {row.deadlineAt && <div className="dim">due {dayOnly(row.deadlineAt)}</div>}
                    </td>
                    <td>
                      {humanise(row.route)}
                      <div className="dim">
                        {row.requiredCapability ?? '—'}
                        {!row.needIsConfirmed && ' (our inference)'}
                      </div>
                    </td>
                    <td><Badge tone={FRICTION_TONE[row.friction]}>{FRICTION_SHORT[row.friction]}</Badge></td>
                    <td style={{ maxWidth: '15rem' }}>
                      {row.phone && (
                        <div>
                          <a href={`tel:${row.phone.replace(/[^\d+]/g, '')}`}>{row.phone}</a>
                        </div>
                      )}
                      <ContactStatus row={row} onRetry={() => retry({ routeId: row.routeId }, row.routeId)} busy={retrying === row.routeId} />
                    </td>
                    <td>
                      {row.fulfilmentStatus === 'AVAILABLE' ? (
                        <Badge tone="success">provider</Badge>
                      ) : (
                        <Badge>no provider yet</Badge>
                      )}
                    </td>
                    <td>
                      {humanise(row.outreachStatus)}
                      {row.attempts > 0 && <div className="dim">{row.attempts} attempt(s)</div>}
                      {row.snoozeUntil && <div className="dim">until {dayOnly(row.snoozeUntil)}</div>}
                    </td>
                    <td style={{ maxWidth: '18rem' }}>{row.nextAction ?? '—'}</td>
                    <td>{row.profitPerHour !== null ? `$${row.profitPerHour}` : <span className="dim">—</span>}</td>
                    <td>
                      <div className="row" style={{ gap: '0.3rem' }}>
                        <button className="btn secondary tiny" onClick={() => openEvidence(row.routeId)}>
                          {expanded === row.routeId ? 'Hide' : 'Evidence'}
                        </button>
                        <Link className="btn secondary tiny" href={`/demand/opportunity/${row.routeId}`}>
                          Record
                        </Link>
                        <Link className="btn tiny" href={`/demand/call?route=${row.routeId}`}>
                          Work
                        </Link>
                      </div>
                    </td>
                  </tr>
                  {expanded === row.routeId && (
                    <tr key={`${row.routeId}-evidence`}>
                      <td colSpan={12}>
                        <EvidencePanel data={evidence} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      {cursor !== null && (
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn secondary" disabled={loading} onClick={() => load(true, cursor)}>
            {loading ? 'Loading…' : `Load ${Math.min(50, total - rows.length)} more`}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * What the system has already done about this account's contact.
 *
 * Written so that nobody has to open a job record or a database table to find
 * out. Where the record is not callable it names the blocker, the sources
 * already consulted and when the next automatic attempt is — so an operator can
 * see the difference between work in progress, a job genuinely finished with no
 * result, and something broken that they can fix.
 */
function ContactStatus({ row, onRetry, busy }: { row: Row; onRetry: () => void; busy: boolean }) {
  const state = ENRICHMENT[row.enrichmentState] ?? ENRICHMENT.NOT_SCHEDULED;
  const settled = row.enrichmentState === 'READY';

  return (
    <div>
      <Badge tone={state.tone}>{state.label}</Badge>

      {!settled && (
        <>
          {row.enrichmentBlocker && (
            <div className="dim" style={{ marginTop: '0.2rem', lineHeight: 1.4 }}>{row.enrichmentBlocker}</div>
          )}
          {!row.enrichmentBlocker && <div className="dim" style={{ marginTop: '0.2rem' }}>{state.hint}</div>}

          {/* What was already attempted, so nobody repeats it by hand. */}
          {row.enrichmentSources.length > 0 && (
            <div className="dim" style={{ marginTop: '0.2rem' }}>
              searched: {row.enrichmentSources.map((s) => humanise(s)).join(', ')}
              {row.enrichmentAttempts > 0 && ` · ${row.enrichmentAttempts} attempt(s)`}
            </div>
          )}

          {row.enrichmentNextAttemptAt && (
            <div className="dim">next automatic attempt {dayOnly(row.enrichmentNextAttemptAt)}</div>
          )}
          {row.enrichmentState === 'AMBIGUOUS' && (
            <div className="dim">no automatic retry — trying again returns the same candidates</div>
          )}
          {row.enrichmentFix && <div className="dim" style={{ lineHeight: 1.4 }}>fix: {row.enrichmentFix}</div>}

          <button className="btn secondary tiny mt" disabled={busy} onClick={onRetry}>
            {busy ? 'Trying…' : 'Try again now'}
          </button>
        </>
      )}

      {settled && row.enrichmentSources.length > 0 && (
        <div className="dim" style={{ marginTop: '0.2rem' }}>from {humanise(row.enrichmentSources[0])}</div>
      )}
    </div>
  );
}

function Select({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  options: Array<[string, string]>;
}) {
  return (
    <select className="input" style={{ width: 'auto' }} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );
}

/**
 * The full dossier, loaded on demand.
 *
 * The same reasoning the engine recorded, unchanged. What matters here is the
 * labelling: the source's own date and our first-seen date are shown as
 * separate lines with different words, and confirmed facts sit apart from
 * inferences rather than in one list.
 */
function EvidencePanel({ data }: { data: Record<string, unknown> | null }) {
  if (!data) return <div className="tiny dim">Loading evidence…</div>;
  if (data.error) return <div className="alert danger tiny">{String(data.error)}</div>;

  const event = data.event as Record<string, unknown>;
  const facts = (event.confirmedFacts as string[]) ?? [];
  const inferences = (event.inferredFacts as string[]) ?? [];
  const thesis = data.thesis as Record<string, unknown> | null;
  const fulfilment = data.fulfilment as Record<string, unknown>;
  const economics = data.economics as Record<string, unknown>;
  const risk = data.risk as Record<string, unknown>;

  return (
    <div className="grid grid-2" style={{ padding: '0.6rem 0' }}>
      <div>
        <div className="tiny dim">The event</div>
        <div className="tiny muted" style={{ lineHeight: 1.7 }}>
          <strong>{String(event.label)}</strong>
          <br />
          External event date: <strong>{dayOnly(event.externalEventDate as string | null)}</strong>
          <br />
          <span className="dim">First seen by us: {dayOnly(event.firstSeenByUs as string)} — our timestamp, not an event.</span>
          <br />
          Source: {String(event.connector)}
          {event.sourceUrl ? (
            <>
              {' · '}
              <a href={String(event.sourceUrl)} target="_blank" rel="noreferrer noopener">open the record ↗</a>
            </>
          ) : (
            <span className="dim"> · no source link</span>
          )}
        </div>

        {facts.length > 0 && (
          <>
            <div className="tiny dim mt">Confirmed by the source</div>
            <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
              {facts.map((f) => <li key={f}>· {f}</li>)}
            </ul>
          </>
        )}

        {inferences.length > 0 && (
          <>
            <div className="tiny dim mt">Our inference — not stated by anyone</div>
            <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
              {inferences.map((f) => <li key={f}>· {f}</li>)}
            </ul>
          </>
        )}

        <div className="tiny dim mt">Why this route</div>
        <div className="tiny muted">{String(data.rationale)}</div>
      </div>

      <div>
        {thesis && (
          <>
            <div className="tiny dim">Thesis</div>
            <div className="tiny muted" style={{ lineHeight: 1.7 }}>
              <strong>Why now:</strong> {String(thesis.whyNow)}
              <br />
              <strong>Who to ask for:</strong> {String(thesis.likelyStakeholder)}
              <br />
              <strong>Economics:</strong> {String(thesis.economics)}
            </div>
            {Array.isArray(thesis.uncertainties) && (
              <>
                <div className="tiny dim mt">What could make this wrong</div>
                <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
                  {(thesis.uncertainties as string[]).map((u) => <li key={u}>· {u}</li>)}
                </ul>
              </>
            )}
          </>
        )}

        <div className="tiny dim mt">Fulfilment</div>
        <div className="tiny muted">
          {String(fulfilment.status)} — {String(fulfilment.reason ?? '')}
        </div>

        <div className="tiny dim mt">Risk</div>
        <div className="tiny muted">
          payment {humanise(String(risk.paymentRisk))} · counterparty {humanise(String(risk.counterpartyRisk))} ·
          compliance {humanise(String(risk.complianceStatus))}
        </div>

        <div className="tiny dim mt">Commercial structure</div>
        <div className="tiny muted">
          {humanise(String(economics.structure ?? 'unset'))} — {String(economics.structureReason ?? '')}
        </div>
      </div>
    </div>
  );
}
