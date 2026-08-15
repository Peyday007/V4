/**
 * How a deal would actually be transacted, and what each way costs you.
 *
 * "Middleman" is not one thing. Introducing two parties and taking a fee, and
 * signing a contract with a buyer and hiring somebody to deliver it, are the
 * same trade and different businesses: different money, different paperwork,
 * different ways of being ruined. The product had seven structures, chose one
 * automatically, and showed the choice as a word on a record — so the decision
 * that determines who gets sued and who funds the gap was made silently by a
 * function nobody read.
 *
 * This is the full set, in one place, answering the five questions that
 * actually separate them:
 *
 *   Who signs with the buyer. This decides who they can sue and who they pay.
 *   Who invoices, and who gets paid first. This decides whether a late-paying
 *   buyer is an inconvenience or an emergency.
 *   Who carries the liability if the work is bad.
 *   Who funds the gap between paying the provider and being paid.
 *   What you must have before you can do it at all.
 *
 * Every answer is written plainly, because the operator this is for should not
 * have to know what "back-to-back" means to understand that they will be paying
 * a crew three weeks before anybody pays them.
 */

export type StructureKey =
  | 'DIRECT_INTRODUCTION'
  | 'REFERRAL'
  | 'SALES_AGENCY'
  | 'PROCUREMENT_AGENT'
  | 'MARKETPLACE_FEE'
  | 'BROKERAGE'
  | 'WHITE_LABEL'
  | 'MANAGED_SERVICE'
  | 'SUBCONTRACTING'
  | 'DISTRIBUTION_RESALE'
  | 'CONSIGNMENT'
  | 'JOINT_VENTURE';

export type CommercialStructure = {
  key: StructureKey;
  label: string;
  /** What it is, in a sentence, with no jargon in it. */
  plainDescription: string;

  /** Who holds the contract with the buyer. */
  contractsWithBuyer: string;
  /** Who sends the invoice, and to whom. */
  invoices: string;
  /** Who has the money first, and what that means when the buyer is late. */
  paidFirst: string;
  /** Who is answerable if the work is wrong. */
  carriesLiability: string;
  /** Who funds the gap between paying out and being paid. */
  fundsTheGap: string;

  /** Roughly what share of the deal value ends up as ours, and why. */
  marginShape: string;
  /** How much of your own money is at risk in the worst ordinary case. */
  cashExposure: 'NONE' | 'SMALL' | 'MODERATE' | 'LARGE';

  /** When this is the right answer. */
  fits: string;
  /** When it is the wrong one. */
  doesNotFit: string;
  /** What has to be true before this is even available. */
  requires: string[];
};

