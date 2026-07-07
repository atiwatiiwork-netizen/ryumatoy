'use client';

import { useCurrentUserId } from '@/state/AuthProvider';
import { useSmartBack } from '@/lib/nav';
import { BackBar } from '@/components/ui';
import { MyCoupons } from '@/components/CouponTicket';

export default function MyCouponsPage() {
  const uid = useCurrentUserId();
  const goBack = useSmartBack('/profile');
  return (
    <div className="mx-auto max-w-[560px]">
      <BackBar title="คูปองของฉัน" onBack={goBack} />
      <MyCoupons uid={uid} />
    </div>
  );
}
