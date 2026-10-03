// =============================================================
// What a project earns (pure - no DOM, no database)
// Profit = income − cost. Income is either what the employer pays for each
// item (a project built under contract) or the rooms' sale prices (one that
// sells what it builds). Funding - a loan, the client's own money - is never
// income: it is spent, and paid back, but earns nothing.
// =============================================================
import { budgetOf, completionOf } from './schedule.js';

/**
 * One item under contract:
 *   income - what the employer pays for it
 *   cost   - its budget (contract + materials)
 *   margin - income − cost; below 0, the item loses money
 *   earned - the income its % complete has earned so far
 */
export function itemMargin(task) {
  const income = Number(task.employer_price || 0);
  const cost = budgetOf(task);
  return { income, cost, margin: income - cost, earned: income * completionOf(task) };
}

/**
 * What one room is expected to bring in, and where the figure comes from:
 *   sale   - sold, at its sale price
 *   asking - on offer (or sold with no price written down), at its asking price
 *   per_m2 - no price of its own: area × the project's price per m²
 *   none   - nothing to price it by
 *   kept   - not for sale; earns nothing
 */
export function roomIncome(room, pricePerM2) {
  if (room.sale_status === 'not_for_sale') return { amount: 0, source: 'kept' };
  if (room.sale_status === 'sold' && room.sale_price != null) return { amount: Number(room.sale_price), source: 'sale' };
  if (room.asking_price != null) return { amount: Number(room.asking_price), source: 'asking' };
  if (Number(pricePerM2) > 0 && room.area_m2 != null) {
    return { amount: Number(room.area_m2) * Number(pricePerM2), source: 'per_m2' };
  }
  return { amount: 0, source: 'none' };
}

const DAY = 86_400_000;
const days = (from, to) => Math.max(0, Math.round((new Date(`${to}T00:00`) - new Date(`${from}T00:00`)) / DAY));
const sumOf = (list, key) => list.reduce((s, x) => s + Number((typeof key === 'function' ? key(x) : x[key]) || 0), 0);

// What money_in kinds are: income (toward profit) or funding (never).
export const INCOME_KINDS = ['employer', 'buyer'];
export const FUNDING_KINDS = ['loan', 'own', 'partner'];

/**
 * Interest on the loan draws in money_in, simple interest at each draw's own
 * yearly rate, from the day it came in up to `untilIso`.
 */
export function loanInterest(moneyIn, untilIso) {
  return sumOf(moneyIn.filter((m) => m.kind === 'loan' && Number(m.interest_pct) > 0 && m.received_on <= untilIso),
    (m) => Number(m.amount) * (Number(m.interest_pct) / 100) * (days(m.received_on, untilIso) / 365));
}

/**
 * What the project will have cost when it is finished, from what is known today:
 *   contracts   - each item's contract budget, or what it has been paid plus
 *                 retention held when that is more (an overpaid item costs what it cost)
 *   materials   - each item's materials budget, or what was bought for it when more
 *   variations  - approved changes (pending ones are a risk, apart)
 *   siteSoFar   - daily workers, guards and rentals up to today
 *   siteToCome  - the same, at the rate kept so far, to the planned completion
 *   unbudgeted  - purchases for the whole site rather than one job
 * budget is what was planned: contracts + materials budgets.
 */
export function forecastCost({ project, tasks, payments = [], materials = [], variations = [], siteCosts = [], today }) {
  let contracts = 0;
  let materialCost = 0;
  for (const t of tasks) {
    const own = payments.filter((p) => p.task_id === t.id);
    contracts += Math.max(Number(t.budget || 0), sumOf(own, 'amount') + sumOf(own, 'retention'));
    materialCost += Math.max(Number(t.material_budget || 0), sumOf(materials.filter((m) => m.task_id === t.id), 'amount'));
  }
  const approved = sumOf(variations.filter((v) => v.status === 'approved'), 'amount');
  const pending = sumOf(variations.filter((v) => v.status === 'instructed' || v.status === 'priced'), 'amount');
  const site = siteCosts.filter((e) => ['labour', 'guard', 'rental'].includes(e.kind) && e.date <= today);
  const siteSoFar = sumOf(site, 'amount');
  // The site's daily cost so far, carried on to the planned completion.
  let siteToCome = 0;
  const end = project?.closed_how ? null : project?.end_date;
  if (site.length && end && end > today) {
    const first = site.reduce((min, e) => (e.date < min ? e.date : min), today);
    siteToCome = (siteSoFar / Math.max(1, days(first, today) + 1)) * days(today, end);
  }
  const unbudgeted = sumOf(materials.filter((m) => !m.task_id), 'amount');
  const budget = sumOf(tasks, (t) => Number(t.budget || 0) + Number(t.material_budget || 0));
  return {
    contracts, materials: materialCost, variations: approved, pendingVariations: pending,
    siteSoFar, siteToCome, unbudgeted, budget,
    total: contracts + materialCost + approved + siteSoFar + siteToCome + unbudgeted,
  };
}

