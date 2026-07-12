'use client';

import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { PromoPushPanel } from '@/components/PromoPushPanel';
import { pushEnabled } from '@/lib/push';
import { setPushConfig } from '@/data/mutations';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

/** ทุก trigger ที่ระบบยิงอัตโนมัติ — key ต้องตรงกับที่จุดส่งเช็ค pushEnabled(db, key). */
const TRIGGERS: { key: string; emoji: string; name: string; target: string; note?: string }[] = [
  { key: 'new_preorder', emoji: '🆕', name: 'สินค้าพรีเข้าใหม่', target: 'ทุกเครื่อง (ตามตัวกรองค่าย/เรื่องของลูกค้า)' },
  { key: 'new_instock', emoji: '🟢', name: 'พร้อมส่งเข้าใหม่', target: 'ทุกเครื่อง (ตามตัวกรองค่าย/เรื่องของลูกค้า)' },
  { key: 'lot_shipping', emoji: '🚚', name: 'ล็อตออกเดินทางมาไทย', target: 'เฉพาะคนที่พรีล็อตนั้น', note: 'ชวนเริ่มจ่ายส่วนต่าง' },
  { key: 'lot_arrived', emoji: '📦', name: 'ล็อตถึงไทยแล้ว', target: 'เฉพาะคนที่พรีล็อตนั้น' },
  { key: 'order_approved', emoji: '✅', name: 'อนุมัติออเดอร์ / ออกตั๋ว', target: 'เจ้าของออเดอร์' },
  { key: 'event_reward', emoji: '🎁', name: 'ได้คูปองจากกิจกรรม', target: 'เจ้าของ (ยิงพร้อมอนุมัติเมื่อครบเป้า)' },
  { key: 'order_rejected', emoji: '❌', name: 'สลิปไม่ผ่าน', target: 'เจ้าของออเดอร์' },
  { key: 'rp_approved', emoji: '💚', name: 'รับยอดส่วนต่าง (จ่ายครบ)', target: 'เจ้าของตั๋ว' },
  { key: 'parcel', emoji: '📮', name: 'พัสดุจัดส่ง + Tracking', target: 'เจ้าของตั๋ว' },
  { key: 'coupon_grant', emoji: '🎟️', name: 'แอดมินมอบคูปอง', target: 'ผู้รับ (เฉพาะคนได้ใบใหม่จริง)' },
  { key: 'sourcing_new', emoji: '🔎', name: 'มีเรื่องหาของใหม่ / ส่งเช็คซ้ำ', target: 'เครื่องแอดมิน' },
  { key: 'sourcing_paid', emoji: '💸', name: 'มัดจำหาของเข้า', target: 'เครื่องแอดมิน' },
  { key: 'sourcing_quoted', emoji: '💡', name: 'ตอบราคาหาของ', target: 'เจ้าของเรื่อง' },
  { key: 'sourcing_unavailable', emoji: '🔍', name: 'หาของ: ยังหาไม่ได้', target: 'เจ้าของเรื่อง' },
  { key: 'sourcing_started', emoji: '🔧', name: 'หาของ: เริ่มงานแล้ว', target: 'เจ้าของเรื่อง' },
  { key: 'restock', emoji: '🔥', name: 'ของมาเพิ่ม / เปิดรอบใหม่', target: 'ทุกเครื่อง (ตามตัวกรองค่าย/เรื่องของลูกค้า)' },
  { key: 'warehouse', emoji: '🚢', name: 'ถึงโกดังจีน → กำลังส่งมาไทย', target: 'เจ้าของตั๋วที่ยืนยันโกดัง' },
];

const deviceKind = (ep: string) =>
  ep.includes('web.push.apple.com') ? '📱 iPhone/iPad'
  : ep.includes('fcm.googleapis.com') ? '💻 Chrome/Android'
  : ep.includes('mozilla') ? '🦊 Firefox'
  : ep.includes('windows.com') || ep.includes('notify.windows') ? '🪟 Edge'
  : '🌐 อื่นๆ';

export default function PushControlPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const subs = db.pushSubscriptions;
  const accounts = new Set(subs.map((s) => s.user_id)).size;
  const filtered = db.pushPrefs.length;
  const nameOf = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '—';

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">Push Control</div>
      <div className="mb-5 text-[13px] text-ink-faint">ศูนย์ควบคุมการแจ้งเตือน — เห็นทุก trigger ในระบบ · เปิด/ปิดได้ · ดูเครื่องที่รับ</div>

      {/* stats */}
      <div className="mb-5 grid grid-cols-3 gap-3 lg:max-w-[560px]">
        {[
          { n: subs.length, l: 'เครื่องที่เปิดรับ' },
          { n: accounts, l: 'บัญชี' },
          { n: filtered, l: 'บัญชีที่ตั้งตัวกรอง' },
        ].map((s) => (
          <div key={s.l} className="rounded-2xl border border-subtle bg-surface-2 p-4 text-center">
            <div className="text-2xl font-extrabold text-primary-soft">{s.n}</div>
            <div className="text-[11.5px] text-ink-faint">{s.l}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        {/* trigger catalog + switches */}
        <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="mb-1 font-bold">เหตุการณ์ที่ยิงอัตโนมัติ ({TRIGGERS.length})</div>
          <div className="mb-3 text-[12px] text-ink-faint">ปิดสวิตช์ = หยุดยิงเหตุการณ์นั้นชั่วคราว (งานหลังบ้านทำงานปกติ แค่ไม่แจ้งเตือน)</div>
          <div className="flex flex-col divide-y divide-hair">
            {TRIGGERS.map((t) => {
              const on = pushEnabled(db, t.key);
              return (
                <div key={t.key} className="flex items-center gap-3 py-2.5">
                  <span className="text-[17px]">{t.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">{t.name}</div>
                    <div className="text-[11px] text-ink-faint">→ {t.target}{t.note ? ` · ${t.note}` : ''}</div>
                  </div>
                  <button
                    onClick={() => { dispatch(setPushConfig(t.key, !on)); flash(`${t.name} → ${!on ? 'เปิด' : 'ปิด'}`); }}
                    className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', on ? 'bg-[#16a34a]' : 'bg-surface-4')}
                    aria-label={t.name}
                  >
                    <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-3 rounded-lg border border-subtle bg-surface-3/50 px-3 py-2 text-[11.5px] text-ink-faint">
            💡 โปรโมชั่นเป็นการส่งเอง (แผงด้านขวา) · ตัวกรองค่าย/เรื่องของลูกค้ามีผลเฉพาะ 2 ข้อแรก
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <PromoPushPanel />

          {/* devices */}
          <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
            <div className="mb-3 font-bold">เครื่องที่เปิดรับ ({subs.length})</div>
            {subs.length === 0 ? <div className="py-4 text-center text-[12.5px] text-ink-faint">ยังไม่มีใครเปิดการแจ้งเตือน</div> : (
              <div className="flex max-h-[340px] flex-col divide-y divide-hair overflow-y-auto">
                {[...subs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((s) => {
                  const pref = db.pushPrefs.find((p) => p.user_id === s.user_id);
                  return (
                    <div key={s.id} className="flex items-center gap-2.5 py-2">
                      <Icon name="user" size={13} className="shrink-0 text-primary-soft" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{nameOf(s.user_id)}</span>
                      {pref && <span title="ตั้งตัวกรองค่าย/เรื่องไว้" className="text-[11px]">🎯</span>}
                      <span className="text-[11.5px] text-ink-muted2">{deviceKind(s.endpoint)}</span>
                      <span className="w-[68px] text-right text-[11px] text-ink-faint">{fmtDate(s.created_at)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
