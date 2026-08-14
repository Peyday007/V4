/**
 * What is actually in here, counted rather than described.
 *
 * The product looks large. The question this answers is how much of that size
 * is commercial substance and how much is the same event refracted into three
 * hypotheses, priced from assumptions, and rendered on four screens.
 *
 * Two counting rules matter more than the rest:
 *
 *   Multiple route hypotheses from one demand event are one opportunity, not
 *   three. Counting them separately is precisely how a portfolio appears
 *   diverse while resting on a single source.
 *
 *   A number is only real if the inputs under it are real. A quote priced from
 *   an assumed volume is not a quote, and it is counted here as inferred.
 *
 *   npx tsx scripts/portfolioAudit.ts
 */

import { prisma } from '@/lib/db';

/** Evidence that is a placeholder wearing a source's clothes. */
const PLACEHOLDER_HOST = /example\.(com|org|net|test)|localhost|placeholder|lorem|foo\.bar/i;
const PLACEHOLDER_CONNECTOR = /^(sandbox|seed|demo|fixture|manual_seed|audit_fixture)$/i;

function bar(n: number, max: number, width = 24): string {
  if (max <= 0) return '';
  return '█'.repeat(Math.max(0, Math.round((n / max) * width)));
}

function table(title: string, rows: Array<[string, number]>, total: number) {
  console.log(`\n${title}`);
  if (rows.length === 0) { console.log('  (nothing)'); return; }
  const max = Math.max(...rows.map(([, n]) => n));
  for (const [label, n] of rows.sort((a, b) => b[1] - a[1])) {
    const pct = total > 0 ? ((n / total) * 100).toFixed(0).padStart(3) : '  0';
    console.log(`  ${label.slice(0, 38).padEnd(38)} ${String(n).padStart(5)}  ${pct}%  ${bar(n, max)}`);
  }
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const world = { orgId: org.id, dataMode: 'PRODUCTION' as const };

  const routes = await prisma.routeHypothesis.findMany({
    where: world,
    select: {
      id: true, route: true, status: true, tier: true, requiredCapability: true,
      eventId: true,
      event: {
        select: {
          connector: true, sourceUrl: true, eventDate: true, deadlineAt: true,
          effectiveAt: true, stateCode: true, lifecycle: true, verification: true,
        },
      },
      company: {
        select: {
          stateCode: true, phone: true,
          contacts: { select: { phone: true, mobile: true, email: true, isDecisionMaker: true } },
        },
      },
    },
  });

  console.log('='.repeat(72));
  console.log(`PORTFOLIO AUDIT — ${org.name}`);
  console.log('='.repeat(72));
  console.log(`\nProduction route hypotheses: ${routes.length}`);
  console.log(`Distinct demand events behind them: ${new Set(routes.map((r) => r.eventId)).size}`);
  console.log(
    '  Several hypotheses from one event are one opportunity. The gap between\n'
    + '  these two numbers is how much of the portfolio is refraction.',
  );

  // --- concentration ------------------------------------------------------
  const by = <T>(items: T[], key: (t: T) => string): Array<[string, number]> => {
    const m = new Map<string, number>();
    for (const item of items) m.set(key(item), (m.get(key(item)) ?? 0) + 1);
    return [...m.entries()];
  };

  // Category is the commercial thing being sold, taken from the capability the
  // route requires rather than from the coarse route enum.
  const category = (r: typeof routes[number]) => {
    const c = (r.requiredCapability ?? 'unstated').toLowerCase();
    if (/janitor|clean|custodial|sanitat|consumable/.test(c)) return 'cleaning / janitorial';
    if (/construct|build|fit-?out|renovat/.test(c)) return 'construction';
    if (/landscap|ground|snow/.test(c)) return 'grounds';
    if (/secur|guard/.test(c)) return 'security';
    if (/haul|freight|transport|logistic|carrier/.test(c)) return 'logistics';
    if (/steel|metal|lumber|material|supply|distribut/.test(c)) return 'materials / distribution';
    if (/hvac|plumb|electric|mechanic|facilit/.test(c)) return 'building trades';
    if (/staff|labour|labor|personnel/.test(c)) return 'staffing';
    return c === 'unstated' ? 'unstated' : `other: ${c.slice(0, 24)}`;
  };

  const categories = by(routes, category);
  table('BY COMMERCIAL CATEGORY', categories, routes.length);
  const top = categories.sort((a, b) => b[1] - a[1])[0];
  if (top) {
    console.log(
      `\n  Concentration: ${((top[1] / routes.length) * 100).toFixed(0)}% of the portfolio is `
      + `"${top[0]}".`,
    );
  }

  table('BY ROUTE', by(routes, (r) => r.route), routes.length);
  table('BY SOURCE CONNECTOR', by(routes, (r) => r.event.connector), routes.length);
  table('BY GEOGRAPHY',
    by(routes, (r) => r.company.stateCode ?? r.event.stateCode ?? 'unknown'), routes.length);

  // --- how real is any of it ---------------------------------------------
  const dated = routes.filter((r) => r.event.eventDate ?? r.event.effectiveAt ?? r.event.deadlineAt);
  const placeholder = routes.filter(
    (r) => (r.event.sourceUrl && PLACEHOLDER_HOST.test(r.event.sourceUrl))
      || PLACEHOLDER_CONNECTOR.test(r.event.connector),
  );
  const reachable = routes.filter(
    (r) => r.company.phone || r.company.contacts.some((c) => c.phone || c.mobile || c.email),
  );
  const decisionMaker = routes.filter(
    (r) => r.company.contacts.some((c) => c.isDecisionMaker && (c.phone || c.mobile || c.email)),
  );

  const routeIds = routes.map((r) => r.id);
  const [requirements, candidates, quotes, deals, payments, attempts] = await Promise.all([
    prisma.buyerRequirement.findMany({
      where: { orgId: org.id, dataMode: 'PRODUCTION', state: 'CURRENT' },
      select: { routeId: true, specification: true, quantity: true, confirmedFields: true },
    }),
    prisma.providerCandidate.findMany({
      where: { orgId: org.id, dataMode: 'PRODUCTION' },
      select: { routeId: true, state: true, costAmount: true, costExpiresAt: true, capabilityVerifiedAt: true },
    }),
    prisma.routeQuote.findMany({
      where: { orgId: org.id, dataMode: 'PRODUCTION' },
      select: { routeId: true, state: true, basis: true, costSideMissing: true, buyerPrice: true },
    }),
    prisma.routeDeal.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
    prisma.dealPayment.aggregate({
      where: { orgId: org.id, dataMode: 'PRODUCTION', direction: 'INBOUND', settledAt: { not: null } },
      _sum: { amount: true }, _count: true,
    }),
    prisma.outreachAttempt.groupBy({
      by: ['routeId'], where: { orgId: org.id, dataMode: 'PRODUCTION' }, _count: true,
    }),
  ]);

  const confirmedNeed = requirements.filter(
    (q) => Array.isArray(q.confirmedFields) && q.confirmedFields.length > 0,
  );
  const verifiedProvider = candidates.filter((c) => c.capabilityVerifiedAt !== null);
  const realCost = candidates.filter(
    (c) => c.costAmount !== null && c.costExpiresAt !== null && c.costExpiresAt > new Date(),
  );
  // A quote is defensible when the cost side is not missing and it rests on
  // something better than the engine's own prior.
  const defensible = quotes.filter((q) => !q.costSideMissing && q.basis !== 'PRIOR' && q.basis !== 'ESTIMATE');
  const inferredEconomics = quotes.filter((q) => q.costSideMissing || q.basis === 'PRIOR' || q.basis === 'ESTIMATE');

  const talkedTo = new Set(attempts.map((a) => a.routeId));
  const stranded = routes.filter((r) => r.status === 'RESEARCH' && !talkedTo.has(r.id));
  // Executable today: somebody can be rung about it now, or research can run.
  const callerReady = routes.filter(
    (r) => reachable.includes(r) && ['ACTIVE_DEMAND', 'STRONG_TRIGGER'].includes(r.tier),
  );

  const row = (label: string, n: number) =>
    console.log(`  ${label.padEnd(46)} ${String(n).padStart(5)}  ${routes.length > 0 ? ((n / routes.length) * 100).toFixed(0).padStart(3) : '  0'}%`);

  console.log('\nHOW REAL IS IT  (of ' + routes.length + ' routes)');
  row('with a dated external demand event', dated.length);
  row('resting on placeholder / demo / example evidence', placeholder.length);
  row('with any reachable contact route', reachable.length);
  row('with a reachable named decision-maker', decisionMaker.length);
  row('somebody has actually spoken to', talkedTo.size);
  row('with a confirmed buyer need', confirmedNeed.length);
  row('with a verified provider capability', verifiedProvider.length);
  row('with a real, unexpired provider cost', realCost.length);
  row('with a defensible buyer quote', defensible.length);
  row('with economics resting on inferred inputs', inferredEconomics.length);
  row('stranded in research, never called', stranded.length);
  row('caller-ready right now', callerReady.length);

  console.log('\nMONEY');
  console.log(`  deals: ${deals}   settled inbound payments: ${payments._count}   collected: $${Number(payments._sum.amount ?? 0).toLocaleString()}`);

  // --- noise --------------------------------------------------------------
  const [activity, aiDecisions] = await Promise.all([
    prisma.activityEvent.groupBy({
      by: ['opportunityId', 'verb', 'summary'], where: { orgId: org.id }, _count: true,
    }),
    prisma.aIDecision.groupBy({
      by: ['opportunityId', 'process', 'decision'], where: { orgId: org.id }, _count: true,
    }),
  ]);
  const dupActivity = activity.filter((a) => a._count > 1);
  const dupDecisions = aiDecisions.filter((a) => a._count > 1);
  const dupActivityRows = dupActivity.reduce((n, a) => n + a._count - 1, 0);
  const dupDecisionRows = dupDecisions.reduce((n, a) => n + a._count - 1, 0);

  console.log('\nNOISE');
  console.log(`  activity entries that repeat an identical line   ${String(dupActivityRows).padStart(5)}`);
  console.log(`  AI decisions repeating an identical conclusion   ${String(dupDecisionRows).padStart(5)}`);
  if (dupActivity.length > 0) {
    const worst = dupActivity.sort((a, b) => b._count - a._count)[0];
    console.log(`  worst offender: "${worst.summary.slice(0, 54)}" ×${worst._count}`);
  }

  // --- the sentence an owner should read ---------------------------------
  console.log('\n' + '='.repeat(72));
  console.log('THE FIRST BROKEN STAGE');
  console.log('='.repeat(72));
  const chain: Array<[string, number]> = [
    ['demand routes found', routes.length],
    ['have a reachable contact', reachable.length],
    ['somebody has spoken to', talkedTo.size],
    ['have a confirmed requirement', confirmedNeed.length],
    ['have a verified provider', verifiedProvider.length],
    ['have a real provider cost', realCost.length],
    ['have a defensible quote', defensible.length],
    ['reached a commitment', deals],
    ['collected money', payments._count],
  ];
  for (const [label, n] of chain) console.log(`  ${String(n).padStart(5)}  ${label}`);

  const broken = chain.find(([, n], i) => i > 0 && n === 0);
  console.log(
    `\n  ${routes.length} demand routes found; ${routes.length - reachable.length} still lack contact resolution; `
    + `${callerReady.length} are ready for discovery; ${confirmedNeed.length} have confirmed requirements; `
    + `${realCost.length} have provider cost.`,
  );
  if (broken) console.log(`  First stage with nothing in it: ${broken[0]}.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
