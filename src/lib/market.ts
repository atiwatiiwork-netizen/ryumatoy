import { supabase } from '@/data/supabaseClient';
import { simActive, SIM_BLOCKED } from '@/lib/sim';

/**
 * สะพานไปหา RPC ตลาดใบพรี (migration v71 · ryuma-p2p-spec).
 *
 * ทำไมทุกอย่างต้องผ่าน server: "ใครจองได้ก่อน" และ "ตั๋วย้ายไปอยู่กับใคร" optimistic store ฝั่ง client
 * ตัดสินไม่ได้ — สองคนกดวินาทีเดียวกันจะเขียนทับกันเงียบๆ และ RLS ไม่ให้ลูกค้าแตะตั๋วคนอื่นอยู่แล้ว.
 * adapter จึงไม่ sync ตาราง ticket_transfers เลย: หลัง RPC สำเร็จให้เรียก store.reload() ดึงของจริง.
 * ทุก await มีเพดานเวลา (DNA: reserve.ts / auction.ts) — resume บน socket ที่ตายแล้วจะไม่ค้างปุ่ม busy.
 */
const RPC_TIMEOUT = 10_000;

export type MarketErr =
  | 'no_server' | 'no_rpc' | 'no_session' | 'not_found' | 'admin_only' | 'bad_status' | 'bad_price' | 'bad_qty' | 'bad_slip'
  | 'no_payout' | 'no_address' | 'own_listing' | 'reserved' | 'gone' | 'one_at_a_time' | 'hold_expired' | 'too_early'
  | 'not_owner' | 'delivery_chosen' | 'still_open' | 'bad_product_status' | 'instock' | 'sourcing' | 'pending_slip'
  | 'already_listed' | 'max_active' | 'resell_hold' | 'topup_needed' | 'owner_changed' | 'ticket_moving' | 'ticket_missing'
  | (string & {});

export type MarketRes = {
  ok?: boolean;
  error?: MarketErr;
  again?: boolean;
  id?: string;
  status?: string;
  hold_until?: string;
  expires_at?: string;
  server_now?: string;
  paid_at?: string;
  at?: string;
  amount?: number;
  promptpay?: string | null;
  bank?: string | null;
  account_no?: string | null;
  account_name?: string | null;
  /** v76: ดีลนี้ไม่มีบัญชีรับเงิน (ยกให้ฟรี) */
  none?: boolean;
  new_ticket_no?: string;
  child_ticket_id?: string | null;
  /** v75: สลิปที่แนบหลังดีลปิด/หมดเวลา ถูกเก็บเป็นหลักฐานให้ร้านแล้ว (ไม่ย้ายตั๋ว) */
  recorded?: boolean;
};

/** หนึ่งแถวบนกระดาน (ryuma_market_feed) — ปิดชื่อคนขายแล้ว ยอดเงินเป็นของ "ชิ้นที่ขาย" (แตกขายได้) */
export interface MarketRow {
  id: string;
  product_id: string;
  variant_id?: string | null;
  batch_id?: string | null;
  product_status: string;
  warehouse_at?: string | null;
  qty: number;
  ticket_qty: number;
  asking_price: number;   // จ่ายคนขายตอนนี้
  paid: number;           // คนขายจ่ายร้านไปแล้ว (มัดจำ + ส่วนต่างที่จ่ายแล้ว)
  due: number;            // ค้างร้าน → ผู้ซื้อรับภาระต่อ
  total: number;          // ราคาเต็มของชิ้นที่ขาย
  listed_at: string;
  expires_at?: string | null;
  status: 'listed' | 'reserved';
  hold_until?: string | null;
  reserved_by_me: boolean;
  mine: boolean;
  seller: string;         // R•••12
  seller_rank: string;
  seller_sold: number;
  ticket_hint: string;    // NR-2026-08-••••
}

/** ต่อฐานข้อมูลได้ แต่ยังไม่มีฟังก์ชัน = ยังไม่ได้รัน v71 → ต้องเตือนตรงๆ ห้าม fallback เงียบ */
export const isMissingRpc = (r: MarketRes) => r.error === 'no_rpc';

