export interface Lead {
  id: number;
  name: string;
  business_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  source: string | null;
  status: string;
  notes: string | null;
  follow_up_date: string | null;
  converted_contact_id: number | null;
  converted_contact_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: number;
  name: string;
  business: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  contact_type: string;
  status: string;
  notes: string | null;
  last_contacted_date: string | null;
  next_follow_up_date: string | null;
  project_count: number;
  created_at: string;
  updated_at: string;
}

export interface ReferralPartner {
  id: number;
  name: string;
  company: string | null;
  industry: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
  referrals_sent: number;
  referrals_received: number;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: number;
  name: string;
  contact_id: number | null;
  contact_name: string | null;
  contact_business: string | null;
  status: string;
  start_date: string | null;
  due_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: number;
  title: string;
  date: string;
  time: string | null;
  event_type: string;
  contact_id: number | null;
  contact_name: string | null;
  project_id: number | null;
  project_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: number;
  title: string;
  body: string | null;
  /** JSON-encoded array of strings. Use `parseTags` to read it. */
  tags: string;
  contact_id: number | null;
  contact_name: string | null;
  lead_id: number | null;
  lead_name: string | null;
  project_id: number | null;
  project_name: string | null;
  ebay_category_id: number | null;
  ebay_category_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface EbayCategory {
  id: number;
  slug: string;
  group_name: string;
  name: string;
  sort_order: number;
}

export interface EbayListing {
  id: number;
  category_id: number;
  category_slug: string;
  category_name: string;
  category_group: string;
  item_id: string | null;
  title: string;
  sold_price: number | null;
  shipping_price: number | null;
  total_price: number | null;
  sold_date: string | null;
  condition: string | null;
  image_url: string | null;
  item_url: string | null;
  source_page: string | null;
  imported_at: string;
}

export interface EbayStats {
  count: number;
  total: number;
  average: number | null;
  median: number | null;
  lowest: number | null;
  highest: number | null;
}

export interface DashboardFollowUp {
  kind: 'lead' | 'contact';
  id: number;
  label: string;
  detail: string | null;
  due_date: string;
  status: string;
}

export interface DashboardData {
  today: string;
  metrics: {
    open_leads: number;
    active_clients: number;
    active_projects: number;
    follow_ups_due: number;
    upcoming_events: number;
    imported_listings: number;
  };
  follow_ups: DashboardFollowUp[];
  upcoming_events: Array<
    Pick<CalendarEvent, 'id' | 'title' | 'date' | 'time' | 'event_type'> & {
      contact_name: string | null;
      project_name: string | null;
    }
  >;
  active_projects: Array<
    Pick<Project, 'id' | 'name' | 'status' | 'due_date'> & {
      contact_name: string | null;
    }
  >;
  totals: Record<string, number>;
  is_empty: boolean;
}

export interface AppInfo {
  name: string;
  tagline: string;
  version: string;
  node_version: string;
  database_path: string;
  started_at: string;
  uptime_seconds: number;
}

export type OptionLists = Record<string, string[]>;
