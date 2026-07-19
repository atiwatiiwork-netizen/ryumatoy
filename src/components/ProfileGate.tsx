'use client';

import { useState, useEffect } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useAuth } from '@/state/AuthProvider';
import { updateUser } from '@/data/mutations';
import { store } from '@/data/store';
import { Icon } from './Icon';
import { cx } from './ui';

/** Blocking overlay: login → (not approved) wait screen → (approved) fill shipping address. */
export function ProfileGate() {
  const { currentUserId, needsProfile, needsApproval, isLoggedIn, signOut } = useAuth();
  const db = useDatabase();
  const me = db.users.find((u) => u.id === currentUserId);
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [line, setLine] = useState('');

  // SELF-HEAL the "กำลังโหลดบัญชี…" hang: logged-in but our own row didn't arrive — happens when the
  // data reload stalled on a resume (frozen PWA reopened over a flaky network). Instead of sitting on
  // the overlay until the user leaves + returns (focus-reload), actively re-pull a few times. Retry via
  // the `tick` state so the effect re-fires even while `me` stays undefined. (resume "stuck loading")
  const stuck = isLoggedIn && !me;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!stuck || tick >= 5) return;
    const t = setTimeout(() => { void store.reload().finally(() => setTick((n) => n + 1)); }, tick === 0 ? 800 : 2000);
    return () => clearTimeout(t);
  }, [stuck, tick]);

  // LAST RESORT: a WEDGED supabase client (bad resume → its internal lock deadlocks) makes every
  // request it fires hang — in-page retries can never fix that (observed live: even signOut's await
  // hung, the logout button "did nothing"). Only a page reload builds a fresh client + sockets, and it
  // reliably clears the state ("ออกแล้วเข้าใหม่หาย"). Auto-reload after ~9s, guarded against loops
  // (max 2 bursts / 2 min — if the network is truly down, the overlay stays with a manual button).
  useEffect(() => {
    if (!stuck) return;
    const t = setTimeout(() => {
      try {
        const g = JSON.parse(sessionStorage.getItem('ryuma_stuck_reload') ?? '{"n":0,"ts":0}') as { n: number; ts: number };
        const stale = Date.now() - g.ts > 120_000;
        if (g.n < 2 || stale) {
          sessionStorage.setItem('ryuma_stuck_reload', JSON.stringify({ n: stale ? 1 : g.n + 1, ts: Date.now() }));
          window.location.reload();
        }
      } catch { window.location.reload(); }
    }, 9000);
    return () => clearTimeout(t);
  }, [stuck]);

  // logged in but the user's own row hasn't loaded yet → clean loading, never the
  // wrong gate. (Under RLS the row loads once the session-aware fetch completes.)
  // Placed AFTER all hooks so hook order stays stable (Rules of Hooks).
  if (isLoggedIn && !me) {
    return (
      <div className="fixed inset-0 z-[110] grid place-items-center bg-black/75 p-5">
        <div className="flex flex-col items-center gap-3 text-ink-muted2">
          <Icon name="box" size={30} className="animate-pulse text-primary-soft" />
          <div className="text-[13px]">กำลังโหลดบัญชี…</div>
          <div className="text-[11px] text-ink-faint">ถ้าไม่มา ระบบจะรีเฟรชให้เองใน 9 วินาที</div>
          {/* reload = ทางเดียวที่แก้ client ค้างตายได้ (สร้างการเชื่อมต่อใหม่ทั้งชุด) */}
          <button onClick={() => window.location.reload()} className="mt-1 rounded-xl bg-cta px-6 py-2.5 text-[13px] font-bold text-white">🔄 รีเฟรชแอป</button>
          <button onClick={async () => { await signOut(); window.location.reload(); }} className="text-[11.5px] text-ink-faint underline">ยังไม่หาย? ออกจากระบบ</button>
        </div>
      </div>
    );
  }

  // profile complete but not yet approved → members-only waiting screen. No browsing until an
  // admin approves (keeps the catalog hidden from anyone who just signed up). Signup lands here.
  if (!needsProfile && needsApproval) {
    return (
      <div className="fixed inset-0 z-[110] grid place-items-center bg-black/75 p-5">
        <div className="w-full max-w-[380px] rounded-3xl border border-subtle bg-surface-2 p-7 text-center">
          <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-[#d97706]/[0.15]"><Icon name="bell" size={30} className="text-[#fbbf24]" /></div>
          <div className="text-lg font-extrabold text-ink">สมัครเรียบร้อย 🎉</div>
          <div className="mt-1.5 text-[13px] text-ink-muted2">บัญชีของคุณกำลัง<b className="text-[#fbbf24]">รอแอดมินอนุมัติ</b><br />เมื่ออนุมัติแล้ว เข้าสู่ระบบเพื่อดูสินค้าและสั่งพรีได้เลย</div>
          <button onClick={() => signOut()} className="mt-5 w-full rounded-xl bg-cta py-3 text-sm font-bold text-white">กลับหน้าเข้าสู่ระบบ</button>
        </div>
      </div>
    );
  }

  if (!needsProfile) return null;

  const needPhone = !me?.phone; // phone-signup users already have it; FB users may not
  const save = () => {
    if (needPhone && !phone.trim()) return flash('กรอกเบอร์โทรศัพท์');
    if (!address.trim()) return flash('กรอกที่อยู่จัดส่ง');
    dispatch(updateUser(currentUserId, { ...(needPhone ? { phone: phone.trim() } : {}), shipping_address: address.trim(), line_id: line.trim() || undefined }));
    flash('บันทึกข้อมูลแล้ว ยินดีต้อนรับ! 🎉');
  };

  const inputCls = 'w-full rounded-xl border border-subtle bg-surface-3 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent';

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/75 p-5">
      <div className="w-full max-w-[420px] rounded-3xl border border-subtle bg-surface-2 p-6">
        <div className="mb-1 flex items-center gap-2 text-lg font-extrabold text-ink"><Icon name="user" size={20} className="text-primary-soft" /> กรอกที่อยู่จัดส่ง</div>
        <div className="mb-4 text-[12.5px] text-ink-faint">อนุมัติแล้ว 🎉 กรอกที่อยู่ให้ครบก่อนเริ่มสั่งซื้อ</div>
        <div className="flex flex-col gap-3">
          {needPhone && (
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">เบอร์โทรศัพท์ <span className="text-primary-soft">*</span></span>
              <input className={inputCls} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="08x-xxx-xxxx" />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">ที่อยู่จัดส่ง <span className="text-primary-soft">*</span></span>
            <textarea className={cx(inputCls, 'h-24 resize-none')} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="บ้านเลขที่ / หมู่ / ถนน / ตำบล / อำเภอ / จังหวัด / รหัสไปรษณีย์" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">LINE ID <span className="text-ink-faint">(ไม่บังคับ)</span></span>
            <input className={inputCls} value={line} onChange={(e) => setLine(e.target.value)} placeholder="@yourline" />
          </label>
          <button onClick={save} className="mt-1 w-full rounded-xl bg-cta py-3 text-sm font-bold text-white">บันทึก · เริ่มใช้งาน</button>
        </div>
      </div>
    </div>
  );
}
