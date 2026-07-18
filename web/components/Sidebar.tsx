'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, clearSession, type Session } from '@/lib/api-client';
import { useLocaleStrings } from '@/lib/i18n';

interface NavLink {
  href: string;
  labelKey: string;
  label: string;
  adminOnly?: boolean;
}

// RT-097 — same canonical nav RT-095/RT-096 built for TopBar, now rendered
// as a collapsible/drawer sidebar instead of a top nav bar (user request,
// 2026-07-18: "dashboard model", not a top bar). RT-091 — labelKey looks up
// a real translation via useLocaleStrings(); label is the English fallback,
// shown as-is while the translation loads or if one isn't available yet.
const NAV_LINKS: NavLink[] = [
  { href: '/dashboard', labelKey: 'nav.dashboard', label: 'Dashboard' },
  { href: '/agents', labelKey: 'nav.agents', label: 'Agents' },
  { href: '/skills', labelKey: 'nav.skills', label: 'Skills' },
  { href: '/skill-proposals', labelKey: 'nav.skillProposals', label: 'Skill Proposals' },
  { href: '/marketplace', labelKey: 'nav.marketplace', label: 'Marketplace' },
  { href: '/approvals', labelKey: 'nav.approvals', label: 'Approvals' },
  { href: '/workflows', labelKey: 'nav.workflows', label: 'Workflows' },
  { href: '/webhooks', labelKey: 'nav.webhooks', label: 'Webhooks' },
  { href: '/outcomes', labelKey: 'nav.outcomes', label: 'Outcomes' },
  { href: '/audit', labelKey: 'nav.auditLog', label: 'Audit Log' },
  { href: '/workspaces', labelKey: 'nav.workspaces', label: 'Workspaces', adminOnly: true },
  { href: '/users', labelKey: 'nav.users', label: 'Users', adminOnly: true },
  { href: '/roles', labelKey: 'nav.roles', label: 'Roles & Permissions', adminOnly: true },
  { href: '/policies', labelKey: 'nav.policies', label: 'Policies', adminOnly: true },
  { href: '/settings', labelKey: 'nav.settings', label: 'Settings' },
];

const COLLAPSE_KEY = 'o2n-sidebar-collapsed';
const EXPANDED_WIDTH = '240px';
const COLLAPSED_WIDTH = '64px';

export function Sidebar({ session }: { session: Session }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAdmin = session.role === 'admin';

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // RT-030 — branding logo, shown in place of the org name text when set.
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  // RT-091 — real nav-label translation. Sidebar is mounted fresh on every
  // page (each page renders its own <Sidebar>, there's no shared layout), so
  // this is computed independently here rather than threaded through props —
  // same pattern every page already uses for its own effectiveLanguage.
  const [language, setLanguage] = useState('en');
  const t = useLocaleStrings(language);

  useEffect(() => {
    Promise.all([api.getOrganization(), api.getMe()])
      .then(([org, me]) => {
        setLogoUrl(org.logoDarkUrl ?? org.logoLightUrl ?? null);
        setLanguage(me.language ?? org.language);
      })
      .catch(() => {}); // best-effort — the sidebar works fine with just the org name / English nav labels
  }, []);

  // Desktop collapse state persists across visits; mobile drawer never does
  // (it always starts closed — a persisted "open" would just be a stuck
  // overlay on next load).
  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--sidebar-width',
      collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
    );
  }, [collapsed]);

  // RT-100 — content shouldn't reserve space for the sidebar on mobile,
  // since there it's an overlay drawer, not a push-content column.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    function apply() {
      document.documentElement.style.setProperty(
        '--sidebar-content-offset',
        mq.matches ? '0px' : 'var(--sidebar-width)',
      );
    }
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [collapsed]);

  // Close the mobile drawer on navigation — otherwise it stays open over the new page.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      return next;
    });
  }

  function handleLogout() {
    clearSession();
    router.push('/login');
  }

  const links = NAV_LINKS.filter((link) => !link.adminOnly || isAdmin);

  return (
    <>
      <button
        className="sidebar-mobile-toggle secondary"
        aria-label={t('nav.openMenu', 'Open menu')}
        onClick={() => setMobileOpen(true)}
      >
        ☰
      </button>

      {mobileOpen ? (
        <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />
      ) : null}

      <aside className={`sidebar${mobileOpen ? ' sidebar-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}`}>
        <div className="sidebar-header">
          {!collapsed ? (
            logoUrl ? (
              <img src={logoUrl} alt={session.organizationName} style={{ maxHeight: 28, maxWidth: 140 }} />
            ) : (
              <strong>{session.organizationName}</strong>
            )
          ) : null}
          <button
            className="sidebar-collapse-toggle secondary"
            onClick={toggleCollapsed}
            title={collapsed ? t('nav.expandSidebar', 'Expand sidebar') : t('nav.collapseSidebar', 'Collapse sidebar')}
            aria-label={collapsed ? t('nav.expandSidebar', 'Expand sidebar') : t('nav.collapseSidebar', 'Collapse sidebar')}
          >
            {collapsed ? '»' : '«'}
          </button>
        </div>

        <nav className="sidebar-nav">
          {links.map((link) => {
            const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
            const label = t(link.labelKey, link.label);
            return (
              <Link
                key={link.href}
                href={link.href}
                title={label}
                className={`sidebar-link${active ? ' sidebar-link-active' : ''}`}
              >
                {collapsed ? label.slice(0, 2).toUpperCase() : label}
              </Link>
            );
          })}
        </nav>

        <button className="secondary sidebar-signout" onClick={handleLogout}>
          {collapsed ? '⏻' : t('nav.signOut', 'Sign out')}
        </button>
      </aside>
    </>
  );
}
