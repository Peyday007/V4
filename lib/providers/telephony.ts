import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';

export type PlaceCallInput = {
  to: string;
  from?: string;
  /** Recording is only requested when consent rules already cleared it. */
  record: boolean;
  /** Spoken announcement played before recording starts. */
  announcement?: string;
  metadata?: Record<string, string>;
};

export type PlaceCallResult = {
  providerCallId: string;
  status: 'initiated' | 'queued' | 'failed';
  from: string;
};

export type CallStatus = {
  providerCallId: string;
  status: 'ringing' | 'in-progress' | 'completed' | 'no-answer' | 'busy' | 'failed';
  durationSec?: number;
  recordingUrl?: string;
};

export interface TelephonyProvider {
  readonly name: string;
  placeCall(input: PlaceCallInput): Promise<PlaceCallResult>;
  getStatus(providerCallId: string): Promise<CallStatus>;
  hangup(providerCallId: string): Promise<void>;
  /** Verifies an inbound webhook signature. Returns false on any mismatch. */
  verifyWebhook(headers: Record<string, string>, rawBody: string): boolean;
}

/**
 * In-memory telephony used for demos and tests. Produces stable, inspectable
 * call ids so the rest of the loop (recording -> transcript -> extraction) can
 * be exercised without a carrier account.
 */
export class MockTelephonyProvider implements TelephonyProvider {
  readonly name = 'mock';
  private calls = new Map<string, CallStatus>();

  async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
    const providerCallId = `mock-call-${randomUUID()}`;
    this.calls.set(providerCallId, { providerCallId, status: 'in-progress' });
    return { providerCallId, status: 'initiated', from: input.from ?? '+15550000000' };
  }

  async getStatus(providerCallId: string): Promise<CallStatus> {
    return this.calls.get(providerCallId) ?? { providerCallId, status: 'completed' };
  }

  async hangup(providerCallId: string): Promise<void> {
    this.calls.set(providerCallId, { providerCallId, status: 'completed' });
  }

  verifyWebhook(): boolean {
    return true;
  }
}

/**
 * Twilio implementation. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
 * TWILIO_FROM_NUMBER. See docs/INTEGRATIONS.md for the webhook wiring.
 */
export class TwilioTelephonyProvider implements TelephonyProvider {
  readonly name = 'twilio';

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
  ) {}

  private auth(): string {
    return `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`;
  }

  async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
    const body = new URLSearchParams({
      To: input.to,
      From: input.from ?? this.fromNumber,
      Url: `${env().APP_URL}/api/webhooks/telephony/twiml`,
      StatusCallback: `${env().APP_URL}/api/webhooks/telephony/status`,
    });
    if (input.record) {
      body.set('Record', 'true');
      body.set('RecordingStatusCallback', `${env().APP_URL}/api/webhooks/telephony/recording`);
    }

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls.json`,
      { method: 'POST', headers: { Authorization: this.auth(), 'content-type': 'application/x-www-form-urlencoded' }, body },
    );
    if (!response.ok) throw new Error(`Twilio call failed: ${response.status}`);
    const json = (await response.json()) as { sid: string };
    return { providerCallId: json.sid, status: 'initiated', from: input.from ?? this.fromNumber };
  }

  async getStatus(providerCallId: string): Promise<CallStatus> {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls/${providerCallId}.json`,
      { headers: { Authorization: this.auth() } },
    );
    if (!response.ok) throw new Error(`Twilio status failed: ${response.status}`);
    const json = (await response.json()) as { status: string; duration?: string };
    return {
      providerCallId,
      status: json.status as CallStatus['status'],
      durationSec: json.duration ? Number(json.duration) : undefined,
    };
  }

  async hangup(providerCallId: string): Promise<void> {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls/${providerCallId}.json`, {
      method: 'POST',
      headers: { Authorization: this.auth(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Status: 'completed' }),
    });
  }

  verifyWebhook(headers: Record<string, string>, rawBody: string): boolean {
    // Twilio signs with HMAC-SHA1 over the full URL + sorted params.
    const signature = headers['x-twilio-signature'];
    if (!signature) return false;
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const url = `${env().APP_URL}/api/webhooks/telephony/status`;
    const params = new URLSearchParams(rawBody);
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const payload = url + sorted.map(([k, v]) => k + v).join('');
    const expected = createHmac('sha1', this.authToken).update(payload).digest('base64');
    return expected === signature;
  }
}

let cached: TelephonyProvider | null = null;

export function getTelephony(): TelephonyProvider {
  if (cached) return cached;
  const config = env();
  if (
    config.TELEPHONY_PROVIDER === 'twilio' &&
    config.TWILIO_ACCOUNT_SID &&
    config.TWILIO_AUTH_TOKEN &&
    config.TWILIO_FROM_NUMBER
  ) {
    cached = new TwilioTelephonyProvider(
      config.TWILIO_ACCOUNT_SID,
      config.TWILIO_AUTH_TOKEN,
      config.TWILIO_FROM_NUMBER,
    );
  } else {
    cached = new MockTelephonyProvider();
  }
  return cached;
}

export function setTelephony(provider: TelephonyProvider | null): void {
  cached = provider;
}
