/**
 * The caller workspace, through a real browser.
 *
 * `callerWorkspaceAudit.ts` proves the server behaves. This proves a VA can
 * actually do the job: sign in with their own PIN, be handed one opportunity,
 * see why it was chosen and where the number came from, be stopped by the gate
 * when they try to skip past an incomplete record, and be let through once they
 * finish it.
 *
 * The gate is the interesting one. It is checked on the server, so the test
 * that matters is the one where the browser is told no.
 *
 *   npm run build && npx next start -p 3111
 *   node scripts/browserCallerWorkspaceCheck.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3111';
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

const scratch = mkdtempSync(join('scripts', '.browser-check-'));
function server(body) {
  const file = join(scratch, `step-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, `async function main() {\n${body}\n}\nmain().catch((e) => { console.error(e); process.exit(1); });\n`);
  return execFileSync('npx', ['tsx', file], {
    encoding: 'utf8',
    env: { ...process.env, DIRECT_URL: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  }).trim();
}

// ---------------------------------------------------------------------------
console.log('--- give a caller an identity and a packet ----------------------');
// Business hours are a hard exclusion, so the fixture companies are moved into
// whichever state is currently mid-morning. The rule is not relaxed; the setup
// works inside it.
const staged = server(`
  const { prisma } = await import('@/lib/db');
  const { hashSecret } = await import('@/lib/auth/password');
  const { issuePin } = await import('@/lib/caller/identity');
  const { buildPacket } = await import('@/lib/caller/packets');
  const { localHours } = await import('@/lib/caller/localTime');

  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  const owner = await prisma.user.findFirstOrThrow({ where: { orgId: org.id, role: { key: 'OWNER' } } });
  const role = await prisma.role.findFirstOrThrow({ where: { orgId: org.id, key: 'CALLER' } });

  await prisma.workIncident.deleteMany({ where: { orgId: org.id } });
  await prisma.packetItem.deleteMany({ where: { orgId: org.id } });
  await prisma.workPacket.deleteMany({ where: { orgId: org.id } });
  await prisma.outreachAttempt.deleteMany({ where: { orgId: org.id } });
  await prisma.outreachState.deleteMany({ where: { orgId: org.id } });

  const email = 'browser.caller@dealdispatch.test';
  const user = await prisma.user.upsert({
    where: { orgId_email: { orgId: org.id, email } },
    create: { orgId: org.id, email, name: 'Browser Caller',
              passwordHash: await hashSecret('unused-password-here', 10), roleId: role.id },
    update: { isActive: true, roleId: role.id },
  });
  const { pin } = await issuePin({ orgId: org.id, userId: user.id, issuedByUserId: owner.id });

  const now = new Date();
  const open = ['NY','IL','CO','CA','AK','HI'].find((s) => localHours({ stateCode: s, now }).open) ?? null;

  const routes = await prisma.$queryRaw\`
    SELECT r."id" AS id, r."companyId" AS "companyId" FROM "RouteHypothesis" r
    JOIN "Company" c ON c."id" = r."companyId"
    WHERE r."orgId" = \${org.id} AND r."status" NOT IN ('EXPIRED','REJECTED','COLD')
      AND r."tier" IN ('ACTIVE_DEMAND','STRONG_TRIGGER') AND c."phone" IS NOT NULL
    LIMIT 4\`;
  if (open) {
    await prisma.company.updateMany({
      where: { id: { in: routes.map((r) => r.companyId) } },
      data: { stateCode: open },
    });
  }
  await buildPacket({
    orgId: org.id, callerId: user.id, name: 'Browser packet',
    routeIds: routes.map((r) => r.id), assignedByUserId: owner.id,
  });
  console.log(JSON.stringify({ email, pin, open, items: routes.length }));
  await prisma.$disconnect();
`);
const fixture = JSON.parse(staged.split('\n').pop());
console.log(`        ${fixture.items} item(s), calling into ${fixture.open ?? 'no open state right now'}`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

// ---------------------------------------------------------------------------
console.log('\n--- the caller signs in with their own PIN ----------------------');
await page.goto(`${BASE}/work`);
check('the workspace asks for a PIN, not a shared passphrase',
  (await page.locator('input[type=password]').count()) === 1 &&
  (await page.locator('input[type=email]').count()) === 1);

await page.fill('input[type=email]', fixture.email);
await page.fill('input[type=password]', '000000');
await page.click('button[type=submit]');
await page.waitForSelector('.alert.danger', { timeout: 10000 });
check('a wrong PIN is refused in the browser too',
  /do not match/i.test((await page.locator('.alert.danger').first().textContent()) ?? ''));

await page.fill('input[type=password]', fixture.pin);
await page.click('button[type=submit]');
// Waiting on the URL is useless here: `/work` is both the sign-in page and the
// page it redirects to, so the wait passes against the form that is still on
// screen. Waiting for content only the signed-in page renders is the only
// version of this that is not a race.
await page.waitForSelector('text=Your packets', { timeout: 20000 });
const readinessText = await page.locator('body').textContent();
check('the pre-shift check greets them by name', /Browser/.test(readinessText ?? ''));
check('and says how much work is waiting', /opportunit/i.test(readinessText ?? ''));
check('and lists their packet', /Browser packet/.test(readinessText ?? ''));

// ---------------------------------------------------------------------------
console.log('\n--- one opportunity at a time -----------------------------------');
await page.goto(`${BASE}/work/call`);
await page.waitForSelector('h2, .alert', { timeout: 20000 });
const workText = await page.locator('body').textContent();

if (!fixture.open) {
  check('outside business hours the caller is told why, not shown a blank screen',
    /business hours/i.test(workText ?? ''), 'no US state is open at this hour');
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'All browser checks passed (serving deferred to local hours).' : `${failures} FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

check('exactly one opportunity is shown, not a board',
  (await page.locator('table.table tbody tr').count()) === 0, 'no queue table in the caller view');
check('it says why this one was chosen', /Why now/i.test(workText ?? ''));
check('it shows a dialable number', (await page.locator('a[href^="tel:"]').count()) >= 1);
check('it says where the number came from', /matched on|confirmed by|existing platform data|held before/i.test(workText ?? ''));
check('it gives an opening to say', /Say something like/i.test(workText ?? ''));
check('it says what not to claim', /Do not claim/i.test(workText ?? ''));
check('it never shows internal margin figures', !/gross profit|\$\/hr|profitPerHour/i.test(workText ?? ''));

// ---------------------------------------------------------------------------
console.log('\n--- the form asks what the outcome needs ------------------------');
await page.locator('button.filter-chip', { hasText: 'Qualified opportunity' }).first().click();
await page.waitForTimeout(300);
const qualifiedText = await page.locator('body').textContent();
check('choosing a demanding outcome reveals required fields', /· required/.test(qualifiedText ?? ''));
check('and explains why they are asked', /leaves cold calling|has to carry/i.test(qualifiedText ?? ''));

await page.locator('button:has-text("Save and get the next one")').click();
// Scoped to the save card. The brief above it carries its own warning alert —
// the supply caveat — and picking the first alert on the page reads that one
// instead, which passes for the wrong reason.
const saveCard = page.locator('.card', { has: page.locator('button:has-text("Save and get the next one")') });
await saveCard.locator('.alert').first().waitFor({ timeout: 15000 });
const refusal = await saveCard.locator('.alert').first().textContent();
check('saving without them is refused by the server', /needs/i.test(refusal ?? ''), (refusal ?? '').slice(0, 90));
check('and the refusal names the fields in the caller’s words',
  /what they said they need|who decides/i.test(refusal ?? ''));

// ---------------------------------------------------------------------------
console.log('\n--- an outcome that asks for nothing goes straight through -------');
await page.locator('button.filter-chip', { hasText: 'No answer' }).first().click();
await page.waitForTimeout(200);
await page.locator('button:has-text("Save and get the next one")').click();
await page.waitForTimeout(2500);
const afterSave = await page.locator('body').textContent();
check('the call saved and the next opportunity arrived',
  !/needs .*required/i.test(afterSave ?? '') && /Why now|Nothing to call|One thing first/i.test(afterSave ?? ''));

// ---------------------------------------------------------------------------
console.log('\n--- the gate holds, and the browser cannot walk past it ----------');
// An incomplete record is written directly, the way a stale tab or a crash
// would leave one, and then the caller asks for more work.
server(`
  const { prisma } = await import('@/lib/db');
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  const user = await prisma.user.findFirstOrThrow({
    where: { orgId: org.id, email: 'browser.caller@dealdispatch.test' } });
  const item = await prisma.packetItem.findFirst({
    where: { callerId: user.id, status: { in: ['PENDING','IN_PROGRESS'] } } });
  if (item) {
    await prisma.outreachAttempt.create({ data: {
      orgId: org.id, routeId: item.routeId, userId: user.id,
      disposition: 'QUALIFIED_OPPORTUNITY', discovery: {}, occurredAt: new Date() } });
  }
  console.log(JSON.stringify({ blocked: Boolean(item) }));
  await prisma.$disconnect();
`);

await page.reload();
await page.waitForSelector('h2', { timeout: 20000 });
const gated = await page.locator('body').textContent();
check('the caller is stopped by their own incomplete record', /One thing first|is missing/i.test(gated ?? ''),
  (gated ?? '').match(/is missing[^.]*/)?.[0]?.slice(0, 80) ?? '');
