import type { Database, Order, OrderItem, Category, Manufacturer, Franchise, Series, Product, PaymentAccount, ProductStatus, Carrier, RankName, PreorderTicket, Coupon, CouponGrant, CouponScope, WcfType, Campaign, CampaignAward, MissionSubmission, PushSubscription as PushSubscriptionRow, SourcingTransport } from '../domain/entities';
import type { CartLine } from '../state/CartProvider';
import { nextTicketNo, ticketPrefix, padTicketSeq, unmatchedApprovedItems } from '../domain/services/tickets';
import type { TicketNoStart } from '../lib/ticketno';

/** Build a ticket_no allocator for ONE mutation run. If a prefix has a server-reserved start number,
 *  hand out consecutive numbers from it; otherwise fall back to client counting (nextTicketNo). Pure
 *  per call (the `used` cursor is local). (ticket_no collision fix — migration v47) */
function ticketNoAllocator(db: Database, startNos: TicketNoStart | undefined, when: Date) {
  const used: Record<string, number> = {};
  return (abbr: string, pending: { ticket_no: string }[]): string => {
    const prefix = ticketPrefix(abbr, when);
    if (startNos && startNos[prefix] != null) {
      const i = used[prefix] ?? 0;
      used[prefix] = i + 1;
      return `${prefix}-${padTicketSeq(startNos[prefix] + i)}`;
    }
    return nextTicketNo(db, abbr, when, pending);
  };
}
import { franchiseOf, canConvertToInStock, stockRemaining } from '../domain/services/catalog';
import { depositFor, priceFromYuan, livePrice } from '../domain/services/pricing';
import { couponMatchesProduct, couponDiscount, couponExpired, scopeAllows, orphanUsedGrants } from '../domain/services/coupons';
import { unclaimedAwards } from '../domain/services/campaigns';

/** A coupon redemption passed in from the UI (grant id + baht discounted at that moment). */
export type CouponApply = { grantId: string; discount: number };

/**
 * Pure mutations — `(db) => db`. Each returns a new Database; the store applies
 * them optimistically and persists. These cover the booking flow + admin catalog
 * management (manufacturers / franchises / products).
 */

let counter = 0;
const id = (p: string) => `${p}-${Date.now()}-${counter++}`;

/** Generate a fresh id for a new catalog row (used by the admin forms). */
export const genId = (prefix: string) => id(prefix);

/** Insert or replace a row by id within a collection. */
function upsertById<T extends { id: string }>(rows: T[], row: T): T[] {
  const i = rows.findIndex((r) => r.id === row.id);
  if (i < 0) return [...rows, row];
  const next = [...rows];
  next[i] = row;
  return next;
}

/** Submit a cart as an order. Normally it awaits admin approval (PRD §9 step 5). When `autoApprove`
 *  is set — used for zero-payment orders, e.g. a Diamond member whose deposit is 0 — there is no slip
 *  to verify, so the order is approved and the tickets are issued immediately (customer gets ตั๋วเลย). */
export function submitOrder(userId: string, lines: CartLine[], slipUrl: string, reservationIds?: string[], autoApprove = false, coupon?: CouponApply, startNos?: TicketNoStart) {
  return (db: Database): Database => {
    const orderId = id('o');
    const rank = db.users.find((u) => u.id === userId)?.rank ?? 'bronze';
    const items: OrderItem[] = lines.map((l) => {
      const isStock = db.products.find((p) => p.id === l.productId)?.is_stock ?? false;
      // price/deposit lock HERE at order submit — read LIVE from the product/variant/batch, not the
      // (possibly stale) cart snapshot — so a formula re-price can't bill an old price. (livePrice)
      const { price, deposit } = livePrice(db, l);
      // rank perk: pre-order deposit reduced by rank (snapshot); total unchanged (remaining grows).
      // full-pay lines (in-stock, or a pay-in-full "พร้อมส่ง" batch) collect in full — no perk. (DNA)
      const unitDeposit = lineDepositForRank(db.settings, { deposit, price, isStock }, rank);
      return {
        id: id('oi'),
        order_id: orderId,
        product_id: l.productId,
        variant_id: l.variantId,
        qty: l.qty,
        deposit_amount: unitDeposit * l.qty,
        // snapshot the just-locked price/deposit onto the order — never re-read the product later
        unit_price: price,
        unit_deposit: unitDeposit,
        batch_id: l.batchId,
      };
    });
    // an in-stock coupon reduces what's transferred now (capped so total never goes below 0)
    const grossDeposit = items.reduce((s, i) => s + i.deposit_amount, 0);
    // SECURITY: re-derive the discount from the coupon TEMPLATE here — never trust `coupon.discount`
    // (it only drives the UI; a crafted request could pass any number). Re-validate active/expiry/scope/
    // target and cap at the MATCHING in-stock subtotal, so a coupon can't discount more than the
    // in-stock products it actually targets. (audit H1/H2)
    let validGrant = coupon ? db.couponGrants.find((g) => g.id === coupon.grantId && g.user_id === userId && g.status === 'active') : undefined;
    let discount = 0;
    if (validGrant) {
      const tpl = db.coupons.find((c) => c.id === validGrant!.coupon_id);
      const base = tpl ? items.reduce((s, i) => {
        const p = db.products.find((x) => x.id === i.product_id);
        if (!p || !(p.is_stock ?? false) || !scopeAllows(tpl.scope, true) || !couponMatchesProduct(tpl, p)) return s;
        return s + i.deposit_amount;
      }, 0) : 0;
      discount = tpl && tpl.active && !couponExpired(tpl, new Date()) ? couponDiscount(tpl, Math.min(base, grossDeposit)) : 0;
      if (discount <= 0) validGrant = undefined; // nothing valid to discount → don't burn the grant
    }
    const now = new Date().toISOString();
    const order: Order = {
      id: orderId,
      user_id: userId,
      total_deposit: grossDeposit - discount,
      slip_url: slipUrl,
      status: 'pending_approval',
      created_at: now,
      reservation_ids: reservationIds && reservationIds.length ? reservationIds : undefined,
      coupon_grant_id: validGrant ? validGrant.id : undefined,
      coupon_discount: validGrant ? discount : undefined,
      items,
    };
    // consume the coupon now (single use); rejectOrder returns it if the slip is refused
    const couponGrants = validGrant
      ? db.couponGrants.map((g) => (g.id === validGrant.id ? { ...g, status: 'used' as const, used_at: now, order_id: orderId, discount_amount: discount } : g))
      : db.couponGrants;
    const withOrder = { ...db, orders: [order, ...db.orders], couponGrants };
    // zero-payment (Diamond) → nothing to verify → approve now + issue tickets in the same step.
    // mintRewards:false — this runs in the CUSTOMER session, which RLS forbids from minting event
    // coupons/awards; minting here would abort the whole flush and lose the tickets. Their rewards
    // are credited by the admin sweep (/admin/events) or the next admin-approved order.
    return autoApprove ? approveOrder(orderId, { mintRewards: false, startNos })(withOrder) : withOrder;
  };
}

/** Admin approves a slip: mark order approved + auto-issue one ticket per item (PRD §9 step 6).
 *  opts.mintRewards (default true) — event reward coupons are minted ONLY in the admin session;
 *  the customer-side Diamond auto-approve passes false because RLS forbids customers minting
 *  coupons/awards, and a blocked mint would abort the whole flush (tickets included). */
/** One-shot repair for orders damaged by the old ticket_no collision bug. Idempotent + safe:
 *  (1) renumbers any DUPLICATE ticket_no (keeps the first, gives later dups the next free number for
 *      their prefix) so persistence stops failing on the UNIQUE constraint; existing good tickets keep
 *      their numbers. (2) re-issues a ticket for any APPROVED-order item that has no matching ticket
 *      (lost when the duplicate insert aborted the sync). Run again = no-op. */
export const repairTickets = () => (db: Database): Database => {
  const pad = (n: number) => String(n).padStart(4, '0');

  const taken = new Set<string>();
  const tickets = db.tickets.map((t) => {
    if (!taken.has(t.ticket_no)) { taken.add(t.ticket_no); return t; }
    const m = /^(.*-)(\d{4})$/.exec(t.ticket_no);
    const prefix = m ? m[1] : `${t.ticket_no}-`;
    let n = 1;
    while (taken.has(prefix + pad(n))) n++;
    const fresh = prefix + pad(n);
    taken.add(fresh);
    return { ...t, ticket_no: fresh };
  });

  const out: Database = { ...db, tickets };
  const usedIds = new Set<string>();
  const issued: PreorderTicket[] = [];
  const key = (a?: string) => a ?? null;
  for (const order of out.orders) {
    if (order.status !== 'approved') continue;
    for (const item of order.items) {
      const match = out.tickets.find((t) =>
        !usedIds.has(t.id) && t.owner_id === order.user_id && t.product_id === item.product_id &&
        key(t.variant_id) === key(item.variant_id) && key(t.batch_id) === key(item.batch_id));
      if (match) { usedIds.add(match.id); continue; }
      const product = out.products.find((p) => p.id === item.product_id);
      if (!product) continue;
      const abbr = franchiseOf(out, product)?.abbr ?? 'xx';
      const unitPrice = item.unit_price ?? product.price_total;
      const unitDeposit = item.unit_deposit ?? product.deposit_amount;
      const when = order.approved_at ?? order.created_at;
      issued.push({
        id: id('t'), ticket_no: nextTicketNo(out, abbr, new Date(), issued),
        product_id: product.id, variant_id: item.variant_id, batch_id: item.batch_id,
        owner_id: order.user_id, original_buyer_id: order.user_id, qty: item.qty,
        deposit_paid: unitDeposit * item.qty, remaining_amount: Math.max(0, unitPrice - unitDeposit) * item.qty,
        remaining_paid: 0, status: 'active', product_status: product.status, qr_code_url: '',
        created_at: when, approved_at: when,
      });
    }
  }
  return { ...out, tickets: [...issued, ...out.tickets] };
};

