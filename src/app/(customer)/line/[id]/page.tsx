'use client';

import { useParams } from 'next/navigation';
import { useDatabase, useReady } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useSmartBack } from '@/lib/nav';
import { lineVisibleTo } from '@/domain/services/lines';
import { BackBar } from '@/components/ui';
import { LineView } from '@/components/lines/LineView';

/**
 * หน้าไลน์ (พรียกไลน์ · v81) — เนื้อหาอยู่ใน LineView ตัวเดียวกับพรีวิวแอดมิน (DNA shared preview)
 * ยังไม่เปิดให้ลูกค้า (สวิตช์ปิด/ไลน์ร่าง) = "ไม่พบหน้านี้" เฉยๆ ไม่มีป้าย "เร็วๆ นี้" (เจ้าของ: ห้ามให้ลูกค้าเห็นก่อน)
 * render แรกของแอปเป็นข้อมูล seed เสมอ → ต้องรอ useReady ก่อนตัดสินว่า "ไม่พบ"
 */
export default function LinePage() {
  const { id } = useParams<{ id: string }>();
  const db = useDatabase();
  const ready = useReady();
  const uid = useCurrentUserId();
  const goBack = useSmartBack('/shop');
  const line = db.productLines.find((l) => l.id === id);

  if (!ready) return <div className="py-16 text-center text-ink-faint">กำลังโหลด…</div>;
  if (!line || !lineVisibleTo(db, uid, line)) {
    return (
      <div className="mx-auto max-w-[640px]">
        <BackBar title="ไม่พบหน้านี้" onBack={goBack} />
        <div className="py-12 text-center text-ink-faint">ไม่พบหน้านี้</div>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="ไลน์" onBack={goBack} />
      <LineView line={line} userId={uid} mode="live" />
    </div>
  );
}
