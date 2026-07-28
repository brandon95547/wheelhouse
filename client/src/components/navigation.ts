import {
  Calendar,
  FolderKanban,
  Handshake,
  LayoutDashboard,
  PackageSearch,
  Settings,
  StickyNote,
  UserPlus,
  Users,
} from 'lucide-react';
import type { ComponentType } from 'react';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  /** Shown under the page title in the top bar. */
  description: string;
}

export const MAIN_NAV: NavItem[] = [
  {
    to: '/',
    label: 'Dashboard',
    icon: LayoutDashboard,
    description: 'A summary of the work currently in your wheelhouse.',
  },
  {
    to: '/leads',
    label: 'Leads',
    icon: UserPlus,
    description: 'Track potential work from first contact through to won or lost.',
  },
  {
    to: '/crm',
    label: 'CRM',
    icon: Users,
    description: 'Your contacts, clients and partners in one place.',
  },
  {
    to: '/ebay',
    label: 'eBay Research',
    icon: PackageSearch,
    description: 'Sold-listing data you import from eBay with the browser extension.',
  },
  {
    to: '/referral-partners',
    label: 'Referral Partners',
    icon: Handshake,
    description: 'People and businesses you exchange referrals with.',
  },
  {
    to: '/projects',
    label: 'Projects',
    icon: FolderKanban,
    description: 'Work in progress, who it is for and when it is due.',
  },
  {
    to: '/calendar',
    label: 'Calendar',
    icon: Calendar,
    description: 'Meetings, follow-ups, deadlines and reminders.',
  },
  {
    to: '/notes',
    label: 'Notes',
    icon: StickyNote,
    description: 'Anything worth writing down, tagged and searchable.',
  },
];

export const SETTINGS_NAV: NavItem = {
  to: '/settings',
  label: 'Settings',
  icon: Settings,
  description: 'Theme, browser extension setup and application data.',
};

export const ALL_NAV: NavItem[] = [...MAIN_NAV, SETTINGS_NAV];

/** Longest matching route wins, so /leads does not shadow /leads/whatever. */
export function navItemForPath(pathname: string): NavItem {
  const matches = ALL_NAV.filter(
    (item) => pathname === item.to || (item.to !== '/' && pathname.startsWith(item.to)),
  ).sort((a, b) => b.to.length - a.to.length);
  return matches[0] ?? MAIN_NAV[0];
}
