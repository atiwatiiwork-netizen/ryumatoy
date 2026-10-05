/**
 * เทสต์รอบ 1 ของ "ตรวจหาบัค" 2026-10-05 (ฝั่งแอป) — regression จากรอบ A–E ที่ลูกค้าโดนอยู่
 *   #1 ถูกปฏิเสธถาวร ≠ เน็ตสะดุด (checkout/ProfileGate บอกเหตุผลจริง · adapter แปลง RLS-ไม่มี-session เป็นชั่วคราว)
 *   #2 ขาดคอลัมน์ (ยังไม่รัน SQL) = ชั่วคราว ลองใหม่ช้าๆ ไม่ทิ้งงาน
 *   #3 Postgres ปฏิเสธค่า / ด่านรุ่นเก่าไม่มี ryuma: = ถาวร · ปุ่ม reload({safe}) บอกงานที่ค้างจริง
 *   #4 paidByUser ไม่นับสลิปของตั๋วที่ถูกลบ
 * รัน: npm run audit:round1
 */
import { isTransientPersistError, isSchemaDriftError, friendlyPersistError, persistFailText } from '../../src/data/persistErrors';
import { paidByUser } from '../../src/domain/services/money';
import { Store } from '../../src/data/store';
import { SEED_DATABASE } from '../../src/data/seed';
import type { Database, Order, PreorderTicket, TicketTransfer } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); } };
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const product = { ...SEED_DATABASE.products[0], id: 'P1', deposit_amount: 300, price_total: 1690, is_stock: false, status: 'production' } as Database['products'][number];
const tk = (over: Partial<PreorderTicket>): PreorderTicket => ({ id: 't', ticket_no: 'NR-1', product_id: 'P1', owner_id: 'uA', original_buyer_id: 'uA', qty: 1, deposit_paid: 300, remaining_amount: 1390, remaining_paid: 0, status: 'active', product_status: 'production', qr_code_url: '', created_at: ago(40), approved_at: ago(40), ...over } as PreorderTicket);
const order = (id: string, user: string, items: Order['items'], at = ago(40)): Order => ({ id, user_id: user, total_deposit: items.reduce((s, i) => s + i.deposit_amount, 0), slip_url: '', status: 'approved', created_at: at, approved_at: at, items });
const tr = (over: Partial<TicketTransfer>): TicketTransfer => ({ id: 'tr', ticket_id: 't', from_user_id: 'uA', to_user_id: 'uB', asking_price: 500, status: 'done', listed_at: ago(1), approved_at: ago(1), kind: 'direct', ...over } as TicketTransfer);
const base = (over: Partial<Database>): Database => ({ ...structuredClone(SEED_DATABASE), products: [product], orders: [], tickets: [], remainingPayments: [], transfers: [], pointLedger: [], ...over });

