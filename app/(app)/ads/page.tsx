import Link from 'next/link';
import { requirePagePermission } from '@/lib/auth/page';
import { can } from '@/lib/auth/session';
import { buildAdRecommendations, PLATFORM_LABELS, type Verdict } from '@/lib/ai/demandGen';
import { Badge, Empty, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

const VERDICT_TONE: Record<Verdict, string> = {
  RUN: 'success',
  PREPARE_FIRST: 'warning',
  DO_NOT_RUN: 'danger',
};

const VERDICT_LABEL: Record<Verdict, string> = {
  RUN: 'Ready to run',
  PREPARE_FIRST: 'Prepare first',
  DO_NOT_RUN: 'Do not run yet',
};

export default async function AdsPage({ searchParams }: { searchParams: { verdict?: string } }) {
  const user = await requirePagePermission('analytics.pipeline.read');
  const showMoney = can(user, 'finance.margin.read');

  const all = await buildAdRecommendations(user.orgId);
  const filter = searchParams.verdict;
  const recommendations = filter ? all.filter((r) => r.verdict === filter) : all;

  const counts = {
    RUN: all.filter((r) => r.verdict === 'RUN').length,
    PREPARE_FIRST: all.filter((r) => r.verdict === 'PREPARE_FIRST').length,
    DO_NOT_RUN: all.filter((r) => r.verdict === 'DO_NOT_RUN').length,
  };

  const totalBudget = all
    .filter((r) => r.verdict === 'RUN')
    .reduce((sum, r) => sum + (r.economics.suggestedMonthlyBudget ?? 0), 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Advertising plan</h1>
          <p>
            What to advertise, where, and what has to be true before it makes money. Every recommendation is gated on
            confirmed fulfillment capacity in that specific territory — a lead you cannot deliver costs you the click and
            the relationship.
          </p>
        </div>
        <div className="row">
          <Badge tone="success">{counts.RUN} ready</Badge>
          <Badge tone="warning">{counts.PREPARE_FIRST} to prepare</Badge>
          {showMoney && totalBudget > 0 && <Badge tone="accent">{money(totalBudget)}/mo total</Badge>}
        </div>
      </div>

      <div className="filter-bar">
        <Link href="/ads" className={`filter-chip${!filter ? ' active' : ''}`}>
          All
        </Link>
        {(['RUN', 'PREPARE_FIRST', 'DO_NOT_RUN'] as Verdict[]).map((verdict) => (
          <Link key={verdict} href={`/ads?verdict=${verdict}`} className={`filter-chip${filter === verdict ? ' active' : ''}`}>
            {VERDICT_LABEL[verdict]} ({counts[verdict]})
          </Link>
        ))}
      </div>

      {recommendations.length === 0 ? (
        <div className="card">
          <Empty>
            Nothing to recommend yet. Add capabilities and territories under Administration, and get a few providers on
            file — recommendations are built from what you can actually deliver.
          </Empty>
        </div>
      ) : (
        recommendations.map((rec) => (
          <div
            className="card"
            key={rec.key}
            style={{
              borderLeft: `3px solid var(--${rec.verdict === 'RUN' ? 'success' : rec.verdict === 'PREPARE_FIRST' ? 'warning' : 'danger'})`,
            }}
          >
            <div className="card-title">
              <div>
                <h2>
                  {rec.service} — {rec.territory}
                </h2>
                <div className="row">
                  <Badge tone={VERDICT_TONE[rec.verdict]}>{VERDICT_LABEL[rec.verdict]}</Badge>
                  <Badge tone="accent">{PLATFORM_LABELS[rec.platform]}</Badge>
                  {rec.secondaryPlatform && <Badge>then {PLATFORM_LABELS[rec.secondaryPlatform]}</Badge>}
                </div>
              </div>
              {showMoney && rec.economics.suggestedMonthlyBudget !== null && rec.verdict === 'RUN' && (
                <div style={{ textAlign: 'right' }}>
                  <div className="stat-value" style={{ fontSize: '1.2rem' }}>
                    {money(rec.economics.suggestedMonthlyBudget)}
                  </div>
                  <div className="tiny dim">suggested monthly cap</div>
                </div>
              )}
            </div>

            <div className={`alert ${rec.verdict === 'RUN' ? 'success' : rec.verdict === 'PREPARE_FIRST' ? 'warning' : 'danger'} small`}>
              {rec.verdictReason}
            </div>

            <div className="two-col">
              <div>
                <h4>What has to happen before you spend</h4>
                {rec.prerequisites.length === 0 ? (
                  <div className="small muted">Nothing outstanding — you can launch this.</div>
                ) : (
                  <ol className="list-reset">
                    {rec.prerequisites.map((prereq, index) => (
                      <li key={index} style={{ padding: '0.45rem 0', borderBottom: '1px solid var(--border)' }}>
                        <div className="small">
                          <strong>{index + 1}. {prereq.action}</strong>
                          {prereq.link && (
                            <>
                              {' '}
                              <Link href={prereq.link} className="tiny">
                                open →
                              </Link>
                            </>
                          )}
                        </div>
                        <div className="tiny muted">{prereq.why}</div>
                      </li>
                    ))}
                  </ol>
                )}

                <h4 className="mt">Why this platform</h4>
                <p className="small muted">{rec.platformReason}</p>
                {rec.secondaryReason && (
                  <>
                    <h4>Second channel — {PLATFORM_LABELS[rec.secondaryPlatform!]}</h4>
                    <p className="small muted">{rec.secondaryReason}</p>
                  </>
                )}

                {rec.platform !== 'DIRECT_OUTREACH' && (
                  <>
                    <h4 className="mt">Starting keywords</h4>
                    <ul className="list-reset small mono">
                      {rec.keywords.map((keyword) => (
                        <li key={keyword}>{keyword}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              <div>
                <h4>Can you deliver it?</h4>
                <table>
                  <tbody>
                    <tr>
                      <td className="muted">Confirmed providers</td>
                      <td className="num">
                        <Badge tone={rec.fulfillment.readyProviders >= 3 ? 'success' : 'warning'}>
                          {rec.fulfillment.readyProviders}
                        </Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">Claimed, unverified</td>
                      <td className="num">{rec.fulfillment.unverifiedProviders}</td>
                    </tr>
                    <tr>
                      <td className="muted">Still needed</td>
                      <td className="num">{rec.fulfillment.providersNeeded || '—'}</td>
                    </tr>
                  </tbody>
                </table>
                {rec.fulfillment.gaps.length > 0 && (
                  <ul className="checklist">
                    {rec.fulfillment.gaps.slice(0, 4).map((gap) => (
                      <li key={gap} className="missing">
                        {gap}
                      </li>
                    ))}
                  </ul>
                )}

                <h4 className="mt">Is there demand?</h4>
                <table>
                  <tbody>
                    <tr>
                      <td className="muted">Recorded needs</td>
                      <td className="num">{rec.demand.buyerNeeds}</td>
                    </tr>
                    <tr>
                      <td className="muted">Signals</td>
                      <td className="num">{rec.demand.signals}</td>
                    </tr>
                    <tr>
                      <td className="muted">Deals won</td>
                      <td className="num">{rec.demand.wonDeals}</td>
                    </tr>
                  </tbody>
                </table>
                {rec.demand.evidence.length > 0 && (
                  <ul className="list-reset tiny muted" style={{ marginTop: '0.35rem' }}>
                    {rec.demand.evidence.map((item, index) => (
                      <li key={index}>• {item}</li>
                    ))}
                  </ul>
                )}

                {showMoney && (
                  <>
                    <h4 className="mt">The numbers</h4>
                    <table>
                      <tbody>
                        <tr>
                          <td className="muted">Gross profit per deal</td>
                          <td className="num">{money(rec.economics.grossProfitPerDeal)}</td>
                        </tr>
                        <tr>
                          <td className="muted">Max cost per lead</td>
                          <td className="num">{money(rec.economics.maxCostPerLead)}</td>
                        </tr>
                        <tr>
                          <td className="muted">Deals you can absorb</td>
                          <td className="num">{rec.economics.monthlyDealCapacity}/mo</td>
                        </tr>
                      </tbody>
                    </table>
                    <div className="tiny muted mt">{rec.economics.basis}</div>
                    <div className="tiny muted mt">{rec.economics.budgetReason}</div>
                  </>
                )}
              </div>
            </div>
          </div>
        ))
      )}
    </>
  );
}
