import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';

export type SendEmailInput = {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  metadata?: Record<string, string>;
};

export type SendEmailResult = { providerMessageId: string; status: 'sent' | 'queued' };

export interface EmailProvider {
  readonly name: string;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/** Captures outbound mail in memory so demos never contact real recipients. */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';
  readonly outbox: Array<SendEmailInput & { id: string; sentAt: Date }> = [];

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const id = `mock-msg-${randomUUID()}`;
    this.outbox.push({ ...input, id, sentAt: new Date() });
    console.info(`[email:mock] would send "${input.subject}" to ${input.to}`);
    return { providerMessageId: id, status: 'sent' };
  }
}

/**
 * SMTP provider stub. Wire a real transport (nodemailer or the provider SDK)
 * here; the interface above is all the rest of the app depends on.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';

  constructor(private readonly smtpUrl: string) {}

  async send(_input: SendEmailInput): Promise<SendEmailResult> {
    throw new Error(
      `SMTP provider not wired. Configure a transport for ${new URL(this.smtpUrl).host} in lib/providers/email.ts — see docs/INTEGRATIONS.md.`,
    );
  }
}

let cached: EmailProvider | null = null;

export function getEmail(): EmailProvider {
  if (cached) return cached;
  const config = env();
  cached =
    config.EMAIL_PROVIDER === 'smtp' && config.SMTP_URL
      ? new SmtpEmailProvider(config.SMTP_URL)
      : new MockEmailProvider();
  return cached;
}

export function setEmail(provider: EmailProvider | null): void {
  cached = provider;
}
