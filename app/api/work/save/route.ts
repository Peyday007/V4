import { z } from 'zod';
import { handleRouteError, json } from '@/lib/api';
import { requireWorkspace, scopeFor } from '@/lib/caller/guard';
import { saveCallerCall } from '@/lib/caller/save';

export const dynamic = 'force-dynamic';

const Body = z.object({
  routeId: z.string().min(1),
  disposition: z.string().min(1),
  notes: z.string().max(8000).optional(),
  discovery: z.record(z.unknown()).optional(),
  followUpAt: z.string().nullable().optional(),
  contactName: z.string().max(200).optional(),
  contactRole: z.string().max(200).optional(),
  correctedPhone: z.string().max(40).optional(),
  correctedEmail: z.string().max(200).optional(),
  contextSnapshot: z.record(z.unknown()).optional(),
});

/**
 * Records what happened on a call.
 *
 * Every refusal it can return is deliberate and distinct: not yours, not
 * complete, or broken on our side. The third one preserves what the caller
 * typed and raises an incident, because a failed save is ours and must never
 * read as a caller who did not fill the form in.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWorkspace();
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return json({ ok: false, kind: 'incomplete', message: parsed.error.issues[0]?.message ?? 'Invalid save.' }, 400);
    }

    const result = await saveCallerCall({
      ...scopeFor(user),
      input: {
        ...parsed.data,
        disposition: parsed.data.disposition as Parameters<typeof saveCallerCall>[0]['input']['disposition'],
      },
      contextSnapshot: parsed.data.contextSnapshot,
    });

    if (!result.ok) {
      // 409 for an incomplete save: the request was understood and refused on
      // state, and the browser needs to tell them what is missing rather than
      // treat it as a malformed request.
      const status = result.kind === 'not_yours' ? 403 : result.kind === 'system' ? 503 : 409;
      return json(result, status);
    }
    return json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
