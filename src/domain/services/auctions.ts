import type { Auction, Database } from '../entities';

/**
 * ระบบประมูล — ตรรกะบริสุทธิ์ที่ "ทั้งสองฝั่งต้องคิดเหมือนกัน" (v60).
 *
 * ⚠ ตัวเลขที่แสดงบนหน้าจอมาจากที่นี่ได้ แต่ **การตัดสินว่าบิดผ่านหรือไม่เป็นของ server เสมอ**
 *   (`ryuma_place_bid`) — สูตรในไฟล์นี้ต้องตรงกับใน migration v60 เป๊ะ ถ้าแก้ต้องแก้ทั้งคู่
 *   เหตุผลเดียวกับสต๊อก: สองคนกดพร้อมกัน ฝั่ง client ตัดสินเองจะทับกันเงียบๆ
 */

// ── บันไดขั้นบิด (เจ้าของเคาะ 2026-07-31) ────────────────────────────────────
export type StepBand = { from: number; step: number };
export const DEFAULT_STEPS: StepBand[] = [
  { from: 0, step: 20 },
  { from: 3000, step: 50 },
  { from: 5000, step: 100 },
  { from: 10000, step: 200 },
];

/** อ่านบันไดขั้นจาก app_config 'auction_steps' (แอดมินแก้ได้) — ไม่มี = ใช้ค่าเริ่มต้น. */
export function stepBands(db: Database): StepBand[] {
  const row = db.appConfig.find((c) => c.key === 'auction_steps');
  const v = (row?.value as { bands?: StepBand[] } | undefined)?.bands;
  return Array.isArray(v) && v.length ? [...v].sort((a, b) => a.from - b.from) : DEFAULT_STEPS;
}

/** ขั้นบิดที่ราคาปัจจุบัน. */
export function stepFor(price: number, bands: StepBand[] = DEFAULT_STEPS): number {
  let step = bands[0]?.step ?? 20;
  for (const b of bands) if (price >= b.from) step = b.step;
  return step;
}

/** ยอดต่ำสุดที่บิดได้ตอนนี้ — ยังไม่มีใครบิด = ราคาเปิดพอดี. */
export function minNextBid(a: Pick<Auction, 'bid_count' | 'start_price' | 'current_price'>, bands: StepBand[] = DEFAULT_STEPS): number {
  return a.bid_count === 0 ? a.start_price : a.current_price + stepFor(a.current_price, bands);
}

/** กติกาเจ้าของ: บิดข้ามขั้นได้ ขอแค่ "ลงท้ายด้วย 0". */
export const isRoundAmount = (amount: number) => Number.isInteger(amount) && amount % 10 === 0;

export type BidReject = 'not_live' | 'ended' | 'not_round' | 'too_low' | 'no_right' | 'too_many_wins';

/** ตรวจก่อนยิง RPC เพื่อบอกเหตุผลทันทีบนหน้าจอ (server ตรวจซ้ำอยู่ดี). */
export function checkBid(a: Auction, amount: number, now: Date, bands: StepBand[] = DEFAULT_STEPS): BidReject | null {
  if (a.status !== 'live') return 'not_live';
  if (now.getTime() >= new Date(a.ends_at).getTime()) return 'ended';
  if (!isRoundAmount(amount)) return 'not_round';
  if (amount < minNextBid(a, bands)) return 'too_low';
  return null;
}

export const BID_REJECT_TH: Record<BidReject | 'auth' | 'not_found' | 'no_buynow' | 'price_passed' | 'no_server', string> = {
  not_live: 'ห้องนี้ยังไม่เปิดประมูล',
  ended: 'ประมูลปิดแล้ว',
  not_round: 'ยอดบิดต้องลงท้ายด้วย 0',
  too_low: 'ยอดต่ำกว่าขั้นต่ำที่บิดได้ตอนนี้',
  no_right: 'ต้องมีใบพรีที่ของยังไม่ถึงมือ หรือจ่ายค่าเข้าสนาม ฿300 ก่อน',
  too_many_wins: 'คุณมีรายการที่ชนะแล้วยังไม่จ่าย 2 รายการ — เคลียร์ก่อนจึงบิดต่อได้',
  auth: 'ต้องเข้าสู่ระบบก่อน',
  not_found: 'ไม่พบห้องประมูลนี้',
  no_buynow: 'ห้องนี้ไม่มีปุ่มซื้อเลย',
  price_passed: 'ราคาบิดเลยราคาซื้อเลยไปแล้ว',
  no_server: 'ต่อเซิร์ฟเวอร์ไม่ได้',
};

// ── ต่อเวลากันสไนป์ ─────────────────────────────────────────────────────────
/** เวลาปิดใหม่หลังบิด — สะสมครั้งละ extend_min ทุกบิดในช่วง window_min สุดท้าย,
 *  เพดาน = เวลาปิดเดิม + cap_min (เจ้าของ: 5 นาที / 30 นาที / 60 นาที). */
export function extendedEnd(a: Auction, now: Date): { ends_at: string; extended: boolean } {
  const end = new Date(a.ends_at).getTime();
  const windowStart = end - a.window_min * 60_000;
  if (now.getTime() < windowStart) return { ends_at: a.ends_at, extended: false };
  const cap = new Date(a.original_ends_at).getTime() + a.cap_min * 60_000;
  const next = Math.min(Math.max(end, now.getTime()) + a.extend_min * 60_000, cap);
  return { ends_at: new Date(next).toISOString(), extended: next > end };
}

