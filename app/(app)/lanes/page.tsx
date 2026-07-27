import { prisma } from '@/lib/db';
import { can } from '@/lib/auth/session';
import { requirePagePermission } from '@/lib/auth/page';
import { getOrgConfig } from '@/lib/config';
import { Badge, Empty, humanize, money, relativeDays, Stat } from '@/components/ui';

export const dynamic = 'force-dynamic';

const RECOMMENDATION_TONE: Record<string, string> = {
  SCALE: 'success',
  CONTINUE_TESTING: 'accent',
  IMPROVE_FULFILLMENT_COVERAGE: 'warning',
  IMPROVE_SCRIPT: 'warning',
  CHANGE_TARGET_PROFILE: 'warning',
  PAUSE: 'danger',
  ABANDON: 'danger',
  INSUFFICIENT_DATA: '',
};

export default async function LanesPage() {
  const user = await requirePagePermission('lane.read');
  const showMoney = can(user, 'finance.margin.read');
  const config = await getOrgConfig(user.orgId);

  const lanes = await prisma.dealLane.findMany({
    where: { orgId: user.orgId },
    include: { industry: true, _count: { select: { opportunities: true } } },
    orderBy: { laneScore: 'desc' },
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Repeatable deal lanes</h1>
          <p>
            Which combinations of buyer type, deal model and scope are worth scaling. Below the configured minimum sample of{' '}
            {config.planning.minimumLaneSampleSize} opportunities the system refuses to make a strategic call — three wins in a
            row is noise, not a lane.
          </p>
        </div>
        <Badge>{lanes.length} lanes</Badge>
      </div>

      {lanes.length === 0 ? (
        <div className="card">
          <Empty>No lanes configured.</Empty>
        </div>
      ) : (
        lanes.map((lane) => {
          const metrics = (lane.metrics ?? {}) as Record<string, number>;
          return (
            <div className="card" key={lane.id}>
              <div className="card-title">
                <div>
                  <h2>{lane.name}</h2>
                  <div className="row">
                    <Badge tone="accent">{humanize(lane.opportunityType)}</Badge>
                    {lane.industry && <Badge>{lane.industry.name}</Badge>}
                    <Badge tone={RECOMMENDATION_TONE[lane.recommendation]}>{humanize(lane.recommendation)}</Badge>
                    <Badge>score {lane.laneScore}</Badge>
                    <span className="tiny dim">
                      {lane._count.opportunities} opportunities · evaluated {lane.evaluatedAt ? relativeDays(lane.evaluatedAt) : 'never'}
                    </span>
                  </div>
                </div>
              </div>

              <p className="small muted">{lane.description}</p>

              {lane.recommendationReason && (
                <div className={`alert ${lane.recommendation === 'SCALE' ? 'success' : lane.recommendation === 'ABANDON' || lane.recommendation === 'PAUSE' ? 'danger' : 'info'} small`}>
                  {lane.recommendationReason}
                </div>
              )}

              {Object.keys(metrics).length > 0 && (
                <div className="grid grid-4">
                  <Stat label="Sample size" value={metrics.sampleSize ?? 0} sub={`${metrics.wonCount ?? 0} won / ${metrics.lostCount ?? 0} lost`} />
                  <Stat label="Qualification rate" value={`${Math.round((metrics.qualificationRate ?? 0) * 100)}%`} />
                  <Stat label="Contact rate" value={`${Math.round((metrics.contactRate ?? 0) * 100)}%`} />
                  {showMoney && <Stat label="Average deal size" value={money(metrics.averageDealSize)} />}
                  {showMoney && <Stat label="Average margin" value={`${metrics.averageGrossMarginPct ?? 0}%`} />}
                  <Stat label="Time to close" value={`${metrics.averageTimeToCloseDays ?? 0}d`} />
                  <Stat label="Repeat frequency" value={`${Math.round((metrics.repeatFrequency ?? 0) * 100)}%`} />
                  <Stat label="Switching friction" value={`${Math.round((metrics.switchingFriction ?? 0) * 100)}%`} />
                  <Stat label="Competitive intensity" value={`${Math.round((metrics.competitiveIntensity ?? 0) * 100)}%`} />
                  <Stat label="Operational complexity" value={`${Math.round((metrics.operationalComplexity ?? 0) * 100)}%`} />
                  <Stat label="Calls per won deal" value={metrics.callerEffortPerDeal ?? 0} />
                  <Stat label="Risk score" value={`${Math.round((metrics.riskScore ?? 0) * 100)}%`} />
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}
