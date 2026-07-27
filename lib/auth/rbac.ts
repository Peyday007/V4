/**
 * Role-based access control.
 *
 * Permission checks are always enforced server-side. The UI hides things it
 * shouldn't show, but hiding is never the control — `requirePermission` is.
 */

export const PERMISSIONS = {
  // Opportunities & deals
  'opportunity.read': { category: 'Deals', description: 'View opportunities' },
  'opportunity.read.assigned': { category: 'Deals', description: 'View only opportunities tied to own assignments' },
  'opportunity.write': { category: 'Deals', description: 'Create and edit opportunities' },
  'opportunity.stage.override': { category: 'Deals', description: 'Manually move pipeline stages' },
  'deal.read': { category: 'Deals', description: 'View deal configurations' },
  'deal.write': { category: 'Deals', description: 'Edit deal configurations' },
  'deal.approve': { category: 'Deals', description: 'Approve deals, pricing and contracts' },

  // Financial visibility
  'finance.margin.read': { category: 'Finance', description: 'See margins and gross profit' },
  'finance.pipeline.read': { category: 'Finance', description: 'See platform-wide financial pipeline' },
  'finance.risk.review': { category: 'Finance', description: 'Review payment, credit and compliance risk' },

  // Companies & contacts
  'company.read': { category: 'Graph', description: 'View companies' },
  'company.write': { category: 'Graph', description: 'Create and edit companies' },
  'contact.read': { category: 'Graph', description: 'View contacts' },
  'contact.write': { category: 'Graph', description: 'Create and edit contacts' },

  // Discovery
  'discovery.read': { category: 'Discovery', description: 'View signals and sources' },
  'discovery.review': { category: 'Discovery', description: 'Triage signals and low-confidence enrichment' },
  'discovery.run': { category: 'Discovery', description: 'Trigger discovery runs' },

  // Calling
  'call.assignment.read.own': { category: 'Calling', description: 'See own call assignments' },
  'call.assignment.read.all': { category: 'Calling', description: 'See all call assignments' },
  'call.assignment.write': { category: 'Calling', description: 'Create and reassign call assignments' },
  'call.place': { category: 'Calling', description: 'Place calls from the platform' },
  'call.transcript.read': { category: 'Calling', description: 'Read call transcripts' },

  // Management
  'escalation.read': { category: 'Management', description: 'View escalations' },
  'escalation.resolve': { category: 'Management', description: 'Resolve escalations' },
  'analytics.caller.read.own': { category: 'Management', description: 'See own caller performance' },
  'analytics.caller.read.all': { category: 'Management', description: 'See all caller performance' },
  'analytics.pipeline.read': { category: 'Management', description: 'See pipeline analytics' },
  'lane.read': { category: 'Management', description: 'View deal lanes' },
  'lane.write': { category: 'Management', description: 'Edit deal lanes' },

  // Documents & comms
  'document.read': { category: 'Documents', description: 'View documents' },
  'document.write': { category: 'Documents', description: 'Draft documents' },
  'document.send': { category: 'Documents', description: 'Send documents and messages externally' },

  // Administration
  'admin.config': { category: 'Admin', description: 'Manage industries, scripts, weights and rules' },
  'admin.users': { category: 'Admin', description: 'Manage users and roles' },
  'admin.integrations': { category: 'Admin', description: 'Manage integrations and data sources' },
  'admin.ai': { category: 'Admin', description: 'Manage AI configuration and governance rules' },
  'admin.audit.read': { category: 'Admin', description: 'Read audit logs' },
  'admin.jobs': { category: 'Admin', description: 'Manage background jobs' },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ROLES = {
  OWNER: {
    name: 'Owner',
    description: 'Full access to strategy, finances, users, AI rules, integrations and approvals.',
    permissions: Object.keys(PERMISSIONS) as PermissionKey[],
  },
  DEAL_MANAGER: {
    name: 'Deal Manager',
    description: 'Reviews opportunities, approves deals, manages exceptions and handles negotiations.',
    permissions: [
      'opportunity.read', 'opportunity.write', 'opportunity.stage.override',
      'deal.read', 'deal.write', 'deal.approve',
      'finance.margin.read', 'finance.pipeline.read',
      'company.read', 'company.write', 'contact.read', 'contact.write',
      'discovery.read', 'discovery.review', 'discovery.run',
      'call.assignment.read.all', 'call.assignment.write', 'call.place', 'call.transcript.read',
      'escalation.read', 'escalation.resolve',
      'analytics.caller.read.all', 'analytics.pipeline.read',
      'lane.read', 'lane.write',
      'document.read', 'document.write', 'document.send',
    ] as PermissionKey[],
  },
  CALLER: {
    name: 'Caller',
    description: 'Sees only assigned calls, approved context, scripts and personal performance.',
    permissions: [
      'opportunity.read.assigned',
      'call.assignment.read.own', 'call.place', 'call.transcript.read',
      'analytics.caller.read.own',
      'contact.read',
    ] as PermissionKey[],
  },
  RESEARCH_REVIEWER: {
    name: 'Research Reviewer',
    description: 'Reviews discovered companies, sources, classifications and low-confidence enrichment.',
    permissions: [
      'discovery.read', 'discovery.review', 'discovery.run',
      'company.read', 'company.write', 'contact.read', 'contact.write',
      'opportunity.read',
    ] as PermissionKey[],
  },
  FINANCE_COMPLIANCE: {
    name: 'Finance and Compliance',
    description: 'Reviews pricing, margins, payment risk, documentation, licensing and insurance.',
    permissions: [
      'opportunity.read', 'deal.read',
      'finance.margin.read', 'finance.pipeline.read', 'finance.risk.review',
      'company.read', 'contact.read',
      'escalation.read', 'escalation.resolve',
      'analytics.pipeline.read',
      'document.read', 'document.write',
      'admin.audit.read',
    ] as PermissionKey[],
  },
  ADMINISTRATOR: {
    name: 'Administrator',
    description: 'Manages configuration, integrations, categories, workflows and system access.',
    permissions: [
      'admin.config', 'admin.users', 'admin.integrations', 'admin.ai', 'admin.audit.read', 'admin.jobs',
      'discovery.read', 'discovery.run',
      'company.read', 'contact.read', 'opportunity.read',
      'lane.read',
      'call.assignment.read.all',
    ] as PermissionKey[],
  },
} as const;

export type RoleKey = keyof typeof ROLES;

export function roleHasPermission(roleKey: string, permission: PermissionKey): boolean {
  const role = ROLES[roleKey as RoleKey];
  if (!role) return false;
  return (role.permissions as readonly PermissionKey[]).includes(permission);
}

/**
 * Fields a caller must never receive. Applied when serialising opportunities
 * for users without `finance.margin.read`.
 */
export const MARGIN_FIELDS = [
  'estimatedGrossProfit',
  'grossProfit',
  'grossMarginPct',
  'supplierCost',
  'costTotal',
  'unitCost',
  'lineCost',
  'estimatedCost',
  'spread',
  'markup',
] as const;

export function redactFinancials<T>(row: T): T {
  if (Array.isArray(row)) return row.map((item) => redactFinancials(item)) as T;
  if (!row || typeof row !== 'object' || row instanceof Date) return row;

  const clone: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of Object.keys(clone)) {
    if ((MARGIN_FIELDS as readonly string[]).includes(key)) {
      clone[key] = null;
    } else {
      clone[key] = redactFinancials(clone[key]);
    }
  }
  return clone as T;
}
