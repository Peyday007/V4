'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLink({
  href,
  children,
  count,
  alert,
  note,
}: {
  href: string;
  children: React.ReactNode;
  count?: number;
  alert?: boolean;
  /** Short word shown in place of a count — for states that are not quantities. */
  note?: string;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link href={href} className={`nav-link${active ? ' active' : ''}`}>
      <span>{children}</span>
      {count !== undefined && count > 0 && <span className={`nav-count${alert ? ' alert' : ''}`}>{count}</span>}
      {count === undefined && note && <span className={`nav-count${alert ? ' alert' : ''}`}>{note}</span>}
    </Link>
  );
}
