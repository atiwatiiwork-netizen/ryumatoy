'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { RANK } from '@/lib/theme';
import type { RankKey } from '@/lib/theme';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { RANK_ORDER } from '@/domain/services/ranks';
import { grantStats } from '@/domain/services/coupons';
import { CouponTierPill } from '@/components/CouponTicket';
import { createCoupon, updateCoupon, deleteCoupon, grantCoupon, grantCouponToRank, revokeGrant } from '@/data/mutations';
import type { Coupon, CouponScope, RankName } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const SCOPES: { key: CouponScope; label: string }[] = [
  { key: 'preorder', label: 'พรีออเดอร์' },
  { key: 'instock', label: 'พร้อมส่ง' },
  { key: 'both', label: 'ทั้งคู่' },
];
const scopeLabel = (s: CouponScope) => SCOPES.find((x) => x.key === s)?.label ?? s;
const scopeCls: Record<CouponScope, string> = {
  preorder: 'bg-[#16a34a]/[0.14] text-[#4ade80]',
  instock: 'bg-[#2563eb]/[0.14] text-[#60a5fa]',
  both: 'bg-[#8b5cf6]/[0.14] text-[#c4b5fd]',
};
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

export default function AdminCouponsPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">คูปองส่วนลด</div>
      <div className="mb-5 text-[13px] text-ink-faint">สร้างคูปอง (ลดเป็นบาท) · มอบให้ลูกค้า · ติดตามใครได้/ใครใช้</div>

      <CreateForm />

      <div className="flex flex-col gap-3">
        {db.coupons.length === 0 ? (
          <div className="rounded-2xl border border-subtle bg-surface-2 p-6 text-center text-[13px] text-ink-faint">ยังไม่มีคูปอง — สร้างด้านบน</div>
        ) : (
          [...db.coupons].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).map((c) => (
            <CouponCard key={c.id} coupon={c} />
          ))
        )}
      </div>
    </div>
  );

  function CreateForm() {
    const [label, setLabel] = useState('');
    const [value, setValue] = useState('');
    const [scope, setScope] = useState<CouponScope>('both');
    const [targetKind, setTargetKind] = useState<'none' | 'product' | 'maker'>('none');
    const [targetProduct, setTargetProduct] = useState('');
    const [targetMaker, setTargetMaker] = useState('');
    const [expires, setExpires] = useState('');

    const submit = () => {
      const v = Number(value) || 0;
      if (!label.trim() || v <= 0) { flash('กรอกชื่อคูปอง + จำนวนเงิน'); return; }
      if (targetKind === 'product' && !targetProduct) { flash('เลือกสินค้าที่จะเจาะจง หรือเปลี่ยนเป็น "ทุกสินค้า"'); return; }
      if (targetKind === 'maker' && !targetMaker) { flash('เลือกค่ายที่จะเจาะจง หรือเปลี่ยนเป็น "ทุกสินค้า"'); return; }
      dispatch(createCoupon({
        label: label.trim(),
        value: v,
        scope,
        target_product_id: targetKind === 'product' ? targetProduct || undefined : undefined,
        target_maker_id: targetKind === 'maker' ? targetMaker || undefined : undefined,
        expires_at: expires || undefined,
      }));
      flash(`สร้างคูปอง ${label.trim()} แล้ว`);
      setLabel(''); setValue(''); setScope('both'); setTargetKind('none'); setTargetProduct(''); setTargetMaker(''); setExpires('');
    };

    return (
      <div className="mb-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-3 text-base font-bold text-ink">＋ สร้างคูปองใหม่</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">ชื่อคูปอง</span>
            <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="เช่น ส่วนลด 200 สงกรานต์" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">ส่วนลด (บาท)</span>
            <input className={inputCls} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder="100 / 200 / 300" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">วันหมดอายุ (ไม่บังคับ)</span>
            <input className={inputCls} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
        </div>

        <div className="mt-3">
          <span className="mb-1.5 block text-[12.5px] font-semibold text-ink-muted">ใช้กับ</span>
          <div className="flex gap-2">
            {SCOPES.map((s) => (
              <button key={s.key} onClick={() => setScope(s.key)} className={cx('flex-1 rounded-lg border px-3 py-2 text-[13px] font-bold', scope === s.key ? 'border-accent bg-cta text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{s.label}</button>
            ))}
          </div>
        </div>

        <div className="mt-3">
          <span className="mb-1.5 block text-[12.5px] font-semibold text-ink-muted">เจาะจงสินค้า/ค่าย (ไม่บังคับ)</span>
          <div className="mb-2 flex gap-2">
            {(['none', 'product', 'maker'] as const).map((k) => (
              <button key={k} onClick={() => setTargetKind(k)} className={cx('rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold', targetKind === k ? 'border-accent bg-surface-3 text-ink' : 'border-subtle bg-surface-2 text-ink-faint')}>
                {k === 'none' ? 'ทุกสินค้า' : k === 'product' ? 'เฉพาะสินค้า' : 'เฉพาะค่าย'}
              </button>
            ))}
          </div>
          {targetKind === 'product' && (
            <select className={inputCls} value={targetProduct} onChange={(e) => setTargetProduct(e.target.value)}>
              <option value="">— เลือกสินค้า —</option>
              {db.products.map((p) => <option key={p.id} value={p.id}>{p.series_name}{p.is_stock ? ' · พร้อมส่ง' : ''}</option>)}
            </select>
          )}
          {targetKind === 'maker' && (
            <select className={inputCls} value={targetMaker} onChange={(e) => setTargetMaker(e.target.value)}>
              <option value="">— เลือกค่าย —</option>
              {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
        </div>

        <button onClick={submit} className="mt-4 rounded-lg bg-cta px-5 py-2.5 text-sm font-bold text-white">สร้างคูปอง</button>
      </div>
    );
  }

  function CouponCard({ coupon }: { coupon: Coupon }) {
    const [tab, setTab] = useState<'none' | 'grant' | 'detail'>('none');
    const st = grantStats(db, coupon.id);
    const targetName = coupon.target_product_id
      ? db.products.find((p) => p.id === coupon.target_product_id)?.series_name
      : coupon.target_maker_id
        ? `ค่าย ${db.manufacturers.find((m) => m.id === coupon.target_maker_id)?.name ?? ''}`
        : null;

    return (
      <div className={cx('rounded-2xl border bg-surface-2 p-4', coupon.active ? 'border-subtle' : 'border-subtle opacity-60')}>
        <div className="flex items-start gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/20 text-primary-soft"><Icon name="tag" size={20} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-bold">{coupon.label}</span>
              <span className="rounded-md bg-primary/20 px-2 py-0.5 text-[12px] font-extrabold text-primary-soft">−{baht(coupon.value)}</span>
              <CouponTierPill value={coupon.value} />
              <span className={cx('rounded-md px-2 py-0.5 text-[10.5px] font-semibold', scopeCls[coupon.scope])}>{scopeLabel(coupon.scope)}</span>
              {!coupon.active && <span className="rounded-md bg-white/10 px-2 py-0.5 text-[10.5px] text-ink-faint">ปิดใช้</span>}
            </div>
            <div className="mt-1 text-[11.5px] text-ink-faint">
              {targetName ? <>เฉพาะ {targetName} · </> : null}
              {coupon.expires_at ? <>หมดอายุ {fmtDate(coupon.expires_at)} · </> : null}
              มอบ {st.granted} · ใช้แล้ว {st.used} · คงเหลือ {st.active}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => setTab(tab === 'grant' ? 'none' : 'grant')} className={cx('rounded-lg border px-3 py-1.5 text-[12.5px] font-bold', tab === 'grant' ? 'border-accent bg-cta text-white' : 'border-subtle bg-surface-3 text-ink')}>มอบให้ลูกค้า</button>
          <button onClick={() => setTab(tab === 'detail' ? 'none' : 'detail')} className={cx('rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold', tab === 'detail' ? 'border-accent bg-surface-3 text-ink' : 'border-subtle bg-surface-2 text-ink-muted2')}>ดูรายชื่อ ({st.granted})</button>
          <button onClick={() => { dispatch(updateCoupon(coupon.id, { active: !coupon.active })); flash(coupon.active ? 'ปิดใช้คูปองแล้ว' : 'เปิดใช้คูปองแล้ว'); }} className="rounded-lg border border-subtle bg-surface-2 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">{coupon.active ? 'ปิดใช้' : 'เปิดใช้'}</button>
          <button onClick={() => { if (confirm(`ลบคูปอง "${coupon.label}" และการมอบทั้งหมด?`)) { dispatch(deleteCoupon(coupon.id)); flash('ลบคูปองแล้ว'); } }} className="rounded-lg border border-[#b91c1c]/40 bg-[#b91c1c]/[0.12] px-3 py-1.5 text-[12.5px] font-semibold text-primary-soft">ลบ</button>
        </div>

        {tab === 'grant' && <GrantPanel coupon={coupon} />}
        {tab === 'detail' && <DetailPanel coupon={coupon} />}
      </div>
    );
  }

  function GrantPanel({ coupon }: { coupon: Coupon }) {
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [rank, setRank] = useState<RankName>('gold');
    const members = [...db.users]
      .filter((u) => u.id !== 'u-admin' && !u.is_admin && u.approved !== false)
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    const held = (uid: string) => db.couponGrants.some((g) => g.coupon_id === coupon.id && g.user_id === uid && g.status === 'active');

    const toggle = (uid: string) => setPicked((s) => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });
    const giveSelected = () => {
      if (!picked.size) { flash('เลือกลูกค้าก่อน'); return; }
      dispatch(grantCoupon(coupon.id, [...picked]));
      flash(`มอบคูปองให้ ${picked.size} คน`);
      setPicked(new Set());
    };

    return (
      <div className="mt-3 rounded-xl border border-subtle bg-surface-3 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] font-semibold text-ink-muted">มอบทั้ง rank:</span>
          <select className={cx(inputCls, 'w-auto py-1.5')} value={rank} onChange={(e) => setRank(e.target.value as RankName)}>
            {RANK_ORDER.map((r) => <option key={r} value={r}>{RANK[r as RankKey].emoji} {RANK[r as RankKey].label}</option>)}
          </select>
          <button onClick={() => { dispatch(grantCouponToRank(coupon.id, rank)); flash(`มอบให้ทุกคนใน ${RANK[rank as RankKey].label}`); }} className="rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-bold text-white">มอบทั้ง rank</button>
        </div>
        <div className="mb-2 max-h-60 overflow-y-auto rounded-lg border border-subtle">
          {members.length === 0 ? <div className="p-3 text-[12.5px] text-ink-faint">ยังไม่มีสมาชิก</div> : members.map((u) => {
            const already = held(u.id);
            return (
              <button key={u.id} disabled={already} onClick={() => toggle(u.id)} className={cx('flex w-full items-center gap-2.5 border-b border-subtle px-3 py-2 text-left last:border-0', already ? 'opacity-50' : 'hover:bg-white/[0.03]')}>
                <span className={cx('grid h-4 w-4 place-items-center rounded border', picked.has(u.id) ? 'border-accent bg-cta' : 'border-subtle')}>{picked.has(u.id) && <Icon name="check" size={11} className="text-white" />}</span>
                <span className="flex-1 text-[13px]">{u.display_name} <span className="text-ink-faint">· {RANK[u.rank as RankKey].label}</span></span>
                {already && <span className="text-[11px] text-[#4ade80]">มีแล้ว</span>}
              </button>
            );
          })}
        </div>
        <button onClick={giveSelected} className="rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white">มอบให้ {picked.size} คนที่เลือก</button>
      </div>
    );
  }

  function DetailPanel({ coupon }: { coupon: Coupon }) {
    const grants = db.couponGrants.filter((g) => g.coupon_id === coupon.id).sort((a, b) => (b.granted_at ?? '').localeCompare(a.granted_at ?? ''));
    const uname = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? uid;
    const badge: Record<string, string> = { active: 'bg-[#16a34a]/[0.14] text-[#4ade80]', used: 'bg-white/10 text-ink-faint', revoked: 'bg-[#b91c1c]/[0.12] text-primary-soft' };
    const badgeLabel: Record<string, string> = { active: 'พร้อมใช้', used: 'ใช้แล้ว', revoked: 'ถอนแล้ว' };
    return (
      <div className="mt-3 rounded-xl border border-subtle bg-surface-3 p-1">
        {grants.length === 0 ? <div className="p-3 text-[12.5px] text-ink-faint">ยังไม่ได้มอบให้ใคร</div> : grants.map((g) => (
          <div key={g.id} className="flex items-center gap-2 border-b border-subtle px-3 py-2 last:border-0">
            <span className="flex-1 text-[13px]">{uname(g.user_id)}</span>
            <span className="text-[11px] text-ink-faint">{g.status === 'used' ? `ใช้ ${fmtDate(g.used_at)}` : `มอบ ${fmtDate(g.granted_at)}`}</span>
            <span className={cx('rounded-md px-2 py-0.5 text-[10.5px] font-semibold', badge[g.status])}>{badgeLabel[g.status]}</span>
            {g.status === 'active' && <button onClick={() => { dispatch(revokeGrant(g.id)); flash('ถอนคูปองแล้ว'); }} className="text-[11px] font-semibold text-primary-soft">ถอน</button>}
          </div>
        ))}
      </div>
    );
  }
}
