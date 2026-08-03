import { supabase } from '@/data/supabaseClient';
import type { AuctionBidRow } from '@/domain/entities';

/**
 * สะพานไปหา RPC ประมูล (migration v60).
 *
 * ทำไมทุกอย่างต้องผ่าน server: การประมูลตัดสิน "ใครมาก่อน/ราคาเท่าไหร่/ปิดกี่โมง" ซึ่ง
 * optimistic store ฝั่ง client ทำไม่ได้ — สองคนกดวินาทีเดียวกันจะเขียนทับกันเงียบๆ.
 * ทุก await มีเพดานเวลา (DNA: reserve.ts) — บน resume ที่ socket ตายแล้ว request จะไม่ settle
 * และปุ่มจะค้าง busy ตลอดกาล.
 */
const RPC_TIMEOUT = 10_000;

export type AuctionRes = {
  ok?: boolean;
  error?: string;
  price?: number;
  min?: number;
  ends_at?: string;
  extended?: boolean;
  bid_count?: number;
  extend_count?: number;
  next_min?: number;
  status?: string;
  leading?: boolean;
  won?: boolean;
  winner?: string | null;
  amount?: number;
  server_now?: string;
};

/**
 * true = **ไม่มีฐานข้อมูลให้ต่อเลย** (seed preview / ยังไม่ตั้ง Supabase) → ใช้โหมดทดลองคิดในเครื่องได้
 *
 * ⚠ เดิมรวม `no_rpc` (ฟังก์ชันหาย) ไว้ด้วย ซึ่งอันตรายมาก: บนเครื่องจริงที่ต่อฐานข้อมูลได้
 * แต่ RPC หายชั่วคราว (schema cache ยังไม่รีเฟรชหลังรัน migration / ฟังก์ชันถูกลบ) แอปจะเงียบๆ
 * ตกไปคิดราคาในเครื่องแล้ว **เขียนราคาปลอมทับราคาจริงบน server** — ห้ามเด็ดขาด
 * กรณีนั้นต้องแจ้ง error ตรงๆ ให้คนเห็น (ดู isMissingRpc)
 */
export const isNoServer = (r: AuctionRes) => r.error === 'no_server';

/** ต่อฐานข้อมูลได้ แต่ยังไม่มีฟังก์ชันตัวนั้น = ยังไม่ได้รัน migration → ต้องเตือน ห้าม fallback เงียบ */
export const isMissingRpc = (r: AuctionRes) => r.error === 'no_rpc';

async function call(fn: string, args: Record<string, unknown>): Promise<AuctionRes> {
  if (!supabase) return { error: 'no_server' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { data, error } = await Promise.race([
      supabase.rpc(fn, args),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${fn} timed out`)), RPC_TIMEOUT); }),
    ]);
    if (error) {
      // ฟังก์ชันยังไม่มีในฐานข้อมูล = ยังไม่ได้รัน v60 → บอกให้ UI ไปโหมดทดลอง ไม่ใช่ error แดง
      const missing = /does not exist|could not find/i.test(error.message ?? '') || error.code === 'PGRST202';
      return { error: missing ? 'no_rpc' : (error.message || 'error') };
    }
    return (data ?? { error: 'error' }) as AuctionRes;
  } catch (e) {
    return { error: (e as Error)?.message ?? 'timeout' };
  } finally {
    clearTimeout(timer); // ห้ามปล่อยตัวจับเวลาค้างหลังสำเร็จ
  }
}

/** บิด — server ตรวจสิทธิ์/ขั้นบันได/เวลา แล้วต่อเวลากันสไนป์ให้เอง. */
export const placeBid = (auctionId: string, amount: number) =>
  call('ryuma_place_bid', { p_auction_id: auctionId, p_amount: amount });

/** ซื้อเลย — ปิดห้องทันทีและตั้งผู้ชนะ. */
export const buyNow = (auctionId: string) =>
  call('ryuma_auction_buynow', { p_auction_id: auctionId });

/** ปิด + สรุปผล (แอดมินกด; ลูกค้าเรียกได้เฉพาะเมื่อเลยเวลาปิดแล้ว). */
export const closeAuction = (auctionId: string) =>
  call('ryuma_auction_close', { p_auction_id: auctionId });

/** ลูกค้าขอให้แอดมินยกเลิกบิดที่พิมพ์ผิด (ถอนเองไม่ได้ตามกติกา) — แตะได้แค่ 2 ช่องผ่าน RPC. */
export const requestBidCancel = (bidId: string, reason: string) =>
  call('ryuma_request_bid_cancel', { p_bid_id: bidId, p_reason: reason });

/** สถานะสด — หน้าห้องเรียกทุกไม่กี่วินาที (ถูกกว่าโหลดทั้งฐานข้อมูลใหม่). */
export const auctionState = (auctionId: string) =>
  call('ryuma_auction_state', { p_auction_id: auctionId });

/** ประวัติบิดที่ปิดชื่อแล้ว — ลูกค้าเห็นครบทุกบรรทัดแต่เป็น "ผู้ประมูล #N", แอดมินเห็นชื่อจริง. */
export async function auctionBids(auctionId: string): Promise<AuctionBidRow[] | null> {
  if (!supabase) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { data, error } = await Promise.race([
      supabase.rpc('ryuma_auction_bids', { p_auction_id: auctionId }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('bids timed out')), RPC_TIMEOUT); }),
    ]);
    if (error || !Array.isArray(data)) return null;
    return data as AuctionBidRow[];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
