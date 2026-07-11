'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { uploadImage } from '@/lib/upload';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, cx } from '@/components/ui';
import { genId, upsertCampaign, deleteCampaign, grantRewardsSweep } from '@/data/mutations';
import { campaignLive, sortedTiers } from '@/domain/services/campaigns';
import type { Campaign, CampaignTier, CouponScope } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block"><span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">{label}</span>{children}</label>
);
const Panel = ({ children }: { children: React.ReactNode }) => <div className="rounded-2xl border border-subtle bg-surface-2 p-5">{children}</div>;

type TierDraft = { threshold: string; coupon_value: string; coupon_count: string };
interface Draft {
  id?: string;
  name: string;
  banner_url?: string;
  product_blurb: string;
  starts_at: string;
  ends_at: string;
  active: boolean;
  tiers: TierDraft[];
  reward_scope: CouponScope;
  reward_expiry_days: string;
  target_maker_id: string;
}
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const fresh = (): Draft => ({
  name: '', banner_url: undefined, product_blurb: '', starts_at: today(), ends_at: plusDays(30), active: true,
  tiers: [{ threshold: '5', coupon_value: '100', coupon_count: '1' }, { threshold: '10', coupon_value: '200', coupon_count: '2' }],
  reward_scope: 'both', reward_expiry_days: '30', target_maker_id: '',
});
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });

