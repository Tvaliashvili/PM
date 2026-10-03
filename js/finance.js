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

/**
 * The project's income against its cost, as the app's Finance page and the
 * client's report both show it. `cost` is costPosition()'s result. Cost, for
 * now, is the BOQ budget (contracts + materials) plus approved variations, the
 * daily workers, guards and rentals paid so far, and what was bought for the
 * site rather than one job (tools, general stock): what is known to be spent,
 * not yet a forecast of the final cost.
 *   source   - 'sales', 'contract', or null when not chosen
 *   sales    - salesPosition() for a project that sells, else null
 *   items    - each item with itemMargin() for a contract, else []
 *   earned   - contract income earned by the work done so far
 *   unbudgeted - purchases for no job, which no budget covers
 */
export function financePosition({ project, tasks, rooms, variations, materials = [], cost }) {
  const sum = (list, key) => list.reduce((s, x) => s + Number(x[key] || 0), 0);
  const source = project?.income_from ?? null;
  const variationCost = sum(variations.filter((v) => v.status === 'approved'), 'amount');
  const siteSoFar = cost.labour + cost.guard + cost.rental;
  const unbudgeted = sum(materials.filter((m) => !m.task_id), 'amount');
  const total = cost.budget + variationCost + siteSoFar + unbudgeted;
  const sales = source === 'sales' ? salesPosition(rooms, project.price_per_m2) : null;
  const items = source === 'contract' ? tasks.map((task) => ({ task, ...itemMargin(task) })) : [];
  const income = sales ? sales.income : sum(items, 'income');
  return {
    source, sales, items, income, earned: sum(items, 'earned'),
    budget: cost.budget, variations: variationCost, siteSoFar, unbudgeted, cost: total, profit: income - total,
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
