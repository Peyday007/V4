/**
 * Score distribution diagnostics.
 *
 * Three times now a scoring dimension has shipped as a constant — fit at 100,
 * contactability at 30, fulfilment at 0 — and each time it was found by a
 * person reading the table, not by the system. A dimension that returns the
 * same value for every record carries no information, and the failure is
 * silent because a constant looks exactly like a confident answer.
 *
 * So the system now checks its own output. Any run that produces a degenerate
 * distribution says so, in the same report as the scores.
 */

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

export type DistributionWarning = {
  dimension: string;
  severity: Severity;
  finding: string;
  likelyCause: string;
};

export type DistributionStats = {
  dimension: string;
  count: number;
  distinctValues: number;
  min: number;
  max: number;
  mean: number;
  /** Share held by the single most common value. 1.0 means a constant. */
  modeShare: number;
  modeValue: number;
};

export function describeDistribution(dimension: string, values: number[]): DistributionStats {
  if (values.length === 0) {
    return { dimension, count: 0, distinctValues: 0, min: 0, max: 0, mean: 0, modeShare: 0, modeValue: 0 };
  }

  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const [modeValue, modeCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    dimension,
    count: values.length,
    distinctValues: counts.size,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
    modeShare: modeCount / values.length,
    modeValue,
  };
}

/**
 * Why a dimension might legitimately be uniform.
 *
 * Not every constant is a bug. Intent is genuinely zero for every record when
 * no intent-bearing source is enabled, and saying so is the correct answer —
 * but the operator still needs to know, because it means the board cannot
 * currently distinguish a hot lead from a cold one.
 */
const EXPECTED_UNIFORM: Record<string, string> = {
  intent:
    'Intent is zero for every record when no intent-bearing source is enabled. Directory and registry sources ' +
    '(Places, CMS) establish existence, not buying. Enable a permit, award or purchasing source to get variation.',
};

/**
 * Below this many records a uniform distribution is unremarkable — five
 * clinics from one registry genuinely may share a score.
 */
const MIN_SAMPLE = 8;

export function inspectDistribution(stats: DistributionStats): DistributionWarning[] {
  const warnings: DistributionWarning[] = [];
  if (stats.count < MIN_SAMPLE) return warnings;

  if (stats.distinctValues === 1) {
    const expected = EXPECTED_UNIFORM[stats.dimension];
    warnings.push({
      dimension: stats.dimension,
      severity: expected ? 'INFO' : 'CRITICAL',
      finding: `Every one of ${stats.count} records scored exactly ${stats.modeValue}. This dimension is not distinguishing anything.`,
      likelyCause:
        expected ??
        'The inputs are probably true by construction — conditions that cannot be false for any record the pipeline produces. Check what actually varies between records before trusting this score.',
    });
    return warnings;
  }

  if (stats.modeShare >= 0.9) {
    warnings.push({
      dimension: stats.dimension,
      severity: 'WARNING',
      finding: `${Math.round(stats.modeShare * 100)}% of ${stats.count} records scored ${stats.modeValue}, across only ${stats.distinctValues} distinct values.`,
      likelyCause:
        'Most inputs are probably invariant, with one or two records differing by accident rather than by evidence.',
    });
  }

  if (stats.max === stats.min && stats.count > 1) {
    warnings.push({
      dimension: stats.dimension,
      severity: 'CRITICAL',
      finding: `No spread at all: every value is ${stats.min}.`,
      likelyCause: 'A hardcoded or placeholder input reached the scorer.',
    });
  }

  // A dimension pinned to its ceiling is as suspicious as one pinned to zero —
  // both mean the scale is not being used.
  if (stats.modeValue === 100 && stats.modeShare >= 0.75) {
    warnings.push({
      dimension: stats.dimension,
      severity: 'WARNING',
      finding: `${Math.round(stats.modeShare * 100)}% of records are at the maximum.`,
      likelyCause: 'The conditions being scored are probably satisfied by every record the pipeline can produce.',
    });
  }

  return warnings;
}

export type DataQualityWarning = {
  kind: string;
  severity: Severity;
  count: number;
  finding: string;
  examples: string[];
};

/**
 * Structural problems in the records themselves, separate from scoring.
 * These are the ones that produce things like a house number in a city field.
 */
export function inspectDataQuality(records: Array<{
  company: string;
  cityState: string;
  quarantined: boolean;
  quarantineReason: string | null;
  contactability: number;
  intent: number;
}>): DataQualityWarning[] {
  const warnings: DataQualityWarning[] = [];

  const quarantined = records.filter((r) => r.quarantined);
  if (quarantined.length > 0) {
    warnings.push({
      kind: 'quarantined_identity',
      severity: 'WARNING',
      count: quarantined.length,
      finding: `${quarantined.length} record(s) have an identity too incomplete to trust. They are held out of ranking rather than merged or deleted.`,
      examples: quarantined.slice(0, 5).map((r) => `${r.company} — ${r.quarantineReason}`),
    });
  }

  const noLocation = records.filter((r) => r.cityState === 'unknown' && !r.quarantined);
  if (noLocation.length > records.length * 0.3 && records.length >= MIN_SAMPLE) {
    warnings.push({
      kind: 'missing_location',
      severity: 'WARNING',
      count: noLocation.length,
      finding: `${noLocation.length} of ${records.length} records have no usable city or state.`,
      examples: noLocation.slice(0, 5).map((r) => r.company),
    });
  }

  const unreachable = records.filter((r) => r.contactability === 0);
  if (unreachable.length > 0) {
    warnings.push({
      kind: 'no_contact_route',
      severity: 'INFO',
      count: unreachable.length,
      finding: `${unreachable.length} record(s) have no phone, email or website. Nobody can work these without research first.`,
      examples: unreachable.slice(0, 5).map((r) => r.company),
    });
  }

  return warnings;
}

/** Everything the run wants to say about its own credibility. */
export type RunDiagnostics = {
  distributions: DistributionStats[];
  warnings: DistributionWarning[];
  dataQuality: DataQualityWarning[];
  verdict: 'CREDIBLE' | 'SUSPECT' | 'NOT_CREDIBLE';
  verdictReason: string;
};

export function diagnose(input: {
  fit: number[];
  intent: number[];
  contactability: number[];
  fulfilment: number[];
  priority: number[];
  records: Parameters<typeof inspectDataQuality>[0];
}): RunDiagnostics {
  const distributions = [
    describeDistribution('accountFit', input.fit),
    describeDistribution('intent', input.intent),
    describeDistribution('contactability', input.contactability),
    describeDistribution('fulfilment', input.fulfilment),
    describeDistribution('priority', input.priority),
  ];

  const warnings = distributions.flatMap(inspectDistribution);
  const dataQuality = inspectDataQuality(input.records);

  // A run whose scores do not vary cannot be used to prioritise work, whatever
  // the individual numbers look like.
  const critical = warnings.filter((w) => w.severity === 'CRITICAL');
  const verdict = critical.length > 0 ? 'NOT_CREDIBLE' : warnings.some((w) => w.severity === 'WARNING') ? 'SUSPECT' : 'CREDIBLE';

  return {
    distributions,
    warnings,
    dataQuality,
    verdict,
    verdictReason:
      verdict === 'NOT_CREDIBLE'
        ? `${critical.length} dimension(s) carry no information: ${critical.map((c) => c.dimension).join(', ')}. Ranking on this output would be ranking on nothing.`
        : verdict === 'SUSPECT'
          ? 'Scores vary, but at least one dimension is close to uniform. Worth reading the warnings before trusting the order.'
          : 'Every dimension varies across the record set.',
  };
}