export function approveOrder(orderId: string, opts: { mintRewards?: boolean; startNos?: TicketNoStart } = {}) {
  const mintRewards = opts.mintRewards ?? true;
  return (db: Database): Database => {
    const order = db.orders.find((o) => o.id === orderId);
    if (!order || order.status !== 'pending_approval') return db;

    const when = new Date();
    const now = when.toISOString();
    const allocNo = ticketNoAllocator(db, opts.startNos, when);
    // build in a loop (not .map) so each ticket's number accounts for its siblings issued in THIS order
    const newTickets: PreorderTicket[] = [];
    for (const item of order.items) {
      const product = db.products.find((p) => p.id === item.product_id)!;
      const variant = db.variants.find((v) => v.id === item.variant_id);
      const abbr = franchiseOf(db, product)?.abbr ?? 'xx';
      // derive from the ORDER-TIME snapshot; fall back to current product for old rows
      const unitPrice = item.unit_price ?? variant?.price_total ?? product.price_total;
      const unitDeposit = item.unit_deposit ?? variant?.deposit_amount ?? product.deposit_amount;
      newTickets.push({
        id: id('t'),
        ticket_no: allocNo(abbr, newTickets),
        product_id: product.id,
        variant_id: item.variant_id,
        batch_id: item.batch_id,
        owner_id: order.user_id,
        original_buyer_id: order.user_id,
        qty: item.qty,
        deposit_paid: unitDeposit * item.qty,
        remaining_amount: Math.max(0, unitPrice - unitDeposit) * item.qty,
        remaining_paid: 0,
        status: 'active',
        product_status: product.status,
        qr_code_url: '',
        created_at: now,
        approved_at: now,
      });
    }

    // in-stock coupon applied at checkout → knock the discount off the qualifying พร้อมส่ง ticket's
    // recorded paid amount (in-stock lines carry no remaining, so this is where it lands)
    if (order.coupon_discount && order.coupon_grant_id) {
      const grant = db.couponGrants.find((g) => g.id === order.coupon_grant_id);
      const coupon = grant && db.coupons.find((c) => c.id === grant.coupon_id);
      let left = order.coupon_discount;
      for (const t of newTickets) {
        if (left <= 0) break;
        const product = db.products.find((p) => p.id === t.product_id);
        if (!product?.is_stock || (coupon && !couponMatchesProduct(coupon, product))) continue;
        const off = Math.min(left, t.deposit_paid);
        t.deposit_paid -= off;
        left -= off;
      }
    }

    const updated: Database = {
      ...db,
      orders: db.orders.map((o) =>
        o.id === orderId ? { ...o, status: 'approved', approved_at: new Date().toISOString() } : o,
      ),
      tickets: [...newTickets, ...db.tickets],
    };

    // Event/กิจกรรม: this approval may have pushed the buyer over a threshold → auto-mint any reward
    // coupons now (admin session = RLS-allowed to grant). Runs before the rank early-return so it
    // always applies. Skipped for the customer-side Diamond auto-approve (mintRewards:false).
    const withRewards = mintRewards ? grantAllCampaignRewards(order.user_id)(updated) : updated;

    // rank progress counts APPROVED pieces → auto-raise a request when a threshold is crossed
    const user = db.users.find((u) => u.id === order.user_id);
    const pieces = rankPiecesOf(withRewards, order.user_id);
    const elig = eligibleRank(db.settings, pieces);
    if (user && rankIndex(elig) > rankIndex(user.rank)) return requestRank(order.user_id, elig, pieces)(withRewards);
    return withRewards;
  };
}

/** Reject a pending order (slip not valid). Stock holds are released separately via RPC.
 *  Any coupon spent on the order is returned to the customer (grant back to active). */
export const rejectOrder = (orderId: string) => (db: Database): Database => {
  const order = db.orders.find((o) => o.id === orderId);
  // Only a still-pending order may be rejected. Rejecting an already-approved order would return the
  // coupon while its tickets + in-stock deposit reductions stay applied = double benefit. (audit M1)
  if (!order || order.status !== 'pending_approval') return db;
  return {
    ...db,
    orders: db.orders.map((o) => (o.id === orderId ? { ...o, status: 'rejected' as const } : o)),
    couponGrants: order?.coupon_grant_id
      ? db.couponGrants.map((g) => (g.id === order.coupon_grant_id ? { ...g, status: 'active' as const, used_at: undefined, order_id: undefined, discount_amount: undefined } : g))
      : db.couponGrants,
  };
};

/**
 * Reopen leftover/surplus stock as a new batch on the same product (SKU). The
 * batch carries its own price/deposit/qty; existing buyers keep their snapshot.
 */
export function reopenBatch(productId: string, opts: { price: number; deposit: number; qty: number; label?: string }) {
  return (db: Database): Database => ({
    ...db,
    batches: [
      {
        id: id('b'),
        product_id: productId,
        label: opts.label || 'สต๊อกเหลือ',
        price_total: opts.price,
        deposit_amount: opts.deposit,
        stock_qty: opts.qty,
        status: 'open',
        created_at: new Date().toISOString(),
      },
      ...db.batches,
    ],
  });
}

/** Top up a product's surplus stock and log the addition with a timestamp. */
export const addStock = (productId: string, qty: number, note?: string) => (db: Database): Database => ({
  ...db,
  products: db.products.map((p) => (p.id === productId ? { ...p, surplus_qty: (p.surplus_qty ?? 0) + qty } : p)),
  stockAdditions: [
    { id: id('sa'), product_id: productId, qty, note, created_at: new Date().toISOString() },
    ...db.stockAdditions,
  ],
});

export const closeBatch = (batchId: string) => (db: Database): Database => ({
  ...db,
  batches: db.batches.map((b) => (b.id === batchId ? { ...b, status: 'closed' } : b)),
});

export const removeBatch = (batchId: string) => (db: Database): Database => ({
  ...db,
  // never delete a round that has buyers — it would orphan their tickets (batch_id → nothing)
  batches: db.tickets.some((t) => t.batch_id === batchId) ? db.batches : db.batches.filter((b) => b.id !== batchId),
});

// ── สต๊อกใบพรี / พรีรอบพิเศษ (special pre-order round) ─────────────────────────
/** Open ONE special pre-order round (สต๊อกใบพรี) on an existing product. Guarded to a single OPEN
 *  round per SKU. `addSurplus` (legacy: physical stock we already hold) bumps surplus first; without it
 *  the round sells existing surplus (from a production close). Deposit = the SKU's deposit unless
 *  `fullPay` (จ่ายเต็ม/พร้อมส่ง → deposit = price). Existing buyers keep their snapshot (ryuma-preorder-stock-spec). */
export const openSpecialRound = (productId: string, opts: { qty: number; price: number; fullPay: boolean; label?: string; addSurplus?: boolean; deposit?: number }) => (db: Database): Database => {
  const p = db.products.find((x) => x.id === productId);
  if (!p) return db;
  if (db.batches.some((b) => b.product_id === productId && b.status === 'open')) return db; // one round at a time
  const qty = Math.max(0, Math.floor(opts.qty));
  if (qty <= 0) return db;
  const price = opts.price > 0 ? opts.price : p.price_total;
  // custom deposit (e.g. finished-goods rate 1000฿) wins; capped at the price so the remaining is never negative
  const deposit = opts.fullPay ? price : Math.min(price, (opts.deposit && opts.deposit > 0 ? opts.deposit : p.deposit_amount));
  const now = new Date().toISOString();
  const products = opts.addSurplus ? db.products.map((x) => (x.id === productId ? { ...x, surplus_qty: (x.surplus_qty ?? 0) + qty } : x)) : db.products;
  const stockAdditions = opts.addSurplus
    ? [{ id: id('sa'), product_id: productId, qty, note: `สต๊อกใบพรี (legacy) +${qty}`, created_at: now }, ...db.stockAdditions]
    : db.stockAdditions;
  const batch = { id: id('b'), product_id: productId, label: opts.label?.trim() || (opts.fullPay ? 'พร้อมส่ง' : 'รอบพิเศษ'), price_total: price, deposit_amount: deposit, stock_qty: qty, status: 'open' as const, created_at: now };
  return { ...db, products, stockAdditions, batches: [batch, ...db.batches] };
};

/** Create a brand-new legacy SKU (stock we already hold) + open its first special round in one step.
 *  full-pay → status 'arrived' (in hand); deposit → 'shipping' (in transit, so the remaining is payable). */
