import { env } from '@/lib/env';

/**
 * Whether this site is connected to a Brain, and to which one.
 *
 * All three settings or none. A half-configured connector is worse than an
 * absent one: it would retry on every tick, fill the job table with failures
 * and make the panel say something that is neither "not connected" nor "here
 * is what Brain thinks".
 *
 * The token never leaves this module except as an `Authorization` header built
 * inside `client.ts`. Nothing here returns it, and `describe()` exists so a
 * diagnostic can name the Brain without naming the credential.
 */
export interface BrainConfig {
  baseUrl: string;
  token: string;
  projectId: string;
  timeoutMs: number;
}

export function brainConfig(): BrainConfig | null {
  const config = env();
  const baseUrl = (config.BRAIN_URL ?? '').trim().replace(/\/+$/, '');
  const token = (config.BRAIN_TOKEN ?? '').trim();
  const projectId = (config.BRAIN_PROJECT_ID ?? '').trim();
  if (!baseUrl || !token || !projectId) return null;
  if (!/^https?:\/\//.test(baseUrl)) return null;
  return { baseUrl, token, projectId, timeoutMs: config.BRAIN_TIMEOUT_MS };
}

export function isConnected(): boolean {
  return brainConfig() !== null;
}

/**
 * Which of the three settings are missing, by name.
 *
 * `isConnected()` answers yes or no, and "no" has more than one cause: none of
 * them set, one of them set, or all three set on a deployment that was built
 * before they existed — the platform applies environment changes to new builds,
 * so the last case looks exactly like the first from inside the process.
 *
 * That ambiguity cost a round of confusion once, so the diagnostic distinguishes
 * them. Names only. A value is never returned here, and the token's is never
 * returned anywhere.
 */
export function missingBrainSettings(): string[] {
  const config = env();
  const missing: string[] = [];
  const baseUrl = (config.BRAIN_URL ?? '').trim();
  if (!baseUrl) missing.push('BRAIN_URL');
  else if (!/^https?:\/\//.test(baseUrl.replace(/\/+$/, ''))) missing.push('BRAIN_URL (not an http(s) address)');
  if (!(config.BRAIN_TOKEN ?? '').trim()) missing.push('BRAIN_TOKEN');
  if (!(config.BRAIN_PROJECT_ID ?? '').trim()) missing.push('BRAIN_PROJECT_ID');
  return missing;
}

/** The Brain, named by host and project. Never by credential. */
export function describeBrain(): string | null {
  const config = brainConfig();
  if (!config) return null;
  try {
    return `${new URL(config.baseUrl).host} · ${config.projectId}`;
  } catch {
    return config.projectId;
  }
}

/** The source system this site identifies as, matching Brain's closed set. */
export const SOURCE_SYSTEM = 'deal-dispatch';
export const RECORD_TYPE = 'OPPORTUNITY';
