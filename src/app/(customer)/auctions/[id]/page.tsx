'use client';

import { useParams } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useAuth } from '@/state/AuthProvider';
import { auctionPublicEnabled } from '@/domain/services/auctions';
import { AuctionRoom } from '@/components/AuctionRoom';
import { useSmartBack } from '@/lib/nav';
import { BackBar, Card } from '@/components/ui';

/** ห้องประมูลรายชิ้น (v60) — UI ตัวเดียวกับที่แอดมินเห็นในแท็บพรีวิว */
export default function AuctionDetailPage() {
  const params = useParams<{ id: string }>();
  const db = useDatabase();
  const { isAdmin } = useAuth();
  const back = useSmartBack('/auctions');

  if (!auctionPublicEnabled(db) && !isAdmin) {
    return (
      <div className="flex flex-col gap-3">
        <BackBar title="ห้องประมูล" onBack={back} />
        <Card><div className="p-8 text-center text-[13px] text-ink-muted">ห้องประมูลกำลังเตรียมเปิด — เร็วๆ นี้</div></Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <BackBar title="ห้องประมูล" onBack={back} />
      <AuctionRoom auctionId={params.id} />
    </div>
  );
}