export const createLegacyStockProduct = (data: {
  franchise_id: string; manufacturer_id: string; series_id?: string; character_name: string; series_name: string;
  height_cm?: number; wcf_type?: WcfType; images?: string[];
  qty: number; price: number; fullPay: boolean; label?: string;
  deposit?: number; // custom มัดจำ (e.g. finished-goods rate 1000฿); falls back to the WCF/Mega rate
  startStatus?: 'production' | 'shipping'; // pre-order rounds: 'production' waits for the warehouse gate
}) => (db: Database): Database => {
  const pid = id('p');
  const now = new Date().toISOString();
  const deposit = data.fullPay
    ? data.price
    : Math.min(data.price, (data.deposit && data.deposit > 0 ? data.deposit : depositFor(db.settings, data.wcf_type ?? 'wcf')));
  // full-pay = ของอยู่ในมือ → arrived. deposit round: admin picks ผลิต(รอโกดัง) / เดินทาง.
  const status: ProductStatus = data.fullPay ? 'arrived' : (data.startStatus ?? 'shipping');
  const product: Product = {
    id: pid, franchise_id: data.franchise_id, manufacturer_id: data.manufacturer_id,
    series_id: data.series_id || undefined, series_name: data.series_name, character_name: data.character_name || undefined,
    wcf_type: data.wcf_type, type: 'other', description: '', images: data.images ?? [],
    eta_note: data.fullPay ? 'พร้อมส่ง' : (status === 'production' ? 'ผลิต · รอเข้าโกดัง' : 'ระหว่างทาง'),
    price_total: data.price, deposit_amount: deposit,
    is_stock: false, height_cm: data.height_cm, has_variants: false,
    status, shipped_at: status === 'shipping' ? now : undefined,
    surplus_qty: 0, stock_origin: 'manual', created_at: now,
  };
  const withProduct = { ...db, products: [product, ...db.products] };
  return openSpecialRound(pid, { qty: data.qty, price: data.price, fullPay: data.fullPay, label: data.label, addSurplus: true, deposit })(withProduct);
};

/**
 * มีของเพิ่ม → เปิดรอบใหม่ (restock): closes the product's current open round (its buyer log stays
 * frozen per-batch) and opens a FRESH batch in the same mutation — no half-state where two rounds
 * are open. Price/deposit default to the previous round's snapshot; label defaults to "รอบ N".
 */
export const restockSpecialRound = (productId: string, opts: { qty: number; price?: number; deposit?: number; label?: string }) => (db: Database): Database => {
  const rounds = db.batches.filter((b) => b.product_id === productId);
  const last = [...rounds].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  const price = opts.price && opts.price > 0 ? opts.price : (last?.price_total ?? db.products.find((p) => p.id === productId)?.price_total ?? 0);
  const deposit = opts.deposit && opts.deposit > 0 ? Math.min(opts.deposit, price) : (last?.deposit_amount ?? price);
  if (price <= 0 || opts.qty <= 0) return db;
  const fullPay = deposit >= price;
  // RESET the product's lifecycle for the fresh round so round-2 buyers don't inherit round-1's
  // advanced status (which would show them "ถึงไทยแล้ว" + skip the warehouse gate). Old-round tickets
  // keep their own per-ticket status. fullPay = goods in hand → arrived; else new pre-order → production
  // (must pass ยืนยันโกดัง again). (audit W#1 — cross-round status bleed)
  const newStatus: ProductStatus = fullPay ? 'arrived' : 'production';
  const closed: Database = {
    ...db,
    batches: db.batches.map((b) => (b.product_id === productId && b.status === 'open' ? { ...b, status: 'closed' as const } : b)),
    products: db.products.map((p) => (p.id === productId
      ? { ...p, status: newStatus, shipped_at: undefined, eta_note: fullPay ? 'พร้อมส่ง' : 'ผลิต · รอเข้าโกดัง' }
      : p)),
  };
  return openSpecialRound(productId, {
    qty: opts.qty, price, deposit, fullPay,
    label: opts.label?.trim() || `รอบ ${rounds.length + 1}`, addSurplus: true,
  })(closed);
};

// ── ยืนยันโกดังจีน (warehouse gate for ผลิต → เดินทางมาไทย) ────────────────────
/** Record the maker's SF tracking on a product (pre-order/special) — internal, matched to the
 *  warehouse table. */
export const setProductSf = (productId: string, sf: string) => (db: Database): Database => ({
  ...db,
  products: db.products.map((p) => (p.id === productId ? { ...p, sf_code: sf.trim() || undefined } : p)),
});

/** Record the maker's SF tracking on a sourcing request (by-case). */
export const setSourcingSf = (requestId: string, sf: string) => (db: Database): Database => ({
  ...db,
  sourcingRequests: db.sourcingRequests.map((r) => (r.id === requestId ? { ...r, sf_code: sf.trim() || undefined } : r)),
});

/**
 * ยืนยันเข้าโกดัง for ONE ticket (per-ticket, per ryuma-warehouse-spec): the matched "เข้าโกดัง" date
 * becomes warehouse_at (the real ETA start) and flips this ticket's product_status ผลิต → เดินทาง.
 * When EVERY active ticket of the product has left production, the product-level status lifts too
 * (keeps the Status tab + sourcing page in sync — no duplicate status system). Requires a date
 * (the gate). Admin session only.
 */
export const confirmWarehouse = (ticketId: string, opts: { date: string; transport: SourcingTransport; slip?: string }) => (db: Database): Database => {
  const t = db.tickets.find((x) => x.id === ticketId);
  if (!t || t.product_status !== 'production' || !opts.date) return db;
  const tickets = db.tickets.map((x) => (x.id === ticketId
    ? { ...x, product_status: 'shipping' as const, warehouse_at: opts.date, warehouse_transport: opts.transport, warehouse_slip: opts.slip ?? x.warehouse_slip }
    : x));
  // scope "all moved" to the confirmed ticket's ROUND (batch cohort), not the whole product — a product
  // can hold an old delivered round + a new production round, and confirming the new round must lift the
  // product without being blocked by (or waiting on) the other round's tickets. (audit W#3)
  const cohort = tickets.filter((x) => x.product_id === t.product_id && (x.batch_id ?? null) === (t.batch_id ?? null));
  const allMoved = cohort.length > 0 && cohort.every((x) => x.product_status !== 'production');
  const products = allMoved
    ? db.products.map((p) => (p.id === t.product_id && p.status === 'production'
        // lift the product AND refresh the 'ผลิต · รอเข้าโกดัง' placeholder so the shop detail page
        // doesn't keep showing "ผลิต" on a product that's now กำลังเดินทาง.
        ? { ...p, status: 'shipping' as const, shipped_at: p.shipped_at ?? opts.date, eta_note: 'กำลังเดินทางมาไทย' }
        : p))
    : db.products;
  return { ...db, tickets, products };
};

/** Edit an OPEN round's price/qty/label — only while nobody has bought from it yet. */
export const editBatch = (batchId: string, patch: { price?: number; qty?: number; label?: string }) => (db: Database): Database => {
  if (db.tickets.some((t) => t.batch_id === batchId)) return db; // locked once a ticket references it
  return {
    ...db,
    batches: db.batches.map((b) => {
      if (b.id !== batchId) return b;
      const fullPay = b.deposit_amount >= b.price_total;
      const price = patch.price != null && patch.price > 0 ? patch.price : b.price_total;
      return {
        ...b,
        price_total: price,
        deposit_amount: fullPay ? price : b.deposit_amount,
        stock_qty: patch.qty != null && patch.qty > 0 ? Math.floor(patch.qty) : b.stock_qty,
        label: patch.label != null ? (patch.label.trim() || b.label) : b.label,
      };
    }),
  };
};

/** Customer submits a remaining-balance payment (slip) awaiting admin approval. A pre-order coupon
 *  applied here permanently reduces the ticket's remaining_amount (so `amount` = the discounted due)
 *  and consumes the grant (single use). */
export const submitRemainingPayment = (ticketId: string, userId: string, amount: number, slipUrl: string, coupon?: CouponApply) => (db: Database): Database => {
  const now = new Date().toISOString();
  const ticket = db.tickets.find((t) => t.id === ticketId);
  const due = ticket ? ticket.remaining_amount - ticket.remaining_paid : 0;
  // SECURITY: re-derive from the coupon TEMPLATE + re-validate (active/expiry/scope=pre-order/target)
  // — never trust the client-passed discount. (audit H1/H2)
  let validGrant = coupon && ticket ? db.couponGrants.find((g) => g.id === coupon.grantId && g.user_id === userId && g.status === 'active') : undefined;
  let discount = 0;
  if (validGrant && ticket) {
    const tpl = db.coupons.find((c) => c.id === validGrant!.coupon_id);
    const product = db.products.find((p) => p.id === ticket.product_id);
    const ok = !!tpl && tpl.active && !couponExpired(tpl, new Date()) && scopeAllows(tpl.scope, false) && (!product || couponMatchesProduct(tpl, product));
    discount = ok ? couponDiscount(tpl!, due) : 0;
    if (discount <= 0) validGrant = undefined;
  }
  return {
    ...db,
    // drop the discount off the ticket's remaining_amount so the (already reduced) slip settles it in full
    tickets: discount > 0 ? db.tickets.map((t) => (t.id === ticketId ? { ...t, remaining_amount: t.remaining_amount - discount } : t)) : db.tickets,
    couponGrants: validGrant
      ? db.couponGrants.map((g) => (g.id === validGrant.id ? { ...g, status: 'used' as const, used_at: now, ticket_id: ticketId, discount_amount: discount } : g))
      : db.couponGrants,
    remainingPayments: [
      { id: id('rp'), ticket_id: ticketId, user_id: userId, amount, slip_url: slipUrl, status: 'pending', created_at: now, coupon_grant_id: validGrant ? validGrant.id : undefined, coupon_discount: validGrant ? discount : undefined },
      ...db.remainingPayments,
    ],
  };
};

