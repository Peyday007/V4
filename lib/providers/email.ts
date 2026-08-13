import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Getting mail out of the building, and being honest when we cannot.
 *
 * The interesting part of this file is not the transport. It is that the
 * default used to be a mock which returned `status: 'sent'`, and the messaging
 * layer wrote a Message row marked SENT on the strength of it. A deployment
 * with no mail configured therefore reported a full outbox of delivered
 * quotes and deal rooms, none of which existed outside a console line. Every
 * follow-up rule downstream — response SLAs, "they never replied" — was
 * reasoning about messages nobody had received.
 *
 * So the mock now says what it is. It reports `status: 'suppressed'` and the
 * caller is required to handle that: nothing is recorded as sent unless a
 * transport actually accepted it. An unconfigured deployment produces visible
 * pending mail with a reason, which is recoverable, rather than invisible loss,
 * which is not.
 */

export type SendEmailInput = {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  metadata?: Record<string, string>;
};

export type SendEmailResult = {
  providerMessageId: string;
  /**
   * `sent` and `queued` mean a transport took responsibility for it.
   * `suppressed` means nothing left the building and nothing will — the caller
   * must not record it as delivered.
   */
  status: 'sent' | 'queued' | 'suppressed';
  /** Why, when it was suppressed. Written for an operator, not a log reader. */
  reason?: string;
};

export interface EmailProvider {
  readonly name: string;
  /** False when this provider cannot actually deliver anything. */
  readonly canDeliver: boolean;
  /**
   * Why not, and what to do about it. Carried by the provider rather than
   * re-derived from the environment, so the advice cannot drift from the
   * decision that produced it.
   */
  readonly unavailableReason: string | null;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/**
 * Captures outbound mail in memory so tests and unconfigured deployments never
 * contact a real recipient — and never claim to have done so either.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';
  readonly canDeliver = false;
  readonly unavailableReason =
    'No email transport is configured. Set EMAIL_PROVIDER=http with EMAIL_API_URL, EMAIL_API_KEY and EMAIL_FROM.';
  readonly outbox: Array<SendEmailInput & { id: string; sentAt: Date }> = [];

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const id = `mock-msg-${randomUUID()}`;
    this.outbox.push({ ...input, id, sentAt: new Date() });
    return {
      providerMessageId: id,
      status: 'suppressed',
      reason:
        'No email transport is configured, so this was not sent. Set EMAIL_PROVIDER=http with '
        + 'EMAIL_API_URL and EMAIL_API_KEY, or EMAIL_PROVIDER=smtp with SMTP_URL, then send it again.',
    };
  }
}

/**
 * Transactional mail over a provider's HTTP API.
 *
 * Chosen as the real transport rather than SMTP because this deploys to a
 * serverless platform, where outbound SMTP ports are commonly blocked and a
 * connection pool has nowhere to live. The body shape is the one Resend,
 * Postmark and SendGrid all accept with minor field naming, so the field names
 * are configurable rather than hard-coded to one vendor.
 */
export class HttpEmailProvider implements EmailProvider {
  readonly name = 'http';
  readonly canDeliver = true;
  readonly unavailableReason = null;

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: input.subject,
        text: input.body,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      // The provider's own words, trimmed. A generic "send failed" leaves an
      // operator with nothing to act on, and the common causes — an unverified
      // sending domain, a bad key — are all stated plainly by these APIs.
      throw new Error(
        `The email provider refused this message (HTTP ${response.status}): ${text.slice(0, 300)}`,
      );
    }

    let providerMessageId = `http-${randomUUID()}`;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const id = parsed.id ?? parsed.MessageID ?? parsed.message_id;
      if (typeof id === 'string' && id.length > 0) providerMessageId = id;
    } catch {
      // A 2xx with an unparseable body still means they took it.
    }

    return { providerMessageId, status: 'sent' };
  }
}

/**
 * SMTP, for deployments that have a relay and want to use it.
 *
 * Deliberately not implemented with a bundled client. Adding an SMTP stack to
 * a serverless deployment that cannot hold the connection is the wrong default,
 * and this says so and names the alternative rather than failing obscurely at
 * the moment somebody presses send.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  readonly canDeliver = false;
  readonly unavailableReason =
    'SMTP is selected but no SMTP client is installed. Switch to EMAIL_PROVIDER=http with '
    + 'EMAIL_API_URL and EMAIL_API_KEY; outbound SMTP is usually blocked on serverless anyway.';

  constructor(private readonly smtpUrl: string) {}

  async send(_input: SendEmailInput): Promise<SendEmailResult> {
    let host = 'the configured relay';
    try { host = new URL(this.smtpUrl).host; } catch { /* keep the generic word */ }
    return {
      providerMessageId: `smtp-unconfigured-${randomUUID()}`,
      status: 'suppressed',
      reason:
        `SMTP is selected for ${host} but no SMTP client is installed, so nothing was sent. `
        + 'On a serverless deployment prefer EMAIL_PROVIDER=http with EMAIL_API_URL and EMAIL_API_KEY; '
        + 'outbound SMTP ports are usually blocked there in any case.',
    };
  }
}

let cached: EmailProvider | null = null;

export function getEmail(): EmailProvider {
  if (cached) return cached;
  const config = env();

  if (config.EMAIL_PROVIDER === 'http' && config.EMAIL_API_URL && config.EMAIL_API_KEY) {
    cached = new HttpEmailProvider(config.EMAIL_API_URL, config.EMAIL_API_KEY, config.EMAIL_FROM ?? '');
  } else if (config.EMAIL_PROVIDER === 'smtp' && config.SMTP_URL) {
    cached = new SmtpEmailProvider(config.SMTP_URL);
  } else {
    cached = new MockEmailProvider();
  }
  return cached;
}

export function setEmail(provider: EmailProvider | null): void {
  cached = provider;
}

/**
 * Whether mail can actually leave, and what to do if it cannot.
 *
 * Read by the product so an operator sees the gap on the screen where it
 * matters, rather than discovering it from a follow-up that never arrived.
 */
export function emailDeliveryStatus(): { canDeliver: boolean; provider: string; reason: string | null } {
  const provider = getEmail();
  return {
    canDeliver: provider.canDeliver,
    provider: provider.name,
    reason: provider.canDeliver ? null : provider.unavailableReason,
  };
}
