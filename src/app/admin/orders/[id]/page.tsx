'use client';

import { useParams, useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, RankBadge } from '@/components/ui';
import { approveOrder, rejectOrder } from '@/data/mutations';
import { sendPush, subsForUsers } from '@/lib/push';
import { confirmReservation, releaseReservation } from '@/lib/reserve';
import { franchiseOf } from '@/domain/services/catalog';
import { nextTicketNo } from '@/domain/services/tickets';

export default function SlipApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();

  const order = db.orders.find((o) => o.id === id);

  if (!order) {
    return (
      <div>
        <Header title="ตรวจสลิป" onBack={() => router.push('/admin')} />
        <div className="py-10 text-ink-faint">ไม่พบออเดอร์นี้ (อาจอนุมัติไปแล้ว)</div>
      </div>
    );
  }

  const user = db.users.find((u) => u.id === order.user_id);
  const firstProduct = db.products.find((p) => p.id === order.items[0]?.product_id);
  const nextTk = firstProduct ? nextTicketNo(db, franchiseOf(db, firstProduct)?.abbr ?? 'xx') : '';
  const approved = order.status === 'approved';

  const approve = async () => {
    const grantsBefore = db.couponGrants.filter((g) => g.user_id === order.user_id).length;
    dispatch(approveOrder(order.id));
    // read the post-mutation state synchronously (no-op mutation) — approveOrder may have just
    // auto-minted event reward coupons; the diff tells us whether to send the 🎁 push too
    let grantsAfter = grantsBefore;
    dispatch((d) => { grantsAfter = d.couponGrants.filter((g) => g.user_id === order.user_id).length; return d; });
    const mySubs = subsForUsers(db, [order.user_id]);
    sendPush(mySubs, { title: '✅ ออเดอร์อนุมัติแล้ว', body: `ตั๋ว ${order.items.length} ใบเข้ากระเป๋าแล้ว — แตะเพื่อดู`, url: '/wallet' }, dispatch).catch(() => {});
    if (grantsAfter > grantsBefore)
      sendPush(mySubs, { title: '🎁 ได้รับคูปองจากกิจกรรม!', body: `คุณได้รับคูปอง ${grantsAfter - grantsBefore} ใบ — ดูใน "คูปองของฉัน"`, url: '/coupons' }, dispatch).catch(() => {});
    // confirm any stock holds → real sale
    await Promise.all((order.reservation_ids ?? []).map((rid) => confirmReservation(rid)));
    flash(`อนุมัติแล้ว · ออก Ticket ${order.items.length} ใบ`);
    router.push('/admin');
  };

  const reject = async () => {
    if (!confirm('ปฏิเสธสลิปนี้? สต๊อกที่จองไว้จะถูกคืน')) return;
    dispatch(rejectOrder(order.id));
    sendPush(subsForUsers(db, [order.user_id]), { title: '❌ สลิปไม่ผ่านการตรวจ', body: 'ยอด/สลิปไม่ถูกต้อง — ติดต่อแอดมิน หรือสั่งใหม่อีกครั้ง', url: '/' }, dispatch).catch(() => {});
    await Promise.all((order.reservation_ids ?? []).map((rid) => releaseReservation(rid)));
    flash('ปฏิเสธออเดอร์แล้ว · คืนสต๊อก');
    router.push('/admin');
  };

  return (
    <div>
      <Header title={`ตรวจสลิป · Order #${order.id.slice(-4)}`} onBack={() => router.push('/admin')} />

      <div className="grid gap-[18px] lg:grid-cols-[1.3fr_340px]">
        {/* slip viewer — real uploaded image when present */}
        <div className="flex min-h-[480px] flex-col items-center justify-center rounded-2xl border border-subtle bg-surface-2 p-5">
          {order.slip_url && /^https?:|^data:/.test(order.slip_url) ? (
            <a href={order.slip_url} target="_blank" rel="noreferrer">
              <img src={order.slip_url} alt="สลิปโอนเงิน" className="max-h-[460px] rounded-xl object-contain" />
            </a>
          ) : (
            <div className="flex h-[420px] w-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-subtle text-ink-faint">
              <Icon name="camera" size={28} />
              <div className="mt-2 text-[12.5px]">ยังไม่มีรูปสลิป</div>
            </div>
          )}
        </div>

        {/* order detail */}
        <div className="flex flex-col rounded-2xl border border-subtle bg-surface-2 p-5">
          <span className={`self-start rounded-[7px] border px-[9px] py-[3px] text-[11.5px] font-bold ${approved ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.14] text-[#4ade80]' : 'border-[#d97706]/40 bg-[#d97706]/[0.14] text-[#fbbf24]'}`}>
            {approved ? 'อนุมัติแล้ว ✓' : 'รอตรวจสอบ'}
          </span>

          <div className="my-4 flex items-center gap-3">
            <div className="grid h-[42px] w-[42px] place-items-center rounded-full bg-primary font-bold">{user?.display_name.charAt(0)}</div>
            <div>
              <div className="text-sm font-semibold">{user?.display_name}</div>
              <div className="mt-0.5">{user && <RankBadge rank={user.rank} />}</div>
            </div>
          </div>

          <div className="mb-3.5 flex flex-col gap-2.5">
            {order.items.map((item) => {
              const p = db.products.find((pp) => pp.id === item.product_id);
              const v = db.variants.find((vv) => vv.id === item.variant_id);
              return (
                <div key={item.id} className="flex justify-between gap-2.5 text-[13px]">
                  <span className="text-ink-muted2">{p?.series_name}{v ? ` · ${v.name}` : ''} ×{item.qty}</span>
                  <span className="font-semibold">{baht(item.deposit_amount)}</span>
                </div>
              );
            })}
          </div>

          <div className="mb-3 rounded-xl bg-surface-3 p-3.5">
            <div className="flex justify-between text-sm"><span className="font-bold">ยอดที่ต้องได้รับ</span><span className="font-extrabold text-primary-soft">{baht(order.total_deposit)}</span></div>
          </div>

          {!approved && (
            <div className="mb-4 flex items-center gap-2 rounded-[10px] border border-dashed border-[#f59e0b]/50 px-3 py-2.5 text-[12.5px] text-[#fbbf24]">
              <Icon name="bell" size={17} className="text-[#fbbf24]" />
              <span>โปรดตรวจสลิปกับยอด {baht(order.total_deposit)} ก่อนกดอนุมัติ · จะออก Ticket: <b className="font-mono">{nextTk}</b></span>
            </div>
          )}

          <div className="flex-1" />
          {approved ? (
            <div className="rounded-btn border border-subtle bg-surface-3 py-3 text-center text-sm font-bold text-ink-muted2">ออก Ticket เรียบร้อยแล้ว</div>
          ) : (
            <>
              <Button variant="success" icon="check" onClick={approve}>Approve · ออก Ticket</Button>
              <button onClick={reject} className="mt-2.5 w-full rounded-btn border-[1.5px] border-[#f87171]/40 py-3 text-sm font-bold text-[#f87171]">ปฏิเสธสลิป · คืนสต๊อก</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="mb-[22px] flex items-center gap-3">
      <button onClick={onBack} className="grid h-[38px] w-[38px] place-items-center rounded-[11px] border border-subtle bg-surface-2 text-ink"><Icon name="arrowLeft" size={19} /></button>
      <div className="text-xl font-extrabold">{title}</div>
    </div>
  );
}
