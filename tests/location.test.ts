import { describe, expect, it } from 'vitest';
import { parseAddress, recordLocation } from '@/lib/discovery/location';
import { toPlaceRecord } from '@/lib/discovery/connectors/googlePlaces';
import { toNppesRecord } from '@/lib/discovery/connectors/nppes';

/**
 * A search scope is not a fact about a business.
 *
 * Four connectors independently wrote `... || marketName`, so whenever a source
 * omitted the address the record inherited the metro anchor the query was
 * centred on. A run against twenty-five businesses in twenty states produced
 * twenty-two accounts all displaying "Milwaukee, WI" — every one of them
 * wrong, and every one of them displayed with the same confidence as a real
 * address.
 */

const QUERY = {
  query: 'commercial cleaning company',
  leadRole: 'PROVIDER',
  companyRole: 'SUBCONTRACTOR',
  category: 'BROKERAGE',
  segment: 'COMMERCIAL',
  service: 'Commercial cleaning',
  why: 'Local provider.',
} as const;

describe('a market name can never become a record location', () => {
  it('leaves the location absent when Places returns no address at all', () => {
    const record = toPlaceRecord(
      { id: 'ChIJabc', displayName: { text: 'Apex Cleaning' }, businessStatus: 'OPERATIONAL' },
      { ...QUERY },
      'Milwaukee, WI',
    );
    expect(record).not.toBeNull();
    expect(record!.location).toBeUndefined();
    // The anchor must not leak into the prose either — the excerpt was
    // asserting "Listed under ... in Milwaukee" for a business it had no city for.
    expect(record!.excerpt).not.toContain('Milwaukee');
  });

  it('recovers the city, state and street line from a formatted address', () => {
    const record = toPlaceRecord(
      {
        id: 'ChIJabc',
        displayName: { text: 'Apex Cleaning' },
        formattedAddress: '1200 Main St Ste 400, Dallas, TX 75201, USA',
        nationalPhoneNumber: '(214) 555-0142',
        businessStatus: 'OPERATIONAL',
      },
      { ...QUERY },
      'Milwaukee, WI',
    );
    expect(record!.location).toBe('Dallas, TX');
    expect(record!.state).toBe('TX');
    // The street line is a deduplication key, and it was being discarded.
    expect(record!.addressLine1).toBe('1200 Main St Ste 400');
    expect(record!.postalCode).toBe('75201');
  });

  it('prefers Google’s structured components over the parsed string', () => {
    const record = toPlaceRecord(
      {
        id: 'ChIJabc',
        displayName: { text: 'Apex Cleaning' },
        formattedAddress: 'Somewhere odd, XX',
        addressComponents: [
          { longText: 'Austin', shortText: 'Austin', types: ['locality'] },
          { longText: 'Texas', shortText: 'TX', types: ['administrative_area_level_1'] },
        ],
        businessStatus: 'OPERATIONAL',
      },
      { ...QUERY },
      'Milwaukee, WI',
    );
    expect(record!.location).toBe('Austin, TX');
  });

  it('gives an NPPES facility its own city rather than the queried partition', () => {
    const record = toNppesRecord(
      {
        number: '1234567890',
        basic: { organization_name: 'Copper Ridge Clinic', status: 'A' },
        addresses: [
          {
            address_purpose: 'LOCATION',
            address_1: '77 E 200 S',
            city: 'Salt Lake City',
            state: 'UT',
            postal_code: '841110000',
            telephone_number: '801-555-0104',
          },
        ],
        taxonomies: [{ desc: 'Clinic/Center', primary: true }],
      } as never,
      'Milwaukee, WI',
    );
    expect(record!.location).toBe('Salt Lake City, UT');
    expect(record!.addressLine1).toBe('77 E 200 S');
    expect(record!.postalCode).toBe('84111');
  });
});

describe('address parsing rejects fragments rather than storing them', () => {
  it('handles the common US shapes', () => {
    expect(parseAddress('1200 Main St, Dallas, TX 75201, USA')).toEqual({
      line1: '1200 Main St', city: 'Dallas', state: 'TX', postalCode: '75201',
    });
    expect(parseAddress('Dallas, TX')).toEqual({
      line1: null, city: 'Dallas', state: 'TX', postalCode: null,
    });
    expect(parseAddress('4200 Ross Ave, Suite 12, Dallas, TX')).toEqual({
      line1: '4200 Ross Ave, Suite 12', city: 'Dallas', state: 'TX', postalCode: null,
    });
  });

  it('returns nothing usable rather than a house number as a city', () => {
    // "633" reached the interface as a lead's location once already.
    expect(parseAddress('633').city).toBeNull();
    expect(parseAddress('').city).toBeNull();
    expect(parseAddress(null).city).toBeNull();
    expect(parseAddress('Ste 400, 75201').city).toBeNull();
  });

  it('drops an implausible state code instead of trusting the position', () => {
    expect(parseAddress('1 Main St, Dallas, ZZ 75201').state).toBeNull();
  });

  it('omits the location string entirely when neither part survives validation', () => {
    expect(recordLocation('633', '75201')).toBeUndefined();
    expect(recordLocation(null, null)).toBeUndefined();
    expect(recordLocation('Dallas', null)).toBe('Dallas');
    expect(recordLocation(null, 'tx')).toBe('TX');
  });
});