/** Admin approves a remaining payment → add to the ticket's remaining_paid; mark paid_full when settled. */
export const approveRemainingPayment = (paymentId: string) => (db: Database): Database => {
  const pay = db.remainingPayments.find((r) => r.id === paymentId);
  if (!pay || pay.status !== 'pending') return db;
  return {
    ...db,
    remainingPayments: db.remainingPayments.map((r) => (r.id === paymentId ? { ...r, status: 'approved', approved_at: new Date().toISOString() } : r)),
    tickets: db.tickets.map((t) => {
      if (t.id !== pay.ticket_id) return t;
      const paid = t.remaining_paid + pay.amount;
      return { ...t, remaining_paid: paid, status: paid >= t.remaining_amount ? 'paid_full' : t.status };
    }),
  };
};

// ── Rank system ────────────────────────────────────────────────────────────
import { rankIndex, rankPiecesOf, eligibleRank, lineDepositForRank } from '../domain/services/ranks';

/** Raise a pending rank-change request (skips if one to the same rank is already pending). */
export const requestRank = (userId: string, toRank: RankName, pieces: number) => (db: Database): Database => {
  const u = db.users.find((x) => x.id === userId);
  if (!u || rankIndex(toRank) <= rankIndex(u.rank)) return db;
  if (db.rankRequests.some((r) => r.user_id === userId && r.to_rank === toRank && r.status === 'pending')) return db;
  return {
    ...db,
    rankRequests: [
      { id: id('rr'), user_id: userId, from_rank: u.rank, to_rank: toRank, pieces, status: 'pending', created_at: new Date().toISOString() },
      ...db.rankRequests,
    ],
  };
};

/** Approve a rank request → promote the user (up only). Popup fires (rank_seen not touched). */
export const approveRankRequest = (reqId: string) => (db: Database): Database => {
  const req = db.rankRequests.find((r) => r.id === reqId);
  if (!req || req.status !== 'pending') return db;
  return {
    ...db,
    rankRequests: db.rankRequests.map((r) => (r.id === reqId ? { ...r, status: 'approved', resolved_at: new Date().toISOString() } : r)),
    users: db.users.map((u) => (u.id === req.user_id && rankIndex(req.to_rank) > rankIndex(u.rank) ? { ...u, rank: req.to_rank } : u)),
  };
};

export const rejectRankRequest = (reqId: string) => (db: Database): Database => ({
  ...db,
  rankRequests: db.rankRequests.map((r) => (r.id === reqId && r.status === 'pending' ? { ...r, status: 'rejected', resolved_at: new Date().toISOString() } : r)),
});

/** Admin grants a rank directly (bypasses conditions). Popup fires (rank_seen not touched). */
export const grantRank = (userId: string, rank: RankName) => (db: Database): Database => ({
  ...db,
  users: db.users.map((u) => (u.id === userId ? { ...u, rank } : u)),
});

/** Mark the user's current rank as "seen" so the congrats popup stops showing. */
export const markRankSeen = (userId: string) => (db: Database): Database => ({
  ...db,
  users: db.users.map((u) => (u.id === userId ? { ...u, rank_seen: u.rank } : u)),
});

// ── Auth / profile ───────────────────────────────────────────────────────────
/** Patch a user's editable fields (profile capture after login). */
export const updateUser = (userId: string, patch: Partial<Database['users'][number]>) => (db: Database): Database => ({
  ...db,
  users: db.users.map((u) => (u.id === userId ? { ...u, ...patch } : u)),
});

/** Insert or merge a full user row fetched from the server (phone+PIN login). */
export const upsertUserRow = (row: Database['users'][number]) => (db: Database): Database => ({
  ...db,
  users: db.users.some((u) => u.id === row.id) ? db.users.map((u) => (u.id === row.id ? { ...u, ...row } : u)) : [...db.users, row],
});

/** Ensure a users row exists for a freshly-logged-in Facebook account (never clobbers existing profile).
 *  New signups start `approved: false` — admin must approve before they can order. */
export const ensureAuthUser = (u: { id: string; display_name: string; facebook_id?: string; avatar_url?: string }) => (db: Database): Database => {
  if (db.users.some((x) => x.id === u.id)) return db;
  return {
    ...db,
    users: [
      ...db.users,
      { id: u.id, display_name: u.display_name, facebook_id: u.facebook_id, avatar_url: u.avatar_url, rank: 'bronze', rank_seen: 'bronze', total_spent: 0, preferred_lang: 'th', approved: false },
    ],
  };
};

/** Admin approves a pending member → they can now complete their profile + order. */
export const approveMember = (userId: string) => (db: Database): Database => ({
  ...db,
  users: db.users.map((u) => (u.id === userId ? { ...u, approved: true } : u)),
});

/** Admin removes a member (does not touch their existing tickets/orders). */
export const removeUser = (userId: string) => (db: Database): Database => ({
  ...db,
  users: db.users.filter((u) => u.id !== userId),
});

/** Suspend / unsuspend a member (กันสปาย) — reversible; RLS is_app_approved() hides the catalog
 *  from suspended accounts (migration v40). Their tickets/orders are untouched. */
export const setSuspended = (userId: string, suspended: boolean) => (db: Database): Database => ({
  ...db,
  users: db.users.map((u) => (u.id === userId ? { ...u, suspended } : u)),
});

// ── Coupons ──────────────────────────────────────────────────────────────────
/** Create a discount coupon template (admin). */
export const createCoupon = (data: { label: string; value: number; scope: CouponScope; target_product_id?: string; target_maker_id?: string; expires_at?: string }) => (db: Database): Database => ({
  ...db,
  coupons: [
    { id: id('c'), label: data.label, value: data.value, scope: data.scope, target_product_id: data.target_product_id || undefined, target_maker_id: data.target_maker_id || undefined, expires_at: data.expires_at || undefined, active: true, created_at: new Date().toISOString() },
    ...db.coupons,
  ],
});

/** Patch a coupon template (label / value / scope / target / expiry / active). */
export const updateCoupon = (couponId: string, patch: Partial<Coupon>) => (db: Database): Database => ({
  ...db,
  coupons: db.coupons.map((c) => (c.id === couponId ? { ...c, ...patch } : c)),
});

/** Delete a coupon template + all its grants (used ones are historical but go too — admin choice). */
export const deleteCoupon = (couponId: string) => (db: Database): Database => ({
  ...db,
  coupons: db.coupons.filter((c) => c.id !== couponId),
  couponGrants: db.couponGrants.filter((g) => g.coupon_id !== couponId),
});

/** Grant a coupon to a set of users (skips anyone who already holds an active copy). */
export const grantCoupon = (couponId: string, userIds: string[]) => (db: Database): Database => {
  const now = new Date().toISOString();
  const fresh: CouponGrant[] = [];
  for (const uid of userIds) {
    if (db.couponGrants.some((g) => g.coupon_id === couponId && g.user_id === uid && g.status === 'active')) continue;
    fresh.push({ id: id('cg'), coupon_id: couponId, user_id: uid, status: 'active', granted_at: now });
  }
  return { ...db, couponGrants: [...fresh, ...db.couponGrants] };
};

/** Grant a coupon to every non-admin member of a rank. */
export const grantCouponToRank = (couponId: string, rank: RankName) => (db: Database): Database =>
  grantCoupon(couponId, db.users.filter((u) => !u.is_admin && u.id !== 'u-admin' && u.rank === rank).map((u) => u.id))(db);

/** Revoke an unused granted coupon (used ones stay for history). */
export const revokeGrant = (grantId: string) => (db: Database): Database => ({
  ...db,
  couponGrants: db.couponGrants.map((g) => (g.id === grantId && g.status === 'active' ? { ...g, status: 'revoked' as const } : g)),
});

// ── Event ภารกิจ (mission quest — ryuma-event-spec) ─────────────────────────
import { MISSION_KEY, missionConfig as readMissionConfig, missionSubmissionFor, type MissionConfig } from '../domain/services/missions';

/** Save the mission-event config (app_config key → jsonb; no schema change). Admin session. */
export const setMissionConfig = (cfg: MissionConfig) => (db: Database): Database => ({
  ...db,
  appConfig: [{ key: MISSION_KEY, value: cfg as unknown as Record<string, unknown> }, ...db.appConfig.filter((c) => c.key !== MISSION_KEY)],
});

/** Customer submits the completed quest — ONCE per event: a pending/approved submission blocks another
 *  (a REJECTED one doesn't, so they can fix the proof and resubmit). Status always starts 'pending'
 *  (matches the RLS insert policy). */
export const submitMission = (userId: string, proofUrl?: string) => (db: Database): Database => {
  const latest = missionSubmissionFor(db, userId);
  if (latest && latest.status !== 'rejected') return db;
  const sub: MissionSubmission = {
    id: id('ms'), event_key: MISSION_KEY, user_id: userId, status: 'pending',
    proof_url: proofUrl || undefined, created_at: new Date().toISOString(),
  };
  return { ...db, missionSubmissions: [sub, ...db.missionSubmissions] };
};

