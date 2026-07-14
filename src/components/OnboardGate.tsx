'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/state/ToastProvider';
import { detectPlatform, isStandalone, inAppBrowser, type Platform, type InAppKind } from '@/lib/pwa';
import { copyText } from '@/lib/clipboard';
import { PublicLanding } from './PublicLanding';
import { Icon } from './Icon';
import { cx } from './ui';

/**
 * First-touch onboarding for a NEW (anonymous) visitor — get the app onto the home screen BEFORE signup
 * (ryuma-push-adoption). Decides by device:
 *  - in-app browser (LINE/FB/IG webview): can't install/push → "เปิดใน Safari/Chrome ก่อน"
 *  - mobile browser, not installed: "ติดตั้งลงหน้าจอก่อน" (soft — a skip link proceeds to signup)
 *  - installed (standalone) / desktop / already-skipped: the normal login/signup landing
 * Only mounts for anonymous users (CustomerShell gates on !isLoggedIn). Client-only detection → renders a
 * splash for one tick to avoid a hydration mismatch / wrong-screen flash.
 */

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const SKIP_KEY = 'ryuma_onboard_skip';         // install screen: persistent skip (informed choice)
const INAPP_SKIP_KEY = 'ryuma_onboard_inapp';  // webview screen: per-session skip only

type Screen = 'wait' | 'inapp' | 'install' | 'landing';

export function OnboardGate() {
  const [screen, setScreen] = useState<Screen>('wait');
  const [platform, setPlatform] = useState<Platform>('desktop');
  const [kind, setKind] = useState<InAppKind | undefined>();
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);

  useEffect(() => {
    const onBIP = (e: Event) => { e.preventDefault(); setDeferred(e as BIPEvent); };
    window.addEventListener('beforeinstallprompt', onBIP);

    // Never TRAP a visitor on the splash: any detection error falls back to the normal landing so they
    // can always reach login/signup. Also a hard safety timeout in case the effect stalls somehow.
    const safety = setTimeout(() => setScreen((s) => (s === 'wait' ? 'landing' : s)), 4000);
    try {
      const p = detectPlatform();
      setPlatform(p);
      const { inApp, kind: k } = inAppBrowser();
      if (isStandalone() || p === 'desktop') setScreen('landing');           // installed / desktop → normal
      else if (inApp && sessionStorage.getItem(INAPP_SKIP_KEY) !== '1') { setKind(k); setScreen('inapp'); }
      else if (localStorage.getItem(SKIP_KEY) === '1') setScreen('landing'); // they chose to skip before
      else setScreen('install');                                            // mobile browser, not installed
    } catch {
      setScreen('landing');
    }

    return () => { clearTimeout(safety); window.removeEventListener('beforeinstallprompt', onBIP); };
  }, []);

  if (screen === 'wait') return <Splash />;
  if (screen === 'inapp') return <OpenInBrowser kind={kind} platform={platform} onSkip={() => { sessionStorage.setItem(INAPP_SKIP_KEY, '1'); setScreen('landing'); }} />;
  if (screen === 'install') return <InstallFirst platform={platform} deferred={deferred} onInstalled={() => setScreen('landing')} onSkip={() => { localStorage.setItem(SKIP_KEY, '1'); setScreen('landing'); }} />;
  return <PublicLanding />;
}

function Splash() {
  return <div className="grid min-h-screen place-items-center bg-base"><img src="/ryuma-logo.png" alt="" width={44} height={44} className="animate-pulse rounded-xl opacity-80" /></div>;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-base px-6 py-10 font-sans text-ink">
      <div className="w-full max-w-[400px]">
        <div className="mb-5 flex flex-col items-center text-center">
          <img src="/ryuma-logo.png" alt="Ryuma" width={56} height={56} className="mb-2.5 rounded-2xl" />
        </div>
        {children}
      </div>
    </div>
  );
}

/** LINE/FB/IG webview → reopen in the real browser (only place install + push work).
 *  Android: an intent:// link escapes the webview to the default browser in ONE tap.
 *  iOS: Apple gives NO way to open Safari from a webview → guide to the app's ⋯ menu + offer copy-link.
 *  The ⋯/menu button sits at the RIGHT — but top or bottom depends on the app/OS, so we don't hard-code it. */