async function call<T = MarketRes>(fn: string, args: Record<string, unknown> = {}): Promise<T & MarketRes> {
  if (!supabase) return { error: 'no_server' } as T & MarketRes;
  // โหมด "ดูเป็นลูกค้า": RPC ตลาดวิ่งด้วย session แอดมินตัวจริง (มีผลจริง · ขอเลขกระเป๋า/นับโควตา/บันทึกเปิดดูบัญชี)
  //   → อ่านกระดานได้อย่างเดียว ที่เหลือไม่ส่ง (audit รอบ E R2B-09 / R2A-09)
  if (simActive() && fn !== 'ryuma_market_feed') return { error: 'sim' } as T & MarketRes;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { data, error } = await Promise.race([
      supabase.rpc(fn, args),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${fn} timed out`)), RPC_TIMEOUT); }),
    ]);
    if (error) {
      const missing = /does not exist|could not find/i.test(error.message ?? '') || error.code === 'PGRST202';
      return { error: missing ? 'no_rpc' : (error.message || 'error') } as T & MarketRes;
    }
    return (data ?? { error: 'error' }) as T & MarketRes;
  } catch (e) {
    return { error: (e as Error)?.message ?? 'timeout' } as T & MarketRes;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const marketFeed = () => call<{ rows?: MarketRow[]; closed?: boolean }>('ryuma_market_feed');
/** ลงประกาศ — ส่งบัญชีที่เลือกในหน้าลงขายไปด้วย (v76: เซิร์ฟเวอร์ล็อกบัญชีนี้กับประกาศ ไม่ไปอ่านบัญชีหลักที่อาจยังเซฟไม่ขึ้น) */
export const marketList = (ticketId: string, qty: number, price: number, payout: { promptpay?: string; bank?: string; account_no?: string; account_name: string }) =>
  call('ryuma_market_list', { p_ticket_id: ticketId, p_qty: qty, p_price: price, p_payout: payout });
export const marketCancel = (id: string) => call('ryuma_market_cancel', { p_id: id });
export const marketReserve = (id: string) => call('ryuma_market_reserve', { p_id: id });
export const marketRelease = (id: string) => call('ryuma_market_release', { p_id: id });
export const marketPayout = (id: string) => call('ryuma_market_payout', { p_id: id });
export const marketPay = (id: string, slipUrl: string) => call('ryuma_market_pay', { p_id: id, p_slip: slipUrl });
export const marketSellerConfirm = (id: string) => call('ryuma_market_seller_confirm', { p_id: id });
export const marketSellerReject = (id: string, note: string, evidence: string[] = []) =>
  call('ryuma_market_seller_reject', { p_id: id, p_note: note, p_evidence: evidence });
export const marketEscalate = (id: string, note?: string) => call('ryuma_market_escalate', { p_id: id, p_note: note ?? null });
/** แอดมิน — orderItemId = รายการในออเดอร์ของคนขายที่ตั๋วเกิดมา (จาก pairItemsWithTickets) สำหรับตั๋วรุ่นเก่าที่ id ไม่ผูกรายการ */
export const marketFinalize = (id: string, orderItemId?: string) => call('ryuma_market_finalize', { p_id: id, p_order_item_id: orderItemId ?? null });
export const marketAdminCancel = (id: string, reason: string) => call('ryuma_market_admin_cancel', { p_id: id, p_reason: reason });

// ── v73 "เปลี่ยนใบพรี" (โอนตรงด้วยเลขกระเป๋า 4 หลักรายวัน) ─────────────────────────────
export type WalletCodeRes = MarketRes & { code?: string; day?: string; resets_at?: string };
export type WalletLookupRes = MarketRes & { user_id?: string; name?: string; avatar_url?: string | null; mask?: string };
/** เลขกระเป๋าของฉันวันนี้ (server สุ่ม+กันชน · รีเซ็ตเที่ยงคืนไทย) */
export const walletCode = () => call<WalletCodeRes>('ryuma_wallet_code');
/** เลขกระเป๋า → ผู้รับ (ชื่อ+รูป เพื่อยืนยัน "ใช่คนนี้ไหม") · จำกัด 20 ครั้ง/วัน */
export const walletLookup = (code: string) => call<WalletLookupRes>('ryuma_wallet_lookup', { p_code: code });
/** ส่งข้อเสนอเปลี่ยนใบให้เลขกระเป๋านี้ — บัญชีรับเงินถูกล็อกกับดีล (payout_snap) · ผู้รับมี 24 ชม.
 *  `expectUser` = user_id ที่ได้จากการค้นเลข (คนที่ยืนยัน "ใช่คนนี้") — เซิร์ฟเวอร์ (v75) ส่งให้เฉพาะเมื่อเลขยังเป็นของคนนั้น
 *  (กันข้ามเที่ยงคืนแล้วเลขเดิมเป็นของคนแปลกหน้า · audit รอบ B R1-02) · ส่งซ้ำแบบเดิม = ok again (R1-38) */
export const marketOffer = (ticketId: string, qty: number, price: number, code: string, payout: { promptpay?: string; bank?: string; account_no?: string; account_name: string } | null, expectUser: string) =>
  call<MarketRes & { to_mask?: string }>('ryuma_market_offer', { p_ticket_id: ticketId, p_qty: qty, p_price: price, p_code: code, p_payout: payout, p_expect_user: expectUser });
/** ผู้รับไม่รับข้อเสนอ (ยังไม่โอน) → ดีลปิด ตั๋วปลดล็อก */
export const marketDecline = (id: string) => call('ryuma_market_decline', { p_id: id });
/** แอดมินปิดเรื่อง "ผู้รับโอนแล้วแต่ดีลปิดไปก่อน" หลังเคลียร์คืนเงิน (v75) */
export const marketLateSlipResolve = (id: string, note: string) => call('ryuma_market_late_slip_resolve', { p_id: id, p_note: note });

/**
 * push ของตลาด — ฝั่งนี้ส่งแค่ (id ดีล, ชนิด) · ปลายทาง+ข้อความตัดสินที่ server (ryuma_market_push_targets v72)
 * เพราะลูกค้าไม่เห็นเครื่องของคนอื่น (RLS) และตลาดยังปิด = ส่งถึงแอดมินเท่านั้น · best-effort ห้ามทำให้ดีลพัง
 */
export type MarketPushKind = 'listed' | 'reserved' | 'paid' | 'seller_ok' | 'reviewing' | 'remind' | 'done' | 'sold' | 'cancelled'
  | 'offer' | 'declined' | 'withdrawn' // v73 เปลี่ยนใบพรี
  | 'late_slip'; // v75 ผู้รับโอนแล้วแต่ดีลปิดไปก่อน → แจ้งคนส่ง + แอดมิน
export async function marketPush(id: string, kind: MarketPushKind): Promise<void> {
  if (!supabase || simActive()) return;
  try {
    const token = await Promise.race([
      supabase.auth.getSession().then((r) => r.data.session?.access_token),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500)),
    ]);
    if (!token) return;
    await fetch('/api/push-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ market: { id, kind } }),
    });
  } catch { /* push ห้ามทำให้ดีลพัง */ }
}

/** ข้อความไทยของรหัส error — ใช้ร่วมทุกหน้า (ลูกค้า + แอดมิน) */
export const MARKET_ERR_TH: Record<string, string> = {
  closed: 'ยังไม่เปิดให้ใช้งาน — เร็วๆ นี้',
  sim: SIM_BLOCKED,
  // v73 เปลี่ยนใบพรี
  bad_code: 'เลขกระเป๋าต้องเป็นตัวเลข 4 หลัก',
  too_many: 'ค้นเลขกระเป๋าครบโควตาวันนี้แล้ว (20 ครั้ง) — ลองใหม่พรุ่งนี้',
  self: 'นี่คือเลขกระเป๋าของคุณเอง',
  not_ready: 'ผู้รับยังรับใบพรีไม่ได้ (บัญชียังไม่พร้อม) — ให้เขาติดต่อร้าน',
  busy: 'ระบบยุ่งอยู่ — ลองใหม่อีกครั้ง',
  no_server: 'ยังไม่ได้ต่อฐานข้อมูล (โหมดพรีวิว)',
  no_rpc: 'ระบบตลาดยังไม่เปิดในฐานข้อมูล — แอดมินต้องรัน migration v71 ก่อน',
  no_session: 'กรุณาเข้าสู่ระบบก่อน',
  not_found: 'ไม่พบรายการนี้แล้ว — รีเฟรชหน้าอีกครั้ง',
  admin_only: 'เฉพาะแอดมิน',
  bad_status: 'สถานะเปลี่ยนไปแล้ว — รีเฟรชหน้าอีกครั้ง',
  bad_price: 'ราคาต้องเป็นจำนวนเต็มบาท',
  bad_qty: 'จำนวนชิ้นไม่ถูกต้อง',
  bad_slip: 'แนบรูปสลิปก่อน',
  no_payout: 'เลือกหรือเพิ่มบัญชีรับเงินก่อน',
  // ใช้ทั้งตอนจองกระดาน (ตัวคุณ) และตอนส่งข้อเสนอ (ผู้รับ) — ข้อความกลางๆ (audit รอบ E R1-31)
  no_address: 'คนรับใบต้องมีที่อยู่จัดส่งในโปรไฟล์ก่อน — ถ้าเป็นคุณ เพิ่มได้ที่หน้าโปรไฟล์',
  own_listing: 'ซื้อประกาศของตัวเองไม่ได้',
  reserved: 'มีคนกำลังจองใบนี้อยู่',
  gone: 'ใบนี้ไม่ได้ลงขายแล้ว',
  one_at_a_time: 'จองได้ทีละใบ — จ่ายหรือปล่อยใบที่จองอยู่ก่อน',
  hold_expired: 'หมดเวลาแล้ว — ถ้าโอนเงินไปแล้วกด “ติดต่อร้าน”',
  too_early: 'ยังไม่ครบเวลาที่คนขายต้องตอบ',
  not_owner: 'ไม่ใช่ใบของคุณ',
  delivery_chosen: 'เลือกวิธีรับของแล้ว ขายไม่ได้',
  still_open: 'ยังเปิดจองอยู่ — ขายได้หลังปิดรอบ',
  bad_product_status: 'สถานะของใบนี้ขายในตลาดไม่ได้',
  instock: 'ของพร้อมส่งไม่ใช่ใบพรี',
  sourcing: 'ตั๋วงานหาของขายในตลาดไม่ได้',
  pending_slip: 'มีสลิปส่วนต่างรอตรวจ',
  already_listed: 'ใบนี้ลงขาย/ส่งข้อเสนออยู่แล้ว',
  max_active: 'ลงขาย/ส่งข้อเสนอพร้อมกันได้สูงสุด 5 ใบ',
  resell_hold: 'ได้ใบนี้มาจากคนอื่น ต้องถือครบ 3 วันก่อนส่งต่อ',
  topup_needed: 'ต้องเติมมัดจำให้ครบก่อนเปลี่ยนใบ/ลงขาย',
  owner_changed: 'ตั๋วเปลี่ยนเจ้าของไปแล้ว',
  ticket_moving: 'ตั๋วเข้าขั้นตอนจัดส่งแล้ว',
  ticket_missing: 'ไม่พบตั๋วใบนี้',
  // v75 รอบ B
  code_changed: 'เลขกระเป๋านี้ไม่ใช่ของคนที่ยืนยันไว้แล้ว (อาจข้ามเที่ยงคืน) — ขอเลขใหม่จากผู้รับแล้วค้นอีกครั้ง',
  recipient_paying: 'ผู้รับเปิดหน้าโอนเงินแล้ว ถอนเองไม่ได้ — ถ้าจำเป็นให้ติดต่อร้านยกเลิก',
  withdrawn: 'ข้อเสนอนี้ถูกถอน/ยกเลิกไปแล้ว',
  use_decline: 'ใช้ปุ่ม "ไม่รับข้อเสนอ" แทน',
  free_deal: 'ดีลยกให้ฟรีไม่มีเงินให้ตรวจ',
  gift_cancel_unavailable: 'ยังยกเลิกการยกให้เองไม่ได้ในตอนนี้ — ติดต่อร้านให้ยกเลิกแทน',
  // v74 รอบ A: ยอดเงินของใบนี้ไม่ตรงกับตอนตกลงกัน (มีคนแก้ระหว่างดีล) — ต้องยกเลิกดีลแล้วตกลงใหม่
  ticket_changed: 'ยอดเงินของใบนี้เปลี่ยนไปจากตอนตกลงกัน — ยกเลิกดีลนี้แล้วให้ตกลงใหม่ตามยอดล่าสุด',
};
export const marketErrText = (r: MarketRes) => MARKET_ERR_TH[r.error ?? ''] ?? (r.error ? `ทำรายการไม่สำเร็จ (${r.error})` : 'ทำรายการไม่สำเร็จ');
/** ข้อความผลค้นเลขกระเป๋า — เลขไม่เจอ ≠ "รายการหาย" (audit รอบ E R1-18) */
export const lookupErrText = (r: MarketRes) =>
  r.error === 'not_found' ? 'ไม่พบเลขกระเป๋านี้ — เลขเปลี่ยนทุกเที่ยงคืน ขอเลขล่าสุดจากผู้รับ' : marketErrText(r);
