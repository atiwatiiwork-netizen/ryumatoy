'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch, useStore } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { worklist, dataIssues, plansDue, plansUpcoming, type WorkItem, type DataIssue } from '@/domain/services/worklist';
import { closePaymentPlan, markPlanReminded, releaseStuckHold, reclaimCouponGrantsFor, repairTickets, logActivity, createPaymentPlan } from '@/data/mutations';
import { releaseReservation } from '@/lib/reserve';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import { lineDepositForRank } from '@/domain/services/ranks';
import { productLabel, lineImage } from '@/domain/services/catalog';
import { availableFor, batchAvailable } from '@/domain/services/reservations';
import { hasPreorderTicket, specialGateEnabled } from '@/domain/services/tickets';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/**
 * "งานค้างวันนี้" — ศูนย์รวมงานที่ต้องลงมือจากทุกโมดูล + เครื่องมือซ่อมข้อมูล + นัดชำระ + ประวัติการกระทำ
 * (เจ้าของ 2026-07-25). เปิดหน้าเดียวรู้ว่าวันนี้ต้องทำอะไร แทนการไล่เปิด 5 หน้า.
 */
export default function TodayPage() {
  const db = useDatabase();
  const router = useRouter();
  const [tab, setTab] = useState<'work' | 'plans' | 'health' | 'log'>('work');

  const items = worklist(db);
  const issues = dataIssues(db);
  const due = plansDue(db);
  const nowCount = items.filter((i) => i.urgency === 'now').reduce((s, i) => s + i.count, 0);

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">งานค้างวันนี้</div>
      <div className="mb-4 text-[13px] text-ink-faint">
        {nowCount > 0 ? `มี ${nowCount} รายการที่ควรทำก่อน` : 'ไม่มีงานด่วนค้าง 🎉'} · รวมทุกโมดูลไว้ที่เดียว
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Tab active={tab === 'work'} onClick={() => setTab('work')}>📋 งานค้าง {items.length > 0 && <B>{items.reduce((s, i) => s + i.count, 0)}</B>}</Tab>
        <Tab active={tab === 'plans'} onClick={() => setTab('plans')}>📅 นัดชำระ {due.length > 0 && <B>{due.length}</B>}</Tab>
        <Tab active={tab === 'health'} onClick={() => setTab('health')}>🩺 สุขภาพข้อมูล {issues.length > 0 && <B>{issues.length}</B>}</Tab>
        <Tab active={tab === 'log'} onClick={() => setTab('log')}>🕘 ประวัติการกระทำ</Tab>
      </div>

      {tab === 'work' && (
        items.length === 0
          ? <Empty text="เคลียร์หมดแล้ว ไม่มีงานค้าง 🎉" />
          : <div className="grid gap-2.5 lg:grid-cols-2">{items.map((w) => <WorkCard key={w.key} w={w} onGo={() => router.push(w.href)} />)}</div>
      )}
      {tab === 'plans' && <PlansTab />}
      {tab === 'health' && <HealthTab issues={issues} />}
      {tab === 'log' && <LogTab />}
    </div>
  );
}

const URG: Record<string, { label: string; cls: string; ring: string }> = {
  now: { label: 'ทำก่อน', cls: 'bg-[#b91c1c]/20 text-[#f87171]', ring: 'border-[#b91c1c]/45' },
  today: { label: 'วันนี้', cls: 'bg-[#d97706]/20 text-[#fbbf24]', ring: 'border-[#d97706]/40' },
  soon: { label: 'เมื่อว่าง', cls: 'bg-white/[0.07] text-ink-muted2', ring: 'border-subtle' },
};

