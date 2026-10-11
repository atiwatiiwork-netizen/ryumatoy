'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { copyText } from '@/lib/clipboard';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import { logActivity, completeTicketOffline, offlineReceiveFor } from '@/data/mutations';
import { store } from '@/data/store';
import { persistFailText } from '@/data/persistErrors';
import { productLabel } from '@/domain/services/catalog';
import { marketLocked } from '@/domain/services/market';
import { collectBoard, collectPushPayload, collectMessage, REMIND_ACTION, COLLECT_PUSH_KEY, type CollectCustomer, type CollectProduct, type CollectTicket } from '@/domain/services/collect';

/**
 * 📣 ตามของ (เจ้าของ 2026-10-10) — "รวมรายการสินค้าที่มาถึงไทยแล้ว ลูกค้ายังไม่ชำระ" ไว้ที่เดียว
 * ตัวตัดสินว่าใบไหน "ค้าง" อยู่ที่ domain/services/collect.ts (ต่อจาก collectableTickets ใน worklist)
 * หน้านี้ทำแค่: จัดกลุ่มรายสินค้า/รายคน · 🔔 เตือน (push) · 📋 ก๊อปข้อความไปทักเอง · จดว่าเตือนแล้วเมื่อไหร่ (activity log)
 * DNA: ทุกอย่างคำนวณสดจาก store ทุก render — ลูกค้าจ่าย/แอดมินอนุมัติสลิปแล้วแถวหายเองทันที
 */
type View = 'product' | 'customer';

