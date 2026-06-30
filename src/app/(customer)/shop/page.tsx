'use client';

import { useMemo, useState } from 'react';
import { useDatabase } from '@/state/DataProvider';
import { Icon } from '@/components/Icon';
import { Chip, cx } from '@/components/ui';
import { ProductCard } from '@/components/ProductCard';
import { filterProducts, type ProductFilter } from '@/domain/services/catalog';
import type { ProductStatus, ProductType } from '@/domain/entities';

const STATUS_FILTERS: { key: ProductStatus; label: string }[] = [
  { key: 'open', label: 'เปิดจอง' },
  { key: 'production', label: 'กำลังผลิต' },
  { key: 'shipping', label: 'กำลังเดินทาง' },
  { key: 'arrived', label: 'ถึงไทยแล้ว' },
];
const TYPES: { key: ProductType; label: string }[] = [
  { key: 'wcf', label: 'WCF' },
  { key: 'figure', label: 'Figure' },
  { key: 'resin', label: 'Resin' },
];

export default function ShopPage() {
  const db = useDatabase();
  const [category, setCategory] = useState<ProductFilter['category']>(null);
  const [manufacturerId, setManufacturerId] = useState<string | null>(null);
  const [franchiseId, setFranchiseId] = useState<string | null>(null);
  const [status, setStatus] = useState<ProductStatus | null>(null);
  const [type, setType] = useState<ProductType | null>(null);
  const [query, setQuery] = useState('');

  const results = useMemo(
    () => filterProducts(db, { category, manufacturerId, franchiseId, status, type, query }),
    [db, category, manufacturerId, franchiseId, status, type, query],
  );

  const preorderCount = db.products.filter((p) => !p.is_stock).length;
  const stockCount = db.products.filter((p) => p.is_stock).length;
  const franchises = manufacturerId ? db.franchises.filter((f) => f.manufacturer_id === manufacturerId) : db.franchises;

  return (
    <div>
      <div className="mb-3.5 flex items-center gap-2.5 lg:hidden">
        <div className="flex-1 text-[26px] font-extrabold">ช็อป</div>
        <button className="grid h-[42px] w-[42px] place-items-center rounded-[11px] border border-subtle bg-surface-3 text-ink"><Icon name="sliders" size={20} /></button>
      </div>

      {/* search (mobile) */}
      <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-subtle bg-surface-3 px-[13px] py-[11px] lg:hidden">
        <Icon name="search" size={18} className="text-ink-faint" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ค้นหาฟิกเกอร์ / เรื่อง / ค่าย" className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint" />
      </div>

      {/* category band */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:mb-6 lg:gap-4">
        <CategoryBanner active={category === 'preorder'} onClick={() => setCategory(category === 'preorder' ? null : 'preorder')} title="Pre-Order" count={preorderCount} icon="box" grad="linear-gradient(120deg, rgba(185,28,28,.34), #1a0f0e)" border="border-primary" />
        <CategoryBanner active={category === 'instock'} onClick={() => setCategory(category === 'instock' ? null : 'instock')} title="In-Stock" count={stockCount} icon="bolt" grad="linear-gradient(120deg, rgba(22,163,74,.18), #0e1310)" border="border-[#16a34a]/50" />
      </div>

      {/* mobile filter chip rails */}
      <div className="lg:hidden">
        <ChipRail>
          <Chip active={!manufacturerId} onClick={() => { setManufacturerId(null); setFranchiseId(null); }}>ทุกค่าย</Chip>
          {db.manufacturers.map((m) => <Chip key={m.id} active={manufacturerId === m.id} onClick={() => { setManufacturerId(m.id); setFranchiseId(null); }}>{m.name}</Chip>)}
        </ChipRail>
        <ChipRail>
          <Chip active={!franchiseId} onClick={() => setFranchiseId(null)}>ทุกเรื่อง</Chip>
          {franchises.map((f) => <Chip key={f.id} active={franchiseId === f.id} onClick={() => setFranchiseId(f.id)}>{f.name}</Chip>)}
        </ChipRail>
        <ChipRail last>
          <Chip active={!status} onClick={() => setStatus(null)}>ทุกสถานะ</Chip>
          {STATUS_FILTERS.map((s) => <Chip key={s.key} active={status === s.key} onClick={() => setStatus(s.key)}>{s.label}</Chip>)}
        </ChipRail>
      </div>

      <div className="lg:grid lg:grid-cols-[208px_1fr] lg:gap-6 lg:items-start">
        {/* desktop sidebar */}
        <aside className="sticky top-[86px] hidden rounded-card border border-subtle bg-surface-2 p-[18px] lg:block">
          <FilterGroup title="ค่าย (Manufacturer)">
            <Check label="ทั้งหมด" checked={!manufacturerId} onClick={() => { setManufacturerId(null); setFranchiseId(null); }} />
            {db.manufacturers.map((m) => <Check key={m.id} label={m.name} checked={manufacturerId === m.id} onClick={() => { setManufacturerId(m.id); setFranchiseId(null); }} />)}
          </FilterGroup>
          <FilterGroup title="เรื่อง (Franchise)">
            <Check label="ทั้งหมด" checked={!franchiseId} onClick={() => setFranchiseId(null)} />
            {franchises.map((f) => <Check key={f.id} label={f.name} checked={franchiseId === f.id} onClick={() => setFranchiseId(f.id)} />)}
          </FilterGroup>
          <FilterGroup title="ประเภท" last>
            <div className="flex flex-wrap gap-1.5">
              <TypeChip label="ทั้งหมด" active={!type} onClick={() => setType(null)} />
              {TYPES.map((t) => <TypeChip key={t.key} label={t.label} active={type === t.key} onClick={() => setType(t.key)} />)}
            </div>
          </FilterGroup>
        </aside>

        <div>
          <div className="mb-3 text-[12.5px] text-ink-faint lg:mb-4 lg:text-lg lg:font-extrabold lg:text-ink">
            {category === 'instock' ? 'พร้อมส่ง' : category === 'preorder' ? 'พรีออเดอร์' : 'สินค้าทั้งหมด'}
            <span className="font-normal text-ink-faint lg:text-sm"> · {results.length} รายการ</span>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            {results.map((p) => <ProductCard key={p.id} product={p} />)}
          </div>
          {results.length === 0 && <div className="py-12 text-center text-ink-faint">ไม่พบสินค้าตามตัวกรอง</div>}
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

function TypeChip({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx('rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold', active ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>
      {label}
    </button>
  );
}
