import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ShipWheel,
  Sun,
  X,
} from 'lucide-react';
import { MAIN_NAV, SETTINGS_NAV, navItemForPath } from './navigation';
import type { NavItem } from './navigation';
import { useTheme } from '../hooks/useTheme';

const COLLAPSE_KEY = 'wheelhouse.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'true';
  } catch {
    return false;
  }
}

function SidebarLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        [
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          collapsed ? 'justify-center px-2' : '',
          isActive
            ? 'bg-primary-container text-primary-text'
            : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface',
        ].join(' ')
      }
    >
      <Icon className="size-4.5 shrink-0" aria-hidden="true" />
      <span className={collapsed ? 'sr-only' : 'truncate'}>{item.label}</span>
    </NavLink>
  );
}

export function AppLayout() {
  const location = useLocation();
  const { resolved, toggle } = useTheme();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  const current = navItemForPath(location.pathname);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, String(collapsed));
    } catch {
      /* Not persisting the sidebar state is harmless. */
    }
  }, [collapsed]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  useEffect(() => {
    document.title = `${current.label} · Wheelhouse`;
  }, [current.label]);

  /** One button drives the drawer on small screens and the rail on large ones. */
  const handleToggle = useCallback(() => {
    if (window.matchMedia('(min-width: 1024px)').matches) {
      setCollapsed((value) => !value);
    } else {
      setMobileOpen((value) => !value);
    }
  }, []);

  const sidebarBody = (
    <>
      <div
        className={`flex h-16 items-center gap-2.5 border-b border-outline-variant px-4 ${
          collapsed ? 'lg:justify-center lg:px-2' : ''
        }`}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-on-primary">
          <ShipWheel className="size-5" aria-hidden="true" />
        </span>
        <span className={collapsed ? 'lg:sr-only' : ''}>
          <span className="block text-sm font-semibold tracking-tight text-on-surface">
            Wheelhouse
          </span>
          <span className="block text-xs text-on-surface-muted">
            Your business command center.
          </span>
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-icon ml-auto lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <nav aria-label="Main" className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {MAIN_NAV.map((item) => (
          <SidebarLink
            key={item.to}
            item={item}
            collapsed={collapsed}
            onNavigate={() => setMobileOpen(false)}
          />
        ))}
        <div className="mt-auto border-t border-outline-variant pt-3">
          <SidebarLink
            item={SETTINGS_NAV}
            collapsed={collapsed}
            onNavigate={() => setMobileOpen(false)}
          />
        </div>
      </nav>
    </>
  );

  return (
    <div className="min-h-dvh">
      {/* Mobile drawer */}
      <div
        className={`fixed inset-0 z-50 lg:hidden ${mobileOpen ? '' : 'pointer-events-none'}`}
        aria-hidden={!mobileOpen}
      >
        <div
          className={`absolute inset-0 bg-scrim/50 transition-opacity ${
            mobileOpen ? 'opacity-100' : 'opacity-0'
          }`}
          onClick={() => setMobileOpen(false)}
        />
        <aside
          className={`absolute inset-y-0 left-0 flex w-72 flex-col border-r border-outline-variant bg-surface transition-transform ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {sidebarBody}
        </aside>
      </div>

      {/* Desktop sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-outline-variant bg-surface lg:flex ${
          collapsed ? 'w-16' : 'w-64'
        }`}
      >
        {sidebarBody}
      </aside>

      <div className={collapsed ? 'lg:pl-16' : 'lg:pl-64'}>
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-outline-variant bg-surface/95 px-4 backdrop-blur-sm sm:px-6">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={handleToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
          >
            <Menu className="size-5 lg:hidden" aria-hidden="true" />
            {collapsed ? (
              <PanelLeftOpen className="hidden size-5 lg:block" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="hidden size-5 lg:block" aria-hidden="true" />
            )}
          </button>

          <h1 className="truncate text-lg font-semibold tracking-tight text-on-surface">
            {current.label}
          </h1>

          <button
            type="button"
            className="btn btn-ghost btn-icon ml-auto"
            onClick={toggle}
            aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`}
          >
            {resolved === 'dark' ? (
              <Sun className="size-5" aria-hidden="true" />
            ) : (
              <Moon className="size-5" aria-hidden="true" />
            )}
          </button>
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Outlet context={{ description: current.description }} />
        </main>
      </div>
    </div>
  );
}
