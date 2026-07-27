import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { checkContactability } from '@/lib/compliance';
import { CallConsole } from '@/components/CallConsole';
import { Badge, humanize, PriorityBadge, relativeDays } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function CallScreen({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const seesAll = can(user, 'call.assignment.read.all');

  const assignment = await prisma.callAssignment.findFirst({
    where: {
      id: params.id,
      orgId: user.orgId,
      ...(seesAll ? {} : { assignedToId: user.id }),
    },
    include: {
      company: { include: { locations: true, contacts: true } },
      contact: true,
      opportunity: { include: { buyerNeed: true } },
      script: true,
      calls: { orderBy: { startedAt: 'desc' }, include: { transcript: true } },
      assignedTo: true,
    },
  });

  if (!assignment) notFound();

  const compliance = await checkContactability({
    orgId: user.orgId,
    contactId: assignment.contactId,
    phone: assignment.contact?.phone ?? assignment.company.phone,
    state: assignment.company.locations.find((l) => l.isHeadquarters)?.state ?? null,
  });

  const known = (assignment.knownInformation ?? []) as Array<{ label: string; value: string; status: string }>;
  const missing = (assignment.missingInformation ?? []) as Array<{ label: string }>;
  const required = (assignment.requiredQuestions ?? []) as Array<{ prompt: string; factKey: string }>;
  const optional = (assignment.optionalQuestions ?? []) as Array<{ prompt: string; factKey: string }>;
  const branches = (assignment.script?.branches ?? []) as Array<{ trigger: string; say: string }>;
  const objections = (assignment.script?.objections ?? []) as Array<{ objection: string; response: string }>;

  const activeCall = assignment.calls.find((c) => c.endedAt === null) ?? null;
  const phone = assignment.contact?.phone ?? assignment.contact?.mobile ?? assignment.company.phone ?? null;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="row mb">
            <Badge tone="accent">{humanize(assignment.callType)}</Badge>
            <PriorityBadge priority={assignment.priority} />
            {assignment.opportunity && (
              <Link href={`/opportunities/${assignment.opportunityId}`} className="badge">
                {assignment.opportunity.name}
              </Link>
            )}
          </div>
          <h1>{assignment.company.legalName}</h1>
          <p>
            {assignment.contact
              ? `${assignment.contact.firstName} ${assignment.contact.lastName}${assignment.contact.title ? `, ${assignment.contact.title}` : ''}`
              : 'No named contact — ask for whoever handles this'}
            {' · '}
            {phone ?? 'no phone on file'}
            {assignment.contact?.bestContactTime ? ` · best time ${assignment.contact.bestContactTime}` : ''}
          </p>
        </div>
        <Link href="/calls" className="btn">
          Back to queue
        </Link>
      </div>

      {!compliance.allowed && (
        <div className="alert danger">
          <strong>This call is blocked.</strong>
          <ul className="list-reset" style={{ marginTop: '0.3rem' }}>
            {compliance.reasons.map((reason) => (
              <li key={reason}>• {reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className={compliance.recordingAllowed ? 'alert info' : 'alert warning'}>
        <strong>Recording:</strong> {compliance.recordingAllowed ? 'enabled' : 'disabled'} — {compliance.recordingBasis}
        {compliance.requiresAnnouncement && (
          <div className="small mt">
            Read this before recording starts: &ldquo;This call may be recorded for quality and record-keeping purposes. Please let me
            know if you would prefer that I not record.&rdquo;
          </div>
        )}
      </div>

      <div className="call-console">
        <div>
          <div className="card">
            <h2>Why you are calling</h2>
            <p className="small">{assignment.reason}</p>
            <div className="script-block">
              <h4>Objective</h4>
              <div className="small">{assignment.objective}</div>
            </div>
            <div className="script-block">
              <h4>Commitment to secure</h4>
              <div className="small">{assignment.desiredCommitment}</div>
            </div>
          </div>

          {assignment.previousSummary && (
            <div className="card">
              <h2>Previous conversation</h2>
              <p className="small pre-wrap">{assignment.previousSummary}</p>
            </div>
          )}

          <div className="card">
            <h2>Opener</h2>
            <p className="small pre-wrap">
              {assignment.script?.opener ??
                `Hi, this is ${user.name}. I work with companies in your area on ${humanize(assignment.callType).toLowerCase()}. Do you have two minutes?`}
            </p>
          </div>

          <div className="card">
            <div className="card-title">
              <h2>Required questions</h2>
              <Badge tone="warning">{required.length} must be answered</Badge>
            </div>
            {required.map((question) => (
              <div className="question" key={question.factKey}>
                {question.prompt}
                <div className="factkey">{question.factKey}</div>
              </div>
            ))}
            {optional.length > 0 && (
              <>
                <h4 className="mt">If there is time</h4>
                {optional.map((question) => (
                  <div className="question" key={question.factKey}>
                    <span className="muted">{question.prompt}</span>
                    <div className="factkey">{question.factKey}</div>
                  </div>
                ))}
              </>
            )}
          </div>

          {branches.length > 0 && (
            <div className="card">
              <h2>If they say…</h2>
              {branches.map((branch, index) => (
                <div className="script-block" key={index}>
                  <div className="tiny dim">{branch.trigger}</div>
                  <div className="small">{branch.say}</div>
                </div>
              ))}
            </div>
          )}

          {objections.length > 0 && (
            <div className="card">
              <h2>Approved objection responses</h2>
              {objections.map((objection, index) => (
                <div className="script-block" key={index}>
                  <div className="tiny dim">&ldquo;{objection.objection}&rdquo;</div>
                  <div className="small">{objection.response}</div>
                </div>
              ))}
            </div>
          )}

          <CallConsole
            assignmentId={assignment.id}
            activeCallId={activeCall?.id ?? null}
            phone={phone}
            blocked={!compliance.allowed}
          />
        </div>

        <div>
          <div className="card">
            <h2>What we already know</h2>
            {known.length === 0 ? (
              <div className="small muted">Nothing on file. Treat everything as unknown.</div>
            ) : (
              <ul className="checklist">
                {known.map((item, index) => (
                  <li key={index} className={item.status === 'CONFIRMED' ? 'done' : ''}>
                    <strong>{item.label}:</strong> {item.value}{' '}
                    <span className="tiny dim">({humanize(item.status)})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>What we need</h2>
            {missing.length === 0 ? (
              <div className="small muted">Nothing outstanding.</div>
            ) : (
              <ul className="checklist">
                {missing.map((item, index) => (
                  <li key={index} className="missing">
                    {item.label}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>You may offer</h2>
            <ul className="checklist">
              {assignment.mayOffer.map((item) => (
                <li key={item} className="done">
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="card" style={{ borderColor: 'var(--danger)' }}>
            <h2>You may not promise</h2>
            <ul className="checklist">
              {assignment.mayNotPromise.map((item) => (
                <li key={item} className="missing">
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="card" style={{ borderColor: 'var(--warning)' }}>
            <h2>Stop and escalate if</h2>
            <ul className="checklist">
              {assignment.escalateIf.map((item) => (
                <li key={item} className="missing">
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {assignment.calls.length > 0 && (
            <div className="card">
              <h2>Call history</h2>
              <ul className="timeline">
                {assignment.calls.map((call) => (
                  <li key={call.id}>
                    <time>
                      {relativeDays(call.startedAt)} · {call.outcome ? humanize(call.outcome) : 'in progress'}
                    </time>
                    {call.transcript?.summary && <div className="tiny muted">{call.transcript.summary.slice(0, 200)}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
