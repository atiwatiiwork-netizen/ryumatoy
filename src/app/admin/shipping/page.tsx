'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { uploadImage } from '@/lib/upload';
import { productLabel, lineImage } from '@/domain/services/catalog';
import { deliveryRequests, parcelQueue, handoffQueue, awaitingChoice, resolveShipTo, DELIVERY_METHOD_LABEL } from '@/domain/services/delivery';
import { acceptDelivery, chooseDelivery, closeDelivery, markShippedOffline, setParcel } from '@/data/mutations';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import { LabelSheet } from '../orders/LabelSheet';
import type { Carrier, PreorderTicket } from '@/domain/entities';

const CARRIERS: { key: Carrier; label: string }[] = [
  { key: 'ems', label: 'EMS' },
  { key: 'jt', label: 'J&T' },
  { key: 'flash', label: 'Flash' },
  { key: 'kerry', label: 'Kerry' },
];
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

/**
 * ศูนย์จัดส่ง (เจ้าของ 2026-07-23) — งานส่งของครบวงจรที่เดียว:
 * ① คำขอรับของใหม่ → รับเรื่อง (Accept)  ② ปริ้นใบปะหน้า A4  ③ ใส่เลขพัสดุ → push "ส่งแล้ว"
 * ④ รถเข้ารับ/มารับเอง → ปิดงาน  ⑤ ประวัติส่งล่าสุด. ทุกการ์ดมี รูป + วันที่ + รายละเอียด.
 */
