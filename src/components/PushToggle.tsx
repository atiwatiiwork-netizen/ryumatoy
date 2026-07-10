'use client';

import { useEffect, useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { pushSupported, currentPushSubscription, enablePush, disablePush } from '@/lib/push';
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

  // "on" means the browser holds a subscription AND that endpoint is saved under MY account —
  // a leftover subscription from a previous login on a shared device must read as "off"
  // (RLS: I only see my own rows, so a plain some() is exactly the ownership check).
  const myEndpoints = db.pushSubscriptions.filter((s) => s.user_id === userId).map((s) => s.endpoint);
  useEffect(() => {
    if (!pushSupported()) { setState('unsupported'); return; }
    currentPushSubscription()
      .then((s) => setState(s && myEndpoints.includes(s.endpoint) ? 'on' : 'off'))
      .catch(() => setState('off'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, myEndpoints.join('|')]);

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
    <button onClick={toggle} className={cx('flex w-full items-center gap-3 px-4 py-3.5 text-left', divider && 'border-t border-hair', state === 'unsupported' && 'opacity-60')}>
      <Icon name="bell" size={20} className={state === 'on' ? 'text-[#4ade80]' : 'text-primary-soft'} />
      <span className="flex-1">
        <span className="block text-sm font-medium">การแจ้งเตือน</span>
        {state === 'unsupported' && <span className="block text-[10.5px] text-ink-faint">iPhone: กด แชร์ → เพิ่มลงหน้าจอโฮม แล้วเปิดจากไอคอนก่อน</span>}
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
  );
}
