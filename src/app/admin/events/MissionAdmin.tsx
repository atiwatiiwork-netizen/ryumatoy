'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, cx } from '@/components/ui';
import { MissionQuestCard } from '@/components/MissionQuest';
import { missionConfig, missionInWindow, missionStateFor, type MissionConfig } from '@/domain/services/missions';
import { setMissionConfig, approveMission, rejectMission, createCoupon } from '@/data/mutations';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block"><span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">{label}</span>{children}</label>
);
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/**
 * Event ภารกิจ (mission quest) admin — config + CUSTOMER PREVIEW + approve queue.
 * DNA (ryuma-event-spec): บันทึกครั้งแรกจะยัง "ปิด" เสมอ → แอดมินต้องดูพรีวิวหน้าลูกค้าด้านล่างก่อน
 * แล้วค่อยกด "เปิดใช้งาน" — กันปล่อย Event ที่หน้าตา/ข้อความผิดออกไปหาลูกค้า.
 */
export function MissionAdmin() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const saved = missionConfig(db);
  const [draft, setDraft] = useState<MissionConfig>(() => saved ?? {
    title: 'ภารกิจนักสะสม — ทำ 3 อย่าง รับคูปอง 100 บาท',
    blurb: 'พรี 1 ใบ + ลงแอปหน้าจอ + เปิดกระดิ่ง รับเลยคูปองส่วนลด 100 บาท',
    starts_at: today(), ends_at: plusDays(30), reward_coupon_id: '', active: false,
  });
  const set = <K extends keyof MissionConfig>(k: K, v: MissionConfig[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const reward = db.coupons.find((c) => c.id === draft.reward_coupon_id);

  // preview toggles — admin can flip each quest state to see every look of the card
  const [pv, setPv] = useState({ hasTicket: true, installed: false, bellOn: true });

  const pending = db.missionSubmissions.filter((s) => s.status === 'pending');
  const approvedCount = db.missionSubmissions.filter((s) => s.status === 'approved').length;
  const nameOf = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '—';
  const [lightbox, setLightbox] = useState<string | null>(null);

  const quickCreateReward = () => {
    dispatch(createCoupon({ label: `Event ภารกิจ ${baht(100)}`, value: 100, scope: 'both' }));
    let newest = '';
    dispatch((d) => { newest = d.coupons[0]?.id ?? ''; return d; }); // createCoupon prepends → [0] is ours
    if (newest) { set('reward_coupon_id', newest); flash('สร้างคูปองรางวัล 100 บาทแล้ว ✓'); }
  };

  const save = (active: boolean) => {
    if (!draft.title.trim()) return flash('ตั้งชื่อกิจกรรมก่อน');
    if (!draft.reward_coupon_id) return flash('เลือก/สร้างคูปองรางวัลก่อน');
    if (!draft.starts_at || !draft.ends_at || draft.ends_at < draft.starts_at) return flash('ช่วงวันที่ไม่ถูกต้อง');
    dispatch(setMissionConfig({ ...draft, active }));
    setDraft((d) => ({ ...d, active }));
    flash(active ? '🟢 เปิด Event ภารกิจแล้ว — ลูกค้าเห็นในโปรไฟล์' : 'บันทึกแล้ว (ยังปิดอยู่ — ตรวจพรีวิวก่อนเปิด)');
  };

  const approve = (subId: string, userId: string) => {
    dispatch(approveMission(subId));
    if (pushEnabled(db, 'event_reward'))
      sendPush(subsForUsers(db, [userId]), { title: '🏆 ภารกิจสำเร็จ!', body: `รับคูปอง ${baht(reward?.value ?? 100)} แล้ว — อยู่ใน "คูปองของฉัน"`, url: '/missions' }, dispatch).catch(() => {});
    flash(`อนุมัติ + ส่งคูปองให้ ${nameOf(userId)} ✓`);
  };

  return (
    <div className="mt-6 rounded-2xl border border-[#d4af37]/35 bg-surface-2 p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2 font-bold">
        🕹️ Event ภารกิจ (ติดตั้งแอป + เปิดกระดิ่ง)
        {saved?.active && missionInWindow(saved) ? <span className="rounded-full bg-[#16a34a]/[0.16] px-2 py-0.5 text-[10.5px] font-bold text-[#4ade80]">กำลังจัด</span>
          : saved?.active ? <span className="rounded-full bg-[#d97706]/[0.16] px-2 py-0.5 text-[10.5px] font-bold text-[#fbbf24]">นอกช่วงเวลา</span>
          : <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10.5px] font-bold text-ink-faint">ปิดอยู่</span>}
        {approvedCount > 0 && <span className="text-[11px] font-normal text-ink-faint">· แจกแล้ว {approvedCount} คน</span>}
      </div>
      <div className="mb-4 text-[12px] text-ink-faint">ลูกค้าทำ 3 อย่าง (พรี 1 ใบ · ลงหน้าจอ · เปิดกระดิ่ง) → ส่งภารกิจ → แอดมินอนุมัติ → คูปองเข้า + push</div>

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        {/* config */}
        <div className="flex flex-col gap-3">
          <Field label="ชื่อกิจกรรม"><input className={inputCls} value={draft.title} onChange={(e) => set('title', e.target.value)} /></Field>
          <Field label="คำอธิบายสั้น"><input className={inputCls} value={draft.blurb ?? ''} onChange={(e) => set('blurb', e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="วันเริ่ม"><input type="date" className={inputCls} value={draft.starts_at} onChange={(e) => set('starts_at', e.target.value)} /></Field>
            <Field label="วันสิ้นสุด (รวมทั้งวัน)"><input type="date" className={inputCls} value={draft.ends_at} onChange={(e) => set('ends_at', e.target.value)} /></Field>
          </div>
          <Field label="คูปองรางวัล">
            <div className="flex gap-2">
              <select className={inputCls} value={draft.reward_coupon_id} onChange={(e) => set('reward_coupon_id', e.target.value)}>
                <option value="">— เลือกคูปอง —</option>
                {db.coupons.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.label} · {baht(c.value)}</option>)}
              </select>
              <button onClick={quickCreateReward} className="shrink-0 rounded-lg border border-subtle bg-surface-3 px-3 text-[12px] font-bold text-ink-muted2">＋ สร้าง 100฿</button>
            </div>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save(false)} icon="check">บันทึก (ยังไม่เปิด)</Button>
            {saved?.active && <button onClick={() => save(false)} className="rounded-xl border border-subtle bg-surface-3 px-4 text-[13px] font-bold text-[#f87171]">⏸ พักกิจกรรม</button>}
          </div>
        </div>

        {/* CUSTOMER PREVIEW — ตรวจก่อนเปิด (DNA) */}
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-bold text-ink-muted">👁️ พรีวิวหน้าลูกค้า (ลองกดสลับสถานะดูทุกแบบ)</span>
            {(['hasTicket', 'installed', 'bellOn'] as const).map((k, i) => (
              <button key={k} onClick={() => setPv((p) => ({ ...p, [k]: !p[k] }))} className={cx('rounded-full border px-2 py-0.5 text-[10.5px] font-bold', pv[k] ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.14] text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-faint')}>{['🎫 พรี', '📲 ลงจอ', '🔔 กระดิ่ง'][i]}</button>
            ))}
          </div>
          <MissionQuestCard cfg={draft} rewardValue={reward?.value ?? 100} flags={pv} />
          {!saved?.active && (
            <button onClick={() => save(true)} className="mt-3 w-full rounded-xl bg-gradient-to-r from-[#b45309] to-[#d4af37] py-3 text-[14px] font-extrabold text-white">
              ✅ ตรวจพรีวิวแล้ว — เปิดใช้งาน Event
            </button>
          )}
          <div className="mt-1.5 text-center text-[10.5px] text-ink-faint">กติกา: ตรวจหน้าตา/ข้อความในพรีวิวให้เรียบร้อยก่อนกดเปิดเสมอ</div>
        </div>
      </div>

      {/* approve queue */}
      <div className="mt-5 border-t border-hair pt-4">
        <div className="mb-2 text-[13px] font-bold">รอตรวจสอบ ({pending.length})</div>
        {pending.length === 0 ? (
          <div className="py-3 text-center text-[12px] text-ink-faint">ไม่มีภารกิจรอตรวจ</div>
        ) : (
          <div className="flex flex-col divide-y divide-hair">
            {pending.map((s) => {
              const st = missionStateFor(db, s.user_id); // admin เห็นทุกแถว → เช็คระบบของคนนั้นได้จริง
              return (
                <div key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">{nameOf(s.user_id)}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10.5px] font-bold">
                      <Chk ok={st.hasTicket} label="🎫 มีใบพรี" />
                      <Chk ok={st.installed} label="📲 ลงจอ (ระบบ)" />
                      <Chk ok={st.bellOn} label="🔔 กระดิ่ง" />
                      {!st.installed && (s.proof_url
                        ? <button onClick={() => setLightbox(s.proof_url!)} className="rounded-md border border-[#2563eb]/45 bg-[#2563eb]/[0.12] px-1.5 py-0.5 text-[#93c5fd]">🖼 ดูรูปหลักฐาน</button>
                        : <span className="rounded-md bg-[#b91c1c]/[0.14] px-1.5 py-0.5 text-primary-soft">ไม่มีหลักฐานลงจอ</span>)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => approve(s.id, s.user_id)} className="rounded-lg bg-[#16a34a] px-3.5 py-2 text-[12.5px] font-bold text-white">อนุมัติ + ส่งคูปอง</button>
                    <button onClick={() => { if (confirm(`ไม่ผ่าน: ${nameOf(s.user_id)}? (ลูกค้าส่งใหม่ได้)`)) { dispatch(rejectMission(s.id)); flash('ตีกลับแล้ว'); } }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[12.5px] font-bold text-[#f87171]">ไม่ผ่าน</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {lightbox && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-black/80 p-4" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="หลักฐาน" className="max-h-[85vh] max-w-full rounded-xl" />
          <button className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-surface-2 text-ink" aria-label="ปิด"><Icon name="x" size={16} /></button>
        </div>
      )}
    </div>
  );
}

function Chk({ ok, label }: { ok: boolean; label: string }) {
  return <span className={cx('rounded-md px-1.5 py-0.5', ok ? 'bg-[#16a34a]/[0.14] text-[#4ade80]' : 'bg-surface-3 text-ink-faint line-through')}>{label}</span>;
}
