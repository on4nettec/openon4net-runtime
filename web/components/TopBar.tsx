'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearSession, type Session } from '@/lib/api-client';

interface NavLink {
  href: string;
  label: string;
  adminOnly?: boolean;
}

// RT-095/RT-096 — canonical nav, replacing 16 separately hand-maintained
// (and inconsistent — some pages omitted admin gating, others omitted most
// links entirely) copies of this markup across every page.
const NAV_LINKS: NavLink[] = [
  { href: '/agents', label: 'Agents' },
  { href: '/skills', label: 'Skills' },
  { href: '/skill-proposals', label: 'Skill Proposals' },
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/workflows', label: 'Workflows' },
  { href: '/webhooks', label: 'Webhooks' },
  { href: '/outcomes', label: 'Outcomes' },
  { href: '/audit', label: 'Audit Log' },
  { href: '/workspaces', label: 'Workspaces', adminOnly: true },
  { href: '/users', label: 'Users', adminOnly: true },
  { href: '/roles', label: 'Roles & Permissions', adminOnly: true },
  { href: '/policies', label: 'Policies', adminOnly: true },
  { href: '/settings', label: 'Settings' },
];

export function TopBar({ session }: { session: Session }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAdmin = session.role === 'admin';

  function handleLogout() {
    clearSession();
    router.push('/login');
  }

  return (
    <div className="topbar">
      <strong>{session.organizationName}</strong>
      <nav>
        {NAV_LINKS.filter((link) => !link.adminOnly || isAdmin).map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              style={{
                color: active ? 'var(--color-foreground)' : 'var(--color-muted-foreground)',
                fontWeight: active ? 600 : 400,
              }}
            >
              {link.label}
            </Link>
          );
        })}
        <button className="secondary" onClick={handleLogout}>
          Sign out
        </button>
      </nav>
    </div>
  );
}
