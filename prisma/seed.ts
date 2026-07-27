/**
 * Seeds a complete, connected demonstration of the operating loop.
 *
 * Rather than hand-writing finished deals, this seeds the *inputs* — companies,
 * contacts, capabilities, data sources — and then runs the real engines:
 * discovery, promotion, scoring, matching, deal configuration and next-action
 * selection. Calls are logged through the real calling path with realistic
 * transcripts, so extraction, escalation and stage movement are genuinely
 * exercised rather than faked.
 */

import { PrismaClient, type CallType, type Prisma } from '@prisma/client';
import { hashPassword } from '../lib/auth/password';
import { PERMISSIONS, ROLES } from '../lib/auth/rbac';
import { DEFAULT_CONFIG } from '../lib/config';
import { runAllDiscovery } from '../lib/discovery/run';
import { promoteSignals } from '../lib/discovery/promote';
import { scoreOpportunity } from '../lib/ai/scoring';
import { findMatches } from '../lib/ai/matching';
import { configureDeal } from '../lib/ai/dealConfig';
import { determineNextAction } from '../lib/ai/nextAction';
import { assessAllCompanies } from '../lib/ai/vulnerability';
import { assignOpportunitiesToLanes, evaluateAllLanes } from '../lib/ai/lanes';
import { generateDailyPlan } from '../lib/ai/planner';
import { generateDocument } from '../lib/ai/documents';
import { snapshotCallerMetrics } from '../lib/ai/analytics';
import { processTranscript } from '../lib/ai/transcript';
import { buildCallAssignment } from '../lib/ai/callAssignment';
import { getTranscription } from '../lib/providers/transcription';

const prisma = new PrismaClient();
const DEMO_PASSWORD = 'demo-password-123';

