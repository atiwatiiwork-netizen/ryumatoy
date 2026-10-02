'use client';

import { useParams } from 'next/navigation';
import { useSmartBack } from '@/lib/nav';
import { MarketDeal } from '@/components/market/MarketDeal';
import { MarketGate } from '../MarketGate';

/** ดีล 1 รายการ — คนทั่วไป/ผู้ซื้อ/คนขาย เห็นมุมของตัวเอง (MarketDeal) · ดีลตรง (v73) ใช้หน้าเดียวกัน */
export default function MarketDealPage() {
  const { id } = useParams<{ id: string }>();
  const goBack = useSmartBack('/market/mine');
  return (
    <MarketGate allowDirect>
      <MarketDeal id={decodeURIComponent(id)} mode="live" onBack={goBack} />
    </MarketGate>
  );
}
