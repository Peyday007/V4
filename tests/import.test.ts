import { describe, expect, it } from 'vitest';
import { inferenceIsCloseEnough, previewCsv, slugifyCapability } from '@/lib/import';

/**
 * The importer is the first thing a real deployment touches, and every failure
 * here is silent: a column that was not recognised looks exactly like a column
 * that was empty. These tests pin the recognition rules.
 */

describe('previewCsv — column recognition', () => {
  it('accepts the obvious header names', () => {
    const preview = previewCsv('company_name,city,state\nBright Clean,Dallas,tx\n');
    expect(preview.usableRows).toBe(1);
    expect(preview.rows[0].companyName).toBe('Bright Clean');
    expect(preview.rows[0].city).toBe('Dallas');
    expect(preview.rows[0].state).toBe('TX');
  });

  it('accepts the aliases real exports actually use', () => {
    const preview = previewCsv('Business Name,Web,Town,Province\nNorth Texas Facility Care,ntfc.example,Plano,TX\n');
    expect(preview.usableRows).toBe(1);
    expect(preview.rows[0].companyName).toBe('North Texas Facility Care');
    expect(preview.rows[0].website).toBe('ntfc.example');
    expect(preview.rows[0].city).toBe('Plano');
  });

  it('normalises headers with spaces, dots and capitals', () => {
    const preview = previewCsv('Company Name,First.Name,LAST NAME\nAcme,Dana,Reyes\n');
    expect(preview.rows[0].companyName).toBe('Acme');
    expect(preview.rows[0].contact?.firstName).toBe('Dana');
    expect(preview.rows[0].contact?.lastName).toBe('Reyes');
  });

  it('reports columns it did not understand rather than dropping them silently', () => {
    const preview = previewCsv('company_name,favourite_colour\nAcme,blue\n');
    expect(preview.unmappedHeaders).toContain('favourite_colour');
  });

  it('refuses a file with no company-name column', () => {
    const preview = previewCsv('city,state\nDallas,TX\n');
    expect(preview.problems.join(' ')).toMatch(/company-name column/i);
  });

  it('distinguishes an empty file from a headers-only file', () => {
    expect(previewCsv('').problems.join(' ')).toMatch(/empty/i);
    expect(previewCsv('company_name,city\n').problems.join(' ')).toMatch(/header row/i);
  });
});

describe('previewCsv — mobile detection', () => {
  it('treats a mobile column as textable', () => {
    const preview = previewCsv('company_name,contact_name,mobile\nAcme,Dana Reyes,214-555-0142\n');
    expect(preview.rows[0].contact?.isMobile).toBe(true);
  });

  it('treats a plain phone column as not textable', () => {
    const preview = previewCsv('company_name,contact_name,phone\nAcme,Dana Reyes,214-555-0142\n');
    expect(preview.rows[0].contact?.phone).toBe('214-555-0142');
    expect(preview.rows[0].contact?.isMobile).toBe(false);
  });

  it('prefers the mobile column when both are present, in either order', () => {
    // Texting the landline is billed and never arrives, so the mobile has to
    // win regardless of which column the export happened to put first.
    const cellFirst = previewCsv('company_name,contact_name,cell,phone\nAcme,Dana Reyes,214-555-0142,214-555-0100\n');
    expect(cellFirst.rows[0].contact?.phone).toBe('214-555-0142');
    expect(cellFirst.rows[0].contact?.isMobile).toBe(true);

    const phoneFirst = previewCsv('company_name,contact_name,phone,mobile\nAcme,Dana Reyes,214-555-0100,214-555-0142\n');
    expect(phoneFirst.rows[0].contact?.phone).toBe('214-555-0142');
    expect(phoneFirst.rows[0].contact?.isMobile).toBe(true);
  });
});

