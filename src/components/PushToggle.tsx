'use client';

import { useEffect, useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { pushSupported, currentPushSubscription, enablePush, disablePush } from '@/lib/push';
import { detectPlatform, isStandalone, inAppBrowser } from '@/lib/pwa';
import { setPushPrefs } from '@/data/mutations';
import { Icon } from './Icon';
import { cx } from './ui';

/** Profile menu row: turn Web-Push notifications on/off for THIS device.
 *  iOS shows a hint until the site is installed to the Home Screen (Safari has no Notification API). */
export function PushToggle({ userId, divider }: { userId: string; divider?: boolean }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [state, setState] = useState<'loading' | 'unsupported' | 'off' | 'on'>('loading');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('iPhone: กด แชร์ → เพิ่มลงหน้าจอโฮม แล้วเปิดจากไอคอนก่อน');

  // "on" means the browser holds a subscription AND that endpoint is saved under MY account —
  // a leftover subscription from a previous login on a shared device must read as "off"
  // (RLS: I only see my own rows, so a plain some() is exactly the ownership check).
  const myEndpoints = db.pushSubscriptions.filter((s) => s.user_id === userId).map((s) => s.endpoint);
  // ติดตั้งแล้วหรือยัง (จาก DB — จำได้ข้ามเบราว์เซอร์: กันเคสลูกค้าติดตั้งแล้วแต่เปิดผ่าน Messenger/Safari
  // แล้วงงว่าทำไม "ไม่รองรับ" — เคส Peerapat 2026-07-23)
  const installedBefore = !!db.users.find((u) => u.id === userId)?.installed_at;
  useEffect(() => {
    if (!pushSupported()) {
      setState('unsupported');
      // ข้อความชี้ทางตามสถานการณ์จริง — ไม่ใช่ประโยคเดียวเหมาทุกเคส
      const { inApp } = inAppBrowser();
      if (isStandalone()) setHint('iOS ของเครื่องเก่าเกินไป — อัปเดต iOS (ตั้งค่า → ทั่วไป → อัปเดตซอฟต์แวร์) แล้วลองใหม่');
      else if (inApp && installedBefore) setHint('คุณติดตั้งแล้ว ✓ — หน้านี้เปิดจาก Messenger/LINE เปิดกระดิ่งไม่ได้ · ปิดหน้านี้ แล้วเปิดจากไอคอน Ryuma บนหน้าจอ');
      else if (inApp) setHint('หน้านี้เปิดจาก Messenger/LINE — เปิดใน Safari/Chrome ก่อน แล้วเพิ่มลงหน้าจอโฮม');
      else if (installedBefore) setHint('คุณติดตั้งแล้ว ✓ — ปิดหน้านี้ แล้วเปิดจากไอคอน Ryuma บนหน้าจอ ค่อยกดเปิดกระดิ่ง');
      else setHint(detectPlatform() === 'ios' ? 'iPhone: กด แชร์ → เพิ่มลงหน้าจอโฮม แล้วเปิดจากไอคอนก่อน' : 'เพิ่ม Ryuma ลงหน้าจอโฮม แล้วเปิดจากไอคอนก่อน');
      return;
    }
    currentPushSubscription()
      .then((s) => setState(s && myEndpoints.includes(s.endpoint) ? 'on' : 'off'))
      .catch(() => setState('off'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, myEndpoints.join('|'), installedBefore]);

  const toggle = async () => {
    if (busy || state === 'loading' || state === 'unsupported') return;
    setBusy(true);
    try {
      if (state === 'on') { await disablePush(dispatch); setState('off'); flash('ปิดการแจ้งเตือนเครื่องนี้แล้ว'); }
      else { await enablePush(userId, dispatch); setState('on'); flash('เปิดการแจ้งเตือนแล้ว 🔔'); }
    } catch (e) {
      flash((e as Error).message === 'denied' ? 'ไม่ได้รับอนุญาต — เปิดได้ใน ตั้งค่า > การแจ้งเตือน' : 'เปิดการแจ้งเตือนไม่สำเร็จ');
    } finally { setBusy(false); }
  };

  return (
    <div className={cx(divider && 'border-t border-hair')}>
      <button onClick={toggle} className={cx('flex w-full items-center gap-3 px-4 py-3.5 text-left', state === 'unsupported' && 'opacity-60')}>
        <Icon name="bell" size={20} className={state === 'on' ? 'text-[#4ade80]' : 'text-primary-soft'} />
        <span className="flex-1">
          <span className="block text-sm font-medium">การแจ้งเตือน</span>
          {state === 'unsupported' && <span className={cx('block text-[10.5px]', hint.includes('ติดตั้งแล้ว ✓') ? 'font-semibold text-[#fbbf24]' : 'text-ink-faint')}>{hint}</span>}
        </span>
        {state === 'loading' || busy ? (
          <span className="text-[11px] text-ink-faint">…</span>
        ) : state === 'unsupported' ? (
          <span className="rounded-md bg-surface-3 px-2 py-0.5 text-[10.5px] text-ink-faint">ไม่รองรับ</span>
        ) : (
          <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-bold', state === 'on' ? 'bg-[#16a34a]/[0.16] text-[#4ade80]' : 'bg-surface-3 text-ink-faint')}>
            {state === 'on' ? 'เปิดอยู่' : 'ปิดอยู่'}
          </span>
        )}
      </button>
      {state === 'on' && <PushPrefsPanel userId={userId} />}
    </div>
  );
}

/** ปิดรับข่าว "สินค้าใหม่" เฉพาะค่าย/เรื่องที่ไม่อยากได้ — ค่าเริ่มต้น = รับทุกอย่าง (รวมค่าย/เรื่องที่เพิ่มใหม่
 *  ในอนาคตด้วย). ปิดอันไหน = ตัวนั้นไม่เด้ง. ของส่วนตัว (อนุมัติ/พัสดุ/คูปอง) แจ้งเสมอ ไม่เกี่ยวกับตัวกรองนี้. */
function PushPrefsPanel({ userId }: { userId: string }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [open, setOpen] = useState(false);
  const pref = db.pushPrefs.find((p) => p.user_id === userId);
  const mutedMakers = pref?.maker_ids ?? [];       // OPT-OUT: these lists hold what's turned OFF
  const mutedFranchises = pref?.franchise_ids ?? [];
  const mutedCount = mutedMakers.length + mutedFranchises.length;

  const save = (m: string[], f: string[]) => { dispatch(setPushPrefs(userId, m, f)); };
  const toggleIn = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  // chip ON (green) = กำลังรับ ; chip OFF (dim) = ปิดแล้ว
  const chip = (receiving: boolean) => cx('rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors', receiving ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.14] text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-faint line-through opacity-70');

  return (
    <div className="border-t border-hair bg-surface-3/30 px-4 py-2.5">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between text-left">
        <span className="text-[12px] font-semibold text-ink-muted">ข่าวสินค้าใหม่: {mutedCount === 0 ? 'รับทุกค่าย · ทุกเรื่อง' : `ปิด ${mutedMakers.length} ค่าย · ${mutedFranchises.length} เรื่อง`}</span>
        <span className={cx('text-[11px] text-ink-faint transition-transform', open && 'rotate-180')}>▾</span>
      </button>
      {open && (
        <div className="mt-2.5 flex flex-col gap-2.5 pb-1">
          <div className="rounded-lg border border-subtle bg-surface-3/60 px-3 py-2 text-[10.5px] leading-relaxed text-ink-faint">แตะเพื่อ <b className="text-[#4ade80]">ปิด</b> ค่าย/เรื่องที่ไม่อยากรับข่าวสินค้าใหม่ · ค่าเริ่มต้นรับทุกอย่าง (ค่าย/เรื่องที่เพิ่มใหม่ก็รับอัตโนมัติ)</div>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-ink-faint">ค่าย</div>
            <div className="flex flex-wrap gap-1.5">
              {db.manufacturers.map((m) => {
                const receiving = !mutedMakers.includes(m.id);
                return <button key={m.id} onClick={() => save(toggleIn(mutedMakers, m.id), mutedFranchises)} className={chip(receiving)}>{receiving ? '🔔 ' : '🔕 '}{m.name}</button>;
              })}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-ink-faint">เรื่อง</div>
            <div className="flex flex-wrap gap-1.5">
              {db.franchises.map((f) => {
                const receiving = !mutedFranchises.includes(f.id);
                return <button key={f.id} onClick={() => save(mutedMakers, toggleIn(mutedFranchises, f.id))} className={chip(receiving)}>{receiving ? '🔔 ' : '🔕 '}{f.name}</button>;
              })}
            </div>
          </div>
          {mutedCount > 0 && <button onClick={() => { save([], []); flash('เปิดรับทั้งหมดแล้ว 🔔'); }} className="self-start text-[11.5px] font-semibold text-primary-soft">เปิดรับทั้งหมด</button>}
          <div className="text-[10.5px] leading-relaxed text-ink-faint">มีผลเฉพาะข่าว “สินค้าเข้าใหม่” — สถานะของที่คุณพรี/คูปอง/พัสดุ แจ้งเตือนเสมอ</div>
        </div>
      )}
    </div>
  );
}
