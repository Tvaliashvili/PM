// =============================================================
// CPMG PM - configuration
// =============================================================

// Supabase Dashboard > Project Settings > API.
// Use the anon (public) key only - never the service_role key.
export const SUPABASE_URL = 'https://wlysnnevbazfjqtuysei.supabase.co';
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndseXNubmV2YmF6ZmpxdHV5c2VpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MzY1MzQsImV4cCI6MjEwNjAxMjUzNH0._XZ5BMrIHlxQe8jnDRYzZpWwMp9xzz1J0_stDQgT0TA';

// Each project keeps its money in one currency (projects.currency).
// Must match the projects_currency_check constraint in schema.sql.
export const CURRENCIES = {
  USD: 'US dollar ($)',
  GEL: 'Georgian lari (₾)',
};
export const DEFAULT_CURRENCY = 'USD';

// Unit types offered in the Units register (stored as text in flats.unit_type).
export const UNIT_TYPES = [
  'Studio', '1-bedroom', '2-bedroom', '3-bedroom', '4-bedroom', 'Penthouse',
  'Duplex', 'Commercial', 'Office', 'Parking', 'Storage',
];

// Must match the flats.status check constraint in schema.sql.
export const UNIT_STATUSES = {
  not_started: 'Not started',
  in_progress: 'In progress',
  finished:    'Finished',
  handed_over: 'Handed over',
};

// Trades counted in daily_logs.manpower.
export const MANPOWER_TRADES = [
  { key: 'masons',       label: 'Masons' },
  { key: 'carpenters',   label: 'Carpenters' },
  { key: 'steel_fixers', label: 'Steel fixers' },
  { key: 'concrete_workers', label: 'Concrete workers' },
  { key: 'electricians', label: 'Electricians' },
  { key: 'plumbers',     label: 'Plumbers' },
  { key: 'tilers',       label: 'Tilers' },
  { key: 'painters',     label: 'Painters' },
  { key: 'day_workers',  label: 'Daily workers' }, // paid a fixed rate per day (see DAY_WORKER_KEY)
];

// Manpower trade whose headcount is paid per day (projects/daily_logs.day_rate).
export const DAY_WORKER_KEY = 'day_workers';

// Suggestions for the equipment-rental form (free text is allowed too).
export const EQUIPMENT_SUGGESTIONS = [
  'Drill', 'Concrete mixer', 'Concrete pump', 'Excavator', 'Mobile crane', 'Tower crane', 'Scaffolding',
  'Generator', 'Plate compactor', 'Jackhammer', 'Welding machine', 'Truck', 'Forklift', 'Formwork',
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

// Sign-off printed at the end of every generated document.
export const REPORT_AUTHOR = {
  name:    'Sandro Tvaliashvili',
  nameKa:  'სანდრო თვალიაშვილი',
  title:   'Project Manager',
  titleKa: 'პროექტის მენეჯერი',
};

// Units for a work item's quantity (quantity × rate = budget).
export const BOQ_UNITS = ['m²', 'm³', 'm', 'kg', 't', 'pcs', 'lump sum', 'day', 'hr'];

// Suggestions for a contractor's trade (free text is allowed too).
export const CONTRACTOR_TRADES = [
  'General contractor', 'Earthworks', 'Concrete', 'Steel / rebar', 'Masonry', 'Roofing',
  'Facade', 'Windows & doors', 'Plumbing', 'Electrical', 'HVAC', 'Finishes', 'Elevators',
];