export const STRUCTURES: CommercialStructure[] = [
  {
    key: 'DIRECT_INTRODUCTION',
    label: 'Direct introduction',
    plainDescription:
      'You put the buyer and the provider in touch and step out of the transaction. They deal with each other.',
    contractsWithBuyer: 'The provider. You are not a party to anything.',
    invoices: 'The provider invoices the buyer. You invoice nobody.',
    paidFirst: 'The provider. You are paid only if you have separately agreed a fee, and often you have not.',
    carriesLiability: 'The provider, entirely. You have made no promise about the work.',
    fundsTheGap: 'Nobody, from your side. No money passes through you.',
    marginShape:
      'Usually nothing on this deal. What you get is the relationship and the knowledge of who buys what.',
    cashExposure: 'NONE',
    fits:
      'A first contact where you do not yet know whether either side is any good, or a deal too small to be '
      + 'worth papering.',
    doesNotFit:
      'Anything you want paying for. An introduction with no fee agreement is a favour, and the second one is '
      + 'a habit.',
    requires: ['A provider willing to take the call.'],
  },
  {
    key: 'REFERRAL',
    label: 'Referral fee',
    plainDescription:
      'You introduce the buyer and the provider, they contract with each other, and the provider pays you an '
      + 'agreed fee if it closes.',
    contractsWithBuyer: 'The provider. You hold a separate fee agreement with the provider only.',
    invoices: 'The provider invoices the buyer. You invoice the provider for your fee.',
    paidFirst:
      'The provider. You are paid after they are, which means a buyer who pays late delays you and a buyer who '
      + 'never pays may mean you are never paid either.',
    carriesLiability: 'The provider. You have promised nothing about delivery.',
    fundsTheGap: 'The provider. Nothing of yours is at risk.',
    marginShape:
      'A fixed fee or a small percentage — usually five to fifteen per cent of the first order, far less than a '
      + 'spread, in exchange for carrying no risk at all.',
    cashExposure: 'NONE',
    fits:
      'Work you cannot deliver, cannot insure, or are not licensed for; and any deal where the compliance '
      + 'burden is worse than the margin.',
    doesNotFit:
      'A relationship you want to own. Once the two sides know each other, the second deal happens without '
      + 'you and there is nothing you can do about it.',
    requires: [
      'A written fee agreement with the provider, signed before the introduction.',
      'A way to know the deal closed, which usually means the provider telling you honestly.',
    ],
  },
  {
    key: 'SALES_AGENCY',
    label: 'Sales agency',
    plainDescription:
      'You sell on the provider\'s behalf, in their name, for a commission on what you bring in.',
    contractsWithBuyer: 'The provider. You sign on their behalf under an agency agreement.',
    invoices: 'The provider invoices the buyer. You invoice the provider for commission.',
    paidFirst:
      'The provider. Commission usually follows their collection, so their credit control becomes your cash '
      + 'flow problem.',
    carriesLiability:
      'The provider for the work. You for what you promised while selling it — an agent\'s statements bind '
      + 'their principal, so over-promising is a real exposure.',
    fundsTheGap: 'The provider.',
    marginShape:
      'Commission, typically ten to twenty-five per cent of revenue, recurring while the account lasts if the '
      + 'agreement says so and not if it does not.',
    cashExposure: 'NONE',
    fits:
      'A provider with capacity and no sales function, where you can build a book that keeps paying.',
    doesNotFit:
      'A provider who might cut you out, or one whose delivery you cannot vouch for. You are selling their '
      + 'quality with your reputation.',
    requires: [
      'An agency agreement stating the commission, the term, and what happens to accounts if it ends.',
      'Authority in writing about what you may promise on their behalf.',
    ],
  },
  {
    key: 'PROCUREMENT_AGENT',
    label: 'Buying agent',
    plainDescription:
      'You act for the buyer: you find the supply, negotiate it, and they pay the supplier directly. They pay '
      + 'you a fee for the service.',
    contractsWithBuyer: 'You, for the service of procuring. The supplier contracts with the buyer.',
    invoices: 'The supplier invoices the buyer. You invoice the buyer for your fee.',
    paidFirst: 'Whoever the buyer pays first, and your fee is usually a separate, smaller and later invoice.',
    carriesLiability:
      'The supplier for the goods. You for the advice — recommending a supplier who fails is a professional '
      + 'exposure even when you never touched the goods.',
    fundsTheGap: 'The buyer. Nothing of yours moves.',
    marginShape:
      'A flat fee or a percentage of spend. Predictable, unglamorous, and it does not scale with how good a '
      + 'price you found unless you agreed a share of the saving.',
    cashExposure: 'NONE',
    fits:
      'A buyer who has money and no time, buying something they buy rarely and you understand well.',
    doesNotFit:
      'Anywhere the buyer would rather have one throat to choke. An agent adds a party without absorbing any '
      + 'risk, which some buyers correctly dislike.',
    requires: [
      'A written engagement stating your fee and that you are not the seller.',
      'Enough category knowledge to be worth the fee, which the buyer will test on the first call.',
    ],
  },
  {
    key: 'MARKETPLACE_FEE',
    label: 'Marketplace fee',
    plainDescription:
      'Both sides transact through an arrangement you run, and you take a fee from one or both for the match.',
    contractsWithBuyer: 'The provider, on terms your arrangement sets.',
    invoices: 'Usually the provider invoices the buyer; you invoice whichever side agreed to the fee.',
    paidFirst: 'The provider, unless you handle the money — in which case see brokerage, because you now are one.',
    carriesLiability:
      'The provider for delivery. You for the accuracy of what you published about them, which is a real risk '
      + 'if you have not checked it.',
    fundsTheGap: 'Nobody, from your side, as long as the money does not pass through you.',
    marginShape: 'A percentage of each transaction. Small per deal and only interesting at volume.',
    cashExposure: 'NONE',
    fits: 'A category with many buyers and many providers where the matching itself is the hard part.',
    doesNotFit:
      'A handful of deals a month. A marketplace with three participants is an introduction with paperwork.',
    requires: [
      'Enough participants on both sides that neither can simply go around you.',
      'Terms both sides have agreed to, in writing.',
    ],
  },
  {
    key: 'BROKERAGE',
    label: 'Brokerage',
    plainDescription:
      'You contract with the buyer, hire a provider to deliver, and keep the difference. You are the supplier '
      + 'as far as the buyer is concerned.',
    contractsWithBuyer: 'You. They have never heard of the provider and do not need to.',
    invoices: 'You invoice the buyer. The provider invoices you.',
    paidFirst:
      'You, if you have set the terms well. If not, you pay the provider on their terms and wait for the buyer '
      + 'on theirs, and the difference is your money.',
    carriesLiability:
      'You, to the buyer, for everything — including things the provider did. You may recover from the '
      + 'provider afterwards, and that is a different and slower argument.',
    fundsTheGap:
      'You, unless the provider agrees to be paid after you are. That single term decides whether this '
      + 'structure needs capital or not.',
    marginShape:
      'The spread. Twenty to forty per cent is normal, and it is the highest margin available to a middleman '
      + 'precisely because it is the one where you carry the delivery risk.',
    cashExposure: 'MODERATE',
    fits:
      'A buyer you can reach directly, a provider you trust to deliver, and a deal large enough to justify '
      + 'carrying the risk.',
    doesNotFit:
      'A provider you have not verified, or a buyer whose payment behaviour is unknown and whose invoice you '
      + 'could not absorb.',
    requires: [
      'Terms with the provider that do not require you to pay before the buyer pays you, or the cash to bridge it.',
      'Insurance that covers the work you are now contractually responsible for.',
      'A provider whose capability somebody has actually verified.',
    ],
  },
  {
    key: 'WHITE_LABEL',
    label: 'White label',
    plainDescription:
      'The provider delivers the work under your name. The buyer believes they are dealing with you, and they '
      + 'are.',
    contractsWithBuyer: 'You. The provider is invisible by design.',
    invoices: 'You invoice the buyer. The provider invoices you.',
    paidFirst: 'You, on your own terms, which is one of the main reasons to do it this way.',
    carriesLiability:
      'You, completely and visibly. The buyer has no idea the provider exists, so every failure is yours in '
      + 'their eyes and in the contract.',
    fundsTheGap: 'You, on the same terms as brokerage.',
    marginShape:
      'Similar to brokerage, sometimes better, because the buyer cannot price-check the provider they cannot '
      + 'see.',
    cashExposure: 'MODERATE',
    fits: 'Repeat work where the relationship is the asset and you intend to keep it.',
    doesNotFit:
      'Work where the provider\'s name is the reason the buyer would say yes, or where a site visit would '
      + 'reveal the arrangement awkwardly.',
    requires: [
      'A provider who will accept not being named, in writing.',
      'The ability to answer a technical question yourself, or a provider who will take the call as you.',
    ],
  },
  {
    key: 'MANAGED_SERVICE',
    label: 'Managed service',
    plainDescription:
      'You take on running something continuously for the buyer, using providers you choose and manage.',
    contractsWithBuyer: 'You, usually on a term contract with a service standard in it.',
    invoices: 'You invoice the buyer on a cycle. Providers invoice you.',
    paidFirst: 'You, monthly, which makes this the most predictable structure here once it is running.',
    carriesLiability:
      'You, for the service standard — which is a higher bar than a one-off job, because you have promised a '
      + 'level rather than a delivery.',
    fundsTheGap: 'You, every cycle, until the first payment lands.',
    marginShape:
      'Lower per transaction than brokerage and far better over a year, because the work recurs without a new '
      + 'sale each time.',
    cashExposure: 'MODERATE',
    fits: 'Anything the buyer needs repeatedly and does not want to think about.',
    doesNotFit:
      'A first deal with a buyer you do not know. A service standard you cannot meet is worse than no contract.',
    requires: [
      'Providers with capacity you can rely on for the whole term, not just this month.',
      'A written service standard you have read and believe you can meet.',
      'Enough cash to run at least one cycle before being paid.',
    ],
  },
  {
    key: 'SUBCONTRACTING',
    label: 'Subcontracting',
    plainDescription:
      'Somebody else holds the contract with the end customer. You work underneath them, and they pay you.',
    contractsWithBuyer: 'The prime contractor. Your contract is with the prime, not the end customer.',
    invoices: 'You invoice the prime. The prime invoices the end customer.',
    paidFirst:
      'The prime. Many subcontracts are pay-when-paid, so the end customer\'s payment behaviour reaches you '
      + 'through somebody else\'s credit control.',
    carriesLiability: 'You, to the prime, for your part. The prime carries the whole to the customer.',
    fundsTheGap: 'You, and often for longer than in any other structure here.',
    marginShape:
      'Thinner than brokerage — the prime is taking a margin too — and it comes with no sales cycle at all, '
      + 'which is what makes it worth having.',
    cashExposure: 'LARGE',
    fits:
      'A prime who has won work they cannot fully staff, in a place where you have capacity.',
    doesNotFit:
      'A prime whose own payment record is unknown. You are lending them money whether or not either of you '
      + 'calls it that.',
    requires: [
      'The prime\'s payment terms in writing, including whether they are pay-when-paid.',
      'Credentials the prime\'s own contract obliges them to require of you.',
      'Cash to cover the gap, which here is measured in months.',
    ],
  },
  {
    key: 'DISTRIBUTION_RESALE',
    label: 'Buy and resell',
    plainDescription: 'You buy goods at wholesale and sell them to the buyer at your own price.',
    contractsWithBuyer: 'You, as the seller of the goods.',
    invoices: 'You invoice the buyer. The supplier invoices you.',
    paidFirst:
      'The supplier, usually. You will often pay for goods before the buyer pays you, and that is the whole '
      + 'financial character of this structure.',
    carriesLiability:
      'You, for the goods — including defects that are the manufacturer\'s fault. You may pass them back, and '
      + 'that takes time you do not have while the buyer is unhappy.',
    fundsTheGap: 'You, in cash, from the moment you place the order.',
    marginShape:
      'A fixed markup, often ten to thirty per cent. Simple, unambiguous, and it scales with volume rather '
      + 'than with cleverness.',
    cashExposure: 'LARGE',
    fits:
      'Consumables and materials on short cycles, where the working capital is small and turns over quickly.',
    doesNotFit:
      'Anything specified so tightly that a substitution is a rejection, or anything you would be left holding.',
    requires: [
      'Cash or supplier credit for the order.',
      'Somewhere to put the goods, or a delivery straight through.',
      'Certainty about the specification, because you own it once it arrives.',
    ],
  },
  {
    key: 'CONSIGNMENT',
    label: 'Consignment',
    plainDescription:
      'You hold or place the supplier\'s goods and pay for them only when they sell.',
    contractsWithBuyer: 'You, for the sale, under a consignment agreement with the supplier.',
    invoices: 'You invoice the buyer. You pay the supplier from the proceeds.',
    paidFirst: 'You, and then the supplier. This is the rare structure where the cash order works in your favour.',
    carriesLiability:
      'Shared, and it must be written down: the supplier for the goods, you for their condition while you hold '
      + 'them.',
    fundsTheGap: 'The supplier, in effect, by waiting for payment.',
    marginShape:
      'A markup or a commission, usually thinner than resale because the supplier is carrying the stock risk.',
    cashExposure: 'SMALL',
    fits: 'A supplier with stock they cannot move and enough trust to let you hold it.',
    doesNotFit:
      'A supplier who needs the cash now, or goods that spoil, obsolete or go missing while you hold them.',
    requires: [
      'A consignment agreement stating who owns the goods, who insures them, and what happens to unsold stock.',
      'A way to account for what has sold that the supplier will believe.',
    ],
  },
  {
    key: 'JOINT_VENTURE',
    label: 'Joint venture',
    plainDescription:
      'You and the provider go after one piece of work together, sharing the cost, the risk and the result.',
    contractsWithBuyer: 'Both of you, jointly, or a vehicle you set up for it.',
    invoices: 'The venture invoices the buyer. Proceeds are split on the agreed basis.',
    paidFirst: 'Neither. You are paid together, which also means you lose together.',
    carriesLiability:
      'Both of you, and usually jointly and severally — meaning the buyer can pursue either of you for all of '
      + 'it, whoever caused the problem.',
    fundsTheGap: 'Both, on the agreed share, and disputes about this are the usual way these end.',
    marginShape:
      'A share of the profit rather than a margin. The upside is the largest available here and so is the '
      + 'downside.',
    cashExposure: 'LARGE',
    fits: 'One large contract neither of you could win or deliver alone, with a partner you already trust.',
    doesNotFit:
      'A first deal with anybody. Joint and several liability with a stranger is not a commercial structure, '
      + 'it is a hope.',
    requires: [
      'A written agreement covering the split, the decision-making and what happens if it goes wrong.',
      'A partner with a track record you have actually checked.',
      'Capital for your share of the cost before any revenue.',
    ],
  },
];

