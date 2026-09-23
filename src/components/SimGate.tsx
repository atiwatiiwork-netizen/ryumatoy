'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useDatabase, StoreOverride } from '@/state/DataProvider';
import { useAuth, AuthOverride } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { store, type Store, type Mutation } from '@/data/store';
import { simulateAfterLaunch } from '@/data/mutations';
import { isAdminUser } from '@/domain/services/admins';
import { POINTS_LAUNCH_KEY } from '@/domain/services/points';
import { SIM_KEY, SIM_BLOCKED, setSimActive, type SimInfo } from '@/lib/sim';
import type { Database } from '@/domain/entities';

/**
 * โหมดจำลอง "ดูเป็นลูกค้า" (เจ้าของ 2026-09-23) — ห่อ layout ลูกค้า
 *   เปิด: แอดมินกดปุ่มใน /admin/points (หรือ /wallet?sim=<userId>) → จำไว้ใน sessionStorage ข้ามหน้าได้ ปิดแท็บ = หาย
 *   ข้างใน: หน้าลูกค้าจริงทุกหน้า (ไม่ก๊อป UI) อ่าน db จำลอง = ข้อมูลจริง + "หลังเปิดระบบคะแนน" (launchPointsPreOnly บนสำเนา
 *           ถ้ายังไม่เปิด) · ตัวตน = ลูกค้าคนนั้น (ไม่ใช่แอดมิน) · เขียนอะไร = ไม่บันทึก (toast) · lib ที่มีผลภายนอกถูกบล็อกด้วยธง sim
 *   เปิดได้เฉพาะแอดมินจริง — ลูกค้าใส่ ?sim= เองไม่มีผล
 */
const SimContext = createContext<SimInfo | null>(null);
export const useSim = () => useContext(SimContext);

/** หน้าที่ "มีผลจริงตั้งแต่เปิด" (จองสต๊อก/ส่งเรื่อง/ประมูล) — ในโหมดจำลองแสดงป้ายแทน */
const BLOCKED_PREFIXES = ['/checkout', '/sourcing', '/auction', '/plans'];

function makeSimStore(sim: Database, onBlocked: () => void): Store {
  return {
    subscribe: store.subscribe,
    getState: () => sim,
    isReady: store.isReady,
    init: async () => {},
    // รันเพื่อดูว่า "จะเปลี่ยนอะไรไหม" แล้วทิ้ง — read-back (คืน d เดิม) ไม่เตือน · เขียนจริง = เตือนว่าไม่บันทึก
    update: (m: Mutation) => { if (m(sim) !== sim) onBlocked(); return sim; },
    flush: async () => null,
    reload: async () => {},
    reloadIfIdle: async () => {},
  } as unknown as Store;
}

