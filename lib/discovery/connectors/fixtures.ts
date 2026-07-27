import type { RawRecord } from '../connector';

/**
 * Fixture corpus backing the mock connectors.
 *
 * These stand in for records that a live deployment would pull from
 * procurement portals, permit systems, job boards and supplier directories.
 * They are written to look like real source records — the same fields, the
 * same ambiguity — so the discovery, classification and qualification path is
 * exercised honestly rather than against pre-solved input.
 */

export const CONTRACT_AWARD_RECORDS: RawRecord[] = [
  {
    externalId: 'award-2026-0431',
    subjectRole: 'PRIME_CONTRACTOR',
    describesSubject: false,
    title: 'Award: Interior renovation, Municipal Services Building — Meridian Construction Group',
    excerpt:
      'The City of Fairview has awarded a $2,850,000 contract for interior renovation of the Municipal Services Building to Meridian Construction Group. Scope of work covers demolition, electrical, mechanical, drywall, flooring, and final construction cleaning across three floors. Performance period 2026-09-01 through 2027-04-30. The solicitation includes a 22% small business subcontracting goal. Prime contractor is expected to subcontract multi-trade packages.',
    sourceUrl: 'https://procurement.fairview.example.gov/awards/2026-0431',
    location: 'Fairview, OH',
    state: 'OH',
    companyName: 'Meridian Construction Group',
    companyWebsite: 'https://meridiancg.example.com',
    payload: {
      agency: 'City of Fairview',
      solicitationNumber: 'RFP-2026-0431',
      value: 2850000,
      awardDate: '2026-07-14',
      performanceStart: '2026-09-01',
      performanceEnd: '2027-04-30',
      subcontractingGoalPct: 22,
      trades: ['electrical', 'mechanical', 'drywall', 'flooring', 'construction cleaning'],
    },
  },
  {
    externalId: 'award-2026-0512',
    subjectRole: 'PRIME_CONTRACTOR',
    describesSubject: false,
    title: 'Award: Regional highway site work package — Grantham Sitework LLC',
    excerpt:
      'State DOT awarded a $6,100,000 site work and grading package to Grantham Sitework LLC for the Route 42 corridor improvement. Scope requires approximately 18,000 tons of crushed aggregate base delivered to two staging yards beginning October 2026. Contractor is seeking quotes from regional aggregate suppliers; delivered price and lead time are the deciding factors.',
    sourceUrl: 'https://bids.state.example.gov/award/2026-0512',
    location: 'Rockdale County, OH',
    state: 'OH',
    companyName: 'Grantham Sitework LLC',
    companyWebsite: 'https://granthamsitework.example.com',
    payload: {
      agency: 'State Department of Transportation',
      solicitationNumber: 'DOT-42-2026',
      value: 6100000,
      awardDate: '2026-07-02',
      performanceStart: '2026-10-01',
      performanceEnd: '2027-08-31',
      materials: [{ name: 'crushed aggregate base', quantity: 18000, unit: 'ton' }],
    },
  },
  {
    externalId: 'award-2026-0498',
    subjectRole: 'PRIME_CONTRACTOR',
    describesSubject: false,
    title: 'Award: Managed IT field services, multi-site — Northline Managed Services',
    excerpt:
      'Northline Managed Services was awarded a three-year managed services contract covering 42 branch locations across four states. Northline has stated it will outsource onsite break-fix and smart-hands work to local field service partners in territories where it has no technicians.',
    sourceUrl: 'https://procurement.example.gov/awards/2026-0498',
    location: 'Columbus, OH',
    state: 'OH',
    companyName: 'Northline Managed Services',
    companyWebsite: 'https://northlinems.example.com',
    payload: {
      agency: 'Regional Credit Union Alliance',
      value: 4400000,
      awardDate: '2026-06-20',
      trades: ['it field service', 'smart hands', 'break-fix'],
    },
  },
];

export const PERMIT_RECORDS: RawRecord[] = [
  {
    externalId: 'permit-CB-2026-88214',
    subjectRole: 'BUYER',
    describesSubject: false,
    title: 'Commercial build-out permit — 4400 Waverly Industrial Pkwy',
    excerpt:
      'Commercial tenant build-out permit issued for a 62,000 sq ft warehouse conversion. Valuation $1,240,000. Applicant Harborline Logistics. Work includes electrical service upgrade, dock equipment installation, and racking. Certificate of occupancy targeted for November 2026.',
    sourceUrl: 'https://permits.fairview.example.gov/CB-2026-88214',
    location: 'Fairview, OH',
    state: 'OH',
    companyName: 'Harborline Logistics',
    payload: { valuation: 1240000, issuedAt: '2026-07-08', trades: ['electrical', 'dock equipment', 'racking'] },
  },
  {
    externalId: 'permit-CB-2026-88377',
    subjectRole: 'BUYER',
    describesSubject: false,
    title: 'New location permit — Brightpath Family Dental, third office',
    excerpt:
      'Interior fit-out permit for a third dental office location. Applicant Brightpath Family Dental. Valuation $410,000. New facility openings historically create recurring janitorial and facility supply needs.',
    sourceUrl: 'https://permits.fairview.example.gov/CB-2026-88377',
    location: 'Westbrook, OH',
    state: 'OH',
    companyName: 'Brightpath Family Dental',
    payload: { valuation: 410000, issuedAt: '2026-07-19' },
  },
];

