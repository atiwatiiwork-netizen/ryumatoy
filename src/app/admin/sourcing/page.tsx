'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { genId, upsertManufacturer, upsertFranchise, quoteSourcing, unavailableSourcing, linkSourcingCatalog, approveSourcingStart, setSourcingEta } from '@/data/mutations';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import { sourcingStatusOf, sourcingEtaConfig, transportRange, transportLabel, sourcingEtaLabel, expiringToday, sourcingDaysLeft } from '@/domain/services/sourcing';
import type { SourcingRequest, SourcingTransport } from '@/domain/entities';
import { SourcingMemos } from './SourcingMemos';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

/** แอดมิน — คิวหาของ: ตอบราคา/มัดจำ · ยืนยันเริ่มงาน · ตาม watchlist (ryuma-sourcing-spec). */
export default function AdminSourcingPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const all = [...db.sourcingRequests].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const st = (r: SourcingRequest) => sourcingStatusOf(r);
  const requested = all.filter((r) => st(r) === 'requested');
  const paid = all.filter((r) => st(r) === 'paid');
  const working = all.filter((r) => st(r) === 'working');
  const watching = all.filter((r) => st(r) === 'quoted' || st(r) === 'unavailable');
  const expiring = expiringToday(db);

  const remindExpiring = () => {
    if (!expiring.length) return flash('ไม่มีรายการหมดอายุวันนี้');
    for (const r of expiring) {
      const msg = r.status === 'quoted'
        ? { title: '⏰ ใบเสนอราคาหมดอายุวันนี้!', body: `${r.character_name} · มัดจำ ${baht((r.deposit ?? 0) * r.qty)} — ชำระวันนี้ก่อนราคาหลุด`, url: '/sourcing' }
        : { title: '⏰ Watchlist หมดอายุวันนี้', body: `${r.character_name} — กด "ส่งเช็คใหม่" ถ้ายังตามหาอยู่`, url: '/sourcing' };
      sendPush(subsForUsers(db, [r.user_id]), msg, dispatch).catch(() => {});
    }
    flash(`ส่งเตือน ${expiring.length} รายการแล้ว 🔔`);
  };

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">หาของ</div>
      <div className="mb-4 text-[13px] text-ink-faint">คิวหาของจากลูกค้า · ตอบราคา/มัดจำ → ลูกค้าโอน → กดเริ่มงาน (ระบบออกตั๋วจริงให้เอง)</div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {expiring.length > 0 && <button onClick={remindExpiring} className="rounded-lg border border-[#d97706]/40 bg-[#d97706]/[0.1] px-3.5 py-2 text-[12.5px] font-bold text-[#fbbf24]">🔔 เตือนหมดอายุวันนี้ ({expiring.length})</button>}
        <EtaConfig />
      </div>

      {/* memo หาของนอกระบบ (แชทเฟส/โทร) — คนละคิวกับด้านล่างซึ่งมาจากลูกค้าในแอป */}
      <SourcingMemos />

      <Group title={`🔎 รอตอบ (${requested.length})`} tone="red" empty={requested.length === 0 ? 'ไม่มีเรื่องค้างตอบ' : undefined}>
        {requested.map((r) => <RequestRow key={r.id} r={r} />)}
      </Group>

      <Group title={`💸 มัดจำเข้าแล้ว · รอเริ่มงาน (${paid.length})`} tone="blue" empty={paid.length === 0 ? 'ไม่มีรายการรอเริ่มงาน' : undefined}>
        {paid.map((r) => <PaidRow key={r.id} r={r} />)}
      </Group>

      <Group title={`🔧 กำลังหาของ / ดำเนินการ (${working.length})`} tone="green" empty={working.length === 0 ? 'ยังไม่มีงานที่เริ่มแล้ว' : undefined}>
        {working.map((r) => <WorkingRow key={r.id} r={r} />)}
      </Group>

      <Group title={`👀 Watchlist ฝั่งลูกค้า (${watching.length})`} tone="plain" empty={watching.length === 0 ? 'ว่าง' : undefined}>
        {watching.map((r) => (
          <BaseRow key={r.id} r={r} right={
            <span className="text-[11.5px] text-ink-faint">{r.status === 'quoted' ? '💡 รอลูกค้าตัดสินใจ' : '🔍 ยังหาไม่ได้'} · เหลือ {sourcingDaysLeft(r)} วัน</span>
          } />
        ))}
      </Group>
    </div>
  );
}

