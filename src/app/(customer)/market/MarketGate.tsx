'use client';

import type { ReactNode } from 'react';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { marketVisibleTo } from '@/domain/services/market';

/** ตลาดยังปิด (เจ้าของ 2026-09-23: "อย่าเพิ่งให้ลูกค้าเห็น") → ลูกค้าเห็นแค่ "เร็วๆ นี้" ไม่มีรายละเอียดใดๆ
 *  แอดมินผ่านเข้าไปลองเล่นได้ · ด่านจริงอยู่ฝั่ง server (ryuma_market_open v72) หน้านี้แค่ซ่อน */
export function MarketGate({ children }: { children: ReactNode }) {
  const db = useDatabase();
  const uid = useCurrentUserId();
  if (!marketVisibleTo(db, uid)) {
    return (
      <div className="mx-auto max-w-[560px] pt-6">
        <div className="rounded-2xl border border-subtle bg-surface-2 p-8 text-center">
          <div className="text-3xl">🎟️</div>
          <div className="mt-2 text-[16px] font-extrabold">เร็วๆ นี้</div>
          <div className="mt-1 text-[12.5px] text-ink-muted2">กำลังเตรียมเปิด</div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