export default function ShippingPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();

  const dReq = deliveryRequests(db).sort((a, b) => ((a.delivery?.requested_at ?? '') < (b.delivery?.requested_at ?? '') ? 1 : -1));
  const dChoice = awaitingChoice(db);
  const dParcel = parcelQueue(db);
  const dHandoff = handoffQueue(db);
  const recentShipped = db.tickets.filter((t) => t.status === 'shipped').sort((a, b) => ((a.shipped_out_at ?? '') < (b.shipped_out_at ?? '') ? 1 : -1)).slice(0, 10);
  const userName = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '—';

  // read-back หลัง dispatch — mutation guard อาจ no-op (แท็บอื่นจัดการไปแล้ว/สถานะเปลี่ยน):
  // ห้าม flash ✓ + push หาลูกค้าทั้งที่ไม่มีอะไรเกิดขึ้น (audit 2026-07-23 false-success class)
  const verify = (ticketId: string, pred: (t: PreorderTicket) => boolean) => {
    let ok = false;
    dispatch((d) => { const x = d.tickets.find((tt) => tt.id === ticketId); ok = !!x && pred(x); return d; });
    return ok;
  };
  const staleFlash = () => flash('รายการนี้ถูกจัดการไปแล้ว/สถานะเปลี่ยน — ตรวจหน้าอีกครั้ง');
  const dueOf = (t: PreorderTicket) => t.remaining_amount - t.remaining_paid;

  const accept = (t: PreorderTicket) => {
    dispatch(acceptDelivery(t.id));
    if (!verify(t.id, (x) => !!x.delivery?.accepted_at)) return staleFlash();
    if (pushEnabled(db, 'parcel') && t.delivery) {
      const body = t.delivery.method === 'courier' ? 'เรียกรถเข้ามารับของได้เลย — นัดเวลากับแอดมินทางแชท'
        : t.delivery.method === 'pickup' ? 'เข้ามารับของได้เลย — นัดวัน-เวลากับแอดมินทางแชท'
          : 'กำลังแพ็คของ รอแจ้งเลขพัสดุได้เลย';
      sendPush(subsForUsers(db, [t.owner_id]), { title: '✅ รับเรื่องจัดส่งแล้ว', body, url: `/wallet/${encodeURIComponent(t.ticket_no)}` }, dispatch).catch(() => {});
    }
    flash(`รับเรื่องแล้ว · ${DELIVERY_METHOD_LABEL[t.delivery!.method]} ✓`);
  };

  const closeJob = (t: PreorderTicket) => {
    const warn = dueOf(t) > 0 ? `\n⚠ ตั๋วนี้ยังค้างชำระ ${baht(dueOf(t))} — เก็บเงินก่อนปิดงาน!` : '';
    if (!confirm(`ปิดงาน ${t.ticket_no} — ลูกค้ารับของแล้วใช่ไหม?${warn}`)) return;
    dispatch(closeDelivery(t.id));
    if (!verify(t.id, (x) => x.status === 'shipped')) return staleFlash();
    if (pushEnabled(db, 'parcel'))
      sendPush(subsForUsers(db, [t.owner_id]), { title: '📦 รับของเรียบร้อย', body: 'ขอบคุณที่อุดหนุนริวมะครับ 🙏', url: `/wallet/${encodeURIComponent(t.ticket_no)}` }, dispatch).catch(() => {});
    flash(`ปิดงานแล้ว · ${t.ticket_no} ✓`);
  };

  // ⓪ ตั๋วที่รอลูกค้ากดเลือกวิธีรับของ — แอดมินเตือน / จัดส่งตามที่อยู่ลงทะเบียนแทน / ปิดงานตั๋วเก่านอกระบบ
  const nudge = (t: PreorderTicket) => {
    if (pushEnabled(db, 'parcel'))
      sendPush(subsForUsers(db, [t.owner_id]), { title: '📦 ของพร้อมส่งแล้ว!', body: 'ชำระครบแล้ว — แตะเลือกวิธีรับของได้เลย', url: `/wallet/${encodeURIComponent(t.ticket_no)}` }, dispatch).catch(() => {});
    flash(`ส่งแจ้งเตือนให้ ${userName(t.owner_id)} แล้ว 🔔`);
  };
  const shipToRegistered = (t: PreorderTicket) => {
    const u = db.users.find((x) => x.id === t.owner_id);
    if (!confirm(`จัดส่ง ${t.ticket_no} ตามที่อยู่ที่ลงทะเบียนของ ${u?.display_name}?\n📍 ${u?.shipping_address}`)) return;
    dispatch(chooseDelivery(t.id, t.owner_id, 'registered'));
    dispatch(acceptDelivery(t.id));
    if (!verify(t.id, (x) => x.delivery?.method === 'registered' && !!x.delivery.accepted_at)) return staleFlash();
    if (pushEnabled(db, 'parcel'))
      sendPush(subsForUsers(db, [t.owner_id]), { title: '✅ รับเรื่องจัดส่งแล้ว', body: 'แอดมินจัดส่งตามที่อยู่ที่ลงทะเบียนให้ — รอเลขพัสดุได้เลย', url: `/wallet/${encodeURIComponent(t.ticket_no)}` }, dispatch).catch(() => {});
    flash(`เข้าคิวจัดส่งแล้ว · ${t.ticket_no} ✓`);
  };
  const closeOffline = (t: PreorderTicket) => {
    if (!confirm(`ปิดงาน ${t.ticket_no} — ตั๋วนี้ส่ง/รับของกันนอกระบบไปแล้วใช่ไหม? (ไม่ push หาลูกค้า)`)) return;
    dispatch(markShippedOffline(t.id));
    if (!verify(t.id, (x) => x.status === 'shipped')) return staleFlash();
    flash(`ปิดงานนอกระบบ · ${t.ticket_no} ✓`);
  };

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">จัดส่ง</div>
      <div className="mb-4 text-[13px] text-ink-faint">ศูนย์จัดการส่งของครบวงจร — รับเรื่อง → ปริ้นใบปะหน้า → ใส่เลขพัสดุ (แจ้งลูกค้าอัตโนมัติ) → ปิดงาน</div>

      {/* สรุปงานวันนี้ — เห็นแวบเดียวรู้ว่าค้างอะไร */}
      <div className="mb-5 grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        <Stat label="รอลูกค้าเลือกวิธีรับ" value={dChoice.length} tone="text-[#c084fc]" icon="ticket" pulse={dChoice.length > 0} />
        <Stat label="คำขอใหม่ รอรับเรื่อง" value={dReq.length} tone="text-[#fbbf24]" icon="bell" pulse={dReq.length > 0} />
        <Stat label="รอใส่เลขพัสดุ" value={dParcel.length} tone="text-[#f87171]" icon="box" />
        <Stat label="รถเข้ารับ / มารับเอง" value={dHandoff.length} tone="text-[#60a5fa]" icon="user" />
        <Stat label="ส่งแล้ว (ทั้งหมด)" value={db.tickets.filter((t) => t.status === 'shipped').length} tone="text-[#4ade80]" icon="check" />
      </div>

      {/* ⓪ จ่ายครบแล้วแต่ยังไม่กดเลือกวิธีรับของ — เดิมตั๋วพวกนี้ไม่โผล่คิวไหนเลย (เคส Taweesin) */}
      <Section icon="ticket" tone="text-[#c084fc]" title="จ่ายครบแล้ว · รอลูกค้าเลือกวิธีรับของ" count={dChoice.length} sub="ลูกค้ายังไม่ได้กดเลือกวิธีรับของ — เตือนลูกค้า หรือแอดมินจัดส่งตามที่อยู่ลงทะเบียนให้เลย · ตั๋วเก่าที่เคยส่งนอกระบบ กดปิดงานทิ้งได้">
        {dChoice.length === 0 ? <Empty text="ไม่มีตั๋วค้าง 🎉" /> : (
          <div className="grid gap-2.5 lg:grid-cols-2">
            {dChoice.map((t) => {
              const u = db.users.find((x) => x.id === t.owner_id);
              return (
                <div key={t.id} className="rounded-xl border border-[#a855f7]/35 bg-surface-2 p-3.5">
                  <div className="flex items-start gap-3">
                    <Thumb ticket={t} size={52} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-bold">{productLabel(db, t.product_id, t.variant_id)}{t.qty > 1 ? ` ×${t.qty}` : ''}</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-muted2"><Icon name="user" size={11} className="mr-0.5 inline" /> {userName(t.owner_id)} · <span className="font-mono text-[10.5px] text-ink-faint">{t.ticket_no}</span></div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-[#16a34a]/15 px-1.5 py-0.5 text-[10.5px] font-bold text-[#4ade80]">จ่ายครบ ✓ {baht(t.deposit_paid + t.remaining_paid)}</span>
                        {u?.shipping_address
                          ? <span className="line-clamp-1 text-[10.5px] text-ink-faint">📍 {u.shipping_address}</span>
                          : <span className="text-[10.5px] font-bold text-[#fbbf24]">⚠ โปรไฟล์ไม่มีที่อยู่</span>}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <button onClick={() => nudge(t)} className="flex-1 rounded-lg border border-[#a855f7]/50 py-2 text-[12.5px] font-bold text-[#c084fc]">🔔 เตือนลูกค้า</button>
                    <button onClick={() => shipToRegistered(t)} disabled={!u?.shipping_address}
                      className={cx('flex-1 rounded-lg py-2 text-[12.5px] font-bold', u?.shipping_address ? 'bg-cta text-white' : 'cursor-not-allowed bg-surface-3 text-ink-faint')}>
                      📮 ส่งตามที่อยู่ลงทะเบียน
                    </button>
                    <button onClick={() => closeOffline(t)} className="shrink-0 rounded-lg border border-subtle px-2.5 py-2 text-[11.5px] text-ink-faint" title="ตั๋วเก่าที่ส่ง/รับของนอกระบบไปแล้ว">ปิดงาน</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ① คำขอรับของใหม่ → รับเรื่อง */}
      <Section icon="bell" tone="text-[#fbbf24]" title="คำขอรับของใหม่ · รอรับเรื่อง" count={dReq.length} sub="ลูกค้าเลือกวิธีรับของแล้ว → กดรับเรื่อง: ส่งพัสดุเข้าคิวใบปะหน้า/เลขพัสดุ · รับเอง-รถเข้ารับ รอปิดงาน">
        {dReq.length === 0 ? <Empty text="ไม่มีคำขอค้าง 🎉" /> : (
          <div className="grid gap-2.5 lg:grid-cols-2">
            {dReq.map((t) => {
              const to = resolveShipTo(db, t);
              const isShip = t.delivery!.method === 'registered' || t.delivery!.method === 'custom';
              return (
                <div key={t.id} className="rounded-xl border border-[#d97706]/35 bg-surface-2 p-3.5">
                  <div className="flex items-start gap-3">
                    <Thumb ticket={t} size={52} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-bold">{productLabel(db, t.product_id, t.variant_id)}{t.qty > 1 ? ` ×${t.qty}` : ''}</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-muted2"><Icon name="user" size={11} className="mr-0.5 inline" /> {userName(t.owner_id)} · <span className="font-mono text-[10.5px] text-ink-faint">{t.ticket_no}</span></div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-[#d97706]/20 px-1.5 py-0.5 text-[10.5px] font-bold text-[#fbbf24]">{DELIVERY_METHOD_LABEL[t.delivery!.method]}</span>
                        <span className="text-[10.5px] text-ink-faint">ขอเมื่อ {fmtDate(t.delivery!.requested_at)}</span>
                        {dueOf(t) > 0 && <span className="animate-blink rounded-md bg-[#b91c1c]/25 px-1.5 py-0.5 text-[10.5px] font-extrabold text-[#f87171]">⚠ ค้างชำระ {baht(dueOf(t))}</span>}
                      </div>
                      {isShip && <div className="mt-1 line-clamp-2 text-[11.5px] text-ink-faint">📍 {to.name} {to.phone} · {to.address || '— ไม่มีที่อยู่ (ทักลูกค้า)'}</div>}
                    </div>
                  </div>
                  <button onClick={() => accept(t)} className="mt-2.5 w-full rounded-lg bg-success py-2 text-[13px] font-bold text-white">✓ รับเรื่อง</button>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ② ใบปะหน้า A4 (ระบบที่ทำไว้แล้ว — ย้ายมาอยู่ศูนย์จัดส่ง) */}
      <LabelSheet tickets={dParcel} />

      {/* ③ รอใส่เลขพัสดุ → push "ส่งแล้ว" อัตโนมัติหลังกรอกเลข */}
      <Section icon="box" tone="text-[#f87171]" title="รอใส่เลขพัสดุ" count={dParcel.length} sub="แพ็คเสร็จ → เลือกขนส่ง + กรอกเลข = ตั๋วเสร็จสิ้น + push แจ้งลูกค้า 'ส่งแล้ว' ทันที">
        {dParcel.length === 0 ? <Empty text="ไม่มีพัสดุรอจัดส่ง" /> : (
          <div className="flex flex-col gap-3">
            {dParcel.map((t) => <TrackRow key={t.id} ticket={t} />)}
          </div>
        )}
      </Section>

      {/* ④ รถเข้ารับ / มารับเอง → ปิดงาน */}
      <Section icon="user" tone="text-[#60a5fa]" title="รถเข้ารับ / มารับเอง · รอปิดงาน" count={dHandoff.length} sub="ของออกจากมือแล้ว → กดปิดงาน (ไม่ต้องใส่เลขพัสดุ)">
        {dHandoff.length === 0 ? <Empty text="—" /> : (
          <div className="grid gap-2.5 lg:grid-cols-2">
            {dHandoff.map((t) => (
              <div key={t.id} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-2 p-3">
                <Thumb ticket={t} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold">{productLabel(db, t.product_id, t.variant_id)}{t.qty > 1 ? ` ×${t.qty}` : ''}</div>
                  <div className="text-[11.5px] text-ink-faint">{userName(t.owner_id)} · <span className="rounded bg-[#2563eb]/20 px-1 py-0.5 text-[10px] font-bold text-[#60a5fa]">{DELIVERY_METHOD_LABEL[t.delivery!.method]}</span> · รับเรื่อง {fmtDate(t.delivery!.accepted_at)}{dueOf(t) > 0 && <span className="ml-1.5 animate-blink rounded bg-[#b91c1c]/25 px-1 py-0.5 text-[10px] font-extrabold text-[#f87171]">⚠ ค้างชำระ {baht(dueOf(t))}</span>}</div>
                </div>
                <button onClick={() => closeJob(t)} className="shrink-0 rounded-lg bg-cta px-3.5 py-2 text-[12.5px] font-bold text-white">ปิดงาน ✓</button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ⑤ ส่งแล้วล่าสุด */}
      {recentShipped.length > 0 && (
        <Section icon="check" tone="text-[#4ade80]" title="ส่งแล้วล่าสุด" count={recentShipped.length} sub="10 รายการล่าสุด">
          <div className="flex flex-col gap-2">
            {recentShipped.map((t) => (
              <div key={t.id} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-2 px-3.5 py-2.5 text-[13px]">
                <Thumb ticket={t} size={38} />
                <div className="min-w-0 flex-1 truncate"><span className="font-semibold">{productLabel(db, t.product_id, t.variant_id)}</span> <span className="text-ink-faint">· {userName(t.owner_id)}</span></div>
                <span className="shrink-0 text-[11px] text-ink-faint">{fmtDate(t.shipped_out_at)}</span>
                {t.parcel_no
                  ? <span className="shrink-0 rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-ink-muted2">{CARRIERS.find((c) => c.key === t.carrier)?.label ?? ''} {t.parcel_no}</span>
                  : <span className="shrink-0 rounded-md bg-[#16a34a]/15 px-2 py-0.5 text-[10.5px] font-bold text-[#4ade80]">{t.delivery ? DELIVERY_METHOD_LABEL[t.delivery.method] : 'รับแล้ว'} ✓</span>}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/* ── แถวกรอกเลขพัสดุ (ยกจาก orders hub เดิม + push ส่งแล้วหลังกรอกเลข) ── */
function TrackRow({ ticket }: { ticket: PreorderTicket }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const to = resolveShipTo(db, ticket);
  const [carrier, setCarrier] = useState<Carrier | null>(null);
  const [no, setNo] = useState('');
  const [img, setImg] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const userName = db.users.find((u) => u.id === ticket.owner_id)?.display_name ?? '—';

  const onImg = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setImg(await uploadImage(file, 'parcel')); flash('แนบรูปแล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  const ship = () => {
    if (busy) return; // กันดับเบิลคลิก = push "ส่งแล้ว" ซ้ำหาลูกค้า
    if (!carrier) return flash('เลือกขนส่งก่อน');
    if (!no.trim()) return flash('ใส่เลขพัสดุก่อน');
    setBusy(true);
    dispatch(setParcel(ticket.id, carrier, no.trim(), img));
    // read-back: setParcel no-op ถ้าตั๋ว shipped ไปแล้ว (แท็บอื่นชิงกด) — อย่า push/flash ซ้ำ
    let applied = false;
    dispatch((d) => { const x = d.tickets.find((tt) => tt.id === ticket.id); applied = x?.status === 'shipped' && x.parcel_no === no.trim(); return d; });
    setBusy(false);
    if (!applied) return flash('ตั๋วนี้ถูกจัดส่งไปแล้ว — ตรวจหน้าอีกครั้ง');
    const cLabel = CARRIERS.find((c) => c.key === carrier)?.label ?? carrier;
    // push "ส่งแล้ว" ให้ลูกค้าทันทีหลังกรอกเลข (เจ้าของ 2026-07-23 ข้อ 3)
    if (pushEnabled(db, 'parcel'))
      sendPush(subsForUsers(db, [ticket.owner_id]), { title: '📮 พัสดุจัดส่งแล้ว!', body: `${cLabel} · ${no.trim()} — แตะเพื่อดูตั๋ว`, url: `/wallet/${encodeURIComponent(ticket.ticket_no)}` }, dispatch).catch(() => {});
    flash(`จัดส่งแล้ว · ${ticket.ticket_no} ✓ แจ้งลูกค้าแล้ว`);
  };

  return (
    <div className="rounded-xl border border-[#b91c1c]/30 bg-surface-2 p-3.5">
      <div className="mb-2 flex items-center gap-2.5">
        <Thumb ticket={ticket} size={44} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{productLabel(db, ticket.product_id, ticket.variant_id)}{ticket.qty > 1 ? ` ×${ticket.qty}` : ''} <span className="font-normal text-ink-faint">· {userName}</span></div>
          <div className="mt-0.5 line-clamp-1 text-[11.5px] text-ink-faint">📍 {to.name} {to.phone} · {to.address || '— ไม่มีที่อยู่'}</div>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-ink-faint">{ticket.ticket_no}</span>
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {CARRIERS.map((c) => (
          <button key={c.key} onClick={() => setCarrier(c.key)}
            className={cx('rounded-lg border px-3 py-1.5 text-[12.5px] font-bold', carrier === c.key ? 'border-accent bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={no} onChange={(e) => setNo(e.target.value)} placeholder="เลขพัสดุ (Tracking no)" className="flex-1 rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint" />
        <label className={cx('grid cursor-pointer place-items-center rounded-lg border px-3 text-[12px]', img ? 'border-[#16a34a]/50 text-[#4ade80]' : 'border-subtle text-ink-faint')}>
          <input type="file" accept="image/*" className="hidden" onChange={(e) => onImg(e.target.files?.[0])} />
          {busy ? '…' : img ? '✓ รูป' : <Icon name="camera" size={16} />}
        </label>
        <button onClick={ship} className="rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white">จัดส่ง + แจ้งลูกค้า</button>
      </div>
    </div>
  );
}

/* ── ชิ้นส่วนเล็ก ── */
function Thumb({ ticket, size = 48 }: { ticket: PreorderTicket; size?: number }) {
  const db = useDatabase();
  const img = lineImage(db, ticket.product_id, ticket.variant_id);
  return (
    <div className="shrink-0 overflow-hidden rounded-lg border border-subtle bg-stripe" style={{ width: size, height: size }}>
      {img
        ? <img src={img} alt="" className="h-full w-full object-cover" />
        : <div className="grid h-full w-full place-items-center"><Icon name="box" size={Math.round(size * 0.42)} className="text-primary-soft/25" /></div>}
    </div>
  );
}
function Stat({ label, value, tone, icon, pulse }: { label: string; value: number; tone: string; icon: Parameters<typeof Icon>[0]['name']; pulse?: boolean }) {
  return (
    <div className={cx('rounded-card border border-subtle bg-surface-2 p-3.5', pulse && 'animate-pulseRed border-accent')}>
      <div className="flex items-center justify-between"><span className="text-[11.5px] text-ink-muted">{label}</span><Icon name={icon} size={16} className={tone} /></div>
      <div className={cx('mt-1 text-[24px] font-extrabold', tone)}>{value}</div>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="py-3 text-[13px] text-ink-faint">{text}</div>;
}
function Section({ icon, tone, title, count, sub, children }: { icon: Parameters<typeof Icon>[0]['name']; tone: string; title: string; count: number; sub?: string; children: React.ReactNode }) {
  return (
    <div className="mb-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 flex items-center gap-2 text-base font-bold text-ink">
        <Icon name={icon} size={18} className={tone} /> <span>{title}</span>
        <span className="ml-1 rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] text-ink-muted2">{count}</span>
      </div>
      {sub && <div className="mb-3 text-[11.5px] text-ink-faint">{sub}</div>}
      {!sub && <div className="mb-3" />}
      {children}
    </div>
  );
}
