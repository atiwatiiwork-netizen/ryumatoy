'use client';

import { useParams, useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, RankBadge } from '@/components/ui';
import { approveOrder } from '@/data/mutations';
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

  const approve = () => {
    dispatch(approveOrder(order.id));
    flash(`อนุมัติแล้ว · ออก Ticket ${order.items.length} ใบ`);
    router.push('/admin');
  };

  return (
    <div>
      <Header title={`ตรวจสลิป · Order #${order.id.slice(-4)}`} onBack={() => router.push('/admin')} />

      <div className="grid gap-[18px] lg:grid-cols-[1.3fr_340px]">
        {/* slip viewer */}
        <div className="flex min-h-[480px] flex-col items-center justify-center rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="flex h-[420px] w-[280px] flex-col rounded-2xl bg-white p-[22px] text-[#0a0809]">
            <div className="mb-[18px] flex items-center gap-2.5">
              <div className="grid h-[34px] w-[34px] place-items-center rounded-[9px] bg-[#4b2ea6] font-extrabold text-white">S</div>
              <div className="text-sm font-bold">โอนเงินสำเร็จ</div>
            </div>
            <div className="text-xs text-[#6b7280]">30 มิ.ย. 2026 · 09:14 น.</div>
            <div className="my-4 text-[34px] font-extrabold text-[#0c8457]">{baht(order.total_deposit)}</div>
            <Field k="จาก" v={user?.display_name ?? '-'} />
            <Field k="ไปยัง" v={db.settings.bank_account} />
            <Field k="พร้อมเพย์" v={db.settings.promptpay_number} />
            <Field k="Ref" v={`RYM${order.id.slice(-8).toUpperCase()}`} />
            <div className="flex-1" />
            <div className="text-center text-[11px] text-[#9ca3af]">{db.settings.bank_name}</div>
          </div>
          <div className="mt-4 flex gap-2.5">
            <button className="grid h-10 w-10 place-items-center rounded-[11px] border border-subtle bg-surface-3 text-ink"><Icon name="search" size={18} /></button>
            <button className="grid h-10 w-10 place-items-center rounded-[11px] border border-subtle bg-surface-3 text-ink"><Icon name="swap" size={18} /></button>
          </div>
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
            <div className="mb-4 flex items-center gap-2 rounded-[10px] border border-dashed border-[#16a34a]/50 px-3 py-2.5 text-[12.5px] text-[#4ade80]">
              <Icon name="verified" size={17} className="text-[#4ade80]" />
              <span>ตรงกับยอดสลิป ✓ · จะออก Ticket: <b className="font-mono">{nextTk}</b></span>
            </div>
          )}

          <div className="flex-1" />
          {approved ? (
            <div className="rounded-btn border border-subtle bg-surface-3 py-3 text-center text-sm font-bold text-ink-muted2">ออก Ticket เรียบร้อยแล้ว</div>
          ) : (
            <>
              <Button variant="success" icon="check" onClick={approve}>Approve · ออก Ticket</Button>
              <button onClick={() => flash('เปิด LINE OA เพื่อติดต่อลูกค้า')} className="mt-2.5 w-full rounded-btn border-[1.5px] border-subtle py-3 text-sm font-bold text-ink-muted2">ติดต่อลูกค้าผ่าน LINE</button>
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

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-[#f0f0f0] py-[5px] text-[12.5px]">
      <span className="text-[#6b7280]">{k}</span>
      <span className="font-semibold text-[#111827]">{v}</span>
    </div>
  );
}
