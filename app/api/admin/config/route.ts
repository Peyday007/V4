import { z } from 'zod';
import { prisma } from '@/lib/db';
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
  /**
   * Identity lives on the organisation row rather than in config settings, so
   * it is handled separately from the numeric groups above.
   */
  organization: z
    .object({
      name: z.string().trim().min(1, 'A name is required').max(120),
      // Validated against the runtime's own database rather than a hardcoded
      // list, so calling-hour arithmetic cannot be given something it will
      // later throw on.
      timezone: z.string().refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown timezone'),
    })
    .optional(),
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
    const { organization, ...groups } = schema.parse(await request.json());

    if (organization) {
      await prisma.organization.update({
        where: { id: user.orgId },
        data: { name: organization.name, timezone: organization.timezone },
      });
      await audit({
        orgId: user.orgId,
        userId: user.id,
        action: 'organization.updated',
        entityType: 'Organization',
        entityId: user.orgId,
        metadata: { name: organization.name, timezone: organization.timezone },
      });
    }

    const updated = await setOrgConfig(user.orgId, groups as never, user.id);

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: 'config.updated',
      entityType: 'ConfigSetting',
      metadata: { keys: Object.keys(groups) },
    });

    return json(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}
