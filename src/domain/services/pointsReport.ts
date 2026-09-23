import type { Database, PreorderTicket } from '../entities';
import { ticketsMissingEarn, rawPointsForTicket, ratePerPiece, ticketClosed, ticketEarnBlock, hasEarned, batchPoints, batchPointsSet } from './points';
import { ticketSourceOf } from './ticketSource';
import { offlineRpIdFor } from './payments';
import { productLabel } from './catalog';

/**
 * "ตรวจก่อนกดเปิดตัว" (เจ้าของ 2026-09-23: "เชคคะแนนที่ลูกค้าจะได้ว่ามีอะไรแปลกๆ ไหม รวมถึงเคสมอบใบพรีให้ ตัดจบข้างนอก")
 * แยกแต้มย้อนหลังที่จะให้ตอนกด 🚀 ตามที่มาของตั๋ว + รายรอบพิเศษ + ตั๋วที่ปิดยอดแล้วแต่ไม่ได้แต้ม (พร้อมเหตุผล)
 * ใช้สูตรเดียวกับ backfill จริง (ticketsMissingEarn / rawPointsForTicket) → ตัวเลขที่เห็น = สิ่งที่ปุ่มจะทำ
 * ส่ง db ที่ "ตั้งอัตราพร้อมส่ง = 0 แล้ว" เข้ามา (เหมือนตอนเปิดตัว)
 */
export type LaunchCatKey = 'normal' | 'special' | 'granted';
export interface LaunchCat { key: LaunchCatKey; label: string; hint: string; tickets: number; pieces: number; points: number }
export interface LaunchRound {
  batchId: string; label: string; product: string; fullPay: boolean; // fullPay = รอบจ่ายเต็ม (ของอยู่ในมือ)
  perTicket: number; explicit: boolean;          // explicit = แอดมินเลือกไว้แล้ว (ไม่ใช่ค่าเริ่มต้น)
  bought: number; granted: number; pieces: number; points: number;
}
export interface LaunchSkip { key: string; label: string; tickets: number }
const SAMPLE = 8;
export interface LaunchBreakdown {
  cats: LaunchCat[];
  rounds: LaunchRound[];
  offlineClosed: { tickets: number; points: number };      // ในจำนวนที่ได้แต้ม: ปิดด้วย "ตัดจบข้างนอก"
  grantedPrepaid: { tickets: number; points: number };     // ในจำนวนที่ได้แต้ม: ตั๋วมอบที่จ่ายครบตั้งแต่มอบ (ไม่มีเงินเข้าในแอป)
  /** ในจำนวนที่ได้แต้ม: ตั๋ว 1 ใบที่มีหลายชิ้น (qty > 1) — ได้ "ต่อชิ้น" · extra = แต้มที่ได้เกินกว่าคิดใบละครั้ง */
  multiPiece: { tickets: number; pieces: number; extra: number };
  skipped: LaunchSkip[];
  alreadyEarned: number;
  /** ตัวอย่างเลขตั๋ว (สูงสุด 8) ให้แอดมินเปิดดูว่าเข้ากลุ่มถูกไหม */
  samples: { offline: string[]; prepaid: string[]; instock: string[]; grantedFull: string[]; multi: string[] };
  total: { tickets: number; points: number; customers: number };
}

const CAT_META: Record<LaunchCatKey, { label: string; hint: string }> = {
  normal: { label: '📝 ใบพรีรอบปกติ (สั่งในแอป)', hint: 'ปิดใบ +20/ใบ' },
  special: { label: '⚡ รอบพิเศษ (สั่งในแอป)', hint: 'ตามที่ตั้งต่อรอบ +20/+40' },
  granted: { label: '🎁 ตั๋วที่แอดมินมอบ (ไล่เก็บใบพรี / ตกลงทางแชท)', hint: 'อยู่ในรอบพิเศษ = ตามรอบ · ตั๋วเก่าที่ไม่มีรอบ = +20' },
};