/**
 * The project's income against its forecast cost, as the app's Finance page
 * and the client's report both show it.
 *   source   - 'sales', 'contract', or null when not chosen
 *   sales    - salesPosition() for a project that sells, else null
 *   items    - each item with itemMargin() for a contract, else []
 *   earned   - contract income earned by the work done so far
 *   income   - sales, or employer's prices plus approved variations' employer amounts
 *   forecast - forecastCost()
 *   interest - loan interest to completion (interestSoFar: to today)
 *   cost     - forecast + interest; profit = income − cost
 *   received - money in so far, by kind, and in all as income / funding
 */
export function financePosition({
  project, tasks, rooms, variations, materials = [], payments = [], siteCosts = [], moneyIn = [],
  today = new Date().toLocaleDateString('en-CA'),
}) {
  const source = project?.income_from ?? null;
  const forecast = forecastCost({ project, tasks, payments, materials, variations, siteCosts, today });
  const end = !project?.closed_how && project?.end_date > today ? project.end_date : today;
  const interestSoFar = loanInterest(moneyIn, today);
  const interest = loanInterest(moneyIn, end);
  const sales = source === 'sales' ? salesPosition(rooms, project.price_per_m2) : null;
  const items = source === 'contract' ? tasks.map((task) => ({ task, ...itemMargin(task) })) : [];
  const variationIncome = source === 'contract'
    ? sumOf(variations.filter((v) => v.status === 'approved'), 'employer_amount') : 0;
  const income = sales ? sales.income : sumOf(items, 'income') + variationIncome;
  const byKind = Object.fromEntries([...INCOME_KINDS, ...FUNDING_KINDS]
    .map((k) => [k, sumOf(moneyIn.filter((m) => m.kind === k), 'amount')]));
  const cost = forecast.total + interest;
  return {
    source, sales, items, income, variationIncome, earned: sumOf(items, 'earned'),
    forecast, interest, interestSoFar, cost, profit: income - cost,
    received: {
      ...byKind,
      income: sumOf(INCOME_KINDS, (k) => byKind[k]),
      funding: sumOf(FUNDING_KINDS, (k) => byKind[k]),
    },
    // Kept for the report's cost line.
    budget: forecast.budget, variations: forecast.variations, siteSoFar: forecast.siteSoFar + forecast.siteToCome,
    unbudgeted: forecast.unbudgeted,
  };
}

/** Rooms for sale by type, most income first: [type, { count, sold, area, amount }]. '' = no type. */
export function salesByType(rooms, pricePerM2) {
  const types = new Map();
  for (const room of rooms) {
    if ((room.sale_status ?? 'for_sale') === 'not_for_sale') continue;
    const key = room.unit_type || '';
    const t = types.get(key) ?? { count: 0, sold: 0, area: 0, amount: 0 };
    t.count += 1;
    if (room.sale_status === 'sold') t.sold += 1;
    t.area += Number(room.area_m2 || 0);
    t.amount += roomIncome(room, pricePerM2).amount;
    types.set(key, t);
  }
  return [...types].sort((a, b) => b[1].amount - a[1].amount);
}

/**
 * Sales across the rooms given. Each of sold, reserved and forSale is
 * { count, area, amount }; area counts only rooms with an area.
 *   income   - every room's expected income (sold + reserved + for sale)
 *   sellable - area of every room that is for sale, reserved or sold
 *   unpriced - rooms that are for sale but have no price to go by
 */
export function salesPosition(rooms, pricePerM2) {
  const blank = () => ({ count: 0, area: 0, amount: 0 });
  const out = { sold: blank(), reserved: blank(), forSale: blank(), kept: 0, unpriced: 0, income: 0, sellable: 0 };
  const key = { sold: 'sold', reserved: 'reserved', for_sale: 'forSale' };
  for (const room of rooms) {
    const status = room.sale_status ?? 'for_sale';
    if (status === 'not_for_sale') {
      out.kept += 1;
      continue;
    }
    const { amount, source } = roomIncome(room, pricePerM2);
    const bucket = out[key[status] ?? 'forSale'];
    const area = Number(room.area_m2 || 0);
    bucket.count += 1;
    bucket.area += area;
    bucket.amount += amount;
    out.income += amount;
    out.sellable += area;
    if (source === 'none') out.unpriced += 1;
  }
  return out;
}
