/**
 * A business's own location, and where it may not come from.
 *
 * Four connectors independently wrote the same fallback:
 *
 *     location: [city, state].filter(Boolean).join(', ') || marketName
 *
 * `marketName` is the search scope — the metro anchor a query was centred on,
 * or the market a run was pointed at. When the source omitted the address, every
 * record in that batch inherited the anchor, so a board of businesses in twelve
 * states all displayed one city, and displayed it as confidently as a real one.
 * That is worse than showing nothing: null is visibly unknown, while a
 * plausible wrong city is acted on.
 *
 * The rule is that a business's location comes from the record or is absent.
 * `parseAddress` exists so "absent" stays rare: a formatted address string is
 * still the source describing the business, and parsing it recovers the street
 * line too, which is a deduplication key the connectors were discarding.
 */

import { cleanCity, cleanState } from './identity';

export type ParsedAddress = {
  line1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

const EMPTY: ParsedAddress = { line1: null, city: null, state: null, postalCode: null };

/**
 * Splits a US formatted address into parts.
 *
 * Handles the shapes the sources actually return:
 *   "1200 Main St, Dallas, TX 75201, USA"
 *   "1200 Main St Ste 400, Dallas, TX 75201"
 *   "Dallas, TX"
 *
 * Every part is validated rather than trusted, so a house number cannot end up
 * in the city field — which is how "633" was once shown as a lead's location.
 */
export function parseAddress(formatted: string | null | undefined): ParsedAddress {
  if (!formatted) return EMPTY;

  const parts = formatted
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^(usa|united states)$/i.test(p));

  if (parts.length === 0) return EMPTY;

  // The trailing part is normally "TX 75201" or just "TX".
  const tail = parts[parts.length - 1];
  const tailMatch = tail.match(/^([A-Za-z]{2})\s*(\d{5}(?:-\d{4})?)?$/);

  let state: string | null = null;
  let postalCode: string | null = null;
  let remaining = parts;

  if (tailMatch) {
    state = cleanState(tailMatch[1]);
    postalCode = tailMatch[2] ?? null;
    remaining = parts.slice(0, -1);
  } else {
    // Some sources append the postcode as its own part.
    const zipOnly = tail.match(/^\d{5}(?:-\d{4})?$/);
    if (zipOnly && parts.length >= 2) {
      postalCode = tail;
      const maybeState = cleanState(parts[parts.length - 2]);
      if (maybeState) {
        state = maybeState;
        remaining = parts.slice(0, -2);
      } else {
        remaining = parts.slice(0, -1);
      }
    }
  }

  const city = remaining.length > 0 ? cleanCity(remaining[remaining.length - 1]) : null;
  const line1 = remaining.length > 1 ? remaining.slice(0, -1).join(', ') : null;

  return { line1, city, state, postalCode };
}

/**
 * The location string a record carries downstream.
 *
 * Returns undefined rather than a market name when the source said nothing.
 * There is no parameter here for a fallback, which is the point: a caller
 * cannot pass the search scope in even by accident.
 */
export function recordLocation(city: string | null | undefined, state: string | null | undefined): string | undefined {
  const parts = [cleanCity(city), cleanState(state)].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}
