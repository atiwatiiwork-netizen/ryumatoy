'use client';

import { useDatabase } from '@/state/DataProvider';
import { AuthScreen } from './AuthScreen';

/** Members-only gate for anonymous visitors. They see just the shop's first banner and the
 *  login/signup form — the catalog, prices, and everything else stay hidden until they join.
 *  (Keeps casual scraping + competitor snooping out; real API-level locking is done in RLS.) */
export function PublicLanding() {
  const db = useDatabase();
  const banner = (db.settings.announcements ?? [])[0];

  return (
    <div className="min-h-screen bg-base">
      <div className="mx-auto max-w-[440px] px-4 pb-12 pt-6">
        {/* first announcement banner (natural ratio, no crop) */}
        {banner?.image_url && (
          <div className="mb-3 overflow-hidden rounded-2xl border border-subtle">
            <img src={banner.image_url} alt={banner.caption ?? ''} className="block h-auto w-full" />
          </div>
        )}

        {/* login / signup (has its own logo + title) */}
        <AuthScreen />

        <div className="mt-2 text-center text-[11.5px] leading-relaxed text-ink-faint">
          ร้านสำหรับสมาชิกเท่านั้น · สมัครสมาชิกเพื่อดูสินค้า ราคา และสั่งพรีทั้งหมด
        </div>
      </div>
    </div>
  );
}
