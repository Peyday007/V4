import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  HttpEmailProvider, MockEmailProvider, SmtpEmailProvider,
  emailDeliveryStatus, setEmail,
} from '@/lib/providers/email';

/**
 * The rule this file exists for: nothing may be recorded as sent that no
 * transport accepted.
 *
 * The mock used to return `status: 'sent'`, and the send paths wrote a Message
 * marked SENT on the strength of it. An unconfigured deployment therefore
 * reported a full outbox of delivered quotes and deal rooms, and every
 * follow-up rule downstream was reasoning about mail nobody had received.
 */

afterEach(() => setEmail(null));

describe('a provider that cannot deliver says so', () => {
  it('the mock reports suppressed, not sent', async () => {
    const mock = new MockEmailProvider();
    const result = await mock.send({ to: 'a@b.test', subject: 's', body: 'b' });
    expect(result.status).toBe('suppressed');
    expect(mock.canDeliver).toBe(false);
  });

  it('and gives a reason an operator can act on', async () => {
    const result = await new MockEmailProvider().send({ to: 'a@b.test', subject: 's', body: 'b' });
    expect(result.reason).toMatch(/EMAIL_PROVIDER/);
    expect(result.reason).toMatch(/not sent/i);
  });

  it('it still keeps the message, so nothing typed is lost', async () => {
    const mock = new MockEmailProvider();
    await mock.send({ to: 'a@b.test', subject: 'The quote', body: 'body' });
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toBe('The quote');
  });

  it('smtp without a client is suppressed rather than silently broken', async () => {
    const smtp = new SmtpEmailProvider('smtp://relay.example.test:587');
    const result = await smtp.send({ to: 'a@b.test', subject: 's', body: 'b' });
    expect(result.status).toBe('suppressed');
    expect(result.reason).toMatch(/relay\.example\.test/);
    expect(result.reason).toMatch(/EMAIL_PROVIDER=http/);
  });
});

describe('the http transport', () => {
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; });

  it('sends, and takes the provider’s message id', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ id: 'prov-123' }), { status: 200 },
    )) as typeof fetch;

    const result = await new HttpEmailProvider('https://api.test/send', 'key', 'ops@test')
      .send({ to: 'a@b.test', subject: 's', body: 'b' });
    expect(result.status).toBe('sent');
    expect(result.providerMessageId).toBe('prov-123');
  });

  it('accepts a 2xx whose body it cannot parse, because they still took it', async () => {
    globalThis.fetch = (async () => new Response('OK', { status: 202 })) as typeof fetch;
    const result = await new HttpEmailProvider('https://api.test/send', 'key', 'ops@test')
      .send({ to: 'a@b.test', subject: 's', body: 'b' });
    expect(result.status).toBe('sent');
    expect(result.providerMessageId.length).toBeGreaterThan(0);
  });

  it('surfaces the provider’s own words when it refuses', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ message: 'The domain example.test is not verified' }), { status: 403 },
    )) as typeof fetch;

    await expect(
      new HttpEmailProvider('https://api.test/send', 'key', 'ops@test')
        .send({ to: 'a@b.test', subject: 's', body: 'b' }),
    ).rejects.toThrow(/not verified/);
  });

  it('never reports a refusal as a send', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const provider = new HttpEmailProvider('https://api.test/send', 'key', 'ops@test');
    await expect(provider.send({ to: 'a@b.test', subject: 's', body: 'b' })).rejects.toThrow();
  });
});

describe('the product can see whether mail works', () => {
  beforeEach(() => setEmail(null));

  it('reports the gap and what to do about it when nothing is configured', () => {
    setEmail(new MockEmailProvider());
    const status = emailDeliveryStatus();
    expect(status.canDeliver).toBe(false);
    expect(status.reason).toMatch(/EMAIL_API_URL/);
  });

  it('reports no gap once a real transport is in place', () => {
    setEmail(new HttpEmailProvider('https://api.test/send', 'key', 'ops@test'));
    const status = emailDeliveryStatus();
    expect(status.canDeliver).toBe(true);
    expect(status.reason).toBeNull();
  });

  it('a provider that cannot deliver always carries its own advice', () => {
    // Checked on the classes rather than through getEmail(), which reads the
    // environment; the property is what the product renders either way.
    expect(new MockEmailProvider().unavailableReason).toMatch(/EMAIL_API_URL/);
    expect(new SmtpEmailProvider('smtp://x.test').unavailableReason).toMatch(/EMAIL_PROVIDER=http/);
    expect(new HttpEmailProvider('https://a.test', 'k', 'f@t').unavailableReason).toBeNull();
  });
});
