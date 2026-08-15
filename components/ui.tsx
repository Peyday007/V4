import type { ReactNode } from 'react';

export function money(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(value.toString());
  if (!Number.isFinite(n)) return fallback;
  return `$${Math.round(n).toLocaleString()}`;
}

export function pct(value: number | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return `${Math.round(value * 100)}%`;
}

export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export function relativeDays(date: Date | null | undefined): string {
  if (!date) return '—';
  const days = Math.round((Date.now() - date.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days > 0) return `${days}d ago`;
  return `in ${Math.abs(days)}d`;
}

export function dueLabel(date: Date | null | undefined): { text: string; overdue: boolean } {
  if (!date) return { text: 'No due date', overdue: false };
  const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, overdue: true };
  if (days === 0) return { text: 'Due today', overdue: false };
  return { text: `Due in ${days}d`, overdue: false };
}

const PRIORITY_TONE: Record<string, string> = {
  CRITICAL: 'critical',
  HIGH: 'warning',
  MEDIUM: 'accent',
  LOW: '',
};

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'accent',
  WAITING: '',
  BLOCKED: 'warning',
  ESCALATED: 'danger',
  WON: 'success',
  LOST: 'danger',
  DORMANT: '',
  DISQUALIFIED: '',
  OPEN: 'danger',
  ACKNOWLEDGED: 'warning',
  RESOLVED: 'success',
  DISMISSED: '',
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
};

const TYPE_TONE: Record<string, string> = {
  SUBCONTRACTING: 'accent',
  BROKERAGE: 'success',
  DISTRIBUTION: 'warning',
  HYBRID: '',
  UNCLASSIFIED: '',
};

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`badge${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  return <Badge tone={PRIORITY_TONE[priority]}>{priority}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status]}>{humanize(status)}</Badge>;
}

export function TypeBadge({ type }: { type: string }) {
  return <Badge tone={TYPE_TONE[type]}>{humanize(type)}</Badge>;
}

/*
 * There is no Meter component any more, and this note is here so nobody adds
 * one back.
 *
 * A bar filled to a tenth of its width makes exactly the same claim as "10%"
 * and makes it harder to argue with, because there is no figure on screen to
 * question. Every meter this product had sat on a score with a column default
 * underneath it, and the two that survived longest were on an account page
 * where they read as measurements of a relationship nobody had checked.
 *
 * Where a proportion genuinely needs showing, show the numerator and the
 * denominator — "3 of 11" is the same information, and it cannot be read as
 * more certain than it is.
 */

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
