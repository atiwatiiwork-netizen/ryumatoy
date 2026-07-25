import type { Database, PreorderTicket } from '../entities';
import { ticketDue, ticketPaid, ticketTotal } from './money';
import { DELIVERY_METHOD_LABEL, resolveShipTo, ticketPaidFull } from './delivery';

/**
 * "เส้นทางของตั๋ว" — ร้อยเรียงทุกฟีเจอร์ให้เห็นเป็นเส้นเดียว (flow review 2026-07-25).
 *
 * ข้อมูลของตั๋ว 1 ใบกระจายอยู่ 7 ที่: order (สลิปมัดจำ) · ticket · product/batch (วงจรล็อต) ·
 * warehouse (ยืนยันโกดังจีน) · remainingPayments (ส่วนต่าง) · delivery jsonb (วิธีรับของ) ·
 * parcel (เลขพัสดุ). เวลามีปัญหา แอดมินต้องเปิด 5 หน้าไล่ดู — ตัวนี้ประกอบให้อ่านได้ในที่เดียว
 * จาก "ข้อมูลที่มีอยู่แล้ว" (ไม่ต้อง migration ไม่เก็บ log ใหม่).
 *
 * ใช้ที่: TicketPeek (แอดมิน) และใช้ตรวจเคสลูกค้าได้ทันทีว่าตอนนี้ค้างอยู่ขั้นไหน ใครต้องขยับ.
 */

export type StepState = 'done' | 'current' | 'wait' | 'warn';
export interface JourneyStep {
  key: string;
  label: string;
  at?: string;          // เวลาที่เกิดขึ้นจริง (ถ้ารู้)
  detail?: string;      // รายละเอียดสั้นๆ
  state: StepState;
  actor?: 'ลูกค้า' | 'แอดมิน' | 'ระบบ';
}

export interface Journey {
  steps: JourneyStep[];
  /** ตอนนี้รออะไร/ใครต้องขยับ — ใช้ตอบลูกค้าได้ทันที */
  waitingOn: string;
  money: { paid: number; due: number; total: number };
  /** ความผิดปกติที่เจอระหว่างร้อยเรียง (ข้อมูลไม่ตรงกัน) */
  anomalies: string[];
}

/** หา order ที่ออกตั๋วใบนี้ (จับคู่ด้วย product+variant+batch ของเจ้าของ ใกล้เวลาออกตั๋วที่สุด). */
export function orderOfTicket(db: Database, t: PreorderTicket) {
  const tTime = new Date(t.created_at).getTime();
  return db.orders
    .filter((o) => o.user_id === t.owner_id && o.items.some((i) =>
      i.product_id === t.product_id && (i.batch_id ?? null) === (t.batch_id ?? null) && (i.variant_id ?? null) === (t.variant_id ?? null)))
    .sort((a, b) => Math.abs(new Date(a.approved_at ?? a.created_at).getTime() - tTime) - Math.abs(new Date(b.approved_at ?? b.created_at).getTime() - tTime))[0];
}

