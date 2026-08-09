import type { BusinessPath, DataOrigin, LeadRole, MarketSegment } from '@prisma/client';
import type { PathScoringWeights } from '@/lib/paths';

/**
 * Ranking discovered leads.
 *
 * Deliberately separate from opportunity scoring. An opportunity has been
 * qualified and has a value; a lead has a source, an age and a phone number,
 * and pretending otherwise produces confident revenue forecasts built on a
 * directory listing.
 *
 * Every component returns its own reason string. A ranked list nobody can
 * interrogate gets ignored the first time the top item is obviously wrong, so
 * the explanation is part of the output rather than something reconstructed
 * afterwards.
 */

export type LeadScoreInput = {
  strength: number;
  confidence: number;
  observedAt: Date;
  lastSeenAt: Date;
  origin: DataOrigin;
  leadRole: LeadRole;
  segment: MarketSegment;
  hasPhone: boolean;
  hasEmail: boolean;
  hasSourceUrl: boolean;
  requiredService: string | null;
  /** True when the connector reaches a real external source. */
  sourceIsLive: boolean;
};

export type LeadScoreComponent = {
  label: string;
  value: number;
  weight: number;
  contribution: number;
  reason: string;
};

export type LeadScore = {
  /** 0–100. Comparable only within an organisation, since weights are per path. */
  score: number;
  components: LeadScoreComponent[];
  freshness: Freshness;
  explanation: string;
};

export type Freshness = 'FRESH' | 'RECENT' | 'AGEING' | 'STALE';

const DEFAULT_WEIGHTS: Required<PathScoringWeights> = {
  freshness: 1.0,
  contactability: 1.0,
  segmentFit: 1.0,
  sourceReliability: 1.0,
  signalStrength: 1.0,
};

/**
 * Freshness is measured from when the source published, not when we stored it.
 *
 * A permit filed in March that we discovered today is three months old to the
 * buyer, whatever our database says. Ranking by ingestion date makes a backlog
 * look like a windfall.
 */
export function freshnessOf(observedAt: Date, now = new Date()): Freshness {
  const days = (now.getTime() - observedAt.getTime()) / 86_400_000;
  if (days <= 7) return 'FRESH';
  if (days <= 30) return 'RECENT';
  if (days <= 90) return 'AGEING';
  return 'STALE';
}

const FRESHNESS_VALUE: Record<Freshness, number> = {
  FRESH: 1.0,
  RECENT: 0.75,
  AGEING: 0.4,
  STALE: 0.15,
};

export function scoreLead(input: LeadScoreInput, path: BusinessPath | null, now = new Date()): LeadScore {
  const weights = { ...DEFAULT_WEIGHTS, ...((path?.scoringWeights ?? {}) as PathScoringWeights) };
  const freshness = freshnessOf(input.observedAt, now);
  const days = Math.max(0, Math.round((now.getTime() - input.observedAt.getTime()) / 86_400_000));

  const components: LeadScoreComponent[] = [];

  components.push(
    component('Freshness', FRESHNESS_VALUE[freshness], weights.freshness, {
      FRESH: `Published ${days} day(s) ago — still current.`,
      RECENT: `Published ${days} days ago. Worth acting on, but the window is narrowing.`,
      AGEING: `Published ${days} days ago. A decision may already have been made.`,
      STALE: `Published ${days} days ago. Likely resolved; verify before spending a call on it.`,
    }[freshness]),
  );

  // Contactability dominates in practice. A perfect lead nobody can reach costs
  // research time before it costs anything else.
  const contactValue = input.hasPhone ? 1.0 : input.hasEmail ? 0.55 : 0.15;
  components.push(
    component('Contactability', contactValue, weights.contactability,
      input.hasPhone
        ? 'Phone number available on the source record — callable today.'
        : input.hasEmail
          ? 'Email only. Slower, and answer rates are lower than a call.'
          : 'No contact detail on the source. Someone has to research a way in first.'),
  );

  const segmentFit = path ? (path.segments.length === 0 || path.segments.includes(input.segment) ? 1.0 : 0.25) : 0.7;
  components.push(
    component('Segment fit', segmentFit, weights.segmentFit,
      path
        ? segmentFit === 1.0
          ? `${titleCase(input.segment)} is a segment the ${path.name} path works.`
          : `${titleCase(input.segment)} is outside the ${path.name} path's configured segments.`
        : 'No business path assigned, so segment fit could not be assessed.'),
  );

  // A record from a live external source is worth more than one from a fixture,
  // and this is the term that makes that difference visible in the ranking
  // rather than only in a badge.
  const reliability = input.sourceIsLive ? (input.hasSourceUrl ? 1.0 : 0.7) : 0.1;
  components.push(
    component('Source reliability', reliability, weights.sourceReliability,
      input.sourceIsLive
        ? input.hasSourceUrl
          ? 'Live external source with a verifiable link back to the original record.'
          : 'Live external source, but no link back — the claim cannot be checked in one click.'
        : 'Demonstration fixture, not a real source. Should not be worked.'),
  );

  const signalValue = clamp01(input.strength * 0.6 + input.confidence * 0.4);
  components.push(
    component('Signal strength', signalValue, weights.signalStrength,
      input.requiredService
        ? `Identified need: ${input.requiredService}. Strength ${input.strength.toFixed(2)}, confidence ${input.confidence.toFixed(2)}.`
        : `No specific service identified. Strength ${input.strength.toFixed(2)}, confidence ${input.confidence.toFixed(2)}.`),
  );

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const weighted = components.reduce((sum, c) => sum + c.contribution, 0);
  const score = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) : 0;

  return { score, components, freshness, explanation: explain(score, components, path) };
}

function explain(score: number, components: LeadScoreComponent[], path: BusinessPath | null): string {
  const ranked = [...components].sort((a, b) => b.contribution - a.contribution);
  const strongest = ranked[0];
  const weakest = ranked[ranked.length - 1];
  const pathName = path ? `${path.name} lead` : 'Lead';

  return (
    `${pathName} scoring ${score}/100. Strongest factor: ${strongest.label.toLowerCase()} — ${strongest.reason} ` +
    `Weakest: ${weakest.label.toLowerCase()} — ${weakest.reason}`
  );
}

function component(label: string, value: number, weight: number, reason: string): LeadScoreComponent {
  const bounded = clamp01(value);
  return { label, value: bounded, weight, contribution: bounded * weight, reason };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}
