'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { uploadImage } from '@/lib/upload';
import { Icon } from '@/components/Icon';
import { Button, BackBar, ProgressBar, QrPanel, TicketQr, cx } from '@/components/ui';
import { franchiseOf, productLabel, lineImage } from '@/domain/services/catalog';
import { paidPercent } from '@/domain/services/tickets';
import { computeEta, etaRangeLabel, etaDaysLabel } from '@/domain/services/shipping';
import { warehouseEtaLabel } from '@/domain/services/warehouse';
import { submitRemainingPayment, chooseDelivery } from '@/data/mutations';
import { deliveryReady, DELIVERY_METHOD_LABEL } from '@/domain/services/delivery';
import { store } from '@/data/store';
import { preorderCouponsForTicket, couponDiscount } from '@/domain/services/coupons';
import { CouponTicket } from '@/components/CouponTicket';
import { useSmartBack } from '@/lib/nav';
import { notifyAdminLine } from '@/lib/notify';
import { copyText, digitsOnly } from '@/lib/clipboard';
import type { ProductStatus, PreorderTicket, DeliveryMethod } from '@/domain/entities';

const TIMELINE: { key: ProductStatus; label: string }[] = [
  { key: 'open', label: 'เปิดจอง' },
  { key: 'production', label: 'ผลิต' },
  { key: 'shipping', label: 'เดินทาง' },
  { key: 'arrived', label: 'ถึงไทย' },
  { key: 'delivered', label: 'ส่งมอบ' },
];

