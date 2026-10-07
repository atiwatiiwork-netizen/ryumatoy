import type { LineTone } from '@/domain/services/lines';

/** สีป้ายไลน์ (ใช้ร่วมกัน: ป้ายบนรูป · วงเลขในรายการ · legend · ชิปนับ) — แก้ที่นี่ที่เดียว */
export const TONE_HEX: Record<LineTone, string> = {
  green: '#34d399',
  blue: '#60a5fa',
  purple: '#c4b5fd',
  amber: '#fbbf24',
  gray: '#9ca3af',
};

/** คำอธิบายสี (ตรงกับป้ายบนรูป) — ไม่มีป้าย = ค่ายยังไม่เปิดตัวนั้น */
export const TONE_LEGEND: { tone: Exclude<LineTone, 'gray'>; label: string }[] = [
  { tone: 'green', label: 'พร้อมส่ง' },
  { tone: 'blue', label: 'เปิดพรี' },
  { tone: 'purple', label: 'ปิดพรีแล้ว' },
  { tone: 'amber', label: 'ของออกแล้ว · หาของ' },
];