async function main() {
  console.info('▸ Resetting demo data…');
  await resetOrg('meridian-ops');

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const org = await prisma.organization.create({
    data: { name: 'Meridian Deal Operations', slug: 'meridian-ops', timezone: 'America/New_York' },
  });

  // --- Permissions and roles ------------------------------------------------
  console.info('▸ Seeding permissions, roles and users…');
  for (const [key, meta] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, description: meta.description, category: meta.category },
      update: { description: meta.description, category: meta.category },
    });
  }
  const allPermissions = await prisma.permission.findMany();
  const permissionByKey = new Map(allPermissions.map((p) => [p.key, p.id]));

  const roleIds: Record<string, string> = {};
  for (const [key, definition] of Object.entries(ROLES)) {
    const role = await prisma.role.create({
      data: {
        orgId: org.id,
        key,
        name: definition.name,
        description: definition.description,
        isSystem: true,
        permissions: {
          create: definition.permissions
            .map((permission) => permissionByKey.get(permission))
            .filter(Boolean)
            .map((permissionId) => ({ permissionId: permissionId as string })),
        },
      },
    });
    roleIds[key] = role.id;
  }

  const owner = await prisma.user.create({
    data: { orgId: org.id, email: 'owner@dealdispatch.test', name: 'Alex Reyes', passwordHash, roleId: roleIds.OWNER },
  });
  const manager = await prisma.user.create({
    data: { orgId: org.id, email: 'manager@dealdispatch.test', name: 'Priya Raman', passwordHash, roleId: roleIds.DEAL_MANAGER },
  });
  await prisma.user.create({
    data: { orgId: org.id, email: 'research@dealdispatch.test', name: 'Sam Okafor', passwordHash, roleId: roleIds.RESEARCH_REVIEWER },
  });
  await prisma.user.create({
    data: { orgId: org.id, email: 'finance@dealdispatch.test', name: 'Wei Zhang', passwordHash, roleId: roleIds.FINANCE_COMPLIANCE },
  });
  await prisma.user.create({
    data: { orgId: org.id, email: 'admin@dealdispatch.test', name: 'Jordan Blake', passwordHash, roleId: roleIds.ADMINISTRATOR },
  });

  const dana = await prisma.user.create({
    data: {
      orgId: org.id,
      email: 'dana@dealdispatch.test',
      name: 'Dana Whitfield',
      passwordHash,
      roleId: roleIds.CALLER,
      callerProfile: {
        create: {
          industryStrengths: ['commercial_cleaning', 'property_maintenance'],
          callTypeStrengths: ['BUYER_QUALIFICATION', 'SUBCONTRACTOR_RECRUITMENT'],
          coldCallSkill: 0.72,
          warmCallSkill: 0.81,
          objectionSkill: 0.68,
          extractionAccuracy: 0.86,
          buyerSideSkill: 0.84,
          supplySideSkill: 0.61,
          notes: 'Strongest on buyer qualification in services. Coach on supplier pricing calls.',
        },
      },
    },
  });

  const marcus = await prisma.user.create({
    data: {
      orgId: org.id,
      email: 'marcus@dealdispatch.test',
      name: 'Marcus Hale',
      passwordHash,
      roleId: roleIds.CALLER,
      callerProfile: {
        create: {
          industryStrengths: ['construction_trades', 'materials'],
          callTypeStrengths: ['SUPPLIER_QUALIFICATION', 'PRICING_REQUEST'],
          coldCallSkill: 0.64,
          warmCallSkill: 0.7,
          objectionSkill: 0.75,
          extractionAccuracy: 0.79,
          buyerSideSkill: 0.58,
          supplySideSkill: 0.88,
          notes: 'Supply-side specialist. Excellent at getting delivered pricing out of quarries and mills.',
        },
      },
    },
  });

  await prisma.configSetting.create({
    data: { orgId: org.id, key: 'operating_rules', value: DEFAULT_CONFIG as object, updatedBy: owner.id },
  });

  // --- Taxonomy -------------------------------------------------------------
  console.info('▸ Seeding configurable taxonomy…');
  const industryDefs = [
    ['construction_trades', 'Construction trades'],
    ['commercial_cleaning', 'Commercial cleaning'],
    ['landscaping', 'Landscaping'],
    ['property_maintenance', 'Property maintenance'],
    ['security', 'Security'],
    ['logistics', 'Logistics'],
    ['transportation', 'Transportation'],
    ['moving', 'Moving'],
    ['warehousing', 'Warehousing'],
    ['staffing', 'Staffing'],
    ['manufacturing', 'Manufacturing'],
    ['materials', 'Materials'],
    ['equipment', 'Equipment'],
    ['it_services', 'IT services'],
    ['field_services', 'Field services'],
    ['marketing', 'Marketing'],
    ['administrative_services', 'Administrative services'],
    ['professional_services', 'Professional services'],
    ['facility_supplies', 'Facility supplies'],
    ['industrial_supplies', 'Industrial supplies'],
  ] as const;

  const industries: Record<string, string> = {};
  for (const [key, name] of industryDefs) {
    const industry = await prisma.industry.create({ data: { orgId: org.id, key, name } });
    industries[key] = industry.id;
  }

  const capabilityDefs = [
    ['commercial_janitorial', 'Commercial janitorial', 'cleaning'],
    ['post_construction_cleaning', 'Post-construction cleaning', 'cleaning'],
    ['day_porter', 'Day porter service', 'cleaning'],
    ['commercial_electrical', 'Commercial electrical', 'trades'],
    ['mechanical_hvac', 'Mechanical and HVAC', 'trades'],
    ['drywall', 'Drywall and finishes', 'trades'],
    ['flooring', 'Flooring', 'trades'],
    ['sitework_grading', 'Sitework and grading', 'trades'],
    ['it_field_service', 'IT field service', 'technology'],
    ['structured_cabling', 'Structured cabling', 'technology'],
    ['last_mile_delivery', 'Last-mile delivery', 'logistics'],
    ['aggregate_supply', 'Aggregate supply', 'materials'],
    ['janitorial_supply', 'Janitorial supply distribution', 'supplies'],
  ] as const;

  const capabilities: Record<string, string> = {};
  for (const [key, name, category] of capabilityDefs) {
    const capability = await prisma.capability.create({ data: { orgId: org.id, key, name, category } });
    capabilities[key] = capability.id;
  }

  for (const [key, name] of [
    ['commercial_janitorial', 'Commercial janitorial'],
    ['electrical_subcontracting', 'Electrical subcontracting'],
    ['it_field_service', 'IT field service'],
    ['aggregate_delivery', 'Aggregate delivery'],
  ] as const) {
    await prisma.service.create({ data: { orgId: org.id, key, name } });
  }

  for (const [name, category, unit] of [
    ['Can liners 40x46 1.5mil', 'janitorial', 'case'],
    ['Multifold hand towels', 'janitorial', 'case'],
    ['2-ply restroom tissue', 'janitorial', 'case'],
    ['Neutral floor cleaner 5gal', 'janitorial', 'pail'],
    ['Nitrile disposable gloves', 'safety', 'case'],
  ] as const) {
    await prisma.product.create({ data: { orgId: org.id, name, category, unit } });
  }

  for (const name of ['Fairview County', 'Westbrook County', 'Rockdale County', 'Marion County'] as const) {
    await prisma.territory.create({ data: { orgId: org.id, name, kind: 'county', state: 'OH' } });
  }

  // --- Scripts --------------------------------------------------------------
  await seedScripts(org.id);

  // --- Data sources ---------------------------------------------------------
  console.info('▸ Registering discovery sources…');
  const sourceDefs: Array<[string, string, string, Prisma.DataSourceCreateInput['sourceType'], string]> = [
    ['public_awards', 'Public contract awards', 'contract_awards', 'CONTRACT_AWARD', 'Public procurement award notices published by the awarding agency for open inspection.'],
    ['permits', 'Municipal building permits', 'building_permits', 'BUILDING_PERMIT', 'Municipal building permit records published as public records.'],
    ['job_boards', 'Public job postings', 'job_postings', 'JOB_POSTING', "Publicly listed job postings retrieved within the posting site's published terms and rate limits."],
    ['bid_portal', 'Open bid and RFQ portal', 'bid_rfq', 'BID_RFP_PORTAL', 'Open solicitations published for public response. No authenticated portal is accessed.'],
    ['directories', 'Supplier and trade directories', 'supplier_directory', 'SUPPLIER_DIRECTORY', 'Business directory listings published by the listing companies themselves.'],
    ['press', 'Company press releases', 'press_releases', 'PRESS_RELEASE', 'Company press releases published for public distribution.'],
    ['csv', 'CRM / CSV import', 'csv_import', 'USER_UPLOAD', 'First-party data supplied by the operator.'],
  ];

  for (const [key, name, connector, sourceType, accessBasis] of sourceDefs) {
    await prisma.dataSource.create({
      data: { orgId: org.id, key, name, connector, sourceType, accessBasis, isEnabled: connector !== 'csv_import' },
    });
  }

  // --- Deal lanes -----------------------------------------------------------
  console.info('▸ Defining deal lanes…');
  const laneDefs = [
    {
      key: 'cleaning_multisite',
      name: 'Commercial cleaning for multi-location property managers',
      description: 'Recurring janitorial across a portfolio of commercial properties, fulfilled through regional cleaning subcontractors.',
      opportunityType: 'SUBCONTRACTING' as const,
      industryId: industries.commercial_cleaning,
      keywords: ['cleaning', 'janitorial', 'property', 'facility'],
    },
    {
      key: 'electrical_regional_gc',
      name: 'Electrical subcontracting for regional general contractors',
      description: 'Trade packages let out by general contractors on commercial renovation and build-out work.',
      opportunityType: 'SUBCONTRACTING' as const,
      industryId: industries.construction_trades,
      keywords: ['electrical', 'renovation', 'build-out', 'general contractor', 'multi-trade'],
    },
    {
      key: 'aggregate_sitework',
      name: 'Aggregate brokerage for site-work contractors',
      description: 'Delivered crushed stone and base material for site-work packages where freight is the binding constraint.',
      opportunityType: 'BROKERAGE' as const,
      industryId: industries.materials,
      keywords: ['aggregate', 'crushed', 'sitework', 'grading', 'stone'],
    },
    {
      key: 'janitorial_supply_portfolio',
      name: 'Janitorial-supply distribution to office portfolios',
      description: 'Recurring consumables supply to multi-property managers, sourced from regional wholesalers.',
      opportunityType: 'DISTRIBUTION' as const,
      industryId: industries.facility_supplies,
      keywords: ['janitorial supplies', 'consumables', 'can liners', 'supplies', 'restroom'],
    },
    {
      key: 'it_field_national_msp',
      name: 'IT field-service subcontracting for national MSPs',
      description: 'Local onsite break-fix and smart-hands coverage for national managed service providers.',
      opportunityType: 'SUBCONTRACTING' as const,
      industryId: industries.it_services,
      keywords: ['it field', 'smart hands', 'break-fix', 'managed service', 'onsite'],
    },
  ];

  for (const lane of laneDefs) {
    await prisma.dealLane.create({
      data: {
        orgId: org.id,
        key: lane.key,
        name: lane.name,
        description: lane.description,
        opportunityType: lane.opportunityType,
        industryId: lane.industryId,
        targetProfile: { keywords: lane.keywords } as object,
      },
    });
  }

  // --- Supply-side graph ----------------------------------------------------
  console.info('▸ Seeding supply-side companies…');
  await seedSupplySide(org.id, capabilities, industries);

  // --- Run the real discovery pipeline --------------------------------------
  console.info('▸ Running discovery across all sources…');
  const discovery = await runAllDiscovery(org.id);
  const signalsFound = discovery.reduce((sum, r) => sum + r.signalsCreated, 0);
  console.info(`  ${signalsFound} signal(s) detected from ${discovery.length} source(s)`);

  console.info('▸ Promoting signals into opportunities…');
  const promotion = await promoteSignals({ orgId: org.id });
  console.info(`  ${promotion.opportunityIds.length} opportunity(ies) opened, ${promotion.triaged} held for triage`);

  // --- Contacts on the demand side -----------------------------------------
  console.info('▸ Seeding contacts…');
  await seedContacts(org.id);

  // --- First pass of the AI loop -------------------------------------------
  console.info('▸ Running the AI loop over every opportunity…');
  await assessAllCompanies(org.id);
  const opportunities = await prisma.opportunity.findMany({ where: { orgId: org.id }, include: { parties: { include: { company: true } } } });
  for (const opportunity of opportunities) {
    await scoreOpportunity(opportunity.id);
    await determineNextAction(opportunity.id);
  }

  // --- Demonstration calls --------------------------------------------------
  console.info('▸ Running demonstration calls through the real transcript pipeline…');
  await runDemoCalls(org.id, dana.id, marcus.id);

  // --- Second pass: everything re-derives from the new facts ----------------
  console.info('▸ Re-running scoring, matching, deal configuration and next actions…');
  const refreshed = await prisma.opportunity.findMany({ where: { orgId: org.id }, select: { id: true } });
  for (const opportunity of refreshed) {
    await scoreOpportunity(opportunity.id);
    await findMatches(opportunity.id);
    await configureDeal(opportunity.id);
    await scoreOpportunity(opportunity.id);
    await determineNextAction(opportunity.id);
  }

  // --- Terminal-state examples ---------------------------------------------
  console.info('▸ Seeding won, lost and repeat history…');
  await seedHistory(org.id, manager.id, dana.id);

  // --- Documents, lanes, plan, metrics -------------------------------------
  console.info('▸ Generating briefs, lane evaluations, the daily plan and caller metrics…');
  const topOpportunities = await prisma.opportunity.findMany({
    where: { orgId: org.id, status: { notIn: ['WON', 'LOST'] } },
    orderBy: { expectedValue: 'desc' },
    take: 3,
    select: { id: true },
  });
  for (const opportunity of topOpportunities) {
    await generateDocument({ orgId: org.id, opportunityId: opportunity.id, kind: 'OPPORTUNITY_BRIEF' });
  }
  const configurable = await prisma.opportunity.findFirst({
    where: { orgId: org.id, deal: { isConfigurable: true } },
    select: { id: true },
  });
  if (configurable) {
    await generateDocument({ orgId: org.id, opportunityId: configurable.id, kind: 'INTERNAL_APPROVAL_SUMMARY' });
    await generateDocument({ orgId: org.id, opportunityId: configurable.id, kind: 'SUBCONTRACTOR_COMPARISON' });
  }

  await assignOpportunitiesToLanes(org.id);
  await evaluateAllLanes(org.id);
  await snapshotCallerMetrics(org.id, new Date(Date.now() - 90 * 86_400_000), new Date());
  const plan = await generateDailyPlan(org.id);

  // --- Summary --------------------------------------------------------------
  const counts = await summarize(org.id);
  console.info('\n─────────────────────────────────────────────');
  console.info('  Seed complete');
  console.info('─────────────────────────────────────────────');
  for (const [label, value] of Object.entries(counts)) {
    console.info(`  ${label.padEnd(26)} ${value}`);
  }
  console.info('─────────────────────────────────────────────');
  console.info(`  Sign in at http://localhost:3000/login`);
  console.info(`  Password for every account: ${DEMO_PASSWORD}`);
  console.info('    owner@dealdispatch.test      Owner');
  console.info('    manager@dealdispatch.test    Deal Manager');
  console.info('    dana@dealdispatch.test       Caller');
  console.info('    marcus@dealdispatch.test     Caller');
  console.info('    research@dealdispatch.test   Research Reviewer');
  console.info('    finance@dealdispatch.test    Finance & Compliance');
  console.info('    admin@dealdispatch.test      Administrator');
  console.info('─────────────────────────────────────────────');
  console.info(`\n${plan.narrative}\n`);
}