function OpenInBrowser({ kind, platform, onSkip }: { kind?: InAppKind; platform: Platform; onSkip: () => void }) {
  const { flash } = useToast();
  const appName = kind === 'line' ? 'LINE' : kind === 'facebook' ? 'Facebook' : kind === 'instagram' ? 'Instagram' : 'แอปนี้';
  const host = typeof window !== 'undefined' ? window.location.host : 'ryumatoy.vercel.app';
  const path = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';
  const httpsUrl = `https://${host}${path}`;
  const androidIntent = `intent://${host}${path}#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(httpsUrl)};end`;
  const browser = platform === 'ios' ? 'Safari' : 'Chrome';
  return (
    <Frame>
      <div className="rounded-3xl border border-subtle bg-surface-2 p-6">
        <div className="mb-1 text-center text-xl font-extrabold">เปิดใน {browser} ก่อนนะ 🌐</div>
        <div className="mb-4 text-center text-[13px] leading-relaxed text-ink-muted2">ตอนนี้เปิดจาก{appName} — ในนี้<b className="text-ink"> ลงหน้าจอ + รับแจ้งเตือนไม่ได้</b> เปิดในเบราว์เซอร์แล้วใช้ได้เต็มที่</div>

        {platform === 'android' ? (
          <>
            {/* Android: one-tap escape to the default browser */}
            <a href={androidIntent} className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl bg-[#2563eb] py-3.5 text-sm font-bold text-white">
              <Icon name="share" size={17} /> เปิดใน Chrome เลย (แตะเดียว)
            </a>
            <div className="text-center text-[11.5px] leading-relaxed text-ink-faint">ถ้าไม่เด้ง → แตะปุ่ม <b className="text-ink">⋯ / เมนู</b> (มุมขวา บนหรือล่าง) → <b className="text-ink">“เปิดในเบราว์เซอร์”</b></div>
          </>
        ) : (
          <>
            {/* iOS: can't auto-open Safari → guide to the app's own menu */}
            <div className="mb-3 rounded-xl border border-[#2563eb]/35 bg-[#2563eb]/[0.08] p-3.5">
              <div className="mb-1.5 text-[12px] font-bold text-[#bcd3f5]">วิธีเปิดใน Safari (2 ขั้น)</div>
              <ol className="ml-4 list-decimal space-y-1 text-[12.5px] leading-relaxed text-ink-muted2">
                <li>แตะปุ่ม <b className="text-ink">⋯</b> หรือ <b className="text-ink">เมนู</b> — อยู่<b className="text-ink">มุมขวา</b> (บนหรือล่าง แล้วแต่แอป)</li>
                <li>เลือก <b className="text-ink">“เปิดในเบราว์เซอร์” / “เปิดใน Safari”</b></li>
              </ol>
            </div>
            <button
              onClick={async () => flash((await copyText(httpsUrl)) ? 'คัดลอกลิงก์แล้ว ✓ เปิด Safari แล้ววางได้เลย' : 'คัดลอกไม่สำเร็จ')}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-subtle bg-surface-3 py-2.5 text-[13px] font-bold text-ink-muted2"
            >
              <Icon name="copy" size={16} /> หรือ คัดลอกลิงก์ไปวางเอง
            </button>
          </>
        )}

        <button onClick={onSkip} className="mt-3 w-full text-center text-[12.5px] font-semibold text-ink-faint">ข้ามไปก่อน (ดู/สมัครในนี้) →</button>
      </div>
    </Frame>
  );
}

/** Mobile browser, not installed → push install to home screen first, with a soft skip. */
function InstallFirst({ platform, deferred, onInstalled, onSkip }: { platform: Platform; deferred: BIPEvent | null; onInstalled: () => void; onSkip: () => void }) {
  const { flash } = useToast();
  const doInstall = async () => {
    if (!deferred) return;
    try { await deferred.prompt(); const c = await deferred.userChoice; if (c.outcome === 'accepted') { flash('กำลังติดตั้ง… เปิด Ryuma จากไอคอนได้เลย'); onInstalled(); } } catch { /* dismissed */ }
  };
  return (
    <Frame>
      <div className="rounded-3xl border border-subtle bg-surface-2 p-6">
        <div className="mb-1 text-center text-xl font-extrabold">ติดตั้ง Ryuma ลงหน้าจอก่อน 📲</div>
        <div className="mb-4 text-center text-[13px] leading-relaxed text-ink-muted2">เปิดเร็วเหมือนแอปจริง + <b className="text-ink">รับแจ้งเตือนรอบพรีใหม่ / ของถึงไทย ก่อนใคร</b></div>

        {platform === 'ios' ? (
          <InstallSteps steps={[
            { glyph: 'share', title: 'แตะปุ่ม แชร์', sub: 'ไอคอนสี่เหลี่ยมมีลูกศรขึ้น ด้านล่างจอ Safari' },
            { glyph: 'add', title: 'เลือก “เพิ่มลงในหน้าจอโฮม”', sub: 'เลื่อนหาในเมนูที่เด้งขึ้นมา' },
            { glyph: 'ryuma', title: 'เปิด Ryuma จากไอคอน', sub: 'แล้วมาสมัคร + เปิดกระดิ่งต่อได้เลย' },
          ]} />
        ) : deferred ? (
          <>
            <button onClick={doInstall} className="mb-2 w-full rounded-xl bg-[#2563eb] py-3 text-sm font-bold text-white">📲 ติดตั้งเลย (แตะเดียว)</button>
            <div className="text-center text-[12px] text-ink-faint">ติดตั้งเสร็จ → เปิด Ryuma จากไอคอน แล้วสมัคร + เปิดกระดิ่ง</div>
          </>
        ) : (
          <InstallSteps steps={[
            { glyph: 'menu', title: 'แตะเมนู ⋮ มุมขวาบน', sub: 'ของ Chrome' },
            { glyph: 'add', title: 'เลือก “ติดตั้งแอป”', sub: 'หรือ “เพิ่มลงในหน้าจอหลัก”' },
            { glyph: 'ryuma', title: 'เปิด Ryuma จากไอคอน', sub: 'แล้วมาสมัคร + เปิดกระดิ่งต่อได้เลย' },
          ]} />
        )}

        <button onClick={onSkip} className="mt-4 w-full text-center text-[12.5px] font-semibold text-ink-faint">ข้ามไปสมัครในเว็บ →</button>
      </div>
    </Frame>
  );
}

type Glyph = 'share' | 'add' | 'ryuma' | 'menu';

function InstallSteps({ steps }: { steps: { glyph: Glyph; title: string; sub: string }[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-3/50 p-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#b91c1c] text-[12px] font-bold text-white">{i + 1}</span>
          <StepGlyph glyph={s.glyph} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold leading-tight">{s.title}</div>
            <div className="text-[11px] leading-tight text-ink-faint">{s.sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function StepGlyph({ glyph }: { glyph: Glyph }) {
  const box = 'grid h-10 w-10 shrink-0 place-items-center rounded-xl border';
  if (glyph === 'share') return (
    <span className={cx(box, 'border-[#2563eb]/50 bg-[#2563eb]/[0.14] text-[#60a5fa]')}>
      <svg width="18" height="22" viewBox="0 0 18 22" fill="none" aria-hidden>
        <path d="M9 2 L9 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M5.5 5 L9 1.8 L12.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 9 H3.2 A1.7 1.7 0 0 0 1.5 10.7 V18.3 A1.7 1.7 0 0 0 3.2 20 H14.8 A1.7 1.7 0 0 0 16.5 18.3 V10.7 A1.7 1.7 0 0 0 14.8 9 H14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
  if (glyph === 'add') return (
    <span className={cx(box, 'border-ink-faint text-ink-muted2')}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 5 V11 M5 8 H11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    </span>
  );
  if (glyph === 'menu') return (
    <span className={cx(box, 'border-[#2563eb]/50 bg-[#2563eb]/[0.14] text-lg font-black leading-none text-[#60a5fa]')}>⋮</span>
  );
  return <img src="/ryuma-logo.png" alt="Ryuma" width={40} height={40} className={cx(box, 'border-subtle object-cover p-0')} />;
}
