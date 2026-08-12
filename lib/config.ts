import type { InterventionRung } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Operating rules an administrator can tune without a deploy. Anything the AI
 * uses as a threshold lives here, not in code constants.
 */
export type OrgConfig = {
  scoringWeights: Record<string, number>;
  marginRules: {
    minimumGrossMarginPct: number;
    targetGrossMarginPct: number;
    subcontractingManagementFeePct: number;
    brokerageSpreadPct: number;
    distributionMarginPct: number;
  };
  approvalLimits: {
    dealValueRequiringApproval: number;
    grossProfitRequiringApproval: number;
    cashExposureLimit: number;
    autoApproveBelowValue: number;
  };
  stalenessRules: {
    pricingDays: number;
    availabilityDays: number;
    capacityDays: number;
    companyVerificationDays: number;
    contactVerificationDays: number;
  };
  riskRules: {
    minimumGeneralLiability: number;
    minimumAutoLiability: number;
    minimumWorkersComp: number;
    requireLicenseForTrades: string[];
    maxDaysWithoutNextAction: number;
    neglectDays: number;
  };
  callingRules: {
    earliestHourLocal: number;
    latestHourLocal: number;
    allowedWeekdays: number[];
    maxAttemptsPerContact: number;
    minHoursBetweenAttempts: number;
    recordingRequiresBothPartyConsent: string[];
  };
  planning: {
    dailyCallCapacityPerCaller: number;
    maxEscalationsPerDay: number;
    minimumLaneSampleSize: number;
  };
  /** What a single outreach touch actually costs, by channel. */
  outreachCosts: {
    callerHourlyRate: number;
    /** Notes, logging and queue time either side of a call. */
    callWrapUpSeconds: number;
    telephonyPerMinute: number;
    smsPerSegment: number;
    emailPerMessage: number;
  };
  outreachRules: {
    /** Texting requires prior express consent in a way calling does not. */
    smsRequiresOptIn: boolean;
    smsEarliestHourLocal: number;
    smsLatestHourLocal: number;
    maxSmsPerContactPerWeek: number;
    /** Below this many attempts, channel comparisons stay advisory. */
    minimumSampleForChannelRecommendation: number;
    /**
     * Whether a Deal Room may be emailed to info@ and friends.
     *
     * Off by default. A general inbox is a room with nobody's name on the
     * door: sometimes it is the only address there is, and it is always a
     * worse send than a named one — so turning it on is a decision somebody
     * makes rather than a default they inherit.
     */
    allowGenericInboxFallback: boolean;
    /**
     * Whether anything may go out without a person pressing send.
     *
     * Off by default and checked at the send, not at the screen. Autonomous
     * outreach is the single fastest way for this system to damage a real
     * relationship at scale.
     */
    autonomousSendingEnabled: boolean;
    /** A ceiling that applies even when autonomous sending is on. */
    maxAutonomousSendsPerDay: number;
  };
  /**
   * What the System Manager is allowed to actually do.
   *
   * Every rung above coaching starts in shadow — decided, recorded, and
   * deliberately without effect. The directive requires it ("feature flags and
   * shadow mode are required for high-impact interventions until calibrated
   * against real work"), and the requirement is the right way round: these
   * rules have never run against this business, and the first few weeks of any
   * such ruleset are mostly it being wrong about people in ways nobody can
   * predict from the code.
   */
  managerRules: {
    /**
     * The rungs that may take effect. Everything else is written in shadow.
     *
     * Two rungs are absent whatever this list says: a security restriction and
     * an owner escalation are the owner's to apply, and the ladder refuses to
     * enforce them from a rule no matter how the flag is set.
     */
    enforceableRungs: InterventionRung[];
    /** Completed cases about a person before any rung may restrict them. */
    minCasesBeforeRestriction: number;
    /** Attempts below which a caller's numbers are not read as performance. */
    minAttemptsForCoaching: number;
    /** Observations a capability needs before its breaker may trip. */
    breakerMinimumObservations: number;
    /** Failure share, over that window, that trips it. */
    breakerFailureRate: number;
    breakerWindowMinutes: number;
    /** How long before one probe is let through to see if it recovered. */
    breakerRetryMinutes: number;
  };
};

