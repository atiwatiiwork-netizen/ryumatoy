'use client';

import { useEffect, useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { pushSupported, currentPushSubscription, enablePush, disablePush } from '@/lib/push';
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
    <div className={cx(divider && 'border-t border-hair')}>
      <button onClick={toggle} className={cx('flex w-full items-center gap-3 px-4 py-3.5 text-left', state === 'unsupported' && 'opacity-60')}>
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
      {state === 'on' && <PushPrefsPanel userId={userId} />}
    </div>
  );
}

/** เลือกได้ว่าจะรับข่าว "สินค้าใหม่" เฉพาะค่าย/เรื่องไหน — ไม่เลือกเลย = รับทั้งหมด (ค่าเริ่มต้น).
 *  ของส่วนตัว (อนุมัติ/พัสดุ/คูปอง) แจ้งเสมอ ไม่เกี่ยวกับตัวกรองนี้. */
function PushPrefsPanel({ userId }: { userId: string }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [open, setOpen] = useState(false);
  const pref = db.pushPrefs.find((p) => p.user_id === userId);
  const makers = pref?.maker_ids ?? [];
  const franchises = pref?.franchise_ids ?? [];
  const isAll = makers.length === 0 && franchises.length === 0;

  const save = (m: string[], f: string[]) => { dispatch(setPushPrefs(userId, m, f)); };
  const toggleIn = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  const chip = (on: boolean) => cx('rounded-full border px-3 py-1.5 text-[12px] font-semibold', on ? 'border-accent bg-[#b91c1c]/[0.16] text-primary-soft' : 'border-subtle bg-surface-3 text-ink-muted2');

  return (
    <div className="border-t border-hair bg-surface-3/30 px-4 py-2.5">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between text-left">
        <span className="text-[12px] font-semibold text-ink-muted">ข่าวสินค้าใหม่: {isAll ? 'รับทุกค่าย · ทุกเรื่อง' : [makers.length ? `${makers.length} ค่าย` : 'ทุกค่าย', franchises.length ? `${franchises.length} เรื่อง` : 'ทุกเรื่อง'].join(' · ')}</span>
        <span className={cx('text-[11px] text-ink-faint transition-transform', open && 'rotate-180')}>▾</span>
      </button>
      {open && (
        <div className="mt-2.5 flex flex-col gap-2.5 pb-1">
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-ink-faint">เฉพาะค่าย (ไม่เลือก = ทุกค่าย)</div>
            <div className="flex flex-wrap gap-1.5">
              {db.manufacturers.map((m) => (
                <button key={m.id} onClick={() => save(toggleIn(makers, m.id), franchises)} className={chip(makers.includes(m.id))}>{makers.includes(m.id) && '✓ '}{m.name}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-ink-faint">เฉพาะเรื่อง (ไม่เลือก = ทุกเรื่อง)</div>
            <div className="flex flex-wrap gap-1.5">
              {db.franchises.map((f) => (
                <button key={f.id} onClick={() => save(makers, toggleIn(franchises, f.id))} className={chip(franchises.includes(f.id))}>{franchises.includes(f.id) && '✓ '}{f.name}</button>
              ))}
            </div>
          </div>
          {!isAll && <button onClick={() => { save([], []); flash('กลับเป็นรับทั้งหมดแล้ว'); }} className="self-start text-[11.5px] font-semibold text-primary-soft">รับทั้งหมด (ล้างตัวกรอง)</button>}
          <div className="text-[10.5px] leading-relaxed text-ink-faint">มีผลเฉพาะข่าว “สินค้าเข้าใหม่” — สถานะของที่คุณพรี/คูปอง/พัสดุ แจ้งเตือนเสมอ</div>
        </div>
      )}
    </div>
  );
}
