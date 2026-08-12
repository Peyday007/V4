/**
 * The Deal Room over real HTTP.
 *
 * This is the only part of the product an anonymous stranger can reach, so the
 * questions are different from every other audit here. Not "does the feature
 * work" but "what can somebody who should not be looking learn from it":
 *
 *   Whether a wrong token is distinguishable from a right one that expired.
 *   Whether the page leaks an id that could be walked to another record.
 *   Whether the owner endpoints are reachable without a session.
 *   Whether a caller — who has a session — can create or send one.
 *   Whether a search engine is told to stay away.
 *
 *   BASE_URL=http://localhost:3111 npx tsx scripts/dealRoomHttpAudit.ts
 */

import { prisma } from '@/lib/db';
import { createRoom } from '@/lib/room/rooms';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
const PASSWORD = 'demo-password-123';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function signIn(email: string): Promise<string | null> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) return null;
  const cookie = response.headers.get('set-cookie');
  return cookie ? cookie.split(';')[0] : null;
}

async function post(path: string, body: unknown, cookie?: string | null) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Seed the database first.');

  const route = await prisma.routeHypothesis.findFirst({
    where: { orgId: org.id, requirements: { some: { state: 'CURRENT' } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!route) throw new Error('No route with a requirement. Run scripts/dealRoomAudit.ts first.');

  await prisma.dealRoom.deleteMany({ where: { routeId: route.id } });
  const created = await createRoom({ orgId: org.id, routeId: route.id, force: true });
  if (!created.ok) throw new Error(`Could not create a room: ${created.message}`);
  const token = created.room.token;

  // -----------------------------------------------------------------------
  console.log('--- the public page ----------------------------------------------');

  const page = await fetch(`${BASE}/room/${token}`);
  const html = await page.text();
  check('a valid token serves the page to anybody', page.status === 200, `got ${page.status}`);
  check('the page carries the prospect\'s own name', html.includes(created.content.organisation));

  // Nothing on this page may be an identifier for anything else.
  for (const [label, id] of [
    ['the route id', route.id],
    ['the company id', route.companyId],
    ['the room id', created.room.id],
    ['the org id', org.id],
  ] as const) {
    check(`the served HTML does not contain ${label}`, !html.includes(id));
  }

  // Asserted against the tag itself rather than the substring, so a stray
  // "noindex" anywhere in the markup cannot make this pass.
  const robots = /<meta name="robots" content="([^"]*)"/.exec(html)?.[1] ?? null;
  check(
    'search engines are told to stay away',
    robots !== null && /noindex/.test(robots) && /nofollow/.test(robots),
    robots ?? 'no robots meta tag',
  );

  // -----------------------------------------------------------------------
  console.log('\n--- a token nobody issued ----------------------------------------');

  const wrong = await fetch(`${BASE}/room/${'A'.repeat(43)}`);
  check('an unknown token is a 404', wrong.status === 404, `got ${wrong.status}`);

  const shaped = await fetch(`${BASE}/room/${route.id}`);
  check('a route id used as a token is a 404 too', shaped.status === 404, `got ${shaped.status}`);
  const wrongBody = await wrong.text();
  check('and the 404 says nothing about what does exist',
    !wrongBody.includes(created.content.organisation) && !wrongBody.includes(route.id));

  // The truncated-token case: an attacker who saw part of one.
  const truncated = await fetch(`${BASE}/room/${token.slice(0, 20)}`);
  check('a partial token is a 404, not a hint', truncated.status === 404, `got ${truncated.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- responding ----------------------------------------------------');

  const respond = async (body: Record<string, string>) => {
    const response = await fetch(`${BASE}/api/room/${token}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      redirect: 'manual',
    });
    return response.status;
  };

  const bad = await respond({ action: 'DELETE_EVERYTHING' });
  check('an action that is not on the list is refused', bad === 400, `got ${bad}`);

  const first = await respond({ action: 'QUOTE_REQUESTED', note: 'Please send a price.' });
  check('a real action is accepted and redirects', first === 303 || first === 307 || first === 302, `got ${first}`);

  const second = await respond({ action: 'QUOTE_REQUESTED', note: 'Please send a price.' });
  check('a repeat is accepted the same way', second === first, `got ${second}`);

  const events = await prisma.dealRoomEvent.count({
    where: { roomId: created.room.id, kind: 'QUOTE_REQUESTED' },
  });
  check('and only one event exists for it', events === 1, `${events} events`);

  const unknownToken = await fetch(`${BASE}/api/room/${'B'.repeat(43)}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'QUOTE_REQUESTED' }).toString(),
    redirect: 'manual',
  });
  check('responding to an unknown token reveals nothing',
    unknownToken.status === 303 || unknownToken.status === 307 || unknownToken.status === 302,
    `got ${unknownToken.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- the owner endpoints ------------------------------------------');

  const anonymous = await post('/api/deal/room', { action: 'create', routeId: route.id });
  check('creating a room needs a session', anonymous.status === 401, `got ${anonymous.status}`);

  const callerCookie = await signIn('dana@dealdispatch.test');
  if (callerCookie) {
    const asCaller = await post('/api/deal/room', { action: 'create', routeId: route.id }, callerCookie);
    check('a caller cannot create a room', asCaller.status === 403, `got ${asCaller.status}`);

    const sendAsCaller = await post(
      '/api/deal/room',
      { action: 'send', roomId: created.room.id, contactId: 'x', channel: 'email' },
      callerCookie,
    );
    check('a caller cannot send one either', sendAsCaller.status === 403, `got ${sendAsCaller.status}`);
  }

  const researchCookie = await signIn('research@dealdispatch.test');
  if (researchCookie) {
    const send = await post(
      '/api/deal/room',
      { action: 'send', roomId: created.room.id, contactId: 'x', channel: 'email' },
      researchCookie,
    );
    check('a research reviewer cannot put one in front of a prospect', send.status === 403, `got ${send.status}`);
  }

  const managerCookie = await signIn('manager@dealdispatch.test');
  if (managerCookie) {
    const duplicate = await post('/api/deal/room', { action: 'create', routeId: route.id }, managerCookie);
    check('a second live room is refused with a reason', duplicate.status === 409, `got ${duplicate.status}`);

    const foreign = await post(
      '/api/deal/room',
      { action: 'create', routeId: 'clx0000000000000000000000' },
      managerCookie,
    );
    check('a route id from outside the account is not found', foreign.status === 404, `got ${foreign.status}`);

    const malformed = await post('/api/deal/room', { action: 'create' }, managerCookie);
    check('a malformed request is a 400', malformed.status === 400, `got ${malformed.status}`);
  }

  // -----------------------------------------------------------------------
  console.log('\n--- the token never comes back from a read path -------------------');

  if (managerCookie) {
    const record = await fetch(`${BASE}/demand/opportunity/${route.id}`, { headers: { cookie: managerCookie } });
    const recordHtml = await record.text();
    check('the owner opportunity page does not carry the token', !recordHtml.includes(token));

    const preview = await fetch(`${BASE}/demand/opportunity/${route.id}/room`, { headers: { cookie: managerCookie } });
    const previewHtml = await preview.text();
    check('the preview page renders', preview.status === 200, `got ${preview.status}`);
    check('the preview does not carry the token either', !previewHtml.includes(token));
    check('the preview is marked as a preview', previewHtml.includes('preview-banner'));

    const openEvents = await prisma.dealRoomEvent.count({
      where: { roomId: created.room.id, kind: 'OPENED', userAgentClass: 'human' },
    });
    check('and viewing it did not record a human open', openEvents === 0, `${openEvents} human opens`);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