describe('previewCsv — contacts', () => {
  it('splits a single full-name column', () => {
    const preview = previewCsv('company_name,contact_name\nAcme,Dana Marie Reyes\n');
    expect(preview.rows[0].contact?.firstName).toBe('Dana');
    expect(preview.rows[0].contact?.lastName).toBe('Marie Reyes');
  });

  it('records no contact when the row has only a company', () => {
    const preview = previewCsv('company_name,city\nAcme,Dallas\n');
    expect(preview.rows[0].contact).toBeNull();
    expect(preview.withContacts).toBe(0);
  });

  it('flags a contact nobody can reach', () => {
    const preview = previewCsv('company_name,contact_name\nAcme,Dana Reyes\n');
    expect(preview.rows[0].problems.join(' ')).toMatch(/neither phone nor email/i);
  });
});

describe('previewCsv — row problems', () => {
  it('flags and excludes a row with no company name', () => {
    const preview = previewCsv('company_name,city\nAcme,Dallas\n,Plano\n');
    expect(preview.totalRows).toBe(2);
    expect(preview.usableRows).toBe(1);
    expect(preview.rows[1].problems.join(' ')).toMatch(/skipped/i);
  });

  it('flags duplicates case-insensitively without dropping them', () => {
    const preview = previewCsv('company_name\nAcme\nACME\n');
    expect(preview.usableRows).toBe(2);
    expect(preview.rows[1].problems.join(' ')).toMatch(/duplicate/i);
    expect(preview.rows[0].problems).toHaveLength(0);
  });
});

describe('previewCsv — list columns', () => {
  it('splits services on the separators people actually type', () => {
    const preview = previewCsv('company_name,services\nAcme,"janitorial; floor care, window cleaning|pressure washing"\n');
    expect(preview.rows[0].services).toEqual(['janitorial', 'floor care', 'window cleaning', 'pressure washing']);
  });

  it('leaves services empty rather than inventing one', () => {
    const preview = previewCsv('company_name,services\nAcme,\n');
    expect(preview.rows[0].services).toEqual([]);
  });
});

describe('slugifyCapability', () => {
  it('produces a stable key from a service name', () => {
    expect(slugifyCapability('Floor Care')).toBe('floor_care');
    expect(slugifyCapability('  HVAC / Refrigeration  ')).toBe('hvac_refrigeration');
  });

  it('never produces an empty or oversized key', () => {
    expect(slugifyCapability('!!!')).toBe('unnamed');
    expect(slugifyCapability('a'.repeat(200)).length).toBe(60);
  });

  it('collides deliberately for wordings that mean the same thing', () => {
    // Which is why importCsv resolves by key as well as name before creating.
    expect(slugifyCapability('Floor-Care')).toBe(slugifyCapability('floor care'));
  });
});

describe('inferenceIsCloseEnough', () => {
  it('accepts a catalogue entry that shares the distinguishing word', () => {
    expect(inferenceIsCloseEnough('janitorial', 'Commercial janitorial')).toBe(true);
    expect(inferenceIsCloseEnough('electrical work', 'Electrical contracting')).toBe(true);
  });

  it('rejects a match that only shares a generic word', () => {
    // The bug this exists for: a loose match filed "window cleaning" under
    // "janitorial supply distribution", which reads as correct and matches
    // nothing anyone wanted.
    expect(inferenceIsCloseEnough('window cleaning', 'Janitorial supply distribution')).toBe(false);
    expect(inferenceIsCloseEnough('office cleaning', 'Commercial janitorial')).toBe(false);
  });

  it('ignores filler words that would otherwise link anything to anything', () => {
    expect(inferenceIsCloseEnough('general services', 'Commercial services')).toBe(false);
    expect(inferenceIsCloseEnough('supply and the of', 'Supply of the general')).toBe(false);
  });

  it('rejects a service with no significant word at all', () => {
    expect(inferenceIsCloseEnough('the', 'Commercial janitorial')).toBe(false);
    expect(inferenceIsCloseEnough('', 'Commercial janitorial')).toBe(false);
  });

  it('is order independent', () => {
    expect(inferenceIsCloseEnough('roofing repair', 'Repair roofing')).toBe(true);
  });
});
