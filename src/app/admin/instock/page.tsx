'use client';

import { InStockTab } from '../products/InStockTab';
import { AdminTabs } from '@/components/AdminTabs';

export default function InStockPage() {
  return (
    <div>
      <AdminTabs tabs={[{ href: '/admin/products', label: '📦 Pre-Order' }, { href: '/admin/instock', label: '🏪 In-Stock' }, { href: '/admin/stock', label: '⚡ สต๊อกใบพรี' }]} />
      <div className="mb-1 text-2xl font-extrabold">In-Stock · พร้อมส่ง</div>
      <div className="mb-5 text-[13px] text-ink-faint">แปลงพรีที่จบแล้ว → พร้อมส่ง · เพิ่มสินค้าพร้อมส่งใหม่ · จัดการสต๊อก + ประวัติ</div>
      <InStockTab />
    </div>
  );
}
