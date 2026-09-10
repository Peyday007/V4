import type { BrainLink } from '@prisma/client';
import { Badge } from '@/components/ui';

/**
 * Brain's view of one record, in a table cell.
 *
 * The board reads the cached row rather than asking Brain per record: three
 * hundred rows would be three hundred round trips, and a board that took ten
 * seconds to render would be worse than one that is a minute behind. What it
 * must not do is pretend the cache is live — so a row Brain has never answered
 * about says exactly that, and a row nobody has asked Brain about says that.
 *
 * There is no button here. Asking Brain to look at something is a decision
 * taken on the record, with its reason in front of you, not from a list.
 */

const STATE_LABEL: Record<string, string> = {
  NOT_EVALUATED: 'Not evaluated',
  QUEUED: 'On the list',
  IN_PROGRESS: 'Researching',
  NEEDS_PERSON: 'Needs a person',
  COMPLETED: 'Finished',
  FAILED: 'Stopped',
};

const STATE_TONE: Record<string, string> = {
  QUEUED: 'accent',
  IN_PROGRESS: 'accent',
  NEEDS_PERSON: 'warning',
  COMPLETED: 'success',
  FAILED: 'danger',
};

export function brainColumnLabel(): string {
  return 'Brain';
}

export function BrainCell({ link }: { link: BrainLink | null }) {
  if (!link || !link.state) {
    return <span className="tiny dim">Not sent yet</span>;
  }
  const label = STATE_LABEL[link.state] ?? link.state;
  return (
    <>
      <Badge tone={STATE_TONE[link.state] ?? ''}>{label}</Badge>
      {link.priority && <div className="tiny dim">{link.priority}</div>}
    </>
  );
}
