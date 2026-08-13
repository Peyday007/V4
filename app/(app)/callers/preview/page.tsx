import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageAny } from '@/lib/auth/page';
import { Badge, Empty } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The caller's screen, read-only.
 *
 * There are two different things an owner might want, and conflating them is
 * how a preview ends up claiming a call happened:
 *
 *   *This* page — look at the layout. It reads one sandbox record and renders
 *   what a caller would see. It claims nothing, leases nothing, and records no
 *   attempt or engagement event. The proof is structural rather than a promise:
 *   there is no mutation anywhere in this file, and the audit asserts the
 *   attempt and event counts are identical before and after loading it.
 *
 *   Signing in as a test caller — actually work the sandbox, with dispositions,
 *   gates and callbacks. That writes, deliberately, and everything it writes is
 *   test data that production counts cannot see.
 *
 * A preview that could record an outcome would eventually record one by
 * accident, and an owner's curiosity would show up in a caller's numbers.
 */
export default async function PreviewWorkspacePage() {
  const user = await requirePageAny('call.assignment.read.all', 'admin.users');

  // Deliberately a plain read of a sandbox route. Not `serveNext`, which takes
  // a lease — a preview that claimed a record would hold it against a caller
  // who wanted to work it.
  const route = await prisma.routeHypothesis.findFirst({
    where: { orgId: user.orgId, dataMode: 'TEST' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, headline: true, rationale: true, route: true, tier: true,
      requiredCapability: true,
      company: {
        select: {
          legalName: true, cityName: true, stateCode: true, phone: true,
          contacts: {
            select: { firstName: true, lastName: true, title: true, phone: true },
            take: 1, orderBy: { createdAt: 'asc' },
          },
        },
      },
      event: { select: { headline: true, summary: true, type: true } },
    },
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Caller workspace — preview</h1>
          <p>
            What a caller sees, rendered read-only. Nothing on this page records an attempt, claims an
            opportunity or writes an engagement event, so you can look as often as you like.
          </p>
        </div>
        <Link href="/callers" className="btn secondary">Back to the floor</Link>
      </div>

      <div className="alert small" data-testid="preview-banner">
        <strong>Preview only.</strong> This is a layout, not a shift. To actually work a call — dispositions,
        the missing-field gate, callbacks, wrong numbers, do-not-contact, packet completion — create a test
        caller on the floor, issue them a PIN and sign in at <code>/work</code>. That records real events
        against test data, which production counts and the manager&rsquo;s judgements never see.
      </div>

      {!route ? (
        <div className="card">
          <Empty>
            There is no sandbox data yet. Create it from the calling floor and this page will show a practice
            record.
          </Empty>
        </div>
      ) : (
        <div className="card" data-testid="preview-card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ marginTop: 0, marginBottom: '0.2rem' }}>
                {route.company.legalName} <Badge tone="warning">TEST</Badge>
              </h2>
              <div className="dim small">
                {[route.company.cityName, route.company.stateCode].filter(Boolean).join(', ') || 'no location'}
                {' · '}{route.route.toLowerCase()}
                {' · '}{route.tier.toLowerCase().replace(/_/g, ' ')}
              </div>
            </div>
            <div className="tiny dim" style={{ textAlign: 'right' }}>
              {route.company.contacts[0]
                ? <>
                    {route.company.contacts[0].firstName} {route.company.contacts[0].lastName}
                    <br />{route.company.contacts[0].title ?? 'role unknown'}
                    <br />{route.company.contacts[0].phone ?? route.company.phone ?? 'no number'}
                  </>
                : 'no contact on this record'}
            </div>
          </div>

          <h3 className="small" style={{ marginBottom: '0.2rem' }}>Why we are calling</h3>
          <p className="small">{route.headline}</p>
          <p className="tiny dim">{route.rationale}</p>

          <h3 className="small" style={{ marginBottom: '0.2rem' }}>What triggered it</h3>
          <p className="small">{route.event.headline}</p>
          <p className="tiny dim">{route.event.summary}</p>

          {route.requiredCapability && (
            <p className="tiny dim">Capability needed: {route.requiredCapability}</p>
          )}

          <div className="alert small" style={{ marginTop: '0.75rem' }}>
            The disposition form, the after-call gate and the next-action fields appear here in a real shift.
            They are deliberately absent from the preview: a form that submits is a form that writes.
          </div>
        </div>
      )}
    </>
  );
}
