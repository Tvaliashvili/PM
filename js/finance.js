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