export const DEFAULT_CONFIG: OrgConfig = {
  scoringWeights: {
    needStrength: 1.4,
    capabilityMatch: 1.2,
    urgency: 1.1,
    informationCompleteness: 0.7,
    contactability: 0.6,
    switchingWillingness: 1.2,
    incumbentWeakness: 1.0,
    supplyAvailability: 1.0,
    repeatPotential: 0.9,
    expansionValue: 0.7,
    fulfillmentRisk: -1.1,
    paymentRisk: -0.9,
    complianceRisk: -1.0,
    competitivePressure: -0.5,
    timeToClose: -0.4,
  },
  marginRules: {
    minimumGrossMarginPct: 12,
    targetGrossMarginPct: 22,
    subcontractingManagementFeePct: 18,
    brokerageSpreadPct: 10,
    distributionMarginPct: 25,
  },
  approvalLimits: {
    dealValueRequiringApproval: 25000,
    grossProfitRequiringApproval: 7500,
    cashExposureLimit: 15000,
    autoApproveBelowValue: 2500,
  },
  stalenessRules: {
    pricingDays: 14,
    availabilityDays: 7,
    capacityDays: 30,
    companyVerificationDays: 180,
    contactVerificationDays: 120,
  },
  riskRules: {
    minimumGeneralLiability: 1_000_000,
    minimumAutoLiability: 1_000_000,
    minimumWorkersComp: 500_000,
    requireLicenseForTrades: ['electrical', 'plumbing', 'hvac', 'security', 'asbestos'],
    maxDaysWithoutNextAction: 3,
    neglectDays: 7,
  },
  callingRules: {
    earliestHourLocal: 8,
    latestHourLocal: 20,
    allowedWeekdays: [1, 2, 3, 4, 5],
    maxAttemptsPerContact: 4,
    minHoursBetweenAttempts: 20,
    // Jurisdictions where all-party consent is required before recording.
    recordingRequiresBothPartyConsent: ['CA', 'CT', 'FL', 'IL', 'MD', 'MA', 'MI', 'MT', 'NH', 'PA', 'WA'],
  },
  planning: {
    dailyCallCapacityPerCaller: 25,
    maxEscalationsPerDay: 12,
    minimumLaneSampleSize: 8,
  },
  outreachCosts: {
    callerHourlyRate: 22,
    callWrapUpSeconds: 120,
    telephonyPerMinute: 0.013,
    smsPerSegment: 0.0079,
    emailPerMessage: 0.0004,
  },
  outreachRules: {
    smsRequiresOptIn: true,
    // Tighter than calling hours: a text arrives with a noise at whatever hour
    // it lands, and there is no way to hang up on it.
    smsEarliestHourLocal: 9,
    smsLatestHourLocal: 20,
    maxSmsPerContactPerWeek: 3,
    minimumSampleForChannelRecommendation: 20,
    allowGenericInboxFallback: false,
    autonomousSendingEnabled: false,
    maxAutonomousSendsPerDay: 0,
  },
  managerRules: {
    // Guidance, a correction to make, and a short piece of coaching. Nothing
    // here takes work away from anybody until somebody has read a few hundred
    // of these and decided the rules are worth obeying.
    enforceableRungs: ['INLINE_GUIDANCE', 'REQUIRED_CORRECTION', 'MICRO_COACHING'],
    minCasesBeforeRestriction: 3,
    minAttemptsForCoaching: 25,
    breakerMinimumObservations: 8,
    breakerFailureRate: 0.5,
    breakerWindowMinutes: 60,
    breakerRetryMinutes: 30,
  },
};

const CONFIG_KEY = 'operating_rules';

export async function getOrgConfig(orgId: string): Promise<OrgConfig> {
  const row = await prisma.configSetting.findUnique({
    where: { orgId_key: { orgId, key: CONFIG_KEY } },
  });
  if (!row) return DEFAULT_CONFIG;
  return mergeConfig(DEFAULT_CONFIG, row.value as Partial<OrgConfig>);
}

export async function setOrgConfig(
  orgId: string,
  partial: Partial<OrgConfig>,
  updatedBy?: string,
): Promise<OrgConfig> {
  const current = await getOrgConfig(orgId);
  const merged = mergeConfig(current, partial);
  await prisma.configSetting.upsert({
    where: { orgId_key: { orgId, key: CONFIG_KEY } },
    create: { orgId, key: CONFIG_KEY, value: merged as object, updatedBy },
    update: { value: merged as object, updatedBy },
  });
  return merged;
}

function mergeConfig(base: OrgConfig, patch: Partial<OrgConfig>): OrgConfig {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = { ...((base as Record<string, unknown>)[key] as object), ...(value as object) };
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as OrgConfig;
}
