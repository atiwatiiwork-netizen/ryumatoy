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
    // ข้อความยาว (เหตุผลที่ทำไม่ได้) ต้องอ่านทัน — เดิม 2.4 วิเท่ากันหมด
    timer.current = setTimeout(() => setToast(null), Math.min(7000, 2400 + message.length * 35));
  }, []);

  return (
    <ToastContext.Provider value={{ toast, flash }}>
      {children}
      {/* z-[300] = เหนือทุก overlay (แผงเปลี่ยนใบ/ลงขาย z-[120] · ป๊อปอัป z-[130] · PreviewSwitcher z-[200]) — เดิม z-[100]
          ข้อความไปจมใต้แผง ทุกข้อผิดพลาดในแผงมองไม่เห็น (audit รอบ B R3-08) · pointer-events-none ไม่บังปุ่มข้างใต้ */}
      {toast && (
        <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-[90px] left-1/2 z-[300] max-w-[320px] -translate-x-1/2 rounded-xl border border-accent bg-surface-4 px-[18px] py-[11px] text-center text-[13.5px] font-semibold shadow-[0_12px_30px_-10px_rgba(0,0,0,.8)]">
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
