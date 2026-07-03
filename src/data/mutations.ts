import type { Database, Order, OrderItem, Category, Manufacturer, Franchise, Series, Product, PaymentAccount, ProductStatus, Carrier, RankName } from '../domain/entities';
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
export function submitOrder(userId: string, lines: CartLine[], slipUrl: string, reservationIds?: string[]) {
  return (db: Database): Database => {
    const orderId = id('o');
    const rank = db.users.find((u) => u.id === userId)?.rank ?? 'bronze';
    const items: OrderItem[] = lines.map((l) => {
      const isStock = db.products.find((p) => p.id === l.productId)?.is_stock ?? false;
      // rank perk: pre-order deposit reduced by rank (snapshot); total unchanged (remaining grows).
      // full-pay lines (in-stock, or a pay-in-full "พร้อมส่ง" batch) collect in full — no perk. (DNA)
      const unitDeposit = lineDepositForRank(db.settings, { deposit: l.depositEach, price: l.priceEach, isStock }, rank);
      return {
        id: id('oi'),
        order_id: orderId,
        product_id: l.productId,
        variant_id: l.variantId,
        qty: l.qty,
        deposit_amount: unitDeposit * l.qty,
        // snapshot the price/deposit at order time — never re-read the product later
        unit_price: l.priceEach,
        unit_deposit: unitDeposit,
        batch_id: l.batchId,
      };
    });
    const order: Order = {
      id: orderId,
      user_id: userId,
      total_deposit: items.reduce((s, i) => s + i.deposit_amount, 0),
      slip_url: slipUrl,
      status: 'pending_approval',
      created_at: new Date().toISOString(),
      reservation_ids: reservationIds && reservationIds.length ? reservationIds : undefined,
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

    const updated: Database = {
      ...db,
      orders: db.orders.map((o) =>
        o.id === orderId ? { ...o, status: 'approved', approved_at: new Date().toISOString() } : o,
      ),
      tickets: [...newTickets, ...db.tickets],
    };

    // rank progress counts APPROVED pieces → auto-raise a request when a threshold is crossed
    const user = db.users.find((u) => u.id === order.user_id);
    const pieces = rankPiecesOf(updated, order.user_id);
    const elig = eligibleRank(db.settings, pieces);
    if (user && rankIndex(elig) > rankIndex(user.rank)) return requestRank(order.user_id, elig, pieces)(updated);
    return updated;
  };
}

/** Reject a pending order (slip not valid). Stock holds are released separately via RPC. */
export const rejectOrder = (orderId: string) => (db: Database): Database => ({
  ...db,
  orders: db.orders.map((o) => (o.id === orderId ? { ...o, status: 'rejected' as const } : o)),
});

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
  return {
    ...db,
    products: db.products.map((p) => {
      const e = entries.find((x) => x.productId === p.id);
      if (!e) return p;
      const ordered = db.tickets.filter((t) => t.product_id === p.id).reduce((s, t) => s + t.qty, 0);
      return { ...p, status: 'production', production_qty: e.finalQty, surplus_qty: Math.max(0, e.finalQty - ordered) };
    }),
    // ปิดใบพรี = เปิดจอง → ผลิต : ต้อง cascade สถานะลงทุกตั๋วเหมือน setProductStatus (ให้ 2 ฟีเจอร์ตรงกัน)
    tickets: db.tickets.map((t) => (ids.has(t.product_id) ? { ...t, product_status: 'production' } : t)),
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
/** Close a board = end its pre-order round. Products stay `status:'open'` but, because the board
 *  is now closed, they leave the shop (inClosedBoard) and become eligible for ปิดรอบสั่งผลิต
 *  (production) where the admin enters the final production qty. No product is finalized here —
 *  that keeps the flow single-track: an OPEN-board product never appears in the production queue,
 *  and a CLOSED-board product appears there exactly once until closeProduction sends it to 'production'. */
export const closeBoard = (boardId: string) => (db: Database): Database => ({
  ...db,
  boards: db.boards.map((b) => (b.id === boardId ? { ...b, status: 'closed', closed_at: new Date().toISOString() } : b)),
});