// ---------------------------------------------------------------------------

async function resetOrg(slug: string) {
  const existing = await prisma.organization.findUnique({ where: { slug } });
  if (!existing) return;
  // Cascades handle the rest; sessions and jobs hang off users and the org.
  await prisma.organization.delete({ where: { id: existing.id } });
}

async function seedScripts(orgId: string) {
  const scripts: Array<{
    callType: CallType;
    name: string;
    opener: string;
    branches: Array<{ trigger: string; say: string }>;
    objections: Array<{ objection: string; response: string }>;
  }> = [
    {
      callType: 'BUYER_QUALIFICATION',
      name: 'Buyer qualification v1',
      opener:
        "Hi, this is {caller} — I work with commercial property and facility groups in the {region} area. I'm not selling anything on this call; I'm trying to find out whether you have a need we could actually help with. Do you have two minutes?",
      branches: [
        { trigger: 'They say they already have a vendor', say: "That's usually the case — I'm not asking you to change anything. I'd just like to understand what you have in place, so if there's ever a gap we're a useful call to make." },
        { trigger: 'They sound rushed', say: 'I can keep this to ninety seconds, or call back — what works better?' },
        { trigger: 'They ask who we are', say: 'We coordinate service and supply for commercial accounts — we source and manage the provider rather than swinging the mop ourselves. That means we can usually cover things a single vendor cannot.' },
        { trigger: 'They mention a problem with the incumbent', say: 'That sounds frustrating. How often does that happen? And what have they said when you have raised it?' },
      ],
      objections: [
        { objection: 'We are happy with who we have', response: 'Good — that is worth protecting. Can I be the backup you call when they cannot cover something? It costs you nothing and it means you are never stuck.' },
        { objection: 'Send me an email', response: 'Happy to. So I send something useful rather than generic — what would you actually want it to answer?' },
        { objection: 'We are not looking right now', response: 'Understood. When does your current arrangement come up for renewal? I will make a note and come back at the right time rather than pestering you.' },
        { objection: 'Price is all that matters', response: 'Then let me price the exact scope rather than a guess. What are you paying today, and what does that include?' },
      ],
    },
    {
      callType: 'SUBCONTRACTOR_RECRUITMENT',
      name: 'Subcontractor recruitment v1',
      opener:
        "Hi, this is {caller}. We coordinate work for commercial clients and we have a scope in {location} that looks like a fit for you. I want to check capacity before I send anything over — is now a bad time?",
      branches: [
        { trigger: 'They ask what the work is', say: 'Give the scope, location and frequency only. Do not name the buyer, and do not state a price.' },
        { trigger: 'They ask what it pays', say: 'I want to send you the written scope so you can price it properly rather than me putting a number in your head. What do you need to see to quote it?' },
        { trigger: 'They say they are at capacity', say: 'Understood. When does that free up? And would you take it if it were night or weekend work?' },
      ],
      objections: [
        { objection: 'We only work direct', response: 'Fair. What we bring is the account and the administration. If the scope and the rate work, would you still look at it?' },
        { objection: 'We do not have insurance at that level', response: 'That is useful to know now rather than later. What are your current limits?' },
        { objection: 'We need exclusivity', response: 'That is a decision above my level. Let me take it back to management and come back to you.' },
      ],
    },
    {
      callType: 'SUPPLIER_QUALIFICATION',
      name: 'Supplier qualification v1',
      opener:
        'Hi, this is {caller}. I have a confirmed requirement and I am trying to source it properly rather than shop it around blindly. Can I run the specification past you?',
      branches: [
        { trigger: 'They ask about volume', say: 'Give the confirmed quantity only. If it is not confirmed, say so.' },
        { trigger: 'They quote a price', say: 'Is that picked up or delivered? And how long does that price hold?' },
      ],
      objections: [
        { objection: 'We only sell through distribution', response: 'Understood. Who covers this territory for you, and can you introduce me?' },
        { objection: 'That quantity is below our minimum', response: 'What is the minimum? And is there a way to structure it that works for you?' },
      ],
    },
    {
      callType: 'QUOTE_FOLLOW_UP',
      name: 'Quote follow-up v1',
      opener: 'Hi, this is {caller} — following up on the quote I sent on {date}. Did it reach you, and did the scope look right?',
      branches: [
        { trigger: 'They have not looked at it', say: 'No problem. Rather than resending it — what is the one thing you would need it to say for this to be an easy yes?' },
        { trigger: 'They say the price is high', say: 'Compared to what, specifically? If we are being compared against a different scope, I would rather fix the comparison than cut the number blindly.' },
      ],
      objections: [
        { objection: 'We went with someone else', response: 'Understood. What made the difference? And would you keep us as the backup for overflow or emergencies?' },
        { objection: 'It is stuck in approvals', response: 'Who else needs to see it, and is there anything I can give you that makes that conversation easier?' },
      ],
    },
  ];

  for (const script of scripts) {
    await prisma.scriptTemplate.create({
      data: {
        orgId,
        callType: script.callType,
        name: script.name,
        opener: script.opener,
        branches: script.branches as object,
        objections: script.objections as object,
      },
    });
  }
}