export function SimGate({ children }: { children: ReactNode }) {
  const realDb = useDatabase();
  const auth = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { flash } = useToast();
  const [uid, setUid] = useState<string | null>(null);

  // อ่าน ?sim= (ตั้ง/ปิด) + sessionStorage ทุกครั้งที่เปลี่ยนหน้า
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('sim');
      if (q === 'off') sessionStorage.removeItem(SIM_KEY);
      else if (q) sessionStorage.setItem(SIM_KEY, q);
      setUid(sessionStorage.getItem(SIM_KEY));
    } catch { setUid(null); }
  }, [pathname]);

  const isAdmin = auth.isAdmin || isAdminUser(realDb, auth.currentUserId);
  // ?sim= รับได้ทั้ง user id หรือ "ชื่อ" (เช่น ?sim=Taweesin) — ชื่อต้องเจอคนเดียว ไม่งั้นไม่เปิด (กันดูผิดคน)
  const target = useMemo(() => {
    if (!uid) return undefined;
    const byId = realDb.users.find((u) => u.id === uid);
    if (byId) return byId;
    const q = uid.trim().toLowerCase();
    const hits = realDb.users.filter((u) => (u.display_name ?? '').toLowerCase().includes(q));
    return hits.length === 1 ? hits[0] : undefined;
  }, [uid, realDb.users]);
  const info: SimInfo | null = isAdmin && target ? { uid: target.id, name: target.display_name } : null;
  // ธงต้องตั้ง "ก่อน" effect ของหน้าลูก (effect ลูกรันก่อนพ่อ) → ตั้งตอน render (idempotent) ล้างตอนปิด/unmount
  if (info) setSimActive(info);
  useEffect(() => { if (!info) setSimActive(null); return () => setSimActive(null); }, [info?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ข้อมูลจำลอง: ถ้ายังไม่เปิดระบบคะแนน → รันเปิดตัวจริงบนสำเนา (แต้มย้อนหลังของคนนี้ + ป๊อปอัป) ไม่บันทึก
  const simDb = useMemo(() => {
    if (!info) return null;
    if (realDb.settings.points_enabled) return realDb;
    const d = simulateAfterLaunch('sim')(realDb);
    // วันเปิดตัวจำลองต้องคงที่ข้ามการโหลดหน้า — ไม่งั้น "ปิดป๊อปอัปแล้ว" ไม่มีวันตรง → เด้งทุกหน้า (เจอจากการทดสอบ 2026-09-23)
    return { ...d, appConfig: d.appConfig.map((c) => (c.key === POINTS_LAUNCH_KEY ? { ...c, value: { at: 'sim-preview', by: 'sim' } } : c)) };
  }, [info?.uid, realDb]); // eslint-disable-line react-hooks/exhaustive-deps
  const simStore = useMemo(() => (simDb ? makeSimStore(simDb, () => flash(SIM_BLOCKED)) : null), [simDb, flash]);

  const exit = () => {
    try { sessionStorage.removeItem(SIM_KEY); } catch { /* ignore */ }
    setSimActive(null);
    setUid(null);
    router.push('/admin/points');
  };
  const replayPopup = () => {
    if (!info) return;
    try { localStorage.removeItem(`ryuma_points_launch_seen_${info.uid}`); } catch { /* ignore */ }
    window.location.reload();
  };

  return (
    <SimContext.Provider value={info}>
      <StoreOverride value={simStore}>
        <AuthOverride userId={info?.uid ?? null}>
          {info && (
            <div className="fixed left-1/2 top-2 z-[115] flex max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-2 rounded-full border border-[#d4af37]/60 bg-black/85 px-3 py-1.5 text-[11.5px] text-[#f1d27a] shadow-lg backdrop-blur">
              <span className="truncate">👁 จำลอง: <b className="text-white">{info.name}</b>{realDb.settings.points_enabled ? '' : ' · หลังเปิดคะแนน'} · ไม่บันทึกจริง</span>
              <button onClick={replayPopup} className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 font-bold">ป๊อปอัป</button>
              <button onClick={exit} className="shrink-0 rounded-full bg-[#b91c1c] px-2 py-0.5 font-bold text-white">ออก</button>
            </div>
          )}
          {children}
        </AuthOverride>
      </StoreOverride>
    </SimContext.Provider>
  );
}

/** ใส่ใน layout รอบ "เนื้อหาหน้า" (ข้างใน CustomerShell) — ในโหมดจำลอง หน้าที่มีผลจริงตั้งแต่เปิดโชว์ป้ายแทน */
export function SimPageGuard({ children }: { children: ReactNode }) {
  const sim = useSim();
  const pathname = usePathname() ?? '';
  if (sim && BLOCKED_PREFIXES.some((p) => pathname.startsWith(p))) {
    return (
      <div className="mx-auto mt-10 max-w-[420px] rounded-2xl border border-[#d4af37]/40 bg-surface-2 p-6 text-center">
        <div className="text-[30px]">👁</div>
        <div className="mt-2 text-[15px] font-bold">หน้านี้ไม่เปิดในโหมดจำลอง</div>
        <div className="mt-1 text-[12.5px] text-ink-muted2">หน้านี้จองสต๊อก / ส่งเรื่องจริงตั้งแต่เปิด จึงปิดไว้ตอนดูแทน {sim.name}</div>
        <Link href="/wallet" className="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-[13px] font-bold text-white">กลับกระเป๋าพรี</Link>
      </div>
    );
  }
  return <>{children}</>;
}
