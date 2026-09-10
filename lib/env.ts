import { z } from 'zod';

/**
 * Environment contract. Everything optional has a safe local default so the
 * app boots with zero credentials and runs entirely on mock providers.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  /** Non-pooled connection used for migrations. Optional outside serverless. */
  DIRECT_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(32),
  APP_URL: z.string().default('http://localhost:3000'),
  /** Shared secret a scheduler presents to drive the loop without a session. */
  CRON_SECRET: z.string().optional(),

  LLM_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

  TELEPHONY_PROVIDER: z.enum(['mock', 'twilio']).default('mock'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_WEBHOOK_SECRET: z.string().optional(),

  SMS_PROVIDER: z.enum(['mock', 'twilio']).default('mock'),
  TWILIO_SMS_FROM_NUMBER: z.string().optional(),

  TRANSCRIPTION_PROVIDER: z.enum(['mock', 'deepgram']).default('mock'),
  DEEPGRAM_API_KEY: z.string().optional(),

  EMAIL_PROVIDER: z.enum(['mock', 'smtp', 'http']).default('mock'),
  SMTP_URL: z.string().optional(),
  /** A transactional mail API — Resend, Postmark, SendGrid and similar. */
  EMAIL_API_URL: z.string().optional(),
  EMAIL_API_KEY: z.string().optional(),
  /** The verified sending address. Providers reject anything else. */
  EMAIL_FROM: z.string().default('ops@example.com'),

  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().default(2),
  WORKER_POLL_MS: z.coerce.number().default(2000),

  /**
   * Brain — the intelligence this site is a window onto.
   *
   * All three or none. With any of them missing the connector is off: the
   * panel says the site is not connected, no job is enqueued, and nothing on
   * the site changes. That is deliberate — a half-configured connector that
   * retried on every tick would be a background loop nobody asked for.
   *
   * `BRAIN_TOKEN` is a credential Brain issued to *this site*, scoped to one
   * project and two verbs. It is never logged, never returned by any route
   * here, and never rendered. `lib/audit.ts` redaction covers it, and the
   * client below refuses to include it in an error message.
   */
  BRAIN_URL: z.string().optional(),
  BRAIN_TOKEN: z.string().optional(),
  BRAIN_PROJECT_ID: z.string().optional(),
  /** How long to wait on Brain before falling back to the cached view. */
  BRAIN_TIMEOUT_MS: z.coerce.number().default(4000),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function isProduction(): boolean {
  return env().NODE_ENV === 'production';
}
