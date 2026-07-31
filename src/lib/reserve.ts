import { supabase } from '@/data/supabaseClient';

type Res = { ok?: boolean; error?: string; reservation_id?: string; until?: string; available?: number };

// DNA: ทุก await ที่วิ่งเน็ตต้องมีเพดานเวลา. ตรงนี้เคยไม่มี → บน resume ที่ socket ตายแล้ว
// request ไม่ settle เลย → ปุ่ม "ส่งคำขอ" ค้าง busy ตลอดกาลหลังลูกค้าโอนเงินไปแล้ว
// และร้ายกว่านั้น: ลูป reserveStock ค้างที่บรรทัดแรก แต่ started.current เป็น true ไปแล้ว
// → resIds ว่าง, soldOut/expired ไม่เคยเป็น true → ออเดอร์ผ่านโดย "ไม่มีการกันสต๊อกเลย" = ขายเกิน
// (audit persist #5). timeout → คืน error ปกติ → UI เดินต่อและแจ้งลูกค้าได้
const RPC_TIMEOUT = 12_000;

async function call(fn: string, args: Record<string, unknown>): Promise<Res> {
  if (!supabase) return { error: 'no_server' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { data, error } = await Promise.race([
      supabase.rpc(fn, args),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${fn} timed out`)), RPC_TIMEOUT); }),
    ]);
    return (data ?? { error: error?.message ?? 'error' }) as Res;
  } catch (e) {
    return { error: (e as Error)?.message ?? 'timeout' };
  } finally {
    clearTimeout(timer); // ห้ามปล่อยตัวจับเวลาค้างหลังสำเร็จ (audit regression #9)
  }
}

/** Reserve `qty` of an in-stock product/batch for 15 min (atomic, oversell-proof). */
export const reserveStock = (productId: string, batchId: string | undefined, qty: number, userId: string) =>
  call('ryuma_reserve', { p_product_id: productId, p_batch_id: batchId ?? '', p_qty: qty, p_user_id: userId, p_ttl: 900 });

/** จำนวนที่ซื้อได้ "ตอนนี้จริง" จาก server (สูตรเดียวกับตอนจอง — สต๊อก − ตั๋ว − hold ค้าง).
 *  ใช้เช็คสดตอนลูกค้าเข้าหน้าซื้อ (เจ้าของ 2026-07-30: เครื่องที่เปิดค้างถือข้อมูลเก่า เห็นของ
 *  ที่หมดแล้วว่ายังอยู่). คืน null เมื่อถามไม่ได้ (preview/ออฟไลน์/timeout) → ใช้ค่า local ตามเดิม.
 *  RPC คืนเลขเปล่าๆ ไม่ใช่ object เลยไม่ผ่าน call(). */
export const checkAvailable = async (productId: string, batchId?: string): Promise<number | null> => {
  if (!supabase) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { data, error } = await Promise.race([
      supabase.rpc('ryuma_available', { p_product_id: productId, p_batch_id: batchId ?? '' }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('avail timeout')), RPC_TIMEOUT); }),
    ]);
    return error != null || typeof data !== 'number' ? null : data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Slip submitted → stop the 15-min timer (hold until admin decides). */
export const payReservation = (id: string) => call('ryuma_reserve_pay', { p_id: id });
/** Admin approved → convert hold to a real sale. */
export const confirmReservation = (id: string) => call('ryuma_reserve_confirm', { p_id: id });
/** Admin rejected / cancelled → return the stock. */
export const releaseReservation = (id: string) => call('ryuma_reserve_release', { p_id: id });
