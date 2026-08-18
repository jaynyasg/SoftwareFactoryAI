'use client';

/**
 * AppShellNav — the persistent view switcher in the control-room header.
 * Every AppShell page gets bidirectional navigation between the two factory
 * surfaces (trunk test: "what are the major sections / where am I"). Client
 * component only for usePathname; links are plain <Link>s.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const VIEWS = [
  { href: '/', label: 'Factory floor' },
  { href: '/operator', label: 'Operator view' },
] as const;

export function AppShellNav() {
  const pathname = usePathname();
  return (
    <nav className="app-header__nav" aria-label="Factory views">
      {VIEWS.map((view) => {
        const active =
          view.href === '/' ? pathname === '/' : (pathname?.startsWith(view.href) ?? false);
        return (
          <Link
            key={view.href}
            href={view.href}
            className={`app-header__nav-link${active ? ' app-header__nav-link--active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {view.label}
          </Link>
        );
      })}
    </nav>
  );
}
