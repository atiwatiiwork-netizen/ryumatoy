'use client';

import { useState } from 'react';
import { useToast } from '@/state/ToastProvider';
import { checkAvailable } from '@/lib/reserve';
import { store } from '@/data/store';

/**
 * เช็คของ "สดจาก server" ตอนลูกค้ากดที่ตัวสินค้า (เจ้าของ 2026-07-30 — step 2).
 *
 * ทำไมต้องมีทั้งที่หน้าร้านรีเฟรชตอนเข้าแล้ว: เครื่องที่เปิดค้างไว้ถือข้อมูลเก่าได้ถึง ~40 วิ
 * ถ้าเช็คแค่ตอน "เข้าหน้าร้าน" คนที่นั่งดูกริดค้างไว้แล้วเพิ่งมากดตอนของหมดพอดี จะยังเข้าไปได้อยู่ดี
 * → กดทีไรถามใหม่ทุกครั้ง ของหมด = ไม่พาเข้าไปเลย + สั่งดึงข้อมูลใหม่ให้การ์ดเปลี่ยนเป็น "หมด" ทันที
 *
 * ถามไม่ได้ (preview/ออฟไลน์/timeout) → ปล่อยผ่าน (fail-open) เพราะยังมีด่านจองของฝั่ง server
 * กับด่านตอนส่งออเดอร์กันเงินอยู่แล้ว — ห้ามบล็อกคนซื้อเพราะเน็ตกระตุก
 */
export function useLiveStock() {
  const { flash } = useToast();
  const [checking, setChecking] = useState(false);

  /** true = ไปต่อได้ · false = หมดแล้ว (แจ้งลูกค้า + สั่งรีเฟรชให้เรียบร้อยแล้ว) */
  const ensure = async (productId: string, batchId?: string): Promise<boolean> => {
    if (checking) return false; // กดรัว = รอรอบแรกก่อน
    setChecking(true);
    const n = await checkAvailable(productId, batchId);
    setChecking(false);
    if (n == null || n > 0) return true;
    void store.reloadIfIdle(); // ให้การ์ด/ป้ายบนหน้าจอกลายเป็นสถานะจริงทันที
    flash('สินค้าหมดแล้ว — มีคนกดตัดหน้าไปพอดี 🙏 กำลังอัปเดตหน้าจอให้');
    return false;
  };

  return { checking, ensure };
}
