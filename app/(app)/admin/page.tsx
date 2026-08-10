import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { getOrgConfig } from '@/lib/config';
import { ActionButton } from '@/components/ActionButton';
import { ConfigEditor } from '@/components/ConfigEditor';
import { Badge, Empty, humanize, relativeDays } from '@/components/ui';
import { SourceControls, ReinstallSources } from '@/components/SourceControls';
import { hasCredential } from '@/lib/discovery/http';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const user = await requirePagePermission('admin.config');
  const config = await getOrgConfig(user.orgId);

  const [industries, services, products, capabilities, scripts, questions, sources, jobs, decisions, auditEvents] =
    await Promise.all([
      prisma.industry.findMany({ where: { orgId: user.orgId }, orderBy: { name: 'asc' } }),
      prisma.service.findMany({ where: { orgId: user.orgId }, orderBy: { name: 'asc' } }),
      prisma.product.findMany({ where: { orgId: user.orgId }, orderBy: { name: 'asc' }, take: 40 }),
      prisma.capability.findMany({ where: { orgId: user.orgId }, orderBy: { name: 'asc' } }),
      prisma.scriptTemplate.findMany({ where: { orgId: user.orgId }, orderBy: { callType: 'asc' } }),
      prisma.qualificationQuestion.findMany({ where: { orgId: user.orgId }, orderBy: [{ callType: 'asc' }, { sortOrder: 'asc' }] }),
      prisma.dataSource.findMany({ where: { orgId: user.orgId }, orderBy: { name: 'asc' } }),
      prisma.job.findMany({ where: { orgId: user.orgId }, orderBy: { createdAt: 'desc' }, take: 25 }),
      prisma.aIDecision.findMany({ where: { orgId: user.orgId }, orderBy: { createdAt: 'desc' }, take: 25 }),
      prisma.auditEvent.findMany({ where: { orgId: user.orgId }, orderBy: { createdAt: 'desc' }, take: 25, include: { user: true } }),
    ]);

  const queued = jobs.filter((j) => j.status === 'QUEUED').length;
  const dead = jobs.filter((j) => j.status === 'DEAD').length;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Administration</h1>
          <p>
            Operating rules, taxonomy, scripts, integrations and the governance ledger. Everything the AI uses as a threshold
            lives here rather than in code.
          </p>
        </div>
        <div className="row">
          <ActionButton endpoint="/api/jobs/tick?max=25" className="primary">
            Run job queue
          </ActionButton>
          <ActionButton endpoint="/api/discovery/run" body={{ inline: true }}>
            Run discovery
          </ActionButton>
        </div>
      </div>

      <div className="card">
        <h2>Operating rules</h2>
        <p className="small muted">
          Margin floors, approval limits, staleness thresholds, calling hours and scoring weights. Changing a value here
          changes what the AI escalates and how it ranks work — no deploy required.
        </p>
        <ConfigEditor initial={config} />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-title">
            <h2>Background jobs</h2>
            <div className="row">
              <Badge>{queued} queued</Badge>
              {dead > 0 && <Badge tone="danger">{dead} dead</Badge>}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Status</th>
                  <th className="num">Attempts</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="mono tiny">{job.kind}</td>
                    <td>
                      <Badge tone={job.status === 'SUCCEEDED' ? 'success' : job.status === 'DEAD' || job.status === 'FAILED' ? 'danger' : job.status === 'RUNNING' ? 'accent' : ''}>
                        {job.status}
                      </Badge>
                      {job.lastError && <div className="tiny danger">{job.lastError.slice(0, 90)}</div>}
                    </td>
                    <td className="num">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                    <td className="tiny dim nowrap">{relativeDays(job.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            <h2>Data sources</h2>
            <ReinstallSources />
          </div>
          <p className="tiny dim">
            Live sources reach real external APIs. Fixture sources replay sample records and exist only for the
            demonstration — anything they produce is labelled as demo and cannot be worked.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Kind</th>
                  <th>Last run</th>
                  <th>Controls</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <strong className="small">{source.name}</strong>
                      <div className="tiny muted">{source.accessBasis}</div>
                      {source.termsUrl && (
                        <a className="tiny mono" href={source.termsUrl} target="_blank" rel="noreferrer noopener">
                          terms ↗
                        </a>
                      )}
                    </td>
                    <td>
                      <Badge tone={source.isLive ? 'success' : ''}>{source.isLive ? 'Live' : 'Fixture'}</Badge>
                      <div className="tiny dim">{source.rateLimitPerMin}/min</div>
                    </td>
                    <td className="tiny dim">
                      {source.lastRunAt ? relativeDays(source.lastRunAt) : 'never'}
                      {source.lastRecordCount !== null && <div>{source.lastRecordCount} record(s)</div>}
                      {source.consecutiveFailures > 0 && (
                        <div style={{ color: 'var(--danger)' }}>{source.consecutiveFailures} failure(s) in a row</div>
                      )}
                      {source.lastRunStatus && source.lastRunStatus !== 'ok' && (
                        <div className="mono" style={{ color: 'var(--warning)' }}>
                          {source.lastRunStatus.slice(0, 80)}
                        </div>
                      )}
                    </td>
                    <td>
                      <SourceControls
                        source={{
                          id: source.id,
                          name: source.name,
                          connector: source.connector,
                          isLive: source.isLive,
                          isEnabled: source.isEnabled,
                          credentialEnvVar: source.credentialEnvVar,
                          // Whether the key is set, never the key itself.
                          credentialPresent: hasCredential(source.credentialEnvVar),
                          rateLimitPerMin: source.rateLimitPerMin,
                          lastRunStatus: source.lastRunStatus,
                          lastRecordCount: source.lastRecordCount,
                          consecutiveFailures: source.consecutiveFailures,
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2>Taxonomy</h2>
          <h4>Industries ({industries.length})</h4>
          <div className="small">{industries.map((i) => i.name).join(', ')}</div>
          <h4 className="mt">Services ({services.length})</h4>
          <div className="small">{services.map((s) => s.name).join(', ')}</div>
          <h4 className="mt">Capabilities ({capabilities.length})</h4>
          <div className="small">{capabilities.map((c) => c.name).join(', ')}</div>
          <h4 className="mt">Products ({products.length})</h4>
          <div className="small">{products.map((p) => p.name).join(', ') || 'None'}</div>
        </div>

        <div className="card">
          <h2>Call scripts</h2>
          {scripts.length === 0 ? (
            <Empty>No scripts configured — the built-in question bank is used.</Empty>
          ) : (
            scripts.map((script) => (
              <div key={script.id} className="script-block">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong className="small">{humanize(script.callType)}</strong>
                  <Badge>v{script.version}</Badge>
                </div>
                <div className="tiny muted">{script.opener.slice(0, 200)}</div>
              </div>
            ))
          )}
          <h4 className="mt">Qualification questions ({questions.length} configured)</h4>
          <div className="small muted">
            {questions.length === 0
              ? 'Using the built-in question bank for every call type.'
              : `Overriding the defaults for ${new Set(questions.map((q) => q.callType)).size} call type(s).`}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>AI decision ledger</h2>
        <p className="small muted">
          Every autonomous action records its decision, reason, inputs, confidence, the rules applied, and the model and
          prompt version behind it.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Process</th>
                <th>Decision</th>
                <th>Reason</th>
                <th className="num">Conf.</th>
                <th>Rules</th>
                <th>Model / prompt</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((decision) => (
                <tr key={decision.id}>
                  <td className="mono tiny">{decision.process}</td>
                  <td className="small">{decision.decision}</td>
                  <td className="tiny muted">{decision.reason.slice(0, 220)}</td>
                  <td className="num">{Math.round(decision.confidence * 100)}%</td>
                  <td className="tiny dim">{decision.rulesApplied.join(', ')}</td>
                  <td className="tiny dim mono">
                    {decision.modelName}
                    <br />
                    {decision.promptVersion}
                  </td>
                  <td className="tiny dim nowrap">{relativeDays(decision.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Audit log</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Entity</th>
                <th>Actor</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {auditEvents.map((event) => (
                <tr key={event.id}>
                  <td className="mono tiny">{event.action}</td>
                  <td className="tiny">
                    {event.entityType}
                    {event.entityId ? ` ${event.entityId.slice(0, 10)}…` : ''}
                  </td>
                  <td className="small">{event.user?.name ?? event.actorType}</td>
                  <td className="tiny dim nowrap">{relativeDays(event.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
