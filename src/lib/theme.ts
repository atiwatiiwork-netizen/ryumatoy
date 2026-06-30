/**
 * Status / rank palettes as Tailwind className maps. These pair text/bg/border
 * colors keyed by a runtime value (product status, rank name), so they can't be
 * plain utility classes in markup — they live here and are looked up by key.
 * Colors come straight from design-reference/HANDOFF.md.
 */

export const STATUS = {
  open: { cls: 'text-[#4ade80] bg-[#16a34a]/[0.14] border-[#16a34a]/40', label: 'เปิดจอง' },
  production: { cls: 'text-[#fbbf24] bg-[#d97706]/[0.14] border-[#d97706]/40', label: 'กำลังผลิต' },
  shipping: { cls: 'text-[#60a5fa] bg-[#2563eb]/[0.14] border-[#2563eb]/40', label: 'กำลังเดินทาง' },
  arrived: { cls: 'text-[#f87171] bg-[#b91c1c]/[0.16] border-[#b91c1c]/[0.45]', label: 'ถึงไทยแล้ว' },
  paid_full: { cls: 'text-[#22c55e] bg-[#16a34a]/[0.16] border-[#16a34a]/40', label: 'จ่ายครบ ✓' },
  closed: { cls: 'text-ink-muted bg-white/[0.06] border-white/10', label: 'ปิดแล้ว' },
} as const;
export type StatusKey = keyof typeof STATUS;

/** Status fill color for progress bars (solid hex). */
export const STATUS_FILL: Record<StatusKey, string> = {
  open: '#4ade80',
  production: '#fbbf24',
  shipping: '#60a5fa',
  arrived: '#f87171',
  paid_full: '#22c55e',
  closed: '#9a9290',
};

export const RANK = {
  bronze: { emoji: '🥉', cls: 'text-[#e8b27d] border-[#b45309]/50', grad: 'linear-gradient(135deg, rgba(180,83,9,.25), rgba(120,53,15,.15))', label: 'Bronze' },
  silver: { emoji: '🥈', cls: 'text-[#d7dde6] border-[#94a3b8]/50', grad: 'linear-gradient(135deg, rgba(148,163,184,.25), rgba(100,116,139,.12))', label: 'Silver' },
  gold: { emoji: '🥇', cls: 'text-[#f1d27a] border-[#d4af37]/[0.55]', grad: 'linear-gradient(135deg, rgba(212,175,55,.3), rgba(161,98,7,.15))', label: 'Gold' },
  diamond: { emoji: '💎', cls: 'text-[#9fe9f5] border-[#38bdf8]/[0.55]', grad: 'linear-gradient(135deg, rgba(56,189,248,.28), rgba(14,165,233,.12))', label: 'Diamond' },
} as const;
export type RankKey = keyof typeof RANK;

/** Format a THB price the way the mocks do: ฿1,234 (no decimals). */
export const baht = (n: number) => '฿' + Math.round(n).toLocaleString('en-US');