(async () => {
  // ── #2 schema ยังไม่พร้อม = ชั่วคราว ───────────────────────────────────────────────────────
  {
    const drift = ['users: column "shipping_info" does not exist', "ticket_transfers: Could not find the 'cancel_note' column of 'ticket_transfers' in the schema cache", 'x: relation "wallet_codes" does not exist'];
    ok('D1 ขาดคอลัมน์/ตาราง (ยังไม่รัน SQL) = ชั่วคราว ลองใหม่ ไม่ทิ้งงาน', drift.every(isTransientPersistError) && drift.every(isSchemaDriftError), drift.filter((m) => !isTransientPersistError(m)));
    ok('D2 ryuma: ปน schema → ลองใหม่ทั้งก้อน (ส่วน schema จะผ่านเมื่อรัน SQL)', isTransientPersistError('users: ryuma: x | orders: column "y" does not exist'));
    ok('D3 เน็ตหลุดเฉยๆ ไม่ใช่ schema drift (ถอย 5 วิ ไม่ใช่ 30)', !isSchemaDriftError('orders: Failed to fetch') && !isSchemaDriftError('x: ryuma: แต้มไม่พอ'));
    ok('D4 ข้อความภาษาคนตอน schema ยังไม่พร้อม', friendlyPersistError(drift[0]) === 'ร้านกำลังอัปเดตระบบ — จะบันทึกให้เองเมื่อพร้อม');
  }
  // ── #3 Postgres ปฏิเสธค่า / ด่านรุ่นเก่า = ถาวร ───────────────────────────────────────────
  {
    const perm = ['orders: value too long for type character varying(10)', 'preorder_tickets: invalid input value for enum ticket_status: "foo"', 'orders: null value in column "user_id" of relation "orders" violates not-null constraint', 'x: numeric field overflow',
      'sourcing_requests: quote fields are admin-only', 'sourcing_requests: invalid status change', 'sourcing_requests: sourcing requests can only be filed as requested', 'coupon_grants: coupon grants can only be issued by an admin',
      'sourcing_requests: ryuma: ใบเสนอราคาแก้ได้เฉพาะแอดมิน'];
    ok('G1 Postgres ปฏิเสธค่า + ด่านหาของ/คูปองรุ่นเก่า (ไม่มี ryuma:) = ถาวร ไม่วน ไม่บล็อกปุ่มอื่น', perm.every((m) => !isTransientPersistError(m)), perm.filter(isTransientPersistError));
    ok('G2 RLS/FK/ryuma: ยังถาวรเหมือนเดิม', !isTransientPersistError('orders: new row violates row-level security policy for table "orders"') && !isTransientPersistError('x: ryuma: แต้มไม่พอ'));
    ok('G3 ชั่วคราวเดิมยังชั่วคราว (เน็ต/เซิร์ฟเวอร์/ข้อความ adapter ไม่มี session)', ['orders: Failed to fetch', 'persist timed out', 'orders: ยังไม่ได้เข้าสู่ระบบ/กำลังต่ออายุการเข้าสู่ระบบ — จะลองใหม่ให้', 'x: deadlock detected'].every(isTransientPersistError));
    ok('G4 checkout: ข้อความถาวร = "ไม่ได้บันทึก — เหตุผล" (ไม่ใช่ "กำลังลองส่งอัตโนมัติ")', persistFailText('orders: ryuma: แต้มไม่พอ (คงเหลือ 20 แต้ม)', 'RETRY').startsWith('ไม่ได้บันทึก — แต้มไม่พอ') && persistFailText('orders: Failed to fetch', 'RETRY') === 'RETRY');
  }
  // ── #3 store: เหตุผลงานที่ค้าง + ถอยหลังตาม schema drift ────────────────────────────────────
  {
    const seed = base({});
    let mode: 'net' | 'schema' | 'ok' = 'net';
    const adapter = {
      load: async () => structuredClone(seed),
      persist: async () => { if (mode === 'net') throw new Error('orders: Failed to fetch'); if (mode === 'schema') throw new Error('users: column "shipping_info" does not exist'); },
      reset: async () => structuredClone(seed),
    };
    const st = new Store(adapter);
    st.onPersistError = () => undefined;
    await st.init();
    ok('S0 ยังไม่มีงานค้าง → stuckReason null · reloadFailText โทษเน็ตได้', st.stuckReason() === null && st.reloadFailText('ลองใหม่') === 'โหลดสถานะล่าสุดไม่สำเร็จ — เช็คเน็ตแล้วลองใหม่');
    st.update((d) => ({ ...d, users: [...d.users] }));
    const f1 = await st.flush();
    ok('S1 เซฟล้มชั่วคราว → stuckReason = เหตุผลจริง', f1 !== null && st.stuckReason() === 'Failed to fetch', { f1, r: st.stuckReason() });
    const safe = await st.reload({ safe: true });
    ok('S2 reload({safe}) คืน false + ข้อความบอกงานที่ค้างจริง (ไม่ใช่ "เช็คเน็ต" ลอยๆ)', safe === false && st.reloadFailText('ลองใหม่') === 'มีงานก่อนหน้าที่ยังบันทึกไม่ขึ้น (Failed to fetch) — ลองใหม่');
    mode = 'schema';
    const f2 = await st.flush();
    ok('S3 ขาดคอลัมน์: งานยังอยู่ในเครื่อง (ไม่ถูกย้อน) + เหตุผลภาษาคน', f2 !== null && st.getState().users !== seed.users && st.stuckReason() === 'ร้านกำลังอัปเดตระบบ — จะบันทึกให้เองเมื่อพร้อม', { f2, r: st.stuckReason() });
    mode = 'ok';
    const f3 = await st.flush();
    ok('S4 เซฟผ่าน → งานค้างหาย reloadFailText กลับเป็นปกติ', f3 === null && st.stuckReason() === null && (await st.reload({ safe: true })) === true);
  }
  // ── #4 paidByUser: สลิปของตั๋วที่ถูกลบไม่นับ · ใบที่ขายออกไปยังนับ ───────────────────────────
  {
    const o = order('o1', 'uA', [{ id: 'oi1', order_id: 'o1', product_id: 'P1', qty: 1, deposit_amount: 300 }]);
    const deleted = base({ orders: [o], tickets: [], remainingPayments: [
      { id: 'orphan', ticket_id: null as unknown as string, user_id: 'uA', amount: 1390, slip_url: 'https://a', status: 'approved', created_at: ago(2) },
      { id: 'ghost', ticket_id: 't-gone', user_id: 'uA', amount: 500, slip_url: 'https://b', status: 'approved', created_at: ago(2) },
    ] });
    ok('W1 ตั๋วถูกลบ (สลิป ticket_id null / ชี้ใบที่ไม่มี) → ไม่นับว่าจ่ายแล้ว (เดิม 1,890)', paidByUser(deleted, 'uA') === 0, paidByUser(deleted, 'uA'));
    const sold = base({ orders: [o], tickets: [], transfers: [tr({ id: 'd1', ticket_id: 't-oi1', order_item_id: 'oi1' })], remainingPayments: [
      { id: 'mine', ticket_id: 't-oi1', user_id: 'uA', amount: 500, slip_url: 'https://c', status: 'approved', created_at: ago(5) },
    ] });
    ok('W2 เครื่องคนขาย: ใบที่ขายออกไปแล้ว มัดจำ 300 + สลิปที่ตัวเองจ่าย 500 ยังนับครบ', paidByUser(sold, 'uA') === 800, paidByUser(sold, 'uA'));
    const held = base({ orders: [o], tickets: [tk({ id: 't-oi1', remaining_paid: 700 })], remainingPayments: [
      { id: 'own', ticket_id: 't-oi1', user_id: 'uA', amount: 700, slip_url: 'https://d', status: 'approved', created_at: ago(5) },
    ] });
    ok('W3 ใบที่ถือเอง ไม่เปลี่ยนมือ: นับจากตั๋ว (300+700) ไม่นับสลิปซ้ำ', paidByUser(held, 'uA') === 1000, paidByUser(held, 'uA'));
  }

  console.log(`\nround1-audit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0); // store ตั้งตัวจับเวลาลองใหม่ (5/30 วิ) ค้างไว้ — ไม่ต้องรอ
})();