/** Admin approves a submission → mark approved + grant the reward coupon. Runs in the ADMIN session
 *  only (RLS: customers can't update submissions or mint grants — DNA rule 7). Idempotent twice over:
 *  the status guard stops a double-approve, and grantCoupon itself skips a user already holding an
 *  active copy of the reward. */
export const approveMission = (submissionId: string) => (db: Database): Database => {
  const sub = db.missionSubmissions.find((s) => s.id === submissionId);
  if (!sub || sub.status !== 'pending') return db;
  const cfg = readMissionConfig(db);
  const marked: Database = {
    ...db,
    missionSubmissions: db.missionSubmissions.map((s) => (s.id === submissionId ? { ...s, status: 'approved' as const, approved_at: new Date().toISOString() } : s)),
  };
  return cfg?.reward_coupon_id ? grantCoupon(cfg.reward_coupon_id, [sub.user_id])(marked) : marked;
};

/** Admin rejects (e.g. proof screenshot ไม่ใช่ของจริง) — customer sees the state and can resubmit. */
export const rejectMission = (submissionId: string) => (db: Database): Database => ({
  ...db,
  missionSubmissions: db.missionSubmissions.map((s) => (s.id === submissionId && s.status === 'pending' ? { ...s, status: 'rejected' as const } : s)),
});

// ── Events / กิจกรรม ─────────────────────────────────────────────────────────
/** Create or update an event. Saving an ACTIVE event pauses every other one (only one live at a time). */
export const upsertCampaign = (c: Campaign) => (db: Database): Database => ({
  ...db,
  campaigns: upsertById(
    c.active ? db.campaigns.map((x) => (x.id === c.id ? x : { ...x, active: false })) : db.campaigns,
    c,
  ),
});

/** Delete an event template. Awards + already-granted coupons stay as history. */
export const deleteCampaign = (campaignId: string) => (db: Database): Database => ({
  ...db,
  campaigns: db.campaigns.filter((c) => c.id !== campaignId),
});

/**
 * Grant every reward a customer has earned-but-not-yet-granted for ONE event. Each reward becomes a
 * fresh Coupon template (expiring reward_expiry_days after the grant) plus coupon_count grants, and a
 * CampaignAward row so it can never be granted twice — while LOOP repeats still qualify because a
 * later cycle is a different (tier,cycle) key. No-op when there is nothing pending.
 *
 * RLS: this runs in the ADMIN session (called from approveOrder), never the customer's — customers
 * are blocked from minting coupons/grants by design (ryuma-dna-save). Auto-granted on approval.
 */
export const grantCampaignRewards = (campaignId: string, userId: string) => (db: Database): Database => {
  const c = db.campaigns.find((x) => x.id === campaignId);
  if (!c) return db;
  const now = new Date();
  const pending = unclaimedAwards(db, c, userId, now);
  if (pending.length === 0) return db;
  const nowIso = now.toISOString();
  const expiresAt = c.reward_expiry_days > 0
    ? new Date(now.getTime() + c.reward_expiry_days * 86400000).toISOString().slice(0, 10)
    : undefined;
  const coupons: Coupon[] = [];
  const grants: CouponGrant[] = [];
  const awards: CampaignAward[] = [];
  for (const a of pending) {
    const couponId = id('c');
    coupons.push({
      id: couponId,
      label: `${c.name} · คูปอง ${a.tier.coupon_value}฿`,
      value: a.tier.coupon_value,
      scope: c.reward_scope,
      target_product_id: c.target_product_id || undefined,
      target_maker_id: c.target_maker_id || undefined,
      expires_at: expiresAt,
      active: true,
      created_at: nowIso,
      campaign_id: c.id,
    });
    for (let i = 0; i < Math.max(1, a.tier.coupon_count); i++) {
      grants.push({ id: id('cg'), coupon_id: couponId, user_id: userId, status: 'active', granted_at: nowIso });
    }
    awards.push({ id: id('ca'), campaign_id: c.id, user_id: userId, tier_index: a.key, cycle: a.cycle, claimed_at: nowIso, coupon_id: couponId });
  }
  return {
    ...db,
    coupons: [...coupons, ...db.coupons],
    couponGrants: [...grants, ...db.couponGrants],
    campaignAwards: [...awards, ...db.campaignAwards],
  };
};

// ── ระบบหาของ (sourcing requests) ────────────────────────────────────────────
const SOURCING_TTL_MS = 5 * 86400000;

/** Customer files a sourcing request (cap: 3 open per user — UI guards too, this is the backstop).
 *  Single-table insert from the customer session (DNA rule 7 friendly). */
export const submitSourcingRequest = (data: {
  user_id: string; maker_id?: string; maker_name: string; franchise_id?: string; franchise_name: string;
  character_name: string; qty: number; images: string[]; note?: string; resent_from?: string;
}) => (db: Database): Database => {
  const open = db.sourcingRequests.filter((r) => r.user_id === data.user_id
    && (r.status === 'requested' || r.status === 'paid'
      || (r.status === 'quoted' && (!r.expires_at || new Date(r.expires_at).getTime() > Date.now())))).length;
  if (open >= 3) return db;
  return {
    ...db,
    sourcingRequests: [{
      id: id('sr'), user_id: data.user_id,
      maker_id: data.maker_id || undefined, maker_name: data.maker_name.trim(),
      franchise_id: data.franchise_id || undefined, franchise_name: data.franchise_name.trim(),
      character_name: data.character_name.trim(), qty: Math.max(1, Math.floor(data.qty)),
      images: data.images.slice(0, 3), note: data.note?.trim() || undefined,
      status: 'requested', created_at: new Date().toISOString(), resent_from: data.resent_from,
    }, ...db.sourcingRequests],
  };
};

/** "ส่งเช็คใหม่" — mark the timed-out row expired and clone it as a fresh request (no re-typing). */
export const resendSourcingRequest = (requestId: string) => (db: Database): Database => {
  const r = db.sourcingRequests.find((x) => x.id === requestId);
  if (!r) return db;
  const marked = { ...db, sourcingRequests: db.sourcingRequests.map((x) => (x.id === requestId ? { ...x, status: 'expired' as const } : x)) };
  return submitSourcingRequest({ user_id: r.user_id, maker_id: r.maker_id, maker_name: r.maker_name, franchise_id: r.franchise_id, franchise_name: r.franchise_name, character_name: r.character_name, qty: r.qty, images: r.images, note: r.note, resent_from: r.id })(marked);
};

/** Admin quotes: price/deposit per unit + transport → 5-day TTL starts. */
export const quoteSourcing = (requestId: string, q: { price: number; deposit: number; transport: 'truck' | 'ship' }) => (db: Database): Database => ({
  ...db,
  sourcingRequests: db.sourcingRequests.map((r) => (r.id === requestId && ['requested', 'quoted', 'unavailable'].includes(r.status)
    ? { ...r, status: 'quoted' as const, price: Math.max(1, Math.round(q.price)), deposit: Math.min(Math.max(1, Math.round(q.deposit)), Math.max(1, Math.round(q.price))), transport: q.transport, quoted_at: new Date().toISOString(), expires_at: new Date(Date.now() + SOURCING_TTL_MS).toISOString() }
    : r)),
});

/** Admin: "รายการนี้ยังไม่สามารถหาได้ตอนนี้" → watchlist, 5-day TTL. */
export const unavailableSourcing = (requestId: string) => (db: Database): Database => ({
  ...db,
  sourcingRequests: db.sourcingRequests.map((r) => (r.id === requestId && ['requested', 'quoted'].includes(r.status)
    ? { ...r, status: 'unavailable' as const, expires_at: new Date(Date.now() + SOURCING_TTL_MS).toISOString() }
    : r)),
});

/** Customer attaches the deposit slip (only while the quote is alive). Own-row update (RLS-legal). */
export const paySourcing = (requestId: string, slipUrl: string) => (db: Database): Database => ({
  ...db,
  sourcingRequests: db.sourcingRequests.map((r) => (r.id === requestId && r.status === 'quoted'
    && (!r.expires_at || new Date(r.expires_at).getTime() > Date.now())
    ? { ...r, status: 'paid' as const, slip_url: slipUrl, paid_at: new Date().toISOString() }
    : r)),
});

/** Admin links a custom-typed ค่าย/เรื่อง to real catalog rows (required before เริ่มงาน). */
export const linkSourcingCatalog = (requestId: string, link: { maker_id?: string; franchise_id?: string }) => (db: Database): Database => ({
  ...db,
  sourcingRequests: db.sourcingRequests.map((r) => (r.id === requestId ? { ...r, ...(link.maker_id ? { maker_id: link.maker_id } : {}), ...(link.franchise_id ? { franchise_id: link.franchise_id } : {}) } : r)),
});

/**
 * Admin เริ่มงาน (slip checked): mint the fulfillment as REAL pre-order plumbing — a HIDDEN product
 * (status 'production' → never in the shop), a CLOSED 1-round batch (never in the storefront; the
 * ticket's batch_id also keeps it out of event counting per spec), and the customer's ticket. From
 * here the normal lot flow takes over (Status tab → shipping/arrived pushes, ส่วนต่าง, พัสดุ).
 * Requires maker_id + franchise_id linked (ticket_no needs the franchise abbr).
 */
