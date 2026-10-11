/**
 * เครื่องจำลองตลาดใบพรี (แท็บ "🎮 ทดลองเล่น" ของแอดมิน · เจ้าของ 2026-09-24)
 *   "จำลองใบพรีตั้งขายในตลาด หลายๆ ค่าย หลายๆ คนขาย" + "มุมผู้ขาย: เลือกใบพรี ตั้งราคา"
 *
 * - โลกจำลอง = สินค้าจริงในร้าน (ชื่อ/รูป/ค่าย/ราคา) + คนขายสมมุติ 8 คน + "คุณ" (ลูกค้าสมมุติ) ที่มีใบพรี 5 ใบ
 * - RPC ตลาดทุกตัววิ่งที่นี่ (lib/marketSandbox) — กติกาเดียวกับ SQL (v71–v83) แบบย่อ ไม่มีอะไรถึงฐานข้อมูลจริง
 * - คู่ค้าเป็นบอท: ลงขาย → มีคนจอง → โอน+แนบสลิป · ซื้อ → คนขายยืนยัน (ตั้งให้ตอบเองได้ หรือกดปุ่มสั่งทีละขั้น)
 * - ฝั่งร้าน (โอนสิทธิ์/ยกเลิก/ตรวจสอบ) ใช้คิวแอดมินตัวจริง (AdminQueue) บนข้อมูลจำลอง
 * ⚠ ตัวเลขเงินคิดด้วยสูตรตัวเดียวกับของจริง (splitShare / depositGap / effectiveStatus) — ต่างกันแค่ที่เก็บข้อมูล
 */
import type { Database, Order, PayoutInfo, PreorderTicket, Product, RankName, TicketTransfer, User } from '@/domain/entities';
import { MARKET, MARKET_PUBLIC_KEY, activeListingOf, depositGap, effectiveStatus, isActiveTransfer, isDirect, nextTransferNo, resellAllowedAt, sellerMask, splitShare } from '@/domain/services/market';
import { productLabel } from '@/domain/services/catalog';
import { approveRemainingPayment } from '@/data/mutations';
import type { Mutation, Store } from '@/data/store';
import type { MarketRow } from '@/lib/market';
import type { MarketSandboxHooks } from '@/lib/marketSandbox';
import { baht } from '@/lib/theme';

export const SB_ME = 'sb-me';
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const SELLABLE = ['production', 'shipping', 'arrived'] as const;
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s?: string | null) => (s ? new Date(s).getTime() : NaN);

export type SbTone = 'me' | 'bot' | 'shop' | 'push' | 'line' | 'time' | 'err';
export interface SbEvent { id: number; at: number; tone: SbTone; text: string }

const BOTS: { id: string; code: string; rank: RankName; sold: number }[] = [
  { id: 'sb-b1', code: 'RYU-0112', rank: 'gold', sold: 7 }, { id: 'sb-b2', code: 'RYU-0127', rank: 'silver', sold: 2 },
  { id: 'sb-b3', code: 'RYU-0134', rank: 'bronze', sold: 0 }, { id: 'sb-b4', code: 'RYU-0148', rank: 'diamond', sold: 12 },
  { id: 'sb-b5', code: 'RYU-0153', rank: 'silver', sold: 4 }, { id: 'sb-b6', code: 'RYU-0166', rank: 'bronze', sold: 1 },
  { id: 'sb-b7', code: 'RYU-0171', rank: 'gold', sold: 3 }, { id: 'sb-b8', code: 'RYU-0189', rank: 'bronze', sold: 0 },
];
const FAKE_PAYOUT = (code: string): PayoutInfo => ({ promptpay: '0000000000', account_name: `ตัวอย่าง R•••${code.slice(-2)} · ห้ามโอนจริง` });

/** สุ่มแบบคงที่ (เปิดใหม่ได้โลกเดิม) */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

