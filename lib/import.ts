import type { CompanyRole, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { audit, recordActivity } from '@/lib/audit';
import { parseCsv } from '@/lib/discovery/connectors';
import { normalizePhone } from '@/lib/compliance';
import { inferRequiredCapabilities } from '@/lib/ai/capabilities';
import { recordDecision } from '@/lib/ai/decisions';

/**
 * First-party CSV import.
 *
 * This is how an operation actually starts: not with discovery, but with the
 * accounts and providers someone already knows. Discovery only becomes useful
 * once there is a graph for it to add to.
 *
 * The importer is deliberately forgiving about column naming and strict about
 * two things — which side of a deal a company sits on, and whether a phone
 * number is a mobile — because both are load-bearing everywhere downstream.
 */

export type ImportSide = 'BUYER' | 'PROVIDER';

export type ParsedRow = {
  rowNumber: number;
  companyName: string;
  website: string | null;
  companyPhone: string | null;
  city: string | null;
  state: string | null;
  services: string[];
  territories: string[];
  notes: string | null;
  contact: {
    firstName: string;
    lastName: string;
    title: string | null;
    email: string | null;
    phone: string | null;
    isMobile: boolean;
  } | null;
  problems: string[];
};

export type ImportPreview = {
  rows: ParsedRow[];
  totalRows: number;
  usableRows: number;
  withContacts: number;
  unmappedHeaders: string[];
  recognisedHeaders: string[];
  problems: string[];
};

/**
 * Column aliases. Real exports never agree on naming, and making someone
 * rename headers before they can try the product is a pointless obstacle.
 */
const ALIASES: Record<string, string[]> = {
  companyName: ['company_name', 'company', 'business_name', 'account_name', 'organization', 'organisation', 'name', 'legal_name', 'account'],
  website: ['website', 'url', 'domain', 'web', 'website_url'],
  companyPhone: ['company_phone', 'main_phone', 'office_phone', 'business_phone', 'phone_number'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'province', 'region', 'st'],
  services: ['services', 'service', 'capabilities', 'capability', 'trade', 'trades', 'category', 'industry', 'what_they_do'],
  territories: ['territories', 'territory', 'coverage', 'service_area', 'areas', 'counties'],
  notes: ['notes', 'note', 'description', 'comments', 'detail', 'details'],
  firstName: ['first_name', 'firstname', 'contact_first_name', 'given_name', 'fname'],
  lastName: ['last_name', 'lastname', 'contact_last_name', 'surname', 'family_name', 'lname'],
  fullName: ['contact_name', 'contact', 'full_name', 'person', 'contact_person'],
  title: ['title', 'job_title', 'role', 'position', 'contact_title'],
  email: ['email', 'email_address', 'contact_email', 'e-mail'],
  contactPhone: ['contact_phone', 'direct_phone', 'phone', 'mobile', 'cell', 'cell_phone', 'mobile_phone', 'telephone'],
};

const MOBILE_HEADERS = ['mobile', 'cell', 'cell_phone', 'mobile_phone'];

/** Roles that can actually fulfil work, for the coverage check after a buyer import. */
const SUPPLY_SIDE_ROLES: CompanyRole[] = ['SUPPLIER', 'DISTRIBUTOR', 'SUBCONTRACTOR', 'CARRIER'];

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s.-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function buildHeaderMap(headers: string[]): { map: Record<string, number>; unmapped: string[]; mobileColumns: Set<number> } {
  const map: Record<string, number> = {};
  const unmapped: string[] = [];
  const mobileColumns = new Set<number>();

  headers.forEach((raw, index) => {
    const header = normaliseHeader(raw);
    if (MOBILE_HEADERS.includes(header)) mobileColumns.add(index);

    const field = Object.entries(ALIASES).find(([, aliases]) => aliases.includes(header))?.[0];
    if (!field) {
      if (raw.trim()) unmapped.push(raw.trim());
      return;
    }

    // A mobile column beats a landline column for the contact number wherever
    // it appears, because that choice decides whether the contact can be
    // texted at all — and a wrong guess bills for messages nobody receives.
    const existing = map[field];
    const overrideForMobile =
      field === 'contactPhone' && existing !== undefined && mobileColumns.has(index) && !mobileColumns.has(existing);

    if (existing === undefined || overrideForMobile) map[field] = index;
  });

  return { map, unmapped, mobileColumns };
}

/** Capability keys are unique per organisation, so this must be stable and bounded. */
export function slugifyCapability(service: string): string {
  return service.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'unnamed';
}

function splitList(value: string): string[] {
  return value
    .split(/[,;|/]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Parses without writing anything, so the operator can check before importing. */
export function previewCsv(csv: string): ImportPreview {
  const rows = parseCsv(csv);
  if (rows.length === 0) {
    return { rows: [], totalRows: 0, usableRows: 0, withContacts: 0, unmappedHeaders: [], recognisedHeaders: [], problems: ['The file is empty.'] };
  }
  if (rows.length === 1) {
    return {
      rows: [], totalRows: 0, usableRows: 0, withContacts: 0, unmappedHeaders: [], recognisedHeaders: [],
      problems: ['Only a header row was found — no data underneath it.'],
    };
  }

  const { map, unmapped, mobileColumns } = buildHeaderMap(rows[0]);
  const problems: string[] = [];
  if (map.companyName === undefined) {
    problems.push('No company-name column found. Name one of your columns "company_name" (or company, business_name, account_name).');
  }

  const parsed: ParsedRow[] = [];
  const seen = new Set<string>();

  rows.slice(1).forEach((cells, index) => {
    const get = (field: string): string => {
      const position = map[field];
      return position === undefined ? '' : (cells[position] ?? '').trim();
    };

    const companyName = get('companyName');
    const rowProblems: string[] = [];
    if (!companyName) rowProblems.push('No company name — row will be skipped');

    const key = companyName.toLowerCase();
    if (companyName && seen.has(key)) rowProblems.push('Duplicate of an earlier row — contacts will be merged onto the same company');
    if (companyName) seen.add(key);

    // Contact name may arrive split or whole.
    let firstName = get('firstName');
    let lastName = get('lastName');
    if (!firstName && !lastName) {
      const full = get('fullName');
      if (full) {
        const parts = full.split(/\s+/);
        firstName = parts[0] ?? '';
        lastName = parts.slice(1).join(' ');
      }
    }

    const contactPhoneColumn = map.contactPhone;
    const contactPhone = get('contactPhone');
    const isMobile = contactPhoneColumn !== undefined && mobileColumns.has(contactPhoneColumn);
    const email = get('email');

    if (firstName && !contactPhone && !email) {
      rowProblems.push('Contact has neither phone nor email — nobody will be able to reach them');
    }

    parsed.push({
      rowNumber: index + 2,
      companyName,
      website: get('website') || null,
      companyPhone: get('companyPhone') || null,
      city: get('city') || null,
      state: get('state').toUpperCase() || null,
      services: splitList(get('services')),
      territories: splitList(get('territories')),
      notes: get('notes') || null,
      contact: firstName || lastName ? { firstName: firstName || '(unknown)', lastName, title: get('title') || null, email: email || null, phone: contactPhone || null, isMobile } : null,
      problems: rowProblems,
    });
  });

  const usable = parsed.filter((r) => r.companyName);
  return {
    rows: parsed,
    totalRows: parsed.length,
    usableRows: usable.length,
    withContacts: usable.filter((r) => r.contact).length,
    unmappedHeaders: unmapped,
    recognisedHeaders: Object.keys(map),
    problems,
  };
}

export type CapabilityMapping = {
  service: string;
  capability: string;
  /** How the service in the file was resolved against the catalogue. */
  via: 'exact' | 'inferred' | 'created';
};

export type ImportResult = {
  companiesCreated: number;
  companiesUpdated: number;
  contactsCreated: number;
  skipped: number;
  capabilitiesCreated: number;
  capabilityMappings: CapabilityMapping[];
  warnings: string[];
};

const STOP_WORDS = new Set(['and', 'the', 'of', 'for', 'services', 'service', 'general', 'commercial', 'supply', 'llc', 'inc']);

function significantWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word)),
  );
}

