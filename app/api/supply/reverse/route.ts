import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { reverseSearch } from '@/lib/supply/reverse';
import { campaignFromBrief } from '@/lib/supply/develop';

export const dynamic = 'force-dynamic';

/**
 * Reverse search: what a verified provider could be sold, and to whom.
 *
 * `GET` answers the question and writes nothing. `POST` turns one of its
 * answers into a draft campaign with the calls attached, which is the only way
 * a market-development thesis becomes work rather than a paragraph.
 *
 * Creating the draft needs `campaign.write` rather than `discovery.read`,
 * because it is the act of committing a week of somebody's calling to a
 * hypothesis. Reading costs nothing and needs nothing.
 */
export async function GET(request: Request) {
  try {
    const user = await requirePermission('discovery.read');
    const companyId = new URL(request.url).searchParams.get('companyId');
    if (!companyId) return json({ error: 'Name the provider to search from.' }, 400);

    return json(await reverseSearch({ orgId: user.orgId, companyId }));
  } catch (error) {
    return handleRouteError(error);
  }
}

const Body = z.object({
  companyId: z.string().min(1),
  /** Which of the returned briefs to commit to. */
  miniPathKey: z.string().min(1),
  dataMode: z.enum(['PRODUCTION', 'TEST']).default('PRODUCTION'),
});

export async function POST(request: Request) {
  try {
    const user = await requirePermission('campaign.write');
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: 'Name the provider and which path to develop.' }, 400);
    }

    // Re-run the search rather than trusting the posted brief. A brief is a
    // derived thing and the client has had it since the page loaded; the
    // provider's capacity may have been unverified in the meantime, and a
    // campaign built on capacity that has since lapsed is exactly what this
    // module refuses to produce.
    const result = await reverseSearch({ orgId: user.orgId, companyId: parsed.data.companyId });
    if (!result.usable) {
      return json({ error: result.because, toUnblock: result.toUnblock }, 409);
    }

    const brief = result.briefs.find((b) => b.miniPathKey === parsed.data.miniPathKey);
    if (!brief) {
      return json({ error: 'That path is no longer supported by this provider\'s verified capacity.' }, 409);
    }

    const draft = await campaignFromBrief({
      orgId: user.orgId,
      userId: user.id,
      position: result.position,
      brief,
      dataMode: parsed.data.dataMode,
    });

    return json(draft, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