export const approveSourcingStart = (requestId: string) => (db: Database): Database => {
  const r = db.sourcingRequests.find((x) => x.id === requestId);
  if (!r || r.status !== 'paid' || !r.maker_id || !r.franchise_id || !r.price || !r.deposit) return db;
  const now = new Date().toISOString();
  const pid = id('p');
  const franchise = db.franchises.find((f) => f.id === r.franchise_id);
  const buyer = db.users.find((u) => u.id === r.user_id);
  const product: Product = {
    id: pid, franchise_id: r.franchise_id, manufacturer_id: r.maker_id,
    series_name: r.character_name, character_name: r.character_name,
    type: 'other', description: `หาของให้ ${buyer?.display_name ?? ''}`.trim(), images: r.images,
    eta_note: 'หาของ · เริ่มงานแล้ว', price_total: r.price, deposit_amount: r.deposit,
    is_stock: false, has_variants: false, status: 'production', surplus_qty: 0, created_at: now,
  };
  const batch = { id: id('b'), product_id: pid, label: 'หาของ', price_total: r.price, deposit_amount: r.deposit, stock_qty: r.qty, status: 'closed' as const, created_at: now };
  const ticket: PreorderTicket = {
    id: id('t'), ticket_no: nextTicketNo(db, franchise?.abbr ?? 'xx'),
    product_id: pid, batch_id: batch.id, owner_id: r.user_id, original_buyer_id: r.user_id,
    qty: r.qty, deposit_paid: r.deposit * r.qty, remaining_amount: Math.max(0, r.price - r.deposit) * r.qty,
    remaining_paid: 0, status: 'active', product_status: 'production', qr_code_url: '',
    created_at: now, approved_at: now,
  };
  return {
    ...db,
    products: [product, ...db.products],
    batches: [batch, ...db.batches],
    tickets: [ticket, ...db.tickets],
    sourcingRequests: db.sourcingRequests.map((x) => (x.id === requestId ? { ...x, status: 'working' as const, approved_at: now, product_id: pid } : x)),
  };
};

/** Admin edits the transport ETA ranges (app_config 'sourcing_eta'). */
export const setSourcingEta = (value: { truck_min: number; truck_max: number; ship_min: number; ship_max: number }) => (db: Database): Database => ({
  ...db,
  appConfig: [{ key: 'sourcing_eta', value }, ...db.appConfig.filter((c) => c.key !== 'sourcing_eta')],
});

// ── Web Push subscriptions ───────────────────────────────────────────────────
/** Save one device's push subscription (replaces any older row for the same endpoint). */
export const addPushSubscription = (sub: PushSubscriptionRow) => (db: Database): Database => ({
  ...db,
  pushSubscriptions: [sub, ...db.pushSubscriptions.filter((s) => s.endpoint !== sub.endpoint)],
});

/** Drop a subscription — used when the user turns notifications off, or when a send reports the
 *  endpoint gone (410: the browser revoked it). */
export const removePushSubscriptionByEndpoint = (endpoint: string) => (db: Database): Database => ({
  ...db,
  pushSubscriptions: db.pushSubscriptions.filter((s) => s.endpoint !== endpoint),
});

/** Stamp the first time this member opens the app installed to the home screen (PWA standalone) — for
 *  the admin install-rate metric. Idempotent: only writes once (never overwrites the first timestamp),
 *  and only touches installed_at on the caller's own row (RLS-safe, unprotected column). */
export const markInstalled = (userId: string) => (db: Database): Database => {
  const u = db.users.find((x) => x.id === userId);
  if (!u || u.installed_at) return db;
  return { ...db, users: db.users.map((x) => (x.id === userId ? { ...x, installed_at: new Date().toISOString() } : x)) };
};

/** Save a customer's broadcast preferences (สินค้าใหม่ pushes). Empty arrays = รับทั้งหมด →
 *  the row is dropped entirely (absent row = default-all, keeps the table tiny). */
export const setPushPrefs = (userId: string, makerIds: string[], franchiseIds: string[]) => (db: Database): Database => {
  const rest = db.pushPrefs.filter((p) => p.user_id !== userId);
  if (makerIds.length === 0 && franchiseIds.length === 0) return { ...db, pushPrefs: rest };
  return { ...db, pushPrefs: [{ user_id: userId, maker_ids: makerIds, franchise_ids: franchiseIds, updated_at: new Date().toISOString() }, ...rest] };
};

/** Admin: enable/disable one push trigger (Push Control). Missing key = enabled. */
export const setPushConfig = (key: string, enabled: boolean) => (db: Database): Database => ({
  ...db,
  pushConfig: [{ key, enabled }, ...db.pushConfig.filter((c) => c.key !== key)],
});

/**
 * SELF-HEAL: re-issue this customer's own missing tickets (approved-order items with no matching
 * ticket). Runs automatically in CustomerShell on load, so a split flush (mobile backgrounding on a
 * Diamond auto-approve — orders wrote, tickets didn't) fixes itself the next time they open the app.
 * RLS-legal: a customer may insert their OWN tickets. Snapshot values come from the order item.
 */
export const fillMissingTicketsFor = (userId: string, startNos?: TicketNoStart) => (db: Database): Database => {
  const missing = unmatchedApprovedItems(db, userId);
  if (missing.length === 0) return db;
  const allocNo = ticketNoAllocator(db, startNos, new Date());
  const issued: PreorderTicket[] = [];
  for (const { order, item } of missing) {
    const product = db.products.find((p) => p.id === item.product_id);
    if (!product) continue;
    const abbr = franchiseOf(db, product)?.abbr ?? 'xx';
    const unitPrice = item.unit_price ?? product.price_total;
    const unitDeposit = item.unit_deposit ?? product.deposit_amount;
    const when = order.approved_at ?? order.created_at;
    issued.push({
      id: id('t'), ticket_no: allocNo(abbr, issued),
      product_id: product.id, variant_id: item.variant_id, batch_id: item.batch_id,
      owner_id: userId, original_buyer_id: userId, qty: item.qty,
      deposit_paid: item.deposit_amount ?? unitDeposit * item.qty, // line snapshot (rank perk included)
      remaining_amount: Math.max(0, unitPrice - unitDeposit) * item.qty,
      remaining_paid: 0, status: 'active', product_status: product.status, qr_code_url: '',
      created_at: when, approved_at: when,
    });
  }
  return issued.length ? { ...db, tickets: [...issued, ...db.tickets] } : db;
};

/**
 * SELF-HEAL: give back this customer's coupons burned by a split flush (grant went 'used' but the
 * order / remaining-payment it paid for never persisted — coupon_grants is one of the FIRST tables
 * written). For the ticket case, when the ticket-side discount DID land (detected against the
 * order-item snapshot) the discount is added back before reactivating, so nothing double-benefits.
 * RLS-legal: a customer may update their own grants and tickets. Idempotent.
 */
export const reclaimOrphanCouponGrants = (userId: string) => (db: Database): Database => {
  const orphans = orphanUsedGrants(db, userId);
  if (orphans.length === 0) return db;
  const ids = new Set(orphans.map((o) => o.grant.id));
  const revertByTicket = new Map<string, number>();
  for (const o of orphans) {
    if (o.kind === 'ticket' && o.revertTicket && o.grant.ticket_id)
      revertByTicket.set(o.grant.ticket_id, (revertByTicket.get(o.grant.ticket_id) ?? 0) + (o.grant.discount_amount ?? 0));
  }
  return {
    ...db,
    couponGrants: db.couponGrants.map((g) => (ids.has(g.id)
      ? { ...g, status: 'active' as const, used_at: undefined, order_id: undefined, ticket_id: undefined, discount_amount: undefined }
      : g)),
    tickets: revertByTicket.size
      ? db.tickets.map((t) => (revertByTicket.has(t.id) ? { ...t, remaining_amount: t.remaining_amount + revertByTicket.get(t.id)! } : t))
      : db.tickets,
  };
};

/** Admin sweep: credit any earned-but-unminted event rewards for EVERY member — covers Diamond
 *  auto-approved orders (customer sessions can't mint) and repaired tickets. Idempotent. */
export const grantRewardsSweep = () => (db: Database): Database =>
  db.users.filter((u) => !u.is_admin && u.id !== 'u-admin').reduce((acc, u) => grantAllCampaignRewards(u.id)(acc), db);

/** Grant pending rewards for a user across every ACTIVE event (each no-ops if nothing is due).
 *  Called from approveOrder so a newly-approved pre-order immediately mints any reward it just
 *  unlocked. Paused (active=false) events never grant — otherwise an old event with an overlapping
 *  window would double-reward the same tickets after a new one auto-pauses it. Note an active event
 *  still grants shortly PAST its ends_at: tickets must be created in-window, so this only covers
 *  orders placed near the end and approved a little late (intended). */
export const grantAllCampaignRewards = (userId: string) => (db: Database): Database =>
  db.campaigns.filter((c) => c.active).reduce((acc, c) => grantCampaignRewards(c.id, userId)(acc), db);