/**
 * Whether an inferred catalogue match is close enough to trust.
 *
 * `inferRequiredCapabilities` is tuned for scraped prose, where a loose hit is
 * better than nothing. Here it is being pointed at a column the operator typed,
 * and a loose hit files "window cleaning" under "janitorial supply
 * distribution" — wrong data that reads as correct. Requiring a shared
 * significant word keeps the useful cases ("commercial janitorial" for
 * "janitorial") and rejects the rest, which then become new capabilities.
 */
export function inferenceIsCloseEnough(service: string, capabilityName: string): boolean {
  const serviceWords = significantWords(service);
  if (serviceWords.size === 0) return false;
  const capabilityWords = significantWords(capabilityName);
  for (const word of serviceWords) {
    if (capabilityWords.has(word)) return true;
  }
  return false;
}

/**
 * Writes the parsed rows.
 *
 * `side` is required rather than guessed. A company filed on the wrong side of
 * a deal breaks matching silently — the system will look for it as a provider
 * when it is a buyer — and that is much harder to notice than an import error.
 */
export async function importCsv(params: {
  orgId: string;
  csv: string;
  side: ImportSide;
  userId: string;
}): Promise<ImportResult> {
  const preview = previewCsv(params.csv);
  const result: ImportResult = {
    companiesCreated: 0,
    companiesUpdated: 0,
    contactsCreated: 0,
    skipped: 0,
    capabilitiesCreated: 0,
    capabilityMappings: [],
    warnings: [...preview.problems],
  };
  const mappingSeen = new Set<string>();
  if (preview.usableRows === 0) return result;

  const role: CompanyRole = params.side === 'BUYER' ? 'BUYER' : 'SUBCONTRACTOR';
  const existingCapabilities = await prisma.capability.findMany({ where: { orgId: params.orgId } });
  const capabilityByName = new Map(existingCapabilities.map((c) => [c.name.toLowerCase(), c]));
  // Keys are unique per organisation, so two differently-named services that
  // slugify the same way would collide on insert. Resolve against the key too.
  const capabilityByKey = new Map(existingCapabilities.map((c) => [c.key, c]));

  for (const row of preview.rows) {
    if (!row.companyName) {
      result.skipped += 1;
      continue;
    }

    const existing = await prisma.company.findFirst({
      where: { orgId: params.orgId, legalName: { equals: row.companyName, mode: 'insensitive' } },
    });

    const companyData: Prisma.CompanyUncheckedCreateInput = {
      orgId: params.orgId,
      legalName: row.companyName,
      website: row.website,
      phone: row.companyPhone,
      description: row.notes,
      companyRole: role,
      serviceTerritories: row.territories.length ? row.territories : row.city ? [row.city] : [],
      accountStage: 'DISCOVERED',
      // First-party, not discovered and certainly not fabricated. The interface
      // separates the three.
      origin: 'IMPORTED',
      // Imported data is first-party and asserted by the operator, so it counts
      // as verified in a way a scraped record does not.
      lastVerifiedAt: new Date(),
    };

    const company = existing
      ? await prisma.company.update({
          where: { id: existing.id },
          data: {
            website: row.website ?? existing.website,
            phone: row.companyPhone ?? existing.phone,
            description: row.notes ?? existing.description,
            serviceTerritories: row.territories.length ? row.territories : existing.serviceTerritories,
            lastVerifiedAt: new Date(),
          },
        })
      : await prisma.company.create({ data: companyData });

    if (existing) result.companiesUpdated += 1;
    else result.companiesCreated += 1;

    if (!existing && (row.city || row.state)) {
      await prisma.companyLocation.create({
        data: { companyId: company.id, label: 'Imported', city: row.city, state: row.state, isHeadquarters: true },
      });
    }

    // Services become capabilities so the matching engine can use them. Any
    // that are not already in the catalogue get added, because a capability
    // the operator uses but the system does not know is invisible to matching.
    for (const service of row.services) {
      const name = service.toLowerCase();
      const slug = slugifyCapability(service);
      let capability = capabilityByName.get(name) ?? capabilityByKey.get(slug);
      let via: CapabilityMapping['via'] = 'exact';

      if (!capability) {
        // The catalogue may already hold this under a different wording —
        // "Commercial janitorial" for "janitorial". Reusing it keeps matching
        // working instead of splitting one trade across two rows.
        const inferred = await inferRequiredCapabilities(params.orgId, service);
        capability = existingCapabilities.find(
          (c) => inferred.includes(c.name.toLowerCase()) && inferenceIsCloseEnough(service, c.name),
        );
        if (capability) via = 'inferred';
      }

      if (!capability) {
        capability = await prisma.capability.create({
          data: {
            orgId: params.orgId,
            key: slug,
            name: service,
            category: params.side === 'BUYER' ? 'buyer_need' : 'imported',
          },
        });
        existingCapabilities.push(capability);
        capabilityByKey.set(slug, capability);
        result.capabilitiesCreated += 1;
        via = 'created';
      }
      // Cache under the wording this file used, so later rows skip the lookup.
      capabilityByName.set(name, capability);

      // Every service in the file gets reported against what it resolved to.
      // Matching runs on these, so a wrong resolution is invisible until the
      // board produces nothing — the operator has to be able to see it.
      const mappingKey = `${name}→${capability.id}`;
      if (!mappingSeen.has(mappingKey)) {
        mappingSeen.add(mappingKey);
        result.capabilityMappings.push({ service, capability: capability.name, via });
      }
      await prisma.companyCapability.upsert({
        where: { companyId_capabilityId: { companyId: company.id, capabilityId: capability.id } },
        create: {
          companyId: company.id,
          capabilityId: capability.id,
          // Stated by the operator, not verified with the company itself.
          status: 'CLAIMED',
          confidence: 0.7,
          notes: 'Imported from CSV',
        },
        update: {},
      });
    }

    if (row.contact) {
      const phone = row.contact.phone;
      const duplicate = await prisma.contact.findFirst({
        where: {
          orgId: params.orgId,
          companyId: company.id,
          firstName: { equals: row.contact.firstName, mode: 'insensitive' },
          lastName: { equals: row.contact.lastName, mode: 'insensitive' },
        },
      });

      if (!duplicate) {
        await prisma.contact.create({
          data: {
            orgId: params.orgId,
            companyId: company.id,
            firstName: row.contact.firstName,
            lastName: row.contact.lastName,
            title: row.contact.title,
            email: row.contact.email,
            phone,
            mobile: row.contact.isMobile ? phone : null,
            hasMobile: row.contact.isMobile,
            // Importing a list is not consent to text it. Calling a business
            // number is generally fine; texting one is not.
            consentToSms: false,
            decisionAuthority: 'unknown',
          },
        });
        result.contactsCreated += 1;

      }
    }

    if (row.problems.length > 0) {
      result.warnings.push(`Row ${row.rowNumber} (${row.companyName}): ${row.problems.join('; ')}`);
    }
  }

  // Providers with no capabilities cannot be matched to anything, which is the
  // most common reason an import looks like it did nothing.
  if (params.side === 'PROVIDER') {
    const withoutCapability = preview.rows.filter((r) => r.companyName && r.services.length === 0).length;
    if (withoutCapability > 0) {
      result.warnings.push(
        `${withoutCapability} provider(s) imported with no services listed. They will not appear as candidates until a services column is provided or capabilities are added by hand — matching has nothing to match on.`,
      );
    }
  }

  // Matching joins buyers to providers through shared capabilities. A buyer
  // need worded differently from every provider's service produces no
  // candidates at all, and nothing in the interface says why.
  if (params.side === 'BUYER' && result.capabilityMappings.length > 0) {
    const capabilityIds = result.capabilityMappings.map((m) => m.capability);
    const covered = await prisma.companyCapability.findMany({
      where: {
        capability: { orgId: params.orgId, name: { in: capabilityIds } },
        company: { orgId: params.orgId, companyRole: { in: SUPPLY_SIDE_ROLES } },
      },
      select: { capability: { select: { name: true } } },
    });
    const coveredNames = new Set(covered.map((c) => c.capability.name));
    const uncovered = [...new Set(capabilityIds.filter((name) => !coveredNames.has(name)))];
    if (uncovered.length > 0) {
      result.warnings.push(
        `No provider currently offers: ${uncovered.join(', ')}. Buyer demand for these cannot be matched or fulfilled until providers with those capabilities are imported — the system will hold the opportunities rather than promote them.`,
      );
    }
  }

  if (result.capabilitiesCreated > 0) {
    result.warnings.push(
      `${result.capabilitiesCreated} new capability(ies) were added to the catalogue from this file. If any duplicate an existing one under a different name, merge them in Administration — matching treats them as unrelated.`,
    );
  }

  await recordDecision({
    orgId: params.orgId,
    process: 'import.csv',
    decision: `Imported ${result.companiesCreated} new and ${result.companiesUpdated} existing ${params.side.toLowerCase()} companies`,
    reason: `Operator-supplied CSV, ${preview.totalRows} row(s), side declared as ${params.side}.`,
    inputs: { totalRows: preview.totalRows, side: params.side, recognisedHeaders: preview.recognisedHeaders },
    outputs: result as unknown as Record<string, unknown>,
    confidence: 0.9,
    rulesApplied: ['first_party_data', 'explicit_side_declaration'],
    modelName: 'deterministic',
    promptVersion: 'import@1',
  });

  await audit({
    orgId: params.orgId,
    userId: params.userId,
    action: 'import.csv',
    entityType: 'Company',
    metadata: { side: params.side, ...result },
  });

  return result;
}

