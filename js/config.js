// =============================================================
// CPMG PM - configuration
// =============================================================
import { SIGNATURE_PNG } from './signatureImage.js';

// Supabase Dashboard > Project Settings > API.
// Use the anon (public) key only - never the service_role key.
// The one account that may change anything; everyone else signed in can only
// look (the database enforces it - see schema.sql section 27).
export const ADMIN_EMAIL = 'st@cpmgroup.ge';

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

// What a purchase is (materials.kind). Only a material can be for one job.
export const PURCHASE_KINDS = {
  material: 'Material',
  tool:     'Tool / equipment',
  other:    'Other',
};

// Where a project's income comes from (projects.income_from; null = not chosen).
// Money from an employer is income - only a loan or own money is funding.
export const INCOME_SOURCES = {
  sales:    'Sells what it builds (flats)',
  contract: 'Built for an employer (government or general contractor)',
};

// Where a room's sale has got to (flats.sale_status). A room not for sale is
// kept or given away, and earns nothing.
export const SALE_STATUSES = {
  for_sale:     'For sale',
  reserved:     'Reserved',
  sold:         'Sold',
  not_for_sale: 'Not for sale',
};

// Where a variation has got to (variations.status). Only an approved one
// changes the contract sum; the rest are money still being argued about.
export const VARIATION_STATUSES = {
  instructed: 'Instructed',
  priced:     'Priced',
  approved:   'Approved',
  rejected:   'Rejected',
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
  { key: 'window_fitters', label: 'Window & door fitters' },
  { key: 'day_workers',  label: 'Daily workers' }, // paid a fixed rate per day (see DAY_WORKER_KEY)
  { key: 'guards',       label: 'Guards' },        // likewise, at their own rate (see GUARD_KEY)
];

// Manpower trades the client pays for by the day, each from its own rate on the
// project and the log. Anyone else on site is inside a contractor's price.
export const DAY_WORKER_KEY = 'day_workers'; // projects/daily_logs.day_rate
export const GUARD_KEY = 'guards';           // projects/daily_logs.guard_rate

// Suggestions for the equipment-rental form (free text is allowed too).
export const EQUIPMENT_SUGGESTIONS = [
  'Drill', 'Concrete mixer', 'Concrete pump', 'Excavator', 'Mobile crane', 'Tower crane', 'Scaffolding',
  'Generator', 'Plate compactor', 'Jackhammer', 'Welding machine', 'Truck', 'Forklift', 'Formwork',
];

export const WEATHER_OPTIONS = ['Sunny', 'Cloudy', 'Rain', 'Heavy rain', 'Windy', 'Snow', 'Extreme heat'];

// Safety and quality events (site_events.kind / .severity).
export const SITE_EVENT_KINDS = {
  incident:     'Incident',
  inspection:   'Inspection',
  toolbox_talk: 'Toolbox talk',
};

// Incidents only, in order of seriousness.
export const INCIDENT_SEVERITIES = {
  first_aid:  'First aid',
  lost_time:  'Lost time',
  reportable: 'Reportable',
};

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

// Sign-off printed at the end of every generated document. `signature` is drawn
// over the signing line; leave it out and the line is left blank to sign by hand.
export const REPORT_AUTHOR = {
  name:    'Sandro Tvaliashvili',
  nameKa:  'სანდრო თვალიაშვილი',
  title:   'Project Manager',
  titleKa: 'პროექტის მენეჯერი',
  signature: SIGNATURE_PNG,
};

// Units for a work item's quantity (quantity × rate = budget).
export const BOQ_UNITS = ['m²', 'm³', 'm', 'kg', 't', 'pcs', 'lump sum', 'day', 'hr'];

// Suggestions for a contractor's trade (free text is allowed too).
export const CONTRACTOR_TRADES = [
  'General contractor', 'Earthworks', 'Concrete', 'Steel / rebar', 'Masonry', 'Roofing',
  'Facade', 'Windows & doors', 'MEP', 'Plumbing', 'Electrical', 'HVAC', 'Finishes', 'Elevators',
];
