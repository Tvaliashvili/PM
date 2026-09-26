// =============================================================
// CPMG PM — configuration
// =============================================================

// Supabase Dashboard > Project Settings > API.
// Use the anon (public) key only — never the service_role key.
export const SUPABASE_URL = 'https://wlysnnevbazfjqtuysei.supabase.co';
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndseXNubmV2YmF6ZmpxdHV5c2VpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MzY1MzQsImV4cCI6MjEwNjAxMjUzNH0._XZ5BMrIHlxQe8jnDRYzZpWwMp9xzz1J0_stDQgT0TA';

// ISO 4217 code used for all money values.
export const CURRENCY_CODE = 'USD';

// Trade stages tracked per flat (keys stored in flats.stage_status).
export const STAGES = [
  { key: 'structure',  label: 'Structure',  short: 'STR' },
  { key: 'masonry',    label: 'Masonry',    short: 'MAS' },
  { key: 'plumbing',   label: 'Plumbing',   short: 'PLB' },
  { key: 'electrical', label: 'Electrical', short: 'ELE' },
  { key: 'plastering', label: 'Plastering', short: 'PLS' },
  { key: 'tiling',     label: 'Tiling',     short: 'TIL' },
  { key: 'carpentry',  label: 'Carpentry',  short: 'CRP' },
  { key: 'painting',   label: 'Painting',   short: 'PNT' },
];

// Click order when cycling a stage badge.
export const STATUSES = ['pending', 'in_progress', 'done', 'blocked'];

export const STATUS_LABELS = {
  pending:     'Pending',
  in_progress: 'In progress',
  done:        'Done',
  blocked:     'Blocked',
};

// Trades counted in daily_logs.manpower.
export const MANPOWER_TRADES = [
  { key: 'masons',       label: 'Masons' },
  { key: 'carpenters',   label: 'Carpenters' },
  { key: 'steel_fixers', label: 'Steel fixers' },
  { key: 'electricians', label: 'Electricians' },
  { key: 'plumbers',     label: 'Plumbers' },
  { key: 'tilers',       label: 'Tilers' },
  { key: 'painters',     label: 'Painters' },
  { key: 'labourers',    label: 'Labourers' },
];

export const WEATHER_OPTIONS = ['Sunny', 'Cloudy', 'Rain', 'Heavy rain', 'Windy', 'Snow', 'Extreme heat'];

export const DELAY_CAUSES = [
  'Weather',
  'Material shortage',
  'Labour shortage',
  'Equipment breakdown',
  'Design change',
  'Permit / inspection',
  'Subcontractor',
  'Payment / funding',
  'Other',
];

// Bill of quantities
export const BOQ_UNITS = ['m²', 'm³', 'm', 'kg', 't', 'pcs', 'lump sum', 'day', 'hr'];

export const BOQ_CATEGORIES = [
  'Preliminaries', 'Substructure', 'Frame', 'Masonry', 'Roofing', 'Plumbing',
  'Electrical', 'Finishes', 'Doors & windows', 'External works',
];

// Must match the cash_flow.status check constraint in schema.sql.
export const BOQ_STATUSES = {
  planned:   'Planned',
  committed: 'Committed',
  paid:      'Paid',
  cancelled: 'Cancelled',
};
