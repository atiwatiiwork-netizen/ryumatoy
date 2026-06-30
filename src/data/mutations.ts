import type { Database, Order, OrderItem } from '../domain/entities';
import type { CartLine } from '../state/CartProvider';
import { nextTicketNo } from '../domain/services/tickets';
import { franchiseOf, remaining } from '../domain/services/catalog';

/**
 * Pure mutations — `(db) => db`. Each returns a new Database; the store applies
 * them optimistically and persists. These cover the core booking flow.
 */

let counter = 0;
const id = (p: string) => `${p}-${Date.now()}-${counter++}`;

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
      const price = variant?.price_total ?? product.price_total;
      const deposit = item.deposit_amount;
      return {
        id: id('t'),
        ticket_no: nextTicketNo(db, abbr),
        product_id: product.id,
        variant_id: item.variant_id,
        owner_id: order.user_id,
        original_buyer_id: order.user_id,
        qty: item.qty,
        deposit_paid: deposit,
        remaining_amount: remaining(price, variant?.deposit_amount ?? product.deposit_amount) * item.qty,
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
