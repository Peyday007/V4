import type { DealPlan, Stage } from './plan';
import type { Evidenced, Presentation } from '@/lib/evidence/class';
import { presentMoney } from '@/lib/evidence/economics';

/**
 * Where a deal stands, said the way a person would say it.
 *
 * The opportunity page was a wall of panels: four meters at the top reading
 * percentages nobody had established, a configuration blob, a risk list, a
 * score breakdown, an activity feed, and somewhere among them the one thing
 * anybody opens the page for — what to do next.
 *
 * The order here is the correction. Standing first, in a sentence. Then the
 * one thing blocking it. Then the money, or the reason there is no money to
 * show. Then the two tracks the deal actually runs on, buyer and provider,
 * side by side because they proceed independently and a deal dies when either
 * stalls. Then the plan. Diagnostics last and collapsed, because they are for
 * the ten minutes a month when something is wrong, not the ten minutes a day
 * when somebody is working.
 */

export type Standing = {
  /** One sentence. What an owner would say if asked at the coffee machine. */
  sentence: string;
  /** The earliest thing in the chain that is ours to move. */
  blocker: Stage | null;
  /** Rungs finished on our side, waiting on somebody outside. */
  waitingOn: Stage[];
  progress: { done: number; total: number };
  /** How the sentence was arrived at, for "Explain this". */
  reasoning: string[];
};

/**
 * The standing sentence.
 *
 * Built from the plan rather than from a status column, because the status
 * column says what somebody set and the plan says what is actually true. A
 * deal marked ACTIVE whose first rung is unfinished is not active; it is
 * stuck, and the page should say so in the first line rather than three
 * scrolls down.
 */
export function standingOf(plan: DealPlan, context: { organisation: string }): Standing {
  const reasoning: string[] = [];
  const done = plan.progress.done;
  const total = plan.progress.total;

  reasoning.push(
    `${done} of ${total} steps are finished, judged by whether each one's evidence exists rather than by a `
    + 'status somebody set.',
  );

  if (plan.firstBroken) {
    reasoning.push(
      `The earliest unfinished step that is ours is "${plan.firstBroken.label}", because every step before it `
      + 'has the evidence it requires.',
    );
  }
  if (plan.waitingOn.length > 0) {
    reasoning.push(
      `${plan.waitingOn.length} step(s) are done on our side and waiting on somebody outside the building.`,
    );
  }
  if (plan.blockedCapabilities.length > 0) {
    reasoning.push(
      `${plan.blockedCapabilities.length} capability the deal needs is unavailable: `
      + plan.blockedCapabilities.map((b) => `${b.what} (${b.reason})`).join('; '),
    );
  }

  let sentence: string;
  if (!plan.firstBroken && plan.waitingOn.length > 0) {
    const soonest = plan.waitingOn
      .filter((s) => s.deadline)
      .sort((a, b) => (a.deadline!.getTime() - b.deadline!.getTime()))[0];
    sentence =
      `Everything on our side of ${context.organisation} is done. We are waiting on them to `
      + `${lower(plan.waitingOn[0].nextAction ?? plan.waitingOn[0].completionCondition)}`
      + (soonest?.deadline ? `, and the window closes ${soonest.deadline.toISOString().slice(0, 10)}.` : '.');
  } else if (!plan.firstBroken) {
    sentence = `${context.organisation} is finished — every step has the evidence it needs.`;
  } else if (done === 0) {
    sentence =
      `Nothing has happened with ${context.organisation} yet. The first thing needed is `
      + `${lower(plan.firstBroken.nextAction ?? plan.firstBroken.label)}`;
  } else {
    sentence =
      `${context.organisation} is ${done} of ${total} steps in, held up at `
      + `${lower(plan.firstBroken.label)}: ${lower(plan.firstBroken.because)}`;
  }

  return {
    sentence,
    blocker: plan.firstBroken,
    waitingOn: plan.waitingOn,
    progress: plan.progress,
    reasoning,
  };
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// The money path
// ---------------------------------------------------------------------------

export type MoneyPath = {
  /** Each step from price to collected profit, and whether it is defensible. */
  steps: Array<{
    label: string;
    presentation: Presentation;
    /** What has to happen for this figure to exist or improve. */
    toConfirm: string | null;
  }>;
  /** True when every step rests on confirmed or observed inputs. */
  defensible: boolean;
  /** One sentence about the money, whatever state it is in. */
  sentence: string;
};

/**
 * The path from a price to money that arrived, with nothing skipped.
 *
 * Shown as a path rather than four numbers in a row, because the interesting
 * thing is almost never the figure — it is which link is missing. A buyer
 * price with no provider cost behind it is not "a deal worth $4,200 with some
 * detail outstanding"; it is a number with nothing under it, and the page now
 * says which link is broken instead of printing the number and hoping.
 */
export function moneyPath(input: {
  buyerPrice: Evidenced<number>;
  providerCost: Evidenced<number>;
  grossProfit: Evidenced<number>;
  collected: Evidenced<number>;
}): MoneyPath {
  const steps = [
    { label: 'Buyer price', value: input.buyerPrice },
    { label: 'Provider cost', value: input.providerCost },
    { label: 'Gross profit', value: input.grossProfit },
    { label: 'Collected', value: input.collected },
  ].map(({ label, value }) => ({
    label,
    presentation: presentMoney(value),
    toConfirm: value.toConfirm,
  }));

  const defensible = steps.every((s) => s.presentation.show);
  const firstMissing = steps.find((s) => !s.presentation.show);

  return {
    steps,
    defensible,
    sentence: defensible
      ? 'Every figure here rests on a real price and a real cost. This is a defensible number.'
      : firstMissing
        ? `There is no defensible money on this deal yet: ${lower(
            firstMissing.presentation.show ? '' : firstMissing.presentation.instead,
          )}`
        : 'No money has been established.',
  };
}
