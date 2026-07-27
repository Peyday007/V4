import { prisma } from '@/lib/db';

/**
 * Infers which configured capabilities a piece of source or call text is
 * asking for.
 *
 * This is what makes matching possible: a buyer need with no required
 * capabilities cannot be matched against anything, and the AI must not invent
 * requirements. So the inference runs strictly against the administrator's own
 * capability catalogue — it can only ever return capabilities the operation
 * has chosen to work in.
 */

/** Extra phrasing that maps onto a capability but would not match its name. */
const SYNONYMS: Record<string, string[]> = {
  commercial_janitorial: ['janitorial', 'cleaning', 'custodial', 'housekeeping', 'porter'],
  post_construction_cleaning: ['construction cleaning', 'post-construction', 'final clean', 'punch clean'],
  day_porter: ['day porter', 'porter service'],
  commercial_electrical: ['electrical', 'electric', 'service upgrade', 'lighting', 'power distribution'],
  mechanical_hvac: ['mechanical', 'hvac', 'heating', 'ventilation', 'air conditioning'],
  drywall: ['drywall', 'finishes', 'gypsum', 'taping'],
  flooring: ['flooring', 'floor covering', 'carpet', 'vct', 'lvt'],
  sitework_grading: ['sitework', 'site work', 'grading', 'excavation', 'earthwork'],
  it_field_service: ['it field', 'field service', 'break-fix', 'break fix', 'smart hands', 'onsite it', 'desk side'],
  structured_cabling: ['cabling', 'structured cabling', 'low voltage'],
  last_mile_delivery: ['last-mile', 'last mile', 'local delivery', 'courier', 'fulfillment partner'],
  aggregate_supply: ['aggregate', 'crushed stone', 'crushed limestone', 'base material', '#57', '#304', 'gravel'],
  janitorial_supply: ['janitorial supplies', 'consumables', 'can liners', 'hand towels', 'restroom tissue', 'floor care', 'facility supplies'],
};

export async function inferRequiredCapabilities(orgId: string, text: string): Promise<string[]> {
  const catalogue = await prisma.capability.findMany({ where: { orgId }, select: { key: true, name: true } });
  const haystack = text.toLowerCase();
  const matched: string[] = [];

  for (const capability of catalogue) {
    const terms = [capability.name.toLowerCase(), capability.key.replace(/_/g, ' '), ...(SYNONYMS[capability.key] ?? [])];
    if (terms.some((term) => term.length > 2 && haystack.includes(term))) {
      matched.push(capability.name.toLowerCase());
    }
  }
  return [...new Set(matched)];
}

/**
 * Builds a readable scope line from source evidence.
 *
 * The scope has to describe the work, not the discovery process — "Company X
 * surfaced 3 signals" is metadata, and pricing against it would be nonsense.
 */
export function deriveScopeFromEvidence(input: {
  signalDetail?: string | null;
  evidenceExcerpt?: string | null;
  evidenceTitle?: string | null;
  opportunityName?: string | null;
}): string {
  const excerpt = input.evidenceExcerpt?.trim();
  if (excerpt && excerpt.length > 40) {
    // First two sentences of the source record carry the actual requirement.
    const sentences = excerpt.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
    return sentences.slice(0, 600);
  }
  if (input.evidenceTitle && input.evidenceTitle.length > 15) return input.evidenceTitle;
  if (input.signalDetail) return input.signalDetail.split('. Matched:')[0].slice(0, 600);
  return input.opportunityName ?? 'Scope not yet established';
}
