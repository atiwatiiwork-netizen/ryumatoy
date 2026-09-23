'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useReady } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { launchNotice, pointsLaunchInfo, SPECIAL_ROUND_POINTS_DEFAULT } from '@/domain/services/points';
import type { Database } from '@/domain/entities';
import { Embers, Rune } from './PointsPanel';

const num = (n: number) => n.toLocaleString('en-US');
const seenKey = (uid: string) => `ryuma_points_launch_seen_${uid}`;

/**
 * ประกาศ "ระบบคะแนนสะสมเปิดแล้ว · คะแนนของคุณคือ xx" (เจ้าของ 2026-09-23) — **คอมโพเนนต์เดียว ใช้ 2 ที่** (DNA shared preview)
 *   · live    → ติดใน CustomerShell: ป๊อปอัปเต็มจอ ครั้งเดียวต่อผู้ใช้ต่อการเปิดตัว (localStorage จำ app_config points_launch.at)
 *   · preview → การ์ดในหน้าแอดมิน /admin/points (เลือกลูกค้า + db จำลองหลังกดเปิดตัว) — ปุ่มกดไม่ได้
 * ข้อความทั้งหมดมาจาก launchNotice() ใน points.ts ตัวเดียวกับ push — ห้ามเขียนข้อความซ้ำที่นี่
 * โชว์เมื่อ: ข้อมูลจริงโหลดเสร็จ (useReady) + เปิดระบบแล้ว + มีวันเปิดตัว + ยังไม่เคยปิดป๊อปอัปนี้
 */
export function PointsLaunchNotice({ mode = 'live', userId, dbOverride }: {
  mode?: 'live' | 'preview';
  userId?: string;
  dbOverride?: Database;
}) {
  const liveDb = useDatabase();
  const db = dbOverride ?? liveDb;
  const ready = useReady();
  const authUid = useCurrentUserId();
  const router = useRouter();
  const uid = mode === 'preview' ? userId ?? '' : authUid;
  const launch = pointsLaunchInfo(db);
  // undefined = ยังไม่ได้อ่าน localStorage (ก่อน mount — กัน hydration mismatch)
  const [seen, setSeen] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (mode === 'preview' || !uid) return;
    try { setSeen(localStorage.getItem(seenKey(uid))); }
    catch { setSeen(null); } // โหมดส่วนตัว/บล็อก storage → โชว์ได้ แล้วจำไว้ในหน่วยความจำหลังปิด
  }, [uid, mode]);

  if (!uid || !launch) return null;
  if (mode === 'live' && (seen === undefined || !ready || !db.settings.points_enabled || seen === launch.at)) return null;

  const n = launchNotice(db, uid);
  const dismiss = () => {
    if (mode === 'preview') return;
    try { localStorage.setItem(seenKey(uid), launch.at); } catch { /* private mode — ปิดในรอบนี้พอ */ }
    setSeen(launch.at);
  };
  const open = () => { dismiss(); if (mode === 'live') router.push(n.url); };

  const card = (
    <div
      role="dialog"
      aria-label={n.title}
      onClick={(e) => e.stopPropagation()}
      className="relative w-full max-w-[360px] overflow-hidden rounded-2xl border border-[#d4af37]/50 bg-[#0b0708] px-5 pb-5 pt-6 text-center shadow-[inset_0_0_0_1px_rgba(0,0,0,.6),inset_0_0_0_3px_rgba(212,175,55,.12),0_24px_60px_-18px_rgba(185,28,28,.6)]"
    >
      <div className="pointer-events-none absolute -left-16 -top-24 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(185,28,28,.42),transparent_65%)]" />
      <div className="pointer-events-none absolute -bottom-28 -right-10 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(212,175,55,.22),transparent_65%)]" />
      <Embers count={12} />
      <Rune className="left-2 top-1.5" /><Rune className="right-2 top-1.5" /><Rune className="bottom-1.5 left-2" /><Rune className="bottom-1.5 right-2" />

      <div className="relative text-[11px] font-bold tracking-[.18em] text-[#f1d27a]/90 motion-safe:animate-eldenReveal">✦ RYUMA POINTS ✦</div>
      <div className="relative mx-auto mt-1.5 h-px w-40 origin-center bg-gradient-to-r from-transparent via-[#d4af37] to-transparent motion-safe:animate-lineGrow" />
      <div className="relative mt-3 text-[19px] font-extrabold text-ink">{n.title.replace('⭐ ', '')}</div>

      <div className="relative mt-4 text-[12px] font-bold tracking-[.14em] text-[#f1d27a]/75">คะแนนของคุณคือ</div>
      <div className="relative mt-1 flex items-end justify-center gap-2">
        <span className="bg-[linear-gradient(90deg,#b8860b,#f7e39b,#d4af37,#fff2b8,#b8860b)] bg-[length:200%_100%] bg-clip-text text-[54px] font-extrabold leading-none text-transparent drop-shadow-[0_0_14px_rgba(212,175,55,.45)] motion-safe:animate-goldShine">{num(n.balance)}</span>
        <span className="pb-2 text-[14px] font-bold text-[#f1d27a]">แต้ม</span>
      </div>
      <div className="relative mt-1.5 text-[12.5px] text-ink-muted2">
        {n.tickets > 0
          ? <>จากใบพรีที่ปิดแล้ว <b className="text-ink">{n.tickets}</b> ใบ · 1 แต้ม = 1฿</>
          : <>ยังไม่มีแต้ม — ปิดใบพรีครั้งถัดไปรับ <b className="text-[#f1d27a]">+{n.rate}</b> แต้ม/ใบ</>}
      </div>

      <div className="relative mt-4 rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 text-left text-[12px] leading-relaxed text-ink-muted2">
        <div>📝 ปิดใบพรี รอบปกติ <b className="text-[#f1d27a]">+{n.rate}</b> · รอบพิเศษ <b className="text-[#f1d27a]">+{SPECIAL_ROUND_POINTS_DEFAULT}</b> แต้ม/ใบ</div>
        <div className="mt-0.5">{n.canRedeem ? '🎟️ ใช้แต้มลดได้ตอนปิดใบพรี / ซื้อของพร้อมส่ง' : '🎟️ การใช้แต้มลดราคา — เร็วๆ นี้ ร้านจะประกาศอีกครั้ง'}</div>
      </div>

      <button onClick={open} className="relative mt-4 w-full rounded-xl bg-[linear-gradient(90deg,#7f1d1d,#b91c1c,#7f1d1d)] py-3 text-[14px] font-extrabold text-white shadow-[0_0_0_1px_rgba(212,175,55,.45)]">ดูคะแนนของฉัน</button>
      <button onClick={dismiss} className="relative mt-2 w-full py-1.5 text-[12.5px] font-semibold text-ink-faint">ไว้ทีหลัง</button>
    </div>
  );

  if (mode === 'preview') return <div className="grid place-items-center rounded-2xl bg-black/80 p-5">{card}</div>;
  return <div className="fixed inset-0 z-[120] grid place-items-center bg-black/80 p-5" onClick={dismiss}>{card}</div>;
}
