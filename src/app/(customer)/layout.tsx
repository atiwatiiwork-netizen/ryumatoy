import type { ReactNode } from 'react';
import { CustomerShell } from '@/components/CustomerShell';
import { SimGate, SimPageGuard } from '@/components/SimGate';

// SimGate = โหมดจำลอง "ดูเป็นลูกค้า" ของแอดมิน (ปกติโปร่งใส ไม่ทำอะไร) — ดู components/SimGate.tsx
export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (
    <SimGate>
      <CustomerShell><SimPageGuard>{children}</SimPageGuard></CustomerShell>
    </SimGate>
  );
}
