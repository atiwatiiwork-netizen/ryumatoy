'use client';

import type { ReactNode } from 'react';
import { DataProvider } from '@/state/DataProvider';
import { CartProvider } from '@/state/CartProvider';
import { ToastProvider } from '@/state/ToastProvider';

/** Client-side provider stack shared by the whole app. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <DataProvider>
      <CartProvider>
        <ToastProvider>{children}</ToastProvider>
      </CartProvider>
    </DataProvider>
  );
}