export const JOB_POSTING_RECORDS: RawRecord[] = [
  {
    externalId: 'job-88291',
    subjectRole: 'PRIME_CONTRACTOR',
    describesSubject: false,
    title: 'Meridian Construction Group — hiring 6 project superintendents and 2 estimators',
    excerpt:
      'Meridian Construction Group posted 8 openings in the last 30 days including project superintendents, estimators, and a subcontractor coordinator. Posting text notes "rapid backlog growth" and "expanding into the Westbrook and Rockdale markets." Heavy hiring alongside a new award frequently indicates capacity constraints and subcontracting demand.',
    sourceUrl: 'https://jobs.example.com/company/meridiancg',
    location: 'Fairview, OH',
    state: 'OH',
    companyName: 'Meridian Construction Group',
    payload: { postingCount: 8, windowDays: 30, roles: ['superintendent', 'estimator', 'subcontractor coordinator'] },
  },
  {
    externalId: 'job-88455',
    subjectRole: 'BUYER',
    describesSubject: false,
    title: 'Sterling Property Partners — facilities coordinator, multi-site portfolio',
    excerpt:
      'Sterling Property Partners is hiring a facilities coordinator to manage vendor performance across 9 commercial office properties. Posting states the role will "consolidate vendors and standardize janitorial supply purchasing across the portfolio."',
    sourceUrl: 'https://jobs.example.com/company/sterlingpp',
    location: 'Columbus, OH',
    state: 'OH',
    companyName: 'Sterling Property Partners',
    payload: { locationCount: 9, roles: ['facilities coordinator'] },
  },
];

export const BID_RFQ_RECORDS: RawRecord[] = [
  {
    externalId: 'rfq-2026-1180',
    subjectRole: 'BUYER',
    describesSubject: false,
    title: 'RFQ: Recurring janitorial supplies, 9-property office portfolio',
    excerpt:
      'Sterling Property Partners is requesting quotes for recurring janitorial and restroom consumables across 9 office properties. Estimated $14,000 per month. Current supplier has had repeated stockouts on can liners and hand towels, and issued a 9% price increase in March. Buyer wants one accountable vendor, scheduled delivery, and consolidated invoicing.',
    sourceUrl: 'https://bids.example.com/rfq/2026-1180',
    location: 'Columbus, OH',
    state: 'OH',
    companyName: 'Sterling Property Partners',
    companyWebsite: 'https://sterlingpp.example.com',
    payload: {
      monthlySpend: 14000,
      locationCount: 9,
      categories: ['can liners', 'hand towels', 'restroom tissue', 'floor care'],
      incumbentIssues: ['stockouts', 'price increase'],
      dueDate: '2026-08-15',
    },
  },
  {
    externalId: 'rfq-2026-1204',
    subjectRole: 'PRIME_CONTRACTOR',
    describesSubject: false,
    title: 'RFQ: Crushed aggregate base, delivered — Route 42 staging yards',
    excerpt:
      'Grantham Sitework LLC requests delivered pricing on 18,000 tons of crushed aggregate base, #57 and #304 gradations, to two staging yards in Rockdale County. First deliveries required 2026-10-01. Requesting multiple quotes; freight is the constraint since the nearest quarry is 41 miles out.',
    sourceUrl: 'https://bids.example.com/rfq/2026-1204',
    location: 'Rockdale County, OH',
    state: 'OH',
    companyName: 'Grantham Sitework LLC',
    payload: {
      quantity: 18000,
      unit: 'ton',
      specs: ['#57', '#304'],
      neededBy: '2026-10-01',
      constraint: 'freight',
    },
  },
];

