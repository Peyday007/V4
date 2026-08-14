import { Badge } from './ui';
import { CLASS_BADGE } from '@/lib/evidence/claims';
import type { Presentation } from '@/lib/evidence/class';

/**
 * A graded figure, rendered the same way everywhere.
 *
 * The opportunity page proved the rule works; the fault was that every other
 * screen printed raw floats beside it, so the same deal read "not yet
 * defensible" on one page and "10% · 35%" on the next. A server component
 * rather than a client one, because none of these need state and the pages
 * that show them are server-rendered.
 *
 * Two presentations, one rule: a supported figure gets its number and a class
 * badge; an unsupported one gets the sentence saying what is missing. Never a
 * dash, never a zero, and never a number with a caveat beside it — a number
 * with a caveat is still a number and gets read as one.
 */
export function Figure({
  presentation,
  explain = false,
  prefix,
}: {
  presentation: Presentation;
  /** Show the provenance line under a figure that is shown. */
  explain?: boolean;
  /** A short label rendered before the value, e.g. "Closes". */
  prefix?: string;
}) {
  if (presentation.show) {
    return (
      <span>
        {prefix && <span className="dim">{prefix} </span>}
        <strong>{presentation.label}</strong> <Badge>{CLASS_BADGE[presentation.evidence]}</Badge>
        {explain && <div className="tiny dim">{presentation.source}</div>}
      </span>
    );
  }
  return (
    <span className="dim small">
      {presentation.instead}
      {presentation.toConfirm && <div className="tiny mt"><strong>To fix:</strong> {presentation.toConfirm}</div>}
    </span>
  );
}

/**
 * The compact form for a card or a table cell.
 *
 * A board card has room for a fragment, so a suppressed figure is reduced to
 * the shortest true thing — "no closing rate yet" — with the full sentence one
 * click away on the record. Truncating the explanation is acceptable; printing
 * a fabricated number in the space it would have taken is not.
 */
export function FigureChip({ presentation, prefix }: { presentation: Presentation; prefix?: string }) {
  if (presentation.show) {
    return <span className="dim">{prefix ? `${prefix} ` : ''}{presentation.label}</span>;
  }
  return <span className="dim" title={presentation.instead}>{shorten(presentation)}</span>;
}

/**
 * A headline tile, which is where the fabrication was loudest.
 *
 * The tile shape itself was the problem: a big number over a small label over a
 * progress meter reads as a measurement whatever is underneath it, so a
 * suppressed figure cannot be squeezed into the same shape with the number
 * greyed out. When there is nothing to show the tile becomes the sentence.
 *
 * No meter. A bar filled to 10% of its width is the same claim as "10%" made
 * again in a form that cannot carry a caveat, and it was sitting under every
 * one of these numbers.
 */
export function GradedStat({ label, presentation }: { label: string; presentation: Presentation }) {
  if (!presentation.show) {
    return (
      <div className="stat" data-testid={`stat-${slug(label)}`} data-shown="false">
        <div className="stat-label">{label}</div>
        <div className="small dim" style={{ lineHeight: 1.45 }}>{presentation.instead}</div>
        {presentation.toConfirm && <div className="tiny mt"><strong>To fix:</strong> {presentation.toConfirm}</div>}
      </div>
    );
  }
  return (
    <div className="stat" data-testid={`stat-${slug(label)}`} data-shown="true">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{presentation.label}</div>
      <div className="tiny dim">
        <Badge>{CLASS_BADGE[presentation.evidence]}</Badge> {presentation.source}
      </div>
    </div>
  );
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function shorten(presentation: Extract<Presentation, { show: false }>): string {
  const first = presentation.instead.split(/(?<=\.)\s/)[0] ?? presentation.instead;
  return first.length > 70 ? `${first.slice(0, 67)}…` : first;
}