function Group({ title, tone, empty, children }: { title: string; tone: 'red' | 'blue' | 'green' | 'plain'; empty?: string; children?: React.ReactNode }) {
  const border = tone === 'red' ? 'border-[#b91c1c]/35' : tone === 'blue' ? 'border-[#2563eb]/35' : tone === 'green' ? 'border-[#16a34a]/35' : 'border-subtle';
  return (
    <div className={cx('mb-5 rounded-2xl border bg-surface-2 p-4', border)}>
      <div className="mb-3 font-bold">{title}</div>
      {empty ? <div className="py-3 text-center text-[12.5px] text-ink-faint">{empty}</div> : <div className="flex flex-col gap-3">{children}</div>}
    </div>
  );
}

function BaseRow({ r, right, footer }: { r: SourcingRequest; right?: React.ReactNode; footer?: React.ReactNode }) {
  const db = useDatabase();
  const buyer = db.users.find((u) => u.id === r.user_id);
  const [big, setBig] = useState<string | null>(null);
  return (
    <div className="rounded-xl border border-subtle bg-surface-3/50 p-3.5">
      <div className="flex gap-3">
        <div className="flex shrink-0 gap-1.5">
          {r.images.slice(0, 2).map((img, i) => <button key={i} onClick={() => setBig(img)}><img src={img} alt="" className="h-16 w-16 rounded-lg border border-subtle object-cover" /></button>)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[14px] font-bold">{r.character_name}{r.qty > 1 ? ` ×${r.qty}` : ''}</div>
            {right}
          </div>
          <div className="text-[12px] text-ink-muted2">{r.maker_name}{!r.maker_id && <em className="text-[#fbbf24]"> (ใหม่)</em>} · {r.franchise_name}{!r.franchise_id && <em className="text-[#fbbf24]"> (ใหม่)</em>}</div>
          <div className="text-[11.5px] text-ink-faint">{buyer?.display_name ?? '—'} · {fmtDate(r.created_at)}{r.note ? ` · 📝 ${r.note}` : ''}{r.resent_from ? ' · 🔁 ส่งซ้ำ' : ''}</div>
        </div>
      </div>
      {footer}
      {big && (
        <div className="fixed inset-0 z-[130] grid place-items-center bg-black/90 p-4" onClick={() => setBig(null)}>
          <img src={big} alt="" className="max-h-[92vh] max-w-full rounded-lg object-contain" />
        </div>
      )}
    </div>
  );
}

/** requested → quote (ราคา/มัดจำ/ขนส่ง) หรือ ยังหาไม่ได้ */
function RequestRow({ r }: { r: SourcingRequest }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [price, setPrice] = useState('');
  const [dep, setDep] = useState('');
  const [transport, setTransport] = useState<SourcingTransport>('truck');
  const range = transportRange(db, transport);

  const quote = () => {
    const p = Number(price) || 0, d = Number(dep) || 0;
    if (p <= 0 || d <= 0) return flash('กรอกราคา + มัดจำ');
    if (d > p) return flash('มัดจำต้องไม่เกินราคา');
    dispatch(quoteSourcing(r.id, { price: p, deposit: d, transport }));
    if (pushEnabled(db, 'sourcing_quoted'))
      sendPush(subsForUsers(db, [r.user_id]), { title: '💡 หาของให้ได้แล้ว!', body: `${r.character_name} · ราคา ${baht(p * r.qty)} มัดจำ ${baht(d * r.qty)} — ล็อคราคา 5 วัน`, url: '/sourcing' }, dispatch).catch(() => {});
    flash(`ส่งราคาแล้ว · ${r.character_name}`);
  };
  const reject = () => {
    dispatch(unavailableSourcing(r.id));
    if (pushEnabled(db, 'sourcing_unavailable'))
      sendPush(subsForUsers(db, [r.user_id]), { title: '🔍 ยังหาไม่ได้ตอนนี้', body: `${r.character_name} — เก็บไว้ใน Watchlist แล้ว ส่งมาเช็คใหม่ได้อาทิตย์หน้า`, url: '/sourcing' }, dispatch).catch(() => {});
    flash('ตอบ "ยังหาไม่ได้" แล้ว');
  };

  return (
    <BaseRow r={r} footer={
      <div className="mt-2.5 flex flex-wrap items-end gap-2">
        <label className="block w-28"><span className="mb-1 block text-[11px] text-ink-faint">ราคา/ชิ้น</span><input className={cx(inputCls, 'py-2')} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))} placeholder="2500" /></label>
        <label className="block w-28"><span className="mb-1 block text-[11px] text-ink-faint">มัดจำ/ชิ้น</span><input className={cx(inputCls, 'py-2')} inputMode="numeric" value={dep} onChange={(e) => setDep(e.target.value.replace(/[^\d]/g, ''))} placeholder="1000" /></label>
        <label className="block"><span className="mb-1 block text-[11px] text-ink-faint">ขนส่ง (≈{range.min}-{range.max} วัน)</span>
          <select className={cx(inputCls, 'w-auto py-2')} value={transport} onChange={(e) => setTransport(e.target.value as SourcingTransport)}>
            <option value="truck">🚚 รถ</option>
            <option value="ship">🚢 เรือ</option>
          </select>
        </label>
        <button onClick={quote} className="rounded-lg bg-cta px-4 py-2.5 text-[13px] font-bold text-white">ส่งราคา →</button>
        <button onClick={reject} className="rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-[12.5px] font-semibold text-ink-muted2">ยังหาไม่ได้</button>
      </div>
    } />
  );
}

