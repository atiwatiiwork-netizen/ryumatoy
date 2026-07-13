'use client';

import { useEffect, useState } from 'react';
import { useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { pushSupported, currentPushSubscription, enablePush } from '@/lib/push';
import { detectPlatform, isStandalone, type Platform } from '@/lib/pwa';
import { Icon } from './Icon';
import { cx } from './ui';

/**
 * ดันให้ลูกค้า (1) ติดตั้งเว็บแอปลงหน้าจอโทรศัพท์ + (2) เปิดกระดิ่งรับ push ให้มากที่สุด (ryuma-push-adoption).
 * ตรวจเองว่าใครยังไม่ทำ → แบนเนอร์ค้าง + เด้ง modal พร้อมวิธีทำ (ทุก ~3 วันถ้ายังไม่ทำ). ไม่มีรางวัล เน้นประโยชน์.
 * ทั้งหมดเป็น client-only (standalone/permission อ่านจาก browser) → เรนเดอร์หลัง mount กัน hydration mismatch.
 */

const NUDGE_INTERVAL = 3 * 24 * 60 * 60 * 1000; // เด้ง modal ซ้ำทุก 3 วัน
const LAST_KEY = 'ryuma_nudge_last';
const BANNER_KEY = 'ryuma_nudge_banner_off'; // ปิดแบนเนอร์เฉพาะ session นี้

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

export function InstallBellNudge({ userId }: { userId: string }) {
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [ready, setReady] = useState(false);
  const [platform, setPlatform] = useState<Platform>('desktop');
  const [installed, setInstalled] = useState(true);
  const [bellOn, setBellOn] = useState(true);
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [open, setOpen] = useState(false);
  const [bannerOff, setBannerOff] = useState(false);
  const [busy, setBusy] = useState(false);

  const recheck = async () => {
    setInstalled(isStandalone());
    if (!pushSupported()) { setBellOn(false); return; }
    try { const s = await currentPushSubscription(); setBellOn(!!s && Notification.permission === 'granted'); }
    catch { setBellOn(false); }
  };

  useEffect(() => {
    setPlatform(detectPlatform());
    setBannerOff(sessionStorage.getItem(BANNER_KEY) === '1');
    const onBIP = (e: Event) => { e.preventDefault(); setDeferred(e as BIPEvent); };
    const onInstalled = () => { setInstalled(true); setDeferred(null); };
    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);
    recheck().finally(() => setReady(true));
    return () => { window.removeEventListener('beforeinstallprompt', onBIP); window.removeEventListener('appinstalled', onInstalled); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isMobile = platform === 'ios' || platform === 'android';
  const needInstall = isMobile && !installed; // เป้าหมายคือลงหน้าจอ "โทรศัพท์" — desktop ไม่บังคับติดตั้ง
  const needBell = !bellOn;
  const show = ready && !!userId && (needInstall || needBell);

  // auto-เด้ง modal ครั้งแรก/ทุก 3 วัน ถ้ายังไม่ครบ
  useEffect(() => {
    if (!show) return;
    const last = Number(localStorage.getItem(LAST_KEY) || 0);
    if (Date.now() - last > NUDGE_INTERVAL) { setOpen(true); localStorage.setItem(LAST_KEY, String(Date.now())); }
  }, [show]);

  if (!show) return null;

  const closeModal = () => { localStorage.setItem(LAST_KEY, String(Date.now())); setOpen(false); };
  const dismissBanner = () => { sessionStorage.setItem(BANNER_KEY, '1'); setBannerOff(true); };

  const doInstall = async () => {
    if (!deferred) return;
    try { await deferred.prompt(); const c = await deferred.userChoice; if (c.outcome === 'accepted') { setInstalled(true); setDeferred(null); flash('กำลังติดตั้ง… เปิดจากไอคอน Ryuma ได้เลย'); } /* dismissed → keep deferred so they can retry one-tap */ }
    catch { /* prompt failed → keep deferred */ }
  };
  // install-FIRST: on a phone the bell is only offered AFTER the app is installed + opened from the icon
  // (iOS *requires* it; on Android we enforce it too so every opt-in lands on the home screen). Desktop
  // has no home-screen step → the bell is available directly.
  const bellBlocked = isMobile && !installed;

  const doBell = async () => {
    if (busy) return;
    if (bellBlocked) { flash('ติดตั้งลงหน้าจอโฮมก่อน แล้วเปิด Ryuma จากไอคอน จึงเปิดกระดิ่งได้'); return; }
    if (!pushSupported()) { flash(platform === 'ios' ? 'iPhone: ติดตั้งลงหน้าจอโฮมก่อน แล้วเปิดจากไอคอน' : 'อุปกรณ์นี้ยังไม่รองรับการแจ้งเตือน'); return; }
    setBusy(true);
    try { await enablePush(userId, dispatch); setBellOn(true); flash('เปิดกระดิ่งแล้ว 🔔 รับข่าวก่อนใครเลย'); }
    catch (e) { flash((e as Error).message === 'denied' ? 'ไม่ได้รับอนุญาต — เปิดได้ใน ตั้งค่า > การแจ้งเตือน' : 'เปิดกระดิ่งไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  return (
    <>
      {/* แบนเนอร์ค้าง (ปิดได้เฉพาะ session) */}
      {!bannerOff && !open && (
        <div className="fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-40 mx-auto max-w-[1140px] px-3 lg:bottom-4">
          <div className="flex items-center gap-2.5 rounded-2xl border border-[#2563eb]/45 bg-[#0f1e3a] px-3.5 py-2.5 shadow-lg">
            <span className="text-lg">🔔</span>
            <button onClick={() => setOpen(true)} className="min-w-0 flex-1 text-left">
              <div className="text-[12.5px] font-bold text-[#bcd3f5]">{needInstall ? 'ติดตั้งแอป + เปิดกระดิ่ง' : 'เปิดกระดิ่งรับข่าว'} รับรอบพรี/ของถึงก่อนใคร</div>
              <div className="text-[10.5px] text-[#7f9cc9]">แตะดูวิธีทำ · ใช้เวลา 15 วินาที</div>
            </button>
            <button onClick={() => setOpen(true)} className="shrink-0 rounded-lg bg-[#2563eb] px-3 py-1.5 text-[12px] font-bold text-white">เปิด</button>
            <button onClick={dismissBanner} aria-label="ปิด" className="shrink-0 text-ink-faint"><Icon name="x" size={16} /></button>
          </div>
        </div>
      )}

      {/* modal วิธีทำ */}
      {open && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={closeModal}>
          <div onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full max-w-[420px] overflow-y-auto rounded-t-3xl border border-subtle bg-surface-2 p-5 sm:rounded-3xl">
            <div className="mb-1 flex items-start justify-between gap-2">
              <div className="text-lg font-extrabold">รับข่าวก่อนใคร 🔥</div>
              <button onClick={closeModal} aria-label="ปิด" className="grid h-8 w-8 place-items-center rounded-full bg-surface-3 text-ink-faint"><Icon name="x" size={16} /></button>
            </div>
            <div className="mb-4 text-[12.5px] leading-relaxed text-ink-muted2">เปิดกระดิ่งแล้วจะได้รู้ทันที — <b className="text-ink">รอบพรีใหม่ · ของถึงไทย · โปรโมชั่น</b> ไม่ต้องคอยเช็กเอง</div>

            {/* ขั้นที่ 1: ติดตั้ง (เฉพาะมือถือ) */}
            {isMobile && (
              <Step done={installed} n={1} title="ติดตั้งลงหน้าจอโทรศัพท์">
                {installed ? (
                  <div className="text-[12px] text-[#4ade80]">ติดตั้งแล้ว ✓</div>
                ) : platform === 'ios' ? (
                  <>
                    <IosInstallVisual />
                    <ol className="ml-4 list-decimal space-y-0.5 text-[12px] leading-relaxed text-ink-muted2">
                      <li>แตะปุ่ม <b className="text-ink">แชร์</b> ด้านล่างจอ Safari</li>
                      <li>เลื่อนหา <b className="text-ink">“เพิ่มลงในหน้าจอโฮม”</b></li>
                      <li>เปิด <b className="text-ink">Ryuma</b> จากไอคอนบนหน้าจอ แล้วมากดเปิดกระดิ่ง</li>
                    </ol>
                  </>
                ) : deferred ? (
                  <>
                    <button onClick={doInstall} className="mb-1.5 rounded-lg bg-[#2563eb] px-4 py-2 text-[13px] font-bold text-white">📲 ติดตั้งแอปเลย (แตะเดียว)</button>
                    <div className="text-[11px] text-ink-faint">ติดตั้งเสร็จ → เปิด Ryuma จากไอคอนบนหน้าจอ แล้วมากดเปิดกระดิ่ง</div>
                  </>
                ) : (
                  <>
                    <AndroidInstallVisual />
                    <ol className="ml-4 list-decimal space-y-0.5 text-[12px] leading-relaxed text-ink-muted2">
                      <li>แตะเมนู <b className="text-ink">⋮</b> มุมขวาบนของ Chrome</li>
                      <li>เลือก <b className="text-ink">“ติดตั้งแอป” / “เพิ่มลงในหน้าจอหลัก”</b></li>
                      <li>เปิด <b className="text-ink">Ryuma</b> จากไอคอน แล้วมากดเปิดกระดิ่ง</li>
                    </ol>
                  </>
                )}
              </Step>
            )}

            {/* ขั้นเปิดกระดิ่ง — บนมือถือ ล็อกไว้จนกว่าจะติดตั้ง + เปิดจากไอคอน (install-first) */}
            <Step done={bellOn} n={isMobile ? 2 : 1} title="เปิดกระดิ่งแจ้งเตือน" locked={bellBlocked}>
              {bellOn ? (
                <div className="text-[12px] text-[#4ade80]">เปิดอยู่แล้ว ✓ เยี่ยมมาก!</div>
              ) : bellBlocked ? (
                <div className="text-[12px] leading-relaxed text-[#fbbf24]">🔒 ทำขั้นที่ 1 ให้เสร็จก่อน แล้ว<b className="text-ink">เปิด Ryuma จากไอคอน</b>บนหน้าจอ จึงจะกดเปิดกระดิ่งได้</div>
              ) : (
                <button onClick={doBell} disabled={busy} className="rounded-lg bg-[#16a34a] px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50">{busy ? 'กำลังเปิด…' : '🔔 เปิดกระดิ่งเลย'}</button>
              )}
            </Step>

            <button onClick={closeModal} className="mt-4 w-full rounded-xl border border-subtle bg-surface-3 py-2.5 text-[13px] font-semibold text-ink-muted2">
              {installed && bellOn ? 'เรียบร้อย ปิดเลย' : 'ไว้ทีหลัง'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Step({ n, title, done, locked, children }: { n: number; title: string; done: boolean; locked?: boolean; children: React.ReactNode }) {
  return (
    <div className={cx('mb-3 flex gap-3 rounded-xl border border-subtle bg-surface-3/50 p-3', locked && 'opacity-70')}>
      <span className={cx('grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-bold', done ? 'bg-[#16a34a] text-white' : locked ? 'bg-surface-4 text-ink-faint' : 'bg-surface-4 text-ink-muted2')}>{done ? '✓' : locked ? '🔒' : n}</span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-[13px] font-bold">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** iOS: illustrate แชร์ → เพิ่มลงในหน้าจอโฮม (the two taps users can't find). Inline SVG = self-contained
 *  (works offline in the PWA, CSP-safe, no external asset). */
function IosInstallVisual() {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border border-[#2563eb]/35 bg-[#2563eb]/[0.08] p-2.5">
      <div className="flex flex-col items-center gap-1">
        <div className="grid h-10 w-10 place-items-center rounded-xl border border-[#2563eb]/50 bg-[#2563eb]/[0.14]">
          <svg width="18" height="22" viewBox="0 0 18 22" fill="none" aria-hidden>
            <path d="M9 2 L9 13" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M5.5 5 L9 1.8 L12.5 5" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 9 H3.2 A1.7 1.7 0 0 0 1.5 10.7 V18.3 A1.7 1.7 0 0 0 3.2 20 H14.8 A1.7 1.7 0 0 0 16.5 18.3 V10.7 A1.7 1.7 0 0 0 14.8 9 H14" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </div>
        <span className="text-[9.5px] font-bold text-[#93c5fd]">1. แชร์</span>
      </div>
      <Icon name="plus" size={13} className="shrink-0 rotate-90 text-ink-faint" />
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-ink-faint text-ink-muted2">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
            <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M7 4 V10 M4 7 H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="text-[11px] font-semibold leading-tight">2. เพิ่มลงในหน้าจอโฮม</span>
      </div>
    </div>
  );
}

/** Android (no native prompt): illustrate เมนู ⋮ → ติดตั้งแอป. */
function AndroidInstallVisual() {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border border-[#2563eb]/35 bg-[#2563eb]/[0.08] p-2.5">
      <div className="flex flex-col items-center gap-1">
        <div className="grid h-10 w-10 place-items-center rounded-xl border border-[#2563eb]/50 bg-[#2563eb]/[0.14] text-lg font-black leading-none text-[#60a5fa]">⋮</div>
        <span className="text-[9.5px] font-bold text-[#93c5fd]">1. เมนู</span>
      </div>
      <Icon name="plus" size={13} className="shrink-0 rotate-90 text-ink-faint" />
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-ink-faint text-ink-muted2">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
            <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M7 4 V10 M4 7 H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="text-[11px] font-semibold leading-tight">2. ติดตั้งแอป</span>
      </div>
    </div>
  );
}