/** สลิปตัวอย่าง (SVG ในหน้าเว็บ ไม่ใช่รูปจริง) */
export function sampleSlip(amount: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="#fff"/><rect width="240" height="56" fill="#1e3a8a"/>`
    + `<text x="120" y="35" font-size="18" fill="#fff" text-anchor="middle" font-family="sans-serif">โอนเงินสำเร็จ</text>`
    + `<text x="120" y="150" font-size="34" fill="#111" text-anchor="middle" font-family="monospace">฿${amount.toLocaleString('en-US')}</text>`
    + `<text x="120" y="200" font-size="14" fill="#888" text-anchor="middle" font-family="sans-serif">สลิปตัวอย่าง · โหมดทดลอง</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** สร้างโลกจำลองจากแคตตาล็อกจริง */
function buildWorld(real: Database, now: number) {
  const r = rng(20261011);
  const products = real.products.filter((p) => !p.is_stock && p.price_total > 0 && p.deposit_amount > 0 && p.deposit_amount < p.price_total);
  const byMaker = new Map<string, Product[]>();
  for (const p of products) { const k = p.manufacturer_id || '_'; byMaker.set(k, [...(byMaker.get(k) ?? []), p]); }
  const makers = [...byMaker.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
  // ค่ายละไม่เกิน 4 ตัว (เอาตัวที่มีรูปก่อน) · ของน้อย (โหมด seed) = วนซ้ำให้ได้อย่างน้อย 12 ประกาศ
  let picked = makers.flatMap(([, ps]) => [...ps].sort((a, b) => Number(!a.images?.length) - Number(!b.images?.length)).slice(0, 4));
  if (picked.length === 0) picked = real.products.filter((p) => p.price_total > p.deposit_amount);
  const listingsN = Math.max(12, Math.min(24, picked.length));
  const abbr = (p: Product) => (real.franchises.find((f) => f.id === p.franchise_id)?.abbr || 'RY').toUpperCase();

  const users: User[] = [
    { id: SB_ME, display_name: 'คุณ (ลูกค้าทดลอง)', rank: 'silver', total_spent: 0, member_code: 'RYU-0099', approved: true, shipping_address: 'ที่อยู่ทดลอง กทม. 10110',
      payout_accounts: [{ id: 'pa-sb1', bank: 'promptpay', promptpay: '0812345678', account_name: 'คุณ ทดลอง' }],
      payout_info: { promptpay: '0812345678', account_name: 'คุณ ทดลอง' } } as User,
    ...BOTS.map((b, i) => ({ id: b.id, display_name: `ผู้ขายสมมุติ ${i + 1}`, rank: b.rank, total_spent: 0, member_code: b.code, approved: true, shipping_address: 'ที่อยู่สมมุติ' }) as User),
  ];
  const tickets: PreorderTicket[] = [], orders: Order[] = [], transfers: TicketTransfer[] = [];
  const payouts = new Map<string, PayoutInfo>();
  let seq = 0;
  const mkTicket = (owner: string, p: Product, o: { qty?: number; status: PreorderTicket['product_status']; paidRem?: number; depFactor?: number; when: number }) => {
    seq += 1;
    const qty = o.qty ?? 1, unitDep = p.deposit_amount, dep = Math.round(unitDep * (o.depFactor ?? 1)) * qty, rem = p.price_total * qty - dep;
    const item = `sb${seq}`, oid = `o-sb${seq}`;
    orders.push({ id: oid, user_id: owner, total_deposit: dep, slip_url: '', status: 'approved', created_at: iso(o.when), approved_at: iso(o.when),
      items: [{ id: item, order_id: oid, product_id: p.id, qty, deposit_amount: dep, unit_price: p.price_total, unit_deposit: dep / qty, std_deposit: unitDep }] });
    const t: PreorderTicket = {
      id: `t-${item}`, ticket_no: `${abbr(p)}-2026-${String(1 + (seq % 9)).padStart(2, '0')}-${String(300 + seq).padStart(4, '0')}`,
      product_id: p.id, owner_id: owner, original_buyer_id: owner, qty, deposit_paid: dep, remaining_amount: rem,
      remaining_paid: Math.min(rem, o.paidRem ?? 0), status: (o.paidRem ?? 0) >= rem ? 'paid_full' : 'active', product_status: o.status,
      qr_code_url: '', created_at: iso(o.when), approved_at: iso(o.when), market_rev: 0,
    };
    tickets.push(t);
    return t;
  };

  // ประกาศของคนขายสมมุติ (หลายค่าย หลายคน)
  for (let i = 0; i < listingsN; i++) {
    const p = picked[i % picked.length];
    const bot = BOTS[(i * 3 + Math.floor(r() * 8)) % BOTS.length];
    const status = SELLABLE[i % 3];
    const qty = i % 7 === 3 ? 3 : 1;
    const t = mkTicket(bot.id, p, { qty, status, paidRem: status === 'arrived' && i % 2 ? p.price_total * qty : 0, when: now - (20 + i) * DAY });
    const sellQty = 1;
    const share = sellQty >= t.qty ? t : { ...t, ...splitShare(t, sellQty).child };
    const paid = share.deposit_paid + share.remaining_paid;
    const due = share.remaining_amount - share.remaining_paid;
    const markup = [-200, 0, 150, 300, 450, 600, 900, 1200][Math.floor(r() * 8)];
    const listedAt = now - Math.floor(r() * 3 * DAY) - i * 37 * MIN;
    const reserved = i % 6 === 2;
    const tr: TicketTransfer = {
      id: `tr-sbl${i + 1}`, ticket_id: t.id, from_user_id: bot.id, asking_price: Math.max(0, Math.round((paid + markup) / 10) * 10),
      status: reserved ? 'reserved' : 'listed', listed_at: iso(listedAt), expires_at: iso(listedAt + MARKET.listingDays * DAY), qty: sellQty,
      product_id: t.product_id, kind: 'market', updated_at: iso(listedAt),
      to_user_id: reserved ? BOTS[(i + 1) % BOTS.length].id : undefined, hold_until: reserved ? iso(now + (4 + (i % 9)) * MIN) : undefined,
      snap: { paid, due, total: share.deposit_paid + share.remaining_amount, product_status: status, ticket_hint: `${t.ticket_no.split('-').slice(0, 3).join('-')}-••••` },
    };
    transfers.push(tr);
    payouts.set(tr.id, FAKE_PAYOUT(bot.code));
  }

  // ใบพรีของ "คุณ" — ครบทุกแบบที่ผู้ขายจะเจอ
  const mine = [...picked].reverse();
  const P = (k: number) => mine[k % mine.length];
  mkTicket(SB_ME, P(0), { status: 'production', when: now - 30 * DAY });                                   // ลงขายได้เลย
  mkTicket(SB_ME, P(1), { qty: 3, status: 'shipping', when: now - 40 * DAY });                              // 3 ชิ้น แตกขายได้
  mkTicket(SB_ME, P(2), { status: 'arrived', paidRem: Math.floor((P(2).price_total - P(2).deposit_amount) / 2), when: now - 50 * DAY }); // ถึงไทย จ่ายส่วนต่างไปครึ่งหนึ่ง
  mkTicket(SB_ME, P(3), { status: 'production', depFactor: 0.5, when: now - 25 * DAY });                    // Gold มัดจำครึ่ง → ต้องเติมก่อน
  mkTicket(SB_ME, P(4), { status: 'open', when: now - 2 * DAY });                                           // ยังเปิดจอง → ขายไม่ได้

  const db: Database = {
    ...real,
    users, tickets, orders, transfers,
    remainingPayments: [], pointLedger: [], stockReservations: [], pushSubscriptions: [], activityLogs: [],
    couponGrants: [], campaignAwards: [], missionSubmissions: [], rankRequests: [], sourcingRequests: [], paymentPlans: [],
    auctions: [], auctionBids: [], auctionWatch: [], auctionEntries: [],
    appConfig: [...real.appConfig.filter((c) => c.key !== MARKET_PUBLIC_KEY), { key: MARKET_PUBLIC_KEY, value: { enabled: true } }],
  };
  return { db, payouts };
}

type Res = Record<string, unknown>;

export class MarketSandbox {
  db: Database;
  events: SbEvent[] = [];
  auto = true;
  private payouts = new Map<string, PayoutInfo>();
  private listeners = new Set<() => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private seq = 0;
  private evSeq = 0;
  readonly store: Store;
  readonly hooks: MarketSandboxHooks;

  constructor(private real: Database) {
    const w = buildWorld(real, Date.now());
    this.db = w.db;
    this.payouts = w.payouts;
    this.log('shop', 'เริ่มโหมดทดลอง · กระดานมีประกาศสมมุติจากสินค้าจริงในร้าน · คุณมีใบพรี 5 ใบไว้ลองขาย');
    const self = this;
    this.store = {
      subscribe: (l: () => void) => { self.listeners.add(l); return () => { self.listeners.delete(l); }; },
      getState: () => self.db,
      isReady: () => true,
      init: async () => {},
      update: (m: Mutation) => { const before = self.db; self.db = m(self.db); if (self.db !== before) { self.afterUpdate(before); self.emit(); } return self.db; },
      flush: async () => null,
      reload: async () => true,
      reloadIfIdle: async () => {},
      reloadFailText: () => '',
    } as unknown as Store;
    this.hooks = {
      call: (fn, args) => this.call(fn, args),
      push: (id, kind) => this.pushed(id, kind),
      line: (msg) => this.log('line', `LINE แอดมิน: ${msg}`),
    };
  }

  // ── ระบบภายใน ────────────────────────────────────────────────────────────────
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  private emit() { for (const l of [...this.listeners]) l(); }
  private set(m: (d: Database) => Database) { this.db = m(this.db); this.emit(); }
  private log(tone: SbTone, text: string) { this.events = [{ id: ++this.evSeq, at: Date.now(), tone, text }, ...this.events].slice(0, 80); this.emit(); }
  private later(msDelay: number, fn: () => void) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, msDelay); this.timers.add(t); }
  /** หยุดบอทที่นัดไว้ (ตอนออกจากแท็บ/เริ่มใหม่) — ผู้ติดตาม (React) ถอดตัวเองเอง */
  dispose() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
  reset() { this.dispose(); const w = buildWorld(this.real, Date.now()); this.db = w.db; this.payouts = w.payouts; this.events = []; this.log('shop', 'เริ่มใหม่ · โลกจำลองชุดเดิม'); }
  setAuto(v: boolean) { this.auto = v; this.log('shop', v ? 'คู่ค้าสมมุติตอบเอง: เปิด' : 'คู่ค้าสมมุติตอบเอง: ปิด (กดสั่งทีละขั้นในแผงนี้)'); }

  private tr(id: string) { return this.db.transfers.find((x) => x.id === id); }
  private ticket(id: string) { return this.db.tickets.find((x) => x.id === id); }
  private patch(id: string, p: Partial<TicketTransfer>) {
    this.set((d) => ({ ...d, transfers: d.transfers.map((x) => (x.id === id ? { ...x, ...p, updated_at: new Date().toISOString() } : x)) }));
  }
  private name(tr: TicketTransfer) { return tr.product_id ? productLabel(this.db, tr.product_id, tr.variant_id) : 'ใบพรี'; }
  private who(uid?: string) { if (uid === SB_ME) return 'คุณ'; const u = this.db.users.find((x) => x.id === uid); return u ? `${sellerMask(u)} ` : 'ใครบางคน '; }
  private randomBot(not: (string | undefined)[]) { const pool = BOTS.filter((b) => !not.includes(b.id)); return pool[Math.floor(Math.random() * pool.length)]; }

  /** สลิปเติมมัดจำที่ "คุณ" ส่ง (ผ่าน dispatch ตัวจริง) → ร้านสมมุติอนุมัติให้ใน 3 วินาที */
  private afterUpdate(before: Database) {
    const fresh = this.db.remainingPayments.filter((r) => r.status === 'pending' && !before.remainingPayments.some((b) => b.id === r.id));
    for (const rp of fresh) {
      this.log('me', `คุณส่งสลิป${rp.purpose === 'topup' ? 'เติมมัดจำ' : 'ส่วนต่าง'} ${baht(rp.amount)} → รอร้านตรวจ`);
      this.later(3000, () => {
        this.set((d) => approveRemainingPayment(rp.id)(d));
        this.log('shop', `ร้าน (สมมุติ) อนุมัติสลิป${rp.purpose === 'topup' ? 'เติมมัดจำ — ใบนี้ลงขายได้แล้ว' : 'ส่วนต่าง'}`);
      });
    }
  }

  // ── กระดาน (ryuma_market_feed) ─────────────────────────────────────────────────
  feedRows(now = new Date()): MarketRow[] {
    const rows: MarketRow[] = [];
    for (const tr of this.db.transfers) {
      if (isDirect(tr)) continue;
      const st = effectiveStatus(tr, now);
      if (st !== 'listed' && st !== 'reserved') continue;
      const t = this.ticket(tr.ticket_id);
      if (!t) continue;
      const qty = tr.qty ?? t.qty;
      const s = qty >= t.qty ? t : { ...t, ...splitShare(t, qty).child };
      const u = this.db.users.find((x) => x.id === tr.from_user_id);
      const bot = BOTS.find((b) => b.id === tr.from_user_id);
      const soldHere = this.db.transfers.filter((x) => x.from_user_id === tr.from_user_id && x.status === 'done' && !isDirect(x)).length;
      rows.push({
        id: tr.id, product_id: tr.product_id ?? t.product_id, variant_id: t.variant_id ?? null, batch_id: t.batch_id ?? null,
        product_status: t.product_status, warehouse_at: t.warehouse_at ?? null, qty, ticket_qty: t.qty, asking_price: tr.asking_price,
        paid: s.deposit_paid + s.remaining_paid, due: s.remaining_amount - s.remaining_paid, total: s.deposit_paid + s.remaining_amount,
        listed_at: tr.listed_at, expires_at: tr.expires_at ?? null, status: st, hold_until: st === 'reserved' ? tr.hold_until ?? null : null,
        reserved_by_me: st === 'reserved' && tr.to_user_id === SB_ME, mine: tr.from_user_id === SB_ME,
        seller: sellerMask(u), seller_rank: u?.rank ?? 'bronze', seller_sold: (bot?.sold ?? 0) + soldHere,
        ticket_hint: `${t.ticket_no.split('-').slice(0, 3).join('-')}-••••`,
      });
    }
    return rows.sort((a, b) => (a.listed_at < b.listed_at ? 1 : -1));
  }

  // ── RPC ───────────────────────────────────────────────────────────────────────
  async call(fn: string, a: Record<string, unknown>): Promise<Res> {
    await new Promise((r) => setTimeout(r, 220)); // ให้รู้สึกเหมือนเน็ต (ปุ่ม busy โชว์ได้)
    const id = String(a.p_id ?? '');
    switch (fn) {
      case 'ryuma_market_feed': return { ok: true, closed: false, server_now: new Date().toISOString(), rows: this.feedRows() };
      case 'ryuma_market_list': return this.list(String(a.p_ticket_id), Number(a.p_qty), Number(a.p_price), (a.p_payout ?? null) as PayoutInfo | null);
      case 'ryuma_market_cancel': return this.cancel(id);
      case 'ryuma_market_reserve': return this.reserve(SB_ME, id);
      case 'ryuma_market_release': return this.release(SB_ME, id);
      case 'ryuma_market_payout': return this.payout(id);
      case 'ryuma_market_pay': return this.pay(SB_ME, id, String(a.p_slip ?? ''));
      case 'ryuma_market_seller_confirm': return this.sellerConfirm(SB_ME, id);
      case 'ryuma_market_seller_reject': return this.sellerReject(SB_ME, id, String(a.p_note ?? ''), (a.p_evidence ?? []) as string[]);
      case 'ryuma_market_escalate': return this.escalate(a.p_note === 'แอดมินส่งเข้าตรวจ', id, String(a.p_note ?? ''));
      case 'ryuma_market_finalize': return this.finalize(id);
      case 'ryuma_market_admin_cancel': return this.adminCancel(id, String(a.p_reason ?? ''));
      case 'ryuma_market_late_slip_resolve': return this.lateResolve(id, String(a.p_note ?? ''));
      default: return { error: 'sandbox_na' };
    }
  }

  /** ด่านลงขาย — ลำดับเดียวกับ ryuma_market_block_reason (v83) */
  private blockReason(t: PreorderTicket | undefined, uid: string, qty: number): string | null {
    if (!t) return 'not_found';
    if (t.owner_id !== uid) return 'not_owner';
    if (['shipped', 'pending_approval', 'transferred'].includes(t.status)) return 'bad_status';
    if (t.delivery) return 'delivery_chosen';
    if (t.product_status === 'open') return 'still_open';
    const b = t.batch_id ? this.db.batches.find((x) => x.id === t.batch_id) : undefined;
    if (b && b.status === 'open' && b.published !== false && (b.stock_qty ?? 0) > 0) return 'still_open';
    if (!(SELLABLE as readonly string[]).includes(t.product_status)) return 'bad_product_status';
    if (!(t.qty >= 1) || !(qty >= 1 && qty <= t.qty && Number.isInteger(qty))) return 'bad_qty';
    if (this.db.remainingPayments.some((r) => r.ticket_id === t.id && r.status === 'pending')) return 'pending_slip';
    if (activeListingOf(this.db, t.id)) return 'already_listed';
    if (this.db.transfers.filter((x) => x.from_user_id === uid && x.ticket_id !== t.id && isActiveTransfer(x)).length >= MARKET.maxActive) return 'max_active';
    const resell = resellAllowedAt(this.db, t, uid);
    if (resell && resell.getTime() > Date.now()) return 'resell_hold';
    if (depositGap(this.db, t) > 0) return 'topup_needed';
    return null;
  }

  private list(ticketId: string, qty: number, price: number, payout: PayoutInfo | null): Res {
    if (!Number.isFinite(price) || price < 0 || price > 1_000_000 || price !== Math.round(price)) return { error: 'bad_price' };
    if (!payout?.account_name || (!payout.promptpay && !payout.account_no)) return { error: 'no_payout' };
    const t = this.ticket(ticketId);
    const why = this.blockReason(t, SB_ME, qty);
    if (why || !t) return { error: why ?? 'not_found' };
    const s = qty >= t.qty ? t : { ...t, ...splitShare(t, qty).child };
    const now = Date.now();
    const id = `tr-sbm${++this.seq}`;
    const tr: TicketTransfer = {
      id, ticket_id: t.id, from_user_id: SB_ME, asking_price: price, status: 'listed', listed_at: iso(now), expires_at: iso(now + MARKET.listingDays * DAY),
      qty, product_id: t.product_id, variant_id: t.variant_id, batch_id: t.batch_id, kind: 'market', updated_at: iso(now), order_item_id: t.id.slice(2),
      snap: { paid: s.deposit_paid + s.remaining_paid, due: s.remaining_amount - s.remaining_paid, total: s.deposit_paid + s.remaining_amount, product_status: t.product_status, ticket_hint: `${t.ticket_no.split('-').slice(0, 3).join('-')}-••••` },
    };
    this.payouts.set(id, payout);
    this.set((d) => ({ ...d, transfers: [tr, ...d.transfers] }));
    this.log('me', `คุณลงขาย ${this.name(tr)}${qty < t.qty ? ` (${qty}/${t.qty} ชิ้น)` : ''} · ${baht(price)}`);
    if (this.auto) this.later(6000, () => this.botReserve(id, true));
    return { ok: true, id, expires_at: tr.expires_at };
  }

  private cancel(id: string): Res {
    const tr = this.tr(id);
    if (!tr || tr.from_user_id !== SB_ME) return { error: 'not_found' };
    const st = effectiveStatus(tr);
    if (st === 'reserved') return { error: 'reserved', hold_until: tr.hold_until };
    if (st !== 'listed') return { error: 'bad_status', status: st };
    this.patch(id, { status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: 'seller', to_user_id: undefined, hold_until: undefined });
    this.log('me', `คุณถอนประกาศ ${this.name(tr)} · ใบพรีปลดล็อกแล้ว`);
    return { ok: true };
  }

  private reserve(uid: string, id: string): Res {
    const tr = this.tr(id);
    if (!tr || isDirect(tr)) return { error: 'not_found' };
    if (tr.from_user_id === uid) return { error: 'own_listing' };
    const st = effectiveStatus(tr);
    if (st === 'reserved') return tr.to_user_id === uid ? { ok: true, again: true, hold_until: tr.hold_until, server_now: new Date().toISOString() } : { error: 'reserved', hold_until: tr.hold_until };
    if (st !== 'listed') return { error: 'gone', status: st };
    if (this.db.transfers.some((x) => x.id !== id && x.to_user_id === uid && !isDirect(x) && effectiveStatus(x) === 'reserved')) return { error: 'one_at_a_time' };
    const hold = iso(Date.now() + MARKET.holdMin * MIN);
    this.patch(id, { status: 'reserved', to_user_id: uid, hold_until: hold });
    this.log(uid === SB_ME ? 'me' : 'bot', `${this.who(uid)}จอง ${this.name(tr)} · ต้องโอน+แนบสลิปภายใน ${MARKET.holdMin} นาที`);
    return { ok: true, hold_until: hold, server_now: new Date().toISOString() };
  }

  private release(uid: string, id: string): Res {
    const tr = this.tr(id);
    if (!tr || tr.to_user_id !== uid || tr.status !== 'reserved') return { error: 'not_found' };
    this.patch(id, { status: 'listed', to_user_id: undefined, hold_until: undefined });
    this.log(uid === SB_ME ? 'me' : 'bot', `${this.who(uid)}ปล่อยการจอง ${this.name(tr)} · กลับขึ้นกระดาน`);
    return { ok: true };
  }

  private payout(id: string): Res {
    const tr = this.tr(id);
    if (!tr) return { error: 'not_found' };
    const pay = tr.from_user_id === SB_ME ? (this.payouts.get(id) ?? this.db.users.find((u) => u.id === SB_ME)?.payout_info) : this.payouts.get(id);
    if (!pay) return { ok: true, amount: tr.asking_price, none: true };
    return { ok: true, amount: tr.asking_price, promptpay: pay.promptpay ?? null, bank: pay.bank ?? null, account_no: pay.account_no ?? null, account_name: pay.account_name };
  }

  private pay(uid: string, id: string, slip: string): Res {
    const tr = this.tr(id);
    if (!tr || tr.to_user_id !== uid) return { error: 'not_found' };
    if (!slip) return { error: 'bad_slip' };
    if (tr.status === 'paid') return { ok: true, again: true };
    if (tr.status !== 'reserved' || ms(tr.hold_until) + MARKET.holdGraceMin * MIN <= Date.now()) return { error: 'hold_expired' };
    this.patch(id, { status: 'paid', slip_url: slip, paid_at: new Date().toISOString() });
    this.log(uid === SB_ME ? 'me' : 'bot', `${this.who(uid)}โอน ${baht(tr.asking_price)} + แนบสลิป → รอ${tr.from_user_id === SB_ME ? 'คุณ' : 'คนขาย'}เช็คเงินเข้า`);
    if (uid === SB_ME && this.auto && tr.from_user_id !== SB_ME) this.later(4500, () => this.botConfirm(id, true));
    return { ok: true, paid_at: new Date().toISOString() };
  }

  private sellerConfirm(uid: string, id: string): Res {
    const tr = this.tr(id);
    if (!tr || tr.from_user_id !== uid) return { error: 'not_found' };
    if (tr.status === 'seller_ok') return { ok: true, again: true };
    if (tr.status !== 'paid' && tr.status !== 'reviewing') return { error: 'bad_status', status: tr.status };
    this.patch(id, { status: 'seller_ok', seller_confirmed_at: new Date().toISOString() });
    this.log(uid === SB_ME ? 'me' : 'bot', `${uid === SB_ME ? 'คุณ' : this.who(uid)}ยืนยัน "ได้รับเงินแล้ว" → รอร้านโอนสิทธิ์ (ฝั่งร้านด้านขวา)`);
    return { ok: true };
  }

  private sellerReject(uid: string, id: string, note: string, evidence: string[]): Res {
    const tr = this.tr(id);
    if (!tr || tr.from_user_id !== uid) return { error: 'not_found' };
    if (tr.status !== 'paid') return { error: 'bad_status', status: tr.status };
    this.patch(id, { status: 'reviewing', review_reason: 'not_received', review_note: note.slice(0, 500), review_evidence: evidence, reviewing_at: new Date().toISOString() });
    this.log(uid === SB_ME ? 'me' : 'bot', `${uid === SB_ME ? 'คุณ' : this.who(uid)}แจ้ง "ยังไม่ได้รับเงิน" → ร้านตรวจสอบ`);
    return { ok: true };
  }

  private escalate(admin: boolean, id: string, note: string): Res {
    const tr = this.tr(id);
    if (!tr) return { error: 'not_found' };
    if (tr.status === 'reviewing') return { ok: true, again: true };
    if (admin) {
      if (!['paid', 'seller_ok', 'pending_admin'].includes(tr.status)) return { error: 'bad_status', status: tr.status };
    } else {
      if (tr.to_user_id !== SB_ME) return { error: 'not_found' };
      if (tr.status !== 'paid') return { error: 'bad_status', status: tr.status };
      if (ms(tr.paid_at) + MARKET.sellerSlaH * HOUR > Date.now()) return { error: 'too_early' };
    }
    this.patch(id, { status: 'reviewing', review_reason: admin ? 'admin' : 'seller_silent', review_note: note || tr.review_note, reviewing_at: new Date().toISOString() });
    this.log(admin ? 'shop' : 'me', admin ? 'ร้านส่งดีลเข้าตรวจสอบ' : 'คุณขอให้ร้านตรวจสอบ (คนขายเงียบเกิน 12 ชม.)');
    return { ok: true };
  }

  /** โอนสิทธิ์ — สูตรเดียวกับ ryuma_market_finalize: ยกใบ = ย้ายเจ้าของ+เลข -T<n> · แตกขาย = ตั๋วลูกแบ่งเงินตามสัดส่วน */
  private finalize(id: string): Res {
    const tr = this.tr(id);
    if (!tr) return { error: 'not_found' };
    if (tr.status === 'done' || tr.status === 'approved') return { ok: true, again: true, new_ticket_no: tr.new_ticket_no, child_ticket_id: tr.child_ticket_id };
    if (!['paid', 'reviewing', 'seller_ok', 'pending_admin'].includes(tr.status) || !tr.to_user_id) return { error: 'bad_status', status: tr.status };
    const t = this.ticket(tr.ticket_id);
    if (!t) return { error: 'ticket_missing' };
    if (t.owner_id !== tr.from_user_id) return { error: 'owner_changed' };
    const qty = tr.qty ?? t.qty;
    if (!(qty >= 1 && qty <= t.qty)) return { error: 'bad_qty' };
    const no = nextTransferNo(this.db.tickets.map((x) => x.ticket_no), t.ticket_no);
    const payer = t.original_buyer_id || t.owner_id;
    const now = new Date().toISOString();
    let child: string | undefined;
    this.set((d) => {
      let tickets = d.tickets;
      if (qty === t.qty) {
        tickets = tickets.map((x) => (x.id === t.id ? { ...x, owner_id: tr.to_user_id!, original_buyer_id: payer, ticket_no: no, market_rev: (x.market_rev ?? 0) + 1 } : x));
      } else {
        const s = splitShare(t, qty);
        child = `tc-sb${++this.seq}`;
        const c: PreorderTicket = { ...t, id: child, ticket_no: no, owner_id: tr.to_user_id!, original_buyer_id: payer, split_from: t.id, created_at: now,
          qty, deposit_paid: s.child.deposit_paid, remaining_amount: s.child.remaining_amount, remaining_paid: s.child.remaining_paid,
          status: s.child.remaining_paid >= s.child.remaining_amount ? 'paid_full' : 'active', market_rev: (t.market_rev ?? 0) + 1, delivery: undefined };
        tickets = [...tickets.map((x) => (x.id === t.id ? { ...x, original_buyer_id: payer, ...s.parent,
          status: (s.parent.remaining_paid >= s.parent.remaining_amount ? 'paid_full' : 'active') as PreorderTicket['status'], market_rev: (x.market_rev ?? 0) + 1 } : x)), c];
      }
      return { ...d, tickets, transfers: d.transfers.map((x) => (x.id === id ? { ...x, status: 'done' as const, approved_at: now, finalized_by: 'sb-admin', prev_ticket_no: t.ticket_no, new_ticket_no: no, child_ticket_id: child, updated_at: now } : x)) };
    });
    this.log('shop', `ร้านโอนสิทธิ์ ${t.ticket_no} → ${no}${child ? ` (แตกขาย ${qty} ชิ้น · ตั๋วลูกแบ่งเงินตามสัดส่วน)` : ''} · ใบเข้ากระเป๋า${this.who(tr.to_user_id)}`);
    return { ok: true, new_ticket_no: no, child_ticket_id: child ?? null };
  }

  private adminCancel(id: string, reason: string): Res {
    const tr = this.tr(id);
    if (!tr) return { error: 'not_found' };
    if (['done', 'approved', 'cancelled', 'expired'].includes(tr.status)) return { error: 'bad_status', status: tr.status };
    const money = !!tr.paid_at && tr.asking_price > 0;
    this.patch(id, { status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: `admin: ${reason.slice(0, 300)}`, hold_until: undefined,
      ...(money ? { review_reason: 'late_slip' as const, reviewing_at: new Date().toISOString() } : {}) });
    this.log('shop', `ร้านยกเลิกดีล ${this.name(tr)}${money ? ' · ผู้ซื้อโอนแล้ว → เข้าคิว "เคลียร์คืนเงิน"' : ''}`);
    return { ok: true, refund: money };
  }

  private lateResolve(id: string, note: string): Res {
    const tr = this.tr(id);
    if (!tr || tr.review_reason !== 'late_slip') return { error: 'bad_status' };
    this.patch(id, { review_reason: 'late_slip_done', review_note: note.slice(0, 500) });
    this.log('shop', `ร้านปิดเรื่องคืนเงิน: ${note}`);
    return { ok: true };
  }

  // ── push (จดว่าใครจะได้แจ้งเตือนอะไร — ข้อความเดียวกับ ryuma_market_push_targets) ──────────────
  private pushed(id: string, kind: string) {
    const tr = this.tr(id);
    if (!tr) return;
    const n = this.name(tr), price = baht(tr.asking_price);
    const to = (uid?: string) => (uid === SB_ME ? 'คุณ' : this.who(uid));
    const M: Record<string, [string, string]> = {
      listed: ['ทุกคน (ยกเว้นคนที่ปิดค่าย/เรื่องนี้)', `🆕 ตลาดใบพรี · ลงขายใหม่ — ${n} · ${price}`],
      reserved: [to(tr.from_user_id), `🛒 มีคนกำลังซื้อใบของคุณ — ${n}`],
      paid: [`${to(tr.from_user_id)} + แอดมิน`, `💸 มีคนโอนเงินให้คุณแล้ว — ${n} · ${price}`],
      seller_ok: [`${to(tr.to_user_id)} + แอดมิน`, `✅ คนขายยืนยันรับเงินแล้ว — รอร้านโอนสิทธิ์`],
      reviewing: ['ทั้งสองฝั่ง + แอดมิน', `🔎 ร้านกำลังตรวจสอบดีล — ${n}`],
      remind: [to(tr.from_user_id), `⏰ มีเงินรอคุณยืนยัน — ${n} · ${price}`],
      done: [to(tr.to_user_id), `🎉 ใบพรีเข้ากระเป๋าแล้ว! — ${n} · ${tr.new_ticket_no ?? ''}`],
      sold: [to(tr.from_user_id), `🤝 ขายสำเร็จแล้ว — ${n}`],
      cancelled: ['ทั้งสองฝั่ง', `❌ ดีลถูกยกเลิก — ${n}`],
    };
    const m = M[kind];
    if (m) this.log('push', `แจ้งเตือนถึง ${m[0]}: ${m[1]}`);
  }

  // ── คู่ค้าสมมุติ (ปุ่มในแผง + โหมดตอบเอง) ───────────────────────────────────────────
  botReserve(id: string, chain = false) {
    const tr = this.tr(id);
    if (!tr || effectiveStatus(tr) !== 'listed') return;
    // บอทที่ยังไม่ได้จองใบอื่นค้างอยู่ (จองได้ทีละใบ — กติกาเดียวกับลูกค้าจริง)
    const busy = this.db.transfers.filter((x) => !isDirect(x) && effectiveStatus(x) === 'reserved').map((x) => x.to_user_id);
    const bot = this.randomBot([tr.from_user_id, ...busy]);
    if (!bot) { this.log('err', 'ไม่มีผู้ซื้อสมมุติว่าง (ทุกคนจองใบอื่นอยู่) — ลองข้ามเวลา +15 นาที'); return; }
    const r = this.reserve(bot.id, id);
    if (!r.ok) { this.log('err', `ผู้ซื้อสมมุติจองไม่สำเร็จ (${String(r.error)})`); return; }
    this.pushed(id, 'reserved');
    if (chain && this.auto) this.later(7000, () => this.botPay(id));
  }
  botPay(id: string) {
    const tr = this.tr(id);
    if (!tr || tr.status !== 'reserved' || !tr.to_user_id || tr.to_user_id === SB_ME) return;
    const r = this.pay(tr.to_user_id, id, sampleSlip(tr.asking_price));
    if (!r.ok) { this.log('err', 'ผู้ซื้อสมมุติแนบสลิปไม่ทัน (หมดเวลาจอง)'); return; }
    this.pushed(id, 'paid');
    this.log('line', `LINE แอดมิน: 🎟️ ตลาดใบพรี: ผู้ซื้อโอน ${baht(tr.asking_price)} ให้คนขายแล้ว (รอคนขายยืนยัน)`);
  }
  botRelease(id: string) {
    const tr = this.tr(id);
    if (!tr || tr.status !== 'reserved' || !tr.to_user_id || tr.to_user_id === SB_ME) return;
    this.release(tr.to_user_id, id);
  }
  botConfirm(id: string, fromAuto = false) {
    const tr = this.tr(id);
    if (!tr || tr.from_user_id === SB_ME || !['paid', 'reviewing'].includes(tr.status)) return;
    if (fromAuto && !this.auto) return;
    this.sellerConfirm(tr.from_user_id, id);
    this.pushed(id, 'seller_ok');
  }
  botReject(id: string) {
    const tr = this.tr(id);
    if (!tr || tr.from_user_id === SB_ME || tr.status !== 'paid') return;
    this.sellerReject(tr.from_user_id, id, 'เช็คแล้วยังไม่มีเงินเข้า', []);
    this.pushed(id, 'reviewing');
  }

  /** ข้ามเวลา: ถอยเวลาทุกช่องของดีลกลับไป = เหมือนเวลาผ่านไปจริง (หมดเวลาจอง/เลย 12 ชม./ครบ 14 วัน/พ้นถือ 2 วัน) */
  fastForward(deltaMs: number, label: string) {
    const back = (s?: string | null) => (s ? iso(ms(s) - deltaMs) : (s ?? undefined));
    this.set((d) => ({
      ...d,
      transfers: d.transfers.map((x) => ({ ...x, listed_at: back(x.listed_at)!, hold_until: back(x.hold_until), expires_at: back(x.expires_at), paid_at: back(x.paid_at),
        approved_at: back(x.approved_at), seller_confirmed_at: back(x.seller_confirmed_at), reviewing_at: back(x.reviewing_at), cancelled_at: back(x.cancelled_at), updated_at: back(x.updated_at) })),
    }));
    this.log('time', `ข้ามเวลา ${label}`);
  }
}