function WorkCard({ w, onGo }: { w: WorkItem; onGo: () => void }) {
  const u = URG[w.urgency];
  return (
    <button onClick={onGo} className={cx('flex items-center gap-3 rounded-2xl border bg-surface-2 p-4 text-left', u.ring, w.urgency === 'now' && 'animate-pulseRed')}>
      <span className="text-[26px]">{w.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[14px] font-bold text-ink">{w.title}</span>
          <span className={cx('rounded-md px-1.5 py-0.5 text-[10px] font-extrabold', u.cls)}>{u.label}</span>
        </span>
        {w.detail && <span className="mt-0.5 block text-[11.5px] text-ink-faint">{w.detail}</span>}
        {w.money ? <span className="mt-0.5 block text-[11.5px] font-bold text-[#4ade80]">{baht(w.money)}</span> : null}
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[22px] font-extrabold text-primary-soft">{w.count}</span>
        <span className="text-[11px] text-ink-faint">ไปทำ →</span>
      </span>
    </button>
  );
}

/* ── นัดชำระ ──
   v57 (เจ้าของ 2026-07-26): แอดมินเป็นคนออกนัดให้ลูกค้า (ลูกค้าตั้งเองไม่ได้แล้ว)
   เลือกลูกค้า → เลือกสินค้าหลายชิ้น → เลือกวันนัด → ส่ง → ลูกค้าเห็นในเมนู "นัดชำระ" แล้วกดจ่ายได้เลย */
function PlansTab() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const me = useCurrentUserId();
  const due = plansDue(db);
  const upcoming = plansUpcoming(db);
  // ปฏิทินไทย ไม่ใช่ UTC — ก่อน 7 โมงเช้า toISOString ยังเป็นเมื่อวาน ป้าย "เลยกำหนด" จะเพี้ยน
  const d0 = new Date();
  const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;

  const remind = (planId: string, userId: string, amount: number) => {
    if (pushEnabled(db, 'plan_due'))
      sendPush(subsForUsers(db, [userId]), { title: '📅 ถึงกำหนดชำระแล้วครับ', body: `ยอดที่นัดไว้ ${baht(amount)} — โอนแล้วแจ้งแอดมินได้เลย`, url: '/wallet' }, dispatch).catch(() => {});
    dispatch(markPlanReminded(planId));
    // อ่านกลับก่อนค่อยบันทึกประวัติ+ฟ้อง: ถ้านัดถูกปิดไปแล้วจากอีกเครื่อง markPlanReminded จะเป็น no-op
    let stamped = false;
    dispatch((d) => { stamped = !!d.paymentPlans.find((p) => p.id === planId)?.reminded_at; return d; });
    if (!stamped) return flash('นัดนี้ถูกปิดไปแล้ว — ไม่ได้บันทึกการเตือน');
    dispatch(logActivity(me, 'remind_plan', `เตือนนัดชำระ ${baht(amount)}`, { targetId: planId, amount }));
    flash('ส่งเตือนลูกค้าแล้ว 🔔');
  };
  const close = (planId: string, status: 'done' | 'cancelled', amount: number) => {
    if (!confirm(status === 'done' ? 'ยืนยันว่าลูกค้าจ่ายแล้ว?' : 'ยกเลิกนัดชำระนี้?')) return;
    dispatch(closePaymentPlan(planId, status));
    let now = '';
    dispatch((d) => { now = d.paymentPlans.find((p) => p.id === planId)?.status ?? ''; return d; });
    if (now !== status) return flash(`ปิดไม่สำเร็จ — สถานะตอนนี้คือ "${now || 'ไม่พบนัด'}"`);
    dispatch(logActivity(me, 'close_plan', `${status === 'done' ? 'ปิดนัดชำระ (จ่ายแล้ว)' : 'ยกเลิกนัดชำระ'} ${baht(amount)}`, { targetId: planId, amount }));
    flash(status === 'done' ? 'ปิดนัดชำระแล้ว ✓' : 'ยกเลิกแล้ว');
  };

  const Row = ({ p }: { p: (typeof due)[number] }) => {
    const u = db.users.find((x) => x.id === p.user_id);
    const overdue = p.due_date < today;
    return (
      <div className={cx('rounded-xl border bg-surface-2 p-3.5', overdue ? 'border-[#b91c1c]/45' : 'border-subtle')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-bold">{u?.display_name ?? '—'}</span>
          <span className={cx('rounded-md px-1.5 py-0.5 text-[10.5px] font-extrabold', overdue ? 'animate-blink bg-[#b91c1c]/25 text-[#f87171]' : 'bg-[#d97706]/20 text-[#fbbf24]')}>
            {overdue ? `เลยกำหนด ${p.due_date}` : `ครบกำหนด ${p.due_date}`}
          </span>
          <span className="ml-auto text-[15px] font-extrabold text-primary-soft">{baht(p.amount)}</span>
        </div>
        <div className="mt-1 text-[11.5px] text-ink-muted2">{p.items.map((i) => `${i.label} ×${i.qty}`).join(' · ')}</div>
        {p.note && <div className="mt-0.5 text-[11.5px] text-ink-faint">📝 {p.note}</div>}
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => remind(p.id, p.user_id, p.amount)} className="rounded-lg border border-[#a855f7]/50 px-3 py-1.5 text-[12px] font-bold text-[#c084fc]">🔔 เตือนลูกค้า</button>
          <button onClick={() => close(p.id, 'done', p.amount)} className="rounded-lg bg-success px-3 py-1.5 text-[12px] font-bold text-white">✓ จ่ายแล้ว</button>
          <button onClick={() => close(p.id, 'cancelled', p.amount)} className="rounded-lg border border-subtle px-3 py-1.5 text-[12px] text-ink-faint">ยกเลิก</button>
          {p.reminded_at && <span className="self-center text-[11px] text-ink-faint">เตือนล่าสุด {fmtTime(p.reminded_at)}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <NewPlanForm />
      <Section title={`ถึงกำหนด / เลยกำหนด (${due.length})`} sub="ลูกค้านัดว่าจะจ่ายวันนี้หรือก่อนหน้า">
        {due.length === 0 ? <Empty text="ไม่มีนัดที่ถึงกำหนด" /> : <div className="flex flex-col gap-2.5">{due.map((p) => <Row key={p.id} p={p} />)}</div>}
      </Section>
      <Section title={`นัดล่วงหน้า (${upcoming.length})`} sub="ยังไม่ถึงกำหนด — ไว้ดูแผนเงินเข้า">
        {upcoming.length === 0 ? <Empty text="ยังไม่มีนัดล่วงหน้า" /> : <div className="flex flex-col gap-2.5">{upcoming.map((p) => <Row key={p.id} p={p} />)}</div>}
      </Section>
    </div>
  );
}

/* ── ฟอร์มออกนัดชำระ (แอดมินเท่านั้น) ── */
type PickKey = string; // `${productId}|${variantId ?? ''}|${batchId ?? ''}`
interface Opt { key: PickKey; productId: string; variantId?: string; batchId?: string; label: string; kind: 'pre' | 'stock' | 'batch'; price: number; deposit: number; avail: number | null; img?: string }

/** ทุกอย่างที่ "ขายได้จริงตอนนี้" — ต้องตรงกับเงื่อนไข `sellable` ใน submitOrder
 *  ไม่งั้นแอดมินออกนัดของที่ลูกค้าจ่ายไม่ผ่าน (รอบปิด/สินค้าปิดรับจอง/ร่างที่ยังไม่เปิดขาย) */
function sellableOptions(db: ReturnType<typeof useDatabase>): Opt[] {
  const out: Opt[] = [];
  for (const p of db.products) {
    const vs = db.variants.filter((v) => v.product_id === p.id);
    if (p.is_stock) {
      const avail = availableFor(db, p);
      if (avail <= 0) continue;
      if (vs.length) vs.forEach((v) => out.push({ key: `${p.id}|${v.id}|`, productId: p.id, variantId: v.id, label: productLabel(db, p.id, v.id), kind: 'stock', price: v.price_total, deposit: v.deposit_amount, avail, img: lineImage(db, p.id, v.id) }));
      else out.push({ key: `${p.id}||`, productId: p.id, label: productLabel(db, p.id), kind: 'stock', price: p.price_total, deposit: p.deposit_amount, avail, img: lineImage(db, p.id) });
    } else if (p.status === 'open') {
      if (vs.length) vs.forEach((v) => out.push({ key: `${p.id}|${v.id}|`, productId: p.id, variantId: v.id, label: productLabel(db, p.id, v.id), kind: 'pre', price: v.price_total, deposit: v.deposit_amount, avail: null, img: lineImage(db, p.id, v.id) }));
      else out.push({ key: `${p.id}||`, productId: p.id, label: productLabel(db, p.id), kind: 'pre', price: p.price_total, deposit: p.deposit_amount, avail: null, img: lineImage(db, p.id) });
    }
  }
  for (const b of db.batches) {
    if (b.status !== 'open' || b.published === false) continue;
    const p = db.products.find((x) => x.id === b.product_id);
    if (!p) continue;
    const avail = batchAvailable(db, b);
    if (avail <= 0) continue;
    out.push({ key: `${p.id}||${b.id}`, productId: p.id, batchId: b.id, label: `${productLabel(db, p.id)} · รอบพิเศษ`, kind: 'batch', price: b.price_total, deposit: b.deposit_amount, avail, img: lineImage(db, p.id) });
  }
  return out;
}

function NewPlanForm() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const store = useStore();
  const { flash } = useToast();
  const me = useCurrentUserId();
  const [open, setOpen] = useState(false);
  const [uid, setUid] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Record<PickKey, number>>({});
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const d0 = new Date();
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const minDate = ymd(d0);
  const dmax = new Date(d0); dmax.setDate(dmax.getDate() + 180);
  const maxDate = ymd(dmax);

  const customers = db.users.filter((u) => !u.is_admin && u.approved !== false)
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'th'));
  const customer = db.users.find((u) => u.id === uid);
  const rank = customer?.rank ?? 'bronze';
  const opts = sellableOptions(db);
  const shown = q.trim() ? opts.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase())) : opts.slice(0, 12);

  // มัดจำต่อชิ้นคิดตาม "ขั้นของลูกค้าคนนั้น" ไม่ใช่ของแอดมิน (DNA: ทุกมัดจำต้องผ่าน ranks.ts)
  const eachOf = (o: Opt) => lineDepositForRank(db.settings, { deposit: o.deposit, price: o.price, isStock: o.kind !== 'pre' }, rank);
  const lines = Object.entries(picked).filter(([, n]) => n > 0)
    .map(([k, n]) => ({ opt: opts.find((o) => o.key === k), qty: n }))
    .filter((x): x is { opt: Opt; qty: number } => !!x.opt);
  const total = lines.reduce((s, x) => s + eachOf(x.opt) * x.qty, 0);
  const overStock = lines.filter((x) => x.opt.avail !== null && x.qty > x.opt.avail);
  // รอบพิเศษต้องมีใบพรีถึงจะจ่ายผ่าน (gate) — เตือนตั้งแต่ตอนออกนัด ไม่ใช่ให้ไปตายตอนลูกค้าจ่าย
  const batchBlocked = !!uid && lines.some((x) => x.opt.kind === 'batch') && !hasPreorderTicket(db, uid) && specialGateEnabled(db);

  const reset = () => { setUid(''); setPicked({}); setDate(''); setNote(''); setQ(''); };

  const send = async () => {
    if (busy) return;
    if (!uid) return flash('เลือกลูกค้าก่อน');
    if (lines.length === 0) return flash('เลือกสินค้าอย่างน้อย 1 ชิ้น');
    if (!date) return flash('เลือกวันนัดก่อน');
    if (date < minDate || date > maxDate) return flash('วันนัดต้องอยู่ระหว่างวันนี้ถึง 180 วันข้างหน้า');
    if (overStock.length) return flash(`ของไม่พอ: ${overStock.map((x) => x.opt.label).join(', ')}`);
    if (batchBlocked && !confirm('ลูกค้าคนนี้ยังไม่มีใบพรี — รอบพิเศษจะจ่ายไม่ผ่าน (ติด gate) ยืนยันส่งนัดนี้?')) return;
    const items = lines.map((x) => ({
      product_id: x.opt.productId, variant_id: x.opt.variantId, batch_id: x.opt.batchId,
      qty: x.qty, label: x.opt.label, each: eachOf(x.opt),
    }));
    setBusy(true);
    let before = 0, after = 0;
    dispatch((d) => { before = d.paymentPlans.length; return d; });
    dispatch(createPaymentPlan(me, uid, date, items, note));
    dispatch((d) => { after = d.paymentPlans.length; return d; });
    if (after === before) { setBusy(false); return flash('ออกนัดไม่สำเร็จ — ลูกค้ามีนัดค้างครบ 5 รายการแล้ว (ปิดของเก่าก่อน)'); }
    await store.flush();   // ต้องเซฟจริงก่อน ค่อยแจ้งลูกค้า
    setBusy(false);
    if (pushEnabled(db, 'plan_new'))
      sendPush(subsForUsers(db, [uid]), { title: '📅 แอดมินส่งนัดชำระให้คุณ', body: `${lines.length} รายการ · ${baht(total)} — กำหนดจ่าย ${date}`, url: '/plans' }, dispatch).catch(() => {});
    dispatch(logActivity(me, 'create_plan', `ออกนัดชำระให้ ${customer?.display_name ?? ''} (${lines.length} รายการ)`, { targetLabel: date, amount: total }));
    flash(`ส่งนัดชำระให้ ${customer?.display_name ?? ''} แล้ว ✓`);
    reset(); setOpen(false);
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-2xl border border-[#a855f7]/45 bg-[#a855f7]/[0.08] py-3.5 text-[13.5px] font-bold text-[#c084fc]">
        ➕ ออกนัดชำระให้ลูกค้า
      </button>
    );
  }
  return (
    <div className="rounded-2xl border border-[#a855f7]/45 bg-[#a855f7]/[0.07] p-4">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-extrabold text-[#c084fc]">➕ ออกนัดชำระให้ลูกค้า</span>
        <button onClick={() => { reset(); setOpen(false); }} className="ml-auto text-[12.5px] text-ink-faint">ปิด</button>
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-muted2">ลูกค้าจะเห็นในเมนู “นัดชำระ” แล้วกดจ่ายผ่านหน้าสลิปปกติ · <b className="text-[#fbbf24]">ไม่ได้กันของไว้ให้</b> ถ้าของหมดก่อนถึงวันนัด ระบบจะบล็อกการโอน</div>

      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        <label className="text-[12px] text-ink-muted">ลูกค้า
          <select value={uid} onChange={(e) => setUid(e.target.value)} className="mt-1 w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] text-ink outline-none">
            <option value="">— เลือกลูกค้า —</option>
            {customers.map((u) => <option key={u.id} value={u.id}>{u.display_name} · {u.rank ?? 'bronze'}</option>)}
          </select>
        </label>
        <label className="text-[12px] text-ink-muted">วันนัดชำระ
          <input type="date" min={minDate} max={maxDate} value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] text-ink outline-none" />
        </label>
      </div>

      <div className="mt-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาสินค้า (พิมพ์ชื่อ)" className="w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] outline-none placeholder:text-ink-faint" />
        <div className="mt-2 max-h-[280px] overflow-y-auto rounded-xl border border-subtle bg-surface-2">
          {shown.length === 0 ? <div className="py-6 text-center text-[12px] text-ink-faint">ไม่พบสินค้าที่ขายได้ตอนนี้</div> : shown.map((o) => {
            const n = picked[o.key] ?? 0;
            const KIND = { pre: ['พรี', 'text-[#4ade80]'], stock: ['พร้อมส่ง', 'text-[#60a5fa]'], batch: ['รอบพิเศษ', 'text-[#fbbf24]'] }[o.kind];
            return (
              <div key={o.key} className={cx('flex items-center gap-2.5 border-b border-hair px-2.5 py-2 last:border-0', n > 0 && 'bg-[#a855f7]/[0.08]')}>
                <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-subtle bg-stripe">{o.img && <img src={o.img} alt="" className="h-full w-full object-cover" />}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-semibold">{o.label}</div>
                  <div className="text-[11px] text-ink-faint">
                    <span className={KIND[1]}>{KIND[0]}</span> · มัดจำ {baht(eachOf(o))}{o.avail !== null ? ` · เหลือ ${o.avail}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button onClick={() => setPicked((s) => ({ ...s, [o.key]: Math.max(0, (s[o.key] ?? 0) - 1) }))} className="grid h-7 w-7 place-items-center rounded-lg border border-subtle text-ink">−</button>
                  <span className="min-w-[16px] text-center text-[13px] font-bold">{n}</span>
                  <button onClick={() => setPicked((s) => ({ ...s, [o.key]: (s[o.key] ?? 0) + 1 }))} className="grid h-7 w-7 place-items-center rounded-lg border border-subtle text-primary-bright">+</button>
                </div>
              </div>
            );
          })}
        </div>
        {!q.trim() && opts.length > shown.length && <div className="mt-1 text-[11px] text-ink-faint">แสดง {shown.length} จาก {opts.length} รายการ — พิมพ์ค้นหาเพื่อดูที่เหลือ</div>}
      </div>

      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="โน้ต (ไม่บังคับ) เช่น ตกลงกันทางแชท" className="mt-2.5 w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] outline-none placeholder:text-ink-faint" />

      {batchBlocked && <div className="mt-2.5 rounded-lg border border-[#b91c1c]/45 bg-[#b91c1c]/[0.1] px-3 py-2 text-[11.5px] text-[#f87171]">🔒 ลูกค้าคนนี้ยังไม่มีใบพรี — รายการรอบพิเศษจะจ่ายไม่ผ่าน (ปิด gate ได้ที่หน้าสต๊อกใบพรี)</div>}
      {overStock.length > 0 && <div className="mt-2.5 rounded-lg border border-[#b91c1c]/45 bg-[#b91c1c]/[0.1] px-3 py-2 text-[11.5px] text-[#f87171]">ของไม่พอ: {overStock.map((x) => `${x.opt.label} (เหลือ ${x.opt.avail})`).join(' · ')}</div>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-ink-muted">ยอดที่ต้องจ่าย{customer ? ` (ขั้น ${rank})` : ''}</span>
        <span className="text-[17px] font-extrabold text-primary-soft">{baht(total)}</span>
        <button onClick={send} disabled={busy} className="ml-auto rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white disabled:opacity-60">{busy ? 'กำลังส่ง…' : '📤 ส่งนัดชำระ'}</button>
      </div>
    </div>
  );
}

/* ── สุขภาพข้อมูล ── */
function HealthTab({ issues }: { issues: DataIssue[] }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const me = useCurrentUserId();

  if (issues.length === 0) return <Empty text="ข้อมูลสะอาด ไม่พบปัญหา 🎉" />;

  const doFix = async (iss: DataIssue, rowId: string, label: string) => {
    if (iss.fix === 'release_hold') {
      if (!confirm(`ปล่อยของที่ถูกกันไว้: ${label}?`)) return;
      await releaseReservation(rowId).catch(() => {});
      dispatch(releaseStuckHold(rowId));
      dispatch(logActivity(me, 'release_hold', `ปล่อย hold ค้าง: ${label}`, { targetId: rowId }));
      flash('ปล่อยของกลับเข้าสต๊อกแล้ว ✓');
    } else if (iss.fix === 'reclaim_coupons') {
      if (!confirm(`คืนคูปองให้ ${label}?`)) return;
      dispatch(reclaimCouponGrantsFor(rowId));
      dispatch(logActivity(me, 'reclaim_coupons', `คืนคูปองให้ ${label}`, { targetId: rowId }));
      flash('คืนคูปองแล้ว ✓');
    }
  };
  const repairAll = () => {
    if (!confirm('ออกตั๋วที่หายให้ครบทุกออเดอร์ที่อนุมัติแล้ว?')) return;
    dispatch(repairTickets());
    dispatch(logActivity(me, 'repair_tickets', 'ซ่อมตั๋วที่หายจากออเดอร์ที่อนุมัติแล้ว'));
    flash('ซ่อมตั๋วแล้ว ✓');
  };

  const SEV: Record<string, string> = { high: 'border-[#b91c1c]/45 bg-[#b91c1c]/[0.07]', mid: 'border-[#d97706]/40 bg-[#d97706]/[0.06]', low: 'border-subtle bg-surface-2' };
  return (
    <div className="flex flex-col gap-3">
      {issues.map((iss) => (
        <div key={iss.key} className={cx('rounded-2xl border p-4', SEV[iss.severity])}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-extrabold text-ink">{iss.title}</span>
            <span className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[11px] font-bold text-ink-muted2">{iss.rows.length} รายการ</span>
            {iss.fix === 'repair_tickets' && <button onClick={repairAll} className="ml-auto rounded-lg bg-cta px-3 py-1.5 text-[12px] font-bold text-white">🔧 ซ่อมทั้งหมด</button>}
          </div>
          <div className="mt-1 text-[12px] text-ink-muted2">{iss.why}</div>
          <div className="mt-2.5 flex flex-col divide-y divide-hair">
            {iss.rows.slice(0, 12).map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-[12.5px]">
                <span className="min-w-[140px] flex-1 font-semibold">{r.label}</span>
                {r.sub && <span className="text-[11.5px] text-ink-faint">{r.sub}</span>}
                {(iss.fix === 'release_hold' || iss.fix === 'reclaim_coupons') && (
                  <button onClick={() => doFix(iss, r.id, r.label)} className="rounded-lg border border-accent px-2.5 py-1 text-[11.5px] font-bold text-primary-soft">
                    {iss.fix === 'release_hold' ? 'ปล่อยของ' : 'คืนคูปอง'}
                  </button>
                )}
              </div>
            ))}
            {iss.rows.length > 12 && <div className="py-1.5 text-[11.5px] text-ink-faint">…และอีก {iss.rows.length - 12} รายการ</div>}
          </div>
        </div>
      ))}
      <div className="text-[11.5px] text-ink-faint">💡 ปัญหาที่ไม่มีปุ่มแก้อัตโนมัติ ต้องไปจัดการในหน้าที่เกี่ยวข้อง (ระบุไว้ในคำอธิบาย)</div>
    </div>
  );
}

/* ── ประวัติการกระทำ ── */
function LogTab() {
  const db = useDatabase();
  const [q, setQ] = useState('');
  const rows = db.activityLogs
    .filter((l) => !q.trim() || `${l.actor_name} ${l.summary} ${l.target_label ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 200);
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-bold">ใครทำอะไร เมื่อไหร่</span>
        <span className="text-[11.5px] text-ink-faint">เก็บอัตโนมัติเมื่อมีการอนุมัติ/แก้เงิน/ลบ — ตามรอยได้เวลามีผู้ช่วยหลายคน</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา ชื่อคน / รายการ" className="ml-auto w-full max-w-[240px] rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] outline-none placeholder:text-ink-faint" />
      </div>
      {rows.length === 0 ? <Empty text={db.activityLogs.length === 0 ? 'ยังไม่มีประวัติ (เริ่มบันทึกตั้งแต่ migration v56)' : 'ไม่พบรายการที่ค้นหา'} /> : (
        <div className="flex flex-col divide-y divide-hair">
          {rows.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12.5px]">
              <span className="w-[108px] shrink-0 text-[11px] text-ink-faint">{fmtTime(l.created_at)}</span>
              <span className="w-[110px] shrink-0 truncate font-semibold text-ink">{l.actor_name}</span>
              <span className="min-w-[160px] flex-1">{l.summary}</span>
              {l.target_label && <span className="font-mono text-[11px] text-ink-faint">{l.target_label}</span>}
              {l.amount ? <span className="font-bold text-[#4ade80]">{baht(l.amount)}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── ชิ้นส่วนเล็ก ── */
function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={cx('flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[13px] font-bold', active ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{children}</button>;
}
function B({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-primary-bright px-[7px] text-[11px] font-bold text-white">{children}</span>;
}
function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-4">
      <div className="text-[14px] font-bold text-ink">{title}</div>
      {sub && <div className="mb-2.5 text-[11.5px] text-ink-faint">{sub}</div>}
      {children}
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="rounded-2xl border border-subtle bg-surface-2 py-10 text-center text-[13px] text-ink-faint">{text}</div>;
}
