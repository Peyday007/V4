import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { can } from '@/lib/auth/session';
import { getOrgConfig } from '@/lib/config';
import { CHANNEL_CAPABILITY, compareChannels, type Channel } from '@/lib/ai/outreach';
import { Badge, Empty, humanize, money, Stat } from '@/components/ui';

export const dynamic = 'force-dynamic';

const CHANNEL_LABEL: Record<Channel, string> = { CALL: 'Call', SMS: 'SMS', EMAIL: 'Email' };

const CONFIDENCE_TONE: Record<string, string> = {
  measured: 'success',
  provisional: 'warning',
  default: '',
};

const CONFIDENCE_LABEL: Record<string, string> = {
  measured: 'Measured from your data',
  provisional: 'Early data — not yet conclusive',
  default: 'Starting recommendation',
};

export default async function OutreachPage() {
  const user = await requirePagePermission('analytics.pipeline.read');
  const showMoney = can(user, 'finance.margin.read');
  const config = await getOrgConfig(user.orgId);

  const [recommendations, messageCount, smsReady, contactCount, optOuts] = await Promise.all([
    compareChannels(user.orgId),
    prisma.message.count({ where: { orgId: user.orgId, direction: 'outbound' } }),
    prisma.contact.count({ where: { orgId: user.orgId, consentToSms: true, hasMobile: true } }),
    prisma.contact.count({ where: { orgId: user.orgId } }),
    prisma.suppressionEntry.count({ where: { orgId: user.orgId, scope: 'DO_NOT_SMS' } }),
  ]);

  const measured = recommendations.filter((r) => r.confidence === 'measured');
  const totalSavings = recommendations.reduce((sum, r) => sum + Math.max(0, r.savingsPerHundred ?? 0), 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Outreach channels</h1>
          <p>
            Which channel to use for which job, and what each one actually costs per result. A call is worth many times an
            SMS when it can extract facts a text never will — and worth nothing extra when the question is closed.
          </p>
        </div>
        <div className="row">
          <Badge>{messageCount} messages sent</Badge>
          {measured.length > 0 && <Badge tone="success">{measured.length} measured</Badge>}
        </div>
      </div>

      <div className="grid grid-4 mb">
        <Stat
          label="Textable contacts"
          value={`${smsReady} / ${contactCount}`}
          sub="Opted in with a confirmed mobile"
        />
        <Stat label="SMS opt-outs" value={optOuts} sub={optOuts > 0 ? 'Permanently unreachable by text' : 'None yet'} />
        {showMoney && (
          <>
            <Stat label="Cost per call" value={`~$${(config.outreachCosts.callerHourlyRate / 60 * 5).toFixed(2)}`} sub="5 min of caller time incl. wrap-up" />
            <Stat label="Cost per SMS" value={`$${config.outreachCosts.smsPerSegment.toFixed(4)}`} sub="per 160-character segment" />
            {totalSavings > 0 && (
              <Stat label="Switchable savings" value={money(totalSavings)} sub="per 100 touches, where SMS/email measurably wins" />
            )}
          </>
        )}
      </div>

      <div className="alert info small">
        <strong>How this decides.</strong> Cost only breaks ties between channels that can both do the job. SMS is far
        cheaper per touch, but you cannot extract a scope, a price and an insurance limit over text — the reply is too
        short and the follow-up questions never happen. So qualification stays on the phone regardless of price, while
        closed questions move to text as soon as the data supports it.
        {' '}Below {config.outreachRules.minimumSampleForChannelRecommendation} attempts per channel, recommendations stay
        provisional rather than pretending to be measured.
      </div>

      {recommendations.length === 0 ? (
        <div className="card">
          <Empty>No outreach recorded yet.</Empty>
        </div>
      ) : (
        recommendations.map((rec) => {
          const capability = CHANNEL_CAPABILITY[rec.purpose];
          return (
            <div className="card" key={rec.purpose}>
              <div className="card-title">
                <div>
                  <h2>{rec.purposeLabel}</h2>
                  <div className="row">
                    <Badge tone="accent">Use {CHANNEL_LABEL[rec.recommended]}</Badge>
                    <Badge tone={CONFIDENCE_TONE[rec.confidence]}>{CONFIDENCE_LABEL[rec.confidence]}</Badge>
                    <span className="tiny dim">{rec.sampleSize} attempt(s) on record</span>
                  </div>
                </div>
                {showMoney && rec.savingsPerHundred !== null && rec.savingsPerHundred > 0 && (
                  <div style={{ textAlign: 'right' }}>
                    <div className="stat-value" style={{ fontSize: '1.1rem' }}>{money(rec.savingsPerHundred)}</div>
                    <div className="tiny dim">saved per 100 touches</div>
                  </div>
                )}
              </div>

              <p className="small">{rec.reason}</p>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th className="num">Attempts</th>
                      <th className="num">Responses</th>
                      <th className="num">Meaningful</th>
                      <th className="num">Response rate</th>
                      <th className="num">Facts captured</th>
                      {showMoney && <th className="num">Total cost</th>}
                      {showMoney && <th className="num">Per meaningful</th>}
                      <th className="num">Median reply</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rec.stats.map((stat) => {
                      const viable = capability.viable.includes(stat.channel);
                      return (
                        <tr key={stat.channel} style={{ opacity: viable ? 1 : 0.45 }}>
                          <td>
                            <strong>{CHANNEL_LABEL[stat.channel]}</strong>
                            {stat.channel === rec.recommended && <> <Badge tone="success">chosen</Badge></>}
                            {!viable && <div className="tiny dim">not suitable for this job</div>}
                          </td>
                          <td className="num">{stat.attempts || '—'}</td>
                          <td className="num">{stat.reached || '—'}</td>
                          <td className="num">{stat.meaningful || '—'}</td>
                          <td className="num">{stat.attempts ? `${Math.round(stat.meaningfulRate * 100)}%` : '—'}</td>
                          <td className="num">{stat.factsCaptured || '—'}</td>
                          {showMoney && <td className="num">{stat.attempts ? money(stat.totalCost) : '—'}</td>}
                          {showMoney && (
                            <td className="num">
                              {stat.costPerMeaningful !== null ? `$${stat.costPerMeaningful.toFixed(2)}` : '—'}
                            </td>
                          )}
                          <td className="num">{stat.medianResponseMinutes !== null ? `${stat.medianResponseMinutes}m` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {rec.caveats.length > 0 && (
                <div className="mt">
                  {rec.caveats.map((caveat, index) => (
                    <div className="alert warning small" key={index}>
                      {caveat}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}

      <div className="card">
        <h2>Before you connect a real SMS provider</h2>
        <ul className="checklist">
          <li className="missing">
            <strong>Opt-in is required.</strong> Texting a contact without prior express consent is not permitted.{' '}
            {smsReady} of {contactCount} contacts currently qualify — the rest need consent captured on a call or a form first.
          </li>
          <li className="missing">
            <strong>Landlines silently fail.</strong> An SMS to a landline is discarded and still billed, so the system
            refuses to send unless the number is marked as a confirmed mobile.
          </li>
          <li className="missing">
            <strong>Every message carries an opt-out</strong> and STOP replies are honoured automatically — the contact is
            suppressed and consent revoked without anyone having to act.
          </li>
          <li className="missing">
            <strong>Quiet hours are tighter than calling hours</strong> ({config.outreachRules.smsEarliestHourLocal}:00–
            {config.outreachRules.smsLatestHourLocal}:00 local), and no contact gets more than{' '}
            {config.outreachRules.maxSmsPerContactPerWeek} texts a week.
          </li>
          <li>
            <strong>US A2P 10DLC registration</strong> is required by the carriers before business texting will reliably
            deliver. Budget a few days for it — unregistered traffic gets filtered rather than rejected, which looks like
            low response rates rather than an error.
          </li>
        </ul>
        <p className="small muted mt">
          Set <span className="mono">SMS_PROVIDER=twilio</span> plus the Twilio credentials to switch from the mock. Nothing
          above the provider interface changes — see <span className="mono">docs/INTEGRATIONS.md</span>.
        </p>
      </div>
    </>
  );
}
