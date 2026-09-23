/**
 * โหมดจำลอง "ดูเป็นลูกค้า" (เจ้าของ 2026-09-23: "จำลองของลูกค้า Taweesin สมมุติหลังเราให้คะแนนไปแล้ว เริ่มจากหน้ากระเป๋า")
 * แอดมินเปิดหน้าลูกค้าจริงทุกหน้า (คอมโพเนนต์เดียวกัน — DNA shared preview) ในนามลูกค้าคนหนึ่ง + ข้อมูลจำลอง
 * หลังเปิดระบบคะแนน · **ห้ามมีผลจริงใดๆ**: store จำลองไม่บันทึก และตัวช่วยที่มีผลภายนอก (อัปโหลด / LINE / push /
 * จองสต๊อก) เช็คธงนี้แล้วไม่ทำงาน — กันกรณีหน้าไหนเรียก store ตัวจริงหรือ lib ตรงๆ
 * ธงเป็นตัวแปรระดับโมดูล ตั้งโดย SimGate ตอน mount (อยู่ใน layout ลูกค้าเท่านั้น) และล้างตอน unmount
 */
export type SimInfo = { uid: string; name: string };

let active: SimInfo | null = null;

export const simActive = (): SimInfo | null => active;
export const setSimActive = (v: SimInfo | null): void => { active = v; };

/** sessionStorage key — โหมดจำลองอยู่รอดการกดลิงก์ข้ามหน้า แต่หายเมื่อปิดแท็บ */
export const SIM_KEY = 'ryuma_sim_view';
export const SIM_BLOCKED = 'โหมดจำลอง — ดูได้อย่างเดียว ไม่บันทึก/ไม่ส่งจริง';
