'use client';

import { createContext, useContext, useState, useRef, useCallback } from 'react';
import type { ReactNode } from 'react';

/** Transient toast messages — replaces the Vite UIProvider.flash(). */
interface ToastState {
  toast: string | null;
  flash: (message: string) => void;
}

const ToastContext = createContext<ToastState | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const flash = useCallback((message: string) => {
    setToast(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2400);
  }, []);

  return (
    <ToastContext.Provider value={{ toast, flash }}>
      {children}
      {toast && (
        <div className="fixed bottom-[90px] left-1/2 z-[100] max-w-[320px] -translate-x-1/2 rounded-xl border border-accent bg-surface-4 px-[18px] py-[11px] text-center text-[13.5px] font-semibold shadow-[0_12px_30px_-10px_rgba(0,0,0,.8)]">
          {toast}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastState {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
