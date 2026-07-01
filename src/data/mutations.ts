import type { Database, Order, OrderItem, Category, Manufacturer, Franchise, Series, Product, PaymentAccount, ProductStatus } from '../domain/entities';
import type { CartLine } from '../state/CartProvider';
import { nextTicketNo } from '../domain/services/tickets';
import { franchiseOf } from '../domain/services/catalog';

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

/** Submit a cart as an order awaiting admin approval (PRD §9 step 5). */
export function submitOrder(userId: string, lines: CartLine[], slipUrl: string) {
  return (db: Database): Database => {
    const orderId = id('o');
    const items: OrderItem[] = lines.map((l) => ({
      id: id('oi'),
      order_id: orderId,
      product_id: l.productId,
      variant_id: l.variantId,
      qty: l.qty,
      deposit_amount: l.depositEach * l.qty,
      // snapshot the price/deposit at order time — never re-read the product later
      unit_price: l.priceEach,
      unit_deposit: l.depositEach,
      batch_id: l.batchId,
    }));
    const order: Order = {
      id: orderId,
      user_id: userId,
      total_deposit: items.reduce((s, i) => s + i.deposit_amount, 0),
      slip_url: slipUrl,
      status: 'pending_approval',
      created_at: new Date().toISOString(),
      items,
    };
    return { ...db, orders: [order, ...db.orders] };
  };
}

/** Admin approves a slip: mark order approved + auto-issue one ticket per item (PRD §9 step 6). */
export function approveOrder(orderId: string) {
  return (db: Database): Database => {
    const order = db.orders.find((o) => o.id === orderId);
    if (!order || order.status !== 'pending_approval') return db;

    const newTickets = order.items.map((item) => {
      const product = db.products.find((p) => p.id === item.product_id)!;
      const variant = db.variants.find((v) => v.id === item.variant_id);
      const abbr = franchiseOf(db, product)?.abbr ?? 'xx';
      // derive from the ORDER-TIME snapshot; fall back to current product for old rows
      const unitPrice = item.unit_price ?? variant?.price_total ?? product.price_total;
      const unitDeposit = item.unit_deposit ?? variant?.deposit_amount ?? product.deposit_amount;
      return {
        id: id('t'),
        ticket_no: nextTicketNo(db, abbr),
        product_id: product.id,
        variant_id: item.variant_id,
        batch_id: item.batch_id,
        owner_id: order.user_id,
        original_buyer_id: order.user_id,
        qty: item.qty,
        deposit_paid: unitDeposit * item.qty,
        remaining_amount: Math.max(0, unitPrice - unitDeposit) * item.qty,
        remaining_paid: 0,
        status: 'active' as const,
        product_status: product.status,
        qr_code_url: '',
        created_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
      };
    });

    return {
      ...db,
      orders: db.orders.map((o) =>
        o.id === orderId ? { ...o, status: 'approved', approved_at: new Date().toISOString() } : o,
      ),
      tickets: [...newTickets, ...db.tickets],
    };
  };
}

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
  batches: db.batches.filter((b) => b.id !== batchId),
});

/** Customer submits a remaining-balance payment (slip) awaiting admin approval. */
export const submitRemainingPayment = (ticketId: string, userId: string, amount: number, slipUrl: string) => (db: Database): Database => ({
  ...db,
  remainingPayments: [
    { id: id('rp'), ticket_id: ticketId, user_id: userId, amount, slip_url: slipUrl, status: 'pending', created_at: new Date().toISOString() },
    ...db.remainingPayments,
  ],
});

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

export const updateSettings = (patch: Partial<Database['settings']>) => (db: Database): Database => ({ ...db, settings: { ...db.settings, ...patch } });

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
export const setProductStatus = (productId: string, status: ProductStatus, extra?: { tracking_no?: string; shipped_at?: string }) => (db: Database): Database => ({
  ...db,
  products: db.products.map((p) => (p.id === productId ? { ...p, status, ...(extra ?? {}) } : p)),
  tickets: db.tickets.map((t) => (t.product_id === productId ? { ...t, product_status: status } : t)),
});

/**
 * Close the pre-order round for the given products → status 'production'.
 * Records the final production qty and the surplus (final − ordered) that becomes
 * shop stock. Ordered qty is the sum of ticket qty for the product.
 */
export const closeProduction = (entries: { productId: string; finalQty: number }[]) => (db: Database): Database => ({
  ...db,
  products: db.products.map((p) => {
    const e = entries.find((x) => x.productId === p.id);
    if (!e) return p;
    const ordered = db.tickets.filter((t) => t.product_id === p.id).reduce((s, t) => s + t.qty, 0);
    return { ...p, status: 'production', production_qty: e.finalQty, surplus_qty: Math.max(0, e.finalQty - ordered) };
  }),
});
export const removeProduct = (pid: string) => (db: Database): Database => ({
  ...db,
  products: db.products.filter((p) => p.id !== pid),
  variants: db.variants.filter((v) => v.product_id !== pid),
});