const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function CollectPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const me = useCurrentUserId();
  const [view, setView] = useState<View>('product');
  const [q, setQ] = useState('');
  const [closing, setClosing] = useState<string | null>(null); // id ตั๋วที่กำลังกด ✅ Complete — ใช้วาดปุ่ม (disabled)
  const lockRef = useRef<string | null>(null); // ล็อกจริง: ดับเบิลแตะก่อน React re-render state ยังเป็น null — ref จับได้ทันที
  const board = useMemo(() => collectBoard(db), [db]);

  const needle = q.trim().toLowerCase();
  const hit = (c: CollectCustomer) => !needle || c.name.toLowerCase().includes(needle) || (c.memberCode ?? '').toLowerCase().includes(needle) || (c.phone ?? '').includes(needle)
    || c.tickets.some((r) => r.ticket.ticket_no.toLowerCase().includes(needle) || r.label.toLowerCase().includes(needle));
  const products = board.products.map((p) => ({ ...p, customers: p.customers.filter(hit) })).filter((p) => p.customers.length > 0);
  const customers = board.customers.filter(hit);

  /** 🔔 เตือนลูกค้า 1 คน — ลำดับสำคัญ (บทเรียน audit v57 #7): อ่าน "สด" จาก store ก่อนยิง ลูกค้าที่เพิ่งจ่าย/ส่งสลิปเมื่อครู่ต้องไม่โดนทวง
   *  คืนค่า: 'sent' ยิงแล้ว · 'nobell' จดแล้วแต่ลูกค้าไม่มีกระดิ่ง · 'skip' ไม่มีอะไรให้ทวงแล้ว */
  const remind = async (userId: string, onlyTicketIds?: Set<string>): Promise<'sent' | 'nobell' | 'skip' | 'off'> => {
    let live: CollectCustomer | undefined;
    dispatch((d) => { live = collectBoard(d).customers.find((c) => c.userId === userId); return d; });
    const rows = (live?.chaseable ?? []).filter((r) => !onlyTicketIds || onlyTicketIds.has(r.ticket.id));
    if (!live || rows.length === 0) return 'skip';
    const payload = collectPushPayload(live, rows);
    const due = rows.reduce((s, r) => s + r.due, 0);
    dispatch(logActivity(me, REMIND_ACTION, `เตือนชำระส่วนต่าง ${baht(due)} · ${rows.map((r) => r.ticket.ticket_no).join(', ')}`, { targetId: userId, targetLabel: live.name, amount: due }));
    if (!pushEnabled(db, COLLECT_PUSH_KEY)) return 'off';
    const devices = subsForUsers(db, [userId]);
    if (devices.length === 0) return 'nobell';
    await sendPush(devices, payload, dispatch).catch(() => {});
    return 'sent';
  };

  const remindOne = async (c: CollectCustomer, onlyTicketIds?: Set<string>) => {
    const r = await remind(c.userId, onlyTicketIds);
    flash(r === 'sent' ? `ส่งเตือน ${c.name} แล้ว 🔔` : r === 'nobell' ? `จดว่าเตือนแล้ว — ${c.name} ยังไม่เปิดกระดิ่ง ใช้ปุ่ม 📋 ก๊อปข้อความไปทักเอง`
      : r === 'off' ? `จดว่าเตือนแล้ว — แต่สวิตช์แจ้งเตือน "${COLLECT_PUSH_KEY}" ปิดอยู่ (หน้า Push)` : `${c.name} ไม่มีรายการให้ทวงแล้ว (เพิ่งจ่าย/ส่งสลิป)`);
  };
  const remindProduct = async (p: CollectProduct) => {
    const targets = p.customers.filter((c) => c.chaseable.some((r) => r.ticket.product_id === p.productId));
    if (targets.length === 0) return flash('ไม่มีใครให้ทวงในรายการนี้');
    if (!confirm(`เตือนลูกค้า ${targets.length} คน ที่ค้าง "${p.name}" ?\n(คนที่เปิดกระดิ่งจะได้ push · คนที่ไม่เปิดจะถูกจดไว้ว่าเตือนแล้ว ต้องทักเอง)`)) return;
    let sent = 0, nobell = 0;
    for (const c of targets) {
      const r = await remind(c.userId, new Set(c.chaseable.filter((x) => x.ticket.product_id === p.productId).map((x) => x.ticket.id)));
      if (r === 'sent') sent++; else if (r === 'nobell') nobell++;
    }
    flash(`ส่ง push แล้ว ${sent} คน${nobell ? ` · ไม่มีกระดิ่ง ${nobell} คน (ทักเอง)` : ''}`);
  };
  const copyMsg = async (c: CollectCustomer, rows: CollectTicket[] = c.chaseable) => {
    const ok = await copyText(collectMessage(db, c, rows, typeof window !== 'undefined' ? window.location.origin : undefined));
    if (!ok) return flash('คัดลอกไม่สำเร็จ');
    // ก๊อปไปทักเอง = เตือนแล้วเหมือนกัน → จด "เตือนล่าสุด" ด้วย (คนไม่มีกระดิ่งคือกลุ่มที่ต้องใช้ปุ่มนี้)
    const due = rows.reduce((s, r) => s + r.due, 0);
    dispatch(logActivity(me, REMIND_ACTION, `ก๊อปข้อความทวง ${baht(due)} · ${rows.map((r) => r.ticket.ticket_no).join(', ')}`, { targetId: c.userId, targetLabel: c.name, amount: due }));
    flash(`คัดลอกข้อความถึง ${c.name} แล้ว — วางใน LINE/เฟสได้เลย`);
  };

  /** ✅ Complete (เจ้าของ 2026-10-11): เคลียร์กันข้างนอกแล้ว (โอนตรง/มารับเอง/ตกลงทางแชท) → ปิดใบจากหน้านี้เลย
   *  กติกาเดียวกับปุ่ม "จบงานตั๋วนี้เลย" ในป๊อปอัปตั๋ว: โหลดสดก่อนตัดสินใจ → ยืนยันยอดที่ "รับนอกระบบ" (เงินต้องมีร่องรอยในสมุด)
   *  → completeTicketOffline (บันทึกรายได้ + ปิดใบเป็นเสร็จสิ้น) → read-back → เซฟให้จบ → ค่อยบอกว่าสำเร็จ (DNA save) */
  const completeOne = async (r: CollectTicket, c: CollectCustomer) => {
    if (lockRef.current) return;
    lockRef.current = r.ticket.id;
    setClosing(r.ticket.id);
    try {
      /** โหลดสดแล้วเช็คว่ายังปิดได้ไหม — เรียก 2 รอบ: ก่อนถามยืนยัน และ "หลัง" ยืนยัน (แอดมินอ่านป๊อปอัปได้เป็นนาที
       *  ลูกค้าส่งสลิป/ใบถูกปิดจากอีกเครื่องระหว่างนั้นได้ — ด่านใน mutation เห็นแต่ของเครื่องตัวเอง) */
      const check = async () => {
        if (!(await store.reload({ safe: true }))) { flash(store.reloadFailText('รอสักครู่แล้วลองใหม่')); return null; }
        const d = store.getState();
        const cur = d.tickets.find((x) => x.id === r.ticket.id);
        if (!cur || cur.owner_id !== c.userId) { flash(`${r.ticket.ticket_no} เปลี่ยนเจ้าของ/ถูกลบไปแล้ว — รีเฟรชหน้า`); return null; }
        if (cur.status === 'shipped') { flash(`${cur.ticket_no} จบงานไปแล้ว`); return null; }
        const pend = d.remainingPayments.find((x) => x.ticket_id === cur.id && x.status === 'pending');
        if (pend) {
          // สลิปเติมมัดจำ (ตลาด) อยู่คนละคิวกับสลิปส่วนต่าง — ชี้ให้ถูกที่ ไม่งั้นแอดมินไปหาไม่เจอ
          flash(pend.purpose === 'topup'
            ? `${cur.ticket_no} มีสลิปเติมมัดจำรอตรวจอยู่ — ไปอนุมัติ/ปฏิเสธที่ "ตลาดใบพรี" ก่อน`
            : `${cur.ticket_no} มีสลิปส่วนต่างรอตรวจอยู่ — ไปอนุมัติ/ปฏิเสธที่ "สลิป / ออเดอร์" ก่อน`);
          return null;
        }
        if (marketLocked(d, cur.id)) { flash(`${cur.ticket_no} ติดประกาศขายในตลาด — จบดีลหรือยกเลิกประกาศก่อน`); return null; }
        return { d, cur };
      };
      const first = await check();
      if (!first) return;
      const { d: nowDb, cur } = first;
      // ยอด "รับจริง" = ค้าง − โบนัสยศผูกใบ (สูตรเดียวกับ mutation และกระเป๋าลูกค้า) — ป๊อปอัปต้องบอกตัวเลขที่ลูกค้าจ่ายจริง
      const { due, bonus, receive } = offlineReceiveFor(nowDb, cur);
      const label = productLabel(nowDb, cur.product_id, cur.variant_id);
      const amountLine = bonus > 0 ? `ค้าง ${baht(due)} · โบนัสยศหักให้ −${baht(bonus)} · รับจริง ${baht(receive)}` : `ค้าง ${baht(due)}`;
      const msg = receive > 0
        ? `Complete ตั๋ว ${cur.ticket_no} ของ ${c.name} เลยไหม?\n\n${label} ×${cur.qty} · ${amountLine}\n\n`
          + `กดตกลง = ยืนยันว่า "รับเงินส่วนต่าง ${baht(receive)} นอกระบบครบแล้ว" — ระบบจะบันทึกเป็นรายได้ให้ และตั๋วจะกลายเป็น "เสร็จสิ้น" (หายจากคิวตามของ/จัดส่ง ไม่ต้องใส่เลขพัสดุ)\n`
          + `(ถ้ายังไม่ได้รับเงิน ห้ามกด — บัญชีจะเพี้ยน)`
        : `Complete ตั๋ว ${cur.ticket_no} ของ ${c.name} เลยไหม?\n\n${label} ×${cur.qty} · ${bonus > 0 ? amountLine : 'จ่ายครบแล้ว'}\nตั๋วจะกลายเป็น "เสร็จสิ้น" ไม่ต้องใส่เลขพัสดุ`;
      if (!confirm(msg)) return;
      const second = await check();
      if (!second) return;
      const again = offlineReceiveFor(second.d, second.cur);
      if (again.receive !== receive) return flash(`ยอดค้างของ ${cur.ticket_no} เพิ่งเปลี่ยน (ตอนนี้ ${baht(again.receive)}) — ดูใหม่แล้วกดอีกครั้ง`);
      dispatch(completeTicketOffline(cur.id, { collectRemaining: receive > 0 }));
      // read-back: mutation no-op ได้ (สลิปเพิ่งมา/ใบถูกปิดจากอีกเครื่อง) — ห้ามขึ้น ✓ ทั้งที่ไม่มีอะไรเปลี่ยน
      let ok = false;
      dispatch((d) => { ok = d.tickets.find((x) => x.id === cur.id)?.status === 'shipped'; return d; });
      if (!ok) return flash('ปิดใบไม่สำเร็จ — รีเฟรชแล้วลองใหม่');
      const pf = await store.flush();
      if (pf) return flash(persistFailText(pf, 'ยังบันทึกขึ้นระบบไม่ได้ — ระบบลองใหม่ให้อัตโนมัติ รอสักครู่แล้วรีเฟรชเช็ค'));
      dispatch(logActivity(me, 'close_delivery',
        `จบงานนอกระบบ ${cur.ticket_no} · ${c.name}${receive > 0 ? ` · รับส่วนต่างนอกระบบ ${baht(receive)}` : ''}${bonus > 0 ? ` · โบนัสยศ −${baht(bonus)}` : ''} (จากหน้าตามของ)`,
        { targetId: cur.id, targetLabel: cur.ticket_no, amount: receive }));
      flash(receive > 0 ? `Complete ${cur.ticket_no} ✓ บันทึกรับเงิน ${baht(receive)} แล้ว` : `Complete ${cur.ticket_no} ✓`);
    } finally { lockRef.current = null; setClosing(null); }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[20px] font-extrabold sm:text-[22px]">📣 ตามของ</div>
          <div className="text-[12.5px] text-ink-muted2">ของถึงไทยแล้ว แต่ลูกค้ายังไม่ชำระส่วนต่าง — ทวงได้เลย · รายการหายเองเมื่อลูกค้าจ่าย/ส่งสลิป</div>
        </div>
        <div className="flex gap-1.5">
          <ViewBtn active={view === 'product'} onClick={() => setView('product')}>📦 รายสินค้า</ViewBtn>
          <ViewBtn active={view === 'customer'} onClick={() => setView('customer')}>👤 รายคน</ViewBtn>
        </div>
      </div>

      {/* สรุปหัว */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="ค้างที่ทวงได้" value={baht(board.totalDue)} tone="warn" />
        <Stat label="ใบที่ค้าง" value={`${board.ticketCount} ใบ`} />
        <Stat label="ลูกค้าที่ค้าง" value={`${board.customerCount} คน`} />
        <Stat label="ส่งสลิปแล้ว รอตรวจ" value={`${board.awaitingSlip} ใบ`} tone={board.awaitingSlip ? 'info' : undefined} href={board.awaitingSlip ? '/admin/orders' : undefined} />
      </div>

      {board.shippedUnpaid.length > 0 && (
        <div className="rounded-xl border border-[#b91c1c]/50 bg-[#b91c1c]/10 p-3 text-[13px]">
          <div className="font-extrabold text-[#f87171]">⚠ ส่งของไปแล้วแต่ยังค้างเงิน {board.shippedUnpaid.length} ใบ — ไม่ควรเกิด ตรวจด่วน</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-muted2">
            {board.shippedUnpaid.map((t) => (
              <Link key={t.id} href={`/admin/customers/${t.owner_id}`} className="underline decoration-white/20">
                {db.users.find((u) => u.id === t.owner_id)?.display_name ?? '—'} · {productLabel(db, t.product_id, t.variant_id)} · <span className="font-mono">{t.ticket_no}</span> · ค้าง {baht(Math.max(0, t.remaining_amount - t.remaining_paid))}
              </Link>
            ))}
          </div>
        </div>
      )}

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 ค้นชื่อลูกค้า / รหัส / เบอร์ / เลขตั๋ว / สินค้า"
        className="w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-sm text-ink outline-none focus:border-accent" />

      {board.products.length === 0 ? (
        <div className="rounded-2xl border border-subtle bg-surface-2 p-8 text-center text-[13.5px] text-ink-faint">ไม่มีของค้างจ่าย — ของที่ถึงไทยจ่ายครบหมดแล้ว 🎉</div>
      ) : view === 'product' ? (
        <div className="flex flex-col gap-3">
          {products.length === 0 && <div className="text-[13px] text-ink-faint">ไม่พบตามคำค้น</div>}
          {products.map((p) => <ProductCard key={p.productId} p={p} closing={closing} onRemindAll={() => void remindProduct(p)} onRemind={(c) => void remindOne(c, new Set(c.chaseable.filter((x) => x.ticket.product_id === p.productId).map((x) => x.ticket.id)))} onCopy={(c) => void copyMsg(c, c.chaseable.filter((x) => x.ticket.product_id === p.productId))} onComplete={(r, c) => void completeOne(r, c)} />)}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {customers.length === 0 && <div className="text-[13px] text-ink-faint">ไม่พบตามคำค้น</div>}
          {customers.map((c) => <CustomerCard key={c.userId} c={c} showProduct closing={closing} onRemind={() => void remindOne(c)} onCopy={() => void copyMsg(c)} onComplete={(r) => void completeOne(r, c)} />)}
        </div>
      )}
      <div className="text-[11px] text-ink-faint">ℹ ฐานข้อมูลไม่ได้เก็บวันที่ "ถึงไทยเมื่อ" ต่อใบ — ใช้ "เตือนล่าสุด" (จดอัตโนมัติทุกครั้งที่กด 🔔 หรือ 📋) เป็นตัวช่วยไล่ลำดับแทน</div>
    </div>
  );
}

function ViewBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={cx('rounded-lg px-3 py-1.5 text-[13px] font-bold', active ? 'bg-primary text-white' : 'border border-subtle bg-surface-3 text-ink-muted2 hover:text-ink')}>{children}</button>;
}

function Stat({ label, value, tone, href }: { label: string; value: string; tone?: 'warn' | 'info'; href?: string }) {
  const cls = cx('min-w-0 rounded-xl border p-3', tone === 'warn' ? 'border-[#d97706]/40 bg-[#d97706]/[0.08]' : tone === 'info' ? 'border-[#2563eb]/40 bg-[#2563eb]/[0.08]' : 'border-subtle bg-surface-2');
  const inner = (<>
    <div className="text-[11px] text-ink-faint">{label}</div>
    <div className={cx('truncate text-[18px] font-extrabold', tone === 'warn' ? 'text-[#fbbf24]' : tone === 'info' ? 'text-[#93c5fd]' : 'text-ink')}>{value}</div>
    {href && <div className="text-[10.5px] text-ink-faint">ไปตรวจ →</div>}
  </>);
  return href ? <Link href={href} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>;
}

function ProductCard({ p, closing, onRemindAll, onRemind, onCopy, onComplete }: { p: CollectProduct; closing: string | null; onRemindAll: () => void; onRemind: (c: CollectCustomer) => void; onCopy: (c: CollectCustomer) => void; onComplete: (r: CollectTicket, c: CollectCustomer) => void }) {
  const chaseN = p.customers.filter((c) => c.chaseable.some((r) => r.ticket.product_id === p.productId)).length;
  return (
    <div className="min-w-0 rounded-2xl border border-subtle bg-surface-2 p-3.5">
      <div className="flex items-start gap-3">
        {p.image ? <img src={p.image} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" /> : <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-faint"><Icon name="box" size={20} /></div>}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-extrabold">{p.name}</div>
          <div className="mt-0.5 flex flex-wrap gap-1.5 text-[11.5px] font-bold">
            <span className="rounded-md bg-[#d97706]/20 px-1.5 py-0.5 text-[#fbbf24]">ค้าง {baht(p.due)}</span>
            <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-ink-muted2">{chaseN} คน · ทวง {p.ticketCount - p.awaitingSlip} จาก {p.totalTickets} ใบ</span>
            {p.awaitingSlip > 0 && <span className="rounded-md bg-[#2563eb]/[0.15] px-1.5 py-0.5 text-[#93c5fd]">รอตรวจสลิป {p.awaitingSlip}</span>}
          </div>
          {/* ใบที่เหลือของสินค้านี้ไปอยู่ไหน — ไม่งั้นเจ้าของนับใบไม่ครบแล้วคิดว่าข้อมูลหาย */}
          {p.totalTickets > p.ticketCount && (
            <div className="mt-1 text-[11.5px] text-ink-faint">
              อีก {p.totalTickets - p.ticketCount} ใบไม่ต้องทวง: {[
                p.others.paidFull ? `✓ จ่ายครบแล้ว ${p.others.paidFull}` : '',
                p.others.shipped ? `📦 ส่งพัสดุแล้ว ${p.others.shipped}` : '',
                p.others.notArrived ? `🚚 รอบอื่น ของยังไม่ถึงไทย ${p.others.notArrived}` : '',
              ].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        {chaseN > 0 && <button disabled={closing !== null} onClick={onRemindAll} className="shrink-0 rounded-lg border border-[#a855f7]/50 px-2.5 py-1.5 text-[12px] font-bold text-[#c084fc] disabled:opacity-40">🔔 เตือนทุกคน</button>}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {p.customers.map((c) => <CustomerCard key={c.userId} c={{ ...c, tickets: c.tickets.filter((r) => r.ticket.product_id === p.productId), chaseable: c.chaseable.filter((r) => r.ticket.product_id === p.productId) }} closing={closing} onRemind={() => onRemind(c)} onCopy={() => onCopy(c)} onComplete={(r) => onComplete(r, c)} />)}
      </div>
    </div>
  );
}

function CustomerCard({ c, showProduct, closing, onRemind, onCopy, onComplete }: { c: CollectCustomer; showProduct?: boolean; closing: string | null; onRemind: () => void; onCopy: () => void; onComplete: (r: CollectTicket) => void }) {
  const due = c.chaseable.reduce((s, r) => s + r.due, 0);
  const canChase = c.chaseable.length > 0;
  return (
    <div className={cx('min-w-0 rounded-xl border p-3', canChase ? 'border-subtle bg-surface-3' : 'border-subtle/60 bg-surface-3/50 opacity-75')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link href={`/admin/customers/${c.userId}`} className="text-[13.5px] font-bold underline decoration-white/20">{c.name}</Link>
        {c.memberCode && <span className="font-mono text-[11px] text-ink-faint">{c.memberCode}</span>}
        {c.phone && <span className="text-[11.5px] text-ink-muted2">📞 {c.phone}</span>}
        {c.lineId && <span className="text-[11.5px] text-ink-muted2">LINE {c.lineId}</span>}
        {c.plan && <span className="rounded-md bg-[#a855f7]/20 px-1.5 py-0.5 text-[10.5px] font-bold text-[#c084fc]">📅 มีนัด {c.plan.due_date}</span>}
        {!c.hasBell && canChase && <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[10.5px] text-ink-faint">ไม่มีกระดิ่ง</span>}
        <span className={cx('ml-auto text-[15px] font-extrabold', canChase ? 'text-[#fbbf24]' : 'text-ink-faint')}>{canChase ? baht(due) : '—'}</span>
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5 text-[12px]">
        {c.tickets.map((r) => (
          <div key={r.ticket.id} className={cx('flex flex-wrap items-center gap-x-2', (r.awaitingSlip || r.locked) && 'text-ink-faint line-through decoration-white/20')}>
            {showProduct && <span className="min-w-0 truncate">{r.label}</span>}
            <span>×{r.ticket.qty}</span>
            <span className="font-mono text-[11px]">{r.ticket.ticket_no}</span>
            <span className="font-bold no-underline">{baht(r.due)}</span>
            {r.awaitingSlip && <span className="rounded bg-[#2563eb]/[0.15] px-1.5 py-0.5 text-[10px] font-bold text-[#93c5fd] no-underline">ส่งสลิปแล้ว รอตรวจ</span>}
            {r.locked && <span className="rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-bold text-ink-muted2 no-underline">ติดประกาศขายในตลาด</span>}
            {/* ✅ Complete = เคลียร์กันข้างนอกแล้ว (ยืนยันยอดในป๊อปอัป) — เฉพาะใบที่ทวงได้: ใบรอตรวจสลิป/ติดตลาดต้องเคลียร์ทางนั้นก่อน */}
            {!r.awaitingSlip && !r.locked && (
              <button disabled={closing !== null} onClick={() => onComplete(r)} title="เคลียร์กันข้างนอกแล้ว — บันทึกรับเงินส่วนต่าง + ปิดใบเป็นเสร็จสิ้น"
                className="ml-auto rounded-md border border-[#16a34a]/50 px-2 py-0.5 text-[10.5px] font-bold text-[#4ade80] hover:bg-[#16a34a]/15 disabled:opacity-40">
                {closing === r.ticket.id ? '⏳ กำลังปิด…' : '✅ Complete'}
              </button>
            )}
          </div>
        ))}
      </div>
      {canChase && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* ระหว่าง Complete กำลัง reload/เซฟ — ห้ามยิงเตือน/ก๊อป (dispatch ที่ลงระหว่าง reload ถูกทับหายได้) */}
          <button disabled={closing !== null} onClick={onRemind} className="rounded-lg border border-[#a855f7]/50 px-3 py-1.5 text-[12px] font-bold text-[#c084fc] disabled:opacity-40">🔔 เตือน</button>
          <button disabled={closing !== null} onClick={onCopy} className="rounded-lg border border-subtle px-3 py-1.5 text-[12px] font-bold text-ink-muted2 hover:text-ink disabled:opacity-40">📋 ก๊อปข้อความ</button>
          {c.lastRemindedAt && <span className="text-[11px] text-ink-faint">เตือนล่าสุด {fmtTime(c.lastRemindedAt)}</span>}
        </div>
      )}
    </div>
  );
}