export function launchBreakdown(db: Database): LaunchBreakdown {
  const cats = new Map<LaunchCatKey, LaunchCat>();
  const rounds = new Map<string, LaunchRound>();
  const offline = { tickets: 0, points: 0 };
  const prepaid = { tickets: 0, points: 0 };
  const multi = { tickets: 0, pieces: 0, extra: 0 };
  const customers = new Set<string>();
  let tickets = 0, points = 0;
  const samples = { offline: [] as string[], prepaid: [] as string[], instock: [] as string[], grantedFull: [] as string[], multi: [] as string[] };
  const tag = (t: PreorderTicket) => `${t.ticket_no} · ${productLabel(db, t.product_id, t.variant_id)}${(t.qty ?? 1) > 1 ? ` ×${t.qty}` : ''} · ${db.users.find((u) => u.id === t.owner_id)?.display_name ?? t.owner_id}`;
  const push = (arr: string[], t: PreorderTicket) => { if (arr.length < SAMPLE) arr.push(tag(t)); };
  const offlineIds = new Set(db.remainingPayments.filter((r) => r.status === 'approved' && r.id.startsWith('rp-off-')).map((r) => r.id));

  for (const t of ticketsMissingEarn(db)) {
    const pts = rawPointsForTicket(db, t);
    const src = ticketSourceOf(db, t);
    const key: LaunchCatKey = src === 'granted' ? 'granted' : t.batch_id ? 'special' : 'normal';
    const c = cats.get(key) ?? { key, ...CAT_META[key], tickets: 0, pieces: 0, points: 0 };
    c.tickets += 1; c.pieces += Math.max(1, t.qty ?? 1); c.points += pts;
    cats.set(key, c);
    tickets += 1; points += pts; customers.add(t.owner_id);
    if (offlineIds.has(offlineRpIdFor(t.id))) { offline.tickets += 1; offline.points += pts; push(samples.offline, t); }
    if (key === 'granted' && isPrepaidGrant(db, t)) { prepaid.tickets += 1; prepaid.points += pts; push(samples.prepaid, t); }
    const q = Math.max(1, t.qty ?? 1);
    if (q > 1) { multi.tickets += 1; multi.pieces += q; multi.extra += pts - ratePerPiece(db, t); push(samples.multi, t); }
    if (t.batch_id) {
      const b = db.batches.find((x) => x.id === t.batch_id);
      const r = rounds.get(t.batch_id) ?? {
        batchId: t.batch_id, label: b?.label ?? '(รอบถูกลบ)', product: productLabel(db, t.product_id, t.variant_id), fullPay: !!b && b.deposit_amount >= b.price_total,
        perTicket: batchPoints(db, t.batch_id), explicit: batchPointsSet(db, t.batch_id) != null,
        bought: 0, granted: 0, pieces: 0, points: 0,
      };
      if (key === 'granted') r.granted += 1; else r.bought += 1;
      r.pieces += Math.max(1, t.qty ?? 1); r.points += pts;
      rounds.set(t.batch_id, r);
    }
  }

  // ปิดยอดแล้วแต่ไม่ได้แต้ม — บอกเหตุผลให้แอดมินเห็นก่อนกด
  const skip = new Map<string, LaunchSkip>();
  const bump = (key: string, label: string) => { const s = skip.get(key) ?? { key, label, tickets: 0 }; s.tickets += 1; skip.set(key, s); };
  let alreadyEarned = 0;
  let free = 0;
  for (const t of db.tickets) {
    if (!ticketClosed(t)) {
      // จ่ายครบแต่ไม่มีเงินเลย (มอบฟรี/ราคา 0) — ticketClosed ต้องมีเงินจริง > 0
      if ((t.remaining_amount ?? 0) - (t.remaining_paid ?? 0) <= 0 && (t.deposit_paid ?? 0) + (t.remaining_paid ?? 0) <= 0) free += 1;
      continue;
    }
    if (hasEarned(db, t.id)) { alreadyEarned += 1; continue; }
    const block = ticketEarnBlock(db, t);
    if (block) { bump(block, block); continue; }
    if (rawPointsForTicket(db, t) === 0) {
      // ตั๋วมอบเก่าที่ "ไม่มีรอบ" + จ่ายเต็มตั้งแต่มอบ → สูตรตีเป็นพร้อมส่ง (0) — แยกบรรทัดให้เห็น เผื่อจริงๆ เป็นใบพรีที่เก็บเงินครบทางแชท
      if (ticketSourceOf(db, t) === 'granted') { bump('granted-full', 'ตั๋วมอบเก่า (ไม่มีรอบ) ที่จ่ายเต็มตั้งแต่มอบ — ระบบนับเป็นพร้อมส่ง'); push(samples.grantedFull, t); }
      else { bump('instock', 'ของพร้อมส่ง / จ่ายเต็มนอกรอบพิเศษ (อัตราพร้อมส่ง = 0)'); push(samples.instock, t); }
    }
  }
  if (free > 0) skip.set('free', { key: 'free', label: 'ตั๋วที่ไม่มีการจ่ายเงินเลย (มอบฟรี / ราคา 0)', tickets: free });

  const order: LaunchCatKey[] = ['normal', 'special', 'granted'];
  return {
    cats: order.map((k) => cats.get(k) ?? { key: k, ...CAT_META[k], tickets: 0, pieces: 0, points: 0 }),
    rounds: [...rounds.values()].sort((a, b) => b.points - a.points),
    offlineClosed: offline,
    grantedPrepaid: prepaid,
    multiPiece: multi,
    skipped: [...skip.values()].sort((a, b) => b.tickets - a.tickets),
    alreadyEarned,
    samples,
    total: { tickets, points, customers: customers.size },
  };
}

/** ตั๋วมอบที่ "จ่ายครบตั้งแต่ตอนมอบ" — ไม่มีสลิปส่วนต่างในแอปเลย (ลูกค้าจ่ายนอกแอปทั้งหมด หรือเป็นของแถม/ชดเชย) */
function isPrepaidGrant(db: Database, t: PreorderTicket): boolean {
  return (t.remaining_amount ?? 0) === 0 && !db.remainingPayments.some((r) => r.ticket_id === t.id && r.status === 'approved');
}
