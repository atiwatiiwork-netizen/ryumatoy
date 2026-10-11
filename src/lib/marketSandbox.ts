/**
 * โหมด "ทดลองเล่นตลาด" ของแอดมิน (เจ้าของ 2026-09-24: "ทำมาให้ลองเล่นเล่นหน่อย") — ธงระดับโมดูลแบบเดียวกับ lib/sim.ts
 * ตอนเปิดแท็บทดลองเล่นใน /admin/market: ทุก RPC ตลาด / push / LINE / อัปโหลดสลิป วิ่งเข้าเครื่องจำลองในหน้าเว็บ
 * แทนเซิร์ฟเวอร์ → ไม่มีอะไรถึงฐานข้อมูลจริง ไม่มีลูกค้าคนไหนได้ push · ปิดแท็บ/ออกจากหน้า = ล้างธง
 */
export interface MarketSandboxHooks {
  /** แทน supabase.rpc(fn, args) ของตลาด */
  call(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** แทนการยิง push จริง (จดลงบันทึกเหตุการณ์ให้เห็นว่าใครจะได้แจ้งเตือนอะไร) */
  push(id: string, kind: string): void;
  /** แทน LINE แจ้งแอดมิน */
  line(message: string): void;
}

let active: MarketSandboxHooks | null = null;

export const marketSandbox = (): MarketSandboxHooks | null => active;
export const setMarketSandbox = (v: MarketSandboxHooks | null): void => { active = v; };