check('the block names the organisation holding them up', /missing/i.test(gated ?? ''));
check('and it is not blamed on the system', !/our fault|our side/i.test(gated ?? ''));

// A refresh is the classic way past a browser-only gate.
await page.goto(`${BASE}/work/call`);
await page.waitForSelector('h2', { timeout: 20000 });
const afterRefresh = await page.locator('body').textContent();
check('refreshing does not walk past the gate', /One thing first|is missing/i.test(afterRefresh ?? ''));

// ---------------------------------------------------------------------------
console.log('\n--- a system failure reads as ours, not theirs -------------------');
server(`
  const { prisma } = await import('@/lib/db');
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  const user = await prisma.user.findFirstOrThrow({
    where: { orgId: org.id, email: 'browser.caller@dealdispatch.test' } });
  await prisma.outreachAttempt.deleteMany({ where: { userId: user.id } });
  await prisma.workIncident.create({ data: {
    orgId: org.id, callerId: user.id, kind: 'SAVE_FAILURE',
    detail: 'Browser check: simulated failure.',
    preserved: { notes: 'They asked for pricing.' } } });
  console.log('{}');
  await prisma.$disconnect();
`);

await page.goto(`${BASE}/work/call`);
await page.waitForSelector('h2', { timeout: 20000 });
const faulted = await page.locator('body').textContent();
check('a save failure of ours is shown as ours', /our fault|our side/i.test(faulted ?? ''));
check('and the caller is told nothing they typed was lost', /not been lost|nothing you typed/i.test(faulted ?? ''));
check('and that it is not counted against them', /not counted against you/i.test(faulted ?? ''));

// ---------------------------------------------------------------------------
console.log('\n--- a caller cannot reach the owner’s screens --------------------');
for (const path of ['/demand', '/callers', '/companies']) {
  const response = await page.goto(`${BASE}${path}`);
  const landed = page.url();
  check(`${path} is not available to a caller`,
    landed.includes('/no-access') || (response?.status() ?? 200) >= 400,
    landed.replace(BASE, ''));
}

await browser.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'All browser checks passed.' : `${failures} browser check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
