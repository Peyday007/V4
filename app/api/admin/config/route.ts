import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { getOrgConfig, setOrgConfig } from '@/lib/config';
import { audit } from '@/lib/audit';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

const partialNumbers = z.record(z.number()).optional();

const schema = z.object({
  scoringWeights: partialNumbers,
  marginRules: partialNumbers,
  approvalLimits: partialNumbers,
  stalenessRules: partialNumbers,
  riskRules: z.record(z.union([z.number(), z.array(z.string())])).optional(),
  callingRules: z.record(z.union([z.number(), z.array(z.number()), z.array(z.string())])).optional(),
  planning: partialNumbers,
});

export async function GET() {
  try {
    const user = await requirePermission('admin.config');
    return json(await getOrgConfig(user.orgId));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requirePermission('admin.config');
    const patch = schema.parse(await request.json());
    const updated = await setOrgConfig(user.orgId, patch as never, user.id);

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: 'config.updated',
      entityType: 'ConfigSetting',
      metadata: { keys: Object.keys(patch) },
    });

    return json(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}
