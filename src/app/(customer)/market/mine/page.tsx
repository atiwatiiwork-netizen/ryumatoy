'use client';

import { useSmartBack } from '@/lib/nav';
import { BackBar } from '@/components/ui';
import { MyDeals } from '@/components/market/MyDeals';
import { MarketGate } from '../MarketGate';

/** ซื้อขาย/เปลี่ยนใบของฉัน — ต้องทำ / กำลังดำเนินการ / ลงขายอยู่ / ประวัติ (รวมดีลตรง v73) */
export default function MyMarketPage() {
  const goBack = useSmartBack('/profile');
  return (
    <MarketGate allowDirect>
      <div className="mx-auto max-w-[640px]">
        <BackBar title="ซื้อขาย / เปลี่ยนใบของฉัน" onBack={goBack} />
        <MyDeals />
      </div>
    </MarketGate>
  );
}
