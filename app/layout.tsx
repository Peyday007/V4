import type { Metadata } from 'next';
import './globals.css';

/**
 * Deployment marker — 2026-08-13.
 *
 * Vercel's most recent build of this branch was commit 29a4881, ten commits
 * behind the head, so `/api/cron/tick` and everything added in phases 0 to 6
 * were absent from the deployed application and the route answered 404.
 *
 * The cause was not a missing change to deploy — the ten skipped commits
 * rewrote hundreds of files under app/, lib/ and prisma/. It was `vercel.json`:
 * the commit immediately after 29a4881 added a ten-minute cron expression, and
 * the Hobby plan rejects any cron that fires more than once a day, at deploy
 * time. Every push after that was refused before it became a build. That entry
 * is gone and .github/workflows/cron-tick.yml drives the tick instead.
 *
 * This comment is the deploy trigger that accompanied the fix. Update the date
 * if a future deployment needs nudging.
 */

export const metadata: Metadata = {
  title: 'Deal Dispatch',
  description: 'AI-operated deal discovery and execution for subcontracting, brokerage and distribution.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
