'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { Icon } from '@/components/Icon';
import { ProductCard } from '@/components/ProductCard';
import { cx } from '@/components/ui';
import { baht } from '@/lib/theme';
import { franchiseOf } from '@/domain/services/catalog';

/** A closing pre-order board (กระดานปิดพรี): poster + this maker's items grouped by เรื่อง. */
export default function BoardPage() {
  const { id } = useParams<{ id: string }>();
  const db = useDatabase();
  const cart = useCart();
  const board = db.boards.find((b) => b.id === id);

  if (!board) return <div className="py-24 text-center text-ink-faint">ไม่พบกระดานนี้ <Link href="/" className="text-primary-soft">← กลับหน้าแรก</Link></div>;

  const maker = db.manufacturers.find((m) => m.id === board.maker_id);
  const items = db.products.filter((p) => p.board_id === board.id);
  const minPrice = items.length ? Math.min(...items.map((p) => p.price_total)) : 0;
  const closed = board.status === 'closed';

  // group items by franchise (เรื่อง)
  const groups = new Map<string, typeof items>();
  for (const p of items) { const f = franchiseOf(db, p)?.name ?? 'อื่นๆ'; if (!groups.has(f)) groups.set(f, []); groups.get(f)!.push(p); }

  return (
    <div>
      <Link href="/" className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-muted2"><Icon name="arrowLeft" size={16} /> หน้าแรก</Link>

      {board.poster_url && (
        <div className="mb-4 overflow-hidden rounded-2xl border border-subtle">
          <img src={board.poster_url} alt={board.title} className="block h-auto w-full" />
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <span className={cx('rounded-md px-2 py-0.5 text-[11px] font-bold', closed ? 'bg-white/[0.08] text-ink-muted2' : 'bg-[#16a34a]/[0.15] text-[#4ade80]')}>{closed ? 'ปิดรับจองแล้ว' : '⚡ กำลังปิดพรี'}</span>
        <div className="text-xl font-extrabold lg:text-2xl">{board.title}</div>
        <div className="text-[13px] text-ink-faint">{maker?.name} · {items.length} รายการ{minPrice > 0 ? ` · เริ่ม ${baht(minPrice)}` : ''}</div>
      </div>

      {closed && (
        <div className="mb-5 rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-4 py-3 text-[13px] font-semibold text-[#fbbf24]">
          กระดานนี้ปิดรับจองแล้ว — สินค้ากำลังเข้าสู่การผลิต
        </div>
      )}

      {items.length === 0 ? (
        <div className="py-16 text-center text-ink-faint">ยังไม่มีสินค้าในกระดานนี้</div>
      ) : (
        [...groups.entries()].map(([fname, list]) => (
          <div key={fname} className="mb-7">
            <div className="mb-3 text-[17px] font-extrabold lg:text-xl">{fname}</div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5 lg:gap-4">
              {list.map((p) => <ProductCard key={p.id} product={p} quickAdd />)}
            </div>
          </div>
        ))
      )}

      {/* sticky "go to cart" bar — lets the customer add many, then check out in one go */}
      {cart.count > 0 && (
        <div className="fixed inset-x-0 bottom-[68px] z-40 px-4 lg:bottom-6">
          <Link href="/cart" className="mx-auto flex max-w-[1140px] items-center justify-between rounded-xl bg-cta px-4 py-3 text-sm font-bold text-white shadow-lg">
            <span>ในตะกร้า {cart.count} รายการ</span>
            <span className="flex items-center gap-1">ดูตะกร้า · เช็คเอาต์ <Icon name="arrowRight" size={16} /></span>
          </Link>
        </div>
      )}
    </div>
  );
}
