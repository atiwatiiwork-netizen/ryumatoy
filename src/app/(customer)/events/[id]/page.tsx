'use client';

import { use } from 'react';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { EventProgress } from '@/components/EventBits';
import { campaignLive, qualifyingCount, sortedTiers } from '@/domain/services/campaigns';
import type { CouponScope } from '@/domain/entities';

const SCOPE_LABEL: Record<CouponScope, string> = { both: 'ใช้ได้ทั้งพรี + พร้อมส่ง', preorder: 'ใช้กับพรีออเดอร์', instock: 'ใช้กับสินค้าพร้อมส่ง' };
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });

export default function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const db = useDatabase();
  const uid = useCurrentUserId();
  const c = db.campaigns.find((x) => x.id === id);
  if (!c) return <div className="p-10 text-center text-ink-faint">ไม่พบกิจกรรมนี้</div>;

  const live = campaignLive(c);
  const count = uid ? qualifyingCount(db, c, uid) : 0;
  const tiers = sortedTiers(c);
  const makerName = c.target_maker_id ? db.manufacturers.find((m) => m.id === c.target_maker_id)?.name : undefined;

  return (
    <div className="mx-auto max-w-[560px]">
      {c.banner_url && <img src={c.banner_url} alt={c.name} className="mb-4 block w-full rounded-2xl border border-subtle" />}

      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-xl font-extrabold">{c.name}</h1>
        {live
          ? <span className="rounded-full bg-[#16a34a]/[0.16] px-2 py-0.5 text-[11px] font-bold text-[#4ade80]">กำลังจัด</span>
          : <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-bold text-ink-faint">จบแล้ว</span>}
      </div>
      <div className="mb-4 text-[12.5px] text-ink-faint">{fmtDate(c.starts_at)} – {fmtDate(c.ends_at)}</div>

      {c.product_blurb && <p className="mb-4 rounded-xl border border-subtle bg-surface-2 p-3.5 text-[13.5px] leading-relaxed text-ink-muted">{c.product_blurb}</p>}

      {/* my progress */}
      {live && <div className="mb-5"><EventProgress variant="card" /></div>}

      {/* reward tiers */}
      <div className="mb-2 text-[13px] font-bold text-ink-muted">ยิ่งพรีเยอะ ยิ่งได้เยอะ</div>
      <div className="flex flex-col gap-2.5">
        {tiers.map(({ tier, index }) => {
          const hit = count >= tier.threshold;
          return (
            <div key={index} className={`flex items-center gap-3 rounded-2xl border p-4 ${hit ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.08]' : 'border-subtle bg-surface-2'}`}>
              <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-[15px] font-extrabold ${hit ? 'bg-[#16a34a] text-white' : 'bg-surface-3 text-ink-muted2'}`}>
                {hit ? <Icon name="check" size={20} /> : tier.threshold}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-bold text-ink">พรีครบ {tier.threshold} รายการ</div>
                <div className="text-[12.5px] text-primary-soft">รับคูปอง {baht(tier.coupon_value)} × {tier.coupon_count} ใบ</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* rules */}
      <div className="mt-5 rounded-2xl border border-subtle bg-surface-2 p-4 text-[12.5px] leading-relaxed text-ink-muted2">
        <div className="mb-1.5 font-bold text-ink">กติกา</div>
        <ul className="list-inside list-disc space-y-1">
          <li>นับเฉพาะ “ใบพรี” ที่แอดมินอนุมัติแล้ว ในช่วงเวลากิจกรรม (1 ใบ = 1 รายการ)</li>
          <li>สะสมครบชั้นไหน รับครบชั้นนั้น — ครบชั้นสูงได้ของชั้นต่ำด้วย และวนสะสมใหม่ได้เรื่อยๆ</li>
          <li>คูปองแจกอัตโนมัติเข้า “คูปองของฉัน” เมื่อแอดมินอนุมัติใบพรี</li>
          <li>{SCOPE_LABEL[c.reward_scope]}{makerName ? ` · เฉพาะค่าย ${makerName}` : ''} · คูปองมีอายุ {c.reward_expiry_days} วันหลังได้รับ</li>
        </ul>
      </div>
    </div>
  );
}