/** อยู่ในช่วงกฎต่อเวลาแล้วหรือยัง (ใช้โชว์ป้ายเตือน). */
export function inSnipeWindow(a: Auction, now: Date): boolean {
  const end = new Date(a.ends_at).getTime();
  return now.getTime() >= end - a.window_min * 60_000 && now.getTime() < end;
}

/** ต่อเวลาจนชนเพดานแล้ว = นาทีสุดท้ายจะไม่ต่อให้อีก (ต้องบอกลูกค้าตรงๆ). */
export function extendCapped(a: Auction): boolean {
  return new Date(a.ends_at).getTime() >= new Date(a.original_ends_at).getTime() + a.cap_min * 60_000;
}

/** เวลาที่เหลือแบบอ่านง่าย. */
export function timeLeftLabel(ms: number): string {
  if (ms <= 0) return 'ปิดแล้ว';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d} วัน ${h} ชม.`;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ── สิทธิ์เข้าประมูล ────────────────────────────────────────────────────────
/**
 * (ก) มีใบพรีที่ "ของยังไม่ถึงมือ" — เจ้าของ 2026-07-31 เลือกกติกานี้แทน "เคยมีใบพรี"
 * เพราะหลักประกันคือ *เขายังมีของค้างอยู่กับเรา*. ตัดการซื้อของพร้อมส่งล้วนออก (ไม่ใช่ใบพรี)
 * — สูตรเดียวกับ hasPreorderTicket ใน tickets.ts แต่บวกเงื่อนไข "ยังไม่ถึงมือ".
 */
export function hasOpenPreorderTicket(db: Database, userId: string): boolean {
  return db.tickets.some((t) => {
    if (t.owner_id !== userId) return false;
    if (t.status === 'shipped' || t.product_status === 'delivered') return false;
    if (t.batch_id) return true;
    const p = db.products.find((x) => x.id === t.product_id);
    return !(p?.is_stock && t.remaining_amount === 0);
  });
}

/** (ข) จ่ายค่าเข้าสนาม ฿300 แล้ว หรือแอดมินปลดล็อกให้. */
export function hasAuctionEntry(db: Database, userId: string): boolean {
  return db.auctionEntries.some((e) => e.user_id === userId && (e.status === 'approved' || e.status === 'used'));
}

/** ค่าเข้าสนามที่รอแอดมินตรวจสลิป. */
export function pendingEntry(db: Database, userId: string) {
  return db.auctionEntries.find((e) => e.user_id === userId && e.status === 'pending');
}

export const MAX_OPEN_WINS = 2;
/** รายการที่ชนะแล้วยังไม่จ่าย (เพดาน 2 รายการ/คน). */
export function openWins(db: Database, userId: string): Auction[] {
  return db.auctions.filter((a) => a.winner_user_id === userId && (a.status === 'ended' || a.status === 'awarded'));
}

export type BidRight = { ok: true } | { ok: false; reason: 'no_right' | 'too_many_wins' };
export function bidRight(db: Database, userId: string): BidRight {
  if (!hasOpenPreorderTicket(db, userId) && !hasAuctionEntry(db, userId)) return { ok: false, reason: 'no_right' };
  if (openWins(db, userId).length >= MAX_OPEN_WINS) return { ok: false, reason: 'too_many_wins' };
  return { ok: true };
}

// ── สวิตช์เปิดให้ลูกค้าเห็น ─────────────────────────────────────────────────
/** เจ้าของ 2026-07-31: "ยังไม่เปิดให้ใช้ในฝั่งผู้ใช้" — default ปิด, แอดมินเข้าดู/ลองเล่นได้เสมอ. */
export function auctionPublicEnabled(db: Database): boolean {
  const row = db.appConfig.find((c) => c.key === 'auction_public');
  return (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
}

// ── ตัวช่วยรายการ ───────────────────────────────────────────────────────────
export const isLive = (a: Auction, now = new Date()) => a.status === 'live' && new Date(a.ends_at).getTime() > now.getTime();
/** ถึงเวลาปิดแล้วแต่ยังไม่มีใครกดสรุปผล (ไม่มี scheduler — แอดมินกดจากการ์ดงานค้าง). */
export const needsClose = (a: Auction, now = new Date()) => a.status === 'live' && new Date(a.ends_at).getTime() <= now.getTime();

export function sortedAuctions(db: Database, now = new Date()): Auction[] {
  const rank = (a: Auction) => (isLive(a, now) ? 0 : needsClose(a, now) ? 1 : a.status === 'draft' ? 2 : 3);
  return [...db.auctions].sort((a, b) => rank(a) - rank(b) || new Date(a.ends_at).getTime() - new Date(b.ends_at).getTime());
}

export const AUCTION_STATUS_TH: Record<Auction['status'], string> = {
  draft: 'ร่าง (ยังไม่เปิด)',
  live: 'กำลังประมูล',
  ended: 'ปิดประมูลแล้ว',
  awarded: 'รอผู้ชนะจ่าย',
  paid: 'จ่ายแล้ว',
  cancelled: 'ยกเลิก',
};

/** ผู้ชนะเลยกำหนดจ่าย 24 ชม. แล้ว → สิทธิ์ตกไปอันดับ 2 ตามกติกาที่ประกาศไว้. */
export function payOverdue(a: Auction, now = new Date()): boolean {
  return !!a.pay_due_at && (a.status === 'ended' || a.status === 'awarded') && new Date(a.pay_due_at).getTime() < now.getTime();
}
