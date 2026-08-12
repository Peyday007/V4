import { handleRouteError, json } from '@/lib/api';
import { requireWorkspace, scopeFor } from '@/lib/caller/guard';
import { serveNext } from '@/lib/caller/packets';
import { loadCallCard } from '@/lib/demand/callCard';
import { fieldsForRoute, requiredFieldsFor, REQUIREMENTS } from '@/lib/caller/discovery';
import { DISPOSITIONS } from '@/lib/demand/dispositionList';

export const dynamic = 'force-dynamic';

/**
 * The next opportunity this caller should work.
 *
 * One at a time, chosen at serve time, and claimed on the way out so a second
 * tab asking the same question is handed a different record rather than the
 * same one twice.
 *
 * The route id is never taken from the request. What a caller may work is
 * decided entirely by what is in their packets, which is why there is nothing
 * here for a crafted request to change.
 */
export async function POST() {
  try {
    const user = await requireWorkspace();
    const scope = scopeFor(user);

    const result = await serveNext(scope);
    if (!result.served) {
      return json({ served: false, reason: result.reason, gate: result.gate ?? null });
    }

    const card = await loadCallCard({ orgId: scope.orgId, routeId: result.item.routeId });
    if (!card) {
      // Served and then unreadable is a system fault, not an empty queue.
      return json({ served: false, reason: 'That opportunity could not be loaded. Ask for the next one.' }, 500);
    }

    return json({
      served: true,
      because: result.because,
      localTime: result.localTime,
      remaining: result.remaining,
      card,
      // The form travels with the record, so the fields always match the route
      // the caller is actually looking at.
      form: {
        route: card.route,
        fields: fieldsForRoute(card.route),
        dispositions: DISPOSITIONS,
        requirements: Object.fromEntries(
          Object.entries(REQUIREMENTS).map(([disposition, requirement]) => [
            disposition,
            {
              because: requirement.because,
              needsFollowUpDate: Boolean(requirement.needsFollowUpDate),
              required: requiredFieldsFor(disposition as keyof typeof REQUIREMENTS, card.route).map((f) => f.key),
            },
          ]),
        ),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
