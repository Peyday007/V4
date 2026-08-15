'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from './ui';
import type { CampaignStarter } from '@/lib/campaign/starters';

/**
 * Starting a campaign, from an argument somebody can edit.
 *
 * The campaigns page had a model, a service, conditions, generated work and no
 * way to create anything — an owner could read campaigns and never make one.
 * The obvious fix is a blank form, and a blank form is why this stayed empty:
 * it asks somebody to state a market thesis, name the evidence against it,
 * price the test in hours and write a kill condition with a number in it,
 * from nothing, in one sitting.
 *
 * So the form starts from an argument. Pick a starter, and the thesis, the
 * reasons it might be wrong, the hours and the kill condition are already
 * there to be disagreed with. What is deliberately *not* filled in is the
 * geography and the evidence about this specific market, because those are the
 * parts only the owner knows and the parts that make it a real campaign rather
 * than a general observation.
 *
 * Nothing here can start a campaign. It creates a draft, and the readiness
 * rules on the server decide whether it may ever run — drafting a thesis and
 * committing money to it are different acts, and every product that ever had a
 * single "save and launch" button conflated them.
 */
export function CampaignCreator({ starters }: { starters: CampaignStarter[] }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<CampaignStarter | null>(null);
  const [name, setName] = useState('');
  const [states, setStates] = useState('');
  const [cities, setCities] = useState('');
  const [extraEvidence, setExtraEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function choose(starter: CampaignStarter) {
    setChosen(starter);
    setName(starter.label);
    setError(null);
  }

  async function create() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const targetStates = states
        .split(/[,\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length === 2);

      const response = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          thesis: chosen.thesis,
          whyNow: chosen.whyNow,
          route: chosen.route,
          targetStates,
          targetCities: cities.split(',').map((c) => c.trim()).filter(Boolean),
          buyerProfile: chosen.buyerProfile,
          providerProfile: chosen.providerProfile,
          requiredCapability: chosen.requiredCapability,
          testingHours: chosen.testingHours,
          testingCostCents: 0,
          testingCostBasis: chosen.testingCostBasis,
          budgetCents: null,
          evidence: [
            ...chosen.evidence,
            // The owner's own evidence about this market, marked as what it is:
            // somebody's reading until a source is attached to it.
            ...(extraEvidence.trim()
              ? [{ kind: 'SUPPORTING' as const, claim: extraEvidence.trim(), evidenceClass: 'INFERRED' as const }]
              : []),
          ],
          // Calling only. A paid channel needs a budget and a named authoriser,
          // and neither can be given from a create form.
          channels: [{ kind: 'CALLING', enabled: true, outcomeMetric: 'CONVERSATIONS_HELD' }],
          conditions: chosen.conditions,
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not create the campaign');
      if (result.id) router.push(`/campaigns/${result.id}`);
      else router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the campaign');
    } finally {
      setBusy(false);
    }
  }

  if (!chosen) {
    return (
      <div className="card" data-testid="campaign-starters">
        <div className="card-title">
          <h2>Start a campaign</h2>
          <span className="tiny dim">Pick an argument to edit rather than a blank page to fill in</span>
        </div>
        <div className="grid grid-2">
          {starters.map((starter) => (
            <button
              key={starter.key}
              type="button"
              className="card"
              data-testid={`starter-${starter.key}`}
              onClick={() => choose(starter)}
              style={{ textAlign: 'left', cursor: 'pointer', width: '100%' }}
            >
              <strong>{starter.label}</strong>
              <div className="small muted mt">{starter.premise}</div>
              <div className="tiny dim mt">
                <Badge>{starter.route.toLowerCase().replace(/_/g, ' ')}</Badge>{' '}
                {starter.testingHours}h to test ·{' '}
                {starter.evidence.filter((e) => e.kind === 'CONTRARY').length} reason(s) it might be wrong
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="card" data-testid="campaign-form">
      <div className="card-title">
        <h2>{chosen.label}</h2>
        <button type="button" className="btn secondary tiny" onClick={() => setChosen(null)}>
          Pick a different one
        </button>
      </div>

      <p className="small">{chosen.thesis}</p>
      <p className="tiny dim"><strong>Why now:</strong> {chosen.whyNow}</p>

      {/* The contrary evidence, shown before anything is filled in. A thesis
          with nothing against it has not been thought about, and burying the
          objections under a fold would be the same as not having them. */}
      <div className="alert warning small" data-testid="starter-contrary">
        <strong>Reasons this might be wrong:</strong>
        <ul className="list-reset mt">
          {chosen.evidence.filter((e) => e.kind === 'CONTRARY').map((e) => (
            <li key={e.claim}>• {e.claim}</li>
          ))}
        </ul>
      </div>

      <div className="alert info small" data-testid="starter-you-must-add">
        <strong>This cannot run until you add:</strong>
        <ul className="list-reset mt">
          {chosen.youMustAdd.map((item) => <li key={item}>• {item}</li>)}
        </ul>
      </div>

      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>

      <label className="field">
        <span>States (two-letter codes, comma separated)</span>
        <input
          value={states}
          onChange={(e) => setStates(e.target.value)}
          placeholder="IL, CA"
          data-testid="campaign-states"
        />
        <span className="tiny dim">
          A campaign with no geography cannot run — the readiness rules refuse it, because a market thesis
          without a market is an opinion.
        </span>
      </label>

      <label className="field">
        <span>Cities (optional, comma separated)</span>
        <input value={cities} onChange={(e) => setCities(e.target.value)} placeholder="Chicago" />
      </label>

      <label className="field">
        <span>What you know about this specific market</span>
        <textarea
          value={extraEvidence}
          onChange={(e) => setExtraEvidence(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Something true about this geography or these buyers, rather than about the trade in general."
        />
        <span className="tiny dim">
          Recorded as an inference until a source is attached to it, because that is what it is until then.
        </span>
      </label>

      <div className="row mt">
        <button type="button" className="primary" onClick={create} disabled={busy || name.trim().length < 3}>
          {busy ? 'Creating…' : 'Create as a draft'}
        </button>
        <span className="tiny dim">
          Creates a draft. Starting it needs somebody with campaign authority, because starting commits time and,
          where a paid channel is enabled, money.
        </span>
      </div>

      {error && <div className="alert danger small mt" data-testid="campaign-create-error">{error}</div>}
    </div>
  );
}