async function seedSupplySide(orgId: string, capabilities: Record<string, string>, industries: Record<string, string>) {
  // Apex Commercial Cleaning — strong subcontractor candidate.
  const apex = await prisma.company.create({
    data: {
      orgId,
      legalName: 'Apex Commercial Cleaning',
      website: 'https://apexclean.example.com',
      phone: '+15135550142',
      description: 'Commercial janitorial and post-construction cleaning across three counties. Multiple night crews, bonded staff.',
      companyRole: 'SUBCONTRACTOR',
      employeeCount: 64,
      serviceTerritories: ['Fairview', 'Westbrook', 'Rockdale'],
      certifications: ['ISSA CIMS'],
      insurance: { generalLiability: 2_000_000, autoLiability: 1_000_000, workersComp: 1_000_000 },
      relationshipStrength: 0.4,
      accountStage: 'QUALIFIED',
      locations: { create: { label: 'HQ', city: 'Fairview', state: 'OH', isHeadquarters: true } },
      industries: { create: { industryId: industries.commercial_cleaning, isPrimary: true } },
      capabilities: {
        create: [
          { capabilityId: capabilities.commercial_janitorial, status: 'CONFIRMED', confidence: 0.9 },
          { capabilityId: capabilities.post_construction_cleaning, status: 'CLAIMED', confidence: 0.6 },
          { capabilityId: capabilities.day_porter, status: 'CLAIMED', confidence: 0.6 },
        ],
      },
      contacts: {
        create: {
          orgId,
          firstName: 'Rosa',
          lastName: 'Delgado',
          title: 'Operations Manager',
          department: 'Operations',
          buyingRole: 'fulfillment',
          phone: '+15135550142',
          email: 'rosa@apexclean.example.com',
          decisionAuthority: 'decision_maker',
          influenceLevel: 0.9,
          consentToRecord: true,
          timezone: 'America/New_York',
        },
      },
      subCapacity: {
        create: {
          orgId,
          capabilities: ['commercial janitorial', 'post-construction cleaning', 'day porter'],
          territories: ['Fairview', 'Westbrook', 'Rockdale'],
          crewCount: 4,
          shiftAvailability: ['night'],
          minimumContract: 2500,
          insuranceLimits: { generalLiability: 2_000_000, workersComp: 1_000_000 },
          monthlyRate: 9800,
          suppliesConsumables: true,
          status: 'CLAIMED',
          confidence: 0.65,
          staleAfter: new Date(Date.now() + 30 * 86_400_000),
        },
      },
    },
  });

  // Bluegrass — a weaker alternative, so comparison has something to compare.
  await prisma.company.create({
    data: {
      orgId,
      legalName: 'Bluegrass Building Services',
      website: 'https://bluegrassbs.example.com',
      phone: '+15135550188',
      description: 'Regional commercial janitorial with day porter and night coverage across four counties. Actively seeking recurring contracts.',
      companyRole: 'SUBCONTRACTOR',
      employeeCount: 38,
      serviceTerritories: ['Westbrook', 'Fairview', 'Rockdale', 'Marion'],
      insurance: { generalLiability: 1_000_000 },
      locations: { create: { label: 'HQ', city: 'Westbrook', state: 'OH', isHeadquarters: true } },
      industries: { create: { industryId: industries.commercial_cleaning, isPrimary: true } },
      capabilities: {
        create: [
          { capabilityId: capabilities.commercial_janitorial, status: 'CLAIMED', confidence: 0.6 },
          { capabilityId: capabilities.day_porter, status: 'CLAIMED', confidence: 0.55 },
        ],
      },
      contacts: {
        create: {
          orgId,
          firstName: 'Terrence',
          lastName: 'Boone',
          title: 'Owner',
          phone: '+15135550188',
          decisionAuthority: 'decision_maker',
          influenceLevel: 1,
          consentToRecord: true,
        },
      },
      subCapacity: {
        create: {
          orgId,
          capabilities: ['commercial janitorial', 'day porter'],
          territories: ['Westbrook', 'Fairview', 'Rockdale', 'Marion'],
          crewCount: 2,
          shiftAvailability: ['night', 'weekend'],
          minimumContract: 1200,
          insuranceLimits: { generalLiability: 1_000_000 },
          monthlyRate: 8600,
          status: 'CLAIMED',
          confidence: 0.5,
          staleAfter: new Date(Date.now() + 30 * 86_400_000),
        },
      },
    },
  });

  // Voltline Electric — licensed trade, drives the compliance-gate path.
  await prisma.company.create({
    data: {
      orgId,
      legalName: 'Voltline Electric',
      website: 'https://voltline.example.com',
      phone: '+16145550119',
      description: 'Licensed commercial electrical contractor. Tenant improvement and multi-trade renovation experience, crews available for subcontract work.',
      companyRole: 'SUBCONTRACTOR',
      employeeCount: 52,
      serviceTerritories: ['Fairview', 'Columbus', 'Westbrook'],
      licenses: [{ type: 'master_electrician', number: 'OH-EL-44821', state: 'OH' }] as object,
      insurance: { generalLiability: 2_000_000, autoLiability: 1_000_000, workersComp: 1_000_000 },
      locations: { create: { label: 'HQ', city: 'Columbus', state: 'OH', isHeadquarters: true } },
      industries: { create: { industryId: industries.construction_trades, isPrimary: true } },
      capabilities: { create: [{ capabilityId: capabilities.commercial_electrical, status: 'CONFIRMED', confidence: 0.85 }] },
      contacts: {
        create: {
          orgId,
          firstName: 'Grant',
          lastName: 'Whitmore',
          title: 'Vice President, Preconstruction',
          phone: '+16145550119',
          decisionAuthority: 'decision_maker',
          influenceLevel: 0.85,
          consentToRecord: true,
        },
      },
      subCapacity: {
        create: {
          orgId,
          capabilities: ['commercial electrical'],
          territories: ['Fairview', 'Columbus', 'Westbrook'],
          crewCount: 3,
          licenses: ['OH-EL-44821'],
          insuranceLimits: { generalLiability: 2_000_000, workersComp: 1_000_000 },
          minimumContract: 25000,
          status: 'CLAIMED',
          confidence: 0.6,
          staleAfter: new Date(Date.now() + 30 * 86_400_000),
        },
      },
    },
  });

  // Rockdale Aggregates — brokerage supply side, with a deliberately stale quote.
  await prisma.company.create({
    data: {
      orgId,
      legalName: 'Rockdale Aggregates',
      website: 'https://rockdaleagg.example.com',
      phone: '+17405550166',
      description: 'Quarry producing crushed limestone in #57, #304 and #8 gradations. Bulk truckload availability and surplus stockpile capacity.',
      companyRole: 'MANUFACTURER',
      serviceTerritories: ['Rockdale', 'Fairview', 'Marion'],
      locations: { create: { label: 'Quarry', city: 'Rockdale County', state: 'OH', isHeadquarters: true } },
      industries: { create: { industryId: industries.materials, isPrimary: true } },
      capabilities: { create: [{ capabilityId: capabilities.aggregate_supply, status: 'CONFIRMED', confidence: 0.8 }] },
      contacts: {
        create: {
          orgId,
          firstName: 'Nadia',
          lastName: 'Kerr',
          title: 'Sales Manager',
          phone: '+17405550166',
          decisionAuthority: 'decision_maker',
          influenceLevel: 0.8,
          consentToRecord: true,
        },
      },
      supplyOffers: {
        create: {
          orgId,
          description: 'Crushed limestone #304 base, bulk',
          quantity: 22000,
          unit: 'ton',
          unitCost: 14.5,
          freightBasis: 'FOB quarry',
          leadTimeDays: 5,
          location: 'Rockdale County, OH',
          minimumOrder: 500,
          status: 'CLAIMED',
          confidence: 0.55,
          // Deliberately expired: exercises the stale-pricing path.
          staleAfter: new Date(Date.now() - 3 * 86_400_000),
        },
      },
    },
  });

  // Continental Facility Supply — distribution supply side.
  const products = await prisma.product.findMany({ where: { orgId } });
  await prisma.company.create({
    data: {
      orgId,
      legalName: 'Continental Facility Supply',
      website: 'https://continentalfs.example.com',
      phone: '+16145550204',
      description: 'Regional wholesale distributor of janitorial paper, can liners, floor care chemicals and safety supplies. Next-day delivery in central Ohio.',
      companyRole: 'DISTRIBUTOR',
      serviceTerritories: ['Columbus', 'Fairview', 'Westbrook', 'Rockdale'],
      locations: { create: { label: 'Warehouse', city: 'Columbus', state: 'OH', isHeadquarters: true } },
      industries: { create: { industryId: industries.facility_supplies, isPrimary: true } },
      capabilities: { create: [{ capabilityId: capabilities.janitorial_supply, status: 'CONFIRMED', confidence: 0.85 }] },
      contacts: {
        create: {
          orgId,
          firstName: 'Owen',
          lastName: 'Bexley',
          title: 'Regional Sales Director',
          phone: '+16145550204',
          decisionAuthority: 'decision_maker',
          influenceLevel: 0.75,
          consentToRecord: true,
        },
      },
      products: {
        create: products.map((product) => ({
          productId: product.id,
          role: 'supplies',
          unitCost: product.name.includes('Can liners') ? 28.4 : product.name.includes('towels') ? 41.2 : product.name.includes('tissue') ? 36.8 : product.name.includes('floor') ? 52.0 : 18.9,
          leadTimeDays: 2,
        })),
      },
      supplyOffers: {
        create: {
          orgId,
          description: 'Janitorial consumables programme — liners, towels, tissue, floor care',
          unit: 'month',
          unitCost: 8900,
          freightBasis: 'Delivered, next day',
          leadTimeDays: 2,
          location: 'Columbus, OH',
          status: 'CLAIMED',
          confidence: 0.6,
          staleAfter: new Date(Date.now() + 14 * 86_400_000),
        },
      },
    },
  });

  // Keystone Field Tech — IT field-service subcontractor.
  await prisma.company.create({
    data: {
      orgId,
      legalName: 'Keystone Field Tech',
      website: 'https://keystonefieldtech.example.com',
      phone: '+16145550287',
      description: 'Onsite IT break-fix, smart hands and structured cabling across central and southern Ohio. Regularly subcontracts to national managed service providers.',
      companyRole: 'SUBCONTRACTOR',
      serviceTerritories: ['Columbus', 'Fairview', 'Rockdale', 'Marion'],
      insurance: { generalLiability: 1_000_000, professionalLiability: 1_000_000 },
      locations: { create: { label: 'HQ', city: 'Columbus', state: 'OH', isHeadquarters: true } },
      industries: { create: { industryId: industries.it_services, isPrimary: true } },
      capabilities: {
        create: [
          { capabilityId: capabilities.it_field_service, status: 'CONFIRMED', confidence: 0.8 },
          { capabilityId: capabilities.structured_cabling, status: 'CLAIMED', confidence: 0.6 },
        ],
      },
      contacts: {
        create: {
          orgId,
          firstName: 'Lena',
          lastName: 'Fontaine',
          title: 'Director of Service Delivery',
          phone: '+16145550287',
          decisionAuthority: 'decision_maker',
          influenceLevel: 0.8,
          consentToRecord: true,
        },
      },
      subCapacity: {
        create: {
          orgId,
          capabilities: ['it field service', 'smart hands', 'structured cabling'],
          territories: ['Columbus', 'Fairview', 'Rockdale', 'Marion'],
          crewCount: 6,
          shiftAvailability: ['weekend'],
          hourlyRate: 95,
          insuranceLimits: { generalLiability: 1_000_000 },
          status: 'CLAIMED',
          confidence: 0.6,
          staleAfter: new Date(Date.now() + 30 * 86_400_000),
        },
      },
    },
  });

  // An incumbent relationship, so vulnerability analysis has something real.
  const sterlingIncumbent = await prisma.company.create({
    data: {
      orgId,
      legalName: 'Nationwide Facility Products',
      description: 'Incumbent janitorial supply vendor. Repeated stockouts and a March price increase are on record.',
      companyRole: 'DISTRIBUTOR',
      locations: { create: { label: 'Regional', city: 'Cleveland', state: 'OH', isHeadquarters: true } },
    },
  });

  return { apex, sterlingIncumbent };
}