export const SUPPLIER_DIRECTORY_RECORDS: RawRecord[] = [
  {
    externalId: 'dir-clean-4401',
    subjectRole: 'SUBCONTRACTOR',
    describesSubject: true,
    title: 'Apex Commercial Cleaning — commercial janitorial, 3 counties',
    excerpt:
      'Apex Commercial Cleaning provides commercial janitorial and post-construction cleaning services across Fairview, Westbrook and Rockdale counties. Company profile lists night-shift crews, general liability coverage, and bonded staff. Operates multiple crews.',
    sourceUrl: 'https://directory.example.com/apex-commercial-cleaning',
    location: 'Fairview, OH',
    state: 'OH',
    companyName: 'Apex Commercial Cleaning',
    companyWebsite: 'https://apexclean.example.com',
    payload: { services: ['commercial janitorial', 'post-construction cleaning'], territories: ['Fairview', 'Westbrook', 'Rockdale'] },
  },
  {
    externalId: 'dir-elec-2210',
    subjectRole: 'SUBCONTRACTOR',
    describesSubject: true,
    title: 'Voltline Electric — licensed commercial electrical contractor',
    excerpt:
      'Voltline Electric is a licensed commercial electrical contractor serving central Ohio. Directory listing shows master electrician license OH-EL-44821, commercial tenant improvement experience, and available crews for subcontract work.',
    sourceUrl: 'https://directory.example.com/voltline-electric',
    location: 'Columbus, OH',
    state: 'OH',
    companyName: 'Voltline Electric',
    companyWebsite: 'https://voltline.example.com',
    payload: { services: ['commercial electrical'], licenses: ['OH-EL-44821'] },
  },
  {
    externalId: 'dir-agg-7781',
    subjectRole: 'MANUFACTURER',
    describesSubject: true,
    title: 'Rockdale Aggregates — quarry and crushed stone producer',
    excerpt:
      'Rockdale Aggregates operates a quarry producing crushed limestone in #57, #304 and #8 gradations. Directory listing notes bulk truckload availability and that the operation has surplus stockpile capacity for the current season.',
    sourceUrl: 'https://directory.example.com/rockdale-aggregates',
    location: 'Rockdale County, OH',
    state: 'OH',
    companyName: 'Rockdale Aggregates',
    companyWebsite: 'https://rockdaleagg.example.com',
    payload: { products: ['#57 crushed limestone', '#304 base', '#8 chips'], note: 'surplus stockpile capacity' },
  },
  {
    externalId: 'dir-jan-9912',
    subjectRole: 'DISTRIBUTOR',
    describesSubject: true,
    title: 'Continental Facility Supply — janitorial and facility products wholesaler',
    excerpt:
      'Continental Facility Supply is a regional wholesale distributor of janitorial paper, can liners, floor care chemicals and safety supplies. Listing indicates stocking distribution from a Columbus warehouse with next-day delivery in central Ohio.',
    sourceUrl: 'https://directory.example.com/continental-facility-supply',
    location: 'Columbus, OH',
    state: 'OH',
    companyName: 'Continental Facility Supply',
    companyWebsite: 'https://continentalfs.example.com',
    payload: { products: ['can liners', 'hand towels', 'restroom tissue', 'floor care chemicals'] },
  },
  {
    externalId: 'dir-clean-4488',
    subjectRole: 'SUBCONTRACTOR',
    describesSubject: true,
    title: 'Bluegrass Building Services — janitorial contractor, regional',
    excerpt:
      'Bluegrass Building Services performs commercial janitorial across four counties with day porter and night crew coverage. Listing notes the company is actively seeking additional recurring contracts.',
    sourceUrl: 'https://directory.example.com/bluegrass-building-services',
    location: 'Westbrook, OH',
    state: 'OH',
    companyName: 'Bluegrass Building Services',
    companyWebsite: 'https://bluegrassbs.example.com',
    payload: { services: ['commercial janitorial', 'day porter'], territories: ['Westbrook', 'Fairview', 'Rockdale', 'Marion'] },
  },
  {
    externalId: 'dir-it-3310',
    subjectRole: 'SUBCONTRACTOR',
    describesSubject: true,
    title: 'Keystone Field Tech — onsite IT field services',
    excerpt:
      'Keystone Field Tech provides onsite IT break-fix, smart hands and structured cabling across central and southern Ohio. Listing indicates the firm regularly works as a subcontractor to national managed service providers.',
    sourceUrl: 'https://directory.example.com/keystone-field-tech',
    location: 'Columbus, OH',
    state: 'OH',
    companyName: 'Keystone Field Tech',
    companyWebsite: 'https://keystonefieldtech.example.com',
    payload: { services: ['it field service', 'smart hands', 'structured cabling'] },
  },
];

export const PRESS_RELEASE_RECORDS: RawRecord[] = [
  {
    externalId: 'pr-2026-0710',
    subjectRole: 'BUYER',
    describesSubject: false,
    title: 'Harborline Logistics announces regional distribution expansion',
    excerpt:
      'Harborline Logistics announced it will open a 62,000 sq ft cross-dock facility in Fairview by November 2026, adding roughly 40 staff. The company said last-mile delivery in outlying counties will be handled through local fulfillment partners rather than in-house fleet.',
    sourceUrl: 'https://news.example.com/harborline-expansion',
    location: 'Fairview, OH',
    state: 'OH',
    companyName: 'Harborline Logistics',
    companyWebsite: 'https://harborline.example.com',
    payload: { facilitySqFt: 62000, opening: '2026-11-01' },
  },
];

export const ALL_FIXTURES: Record<string, RawRecord[]> = {
  contract_awards: CONTRACT_AWARD_RECORDS,
  building_permits: PERMIT_RECORDS,
  job_postings: JOB_POSTING_RECORDS,
  bid_rfq: BID_RFQ_RECORDS,
  supplier_directory: SUPPLIER_DIRECTORY_RECORDS,
  press_releases: PRESS_RELEASE_RECORDS,
};
