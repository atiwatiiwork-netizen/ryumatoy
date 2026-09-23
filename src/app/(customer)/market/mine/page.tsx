'use client';

import { useSmartBack } from '@/lib/nav';
import { BackBar } from '@/components/ui';
import { MyDeals } from '@/components/market/MyDeals';
import { MarketGate } from '../MarketGate';

/** ซื้อขายของฉัน — ต้องทำ / กำลังดำเนินการ / ลงขายอยู่ / ประวัติ */
export default function MyMarketPage() {
  const goBack = useSmartBack('/market');
  return (
    <MarketGate>
      <div className="mx-auto max-w-[640px]">
        <BackBar title="ซื้อขายของฉัน" onBack={goBack} />
        <MyDeals />
      </div>
    </MarketGate>
  );
}
