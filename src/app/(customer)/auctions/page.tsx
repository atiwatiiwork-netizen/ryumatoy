'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useAuth } from '@/state/AuthProvider';
import { auctionPublicEnabled, isLive, needsClose, sortedAuctions } from '@/domain/services/auctions';
import { AuctionCard } from '@/components/AuctionRoom';
import { Card } from '@/components/ui';

/**
 * ห้องประมูล (หน้ารวม) — v60.
 * เจ้าของ 2026-07-31: "ยังไม่เปิดให้ใช้ในฝั่งผู้ใช้" → ลูกค้าเห็นหน้า "เร็วๆ นี้"
 * จนกว่าจะเปิดสวิตช์ใน /admin/auctions; แอดมินเข้าดูของจริงได้ตลอดเพื่อทดลอง
 */
export default function AuctionsPage() {
  const db = useDatabase();
  const { isAdmin } = useAuth();
  const open = auctionPublicEnabled(db);

  if (!open && !isAdmin) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-2 p-8 text-center">
          <div className="text-[17px] font-extrabold">ห้องประมูล</div>
          <div className="text-[13px] leading-relaxed text-ink-muted">
            กำลังเตรียมเปิด — เร็วๆ นี้<br />กดกระดิ่งในโปรไฟล์ไว้ จะแจ้งเตือนทันทีที่เปิดรอบแรก
          </div>
          <Link href="/shop" className="mt-2 rounded-lg bg-cta px-5 py-2.5 text-[13.5px] font-bold text-white">ไปดูสินค้าก่อน</Link>
        </div>
      </Card>
    );
  }

  const now = new Date();
  const list = sortedAuctions(db, now).filter((a) => (isAdmin ? true : a.status !== 'draft' && a.status !== 'cancelled'));
  const live = list.filter((a) => isLive(a, now));
  const rest = list.filter((a) => !isLive(a, now));

  return (
    <div className="flex flex-col gap-4">
      {!open && isAdmin && (
        <div className="rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-3 py-2 text-[12px] font-semibold text-[#fbbf24]">
          ยังไม่เปิดให้ลูกค้าเห็น — คุณเห็นหน้านี้เพราะเป็นแอดมิน (เปิดสวิตช์ได้ที่ แอดมิน › ประมูล)
        </div>
      )}

      <div>
        <div className="mb-1 text-[19px] font-extrabold">ห้องประมูล</div>
        <div className="text-[12.5px] text-ink-muted">
          ของในมือ พร้อมส่งทันทีที่ชำระ · เปิดที่ ฿1,000 · ผู้ชนะชำระภายใน 24 ชม.
        </div>
      </div>

      {list.length === 0 && (
        <Card><div className="p-8 text-center text-[13px] text-ink-muted">ยังไม่มีรายการประมูล</div></Card>
      )}

      {live.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="text-[13.5px] font-extrabold">กำลังประมูล · {live.length}</div>
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {live.map((a) => <AuctionCard key={a.id} a={a} href={`/auctions/${a.id}`} />)}
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="text-[13.5px] font-extrabold">รายการอื่น</div>
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {rest.map((a) => (
              <div key={a.id} className="relative">
                <AuctionCard a={a} href={`/auctions/${a.id}`} />
                {needsClose(a, now) && isAdmin && (
                  <span className="absolute right-2 top-2 rounded-full bg-[#fbbf24] px-2 py-0.5 text-[10px] font-extrabold text-black">รอสรุปผล</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