async function seedContacts(orgId: string) {
  const contacts: Array<{ company: string; data: Omit<Prisma.ContactCreateInput, 'org' | 'company'> }> = [
    {
      company: 'Meridian Construction Group',
      data: {
        firstName: 'Elena',
        lastName: 'Vasquez',
        title: 'Director of Preconstruction',
        department: 'Preconstruction',
        buyingRole: 'decision maker for subcontract packages',
        phone: '+15135550101',
        email: 'evasquez@meridiancg.example.com',
        decisionAuthority: 'decision_maker',
        influenceLevel: 0.9,
        bestContactTime: '8-10am',
        consentToRecord: true,
        knownPriorities: ['schedule certainty', 'subcontractor reliability'],
      },
    },
    {
      company: 'Sterling Property Partners',
      data: {
        firstName: 'Marcus',
        lastName: 'Bell',
        title: 'Director of Facilities',
        department: 'Facilities',
        buyingRole: 'budget holder for facility services and supplies',
        phone: '+16145550233',
        email: 'mbell@sterlingpp.example.com',
        decisionAuthority: 'decision_maker',
        influenceLevel: 0.95,
        bestContactTime: 'early afternoon',
        consentToRecord: true,
        knownPriorities: ['vendor consolidation', 'consistent availability'],
      },
    },
    {
      company: 'Grantham Sitework LLC',
      data: {
        firstName: 'Dale',
        lastName: 'Grantham',
        title: 'Owner',
        phone: '+17405550311',
        email: 'dale@granthamsitework.example.com',
        decisionAuthority: 'decision_maker',
        influenceLevel: 1,
        consentToRecord: true,
        knownPriorities: ['delivered price', 'schedule'],
      },
    },
    {
      company: 'Northline Managed Services',
      data: {
        firstName: 'Priya',
        lastName: 'Anand',
        title: 'VP of Field Operations',
        phone: '+16145550422',
        decisionAuthority: 'decision_maker',
        influenceLevel: 0.85,
        consentToRecord: true,
      },
    },
    {
      company: 'Harborline Logistics',
      data: {
        firstName: 'Tomas',
        lastName: 'Ruiz',
        title: 'Regional Operations Manager',
        phone: '+15135550455',
        decisionAuthority: 'influencer',
        influenceLevel: 0.6,
        consentToRecord: true,
      },
    },
    {
      company: 'Brightpath Family Dental',
      data: {
        firstName: 'Hannah',
        lastName: 'Cole',
        title: 'Practice Administrator',
        phone: '+15135550477',
        decisionAuthority: 'decision_maker',
        influenceLevel: 0.7,
        // Recording refused: exercises the consent path on the call screen.
        consentToRecord: false,
      },
    },
  ];

  for (const entry of contacts) {
    const company = await prisma.company.findFirst({ where: { orgId, legalName: entry.company } });
    if (!company) continue;
    await prisma.contact.create({
      data: { ...entry.data, orgId, companyId: company.id } as Prisma.ContactUncheckedCreateInput,
    });
  }
}

/**
 * Runs demonstration calls through the same code path a caller uses: a call
 * record, a transcript from the transcription provider, then `processTranscript`
 * which extracts facts, updates records and advances the pipeline.
 */