export const STRUCTURE_BY_KEY = new Map(STRUCTURES.map((s) => [s.key, s]));

// ---------------------------------------------------------------------------
// Which of them are actually available on this deal
// ---------------------------------------------------------------------------

export type StructureContext = {
  /** A prime already holds the customer contract. */
  primeHoldsWork: boolean;
  /** Physical goods change hands. */
  involvesGoods: boolean;
  /** We can reach and contract with the buyer directly. */
  canContractWithBuyer: boolean;
  /** A registration or licence we do not hold that this work needs. */
  blockingCompliance: string | null;
  /** Whether a provider's capability has actually been verified by a person. */
  providerVerified: boolean;
  /** Whether the buyer's payment behaviour is known. */
  buyerPaymentKnown: boolean;
  /** Cash we could put at risk on one deal, where the owner has stated it. */
  workingCapitalCents: number | null;
  /** The low end of the modelled gross profit, where one exists. */
  grossProfitLow: number | null;
  /** Whether the work recurs, as far as anybody has established. */
  recurring: boolean | null;
};

export type StructureAssessment = {
  structure: CommercialStructure;
  available: boolean;
  /** Why it is or is not available, in the operator's language. */
  because: string;
  /** Things that are true and would still hurt. Shown even when available. */
  cautions: string[];
  /** What has not been established that this structure needs. */
  unknowns: string[];
};

