import { prisma } from '@/lib/db';
import type { StructureContext } from './structures';

/**
 * Where the owner's stated risk appetite lives.
 *
 * One key, named here rather than typed as a string at each use, because a
 * setting read under one spelling and written under another is a setting that
 * silently never applies.
 */
export const WORKING_CAPITAL_KEY = 'deal.max_working_capital_cents';

/**
 * The facts a structure comparison rests on, read from the record.
 *
 * Separate from the comparison itself so the same context feeds the page and
 * the endpoint that accepts the choice. When the two derive their own inputs
 * they eventually disagree, and the disagreement shows up as an owner choosing
 * something the server then refuses for reasons the screen never mentioned.
 *
 * Everything here is read rather than assumed, and the two things that cannot
 * be read — how much cash the owner will risk and whether the work recurs —
 * come back as nulls so the comparison can say "not established" instead of
 * quietly picking a default and pricing a decision on it.
 */
export async function structureContextFor(params: {
  orgId: string;
  routeId: string;
}): Promise<{ context: StructureContext; chosen: string | null; chosenReason: string | null } | null> {
  const route = await prisma.routeHypothesis.findFirst({
    where: { id: params.routeId, orgId: params.orgId },
    select: {
      route: true,
      buyerRole: true,
      complianceStatus: true,
      complianceGaps: true,
      commercialStructure: true,
      structureReason: true,
      estimatedGrossProfitLow: true,
      estimatedGrossProfit: true,
      company: { select: { phone: true, contacts: { select: { phone: true, email: true }, take: 5 } } },
      providerCandidates: { select: { capabilityVerifiedAt: true } },
      claims: {
        where: { supersededAt: null, key: { in: ['buyer.requirement.cycle', 'timing.contractEnd'] } },
        select: { key: true, standing: true },
      },
    },
  });
  if (!route) return null;

  const [capitalSetting, payments] = await Promise.all([
    // Stored as a setting rather than derived. How much cash an owner will put
    // at risk on one deal is a fact about their bank account and their nerve,
    // and no amount of reading the database produces it. Absent means absent —
    // the comparison then says so rather than assuming a comfortable figure.
    prisma.configSetting.findUnique({
      where: { orgId_key: { orgId: params.orgId, key: WORKING_CAPITAL_KEY } },
      select: { value: true },
    }),
    // Whether this buyer's payment behaviour is known at all: a settled inbound
    // payment is the only evidence that counts.
    prisma.dealPayment.count({
      where: { orgId: params.orgId, direction: 'INBOUND', settledAt: { not: null } },
    }),
  ]);

  const capitalValue = capitalSetting?.value;
  const workingCapitalCents =
    typeof capitalValue === 'number' && Number.isFinite(capitalValue) && capitalValue >= 0
      ? capitalValue
      : null;

  // A prime holding the work is a fact about the event, and the pipeline
  // records it by choosing the subcontracting route rather than in a column of
  // its own.
  const primeHoldsWork = route.route === 'SUBCONTRACTING' || route.buyerRole === 'PRIME_CONTRACTOR';

  return {
    context: {
      primeHoldsWork,
      involvesGoods: route.route === 'DISTRIBUTION',
      canContractWithBuyer:
        Boolean(route.company.phone) || route.company.contacts.some((c) => c.phone || c.email),
      blockingCompliance:
        route.complianceStatus === 'STRUCTURALLY_UNQUALIFIED' ? route.complianceGaps[0] ?? null : null,
      providerVerified: route.providerCandidates.some((c) => c.capabilityVerifiedAt !== null),
      buyerPaymentKnown: payments > 0,
      workingCapitalCents,
      grossProfitLow:
        route.estimatedGrossProfitLow !== null
          ? Number(route.estimatedGrossProfitLow)
          : route.estimatedGrossProfit !== null
            ? Number(route.estimatedGrossProfit)
            : null,
      // Null rather than false. Nobody having established that the work recurs
      // is a different thing from having established that it does not, and the
      // managed-service caution depends on the difference.
      recurring: route.claims.some((c) => c.standing === 'CONFIRMED') ? true : null,
    },
    chosen: route.commercialStructure,
    chosenReason: route.structureReason,
  };
}