export function ticketJourney(db: Database, t: PreorderTicket): Journey {
  const p = db.products.find((x) => x.id === t.product_id);
  const batch = t.batch_id ? db.batches.find((b) => b.id === t.batch_id) : undefined;
  const order = orderOfTicket(db, t);
  const rps = db.remainingPayments.filter((r) => r.ticket_id === t.id);
  const rpApproved = rps.find((r) => r.status === 'approved');
  const rpPending = rps.find((r) => r.status === 'pending');
  const sourcing = db.sourcingRequests.find((s) => s.product_id === t.product_id);
  const d = t.delivery;
  const paidFull = ticketPaidFull(t);
  const shipped = t.status === 'shipped';
  const anomalies: string[] = [];
  const steps: JourneyStep[] = [];
  const push = (s: JourneyStep) => steps.push(s);

  // ① ที่มาของตั๋ว
  if (sourcing) {
    push({ key: 'source', label: 'หาของให้ตามคำขอ', at: sourcing.approved_at ?? sourcing.paid_at, detail: `${sourcing.character_name} · มัดจำ ${sourcing.deposit ?? 0}/ชิ้น`, state: 'done', actor: 'แอดมิน' });
  } else if (order) {
    push({ key: 'order', label: 'ลูกค้าสั่งซื้อ + แนบสลิป', at: order.created_at, detail: batch ? `รอบพิเศษ · ${batch.label}` : p?.is_stock ? 'ของพร้อมส่ง (จ่ายเต็ม)' : 'พรีออเดอร์', state: 'done', actor: 'ลูกค้า' });
    push({ key: 'approve', label: 'แอดมินตรวจสลิป → ออกตั๋ว', at: order.approved_at ?? t.created_at, detail: t.ticket_no, state: 'done', actor: 'แอดมิน' });
  } else {
    push({ key: 'grant', label: 'แอดมินมอบตั๋วให้โดยตรง', at: t.created_at, detail: batch ? `จากรอบ ${batch.label}` : 'ไล่เก็บใบพรีเก่า', state: 'done', actor: 'แอดมิน' });
  }

  // ② วงจรของ (เฉพาะพรี — in-stock ข้ามไปเลือกวิธีรับของ)
  const isStockBuy = !!p?.is_stock && (t.remaining_amount ?? 0) === 0;
  if (!isStockBuy) {
    const ps = t.product_status;
    const reached = (s: string) => ['open', 'production', 'shipping', 'arrived', 'delivered', 'closed'].indexOf(ps) >= ['open', 'production', 'shipping', 'arrived', 'delivered', 'closed'].indexOf(s);
    push({ key: 'production', label: 'ปิดรอบ → สั่งผลิต', state: reached('production') ? 'done' : ps === 'open' ? 'current' : 'wait', actor: 'แอดมิน' });
    push({
      key: 'warehouse', label: 'เข้าโกดังจีน (ยืนยัน SF)',
      at: t.warehouse_at, detail: t.warehouse_at ? `ขนส่ง: ${t.warehouse_transport === 'ship' ? 'เรือ' : 'รถ'}` : p?.sf_code ? `SF ${p.sf_code}` : undefined,
      state: t.warehouse_at ? 'done' : reached('shipping') ? 'done' : ps === 'production' ? 'current' : 'wait', actor: 'แอดมิน',
    });
    push({ key: 'shipping', label: 'กำลังเดินทางมาไทย', at: p?.shipped_at, state: reached('arrived') ? 'done' : ps === 'shipping' ? 'current' : 'wait', actor: 'ระบบ' });
    push({ key: 'arrived', label: 'ถึงไทยแล้ว', state: reached('arrived') ? 'done' : 'wait', actor: 'แอดมิน' });

    // ③ ส่วนต่าง (เฉพาะตั๋วที่มีส่วนต่าง)
    if ((t.remaining_amount ?? 0) > 0 || rps.length > 0) {
      push({
        key: 'remaining', label: 'ลูกค้าชำระส่วนต่าง',
        at: rpApproved?.approved_at ?? rpPending?.created_at,
        detail: paidFull ? 'ครบแล้ว' : rpPending ? `ส่งสลิปแล้ว ${rpPending.amount} — รอแอดมินตรวจ` : `ค้าง ${ticketDue(t)}`,
        state: paidFull ? 'done' : rpPending ? 'warn' : reached('arrived') ? 'current' : 'wait',
        actor: rpPending ? 'แอดมิน' : 'ลูกค้า',
      });
    }
  }

  // ④ การรับของ
  push({
    key: 'choose', label: 'ลูกค้าเลือกวิธีรับของ',
    at: d?.requested_at,
    detail: d ? DELIVERY_METHOD_LABEL[d.method] : undefined,
    state: d ? 'done' : shipped ? 'done' : paidFull && (isStockBuy || ['arrived', 'delivered'].includes(t.product_status)) ? 'current' : 'wait',
    actor: 'ลูกค้า',
  });
  if (d || shipped) {
    push({ key: 'accept', label: 'แอดมินรับเรื่องจัดส่ง', at: d?.accepted_at, state: d?.accepted_at ? 'done' : shipped ? 'done' : 'current', actor: 'แอดมิน' });
  }
  if (d?.method === 'courier' || d?.method === 'pickup') {
    push({ key: 'handoff', label: d.method === 'courier' ? 'รถเข้ารับของ' : 'ลูกค้ามารับเอง', at: d.closed_at, state: d.closed_at ? 'done' : d.accepted_at ? 'current' : 'wait', actor: 'แอดมิน' });
  } else {
    const to = resolveShipTo(db, t);
    push({
      key: 'parcel', label: 'ส่งพัสดุ + แจ้งเลข',
      at: t.shipped_out_at,
      detail: t.parcel_no ? `${(t.carrier ?? '').toUpperCase()} ${t.parcel_no}` : to.address ? `📍 ${to.address.slice(0, 40)}${to.address.length > 40 ? '…' : ''}` : '⚠ ไม่มีที่อยู่',
      state: t.parcel_no ? 'done' : d?.accepted_at ? 'current' : 'wait', actor: 'แอดมิน',
    });
  }
  push({ key: 'done', label: 'เสร็จสิ้น · ลูกค้าได้รับของ', at: shipped ? t.shipped_out_at : undefined, state: shipped ? 'done' : 'wait', actor: 'ระบบ' });

  // ── ความผิดปกติ (ข้อมูลข้ามฟีเจอร์ไม่ตรงกัน) ──
  if (shipped && ticketDue(t) > 0) anomalies.push(`ส่งของแล้วแต่ยังค้าง ${ticketDue(t)} บาท`);
  if (t.parcel_no && !shipped) anomalies.push('มีเลขพัสดุแต่สถานะตั๋วไม่จบ (เซฟไม่สมบูรณ์)');
  if (d?.accepted_at && !paidFull) anomalies.push('รับเรื่องจัดส่งแล้วแต่ยอดยังไม่ครบ');
  if (!order && !sourcing && db.orders.some((o) => o.user_id === t.owner_id && o.status === 'approved')) {
    // ตั๋วที่หา order ไม่เจอ = มอบตรง (ปกติ) — ไม่ใช่ anomaly ถ้าไม่มี order ตรงกันจริงๆ
  }
  if (p && !p.is_stock && !t.batch_id && t.product_status !== p.status && !shipped && !t.warehouse_at)
    anomalies.push(`สถานะตั๋ว (${t.product_status}) ไม่ตรงกับสินค้า (${p.status})`);

  // ── ตอนนี้รอใคร ──
  const cur = steps.find((s) => s.state === 'current' || s.state === 'warn');
  const waitingOn = shipped ? 'จบงานแล้ว ✓' : cur ? `${cur.actor === 'ลูกค้า' ? '🙋 รอลูกค้า' : cur.actor === 'แอดมิน' ? '🛠 รอแอดมิน' : '⏳ รอของ'}: ${cur.label}` : '⏳ รอของเดินทาง';

  return { steps, waitingOn, money: { paid: ticketPaid(t), due: ticketDue(t), total: ticketTotal(t) }, anomalies };
}
