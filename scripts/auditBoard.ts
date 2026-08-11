/**
 * End-to-end audit of the real workflow, against a real database.
 *
 * Unit tests kept passing while the board rendered 47 identical scores, so
 * this drives the production path instead: the real connector, the real
 * ingest, the real identity resolution, the real scorers, and the same
 * `buildBoard` the page calls. The only substitution is the HTTP transport,
 * because this sandbox cannot reach Google's servers.
 *
 * Run with `--stub` to replay a recorded-shape response set, or without it to
 * use whatever credentials are in the environment and hit the live API.
 *
 *   npx tsx scripts/auditBoard.ts --stub
 *   npx tsx scripts/auditBoard.ts            # live, needs GOOGLE_PLACES_API_KEY
 */

import { prisma } from '@/lib/db';
import { ensureDefaultPaths } from '@/lib/paths';
import { ensureStarterMarket, installLiveSources } from '@/lib/discovery/setup';
import { setTransport } from '@/lib/discovery/http';
import { runDiscoveryAcrossMarkets } from '@/lib/discovery/run';
import { reclassify } from '@/lib/discovery/reclassify';
import { buildBoard, missingEvidence, type BoardAccount } from '@/lib/discovery/board';

const STUB = process.argv.includes('--stub');

/**
 * Place records shaped like real Places (New) responses.
 *
 * Deliberately heterogeneous, and deliberately including the two patterns the
 * operator reported: the same business returned by more than one query, and
 * businesses with no phone number at all.
 */
const PLACES: Array<{ name: string; addr: string; city: string; state: string; phone?: string; site?: string }> = [
  { name: 'Lone Star Facility Services', addr: '4200 Ross Ave', city: 'Dallas', state: 'TX', phone: '+1 214-555-0142', site: 'https://lonestarfs.test' },
  { name: 'Bluebonnet Janitorial', addr: '910 S Lamar St', city: 'Austin', state: 'TX', phone: '+1 512-555-0188' },
  { name: 'Gulf Coast Building Care', addr: '3300 Kirby Dr', city: 'Houston', state: 'TX' },
  { name: 'Midwest Sanitation Partners', addr: '55 W Monroe St', city: 'Chicago', state: 'IL', phone: '+1 312-555-0110', site: 'https://mwsanitation.test' },
  { name: 'Prairie Clean Co', addr: '1200 SW Topeka Blvd', city: 'Topeka', state: 'KS', phone: '+1 785-555-0163' },
  { name: 'Cascade Commercial Cleaning', addr: '701 Pike St', city: 'Seattle', state: 'WA', phone: '+1 206-555-0129', site: 'https://cascadecc.test' },
  { name: 'Sunbelt Property Group', addr: '2 N Central Ave', city: 'Phoenix', state: 'AZ', phone: '+1 602-555-0175' },
  { name: 'Rocky Mountain Property Mgmt', addr: '1600 Broadway', city: 'Denver', state: 'CO' },
  { name: 'Peachtree Dental Care', addr: '191 Peachtree St NE', city: 'Atlanta', state: 'GA', phone: '+1 404-555-0197' },
  { name: 'Harbor Family Dentistry', addr: '100 Federal St', city: 'Boston', state: 'MA', phone: '+1 617-555-0154' },
  { name: 'Anytime Fitness', addr: '450 N High St', city: 'Columbus', state: 'OH', phone: '+1 614-555-0121' },
  { name: 'Iron Peak Gym', addr: '88 Union Ave', city: 'Memphis', state: 'TN' },
  { name: 'Cornerstone Office Suites', addr: '1 Market St', city: 'San Francisco', state: 'CA', phone: '+1 415-555-0182', site: 'https://cornerstone.test' },
  { name: 'Riverfront Executive Center', addr: '400 Locust St', city: 'Des Moines', state: 'IA', phone: '+1 515-555-0136' },
  { name: 'Big Sky Supply Wholesale', addr: '2800 Grand Ave', city: 'Billings', state: 'MT', phone: '+1 406-555-0148' },
  { name: 'Delta Paper & Chemical', addr: '600 Poydras St', city: 'New Orleans', state: 'LA', phone: '+1 504-555-0170', site: 'https://deltapaper.test' },
  { name: 'Summit Facility Management', addr: '250 Vesey St', city: 'New York', state: 'NY', phone: '+1 212-555-0113' },
  { name: 'Keystone FM Group', addr: '1700 Market St', city: 'Philadelphia', state: 'PA' },
  { name: 'Granite State Contractors', addr: '900 Elm St', city: 'Manchester', state: 'NH', phone: '+1 603-555-0159' },
  { name: 'Redwood General Contracting', addr: '1201 SW 4th Ave', city: 'Portland', state: 'OR', phone: '+1 503-555-0192' },
  { name: 'Copper Ridge Clinic', addr: '77 E 200 S', city: 'Salt Lake City', state: 'UT', phone: '+1 801-555-0104' },
  { name: 'Lakeside Urgent Care', addr: '310 W Wisconsin Ave', city: 'Milwaukee', state: 'WI' },
  { name: 'Fairview Medical Plaza', addr: '80 S 8th St', city: 'Minneapolis', state: 'MN', phone: '+1 612-555-0166' },
  { name: 'Sandhills Janitorial', addr: '1200 O St', city: 'Lincoln', state: 'NE', phone: '+1 402-555-0178' },
  { name: 'Ozark Building Services', addr: '400 Broadway Blvd', city: 'Kansas City', state: 'MO' },
];

