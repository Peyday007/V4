import type { SignalCategory } from '@prisma/client';

/**
 * The signal catalogue from the operating spec, expressed as auditable
 * detectors. Each detector reports which phrases fired, so a reviewer can see
 * why a signal was raised and challenge it.
 */
export type SignalDefinition = {
  key: string;
  category: SignalCategory;
  label: string;
  /** Baseline strength when the signal fires, before evidence adjustments. */
  strength: number;
  patterns: RegExp[];
};

export const SIGNAL_CATALOGUE: SignalDefinition[] = [
  // --- Subcontracting -----------------------------------------------------
  { key: 'recent_contract_award', category: 'SUBCONTRACTING', label: 'Company recently won a contract', strength: 0.8, patterns: [/award(ed)?\s+(a\s+)?(\$[\d,]+\s+)?contract/i, /has been awarded/i, /contract award/i] },
  { key: 'multi_trade_project', category: 'SUBCONTRACTING', label: 'Project requires multiple trades', strength: 0.7, patterns: [/multi[- ]trade/i, /scope of work covers[^.]*,[^.]*,/i, /electrical[^.]*mechanical/i] },
  { key: 'new_region_entry', category: 'SUBCONTRACTING', label: 'Prime contractor entering a new region', strength: 0.7, patterns: [/expanding into the [\w\s,]+ markets?/i, /new (region|territory|market)/i, /entering the [\w\s]+ market/i] },
  { key: 'local_coverage_gap', category: 'SUBCONTRACTING', label: 'Provider needs local coverage', strength: 0.85, patterns: [/local (fulfillment|field service|service) partners?/i, /where it has no technicians/i, /local coverage/i, /outsource onsite/i] },
  { key: 'heavy_hiring', category: 'SUBCONTRACTING', label: 'Contractor hiring unusually heavily', strength: 0.6, patterns: [/hiring \d+/i, /posted \d+ openings/i, /rapid backlog growth/i] },
  { key: 'capacity_constraint', category: 'SUBCONTRACTING', label: 'Overflow or capacity constraint mentioned', strength: 0.85, patterns: [/overflow/i, /capacity constraint/i, /at capacity/i, /cannot keep up/i, /backlog/i] },
  { key: 'subcontracting_goal', category: 'SUBCONTRACTING', label: 'Contract includes subcontracting participation goals', strength: 0.75, patterns: [/subcontracting goal/i, /small business participation/i, /\b(sbe|mbe|wbe|dbe)\b\s*goal/i, /\d+%\s*small business/i] },
  { key: 'recurring_outsourced_service', category: 'SUBCONTRACTING', label: 'Facility has recurring outsourced-service needs', strength: 0.65, patterns: [/recurring (janitorial|cleaning|maintenance|service)/i, /outsourced service/i, /vendor performance across/i] },
  { key: 'crew_loss', category: 'SUBCONTRACTING', label: 'Business recently lost employees or crews', strength: 0.8, patterns: [/lost (crews?|employees|staff)/i, /staffing shortage/i, /short[- ]staffed/i] },
  { key: 'emergency_coverage', category: 'SUBCONTRACTING', label: 'Company needs emergency coverage', strength: 0.9, patterns: [/emergency (coverage|service|call)/i, /urgent(ly)? need/i, /immediate(ly)? need/i] },
  { key: 'incumbent_underperforming', category: 'SUBCONTRACTING', label: 'Incumbent subcontractor underperforming', strength: 0.9, patterns: [/incumbent[^.]*underperform/i, /missed (shifts|deliveries|deadlines)/i, /poor (service|quality)/i, /repeated (complaints|issues)/i] },
  { key: 'capability_gap', category: 'SUBCONTRACTING', label: 'Work requires a capability the prime lacks internally', strength: 0.75, patterns: [/rather than in-house/i, /does not (self[- ]perform|have in[- ]house)/i, /will (outsource|subcontract)/i] },

  // --- Brokerage ----------------------------------------------------------
  { key: 'specific_purchasing_need', category: 'BROKERAGE', label: 'Buyer has a specific purchasing need', strength: 0.85, patterns: [/request(ing|s)? (delivered )?(pricing|quotes?)/i, /\brfq\b/i, /requires? approximately [\d,]+/i] },
  { key: 'excess_inventory', category: 'BROKERAGE', label: 'Supplier has excess inventory or unused capacity', strength: 0.8, patterns: [/surplus (stockpile|inventory)/i, /excess inventory/i, /unused capacity/i, /available capacity/i] },
  { key: 'supplier_missed_delivery', category: 'BROKERAGE', label: 'Current supplier missed delivery', strength: 0.9, patterns: [/missed deliver(y|ies)/i, /late deliver(y|ies)/i, /stockouts?/i, /out of stock/i] },
  { key: 'freight_constraint', category: 'BROKERAGE', label: 'Freight or availability limits existing sources', strength: 0.7, patterns: [/freight is the constraint/i, /\d+ miles (out|away)/i, /delivered pricing/i, /lead time/i] },
  { key: 'territory_expansion', category: 'BROKERAGE', label: 'Company expanding into a new territory', strength: 0.6, patterns: [/expansion/i, /will open a/i, /new (facility|location|warehouse)/i] },
  { key: 'multiple_quotes_requested', category: 'BROKERAGE', label: 'Buyer is requesting multiple quotes', strength: 0.85, patterns: [/multiple quotes/i, /requesting quotes from/i, /seeking quotes/i] },
  { key: 'time_sensitive_shortage', category: 'BROKERAGE', label: 'Time-sensitive shortage exists', strength: 0.9, patterns: [/shortage/i, /required by \d{4}-\d{2}-\d{2}/i, /first deliveries required/i] },

  // --- Distribution -------------------------------------------------------
  { key: 'repeat_purchases', category: 'DISTRIBUTION', label: 'Repeat purchases identified', strength: 0.8, patterns: [/recurring (order|purchase|suppl(y|ies))/i, /standing order/i, /per month/i, /monthly/i] },
  { key: 'multi_branch_buying', category: 'DISTRIBUTION', label: 'Multiple branches buying the same products', strength: 0.8, patterns: [/across \d+ (properties|locations|branches|sites)/i, /multi[- ](site|location)/i, /portfolio/i] },
  { key: 'new_facility_opening', category: 'DISTRIBUTION', label: 'New facility opening', strength: 0.6, patterns: [/new (facility|office|location) (opening|openings)/i, /third (office|location)/i, /certificate of occupancy/i] },
  { key: 'supplier_complaints', category: 'DISTRIBUTION', label: 'Current-supplier complaints', strength: 0.9, patterns: [/current supplier has had/i, /repeated (stockouts|issues|problems)/i, /complaints? about/i] },
  { key: 'price_sensitivity', category: 'DISTRIBUTION', label: 'Price sensitivity', strength: 0.7, patterns: [/price increase/i, /\d+% (price )?increase/i, /pricing complaint/i, /cost pressure/i] },
  { key: 'vendor_consolidation', category: 'DISTRIBUTION', label: 'Consolidation of vendors', strength: 0.85, patterns: [/consolidate vendors/i, /vendor consolidation/i, /one accountable vendor/i, /single vendor/i, /consolidated invoicing/i] },
  { key: 'scheduled_delivery_need', category: 'DISTRIBUTION', label: 'Need for scheduled or recurring delivery', strength: 0.7, patterns: [/scheduled deliver(y|ies)/i, /recurring deliver(y|ies)/i, /next[- ]day delivery/i] },
  { key: 'product_substitution', category: 'DISTRIBUTION', label: 'Product substitutions occurring', strength: 0.6, patterns: [/substitution/i, /substitute product/i] },
];

export type DetectedSignal = {
  definition: SignalDefinition;
  matches: string[];
  strength: number;
};

/** Runs every detector over one piece of source text. */
export function detectSignals(text: string): DetectedSignal[] {
  const detected: DetectedSignal[] = [];
  for (const definition of SIGNAL_CATALOGUE) {
    const matches: string[] = [];
    for (const pattern of definition.patterns) {
      const match = pattern.exec(text);
      if (match) matches.push(match[0].trim());
    }
    if (matches.length > 0) {
      // Multiple independent phrases firing is stronger evidence than one.
      const strength = Math.min(1, definition.strength + (matches.length - 1) * 0.05);
      detected.push({ definition, matches, strength });
    }
  }
  return detected.sort((a, b) => b.strength - a.strength);
}

export function signalLabel(key: string): string {
  return SIGNAL_CATALOGUE.find((s) => s.key === key)?.label ?? key;
}
