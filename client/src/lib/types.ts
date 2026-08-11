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

/* The brand book, split by WHERE THE PICKUP SIGNAL LIVES. `rare` means the brand itself
   is the signal — seeing the label is reason enough. `common` means the specific model
   is the signal: the label is worthless by default and only certain models, lines,
   materials, vintages, collaborations or editions pay, which is why a common brand
   always carries a `look_for`. `unsorted` is what an import found that no guide has
   judged — or judged common without being able to say what to look for. */
export type BrandTier = 'rare' | 'common' | 'unsorted' | 'not_worthy';
export type ModelVerdict = 'worthy' | 'not_worthy';

export interface EbayBrandModel {
  id: number;
  slug: string;
  name: string;
  verdict: ModelVerdict;
  verdict_source: string;
  sold_count: number;
  median_price: number | null;
  high_price: number | null;
  notes: string | null;
}

export interface EbayBrand {
  id: number;
  /* A brand is judged inside one category. "Nike" under Men/Shoes and "Nike" under
     Men/Shirts are separate rows with separate tiers and separate models. */
  category_id: number;
  category_slug: string;
  category_name: string;
  category_group: string;
  slug: string;
  name: string;
  tier: BrandTier;
  tier_source: string;
  /** What to look for. Always set on a common brand; always null on a rare one. */
  look_for: string | null;
  /** Pinned by the user: re-scoring skips it and deletion refuses it. */
  locked: number;
  kind: string | null;
  sold_count: number;
  rejected_count: number;
  median_price: number | null;
  high_price: number | null;
  notes: string | null;
  first_seen: string;
  last_seen: string;
  models: EbayBrandModel[];
}

export interface EbayBrandBook {
  brands: EbayBrand[];
  counts: { rare: number; common: number; unsorted: number; not_worthy: number };
}

/* What `POST /ebay/brands/import` did with a paste. Every row it could not file comes back
   in `problems`, worded for the person who wrote it — a bulk write that reported only a
   total would be indistinguishable from one that quietly dropped half the input. */
export interface BrandPasteResult {
  created: number;
  updated: number;
  untouched: number;
  locked: number;
  models: number;
  attributed: number;
  problems: string[];
  category: { slug: string; name: string; group: string };
  message: string;
}

/* What the sold-price evidence says about a brand. Rank statistics only — see
   server/src/lib/brand-strength.ts for why the mean is never used. */
export interface BrandStats {
  sampleSize: number;
  median: number | null;
  lowerQuartile: number | null;
  topDecile: number | null;
  shareAt: Record<'40' | '50' | '60' | '100', number>;
  strength: 'rare' | 'common' | 'weak' | 'thin';
  confident: boolean;
  reason: string;
}

export interface MinedModel {
  name: string;
  hits: number;
  coverage: number;
  lift: number;
  medianPrice: number | null;
}

export interface BrandProposal {
  brandId: number;
  name: string;
  currentTier: BrandTier;
  proposedTier: BrandTier;
  changed: boolean;
  locked: boolean;
  stats: BrandStats;
  models: MinedModel[];
  lookFor: string | null;
}

export interface BrandAnalysis {
  gates: {
    rare: {
      medianAtLeast: number;
      lowerQuartileAtLeast: number;
      shareAtLeast: { price: number; fraction: number };
    };
    minSample: number;
  };
  proposals: BrandProposal[];
  counts: { rare: number; common: number; unsorted: number; changed: number; locked: number };
}
