'use client';

import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useSmartBack } from '@/lib/nav';
import { BackBar } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { CouponTicket } from '@/components/CouponTicket';
import { usableGrantsFor, couponExpired } from '@/domain/services/coupons';

export default function MyCouponsPage() {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const goBack = useSmartBack('/profile');

  const usable = usableGrantsFor(db, uid);
  const usableIds = new Set(usable.map((x) => x.grant.id));
  const past = db.couponGrants
    .filter((g) => g.user_id === uid && !usableIds.has(g.id))
    .map((g) => ({ grant: g, coupon: db.coupons.find((c) => c.id === g.coupon_id) }))
    .filter((x): x is { grant: typeof x.grant; coupon: NonNullable<typeof x.coupon> } => !!x.coupon)
    .sort((a, b) => (b.grant.granted_at ?? '').localeCompare(a.grant.granted_at ?? ''));

  const pastLabel = (g: (typeof past)[number]) => {
    if (g.grant.status === 'used') return 'ใช้ไปแล้ว';
    if (g.grant.status === 'revoked') return 'ถูกยกเลิก';
    if (couponExpired(g.coupon)) return 'หมดอายุ';
    return 'ใช้ไม่ได้';
  };

  return (
    <div className="mx-auto max-w-[560px]">
      <BackBar title="คูปองของฉัน" onBack={goBack} />

      <div className="mb-4 flex items-center gap-2 rounded-xl border border-[#8b5cf6]/25 bg-[#8b5cf6]/[0.06] px-3.5 py-2.5 text-[12px] text-[#c4b5fd]">
        <Icon name="tag" size={16} /> พรีออเดอร์ → ใช้ตอนจ่ายยอดสุดท้าย · พร้อมส่ง → ใช้ตอนสั่งซื้อ
      </div>

      {usable.length > 0 && (
        <div className="mb-6">
          <div className="mb-2.5 text-[13px] font-bold text-ink-muted2">ใช้ได้ ({usable.length})</div>
          <div className="flex flex-col gap-3">
            {usable.map((x) => <CouponTicket key={x.grant.id} coupon={x.coupon} size="md" />)}
          </div>
        </div>
      )}

      {usable.length === 0 && (
        <div className="mb-6 rounded-2xl border border-subtle bg-surface-2 py-14 text-center text-ink-faint">
          <Icon name="tag" size={40} className="mx-auto mb-3 text-ink-faint" />
          <div className="text-[15px]">ยังไม่มีคูปองที่ใช้ได้</div>
          <div className="mt-1 text-[12.5px]">แอดมินจะมอบคูปองส่วนลดให้เป็นพิเศษ ✨</div>
        </div>
      )}

      {past.length > 0 && (
        <div>
          <div className="mb-2.5 text-[13px] font-bold text-ink-faint">ประวัติ ({past.length})</div>
          <div className="flex flex-col gap-2.5">
            {past.map((x) => (
              <div key={x.grant.id} className="relative">
                <CouponTicket coupon={x.coupon} size="sm" muted />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-black/55 px-2 py-1 text-[10.5px] font-bold text-white">{pastLabel(x)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
