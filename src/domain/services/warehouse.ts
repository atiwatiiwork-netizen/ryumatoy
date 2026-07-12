import type { Database, PreorderTicket, Product, SourcingTransport } from '../entities';
import { transportRange } from './sourcing';

/**
 * ระบบยืนยันโกดังจีน (ryuma-warehouse-spec). The warehouse table ("รูป 3") — pasted text OR OCR
 * output — is parsed into rows; each row's SF code (รหัสวัสดุ) is matched to a product/sourcing
 * sf_code, and the "เข้าโกดัง" date becomes the real ETA start. Transport (รถ/เรือ) is read from the
 * ล๊อต column (rows begin "เรือ …" / "รถ …"). Confirming a ticket flips its status to shipping.
 */

export type WarehouseRow = { sf: string; date?: string; transport?: SourcingTransport; raw: string };

const SF_RE = /\b([A-Z]{2}\d{9,}|\d{12,})\b/;                 // SF tracking or a long numeric code
const DATE_RE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/;  // dd/mm/yyyy (first one on a row = เข้าโกดัง)

const toIso = (d: string): string | undefined => {
  const m = DATE_RE.exec(d);
  if (!m) return undefined;
  let [, dd, mm, yy] = m;
  // 2-digit → +2000; Buddhist Era (25xx, some warehouse sheets use it) → -543 to Gregorian.
  let y = Number(yy); if (y < 100) y += 2000; else if (y >= 2500) y -= 543;
  const iso = new Date(Date.UTC(y, Number(mm) - 1, Number(dd)));
  return isNaN(iso.getTime()) ? undefined : iso.toISOString().slice(0, 10);
};

/** Parse pasted/OCR'd warehouse text → one row per line that carries an SF code. */
export function parseWarehouseText(text: string): WarehouseRow[] {
  const out: WarehouseRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // match the SF token on the SPACED line first (the code sits between separators, so \b is clean
    // and greedy \d+ can't swallow the next column). Only if that misses (OCR split the code with a
    // stray space) fall back to a de-spaced copy.
    const sfM = SF_RE.exec(line) ?? SF_RE.exec(line.replace(/\s+/g, ''));
    if (!sfM) continue;
    const transport: SourcingTransport | undefined = /เรือ|ship|船/i.test(line) ? 'ship' : /รถ|truck|车|車/i.test(line) ? 'truck' : undefined;
    // first date on the line = เข้าโกดัง (columns run เข้าโกดัง → ออกโกดัง → ถึงไทย, left to right)
    const date = toIso(line);
    out.push({ sf: sfM[1], date, transport, raw: line });
  }
  return out;
}

/** Find the warehouse row that matches a code (loose: ignores spaces, case-insensitive). */
export function matchWarehouseRow(rows: WarehouseRow[], sfCode?: string): WarehouseRow | undefined {
  if (!sfCode) return undefined;
  const key = sfCode.replace(/\s+/g, '').toUpperCase();
  return rows.find((r) => r.sf.replace(/\s+/g, '').toUpperCase() === key);
}

/** The SF code that applies to a ticket: the sourcing request's (by-case) if any, else the product's. */
export function ticketSfCode(db: Database, t: PreorderTicket): string | undefined {
  const req = db.sourcingRequests.find((r) => r.product_id === t.product_id);
  return req?.sf_code || db.products.find((p) => p.id === t.product_id)?.sf_code;
}

/** A ticket still in 'production' with no warehouse date = waiting for the warehouse gate (the Filter). */
export function awaitingWarehouse(db: Database, t: PreorderTicket): boolean {
  return t.product_status === 'production' && !t.warehouse_at;
}

/** Does a product still have ticket(s) waiting for the warehouse gate? Used to STOP the old Status-tab
 *  stepper from jumping ผลิต → เดินทาง without a เข้าโกดัง date (single source for that transition,
 *  no duplicate/conflicting path). Products with no such ticket advance normally. */
export function productAwaitingWarehouse(db: Database, productId: string): boolean {
  return db.tickets.some((t) => t.product_id === productId && awaitingWarehouse(db, t));
}

/** Tickets waiting for warehouse confirmation, grouped by product (special rounds + sourcing + any
 *  production lot). Newest product first. */
export function warehouseQueue(db: Database): { product: Product; tickets: PreorderTicket[]; sf?: string }[] {
  const byProduct = new Map<string, PreorderTicket[]>();
  for (const t of db.tickets) {
    if (!awaitingWarehouse(db, t)) continue;
    (byProduct.get(t.product_id) ?? byProduct.set(t.product_id, []).get(t.product_id)!).push(t);
  }
  return [...byProduct.entries()]
    .map(([pid, tickets]) => {
      const product = db.products.find((p) => p.id === pid)!;
      return { product, tickets, sf: product && ticketSfCode(db, tickets[0]) };
    })
    .filter((g) => g.product)
    .sort((a, b) => (a.product.created_at < b.product.created_at ? 1 : -1));
}

/** ETA line for a warehouse-confirmed ticket: warehouse_at + transport range → a date range. */
export function warehouseEtaLabel(db: Database, t: PreorderTicket): string {
  if (!t.warehouse_at) return '';
  const tr = t.warehouse_transport ?? 'truck';
  const { min, max } = transportRange(db, tr);
  const start = new Date(t.warehouse_at);
  const d = (n: number) => new Date(start.getTime() + n * 86400000).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
  return `${tr === 'ship' ? '🚢 เรือ' : '🚚 รถ'} · คาดถึงไทย ${d(min)} – ${d(max)}`;
}