/**
 * Every structure, with an honest answer about each.
 *
 * Deliberately not a ranking. The old code chose one and reported the rest as
 * "rejected", which reads as a decision and was really a heuristic — and the
 * heuristic could not know the two things that matter most: how much cash the
 * owner can put at risk, and how much they trust the provider. Both are the
 * owner's to say.
 *
 * So this returns the whole set, marks what is genuinely unavailable and says
 * why, and leaves the choice with the person who carries it. Where something is
 * unknown rather than untrue, it says that too, because "we do not know their
 * payment terms" is a different problem from "their terms are bad".
 */
export function compareStructures(context: StructureContext): StructureAssessment[] {
  return STRUCTURES.map((structure) => {
    const cautions: string[] = [];
    const unknowns: string[] = [];

    // --- hard availability -------------------------------------------------
    if (context.blockingCompliance && CONTRACTING_STRUCTURES.has(structure.key)) {
      return {
        structure,
        available: false,
        because:
          `This puts you in the contract, and ${context.blockingCompliance} is outstanding. You cannot promise `
          + 'work you are not permitted to do.',
        cautions,
        unknowns,
      };
    }

    if (structure.key === 'SUBCONTRACTING' && !context.primeHoldsWork) {
      return {
        structure,
        available: false,
        because: 'Nobody else holds this work, so there is no prime to sit underneath. The buyer is direct.',
        cautions,
        unknowns,
      };
    }

    if (structure.key !== 'SUBCONTRACTING' && context.primeHoldsWork && CONTRACTING_STRUCTURES.has(structure.key)) {
      return {
        structure,
        available: false,
        because:
          'A prime contractor already holds the customer contract. You cannot also be the buyer\'s supplier '
          + 'for the same work.',
        cautions,
        unknowns,
      };
    }

    if (GOODS_ONLY.has(structure.key) && !context.involvesGoods) {
      return {
        structure,
        available: false,
        because: 'There are no goods in this deal, so there is nothing to buy, hold or place.',
        cautions,
        unknowns,
      };
    }

    if (!context.canContractWithBuyer && CONTRACTING_STRUCTURES.has(structure.key)) {
      return {
        structure,
        available: false,
        because: 'There is no route to hold a contract with this buyer, and this structure requires one.',
        cautions,
        unknowns,
      };
    }

    // --- available, and here is what it will cost you ----------------------
    if (DELIVERY_RISK.has(structure.key) && !context.providerVerified) {
      cautions.push(
        'You would be promising the buyer work that a provider nobody has verified is meant to deliver. '
        + 'One call fixes this and nothing else does.',
      );
    }

    if (CAPITAL_STRUCTURES.has(structure.key)) {
      if (context.workingCapitalCents === null) {
        unknowns.push(
          'How much cash you can put at risk on one deal has never been recorded, so nothing here can tell you '
          + 'whether you could absorb this one.',
        );
      } else if (context.grossProfitLow !== null && context.workingCapitalCents < context.grossProfitLow * 100) {
        cautions.push(
          'The gap you would be funding is large against the cash you have said you can risk. A provider who '
          + 'agrees to be paid after you are removes this entirely, and is worth asking for.',
        );
      }
      if (!context.buyerPaymentKnown) {
        unknowns.push(
          'Nothing is known about how or when this buyer pays, and this structure means their answer becomes '
          + 'your cash flow.',
        );
      }
    }

    if (structure.key === 'MANAGED_SERVICE' && context.recurring !== true) {
      cautions.push(
        'Nobody has established that this work recurs. A term contract for a one-off is a service standard you '
        + 'carry for nothing.',
      );
    }

    if (structure.key === 'JOINT_VENTURE') {
      cautions.push(
        'Joint and several liability means the buyer can pursue you for all of it whoever caused the problem. '
        + 'This is not a first-deal structure.',
      );
    }

    if (structure.key === 'MARKETPLACE_FEE') {
      cautions.push(
        'This only pays at volume. With a handful of deals a month it is an introduction with paperwork on it.',
      );
    }

    return {
      structure,
      available: true,
      because: structure.fits,
      cautions,
      unknowns,
    };
  });
}

/** Structures where you sign with the buyer and therefore carry the work. */
const CONTRACTING_STRUCTURES = new Set<StructureKey>([
  'BROKERAGE', 'WHITE_LABEL', 'MANAGED_SERVICE', 'DISTRIBUTION_RESALE', 'CONSIGNMENT', 'JOINT_VENTURE',
]);

/** Structures where you are answerable to somebody for delivery. */
const DELIVERY_RISK = new Set<StructureKey>([
  'BROKERAGE', 'WHITE_LABEL', 'MANAGED_SERVICE', 'SUBCONTRACTING', 'JOINT_VENTURE',
]);

/** Structures that need your own money between paying out and being paid. */
const CAPITAL_STRUCTURES = new Set<StructureKey>([
  'BROKERAGE', 'WHITE_LABEL', 'MANAGED_SERVICE', 'SUBCONTRACTING', 'DISTRIBUTION_RESALE', 'JOINT_VENTURE',
]);

/** Structures that only make sense when physical goods are involved. */
const GOODS_ONLY = new Set<StructureKey>(['DISTRIBUTION_RESALE', 'CONSIGNMENT']);
