import type { CallDisposition } from '@prisma/client';

/**
 * The disposition list, importable by a client component.
 *
 * Separate from `outreach.ts` because that module imports the Prisma client,
 * and a browser bundle must not pull a database driver in behind a constant.
 */
export const DISPOSITIONS: Array<{ value: CallDisposition; label: string; group: string }> = [
  { value: 'NO_ANSWER', label: 'No answer', group: 'Nobody reached' },
  { value: 'LEFT_VOICEMAIL', label: 'Left voicemail', group: 'Nobody reached' },
  { value: 'GATEKEEPER', label: 'Gatekeeper', group: 'Nobody reached' },
  { value: 'WRONG_NUMBER', label: 'Wrong number', group: 'Nobody reached' },
  { value: 'REACHED_DECISION_MAKER', label: 'Reached decision-maker', group: 'Spoke to someone' },
  { value: 'INTERESTED', label: 'Interested', group: 'Spoke to someone' },
  { value: 'NEEDS_INFORMATION', label: 'Needs information', group: 'Spoke to someone' },
  { value: 'FOLLOW_UP', label: 'Follow up later', group: 'Spoke to someone' },
  { value: 'QUALIFIED_OPPORTUNITY', label: 'Qualified opportunity', group: 'Outcome' },
  { value: 'ALREADY_HANDLED', label: 'Already handled', group: 'Outcome' },
  { value: 'NOT_INTERESTED', label: 'Not interested', group: 'Outcome' },
  { value: 'BAD_FIT', label: 'Bad fit', group: 'Outcome' },
  { value: 'DO_NOT_CONTACT', label: 'Do not contact', group: 'Outcome' },
];