/** List one of my tickets on the P2P marketplace (PRD §12). */
export function listForResale(ticketId: string, fromUserId: string, askingPrice: number) {
  return (db: Database): Database => ({
    ...db,
    transfers: [
      {
        id: id('tr'),
        ticket_id: ticketId,
        from_user_id: fromUserId,
        asking_price: askingPrice,
        status: 'listed',
        listed_at: new Date().toISOString(),
      },
      ...db.transfers,
    ],
  });
}

// ---- Admin catalog CRUD (PRD §16 จัดการสินค้า) ------------------------------

/** Patch shop settings. When the PRICE FORMULA / deposit tiers change, re-price every OPEN pre-order
 *  from its saved yuan/tier so the whole system stays in lockstep — the card, the cart, checkout, and the
 *  ticket issued at order time all read product.price_total/deposit_amount, so there's no way to show a
 *  new price but bill the old one. Already-issued tickets keep their snapshot (never touched here); closed/
 *  shipping rounds and in-stock keep their price too. Variant products (no per-variant yuan stored) are
 *  left as-is. (user request 2026-07-07) */
/** Re-price ONE product from the formula IF it's still an open pre-order (else leave it). */
const repricedFromFormula = (settings: Database['settings'], p: Product): Product => {
  if (p.is_stock || p.status !== 'open') return p; // only products still taking bookings re-price
  const price_total = p.cost_yuan != null ? priceFromYuan(settings, p.cost_yuan) : p.price_total;
  const deposit_amount = p.wcf_type ? depositFor(settings, p.wcf_type) : p.deposit_amount;
  return price_total === p.price_total && deposit_amount === p.deposit_amount ? p : { ...p, price_total, deposit_amount };
};

export const updateSettings = (patch: Partial<Database['settings']>) => (db: Database): Database => {
  const settings = { ...db.settings, ...patch };
  const priceKeys = ['yuan_base', 'baht_base', 'baht_per_yuan', 'deposit_wcf', 'deposit_mega'] as const;
  const pricingChanged = priceKeys.some((k) => patch[k] != null && patch[k] !== db.settings[k]);
  if (!pricingChanged) return { ...db, settings };
  return { ...db, settings, products: db.products.map((p) => repricedFromFormula(settings, p)) };
};

/** Force re-apply the CURRENT formula to every open pre-order (for products created under an older
 *  formula, where no value "changed" to trigger the auto re-price). */
export const repriceOpenPreorders = () => (db: Database): Database => ({
  ...db,
  products: db.products.map((p) => repricedFromFormula(db.settings, p)),
});

export const upsertPaymentAccount = (a: PaymentAccount) => (db: Database): Database => ({ ...db, paymentAccounts: upsertById(db.paymentAccounts, a) });
export const removePaymentAccount = (aid: string) => (db: Database): Database => ({ ...db, paymentAccounts: db.paymentAccounts.filter((a) => a.id !== aid) });

export const upsertCategory = (c: Category) => (db: Database): Database => ({ ...db, categories: upsertById(db.categories, c) });
export const removeCategory = (cid: string) => (db: Database): Database => ({ ...db, categories: db.categories.filter((c) => c.id !== cid) });

export const upsertManufacturer = (m: Manufacturer) => (db: Database): Database => ({ ...db, manufacturers: upsertById(db.manufacturers, m) });
export const removeManufacturer = (mid: string) => (db: Database): Database => ({ ...db, manufacturers: db.manufacturers.filter((m) => m.id !== mid) });

export const upsertFranchise = (f: Franchise) => (db: Database): Database => ({ ...db, franchises: upsertById(db.franchises, f) });
export const removeFranchise = (fid: string) => (db: Database): Database => ({ ...db, franchises: db.franchises.filter((f) => f.id !== fid) });

export const upsertSeries = (s: Series) => (db: Database): Database => ({ ...db, series: upsertById(db.series, s) });
export const removeSeries = (sid: string) => (db: Database): Database => ({ ...db, series: db.series.filter((s) => s.id !== sid) });

export const upsertProduct = (p: Product) => (db: Database): Database => ({ ...db, products: upsertById(db.products, p) });

/**
 * Move a lot to a new status (shipping/arrived/delivered) and cascade the status
 * to every ticket of that product, so customers' wallets track the lifecycle.
 * `extra` carries tracking_no/shipped_at when the lot starts shipping.
 */
