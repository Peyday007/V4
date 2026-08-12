import type { ReactNode } from 'react';
import '../globals.css';

/**
 * The caller workspace shell.
 *
 * Its own layout on purpose, outside the `(app)` group. The admin navigation
 * lists companies, providers, analytics and settings — none of which a caller
 * may open — and a shell that renders links to them invites the attempt and
 * makes the boundary look like a suggestion.
 */
export const metadata = { title: 'Work' };

export default function WorkLayout({ children }: { children: ReactNode }) {
  return (
    <div className="container" style={{ maxWidth: '64rem', paddingTop: '1.5rem' }}>
      {children}
    </div>
  );
}
