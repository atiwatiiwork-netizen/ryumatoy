'use client';

import { useEffect, useState } from 'react';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { couponTier, usableGrantsFor } from '@/domain/services/coupons';
import type { CouponTier } from '@/domain/services/coupons';
import type { Coupon } from '@/domain/entities';
import { cx } from './ui';

const SCOPE_LABEL: Record<string, string> = { preorder: 'พรีออเดอร์', instock: 'พร้อมส่ง', both: 'พรี & พร้อมส่ง' };

type TierMeta = { label: string; grad: string; ink: string; subInk: string; star: string; glow: string; ring: string; stars: number };
export const TIER_META: Record<CouponTier, TierMeta> = {
  basic: {
    label: 'BASIC', grad: 'linear-gradient(135deg,#6b4a24 0%,#caa057 50%,#5a3e1e 100%)',
    ink: '#fff7e8', subInk: '#ecd6ab', star: '#fff2d6', glow: 'rgba(201,154,78,.55)', ring: '#e9c987', stars: 3,
  },
  premium: {
    label: 'PREMIUM', grad: 'linear-gradient(135deg,#5c0d18 0%,#e0374b 52%,#4a0a14 100%)',
    ink: '#ffffff', subInk: '#f6c2c8', star: '#fff0f2', glow: 'rgba(224,55,75,.6)', ring: '#f6c9cf', stars: 4,
  },
  ultimate: {
    label: 'ULTIMATE', grad: 'linear-gradient(135deg,#9fc3ea 0%,#eef6ff 45%,#7fa8d8 100%)',
    ink: '#0c2c4d', subInk: '#2f6ba0', star: '#1f5c96', glow: 'rgba(150,196,236,.8)', ring: '#ffffff', stars: 5,
  },
};

const Star = ({ s, fill }: { s: number; fill: string }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill={fill}><path d="M12 2l3 6.9 7.5.6-5.7 4.9 1.8 7.3L12 17.8 5.1 21.7l1.8-7.3L1.2 9.5 8.7 8.9z" /></svg>
);

type Size = 'sm' | 'md' | 'lg';
const DIM: Record<Size, { pad: string; val: string; label: string; sub: string; stub: string; star: number }> = {
  sm: { pad: 'py-2.5 pl-3.5 pr-2', val: 'text-[22px]', label: 'text-[11px] tracking-[2px]', sub: 'text-[10px]', stub: 'w-[56px]', star: 10 },
  md: { pad: 'py-3.5 pl-4 pr-2.5', val: 'text-[32px]', label: 'text-[13px] tracking-[3px]', sub: 'text-[11.5px]', stub: 'w-[70px]', star: 12 },
  lg: { pad: 'py-5 pl-6 pr-3', val: 'text-[46px]', label: 'text-[17px] tracking-[4px]', sub: 'text-[13px]', stub: 'w-[92px]', star: 15 },
};