export default function AdminEventsPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [draft, setDraft] = useState<Draft>(fresh());
  const [busy, setBusy] = useState(false);
  const editing = Boolean(draft.id);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const reset = () => setDraft(fresh());
  const setTier = (i: number, patch: Partial<TierDraft>) => setDraft((d) => ({ ...d, tiers: d.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const addTier = () => setDraft((d) => ({ ...d, tiers: [...d.tiers, { threshold: '', coupon_value: '', coupon_count: '1' }] }));
  const removeTier = (i: number) => setDraft((d) => ({ ...d, tiers: d.tiers.filter((_, j) => j !== i) }));

  const onBanner = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { set('banner_url', await uploadImage(file, 'banner')); flash('อัปโหลดแบนเนอร์แล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  const save = () => {
    if (!draft.name.trim()) return flash('กรอกชื่อกิจกรรม');
    if (draft.ends_at < draft.starts_at) return flash('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
    const tiers: CampaignTier[] = draft.tiers
      .map((t) => ({ threshold: Number(t.threshold) || 0, coupon_value: Number(t.coupon_value) || 0, coupon_count: Number(t.coupon_count) || 0 }))
      .filter((t) => t.threshold > 0 && t.coupon_value > 0 && t.coupon_count > 0)
      .sort((a, b) => a.threshold - b.threshold);
    if (tiers.length === 0) return flash('ใส่ชั้นรางวัลอย่างน้อย 1 ชั้น (ครบกี่ใบ / คูปองกี่บาท / กี่ใบ)');
    const existing = draft.id ? db.campaigns.find((c) => c.id === draft.id) : undefined;
    const campaign: Campaign = {
      id: draft.id ?? genId('ev'),
      name: draft.name.trim(),
      banner_url: draft.banner_url || undefined,
      product_blurb: draft.product_blurb.trim() || undefined,
      starts_at: draft.starts_at,
      ends_at: draft.ends_at,
      active: draft.active,
      tiers,
      reward_scope: draft.reward_scope,
      reward_expiry_days: Number(draft.reward_expiry_days) || 0,
      target_maker_id: draft.target_maker_id || undefined,
      created_at: existing?.created_at ?? new Date().toISOString(),
    };
    dispatch(upsertCampaign(campaign));
    flash((editing ? 'บันทึกกิจกรรมแล้ว' : 'สร้างกิจกรรมแล้ว') + (draft.active && db.campaigns.some((x) => x.id !== campaign.id && x.active) ? ' · กิจกรรมอื่นถูกพัก' : ''));
    reset();
  };

  const edit = (c: Campaign) => setDraft({
    id: c.id, name: c.name, banner_url: c.banner_url, product_blurb: c.product_blurb ?? '',
    starts_at: c.starts_at, ends_at: c.ends_at, active: c.active,
    tiers: sortedTiers(c).map(({ tier }) => ({ threshold: String(tier.threshold), coupon_value: String(tier.coupon_value), coupon_count: String(tier.coupon_count) })),
    reward_scope: c.reward_scope, reward_expiry_days: String(c.reward_expiry_days), target_maker_id: c.target_maker_id ?? '',
  });
  const del = (c: Campaign) => { if (confirm(`ลบกิจกรรม "${c.name}"?`)) { dispatch(deleteCampaign(c.id)); flash('ลบกิจกรรมแล้ว'); if (draft.id === c.id) reset(); } };

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">กิจกรรม / Event</div>
      <div className="mb-5 text-[13px] text-ink-faint">พรีครบตามเป้า รับคูปองอัตโนมัติ · แสดงแบนเนอร์หน้าแรก + ความคืบหน้าในหน้าสินค้า</div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_1fr] lg:items-start">
        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <span className="font-bold">{editing ? 'แก้ไขกิจกรรม' : 'สร้างกิจกรรมใหม่'}</span>
            {editing && <button onClick={reset} className="text-xs text-primary-soft">+ สร้างใหม่</button>}
          </div>
          <div className="flex flex-col gap-3">
            <Field label="ชื่อกิจกรรม"><input className={inputCls} value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="เช่น พรีครบรับคูปอง เดือนกรกฎา" /></Field>

            <div>
              <div className="mb-1 text-[12.5px] font-semibold text-ink-muted">แบนเนอร์หน้าแรก</div>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-accent bg-surface-3 p-2.5">
                {draft.banner_url
                  ? <img src={draft.banner_url} alt="" className="h-14 w-24 rounded-lg object-cover" />
                  : <div className="grid h-14 w-24 place-items-center rounded-lg bg-surface-4 text-ink-faint">{busy ? <Icon name="box" size={18} className="animate-pulse" /> : <Icon name="camera" size={18} />}</div>}
                <span className="text-[12px] text-ink-faint">{draft.banner_url ? 'เปลี่ยนรูป' : 'แตะเพื่ออัปโหลด (แนะนำแนวนอน)'}</span>
                <input type="file" accept="image/*" className="hidden" onChange={(e) => onBanner(e.target.files?.[0])} />
              </label>
            </div>

            <Field label="ข้อความดึงดูด (แสดงในหน้าสินค้า/รายละเอียด)"><textarea className={cx(inputCls, 'min-h-[64px]')} value={draft.product_blurb} onChange={(e) => set('product_blurb', e.target.value)} placeholder="เช่น ยิ่งพรีเยอะ ยิ่งได้คูปองส่วนลดเยอะ!" /></Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="วันเริ่ม"><input type="date" className={inputCls} value={draft.starts_at} onChange={(e) => set('starts_at', e.target.value)} /></Field>
              <Field label="วันสิ้นสุด"><input type="date" className={inputCls} value={draft.ends_at} onChange={(e) => set('ends_at', e.target.value)} /></Field>
            </div>

            {/* tiers */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[12.5px] font-semibold text-ink-muted">ชั้นรางวัล (พรีครบ → คูปอง)</span>
                <button onClick={addTier} className="text-xs font-semibold text-primary-soft">＋ เพิ่มชั้น</button>
              </div>
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_1fr_1fr_28px] gap-2 px-0.5 text-[10.5px] text-ink-faint">
                  <span>ครบ (ใบ)</span><span>คูปอง (บาท)</span><span>จำนวน (ใบ)</span><span />
                </div>
                {draft.tiers.map((t, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_28px] items-center gap-2">
                    <input className={cx(inputCls, 'py-2 text-center')} inputMode="numeric" value={t.threshold} onChange={(e) => setTier(i, { threshold: e.target.value })} placeholder="5" />
                    <input className={cx(inputCls, 'py-2 text-center')} inputMode="numeric" value={t.coupon_value} onChange={(e) => setTier(i, { coupon_value: e.target.value })} placeholder="100" />
                    <input className={cx(inputCls, 'py-2 text-center')} inputMode="numeric" value={t.coupon_count} onChange={(e) => setTier(i, { coupon_count: e.target.value })} placeholder="1" />
                    <button onClick={() => removeTier(i)} className="grid h-8 w-7 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint"><Icon name="x" size={14} /></button>
                  </div>
                ))}
              </div>
            </div>

            {/* reward coupon spec */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="คูปองใช้กับ">
                <select className={inputCls} value={draft.reward_scope} onChange={(e) => set('reward_scope', e.target.value as CouponScope)}>
                  <option value="both">พรี + พร้อมส่ง</option>
                  <option value="preorder">พรีออเดอร์</option>
                  <option value="instock">พร้อมส่ง</option>
                </select>
              </Field>
              <Field label="อายุคูปอง (วันหลังได้รับ)">
                <input className={inputCls} inputMode="numeric" value={draft.reward_expiry_days} onChange={(e) => set('reward_expiry_days', e.target.value)} placeholder="30" />
                <span className="mt-1 block text-[11px] text-ink-faint">0 = ไม่หมดอายุ</span>
              </Field>
            </div>
            <Field label="จำกัดค่าย (ไม่บังคับ)">
              <select className={inputCls} value={draft.target_maker_id} onChange={(e) => set('target_maker_id', e.target.value)}>
                <option value="">— ทุกค่าย —</option>
                {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>

            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.active} onChange={(e) => set('active', e.target.checked)} /> เปิดใช้งาน (โชว์หน้าร้าน — ปิดกิจกรรมอื่นทั้งหมด)</label>
            {editing && db.campaignAwards.some((a) => a.campaign_id === draft.id) && (
              <div className="rounded-lg border border-[#d97706]/40 bg-[#d97706]/[0.08] px-3 py-2 text-[11.5px] text-[#fbbf24]">⚠️ กิจกรรมนี้แจกรางวัลไปแล้ว — ไม่ควรแก้ "ครบ (ใบ)" ของชั้นรางวัลกลางคัน (คนที่รับชั้นเดิมไปแล้วอาจรับชั้นที่แก้ใหม่ซ้ำได้)</div>
            )}
            <Button onClick={save} icon={editing ? 'check' : 'plus'} disabled={busy}>{editing ? 'บันทึก' : 'สร้างกิจกรรม'}</Button>
          </div>
        </Panel>

        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <span className="font-bold">กิจกรรมทั้งหมด ({db.campaigns.length})</span>
            {/* Diamond auto-approve (customer session) can't mint rewards — this credits anything owed */}
            <button onClick={() => {
              let before = 0, after = 0;
              dispatch((d) => { before = d.campaignAwards.length; return d; });
              dispatch(grantRewardsSweep());
              dispatch((d) => { after = d.campaignAwards.length; return d; });
              flash(after > before ? `เติมรางวัลย้อนหลัง ${after - before} รายการ ✓` : 'ไม่มีรางวัลค้างจ่าย ✓');
            }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-semibold text-ink-muted2">🔄 ตรวจจ่ายรางวัลย้อนหลัง</button>
          </div>
          {db.campaigns.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-ink-faint">ยังไม่มีกิจกรรม — สร้างด้านซ้าย</div>
          ) : (
            <div className="flex flex-col gap-3">
              {[...db.campaigns].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((c) => {
                const live = campaignLive(c);
                const awards = db.campaignAwards.filter((a) => a.campaign_id === c.id);
                const winners = new Set(awards.map((a) => a.user_id)).size;
                return (
                  <div key={c.id} className="rounded-xl border border-subtle bg-surface-3/40 p-4">
                    <div className="flex items-start gap-3">
                      {c.banner_url && <img src={c.banner_url} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[14px] font-bold">{c.name}</span>
                          {live
                            ? <span className="rounded-full bg-[#16a34a]/[0.16] px-2 py-0.5 text-[10.5px] font-bold text-[#4ade80]">กำลังจัด</span>
                            : c.active
                              ? <span className="rounded-full bg-[#d97706]/[0.16] px-2 py-0.5 text-[10.5px] font-bold text-[#fbbf24]">นอกช่วงเวลา</span>
                              : <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10.5px] font-bold text-ink-faint">ปิด</span>}
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-ink-faint">{fmtDate(c.starts_at)} – {fmtDate(c.ends_at)} · แจกแล้ว {awards.length} คูปอง · {winners} คน</div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {sortedTiers(c).map(({ tier, index }) => (
                            <span key={index} className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-muted2">ครบ {tier.threshold} → {baht(tier.coupon_value)}×{tier.coupon_count}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button onClick={() => { edit(c); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">แก้</button>
                      <button onClick={() => del(c)} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-[#f87171]">ลบ</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      <PricingGuide />
    </div>
  );
}

/** คู่มือตั้งชั้นรางวัล (อิงกำไร ~200฿/ใบพรี) — reference ถาวรกันลืม อยู่ท้ายหน้ากิจกรรม */
function PricingGuide() {
  const th = 'px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-ink-faint';
  const td = 'px-3 py-2 text-[12.5px] text-ink-muted';
  return (
    <div className="mt-6 rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">📐 คู่มือตั้งชั้นรางวัล (อิงกำไร ~200฿/ใบพรี)</div>
      <div className="mb-4 text-[12px] text-ink-faint">หลัก: ส่วนลดที่แจกควรอยู่ราว 10–17% ของกำไรสะสม · คูปองมีวันหมดอายุ + ต้องกลับมาใช้กับออเดอร์ใหม่ = ได้กำไรรอบถัดไปมาชดเชยอีกชั้น (คนใช้จริง ~70–80% → ต้นทุนสุทธิ ~12–14%)</div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-[12.5px] font-bold text-ink-muted">คณิตพื้นฐาน</div>
          <div className="overflow-x-auto rounded-xl border border-subtle">
            <table className="w-full min-w-[380px] border-collapse">
              <thead className="bg-surface-3"><tr><th className={th}>ครบ (ใบ)</th><th className={th}>กำไรสะสม</th><th className={th}>ถ้าแจก</th><th className={th}>คืนเป็น % กำไร</th></tr></thead>
              <tbody className="divide-y divide-hair">
                <tr><td className={td}>3</td><td className={td}>600฿</td><td className={td}>50฿</td><td className={td}>8% ✅ เบามาก</td></tr>
                <tr><td className={td}>5</td><td className={td}>1,000฿</td><td className={td}>100฿</td><td className={td}>10% ✅ กำลังดี</td></tr>
                <tr><td className={td}>10</td><td className={td}>2,000฿</td><td className={td}>200฿ (สะสมรวม 350)</td><td className={td}>17.5% ✅ ตึงแต่รับได้</td></tr>
                <tr><td className={td}>10</td><td className={td}>2,000฿</td><td className={td}>200×2 (สะสมรวม 500)</td><td className={td}>25% ⚠️ แพงไป</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="mb-2 text-[12.5px] font-bold text-ink-muted">🎯 สูตรแนะนำ (สมดุล 3 กลุ่มลูกค้า)</div>
          <div className="overflow-x-auto rounded-xl border border-subtle">
            <table className="w-full min-w-[380px] border-collapse">
              <thead className="bg-surface-3"><tr><th className={th}>ชั้น</th><th className={th}>รางวัล</th><th className={th}>เจาะกลุ่ม</th><th className={th}>เหตุผล</th></tr></thead>
              <tbody className="divide-y divide-hair">
                <tr><td className={td}>ครบ 3</td><td className={td}>50฿ ×1</td><td className={td}>🐣 พรีน้อย</td><td className={td}>สั่งทีละ 2–3 ตัวอยู่แล้ว → ออเดอร์เดียวแตะรางวัล = ติดใจเร็ว</td></tr>
                <tr><td className={td}>ครบ 5</td><td className={td}>100฿ ×1</td><td className={td}>🚶 พรีกลาง</td><td className={td}>จาก 3 เพิ่มแค่ 2 ใบ "อีกนิดเดียว" — จุดที่คน 3–4 ใบยอมกดเพิ่ม</td></tr>
                <tr><td className={td}>ครบ 10</td><td className={td}>200฿ ×1</td><td className={td}>🐋 พรีเยอะ</td><td className={td}>สะสม 350/2,000 = 17.5% · loop วนใหม่ดูแลสายเปย์เอง (ครบ 20 ได้อีก 350)</td></tr>
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-[11.5px] text-ink-faint">ทางเลือก — ประหยัด (~15%): 5→100, 10→200 · เปิดตัวดุดัน (~22%, เดือนแรกเดือนเดียว): 3→50, 5→100, 10→300</div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-subtle bg-surface-3/40 p-3.5 text-[12.5px] leading-relaxed text-ink-muted2">
        <div className="mb-1 font-bold text-ink">เคล็ดลับตั้งค่า</div>
        <ul className="list-inside list-disc space-y-1">
          <li><b>ระยะเวลา 1 เดือน</b> ตรงรอบเปิดพรีรายเดือน — เริ่มใหม่ทุกเดือน คนไม่รอสะสมข้ามปี</li>
          <li><b>อายุคูปอง 30 วัน</b> — บังคับให้กลับมาซื้อภายในรอบถัดไปพอดี</li>
          <li>scope <b>"พรี + พร้อมส่ง"</b> — คูปองกลายเป็นตัวดันของค้างสต๊อกได้ด้วย</li>
          <li>นับ "1 รายการ" = ใบพรี 1 ใบ (1 บรรทัดในออเดอร์) — สั่งตัวเดียวกันหลายชิ้นในบรรทัดเดียวนับ 1 · ซื้อพร้อมส่ง/รอบพิเศษไม่นับ</li>
          <li>⚠️ ไม่ควรแก้ชั้นรางวัลระหว่าง event ที่แจกไปแล้ว — ตั้งใหม่เป็น event เดือนถัดไปแทน</li>
        </ul>
      </div>
    </div>
  );
}
