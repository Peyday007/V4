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