/** The animated tiered coupon ticket — shine sweep + sparkles + tier glow. */
export function CouponTicket({ coupon, size = 'md', muted = false, className }: { coupon: Coupon; size?: Size; muted?: boolean; className?: string }) {
  const db = useDatabase();
  const tier = couponTier(coupon.value);
  const m = TIER_META[tier];
  const d = DIM[size];
  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '');
  // what the coupon is locked to — maker name takes priority (ค่าย), then a specific product, else its scope
  const scopeText = SCOPE_LABEL[coupon.scope] ?? coupon.scope;
  const target = coupon.target_maker_id
    ? `เฉพาะค่าย ${db.manufacturers.find((x) => x.id === coupon.target_maker_id)?.name ?? ''}`.trim()
    : coupon.target_product_id
      ? `เฉพาะ ${db.products.find((p) => p.id === coupon.target_product_id)?.series_name ?? 'รุ่นนี้'}`
      : `ใช้กับ ${scopeText}`;

  return (
    <div
      className={cx('relative overflow-hidden rounded-2xl', muted && 'opacity-55 grayscale', className)}
      style={{ background: m.grad, boxShadow: `0 12px 34px -12px ${m.glow}, inset 0 0 0 1.5px ${m.ring}` }}
    >
      {/* shine sweep */}
      {!muted && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-y-0 left-0 w-1/3 animate-couponShine bg-gradient-to-r from-transparent via-white/45 to-transparent" />
        </div>
      )}
      {/* sparkles (md/lg) */}
      {!muted && size !== 'sm' && (
        <div className="pointer-events-none absolute inset-0">
          {[[8, 14, 0], [72, 10, .6], [40, 78, 1.1], [88, 64, .3]].map(([l, t, delay], i) => (
            <div key={i} className="absolute animate-twinkle" style={{ left: `${l}%`, top: `${t}%`, animationDelay: `${delay}s` }}>
              <Star s={d.star} fill={m.star} />
            </div>
          ))}
        </div>
      )}

      <div className="relative flex items-stretch">
        <div className={cx('min-w-0 flex-1', d.pad)}>
          <div className={cx('font-black leading-none', d.val)} style={{ color: m.ink, textShadow: tier === 'ultimate' ? 'none' : '0 1px 2px rgba(0,0,0,.35)' }}>
            ลด {baht(coupon.value)}
          </div>
          <div className={cx('mt-1.5 font-extrabold', d.label)} style={{ color: m.ink }}>{m.label}</div>
          <div className={cx('mt-1 truncate font-semibold', d.sub)} style={{ color: m.subInk }}>
            {target}{coupon.expires_at ? ` · ถึง ${fmt(coupon.expires_at)}` : ''}
          </div>
        </div>

        {/* perforated stub */}
        <div className={cx('relative flex flex-col items-center justify-center gap-1', d.stub)} style={{ borderLeft: `2px dashed ${tier === 'ultimate' ? 'rgba(12,44,77,.3)' : 'rgba(0,0,0,.28)'}` }}>
          <div className="absolute -top-2 -left-2 h-4 w-4 rounded-full bg-base" />
          <div className="absolute -bottom-2 -left-2 h-4 w-4 rounded-full bg-base" />
          {Array.from({ length: m.stars }).map((_, i) => <Star key={i} s={d.star} fill={m.star} />)}
        </div>
      </div>
    </div>
  );
}

/** Full-screen celebratory popup that fires ONCE per newly-received coupon (localStorage seen-set,
 *  no migration). Mounted in CustomerShell. */
export function CouponReceived() {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const key = `ryuma_coupon_seen_${uid}`;
  const [seen, setSeen] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try { setSeen(JSON.parse(localStorage.getItem(key) || '[]')); } catch { setSeen([]); }
    setReady(true);
  }, [key]);

  if (!ready || !uid) return null;
  const unseen = usableGrantsFor(db, uid).filter((x) => !seen.includes(x.grant.id));
  if (!unseen.length) return null;
  const { grant, coupon } = unseen[0];

  const dismiss = () => {
    const next = [...seen, grant.id];
    setSeen(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode */ }
  };

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/75 p-6" onClick={dismiss}>
      <div className="w-full max-w-[380px] text-center" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-[13px] font-semibold text-ink-muted2">🎉 คุณได้รับคูปองส่วนลด!</div>
        <div className="mb-4 text-2xl font-extrabold text-ink">เย่! ใช้ได้เลย</div>
        <div className="animate-couponPop">
          <CouponTicket coupon={coupon} size="lg" />
        </div>
        <button onClick={dismiss} className="mt-6 w-full rounded-xl bg-cta py-3 text-sm font-bold text-white">เก็บไว้ในกระเป๋า</button>
        <div className="mt-2 text-[11.5px] text-ink-faint">ดูคูปองทั้งหมดได้ที่ “คูปองของฉัน”</div>
      </div>
    </div>
  );
}

/** A tiny tier color dot + label — for admin lists / compact contexts. */
export function CouponTierPill({ value }: { value: number }) {
  const m = TIER_META[couponTier(value)];
  return <span className="rounded-md px-2 py-0.5 text-[10.5px] font-extrabold" style={{ background: m.grad, color: m.ink, boxShadow: `inset 0 0 0 1px ${m.ring}` }}>{m.label}</span>;
}
