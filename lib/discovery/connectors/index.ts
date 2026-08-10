import type { SignalCategory, SourceType } from '@prisma/client';
import { registerConnector, type ConnectorContext, type DiscoveryConnector, type RawRecord } from '../connector';
import { ALL_FIXTURES } from './fixtures';
import { SocrataConnector } from './socrata';
import { GooglePlacesConnector } from './googlePlaces';
import { SamGovConnector } from './samGov';
import { NppesConnector } from './nppes';
import { UsaSpendingConnector } from './usaSpending';

/**
 * Fixture-backed connector. Each instance stands in for one real source class.
 *
 * `isLive` is false on every one of these, and that flag is carried through to
 * the DataSource row and shown in the interface. It exists because a run that
 * re-reads a sample file reports exactly the same "37 signals discovered" as a
 * run that queried a municipal permit portal, and the difference is the whole
 * value of the system.
 */
class FixtureConnector implements DiscoveryConnector {
  readonly isLive = false;

  constructor(
    readonly key: string,
    readonly sourceType: SourceType,
    readonly defaultCategory: SignalCategory,
    readonly accessBasis: string,
    private readonly fixtureKey: string,
  ) {}

  async fetch(context: ConnectorContext): Promise<RawRecord[]> {
    const records = ALL_FIXTURES[this.fixtureKey] ?? [];
    const filtered = context.since
      ? records.filter((r) => !r.observedAt || r.observedAt >= context.since!)
      : records;
    return filtered.slice(0, context.maxRecords);
  }
}

/**
 * CSV import connector. Unlike the fixture connectors this one is real: it
 * parses first-party data a user uploaded or pasted, which is the most common
 * way an operation seeds its graph on day one.
 */
export class CsvImportConnector implements DiscoveryConnector {
  readonly key = 'csv_import';
  readonly sourceType: SourceType = 'USER_UPLOAD';
  readonly defaultCategory: SignalCategory = 'GENERAL';
  readonly isLive = false;
  readonly accessBasis = 'First-party data supplied by the operator.';

  async fetch(context: ConnectorContext): Promise<RawRecord[]> {
    const csv = String(context.config.csv ?? '').trim();
    if (!csv) return [];
    return parseCsvRecords(csv).slice(0, context.maxRecords);
  }
}

/** Minimal RFC4180-ish parser: quoted fields, embedded commas and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

export function parseCsvRecords(csv: string): RawRecord[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));

  return rows.slice(1).map((cells, index) => {
    const row: Record<string, string> = {};
    headers.forEach((header, i) => {
      row[header] = (cells[i] ?? '').trim();
    });
    const companyName = row.company_name || row.company || row.legal_name || `Imported row ${index + 1}`;
    return {
      externalId: row.external_id || `csv-${index}-${companyName}`,
      title: row.title || companyName,
      excerpt:
        row.notes ||
        row.description ||
        row.excerpt ||
        `Imported record for ${companyName}. ${row.services ? `Services: ${row.services}.` : ''} ${
          row.needs ? `Stated needs: ${row.needs}.` : ''
        }`.trim(),
      sourceUrl: row.source_url || row.website || undefined,
      location: [row.city, row.state].filter(Boolean).join(', ') || undefined,
      state: row.state || undefined,
      companyName,
      companyWebsite: row.website || undefined,
      payload: row,
    };
  });
}

export const BUILT_IN_CONNECTORS: DiscoveryConnector[] = [
  new FixtureConnector(
    'contract_awards',
    'CONTRACT_AWARD',
    'SUBCONTRACTING',
    'Public procurement award notices published by the awarding agency for open inspection.',
    'contract_awards',
  ),
  new FixtureConnector(
    'building_permits',
    'BUILDING_PERMIT',
    'SUBCONTRACTING',
    'Municipal building permit records published as public records.',
    'building_permits',
  ),
  new FixtureConnector(
    'job_postings',
    'JOB_POSTING',
    'SUBCONTRACTING',
    'Publicly listed job postings retrieved within the posting site\'s published terms and rate limits.',
    'job_postings',
  ),
  new FixtureConnector(
    'bid_rfq',
    'BID_RFP_PORTAL',
    'BROKERAGE',
    'Open solicitations published for public response. No authenticated portal is accessed.',
    'bid_rfq',
  ),
  new FixtureConnector(
    'supplier_directory',
    'SUPPLIER_DIRECTORY',
    'DISTRIBUTION',
    'Business directory listings published by the listing companies themselves.',
    'supplier_directory',
  ),
  new FixtureConnector(
    'press_releases',
    'PRESS_RELEASE',
    'GENERAL',
    'Company press releases published for public distribution.',
    'press_releases',
  ),
  new CsvImportConnector(),

  // Live sources. These reach real external APIs and are the only connectors
  // that produce leads a person can act on.
  // Nationwide, free, keyless federal sources. These are the foundation: they
  // work in every state on day one without a credential or a per-city dataset.
  new NppesConnector(),
  new UsaSpendingConnector(),
  // Nationwide with a credential.
  new GooglePlacesConnector(),
  new SamGovConnector(),
  // Jurisdiction-specific, configured per market. Supplements the above; it is
  // deliberately not the foundation, because it cannot cover the country.
  new SocrataConnector(),
];

export { SocrataConnector, GooglePlacesConnector, SamGovConnector, NppesConnector, UsaSpendingConnector };

let registered = false;

export function ensureConnectorsRegistered(): void {
  if (registered) return;
  for (const connector of BUILT_IN_CONNECTORS) registerConnector(connector);
  registered = true;
}
