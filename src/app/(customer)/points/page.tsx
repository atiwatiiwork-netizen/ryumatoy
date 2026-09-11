'use client';

import { useCurrentUserId } from '@/state/AuthProvider';
import { BackBar } from '@/components/ui';
import { useSmartBack } from '@/lib/nav';
import { PointsPanel } from '@/components/PointsPanel';

/**
 * คะแนนสะสมของฉัน (ryuma-points-spec เฟส 1 "ได้คะแนน")
 * เนื้อหาทั้งหมดอยู่ใน <PointsPanel> — คอมโพเนนต์เดียวกับ "พรีวิวหน้าลูกค้า" ใน /admin/points
 * (เจ้าของ 2026-09-12: แก้ฝั่งลูกค้าแล้วพรีวิวแอดมินต้องเปลี่ยนตาม → ต้องเป็นตัวเดียวกัน ห้ามก๊อปปี้)
 */
export default function PointsPage() {
  const uid = useCurrentUserId();
  const goBack = useSmartBack('/profile');
  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="คะแนนสะสม" onBack={goBack} />
      <PointsPanel userId={uid} mode="live" />
    </div>
  );
}
