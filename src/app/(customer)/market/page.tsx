'use client';

import { MarketBoard } from '@/components/market/MarketBoard';
import { MarketGate } from './MarketGate';

/** ตลาดใบพรี (กระดาน) — เนื้อหาอยู่ใน MarketBoard ตัวเดียวกับพรีวิวแอดมิน (DNA shared preview) */
export default function MarketPage() {
  return (
    <MarketGate>
      <div className="mx-auto max-w-[640px]"><MarketBoard mode="live" /></div>
    </MarketGate>
  );
}