async function runDemoCalls(orgId: string, danaId: string, marcusId: string) {
  const conversations: Array<{ company: string; callType: CallType; callerId: string; transcript: string }> = [
    {
      company: 'Sterling Property Partners',
      callType: 'BUYER_QUALIFICATION',
      callerId: danaId,
      transcript: [
        'Caller: Hi Marcus, this is Dana. I saw your RFQ for janitorial consumables across the office portfolio. I am not selling anything yet — I want to understand what you actually need. Do you have a couple of minutes?',
        'Marcus Bell: Sure, go ahead.',
        'Caller: How many properties does this cover?',
        'Marcus Bell: Nine properties across Columbus and Fairview. All commercial office, roughly 620,000 square feet total.',
        'Caller: And what are you spending on consumables at the moment?',
        'Marcus Bell: About $14,000 per month across the nine. Can liners, hand towels, restroom tissue, and floor care chemicals mostly.',
        'Caller: Who handles that today?',
        'Marcus Bell: We use Nationwide Facility Products. Honestly they have been a problem. We had stockouts on can liners three times last quarter, and hand towels twice. Then they hit us with a 9% price increase in March.',
        'Caller: That sounds frustrating. Have you raised it with them?',
        'Marcus Bell: Twice. Slow to respond, and nothing really changed. We are shopping around at this point.',
        'Caller: What would a better arrangement look like for you?',
        'Marcus Bell: One accountable vendor. Scheduled delivery so I am not chasing anyone, and consolidated invoicing instead of nine separate bills. Consistent availability more than anything.',
        'Caller: When would you want that in place?',
        'Marcus Bell: We would want to start 2026-09-01. Our arrangement with Nationwide is month to month, so we are not locked in.',
        'Caller: Is this recurring or would you want to trial it first?',
        'Marcus Bell: Recurring, monthly. But I would want to start with two or three buildings before we move everything.',
        'Caller: That is reasonable. Would you be open to us quoting the full list so you can compare properly?',
        'Marcus Bell: Yes, send it over. I make the call on this, so you are talking to the right person.',
        'Caller: I will get you a written scope and pricing. I am not quoting a number today — I want to price the exact list rather than guess.',
      ].join('\n'),
    },
    {
      company: 'Apex Commercial Cleaning',
      callType: 'SUBCONTRACTOR_RECRUITMENT',
      callerId: danaId,
      transcript: [
        'Caller: Hi Rosa, this is Dana. We coordinate service work for commercial clients and we have a recurring janitorial scope in Fairview that looks like a fit. Is now a bad time?',
        'Rosa Delgado: No, now is fine.',
        'Caller: Do you have capacity for additional recurring work?',
        'Rosa Delgado: We do. We run four crews and we have room for one more recurring account right now.',
        'Caller: Which areas do you actually cover?',
        'Rosa Delgado: We cover Fairview, Westbrook and Rockdale counties. We will not go past Marion, that is too far for a night crew.',
        'Caller: Can you do night shift?',
        'Rosa Delgado: Yes, nights are most of what we do. Crews start at 6pm.',
        'Caller: What is your minimum contract size?',
        'Rosa Delgado: $2,500 per month. Below that it is not worth routing a crew.',
        'Caller: What are your insurance limits?',
        'Rosa Delgado: We carry $2,000,000 general liability and $1,000,000 workers comp. I can send the certificate over.',
        'Caller: That helps. How soon could you start?',
        'Rosa Delgado: We could start 2026-09-01 if we have the scope by mid-August.',
        'Caller: Do you supply your own consumables?',
        'Rosa Delgado: We can, or the client can provide them. Either works.',
        'Caller: Last one — what would you charge for a mid-size office building, five nights a week?',
        'Rosa Delgado: Depends on square footage, but for something typical we are around $9,800 per month.',
        'Caller: Understood. I will send you the written scope so you can price it properly. I am not committing to anything on this call and neither are you.',
      ].join('\n'),
    },
    {
      company: 'Grantham Sitework LLC',
      callType: 'BUYER_QUALIFICATION',
      callerId: marcusId,
      transcript: [
        'Caller: Hi Dale, this is Marcus. I saw the Route 42 award and your RFQ for aggregate. I want to understand the requirement before I go source it.',
        'Dale Grantham: Fine, what do you need to know?',
        'Caller: What exactly do you need and how much?',
        'Dale Grantham: 18,000 tons of crushed aggregate base. Mostly #304, some #57. Delivered to two staging yards in Rockdale County.',
        'Caller: When do you need first deliveries?',
        'Dale Grantham: 2026-10-01. That is a hard date, we are behind schedule as it is.',
        'Caller: What is the constraint — price or availability?',
        'Dale Grantham: Freight. The nearest quarry is 41 miles out and the haul is killing the delivered number. If you can find something closer or a better freight rate, I am interested.',
        'Caller: Who are you buying from today?',
        'Dale Grantham: We have been using Tri-State Materials but they missed two deliveries last month and it pushed us back a week.',
        'Caller: What are you paying delivered?',
        'Dale Grantham: Around $23 per ton delivered. That is too high for this volume.',
        'Caller: Is this a one-time requirement or ongoing?',
        'Dale Grantham: One-time for this job, but we have three more coming next year.',
        'Caller: Are you getting multiple quotes?',
        'Dale Grantham: Yes, I am talking to three people. Best delivered number wins, assuming they can actually hit the date.',
        'Caller: Understood. I will come back with a delivered price. I am not quoting you a number until I have the freight confirmed.',
      ].join('\n'),
    },
    {
      company: 'Rockdale Aggregates',
      callType: 'SUPPLIER_QUALIFICATION',
      callerId: marcusId,
      transcript: [
        'Caller: Hi Nadia, this is Marcus. I have a confirmed requirement for crushed base and I want to see whether you can cover it.',
        'Nadia Kerr: Go ahead.',
        'Caller: 18,000 tons of #304 base, delivered to two staging yards in Rockdale County, first deliveries 2026-10-01.',
        'Nadia Kerr: We have the material. We have surplus stockpile this season, about 22,000 tons of #304 available.',
        'Caller: What is your price?',
        'Nadia Kerr: $14.50 per ton FOB the quarry. That is picked up, not delivered.',
        'Caller: What would delivered look like to Rockdale County?',
        'Nadia Kerr: We do not haul ourselves, you would need to arrange freight or we can quote it through our carrier. I would need the exact yard addresses to price that.',
        'Caller: What is your lead time?',
        'Nadia Kerr: Five days once the order is placed. We can start loading 2026-09-25 if you want to build a stockpile ahead of the date.',
        'Caller: What is your minimum order?',
        'Nadia Kerr: 500 tons.',
        'Caller: How long does the $14.50 hold?',
        'Nadia Kerr: Thirty days. After that it moves with our seasonal pricing.',
        'Caller: Understood. I will send you the delivery points so you can quote the freight. Nothing is committed on either side yet.',
      ].join('\n'),
    },
    {
      company: 'Meridian Construction Group',
      callType: 'PRIME_QUALIFICATION',
      callerId: danaId,
      transcript: [
        'Caller: Hi Elena, this is Dana. Congratulations on the Municipal Services Building award. I wanted to ask which scopes you are planning to subcontract.',
        'Elena Vasquez: Thanks. We are self-performing the drywall and finishes. Electrical, mechanical, flooring and the final construction cleaning are all going out.',
        'Caller: What is the value of the packages you are letting?',
        'Elena Vasquez: Electrical is the big one, somewhere around $640,000. Construction cleaning is much smaller, maybe $85,000 across the three floors.',
        'Caller: What insurance do your subs have to carry?',
        'Elena Vasquez: $2,000,000 general liability, $1,000,000 auto, $1,000,000 workers comp. Non-negotiable, it is in the prime contract.',
        'Caller: And licensing?',
        'Elena Vasquez: Electrical has to be a licensed Ohio contractor obviously. Cleaning does not need a licence but they need to be bonded.',
        'Caller: The solicitation mentioned a 22% small business subcontracting goal — is that driving your selection?',
        'Elena Vasquez: It is, and honestly that is a problem for us. We do not have enough qualified small business subs in our bench for this region.',
        'Caller: When do you need those packages committed?',
        'Elena Vasquez: We need commitments by 2026-08-15. Performance starts 2026-09-01.',
        'Caller: Do you have subs lined up already?',
        'Elena Vasquez: For electrical we have one we have used before but they are stretched thin. For cleaning we have nobody. Our usual cleaning sub lost most of their crews over the winter.',
        'Caller: That is useful. Would you be open to us bringing you qualified subs for the cleaning and electrical packages?',
        'Elena Vasquez: Yes. Send me the scope-back and their qualifications. If they carry the insurance and can hit the date, I will look at them.',
      ].join('\n'),
    },
    {
      company: 'Northline Managed Services',
      callType: 'PRIME_QUALIFICATION',
      callerId: marcusId,
      transcript: [
        'Caller: Hi Priya, this is Marcus. I saw the credit union alliance award. I understand you are looking at local field service partners in some territories.',
        'Priya Anand: We are. We have 42 branches across four states and we have technicians in maybe half of those markets.',
        'Caller: Which territories are the gaps?',
        'Priya Anand: Southern and central Ohio mainly. We do not cover Rockdale or Marion at all right now.',
        'Caller: What kind of work would a partner be doing?',
        'Priya Anand: Onsite break-fix, smart hands, occasional cabling. Nothing exotic.',
        'Caller: What are your response time requirements?',
        'Priya Anand: Four hour response during business hours, next business day for non-critical.',
        'Caller: What do you typically pay for that?',
        'Priya Anand: I would rather not get into rates on a first call. Send me capabilities and coverage and we can talk numbers after.',
        'Caller: Completely fair. Do you need partners insured at a particular level?',
        'Priya Anand: $1,000,000 general liability minimum and they have to pass our background screening.',
        'Caller: And when do you need coverage in place?',
        'Priya Anand: The contract starts in October so realistically we need partners identified within six weeks.',
        'Caller: Understood. I will send coverage and capability detail. I will not quote you a rate until we have talked scope properly.',
      ].join('\n'),
    },
  ];

  for (const conversation of conversations) {
    const company = await prisma.company.findFirst({
      where: { orgId, legalName: conversation.company },
      include: { contacts: true, opportunityParties: { include: { opportunity: true } } },
    });
    if (!company || company.contacts.length === 0) {
      console.warn(`  ⚠ skipping call for ${conversation.company} — company or contact missing`);
      continue;
    }

    const opportunity = company.opportunityParties.find((p) => p.isPrimary)?.opportunity ?? null;

    const assignmentId = await buildCallAssignment({
      orgId,
      opportunityId: opportunity?.id ?? null,
      companyId: company.id,
      contactId: company.contacts[0].id,
      callType: conversation.callType,
      reason: `Demonstration call: ${conversation.callType.replace(/_/g, ' ').toLowerCase()} for ${company.legalName}.`,
      objective: 'Capture the facts required to move this opportunity forward.',
      desiredCommitment: 'Permission to send a written scope and preliminary pricing.',
      missingInformation: opportunity?.missingInformation ?? ['Scope', 'Timeline', 'Budget'],
    });
    if (!assignmentId) continue;

    await prisma.callAssignment.update({
      where: { id: assignmentId },
      data: { assignedToId: conversation.callerId, status: 'ASSIGNED' },
    });

    const startedAt = new Date(Date.now() - Math.floor(Math.random() * 6 + 1) * 86_400_000);
    const call = await prisma.call.create({
      data: {
        orgId,
        assignmentId,
        contactId: company.contacts[0].id,
        callerId: conversation.callerId,
        direction: 'OUTBOUND',
        toNumber: company.contacts[0].phone,
        outcome: 'CONNECTED',
        startedAt,
        endedAt: new Date(startedAt.getTime() + 9 * 60_000),
        durationSec: 540,
        recordingConsent: true,
        consentBasis: 'Single-party consent jurisdiction (OH); announcement played',
      },
    });

    const transcription = await getTranscription().transcribe({
      audioRef: `seed:${call.id}`,
      syntheticText: conversation.transcript,
    });

    const transcript = await prisma.transcript.create({
      data: {
        callId: call.id,
        provider: transcription.provider,
        language: transcription.language,
        text: transcription.text,
        segments: transcription.segments as object,
      },
    });

    const result = await processTranscript(transcript.id);
    console.info(
      `  ${company.legalName}: ${result.factsExtracted} fact(s), ${result.commitments} commitment(s), ${result.objections} objection(s), records updated: ${result.recordsUpdated.join(', ') || 'none'}`,
    );
  }

  // One call where the caller oversteps — exercises the governance escalation.
  const apex = await prisma.company.findFirst({ where: { orgId, legalName: 'Bluegrass Building Services' }, include: { contacts: true } });
  if (apex && apex.contacts.length > 0) {
    const assignmentId = await buildCallAssignment({
      orgId,
      companyId: apex.id,
      contactId: apex.contacts[0].id,
      callType: 'SUBCONTRACTOR_RECRUITMENT',
      reason: 'Second-source recruitment for the Fairview cleaning scope.',
      objective: 'Confirm capacity and territory coverage as an alternative to the leading candidate.',
      desiredCommitment: 'Written confirmation of capacity, coverage and insurance.',
      missingInformation: ['Crew capacity', 'Insurance limits', 'Earliest start'],
    });

    if (assignmentId) {
      await prisma.callAssignment.update({ where: { id: assignmentId }, data: { assignedToId: danaId, status: 'ASSIGNED' } });
      const startedAt = new Date(Date.now() - 2 * 86_400_000);
      const call = await prisma.call.create({
        data: {
          orgId,
          assignmentId,
          contactId: apex.contacts[0].id,
          callerId: danaId,
          direction: 'OUTBOUND',
          toNumber: apex.contacts[0].phone,
          outcome: 'CONNECTED',
          startedAt,
          endedAt: new Date(startedAt.getTime() + 6 * 60_000),
          durationSec: 360,
          recordingConsent: true,
          consentBasis: 'Single-party consent jurisdiction (OH); announcement played',
        },
      });

      const text = [
        'Caller: Hi Terrence, this is Dana. We have a recurring cleaning scope in Fairview and I wanted to check your capacity.',
        'Terrence Boone: We have capacity, yes. Two crews right now, and we cover Westbrook, Fairview, Rockdale and Marion.',
        'Caller: What are your insurance limits?',
        'Terrence Boone: $1,000,000 general liability. That is all we carry.',
        'Caller: Understood. I guarantee we can get you this contract if your number comes in under ten thousand a month.',
        'Terrence Boone: That is good to hear. Are we the only ones you are talking to?',
        'Caller: I promise you will be our first call on anything in Fairview. We will beat any price the other guys quote you.',
        'Terrence Boone: We would want exclusivity in Fairview if we are taking this on.',
        'Caller: I can definitely do that for you.',
        'Terrence Boone: Good. Send me the scope.',
      ].join('\n');

      const transcription = await getTranscription().transcribe({ audioRef: `seed:${call.id}`, syntheticText: text });
      const transcript = await prisma.transcript.create({
        data: {
          callId: call.id,
          provider: transcription.provider,
          language: transcription.language,
          text: transcription.text,
          segments: transcription.segments as object,
        },
      });
      const result = await processTranscript(transcript.id);
      console.info(`  Bluegrass Building Services: ${result.unauthorizedCommitments} unauthorised commitment(s) flagged for management review`);
    }
  }
}