export const setProductStatus = (productId: string, status: ProductStatus, extra?: { tracking_no?: string; shipped_at?: string }) => (db: Database): Database => {
  const base: Database = {
    ...db,
    products: db.products.map((p) => (p.id === productId ? { ...p, status, ...(extra ?? {}) } : p)),
    tickets: db.tickets.map((t) => (t.product_id === productId ? { ...t, product_status: status } : t)),
  };
  // สต๊อกใบพรี auto-finish: when a special-round product is DELIVERED, archive its open round(s) and
  // auto-flip any leftover surplus → in-stock (only if the round is settled — no unpaid tickets). (ryuma-preorder-stock-spec)
  if (status === 'delivered' && base.batches.some((b) => b.product_id === productId)) {
    const closed: Database = { ...base, batches: base.batches.map((b) => (b.product_id === productId && b.status === 'open' ? { ...b, status: 'closed' as const } : b)) };
    const p = closed.products.find((x) => x.id === productId);
    if (p && canConvertToInStock(closed, p)) {
      const lastBatch = [...closed.batches].filter((b) => b.product_id === productId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
      return convertToInStock(productId, lastBatch?.price_total ?? p.price_total)(closed);
    }
    return closed;
  }
  return base;
};

/**
 * Record the in-Thailand parcel (carrier + tracking no + optional photo) for a single
 * ticket. This is the LAST step of the pre-order: the ticket is marked 'shipped' (done).
 */
export const setParcel = (ticketId: string, carrier: Carrier, parcelNo: string, image?: string) => (db: Database): Database => ({
  ...db,
  tickets: db.tickets.map((t) =>
    t.id === ticketId
      ? { ...t, carrier, parcel_no: parcelNo, parcel_image: image, status: 'shipped' as const, shipped_out_at: new Date().toISOString() }
      : t,
  ),
});

/**
 * Close the pre-order round for the given products → status 'production'.
 * Records the final production qty and the surplus (final − ordered) that becomes
 * shop stock. Ordered qty is the sum of ticket qty for the product.
 */
export const closeProduction = (entries: { productId: string; finalQty: number }[]) => (db: Database): Database => {
  const ids = new Set(entries.map((e) => e.productId));
  const now = new Date().toISOString();
  const orderedOf = (pid: string) => db.tickets.filter((t) => t.product_id === pid).reduce((s, t) => s + t.qty, 0);
  // same round-log as a board close (booked vs final snapshot) — a plain ปิดรอบ is also 1 cycle
  const lines = entries.map((e) => {
    const p = db.products.find((pp) => pp.id === e.productId);
    const booked = orderedOf(e.productId);
    const final = Math.max(booked, e.finalQty);
    return { product_id: e.productId, name: p?.series_name ?? '—', booked, final, surplus: Math.max(0, final - booked) };
  });
  const makerId = db.products.find((p) => p.id === entries[0]?.productId)?.manufacturer_id ?? '';
  return {
    ...db,
    products: db.products.map((p) => {
      const e = entries.find((x) => x.productId === p.id);
      if (!e) return p;
      const booked = orderedOf(p.id);
      const final = Math.max(booked, e.finalQty); // can't order fewer than booked
      return { ...p, status: 'production', production_qty: final, surplus_qty: Math.max(0, final - booked) };
    }),
    // ปิดใบพรี = เปิดจอง → ผลิต : ต้อง cascade สถานะลงทุกตั๋วเหมือน setProductStatus (ให้ 2 ฟีเจอร์ตรงกัน)
    tickets: db.tickets.map((t) => (ids.has(t.product_id) ? { ...t, product_status: 'production' } : t)),
    boardLogs: entries.length
      ? [{ id: id('bl'), board_title: 'ปิดรอบสั่งผลิต', maker_id: makerId, closed_at: now, lines }, ...db.boardLogs]
      : db.boardLogs,
  };
};
export const removeProduct = (pid: string) => (db: Database): Database => ({
  ...db,
  products: db.products.filter((p) => p.id !== pid),
  variants: db.variants.filter((v) => v.product_id !== pid),
});

/** Replace a product's variants with the given list. A blank variant price inherits the
 *  product's price; variants always share the product's deposit. */
export const setProductVariants = (productId: string, list: { id?: string; name: string; price_total?: number; image_url?: string }[]) => (db: Database): Database => {
  const p = db.products.find((pp) => pp.id === productId);
  const basePrice = p?.price_total ?? 0;
  const baseDeposit = p?.deposit_amount ?? 0;
  return {
    ...db,
    variants: [
      ...db.variants.filter((v) => v.product_id !== productId),
      ...list.filter((v) => v.name.trim()).map((v) => ({ id: v.id ?? id('v'), product_id: productId, name: v.name.trim(), price_total: v.price_total ?? basePrice, deposit_amount: baseDeposit, image_url: v.image_url })),
    ],
  };
};

/** Create many products in one atomic write (bulk add). Each item brings its Product + optional
 *  variants; a blank variant price inherits the product price, and variants share the product deposit. */
export const bulkCreateProducts = (items: { product: Product; variants: { name: string; price_total?: number; image_url?: string }[] }[]) => (db: Database): Database => {
  const newVariants = items.flatMap((it) =>
    it.variants.filter((v) => v.name.trim()).map((v) => ({
      id: id('v'), product_id: it.product.id, name: v.name.trim(),
      price_total: v.price_total ?? it.product.price_total, deposit_amount: it.product.deposit_amount, image_url: v.image_url,
    })),
  );
  return { ...db, products: [...items.map((it) => it.product), ...db.products], variants: [...newVariants, ...db.variants] };
};

// same character + maker already sold in-stock? (used to merge stock instead of duplicating a SKU)
const sameInStock = (products: Product[], p: Product, excludeId?: string) =>
  products.find((x) => x.is_stock && x.id !== excludeId && x.manufacturer_id === p.manufacturer_id && (x.character_name ?? x.series_name) === (p.character_name ?? p.series_name));

/** Bulk-create in-stock (พร้อมส่ง) products. If a character already has an in-stock SKU (same ค่าย),
 *  its qty is MERGED into that SKU instead of creating a duplicate. Logs each stock change. */
export const bulkCreateStock = (products: Product[]) => (db: Database): Database => {
  let out: Database = { ...db, products: [...db.products], stockAdditions: [...db.stockAdditions] };
  const now = new Date().toISOString();
  for (const np of products) {
    const merge = sameInStock(out.products, np);
    if (merge) {
      out.products = out.products.map((x) => (x.id === merge.id ? { ...x, stock_qty: (x.stock_qty ?? 0) + (np.stock_qty ?? 0) } : x));
      out.stockAdditions = [{ id: id('sa'), product_id: merge.id, qty: np.stock_qty ?? 0, note: `รวมสต๊อก (${np.series_name})`, created_at: now }, ...out.stockAdditions];
    } else {
      out.products = [np, ...out.products];
      out.stockAdditions = [{ id: id('sa'), product_id: np.id, qty: np.stock_qty ?? 0, note: 'สร้าง (สต๊อกเริ่มต้น)', created_at: now }, ...out.stockAdditions];
    }
  }
  return out;
};

/** Top up an IN-STOCK product's on-hand quantity + optionally set a new price + log the addition. */
export const restockInStock = (productId: string, qty: number, newPrice?: number) => (db: Database): Database => ({
  ...db,
  products: db.products.map((p) => (p.id === productId ? { ...p, stock_qty: (p.stock_qty ?? 0) + qty, ...(newPrice != null ? { price_total: newPrice, deposit_amount: newPrice } : {}) } : p)),
  stockAdditions: [{ id: id('sa'), product_id: productId, qty, note: newPrice != null ? `เติม +${qty} · ราคาใหม่ ${newPrice}` : `เติม +${qty}`, created_at: new Date().toISOString() }, ...db.stockAdditions],
});
export const addInStock = restockInStock; // alias (qty only)

/** Flip a finished pre-order → in-stock (พร้อมส่ง). Opening stock = its leftover surplus, at the given
 *  price. If a same-character in-stock SKU exists, the surplus is MERGED into it (this SKU stays as-is,
 *  surplus cleared). Caller (UI) enforces the arrived/settled gate via canConvertToInStock. */
export const convertToInStock = (productId: string, price: number) => (db: Database): Database => {
  const p = db.products.find((x) => x.id === productId);
  if (!p) return db;
  // only the UNSOLD leftover becomes in-stock — surplus already sold via a special round is now
  // customer tickets, so using surplus_qty (raw) would double-count and oversell. (found by test T6)
  const surplus = stockRemaining(db, p);
  const now = new Date().toISOString();
  const merge = sameInStock(db.products, p, productId);
  if (merge) {
    return {
      ...db,
      products: db.products.map((x) => {
        if (x.id === merge.id) return { ...x, stock_qty: (x.stock_qty ?? 0) + surplus };
        if (x.id === productId) return { ...x, surplus_qty: 0 };
        return x;
      }),
      stockAdditions: [{ id: id('sa'), product_id: merge.id, qty: surplus, note: `รวมจากพรี (${p.series_name})`, created_at: now }, ...db.stockAdditions],
    };
  }
  return {
    ...db,
    products: db.products.map((x) => (x.id === productId
      ? { ...x, is_stock: true, stock_qty: surplus, surplus_qty: 0, price_total: price, deposit_amount: price, status: 'open', eta_note: 'พร้อมส่ง', stock_origin: 'preorder' as const }
      : x)),
    stockAdditions: [{ id: id('sa'), product_id: productId, qty: surplus, note: 'แปลงจากพรี (ส่วนเกิน)', created_at: now }, ...db.stockAdditions],
  };
};

/** Admin edits a ticket's deposit. The TOTAL price is kept constant (deposit + remaining),
 *  so raising the deposit lowers the remaining and vice-versa. e.g. 1500 total, dep 300 →
 *  remaining 1200; set dep 400 → remaining 1100. Clamped to [0, total]. */
export const editTicketDeposit = (ticketId: string, newDeposit: number) => (db: Database): Database => ({
  ...db,
  tickets: db.tickets.map((t) => {
    if (t.id !== ticketId) return t;
    const total = t.deposit_paid + t.remaining_amount;
    const dep = Math.max(0, Math.min(newDeposit, total));
    return { ...t, deposit_paid: dep, remaining_amount: total - dep };
  }),
});

/** Admin deletes a ticket entirely — removes it + any linked remaining-payments and
 *  P2P transfer listings from the DB. (Stock return for in-stock items is handled in the
 *  admin handler via releaseReservation; pre-order counts drop automatically.) */
export const deleteTicket = (ticketId: string) => (db: Database): Database => ({
  ...db,
  tickets: db.tickets.filter((t) => t.id !== ticketId),
  remainingPayments: db.remainingPayments.filter((r) => r.ticket_id !== ticketId),
  transfers: db.transfers.filter((tr) => tr.ticket_id !== ticketId),
});

// ── Closing pre-order boards (กระดานปิดพรี) — one board = one maker ──────────
export const createBoard = (makerId: string, title: string) => (db: Database): Database => ({
  ...db,
  boards: [
    { id: id('board'), maker_id: makerId, title, status: 'open', created_at: new Date().toISOString() },
    ...db.boards,
  ],
});

export const updateBoard = (boardId: string, patch: Partial<Database['boards'][number]>) => (db: Database): Database => ({
  ...db,
  boards: db.boards.map((b) => (b.id === boardId ? { ...b, ...patch } : b)),
});

/** Set exactly which products belong to a board: assign board_id to the chosen ones,
 *  and clear it from any product that was in this board but is no longer selected. */
export const setBoardProducts = (boardId: string, productIds: string[]) => (db: Database): Database => {
  const chosen = new Set(productIds);
  return {
    ...db,
    products: db.products.map((p) => {
      if (chosen.has(p.id)) return p.board_id === boardId ? p : { ...p, board_id: boardId };
      if (p.board_id === boardId) return { ...p, board_id: undefined }; // deselected → leave the board
      return p;
    }),
  };
};

/** Delete a board and release its products (does not touch their status/orders). */
export const removeBoard = (boardId: string) => (db: Database): Database => ({
  ...db,
  boards: db.boards.filter((b) => b.id !== boardId),
  products: db.products.map((p) => (p.board_id === boardId ? { ...p, board_id: undefined } : p)),
});

/** Close a board: archive it + send every product in it to production (final qty =
 *  the booked amount), cascading ticket product_status like closeProduction. */
/** Close a board AND finalize its whole production round in one atomic step (admin enters the final
 *  qty per product in the close dialog, then confirms). Nothing happens until confirm, so a dropped
 *  connection or a cancelled dialog leaves the board OPEN — no half-closed / double-counted state.
 *  Writes an immutable BoardCloseLog snapshot (booked vs final per product) for the history. */
export const closeBoardWithProduction = (boardId: string, entries: { productId: string; finalQty: number }[]) => (db: Database): Database => {
  const board = db.boards.find((b) => b.id === boardId);
  if (!board || board.status !== 'open') return db; // only an OPEN board can be closed (no double-close/log)
  const now = new Date().toISOString();
  const orderedOf = (pid: string) => db.tickets.filter((t) => t.product_id === pid).reduce((s, t) => s + t.qty, 0);
  const byId = new Map(entries.map((e) => [e.productId, e.finalQty]));
  const lines = entries.map((e) => {
    const p = db.products.find((pp) => pp.id === e.productId);
    const booked = orderedOf(e.productId);
    const final = Math.max(booked, e.finalQty); // can't order fewer than booked
    return { product_id: e.productId, name: p?.series_name ?? '—', booked, final, surplus: Math.max(0, final - booked) };
  });
  return {
    ...db,
    boards: db.boards.map((b) => (b.id === boardId ? { ...b, status: 'closed', closed_at: now } : b)),
    products: db.products.map((p) => {
      if (!byId.has(p.id)) return p;
      const booked = orderedOf(p.id);
      const final = Math.max(booked, byId.get(p.id)!);
      return { ...p, status: 'production', production_qty: final, surplus_qty: Math.max(0, final - booked) };
    }),
    tickets: db.tickets.map((t) => (byId.has(t.product_id) ? { ...t, product_status: 'production' } : t)),
    boardLogs: [
      { id: id('bl'), board_id: boardId, board_title: board.title, maker_id: board.maker_id, closed_at: now, lines },
      ...db.boardLogs,
    ],
  };
};
