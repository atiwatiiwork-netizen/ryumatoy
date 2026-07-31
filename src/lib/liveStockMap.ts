'use client';

import { useEffect, useState } from 'react';
import { checkAvailable } from '@/lib/reserve';

/**
 * ของเหลือ "จริงจาก server" ของหลายรายการพร้อมกัน — ใช้กับกริดการ์ดในหน้าร้าน
 *
 * ทำไมต้องมี (audit 2026-07-30, ต้นตอที่เจ้าของเจอ "แอดมินเห็นหมด ลูกค้าเห็นไม่หมด"):
 * RLS ของ preorder_tickets ให้ลูกค้าอ่านได้เฉพาะ "ตั๋วของตัวเอง" (migration_rls_v21.sql:91)
 * → สูตรฝั่ง client (batchAvailable = สต๊อก − ตั๋วที่ขาย − hold) มองไม่เห็นตั๋วของคนอื่นเลย
 * → รอบที่ขายหมดแล้ว เครื่องลูกค้ายังคำนวณว่า "ยังมีของ" ตลอดไป การ์ดจึงโชว์ราคาชวนกด
 * ตัว hold มองเห็นได้ (sr_read using(true)) เลยเห็นแค่ "หมดชั่วคราว" ตอนมีคนถือ แต่พอเป็นตั๋วจริงแล้วมองไม่เห็น
 *
 * RPC ryuma_available เป็น SECURITY DEFINER (ข้าม RLS) จึงเป็นตัวเลขเดียวที่เชื่อได้ฝั่งลูกค้า
 * ถามไม่ได้ (preview/ออฟไลน์) → คืน map ว่าง แล้วผู้เรียกใช้เลข local ตามเดิม
 *
 * เพดาน: ถามไม่เกิน MAX รายการต่อรอบ และถามซ้ำเป็นจังหวะเฉพาะตอนแท็บ visible
 */
const MAX_ASK = 24;      // การ์ดที่เห็นจริงบนจอรอบแรก ๆ ก็ประมาณนี้
const REFRESH_MS = 40_000; // ให้ตรงจังหวะกับ poll ของ DataProvider จะได้ไม่เถียงกัน

export interface LiveItem { key: string; productId: string; batchId?: string }

export function useLiveStockMap(items: LiveItem[]): Record<string, number> {
  const [map, setMap] = useState<Record<string, number>>({});
  // ผูก effect กับ "รายการที่จะถาม" เป็นสตริง ไม่ใช่ตัว array (สร้างใหม่ทุก render)
  const sig = items.slice(0, MAX_ASK).map((i) => `${i.productId}|${i.batchId ?? ''}`).join(',');

  useEffect(() => {
    if (!sig) { setMap({}); return; }
    let dead = false;
    const list = sig.split(',').map((s) => { const [productId, batchId] = s.split('|'); return { productId, batchId: batchId || undefined }; });
    const ask = async () => {
      const pairs = await Promise.all(list.map(async (it) => {
        const n = await checkAvailable(it.productId, it.batchId);
        return [`${it.productId}|${it.batchId ?? ''}`, n] as const;
      }));
      if (dead) return;
      const next: Record<string, number> = {};
      for (const [k, n] of pairs) if (n != null) next[k] = n;
      setMap(next);
    };
    void ask();
    const tick = setInterval(() => { if (document.visibilityState === 'visible') void ask(); }, REFRESH_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void ask(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      dead = true;
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [sig]);

  return map;
}

/** คีย์เดียวกับที่ useLiveStockMap ใช้ — ให้การ์ดหยิบเลขของตัวเองออกมา */
export const liveKey = (productId: string, batchId?: string) => `${productId}|${batchId ?? ''}`;
