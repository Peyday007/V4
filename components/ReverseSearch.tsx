'use client';

import { useState } from 'react';
import { Badge } from './ui';
import type { ReverseSearchResult } from '@/lib/supply/reverse';

/**
 * What a verified provider could be sold, and what has to be asked first.
 *
 * The presentation carries one rule that the rest of the page depends on:
 * nothing here is styled like an opportunity. No money, no score, no priority.
 * A market-development brief that looks like a deal will be worked like a deal,
 * and the person working it will spend the first call assuming somebody wants
 * this — which is the assumption the whole exercise is meant to test.
 *
 * So a brief reads as a set of questions, with the falsifier stated as loudly
 * as the thesis, and the only action available is to commit it to a campaign
 * that will be measured and killed on the same terms as everything else.
 */
export function ReverseSearchPanel({ result }: { result: ReverseSearchResult }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<
    { campaignId: string; name: string; tasks: number; youMustAdd: string[] } | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  if (!result.usable) {
    return (
      <div className="card" data-testid="reverse-refusal">
        <div className="card-title">
          <h2>Nothing to work from here yet</h2>
        </div>
        <p className="small">{result.because}</p>
        <div className="alert warning small mt">
          <strong>What would change it:</strong> {result.toUnblock}
        </div>
        {result.position && result.position.claimedCapabilities.length > 0 && (
          <div className="tiny dim mt">
            Claimed and unchecked: {result.position.claimedCapabilities.join(', ')}
          </div>
        )}
      </div>
    );
  }

  async function commit(miniPathKey: string) {
    setBusy(miniPathKey);
    setError(null);
    try {
      const response = await fetch('/api/supply/reverse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId: (result as Extract<ReverseSearchResult, { usable: true }>).position.companyId,
          miniPathKey,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
      setCreated(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  const { position, briefs, standing } = result;

  return (
    <div className="card" data-testid="reverse-briefs">
      <div className="card-title">
        <h2>{position.name}</h2>
        <span className="tiny dim">{position.location ?? 'location unknown'}</span>
      </div>

      <div className="alert info small" data-testid="reverse-standing">{standing}</div>

      <div className="mt">
        <div className="tiny dim">What has actually been established</div>
        <ul className="list-reset small mt" style={{ lineHeight: 1.6 }}>
          {position.verifiedCapabilities.map((c) => (
            <li key={c.name}>
              <Badge tone="success">verified</Badge> <strong>{c.name}</strong>
              <span className="dim"> — {c.how} ({c.verifiedAt.toISOString().slice(0, 10)})</span>
            </li>
          ))}
          {position.capacity.map((c, index) => (
            <li key={`${c.what}-${index}`}>
              <Badge tone={c.verifiedAt ? 'success' : 'warning'}>
                {c.verifiedAt ? 'checked' : 'their claim'}
              </Badge>{' '}
              {c.what}
              {c.detail && <span className="dim"> — {c.detail}</span>}
            </li>
          ))}
        </ul>
      </div>

      {created && (
        <div className="alert success small mt" data-testid="reverse-created">
          <strong>Drafted:</strong> {created.name} — {created.tasks} call(s) queued.{' '}
          <a href={`/campaigns/${created.campaignId}`}>Open it</a>
          <ul className="list-reset tiny mt" style={{ paddingLeft: '1rem' }}>
            {created.youMustAdd.map((item) => <li key={item}>· {item}</li>)}
          </ul>
        </div>
      )}
      {error && <div className="alert danger small mt">{error}</div>}

      {briefs.map((brief) => (
        <div key={brief.miniPathKey} className="card mt" data-testid={`reverse-brief-${brief.miniPathKey}`}>
          <div className="card-title">
            <h3 style={{ margin: 0 }}>{brief.label}</h3>
            <Badge>market development</Badge>
          </div>

          <p className="small">{brief.becauseThisProvider}</p>

          <div className="tiny dim mt">Who buys this</div>
          <p className="small">{brief.buyerTypes.join(', ')} — in {brief.geography}.</p>

          <div className="tiny dim mt">Why anyone would pay an intermediary</div>
          <p className="small">{brief.intermediaryAdvantage}</p>

          <div className="tiny dim mt">What to establish, in this order</div>
          <ol className="small" style={{ paddingLeft: '1.1rem', lineHeight: 1.6 }}>
            {brief.toEstablish.map((question) => <li key={question}>{question}</li>)}
          </ol>

          {/* As loud as the thesis, deliberately. A market-development idea with
              no stated falsifier runs until somebody loses interest, which is
              not the same as being wrong. */}
          <div className="alert warning small mt">
            <strong>What would show this is not worth pursuing:</strong> {brief.wouldFalsifyIt}
          </div>

          <button
            className="btn"
            disabled={busy !== null}
            onClick={() => commit(brief.miniPathKey)}
          >
            {busy === brief.miniPathKey ? 'Drafting…' : 'Draft a campaign for this'}
          </button>
          <div className="tiny dim mt">
            Creates a draft with these calls attached and a kill condition already set. It cannot be started
            until somebody adds an observation about the demand side, because the engine has none.
          </div>
        </div>
      ))}
    </div>
  );
}