export default function TicketDetailPage() {
  const { ticketNo } = useParams<{ ticketNo: string }>();
  const router = useRouter();
  const goBack = useSmartBack('/wallet');
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const CURRENT_USER_ID = useCurrentUserId();

  // HOOKS ทั้งหมดต้องอยู่ก่อน early-return (Rules of Hooks) — เดิม useState อยู่หลัง "ไม่พบใบพรี" →
  // เปิดลิงก์ตั๋วตรงๆ (จาก push/refresh): render แรกข้อมูลยังไม่มา = return สั้น, พอโหลดเสร็จ hooks เพิ่ม
  // → "Rendered more hooks" หน้าขาวทั้งหน้า (เคสจริง Taweesin 2026-07-23: ไม่เห็นตัวเลือกวิธีรับของ)
  const [paying, setPaying] = useState(false);
  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [couponGrantId, setCouponGrantId] = useState<string>('');

  const ticket = db.tickets.find((t) => t.ticket_no === decodeURIComponent(ticketNo));
  if (!ticket) return <div className="p-10 text-ink-faint">ไม่พบใบพรี</div>;

  const product = db.products.find((p) => p.id === ticket.product_id)!;
  const ticketImg = lineImage(db, ticket.product_id, ticket.variant_id); // honour the picked variant's image
  const pct = paidPercent(ticket.deposit_paid, ticket.remaining_amount, ticket.remaining_paid);
  const due = ticket.remaining_amount - ticket.remaining_paid;
  const isShipped = ticket.status === 'shipped';
  // ตั๋ว IN-STOCK: timeline พรี (เปิดจอง→ผลิต→…) ไม่ตรงความจริง (เคยค้างที่ "เปิดจอง" — เคส Taweesin
  // 2026-07-23). ใช้เส้นทางของจริงแทน: ชำระแล้ว → เลือกวิธีรับของ → รอจัดส่ง (รอเลขพัสดุ) → เสร็จสิ้น
  const isStockTicket = product.is_stock;
  const steps: string[] = isStockTicket
    ? ['ชำระเงินแล้ว', 'เลือกวิธีรับของ', 'รอจัดส่ง', 'เสร็จสิ้น']
    : TIMELINE.map((s) => s.label);
  const currentIdx = isStockTicket
    ? (isShipped ? 3 : ticket.delivery ? 2 : 1)
    : (isShipped ? TIMELINE.length - 1 : TIMELINE.findIndex((s) => s.key === ticket.product_status));
  const carrierLabel: Record<string, string> = { ems: 'EMS', jt: 'J&T', flash: 'Flash', kerry: 'Kerry' };
  const eta = ticket.product_status === 'shipping' ? computeEta(db.settings, product.shipped_at) : null;
  // warehouse-confirmed tickets carry their OWN start date + transport (ryuma-warehouse-spec) →
  // that ETA wins over the lot-level one.
  const whEta = ticket.product_status === 'shipping' && ticket.warehouse_at ? warehouseEtaLabel(db, ticket) : '';

  // remaining-balance payment: available once the lot is shipping onward
  const canPay = due > 0 && ['shipping', 'arrived', 'delivered'].includes(ticket.product_status);
  const pendingRP = db.remainingPayments.find((r) => r.ticket_id === ticket.id && r.status === 'pending');
  const account = db.paymentAccounts.find((a) => a.active) ?? db.paymentAccounts[0];

  // pre-order coupon: reduces this final payment (only usable coupons that match this product)
  const eligibleCoupons = preorderCouponsForTicket(db, CURRENT_USER_ID, product);
  const selectedCoupon = eligibleCoupons.find((x) => x.grant.id === couponGrantId);
  const couponOff = selectedCoupon ? couponDiscount(selectedCoupon.coupon, due) : 0;
  const payable = Math.max(0, due - couponOff);

  const onSlip = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setSlip(await uploadImage(file, 'slip')); flash('แนบสลิปแล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  const payRemaining = () => {
    if (!slip) return;
    dispatch(submitRemainingPayment(ticket.id, CURRENT_USER_ID, payable, slip, selectedCoupon ? { grantId: selectedCoupon.grant.id, discount: couponOff } : undefined));
    notifyAdminLine(`💸 สลิปส่วนต่างใหม่: ${ticket.ticket_no} · ${payable.toLocaleString()} บาท`);
    flash('ส่งสลิปส่วนต่างแล้ว · รอ Admin ตรวจสอบ');
    setPaying(false); setSlip(null); setCouponGrantId('');
  };

  const resell = () => {
    // P2P Market ยังไม่เปิด (parked) — listForResale จะล็อกตั๋วแบบกู้คืนไม่ได้ + ยังไม่มีตลาด/ปุ่มยกเลิก
    // จึงกันไว้ก่อน ให้ตรงกับสถานะ "เร็วๆ นี้" ที่อื่น (audit: P2P dead-end). ปลดล็อกเมื่อระบบ P2P พร้อม.
    flash('ตลาดซื้อขายใบพรี (P2P) กำลังพัฒนา — เร็วๆ นี้');
  };

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="ใบพรี" onBack={goBack} />

      <div className="relative mb-4 rounded-2xl border border-[#b91c1c]/35 bg-surface-2 px-[18px] py-[22px] text-center">
        <div className="absolute -left-[9px] top-[55%] h-[18px] w-[18px] rounded-full bg-base" />
        <div className="absolute -right-[9px] top-[55%] h-[18px] w-[18px] rounded-full bg-base" />
        <div className="mb-3.5 font-mono text-[15px] tracking-wider text-primary-soft">{ticket.ticket_no}</div>
        <div className="flex justify-center"><TicketQr value={typeof window !== 'undefined' ? `${window.location.origin}/wallet/${encodeURIComponent(ticket.ticket_no)}` : ticket.ticket_no} size={150} /></div>
        <div className="mt-3 text-[11.5px] text-ink-faint">แสดง QR นี้เพื่อยืนยันตัวตนตอนรับของ</div>
      </div>

      <div className="mb-3.5 flex items-center gap-3 rounded-card border border-subtle bg-surface-2 p-3">
        <div className="grid h-[52px] w-[52px] shrink-0 place-items-center overflow-hidden rounded-[10px] bg-stripe">
          {ticketImg ? <img src={ticketImg} alt="" className="h-full w-full object-cover" /> : <Icon name="box" size={22} className="text-primary-soft/25" />}
        </div>
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold">{productLabel(db, ticket.product_id, ticket.variant_id)}</div>
          {/* title ลงท้ายด้วยค่ายแล้ว (productLabel) → บรรทัดรองเหลือแค่เรื่อง กันซ้ำ */}
          <div className="text-[11.5px] text-ink-faint">{franchiseOf(db, product)?.name}</div>
        </div>
      </div>

      {whEta ? (
        <div className="mb-3.5 flex items-center gap-2.5 rounded-card border border-[#2563eb]/30 bg-[#2563eb]/10 px-4 py-3">
          <Icon name="truck" size={18} className="text-[#60a5fa]" />
          <div className="text-[13px] text-[#bcd3f5]">🚢 ถึงโกดังจีนแล้ว · {whEta}</div>
        </div>
      ) : eta && (
        <div className="mb-3.5 flex items-center gap-2.5 rounded-card border border-[#2563eb]/30 bg-[#2563eb]/10 px-4 py-3">
          <Icon name="truck" size={18} className="text-[#60a5fa]" />
          <div className="text-[13px] text-[#bcd3f5]">คาดว่าถึงไทย <b>{etaRangeLabel(eta)}</b> {etaDaysLabel(eta)}{product.tracking_no ? <> · <span className="font-mono text-[11px]">Track {product.tracking_no}</span></> : null}</div>
        </div>
      )}

      {isShipped && ticket.parcel_no && (
        <div className="mb-3.5 rounded-card border border-[#16a34a]/35 bg-[#16a34a]/[0.1] px-4 py-3">
          <div className="mb-1 flex items-center gap-2 text-[13px] font-bold text-[#4ade80]"><Icon name="truck" size={17} /> จัดส่งแล้ว · {carrierLabel[ticket.carrier ?? ''] ?? ticket.carrier}</div>
          <div className="font-mono text-[13px] text-ink">เลขพัสดุ {ticket.parcel_no}</div>
          {ticket.parcel_image && /^https?:|^data:/.test(ticket.parcel_image) && (
            <a href={ticket.parcel_image} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-[12px] text-[#60a5fa] underline">ดูรูปพัสดุ</a>
          )}
        </div>
      )}

      {/* รับเอง/รถเข้ารับ ที่แอดมินปิดงานแล้ว (ไม่มีเลขพัสดุ) → จบงานเหมือนกัน */}
      {isShipped && !ticket.parcel_no && (ticket.delivery?.method === 'courier' || ticket.delivery?.method === 'pickup') && (
        <div className="mb-3.5 flex items-center gap-2.5 rounded-card border border-[#16a34a]/35 bg-[#16a34a]/[0.1] px-4 py-3">
          <Icon name="check" size={18} className="text-[#4ade80]" />
          <div className="text-[13px] text-[#4ade80]"><b>รับของเรียบร้อยแล้ว ✓</b> · {DELIVERY_METHOD_LABEL[ticket.delivery.method]}</div>
        </div>
      )}

      <div className="mb-3.5 rounded-card border border-subtle bg-surface-2 p-4">
        <div className="mb-2 flex justify-between text-[13px]"><span className="text-[#4ade80]">มัดจำที่จ่ายแล้ว ✓</span><span className="font-bold">{baht(ticket.deposit_paid)}</span></div>
        <div className="mb-3 flex justify-between text-[13px]"><span className="text-ink-muted">ส่วนต่างคงเหลือ</span><span className={cx('font-bold', due > 0 ? 'text-primary-soft' : 'text-[#4ade80]')}>{due > 0 ? baht(due) : 'จ่ายครบ'}</span></div>
        <ProgressBar pct={pct} />
        <div className="mt-[7px] text-[11.5px] text-ink-faint">จ่ายแล้ว {pct}%</div>
      </div>

      <div className="mb-4 rounded-card border border-subtle bg-surface-2 px-4 py-[18px]">
        <div className="relative flex justify-between">
          <div className="absolute left-3.5 right-3.5 top-[11px] h-0.5 bg-white/10" />
          {steps.map((label, i) => {
            const done = i < currentIdx || (i === currentIdx && isShipped);
            const current = i === currentIdx && !isShipped;
            return (
              <div key={label} className="relative z-10 flex-1 text-center">
                <div className={cx('mx-auto grid h-6 w-6 place-items-center rounded-full border-2', done ? 'border-[#16a34a] bg-[#16a34a]' : current ? 'animate-pulseRed border-[#dc2626] bg-[#dc2626]' : 'border-white/15 bg-surface-3')}>
                  {done && <Icon name="check" size={13} className="text-white" />}
                </div>
                <div className={cx('mt-1.5 text-[10.5px]', current ? 'font-bold text-ink' : 'text-ink-faint')}>{label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* arrived → notify again to pay the remaining */}
      {ticket.product_status === 'arrived' && due > 0 && !pendingRP && (
        <div className="mb-4 flex animate-pulseRed items-center gap-2.5 rounded-card border border-accent bg-[#b91c1c]/[0.12] px-4 py-3">
          <Icon name="bell" size={18} className="text-primary-soft" />
          <div className="text-[13px] text-primary-soft">ถึงไทยแล้ว! ชำระส่วนต่าง {baht(due)} เพื่อรับของ</div>
        </div>
      )}

      {/* remaining-payment status / action */}
      {pendingRP ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-card border border-[#d97706]/40 bg-[#d97706]/[0.14] px-4 py-3 text-[13px] text-[#fbbf24]">
          <Icon name="check" size={17} /> ส่งสลิปส่วนต่าง {baht(pendingRP.amount)} แล้ว · รอ Admin ตรวจสอบ
        </div>
      ) : canPay && paying ? (
        <div className="mb-4 rounded-card border border-[#b91c1c]/30 bg-surface-2 p-[18px] text-center">
          <div className="mb-1 text-sm font-bold">ชำระส่วนต่าง {baht(payable)}{couponOff > 0 && <span className="ml-1.5 text-[12px] font-normal text-ink-faint line-through">{baht(due)}</span>}</div>
          <div className="mb-3.5 text-[12px] text-ink-faint">โอนผ่านบัญชีธนาคาร / สแกนจ่าย → แนบสลิป → รอ Admin อนุมัติ</div>
          {eligibleCoupons.length > 0 && (
            <div className="mb-3.5 text-left">
              <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-bold text-[#c4b5fd]"><Icon name="tag" size={15} /> ใช้คูปองส่วนลด</div>
              <select value={couponGrantId} onChange={(e) => setCouponGrantId(e.target.value)} className="w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent">
                <option value="">ไม่ใช้คูปอง</option>
                {eligibleCoupons.map((x) => <option key={x.grant.id} value={x.grant.id}>{x.coupon.label} · ลด {baht(x.coupon.value)}</option>)}
              </select>
              {selectedCoupon && <div className="mt-2.5"><CouponTicket coupon={selectedCoupon.coupon} size="sm" /></div>}
              {couponOff > 0 && <div className="mt-1.5 flex justify-between text-[12.5px] text-[#4ade80]"><span>ส่วนลด</span><span className="font-semibold">−{baht(couponOff)}</span></div>}
            </div>
          )}
          <div className="mb-3.5 flex justify-center">
            {account?.qr_url ? <img src={account.qr_url} alt="QR" className="h-[160px] w-[160px] rounded-2xl bg-white object-contain p-2" /> : <QrPanel size={160} />}
          </div>
          {account && (
            <button
              onClick={async () => flash((await copyText(digitsOnly(account.number))) ? 'คัดลอกเลขบัญชีแล้ว ✓' : 'คัดลอกไม่สำเร็จ')}
              className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] text-ink-muted2"
            >
              {account.name} · <span className="font-mono text-ink">{account.number}</span> <Icon name="copy" size={14} className="text-ink-faint" />
            </button>
          )}
          <label className={cx('mb-3 block cursor-pointer rounded-xl border-[1.5px] border-dashed p-4 text-center', slip ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.06]' : 'border-accent')}>
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onSlip(e.target.files?.[0])} />
            {slip ? <img src={slip} alt="สลิป" className="mx-auto max-h-40 rounded-lg object-contain" /> : <div className="text-[13px] font-semibold text-primary-soft">{busy ? 'กำลังอัปโหลด…' : 'แตะแนบรูปสลิป'}</div>}
          </label>
          <div className="flex gap-2.5">
            <Button variant="ghost" onClick={() => { setPaying(false); setSlip(null); }}>ยกเลิก</Button>
            <Button disabled={!slip || busy} onClick={payRemaining}>ส่งสลิป · รอตรวจสอบ</Button>
          </div>
        </div>
      ) : null}

      {/* จ่ายครบ + ของถึงไทย/พร้อมส่ง → เลือกวิธีรับของ (ryuma delivery spec) */}
      {deliveryReady(db, ticket) && <DeliverySection ticket={ticket} />}

      <div className="flex gap-2.5">
        <Button variant="outline" icon="swap" onClick={resell}>ลงขาย P2P</Button>
        {canPay && !pendingRP && !paying && (
          <Button icon="payments" onClick={() => setPaying(true)}>จ่ายส่วนต่าง</Button>
        )}
      </div>
    </div>
  );
}

/* ── เลือกวิธีรับของ (หลังจ่ายครบ + ของถึงไทย/พร้อมส่ง) ─────────────────────
   4 ทาง: ส่งตามที่อยู่ที่ลงทะเบียน (default) / ที่อยู่ใหม่ 3 ช่อง / เรียกรถเข้ารับ / มารับเอง.
   ทุกทางส่งเป็น "คำขอ" รอแอดมิน Accept — ก่อน Accept เปลี่ยนใจได้. */
function DeliverySection({ ticket }: { ticket: PreorderTicket }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const CURRENT_USER_ID = useCurrentUserId();
  const me = db.users.find((u) => u.id === CURRENT_USER_ID);

  const d = ticket.delivery;
  const [choosing, setChoosing] = useState(false);
  const [method, setMethod] = useState<DeliveryMethod>('registered');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);

  const METHODS: { key: DeliveryMethod; icon: 'truck' | 'home' | 'box' | 'user'; label: string; sub: string }[] = [
    { key: 'registered', icon: 'truck', label: 'ส่งพัสดุ ตามที่อยู่ที่ลงทะเบียนไว้', sub: me?.shipping_address ? me.shipping_address : 'ยังไม่มีที่อยู่ในระบบ — เลือก "ที่อยู่ใหม่" แทน' },
    { key: 'custom', icon: 'home', label: 'ส่งพัสดุ ที่อยู่ใหม่', sub: 'กรอก ชื่อ / เบอร์ / ที่อยู่' },
    { key: 'courier', icon: 'box', label: 'เรียกรถเข้ามารับเอง', sub: 'ส่งคำขอ → รอแอดมินยืนยันวันที่สะดวก' },
    { key: 'pickup', icon: 'user', label: 'เข้ามารับด้วยตัวเอง', sub: 'ส่งคำขอ → รอแอดมินยืนยัน แล้วนัดเวลา' },
  ];

  const submit = async () => {
    if (method === 'registered' && !me?.shipping_address?.trim()) return flash('ยังไม่มีที่อยู่ในระบบ — เลือก "ที่อยู่ใหม่" แทน');
    if (method === 'custom' && !(name.trim() && phone.trim() && addr.trim())) return flash('กรอก ชื่อ / เบอร์ / ที่อยู่ ให้ครบ');
    setBusy(true);
    dispatch(chooseDelivery(ticket.id, CURRENT_USER_ID, method, method === 'custom' ? { name, phone, address: addr } : undefined));
    try { await store.flush(); } catch { /* persist error surface via onPersistError */ }
    setBusy(false);
    notifyAdminLine(`📦 คำขอรับของใหม่: ${ticket.ticket_no} · ${DELIVERY_METHOD_LABEL[method]}`);
    flash('ส่งคำขอแล้ว · รอแอดมินยืนยัน');
    setChoosing(false);
  };

  // ── มีคำขอแล้ว → แสดงสถานะ ──
  if (d && !choosing) {
    if (!d.accepted_at) {
      return (
        <div className="mb-4 rounded-card border border-[#d97706]/40 bg-[#d97706]/[0.12] px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-bold text-[#fbbf24]"><Icon name="truck" size={17} /> ส่งคำขอรับของแล้ว · รอแอดมินยืนยัน</div>
          <div className="mt-1 text-[12.5px] text-ink-muted2">{DELIVERY_METHOD_LABEL[d.method]}{d.method === 'custom' && d.address ? ` · ${d.name} ${d.phone}` : ''}</div>
          <button onClick={() => { setMethod(d.method); setName(d.name ?? ''); setPhone(d.phone ?? ''); setAddr(d.address ?? ''); setChoosing(true); }} className="mt-1.5 text-[12px] text-ink-faint underline">เปลี่ยนวิธีรับของ</button>
        </div>
      );
    }
    // Accept แล้ว
    const accepted = d.method === 'registered' || d.method === 'custom'
      ? { text: 'ยืนยันแล้ว · กำลังแพ็คของ รอแจ้งเลขพัสดุ', sub: d.method === 'custom' ? `ส่งที่: ${d.name} ${d.phone} · ${d.address}` : `ส่งตามที่อยู่ที่ลงทะเบียนไว้` }
      : d.method === 'courier'
        ? { text: 'ยืนยันแล้ว · เรียกรถเข้ามารับได้เลย', sub: 'แจ้งรอบรถ/เวลากับแอดมินทางแชทได้เลย' }
        : { text: 'ยืนยันแล้ว · เข้ามารับของได้เลย', sub: 'นัดวัน-เวลากับแอดมินทางแชทได้เลย' };
    return (
      <div className="mb-4 rounded-card border border-[#2563eb]/35 bg-[#2563eb]/[0.1] px-4 py-3">
        <div className="flex items-center gap-2 text-[13px] font-bold text-[#60a5fa]"><Icon name="check" size={17} /> {accepted.text}</div>
        <div className="mt-1 text-[12px] text-ink-muted2">{DELIVERY_METHOD_LABEL[d.method]} · {accepted.sub}</div>
      </div>
    );
  }

  // ── ยังไม่เลือก (หรือกดเปลี่ยน) → ตัวเลือก 4 ทาง ──
  return (
    <div className="mb-4 rounded-card border border-[#16a34a]/35 bg-surface-2 p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-bold text-[#4ade80]"><Icon name="truck" size={17} /> ของพร้อมส่งแล้ว! เลือกวิธีรับของ</div>
      <div className="mb-3 text-[12px] text-ink-faint">เลือกได้ 1 ทาง · ส่งคำขอแล้วรอแอดมินยืนยัน</div>
      <div className="flex flex-col gap-2">
        {METHODS.map((m) => (
          <button key={m.key} onClick={() => setMethod(m.key)}
            className={cx('rounded-xl border px-3.5 py-2.5 text-left', method === m.key ? 'border-accent bg-[#b91c1c]/[0.1]' : 'border-subtle bg-surface-3')}>
            <div className={cx('flex items-center gap-2 text-[13px] font-bold', method === m.key ? 'text-primary-soft' : 'text-ink')}>
              <Icon name={m.icon} size={15} /> {m.label} {m.key === 'registered' && <span className="rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted2">แนะนำ</span>}
            </div>
            <div className="mt-0.5 line-clamp-2 pl-[23px] text-[11.5px] text-ink-faint">{m.sub}</div>
          </button>
        ))}
      </div>
      {method === 'custom' && (
        <div className="mt-3 flex flex-col gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่อผู้รับ *" className="w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-faint outline-none focus:border-accent" />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="เบอร์โทร *" className="w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-faint outline-none focus:border-accent" />
          <textarea value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="ที่อยู่จัดส่ง *" className="h-20 w-full resize-none rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-faint outline-none focus:border-accent" />
        </div>
      )}
      <div className="mt-3 flex gap-2.5">
        {d && <Button variant="ghost" onClick={() => setChoosing(false)}>ยกเลิก</Button>}
        <Button disabled={busy} onClick={submit}>{busy ? 'กำลังส่ง…' : 'ยืนยันวิธีรับของ'}</Button>
      </div>
    </div>
  );
}