/** Won, lost and repeat history so analytics and lane scoring have real inputs. */
async function seedHistory(orgId: string, managerId: string, callerId: string) {
  const apex = await prisma.company.findFirst({ where: { orgId, legalName: 'Apex Commercial Cleaning' } });
  const sterling = await prisma.company.findFirst({ where: { orgId, legalName: 'Sterling Property Partners' } });
  const lane = await prisma.dealLane.findFirst({ where: { orgId, key: 'cleaning_multisite' } });
  if (!apex || !sterling) return;

  const wonAt = new Date(Date.now() - 40 * 86_400_000);
  const won = await prisma.opportunity.create({
    data: {
      orgId,
      name: 'Subcontracting: Sterling Property Partners — emergency cleaning, Westbrook location',
      type: 'SUBCONTRACTING',
      stage: 'REPEAT_OR_EXPANSION',
      status: 'WON',
      priority: 'MEDIUM',
      laneId: lane?.id ?? null,
      ownerId: managerId,
      location: 'Westbrook, OH',
      summary:
        'Two emergency post-incident cleaning assignments at the Westbrook property, fulfilled by Apex Commercial Cleaning within 24 hours of request. Buyer manages eight further locations.',
      estimatedValue: 14200,
      estimatedGrossProfit: 3124,
      closingProbability: 1,
      fulfillmentConfidence: 0.95,
      expectedValue: 2968,
      informationCompleteness: 1,
      wedgeStrategy: 'One emergency job at a single location, used to earn the right to quote the recurring portfolio.',
      aiExplanation:
        'Won through an emergency wedge. Delivery was clean, which converts the account from a cold prospect into a reference for the remaining eight locations.',
      createdAt: new Date(Date.now() - 62 * 86_400_000),
      closedAt: wonAt,
      lastActivityAt: wonAt,
      parties: {
        create: [
          { companyId: sterling.id, role: 'BUYER', isPrimary: true },
          { companyId: apex.id, role: 'SUBCONTRACTOR' },
        ],
      },
      statusHistory: {
        create: [
          { toStage: 'SIGNAL_DISCOVERED', toStatus: 'ACTIVE', reason: 'Emergency request logged', actorType: 'ai', createdAt: new Date(Date.now() - 62 * 86_400_000) },
          { fromStage: 'SIGNAL_DISCOVERED', toStage: 'QUALIFICATION_REQUIRED', fromStatus: 'ACTIVE', toStatus: 'ACTIVE', reason: 'Scope needed confirming', actorType: 'ai', createdAt: new Date(Date.now() - 60 * 86_400_000) },
          { fromStage: 'QUALIFICATION_REQUIRED', toStage: 'FULFILLMENT_SCHEDULED', fromStatus: 'ACTIVE', toStatus: 'ACTIVE', reason: 'Apex confirmed same-week availability', actorType: 'ai', createdAt: new Date(Date.now() - 50 * 86_400_000) },
          { fromStage: 'FULFILLMENT_SCHEDULED', toStage: 'COMPLETED', fromStatus: 'ACTIVE', toStatus: 'WON', reason: 'Both assignments completed and invoiced', actorType: 'user', actorId: managerId, createdAt: wonAt },
          { fromStage: 'COMPLETED', toStage: 'REPEAT_OR_EXPANSION', fromStatus: 'WON', toStatus: 'WON', reason: 'Eight further locations at the same account', actorType: 'ai', createdAt: wonAt },
        ],
      },
    },
  });

  await prisma.deal.create({
    data: {
      orgId,
      opportunityId: won.id,
      type: 'SUBCONTRACTING',
      configuration: { model: 'subcontracting', scope: 'Emergency post-incident cleaning, two assignments', location: 'Westbrook, OH' } as object,
      buyerPrice: 14200,
      supplierCost: 11076,
      grossProfit: 3124,
      grossMarginPct: 22,
      isConfigurable: true,
      configuredAt: new Date(Date.now() - 52 * 86_400_000),
      paymentTerms: 'Net 30',
    },
  });

  await prisma.company.update({
    where: { id: sterling.id },
    data: { accountStage: 'FIRST_DEAL', relationshipStrength: 0.55, estimatedLifetimeValue: 168000 },
  });
  await prisma.company.update({
    where: { id: apex.id },
    data: { accountStage: 'REPEAT_DEAL', relationshipStrength: 0.7 },
  });

  // A loss, with a reason the analytics can aggregate.
  const harborline = await prisma.company.findFirst({ where: { orgId, legalName: 'Harborline Logistics' } });
  if (harborline) {
    const lostAt = new Date(Date.now() - 21 * 86_400_000);
    await prisma.opportunity.create({
      data: {
        orgId,
        name: 'Brokerage: Harborline Logistics — dock equipment sourcing',
        type: 'BROKERAGE',
        stage: 'LOST',
        status: 'LOST',
        priority: 'LOW',
        ownerId: managerId,
        location: 'Fairview, OH',
        summary: 'Dock levellers and restraints for the new cross-dock facility. Buyer went direct to the manufacturer.',
        estimatedValue: 48000,
        estimatedGrossProfit: 4800,
        closingProbability: 0,
        lostReason: 'Buyer purchased direct from manufacturer',
        createdAt: new Date(Date.now() - 45 * 86_400_000),
        closedAt: lostAt,
        lastActivityAt: lostAt,
        parties: { create: [{ companyId: harborline.id, role: 'BUYER', isPrimary: true }] },
        statusHistory: {
          create: [
            { toStage: 'SIGNAL_DISCOVERED', toStatus: 'ACTIVE', reason: 'Permit signal for dock equipment', actorType: 'ai', createdAt: new Date(Date.now() - 45 * 86_400_000) },
            { fromStage: 'SIGNAL_DISCOVERED', toStage: 'QUOTE_DELIVERED', fromStatus: 'ACTIVE', toStatus: 'WAITING', reason: 'Quote issued', actorType: 'ai', createdAt: new Date(Date.now() - 30 * 86_400_000) },
            { fromStage: 'QUOTE_DELIVERED', toStage: 'LOST', fromStatus: 'WAITING', toStatus: 'LOST', reason: 'Buyer purchased direct from the manufacturer', actorType: 'user', actorId: managerId, createdAt: lostAt },
          ],
        },
      },
    });
  }
}

