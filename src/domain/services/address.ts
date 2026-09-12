/**
 * แพลตฟอร์มที่อยู่จัดส่ง (เจ้าของ 2026-09-12): ช่องแยก ชื่อผู้รับ / เบอร์ / ที่อยู่ / จังหวัด / ไปรษณีย์.
 *
 * หลักการเก็บ: โครงสร้างจริงอยู่ที่ `users.shipping_info` (jsonb, v68) แต่ทุกครั้งที่เซฟต้องเขียน
 * `shipping_address` เป็น "ข้อความประกอบแล้ว" คู่กันเสมอ — ใบปะหน้า A4 / หน้าจัดส่ง / หน้าแอดมิน /
 * needsProfile gate อ่านช่องข้อความเดิมต่อได้หมดโดยไม่ต้องแตะสักบรรทัด (กัน regression ทั้งสาย).
 * ที่อยู่ legacy ที่เป็นข้อความล้วน: ฟอร์มเติมลงช่อง "ที่อยู่" ให้ลูกค้าเกลาเอง ไม่เดา parse.
 */

import type { ShippingInfo, User } from '../entities';

/** 77 จังหวัด — ใช้ทำ datalist ให้พิมพ์แล้วเด้งตัวเลือก (ไม่บังคับต้องตรงลิสต์ กัน edge เขต กทม.) */
export const THAI_PROVINCES = [
  'กรุงเทพมหานคร', 'กระบี่', 'กาญจนบุรี', 'กาฬสินธุ์', 'กำแพงเพชร', 'ขอนแก่น', 'จันทบุรี', 'ฉะเชิงเทรา',
  'ชลบุรี', 'ชัยนาท', 'ชัยภูมิ', 'ชุมพร', 'เชียงราย', 'เชียงใหม่', 'ตรัง', 'ตราด', 'ตาก', 'นครนายก',
  'นครปฐม', 'นครพนม', 'นครราชสีมา', 'นครศรีธรรมราช', 'นครสวรรค์', 'นนทบุรี', 'นราธิวาส', 'น่าน',
  'บึงกาฬ', 'บุรีรัมย์', 'ปทุมธานี', 'ประจวบคีรีขันธ์', 'ปราจีนบุรี', 'ปัตตานี', 'พระนครศรีอยุธยา',
  'พะเยา', 'พังงา', 'พัทลุง', 'พิจิตร', 'พิษณุโลก', 'เพชรบุรี', 'เพชรบูรณ์', 'แพร่', 'ภูเก็ต',
  'มหาสารคาม', 'มุกดาหาร', 'แม่ฮ่องสอน', 'ยโสธร', 'ยะลา', 'ร้อยเอ็ด', 'ระนอง', 'ระยอง', 'ราชบุรี',
  'ลพบุรี', 'ลำปาง', 'ลำพูน', 'เลย', 'ศรีสะเกษ', 'สกลนคร', 'สงขลา', 'สตูล', 'สมุทรปราการ',
  'สมุทรสงคราม', 'สมุทรสาคร', 'สระแก้ว', 'สระบุรี', 'สิงห์บุรี', 'สุโขทัย', 'สุพรรณบุรี', 'สุราษฎร์ธานี',
  'สุรินทร์', 'หนองคาย', 'หนองบัวลำภู', 'อ่างทอง', 'อำนาจเจริญ', 'อุดรธานี', 'อุตรดิตถ์', 'อุทัยธานี',
  'อุบลราชธานี',
];

/** ประกอบเป็นข้อความบรรทัดเดียวสำหรับใบปะหน้า/ช่อง shipping_address เดิม */
export const composeAddress = (info: ShippingInfo): string =>
  [info.address?.trim(), info.province?.trim(), info.postal?.trim()].filter(Boolean).join(' ');

/** ตรวจฟอร์ม — คืนข้อความ error ภาษาคน หรือ null ถ้าครบ */
export function addressProblem(info: ShippingInfo): string | null {
  if (!info.name?.trim()) return 'กรอกชื่อผู้รับ';
  if (!info.phone?.trim()) return 'กรอกเบอร์โทรผู้รับ';
  if (!/^0\d{8,9}$/.test(info.phone.replace(/[^\d]/g, ''))) return 'เบอร์โทรไม่ถูกต้อง (0 นำหน้า 9–10 หลัก)';
  if (!info.address?.trim()) return 'กรอกที่อยู่ (บ้านเลขที่ / ถนน / ตำบล / อำเภอ)';
  if (!info.province?.trim()) return 'เลือกจังหวัด';
  if (!/^\d{5}$/.test(info.postal?.trim() ?? '')) return 'รหัสไปรษณีย์ต้อง 5 หลัก';
  return null;
}

/** แยกข้อความประกอบกลับเป็นช่อง — best-effort ไว้ "เติมฟอร์ม" ตอนแก้เท่านั้น (แหล่งเก็บจริงคือ shipping_info):
 *  ดึงรหัสไปรษณีย์ 5 หลักท้ายข้อความ + จังหวัดที่ลงท้าย (เทียบลิสต์ 77) — แยกไม่ได้ก็ยกทั้งก้อนลงช่องที่อยู่ */
export function splitComposed(text?: string): Pick<ShippingInfo, 'address' | 'province' | 'postal'> {
  let s = (text ?? '').trim();
  let postal = '';
  const pm = s.match(/(\d{5})\s*$/);
  if (pm) { postal = pm[1]; s = s.slice(0, pm.index).replace(/[,\s]+$/, '').trim(); }
  let province = '';
  for (const p of THAI_PROVINCES) {
    if (s.endsWith(p)) { province = p; s = s.slice(0, s.length - p.length).replace(/[,\s]+$/, '').trim(); break; }
  }
  if (province && /จ\.$/.test(s)) s = s.replace(/จ\.$/, '').replace(/[,\s]+$/, '').trim(); // เผื่อเขียน "จ.ชลบุรี"
  return { address: s, province, postal };
}

/** ค่าตั้งต้นของฟอร์ม: โครงสร้างที่เคยเซฟ > สมาชิกเก่า (ข้อความล้วน) เติมชื่อเฟส+เบอร์ล็อกอิน
 *  แล้วพยายามแยกจังหวัด/ไปรษณีย์จากข้อความเดิมให้ (ลูกค้าเกลาต่อได้เลย) */
export function shippingInfoOf(u?: User | null): ShippingInfo {
  if (u?.shipping_info && (u.shipping_info.address || u.shipping_info.name)) return u.shipping_info;
  return { name: u?.display_name ?? '', phone: u?.phone ?? '', ...splitComposed(u?.shipping_address) };
}
