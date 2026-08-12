import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { autoFillAccuracy } from '@/lib/calls/review';
import { captureCaveat } from '@/lib/calls/recording';
import { AUTO_APPLY_THRESHOLD, HIGH_IMPACT_REASON } from '@/lib/calls/analysis';
import { Badge, Empty } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Calls waiting on a person.
 *
 * The order is the priority order, and it is not by age: an operator's own
 * request first, then the conclusions the analysis is never allowed to finalise,
 * then the uncertain ones, then the spot checks. A queue sorted by date buries
 * the dangerous items under the routine ones.
 */
const ORDER = ['OPERATOR_FLAGGED', 'HIGH_IMPACT', 'DISAGREEMENT', 'LOW_CONFIDENCE', 'RANDOM_SAMPLE'];

export default async function ReviewsPage() {
  // Not the transcript permission, which callers hold for their own calls.
  // This queue carries script observations about other callers, and those feed
  // performance and standing.
  const user = await requirePagePermission('analytics.caller.read.all');
  const since = new Date(Date.now() - 90 * 86_400_000);

  const [open, accuracy] = await Promise.all([
    prisma.callReview.findMany({
      where: { orgId: user.orgId, state: 'OPEN' },
      orderBy: { openedAt: 'asc' },
      take: 100,
      include: {
        session: {
          select: {
            id: true, startedAt: true, captureMode: true, recordingState: true,
            transcriptState: true, consentState: true,
            route: { select: { id: true, headline: true, company: { select: { legalName: true } } } },
            caller: { select: { name: true } },
            insights: {
              orderBy: { confidence: 'desc' },
              select: { id: true, kind: true, value: true, confidence: true, state: true, evidenceQuote: true, actor: true },
            },
          },
        },
      },
    }),
    autoFillAccuracy({ orgId: user.orgId, since }),
  ]);

  const sorted = [...open].sort(
    (a, b) => ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason) || a.openedAt.getTime() - b.openedAt.getTime(),
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Calls waiting on a person</h1>
          <p>
            Everything the analysis was unsure about, everything it is never allowed to finalise, and a sample of the
            calls it was confident about — because that sample is the only way anybody finds out whether the confident
            ones are right.
          </p>
        </div>
        <Badge tone={sorted.length > 0 ? 'warning' : 'success'}>{sorted.length}</Badge>
      </div>

      <div className="card" data-testid="accuracy">
        <h2 style={{ marginTop: 0 }}>Is auto-fill earning its place?</h2>
        <p className="small muted">{accuracy.verdict}</p>
        <p className="tiny dim">
          Read only from the spot checks on confident calls. Including the low-confidence reviews would measure the
          cases the system already said it was unsure about, which says nothing about the ones it applied without
          asking. Anything at or above {Math.round(AUTO_APPLY_THRESHOLD * 100)}% confidence is applied automatically.
        </p>
      </div>

      {sorted.length === 0 ? (
        <div className="card"><Empty>Nothing is waiting on a person.</Empty></div>
      ) : (
        sorted.map((review) => {
          const caveat = captureCaveat(review.session.captureMode);
          const undecided = review.session.insights.filter((i) => i.state === 'NEEDS_REVIEW');

          return (
            <div className="card" key={review.id} data-testid="review-item">
              <div className="card-title">
                <div>
                  <h2>{review.session.route.company.legalName}</h2>
                  <div className="row">
                    <Badge tone={review.reason === 'HIGH_IMPACT' || review.reason === 'OPERATOR_FLAGGED' ? 'danger' : 'warning'}>
                      {review.reason.toLowerCase().replace(/_/g, ' ')}
                    </Badge>
                    <span className="tiny dim">
                      {review.session.startedAt.toISOString().slice(0, 10)}
                      {review.session.caller && ` · ${review.session.caller.name}`}
                    </span>
                  </div>
                </div>
                <Link href={`/demand/opportunity/${review.session.route.id}`} className="btn sm">
                  Open the opportunity
                </Link>
              </div>

              <p className="small">{review.because}</p>

              {caveat && (
                <div className="alert small" data-testid="capture-caveat">{caveat}</div>
              )}
              {review.session.recordingState !== 'STORED' && (
                <p className="tiny dim" data-testid="no-audio">
                  Recording state: {review.session.recordingState.toLowerCase().replace(/_/g, ' ')}.
                  {review.session.recordingState !== 'NOT_ATTEMPTED' && ' There is no audio to play.'}
                </p>
              )}

              {review.session.insights.length === 0 ? (
                <p className="small muted">The analysis concluded nothing from this call.</p>
              ) : (
                <table className="table tiny">
                  <thead>
                    <tr><th>What it concluded</th><th>Confidence</th><th>Evidence</th><th>State</th></tr>
                  </thead>
                  <tbody>
                    {review.session.insights.map((insight) => (
                      <tr key={insight.id} data-testid="insight">
                        <td>
                          <strong>{insight.kind.toLowerCase().replace(/_/g, ' ')}</strong>
                          <div>{insight.value}</div>
                          <div className="tiny dim" data-testid="insight-actor">
                            concluded by {insight.actor}
                            {HIGH_IMPACT_REASON[insight.kind] && ` — ${HIGH_IMPACT_REASON[insight.kind]}`}
                          </div>
                        </td>
                        <td>{(insight.confidence * 100).toFixed(0)}%</td>
                        <td>
                          {insight.evidenceQuote
                            ? <em className="tiny">“{insight.evidenceQuote}”</em>
                            : <span className="dim tiny" data-testid="no-evidence">no quote — held for review</span>}
                        </td>
                        <td>
                          <Badge tone={insight.state === 'AUTO_APPLIED' ? 'success' : insight.state === 'NEEDS_REVIEW' ? 'warning' : undefined}>
                            {insight.state.toLowerCase().replace(/_/g, ' ')}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {undecided.length > 0 && (
                <p className="tiny dim">
                  {undecided.length} still {undecided.length === 1 ? 'needs' : 'need'} a decision before this review
                  can be closed.
                </p>
              )}
            </div>
          );
        })
      )}
    </>
  );
}