async function summarize(orgId: string) {
  const [companies, contacts, evidence, signals, opportunities, needs, matches, deals, configurable, assignments, calls, facts, escalations, approvals, documents, decisions, lanes, nextActions] =
    await Promise.all([
      prisma.company.count({ where: { orgId } }),
      prisma.contact.count({ where: { orgId } }),
      prisma.sourceEvidence.count({ where: { orgId } }),
      prisma.discoverySignal.count({ where: { orgId } }),
      prisma.opportunity.count({ where: { orgId } }),
      prisma.buyerNeed.count({ where: { orgId } }),
      prisma.match.count({ where: { orgId } }),
      prisma.deal.count({ where: { orgId } }),
      prisma.deal.count({ where: { orgId, isConfigurable: true } }),
      prisma.callAssignment.count({ where: { orgId } }),
      prisma.call.count({ where: { orgId } }),
      prisma.extractedFact.count({ where: { orgId } }),
      prisma.escalation.count({ where: { orgId } }),
      prisma.approval.count({ where: { orgId } }),
      prisma.document.count({ where: { orgId } }),
      prisma.aIDecision.count({ where: { orgId } }),
      prisma.dealLane.count({ where: { orgId } }),
      prisma.nextAction.count({ where: { orgId, isCurrent: true } }),
    ]);

  return {
    Companies: companies,
    Contacts: contacts,
    'Source evidence': evidence,
    'Discovery signals': signals,
    Opportunities: opportunities,
    'Buyer needs': needs,
    Matches: matches,
    'Deals (configurable)': `${deals} (${configurable})`,
    'Call assignments': assignments,
    'Calls logged': calls,
    'Extracted facts': facts,
    Escalations: escalations,
    Approvals: approvals,
    Documents: documents,
    'AI decisions': decisions,
    'Deal lanes': lanes,
    'Current next actions': nextActions,
  };
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