export type ClearResult = Record<string, number>;

/**
 * Removes demonstration content while keeping the configuration.
 *
 * Users, roles, industries, capabilities, territories, scripts, data sources,
 * deal lanes and operating rules survive — those took setup and are not fake.
 * Everything transactional goes, so real imports are not mixed in with seeded
 * companies that do not exist.
 */
export async function clearBusinessData(orgId: string, userId: string): Promise<ClearResult> {
  const counts: ClearResult = {};

  // Ordered so that rows are removed before whatever they point at, for the
  // relations that are not set to cascade.
  counts.messages = (await prisma.message.deleteMany({ where: { orgId } })).count;
  counts.extractedFacts = (await prisma.extractedFact.deleteMany({ where: { orgId } })).count;
  counts.commitments = (await prisma.commitment.deleteMany({ where: { orgId } })).count;
  counts.objections = (await prisma.objection.deleteMany({ where: { orgId } })).count;
  counts.calls = (await prisma.call.deleteMany({ where: { orgId } })).count;
  counts.callAssignments = (await prisma.callAssignment.deleteMany({ where: { orgId } })).count;
  counts.tasks = (await prisma.task.deleteMany({ where: { orgId } })).count;
  counts.approvals = (await prisma.approval.deleteMany({ where: { orgId } })).count;
  counts.escalations = (await prisma.escalation.deleteMany({ where: { orgId } })).count;
  counts.documents = (await prisma.document.deleteMany({ where: { orgId } })).count;
  counts.opportunities = (await prisma.opportunity.deleteMany({ where: { orgId } })).count;
  counts.buyerNeeds = (await prisma.buyerNeed.deleteMany({ where: { orgId } })).count;
  counts.supplierAvailability = (await prisma.supplierAvailability.deleteMany({ where: { orgId } })).count;
  counts.subcontractorCapacity = (await prisma.subcontractorCapacity.deleteMany({ where: { orgId } })).count;
  counts.contractAwards = (await prisma.contractAward.deleteMany({ where: { orgId } })).count;
  counts.projects = (await prisma.project.deleteMany({ where: { orgId } })).count;
  counts.signals = (await prisma.discoverySignal.deleteMany({ where: { orgId } })).count;
  counts.sourceEvidence = (await prisma.sourceEvidence.deleteMany({ where: { orgId } })).count;
  counts.relationships = (await prisma.relationship.deleteMany({ where: { orgId } })).count;
  counts.contacts = (await prisma.contact.deleteMany({ where: { orgId } })).count;
  counts.companies = (await prisma.company.deleteMany({ where: { orgId } })).count;
  counts.notifications = (await prisma.notification.deleteMany({ where: { orgId } })).count;
  counts.dailyPlans = (await prisma.dailyPlan.deleteMany({ where: { orgId } })).count;
  counts.jobs = (await prisma.job.deleteMany({ where: { orgId } })).count;

  // Data sources, markets and business paths survive — they are configuration,
  // not content. Only the run history goes, because it described data that no
  // longer exists.
  await prisma.dataSource.updateMany({
    where: { orgId },
    data: { lastRunAt: null, lastRunStatus: null, lastRecordCount: null, lastErrorAt: null, consecutiveFailures: 0 },
  });

  await audit({
    orgId,
    userId,
    action: 'data.cleared',
    entityType: 'Organization',
    entityId: orgId,
    metadata: counts,
  });

  return counts;
}

export { normalizePhone };