/** Which queries each business comes back for. Several match more than one. */
const MATCHES: Record<string, string[]> = {
  'Lone Star Facility Services': ['commercial cleaning company', 'janitorial services'],
  'Bluebonnet Janitorial': ['janitorial services'],
  'Gulf Coast Building Care': ['commercial cleaning company', 'janitorial services'],
  'Midwest Sanitation Partners': ['commercial cleaning company'],
  'Prairie Clean Co': ['janitorial services'],
  'Cascade Commercial Cleaning': ['commercial cleaning company', 'janitorial services'],
  'Anytime Fitness': ['gym', 'fitness center'],
  'Summit Facility Management': ['facility management company', 'commercial cleaning company'],
};

function stubResponse(textQuery: string, anchorState: string) {
  const places = PLACES.filter((p) => {
    const queries = MATCHES[p.name];
    if (queries) return queries.some((q) => textQuery.includes(q.split(' ')[0]));
    return true;
  })
    .filter((p) => !anchorState || p.state === anchorState || Math.random() < 0.25)
    .slice(0, 6)
    .map((p) => ({
      id: `ChIJ${Buffer.from(p.name).toString('hex').slice(0, 20)}`,
      displayName: { text: p.name },
      formattedAddress: `${p.addr}, ${p.city}, ${p.state} 7${Math.floor(Math.random() * 9000 + 1000)}`,
      nationalPhoneNumber: p.phone,
      websiteUri: p.site,
      businessStatus: 'OPERATIONAL',
      // Places returns no publication date. That is the whole point: there is
      // no event here, only an existence.
    }));

  return { places };
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Run the seed first.');
  const user = await prisma.user.findFirst({ where: { orgId: org.id } });
  if (!user) throw new Error('No user in the organisation.');

  await ensureDefaultPaths(org.id);
  await ensureStarterMarket(org.id);
  await installLiveSources(org.id);

  if (STUB) {
    process.env.GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || 'stub-key-not-a-real-credential';
    setTransport(async (url, init) => {
      const body = JSON.parse(String(init.body ?? '{}'));
      const lat = body?.locationBias?.circle?.center?.latitude ?? 0;
      // Anchor latitude is enough to vary the result set per anchor.
      const state = ['TX', 'IL', 'CA', 'NY', 'WA', 'GA', 'CO', 'OH'][Math.floor(lat) % 8] ?? '';
      return new Response(JSON.stringify(stubResponse(String(body.textQuery ?? ''), state)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    // Only Places is stubbed; everything else would try the network.
    await prisma.dataSource.updateMany({
      where: { orgId: org.id, isLive: true, connector: { not: 'google_places' } },
      data: { isEnabled: false },
    });
    await prisma.dataSource.updateMany({
      where: { orgId: org.id, connector: 'google_places' },
      data: { isEnabled: true },
    });
  }

  console.log('--- running discovery -----------------------------------------');
  const runs = await runDiscoveryAcrossMarkets({ orgId: org.id, liveOnly: true, maxRecordsPerRun: 60 });
  for (const r of runs) {
    console.log(`${r.dataSourceKey.padEnd(26)} fetched ${String(r.recordsFetched).padStart(3)}  created ${String(r.signalsCreated).padStart(3)}  dup ${String(r.signalsDuplicate).padStart(3)}${r.errors[0] ? `  ! ${r.errors[0].slice(0, 90)}` : ''}`);
  }

  console.log('\n--- assessing --------------------------------------------------');
  const assessment = await reclassify({ orgId: org.id, userId: user.id });
  console.log(`signals examined ${assessment.signalsExamined} · accounts ${assessment.companiesAfter} · merged ${assessment.companiesMerged} · hypotheses ${assessment.hypothesesCreated} · intent events ${assessment.intentEventsFound} · quarantined ${assessment.quarantinedAccounts}`);

  console.log('\n--- the board as the page builds it ----------------------------');
  const hypotheses = await prisma.pathHypothesis.findMany({
    where: { orgId: org.id, company: { origin: 'LIVE_DISCOVERY' } },
    include: {
      path: true,
      company: { include: { contacts: { orderBy: { createdAt: 'asc' } } } },
      signals: { include: { dataSource: true, market: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  const unassessed = await prisma.discoverySignal.count({
    where: { orgId: org.id, origin: 'LIVE_DISCOVERY', status: { in: ['NEW', 'TRIAGED'] }, hypothesisId: null },
  });

  const byId = new Map<string, BoardAccount>();
  for (const h of hypotheses) {
    const c = h.company;
    const account = byId.get(c.id) ?? {
      companyId: c.id, name: c.legalName, cityName: c.cityName, stateCode: c.stateCode,
      phone: c.phone ?? c.contacts[0]?.phone ?? null, email: c.contacts[0]?.email ?? null,
      website: c.website, origin: c.origin, externalPlaceId: c.externalPlaceId,
      normalizedPhone: c.normalizedPhone, normalizedAddress: c.normalizedAddress, hypotheses: [],
    };
    account.hypotheses.push({
      id: h.id, pathId: h.pathId, pathName: h.path.name,
      leadRole: h.signals[0]?.leadRole ?? 'BUYER', stage: h.stage,
      accountFit: h.accountFitScore, intent: h.intentScore,
      contactability: h.contactabilityScore, fulfilment: h.fulfillmentReadinessScore,
      priority: Math.round(h.priorityScore),
      scoreExplanation: (h.scoreExplanation ?? {}) as Record<string, string>,
      requiredService: h.signals[0]?.requiredService ?? null,
      missing: missingEvidence({ needEvidence: h.needEvidence, decisionMakerId: h.decisionMakerId, timingEvidence: h.timingEvidence, accountFit: h.accountFitScore, nextStep: h.nextStep }),
      sourceNames: [...new Set(h.signals.map((s) => s.dataSource?.name).filter(Boolean) as string[])],
      sourceUrl: h.signals.find((s) => s.sourceUrl)?.sourceUrl ?? null,
      sourcePublishedAt: h.signals.map((s) => s.sourcePublishedAt).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null,
      firstDiscoveredAt: h.firstDiscoveredAt, lastSeenAt: h.lastSeenAt, lastIntentSignalAt: h.lastIntentSignalAt,
      signalCount: h.signals.length, evidence: [], marketName: null,
      isLiveSource: h.signals.some((s) => s.dataSource?.isLive),
    });
    byId.set(c.id, account);
  }

  const board = buildBoard({ accounts: [...byId.values()], unassessedSignals: unassessed });

  console.log(`accounts ${board.counts.accounts} · hypotheses ${board.counts.hypotheses} · raw records ${board.counts.signals} · duplicates collapsed ${board.counts.duplicateSignals} · held back ${board.counts.quarantined} · unassessed ${board.counts.unassessedSignals}`);
  console.log(`\nVERDICT: ${board.diagnostics.verdict} — ${board.diagnostics.verdictReason}`);
  console.log(`ranked: ${board.ranked}${board.rankingRefusedBecause ? ` (${board.rankingRefusedBecause})` : ''}`);

  console.log('\ndimension        n  distinct   min   max  mean  modeShare');
  for (const d of board.diagnostics.distributions) {
    console.log(
      `${d.dimension.padEnd(15)} ${String(d.count).padStart(2)}  ${String(d.distinctValues).padStart(8)}  ${String(d.min).padStart(4)}  ${String(d.max).padStart(4)}  ${d.mean.toFixed(1).padStart(4)}  ${(d.modeShare * 100).toFixed(0).padStart(8)}% @ ${d.modeValue}`,
    );
  }

  for (const w of board.diagnostics.warnings) console.log(`\n[${w.severity}] ${w.dimension}: ${w.finding}\n         ${w.likelyCause}`);
  for (const q of board.diagnostics.dataQuality) console.log(`\n[${q.severity}] ${q.kind}: ${q.finding}`);

  console.log('\n--- top of the board -------------------------------------------');
  console.log('pri  fit int con ful  stage                   path            account');
  for (const a of board.accounts.slice(0, 20)) {
    for (const h of a.hypotheses) {
      console.log(
        `${String(h.priority).padStart(3)}  ${String(Math.round(h.accountFit * 100)).padStart(3)} ${String(Math.round(h.intent * 100)).padStart(3)} ${String(Math.round(h.contactability * 100)).padStart(3)} ${String(Math.round(h.fulfilment * 100)).padStart(3)}  ${h.stage.padEnd(22)}  ${h.pathName.padEnd(14)}  ${a.name}${a.quarantined ? '  [held]' : ''} — ${[a.cityName, a.stateCode].filter(Boolean).join(', ') || 'location unknown'}`,
      );
    }
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