/** paid → ตรวจสลิป + ผูกค่าย/เรื่อง (ถ้าเป็นชื่อใหม่) + เริ่มงาน */
function PaidRow({ r }: { r: SourcingRequest }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [mk, setMk] = useState(r.maker_id ?? '');
  const [fr, setFr] = useState(r.franchise_id ?? '');
  const linked = !!(r.maker_id && r.franchise_id);

  const quickAddMaker = () => {
    const mid = genId('m');
    dispatch(upsertManufacturer({ id: mid, name: r.maker_name, category_id: db.categories[0]?.id ?? '' }));
    dispatch(linkSourcingCatalog(r.id, { maker_id: mid }));
    flash(`เพิ่มค่าย "${r.maker_name}" เข้าระบบแล้ว ✓`);
  };
  const quickAddFranchise = () => {
    const abbr = window.prompt(`ตัวย่อเรื่อง "${r.franchise_name}" (ใช้ออกเลขตั๋ว เช่น sd)`, r.franchise_name.slice(0, 2).toLowerCase());
    if (!abbr?.trim()) return;
    const fid = genId('f');
    dispatch(upsertFranchise({ id: fid, name: r.franchise_name, abbr: abbr.trim().toLowerCase() }));
    dispatch(linkSourcingCatalog(r.id, { franchise_id: fid }));
    flash(`เพิ่มเรื่อง "${r.franchise_name}" เข้าระบบแล้ว ✓`);
  };
  const link = (kind: 'maker' | 'franchise', id2: string) => {
    if (!id2) return;
    dispatch(linkSourcingCatalog(r.id, kind === 'maker' ? { maker_id: id2 } : { franchise_id: id2 }));
    flash('ผูกกับระบบแล้ว ✓');
  };

  const start = () => {
    dispatch(approveSourcingStart(r.id));
    if (pushEnabled(db, 'sourcing_started'))
      sendPush(subsForUsers(db, [r.user_id]), { title: '🔧 เริ่มงานแล้ว!', body: `ตั๋วหาของ "${r.character_name}" เริ่มงานแล้ว · ${sourcingEtaLabel(db, { ...r, approved_at: new Date().toISOString() })}`, url: '/sourcing' }, dispatch).catch(() => {});
    flash(`เริ่มงาน "${r.character_name}" · ออกตั๋วให้ลูกค้าแล้ว 🎫`);
  };

  return (
    <BaseRow r={r} right={<span className="rounded-full bg-[#2563eb]/[0.15] px-2.5 py-1 text-[11px] font-bold text-[#60a5fa]">มัดจำ {baht((r.deposit ?? 0) * r.qty)}</span>} footer={
      <div className="mt-2.5 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          {r.slip_url && <a href={r.slip_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-lg border border-subtle bg-surface-2 px-3 py-1.5 font-bold text-ink-muted2"><Icon name="copy" size={13} /> ดูสลิป</a>}
          <span className="text-ink-faint">ราคา {baht((r.price ?? 0) * r.qty)} · {r.transport ? transportLabel(r.transport) : ''}</span>
        </div>
        {!r.maker_id && (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-[#fbbf24]">ค่าย "{r.maker_name}" ยังไม่อยู่ในระบบ:</span>
            <button onClick={quickAddMaker} className="rounded-lg bg-primary px-2.5 py-1.5 font-bold text-white">＋ เพิ่มเข้าระบบ</button>
            <span className="text-ink-faint">หรือผูกกับ</span>
            <select className={cx(inputCls, 'w-auto py-1.5')} value={mk} onChange={(e) => { setMk(e.target.value); link('maker', e.target.value); }}>
              <option value="">— เลือกค่ายเดิม —</option>
              {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        )}
        {!r.franchise_id && (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-[#fbbf24]">เรื่อง "{r.franchise_name}" ยังไม่อยู่ในระบบ:</span>
            <button onClick={quickAddFranchise} className="rounded-lg bg-primary px-2.5 py-1.5 font-bold text-white">＋ เพิ่มเข้าระบบ</button>
            <span className="text-ink-faint">หรือผูกกับ</span>
            <select className={cx(inputCls, 'w-auto py-1.5')} value={fr} onChange={(e) => { setFr(e.target.value); link('franchise', e.target.value); }}>
              <option value="">— เลือกเรื่องเดิม —</option>
              {db.franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        )}
        <button onClick={start} disabled={!linked} className="self-start rounded-lg bg-cta px-5 py-2.5 text-[13px] font-bold text-white disabled:opacity-50">
          {linked ? '✅ ยืนยันสลิป · เริ่มงาน (ออกตั๋วจริง)' : 'ผูกค่าย/เรื่องก่อนเริ่มงาน'}
        </button>
      </div>
    } />
  );
}

function WorkingRow({ r }: { r: SourcingRequest }) {
  const db = useDatabase();
  const product = r.product_id ? db.products.find((p) => p.id === r.product_id) : undefined;
  const ticket = r.product_id ? db.tickets.find((t) => t.product_id === r.product_id) : undefined;
  const label = product?.status === 'shipping' ? '🚚 กำลังเดินทาง' : product?.status === 'arrived' ? '📦 ถึงไทยแล้ว' : product?.status === 'delivered' ? '✅ ส่งมอบแล้ว' : '🔧 เริ่มงานแล้ว';
  return (
    <BaseRow r={r} right={<span className="rounded-full bg-[#16a34a]/[0.15] px-2.5 py-1 text-[11px] font-bold text-[#4ade80]">{label}</span>} footer={
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-ink-muted2">
        <span>{sourcingEtaLabel(db, r)}</span>
        {ticket && <span className="font-mono text-ink-faint">{ticket.ticket_no}</span>}
        <Link href="/admin/products" className="font-bold text-primary-soft">เลื่อนสถานะที่แท็บ Status →</Link>
      </div>
    } />
  );
}

/** config รถ/เรือ x-y วัน (app_config 'sourcing_eta') */
function EtaConfig() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const c = sourcingEtaConfig(db);
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ truck_min: String(c.truck_min), truck_max: String(c.truck_max), ship_min: String(c.ship_min), ship_max: String(c.ship_max) });
  const save = () => {
    dispatch(setSourcingEta({ truck_min: Number(v.truck_min) || 1, truck_max: Number(v.truck_max) || 1, ship_min: Number(v.ship_min) || 1, ship_max: Number(v.ship_max) || 1 }));
    flash('บันทึกกำหนดการขนส่งแล้ว'); setOpen(false);
  };
  if (!open) return <button onClick={() => setOpen(true)} className="rounded-lg border border-subtle bg-surface-3 px-3.5 py-2 text-[12.5px] font-semibold text-ink-muted2">⚙️ กำหนดการขนส่ง · รถ {c.truck_min}-{c.truck_max} วัน · เรือ {c.ship_min}-{c.ship_max} วัน</button>;
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-subtle bg-surface-3 p-2.5 text-[12px]">
      {(['truck_min', 'truck_max', 'ship_min', 'ship_max'] as const).map((k) => (
        <label key={k} className="block w-20"><span className="mb-0.5 block text-ink-faint">{k.startsWith('truck') ? '🚚' : '🚢'} {k.endsWith('min') ? 'ต่ำสุด' : 'สูงสุด'}</span>
          <input className={cx(inputCls, 'py-1.5')} inputMode="numeric" value={v[k]} onChange={(e) => setV((s) => ({ ...s, [k]: e.target.value.replace(/[^\d]/g, '') }))} /></label>
      ))}
      <button onClick={save} className="rounded-lg bg-cta px-3.5 py-2 text-[12.5px] font-bold text-white">บันทึก</button>
      <button onClick={() => setOpen(false)} className="py-2 text-ink-faint">ยกเลิก</button>
    </div>
  );
}
