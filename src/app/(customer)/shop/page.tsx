'use client';

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { Icon } from '@/components/Icon';
import { Chip, cx } from '@/components/ui';
import { ProductCard } from '@/components/ProductCard';
import { BatchCard } from '@/components/BatchCard';
import { filterProducts, seriesForFranchise, makersOfCategory, categoryOf, batchRemaining, type ProductFilter } from '@/domain/services/catalog';
import type { ProductStatus } from '@/domain/entities';

const STATUS_FILTERS: { key: ProductStatus; label: string }[] = [
  { key: 'open', label: 'เปิดจอง' },
  { key: 'production', label: 'กำลังผลิต' },
  { key: 'shipping', label: 'กำลังเดินทาง' },
  { key: 'arrived', label: 'ถึงไทยแล้ว' },
];

export default function ShopPage() {
  return <Suspense fallback={null}><ShopInner /></Suspense>;
}

function ShopInner() {
  const db = useDatabase();
  const params = useSearchParams();
  const [category, setCategory] = useState<ProductFilter['category']>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null); // ประเภท/Type
  // deep-linkable from a product's series chip: /shop?franchise=..&series=..
  const [franchiseId, setFranchiseId] = useState<string | null>(() => params.get('franchise'));
  const [manufacturerId, setManufacturerId] = useState<string | null>(null);
  const [seriesId, setSeriesId] = useState<string | null>(() => params.get('series'));
  const [status, setStatus] = useState<ProductStatus | null>(null);
  const [query, setQuery] = useState('');

  const results = useMemo(
    () => filterProducts(db, { category, categoryId, franchiseId, manufacturerId, seriesId, status, query }),
    [db, category, categoryId, franchiseId, manufacturerId, seriesId, status, query],
  );

  // reopened stock batches matching the same filters (shown as extra "รอบใหม่" cards)
  const openBatches = category === 'instock' ? [] : db.batches.filter((b) => {
    if (b.status !== 'open') return false;
    if (batchRemaining(db, b.id, b.stock_qty) <= 0) return false; // sold out
    const p = db.products.find((x) => x.id === b.product_id);
    if (!p) return false;
    if (categoryId && categoryOf(db, p)?.id !== categoryId) return false;
    if (franchiseId && p.franchise_id !== franchiseId) return false;
    if (manufacturerId && p.manufacturer_id !== manufacturerId) return false;
    if (seriesId && p.series_id !== seriesId) return false;
    if (query && !`${p.series_name}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  // only count pre-orders still OPEN for booking (production/shipping/arrived aren't orderable)
  const preorderCount = db.products.filter((p) => !p.is_stock && p.status === 'open').length;
  const stockCount = db.products.filter((p) => p.is_stock).length;
  // ประเภท offered on the storefront = active categories only
  const activeCategories = db.categories.filter((c) => c.active);
  // ค่าย list narrows to makers under the selected ประเภท
  const makerList = categoryId ? makersOfCategory(db, categoryId) : db.manufacturers;
  // ซีรีย์ shown only once a เรื่อง is picked (optionally narrowed by ค่าย)
  const seriesList = franchiseId ? seriesForFranchise(db, franchiseId, manufacturerId ?? undefined) : [];

  return (
    <div>
      <div className="mb-3.5 flex items-center gap-2.5 lg:hidden">
        <div className="flex-1 text-[26px] font-extrabold">ช็อป</div>
        <button className="grid h-[42px] w-[42px] place-items-center rounded-[11px] border border-subtle bg-surface-3 text-ink"><Icon name="sliders" size={20} /></button>
      </div>

      <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-subtle bg-surface-3 px-[13px] py-[11px] lg:hidden">
        <Icon name="search" size={18} className="text-ink-faint" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ค้นหาฟิกเกอร์ / เรื่อง / ค่าย" className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint" />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:mb-6 lg:gap-4">
        <CategoryBanner active={category === 'preorder'} onClick={() => setCategory(category === 'preorder' ? null : 'preorder')} title="Pre-Order" count={preorderCount} icon="box" grad="linear-gradient(120deg, rgba(185,28,28,.34), #1a0f0e)" border="border-primary" />
        <CategoryBanner active={category === 'instock'} onClick={() => setCategory(category === 'instock' ? null : 'instock')} title="In-Stock" count={stockCount} icon="bolt" grad="linear-gradient(120deg, rgba(22,163,74,.18), #0e1310)" border="border-[#16a34a]/50" />
      </div>

      {/* mobile filter rails — order: ประเภท → ค่าย → เรื่อง → ซีรีย์ → สถานะ */}
      <div className="lg:hidden">
        {activeCategories.length > 1 && (
          <ChipRail>
            <Chip active={!categoryId} onClick={() => { setCategoryId(null); setManufacturerId(null); setSeriesId(null); }}>ทุกประเภท</Chip>
            {activeCategories.map((c) => <Chip key={c.id} active={categoryId === c.id} onClick={() => { setCategoryId(c.id); setManufacturerId(null); setSeriesId(null); }}>{c.name}</Chip>)}
          </ChipRail>
        )}
        <ChipRail>
          <Chip active={!manufacturerId} onClick={() => { setManufacturerId(null); setSeriesId(null); }}>ทุกค่าย</Chip>
          {makerList.map((m) => <Chip key={m.id} active={manufacturerId === m.id} onClick={() => { setManufacturerId(m.id); setSeriesId(null); }}>{m.name}</Chip>)}
        </ChipRail>
        <ChipRail>
          <Chip active={!franchiseId} onClick={() => { setFranchiseId(null); setSeriesId(null); }}>ทุกเรื่อง</Chip>
          {db.franchises.map((f) => <Chip key={f.id} active={franchiseId === f.id} onClick={() => { setFranchiseId(f.id); setSeriesId(null); }}>{f.name}</Chip>)}
        </ChipRail>
        {seriesList.length > 0 && (
          <ChipRail>
            <Chip active={!seriesId} onClick={() => setSeriesId(null)}>ทุกซีรีย์</Chip>
            {seriesList.map((s) => <Chip key={s.id} active={seriesId === s.id} onClick={() => setSeriesId(s.id)}>{s.name}</Chip>)}
          </ChipRail>
        )}
        <ChipRail last>
          <Chip active={!status} onClick={() => setStatus(null)}>ทุกสถานะ</Chip>
          {STATUS_FILTERS.map((s) => <Chip key={s.key} active={status === s.key} onClick={() => setStatus(s.key)}>{s.label}</Chip>)}
        </ChipRail>
      </div>

      <div className="lg:grid lg:grid-cols-[208px_1fr] lg:gap-6 lg:items-start">
        <aside className="sticky top-[86px] hidden rounded-card border border-subtle bg-surface-2 p-[18px] lg:block">
          {activeCategories.length > 1 && (
            <FilterGroup title="ประเภท (Type)">
              <Check label="ทั้งหมด" checked={!categoryId} onClick={() => { setCategoryId(null); setManufacturerId(null); setSeriesId(null); }} />
              {activeCategories.map((c) => <Check key={c.id} label={c.name} checked={categoryId === c.id} onClick={() => { setCategoryId(c.id); setManufacturerId(null); setSeriesId(null); }} />)}
            </FilterGroup>
          )}
          <FilterGroup title="ค่าย (Manufacturer)">
            <Check label="ทั้งหมด" checked={!manufacturerId} onClick={() => { setManufacturerId(null); setSeriesId(null); }} />
            {makerList.map((m) => <Check key={m.id} label={m.name} checked={manufacturerId === m.id} onClick={() => { setManufacturerId(m.id); setSeriesId(null); }} />)}
          </FilterGroup>
          <FilterGroup title="เรื่อง (Franchise)" last={seriesList.length === 0}>
            <Check label="ทั้งหมด" checked={!franchiseId} onClick={() => { setFranchiseId(null); setSeriesId(null); }} />
            {db.franchises.map((f) => <Check key={f.id} label={f.name} checked={franchiseId === f.id} onClick={() => { setFranchiseId(f.id); setSeriesId(null); }} />)}
          </FilterGroup>
          {seriesList.length > 0 && (
            <FilterGroup title="ซีรีย์ (Series)" last>
              <Check label="ทั้งหมด" checked={!seriesId} onClick={() => setSeriesId(null)} />
              {seriesList.map((s) => <Check key={s.id} label={s.name} checked={seriesId === s.id} onClick={() => setSeriesId(s.id)} />)}
            </FilterGroup>
          )}
        </aside>

        <div>
          <div className="mb-3 text-[12.5px] text-ink-faint lg:mb-4 lg:text-lg lg:font-extrabold lg:text-ink">
            {category === 'instock' ? 'พร้อมส่ง' : category === 'preorder' ? 'พรีออเดอร์' : 'สินค้าทั้งหมด'}
            <span className="font-normal text-ink-faint lg:text-sm"> · {results.length + openBatches.length} รายการ</span>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            {openBatches.map((b) => <BatchCard key={b.id} batch={b} />)}
            {results.map((p) => <ProductCard key={p.id} product={p} />)}
          </div>
          {results.length + openBatches.length === 0 && <div className="py-12 text-center text-ink-faint">ไม่พบสินค้าตามตัวกรอง</div>}
        </div>
      </div>
    </div>
  );
}

function ChipRail({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return <div className={cx('flex gap-2 overflow-x-auto pb-1 no-scrollbar', last ? 'mb-[18px]' : 'mb-2.5')}>{children}</div>;
}

function CategoryBanner({ active, onClick, title, count, icon, grad, border }: { active?: boolean; onClick: () => void; title: string; count: number; icon: 'box' | 'bolt'; grad: string; border: string }) {
  return (
    <button onClick={onClick} className={cx('relative h-24 overflow-hidden rounded-card border-[1.5px] p-4 text-left text-ink lg:h-[110px] lg:rounded-2xl lg:p-6', active ? border : 'border-transparent')} style={{ background: grad }}>
      <Icon name={icon} size={24} className="text-white" />
      <div className="mt-2 text-base font-extrabold lg:text-xl">{title}</div>
      <div className="text-[11.5px] text-ink-muted2 lg:text-[13px]">{count} รายการ</div>
      <Icon name={icon} size={80} className="absolute -bottom-3 -right-1.5 text-white/5" />
    </button>
  );
}

function FilterGroup({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={cx(!last && 'mb-[18px] border-b border-hair pb-[18px]')}>
      <div className="mb-2.5 text-[12.5px] font-bold text-ink-muted">{title}</div>
      {children}
    </div>
  );
}

function Check({ label, checked, onClick }: { label: string; checked?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx('flex w-full items-center gap-2.5 py-[5px] text-left text-[13.5px]', checked ? 'text-ink' : 'text-ink-muted2')}>
      <span className={cx('grid h-[17px] w-[17px] flex-shrink-0 place-items-center rounded-[5px] border-[1.5px]', checked ? 'border-primary bg-primary' : 'border-subtle')}>
        {checked && <Icon name="check" size={12} className="text-white" />}
      </span>
      {label}
    </button>
  );
}
