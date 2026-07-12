'use client';

import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import type { ReactNode } from 'react';

const CART_KEY = 'ryuma_cart'; // persist the cart so it survives a refresh / tab reload
function loadCart(): { lines: CartLine[]; coupon: string | null } {
  if (typeof window === 'undefined') return { lines: [], coupon: null };
  try {
    const p = JSON.parse(localStorage.getItem(CART_KEY) ?? '{}');
    return { lines: Array.isArray(p.lines) ? p.lines : [], coupon: p.coupon ?? null };
  } catch { return { lines: [], coupon: null }; }
}

/**
 * Cart — UI-only state until checkout. Each line references a product (+ optional
 * variant) and carries the deposit charged now. Totals derive from these lines.
 */
export interface CartLine {
  productId: string;
  variantId?: string;
  batchId?: string; // reopened stock batch, if bought from one
  qty: number;
  depositEach: number;
  priceEach: number;
}

interface CartState {
  lines: CartLine[];
  coupon: string | null;
  count: number;
  add: (line: Omit<CartLine, 'qty'> & { qty?: number }) => void;
  setQty: (productId: string, variantId: string | undefined, qty: number) => void;
  remove: (productId: string, variantId?: string) => void;
  applyCoupon: (code: string | null) => void;
  clear: () => void;
  depositTotal: () => number;
}

const CartContext = createContext<CartState | null>(null);

const same = (a: CartLine, productId: string, variantId?: string) =>
  a.productId === productId && a.variantId === variantId;

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => loadCart().lines);
  const [coupon, setCoupon] = useState<string | null>(() => loadCart().coupon);

  // keep localStorage in sync so a refresh / accidental reload doesn't drop the cart
  useEffect(() => {
    try { localStorage.setItem(CART_KEY, JSON.stringify({ lines, coupon })); } catch { /* private mode / full */ }
  }, [lines, coupon]);

  const add = useCallback((line: Omit<CartLine, 'qty'> & { qty?: number }) => {
    const qty = line.qty ?? 1;
    setLines((prev) => {
      // match on batchId too, so a special-round line (its own price) never MERGES into a normal
      // pre-order line of the same product and inherits the wrong deposit/price. (audit: cart batchId)
      const i = prev.findIndex((l) => same(l, line.productId, line.variantId) && l.batchId === line.batchId);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + qty };
        return next;
      }
      return [...prev, { ...line, qty }];
    });
  }, []);

  const setQty = useCallback((productId: string, variantId: string | undefined, qty: number) => {
    setLines((prev) =>
      prev.map((l) => (same(l, productId, variantId) ? { ...l, qty } : l)).filter((l) => l.qty > 0),
    );
  }, []);

  const remove = useCallback((productId: string, variantId?: string) => {
    setLines((prev) => prev.filter((l) => !same(l, productId, variantId)));
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setCoupon(null);
  }, []);

  const value = useMemo<CartState>(
    () => ({
      lines,
      coupon,
      count: lines.reduce((n, l) => n + l.qty, 0),
      add,
      setQty,
      remove,
      applyCoupon: setCoupon,
      clear,
      depositTotal: () => lines.reduce((sum, l) => sum + l.depositEach * l.qty, 0),
    }),
    [lines, coupon, add, setQty, remove, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
