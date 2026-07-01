import Link from 'next/link';

export const metadata = { title: 'นโยบายความเป็นส่วนตัว · Ryuma' };

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-base px-5 py-10 font-sans text-ink">
      <div className="mx-auto max-w-[720px]">
        <Link href="/" className="text-[13px] text-primary-soft">← กลับหน้าร้าน Ryuma</Link>
        <h1 className="mt-4 text-2xl font-extrabold">นโยบายความเป็นส่วนตัว (Privacy Policy)</h1>
        <p className="mt-1 text-[13px] text-ink-faint">ปรับปรุงล่าสุด: 1 กรกฎาคม 2026 · Ryuma (ริวมะ) — ร้านพรีออเดอร์ฟิกเกอร์/WCF</p>

        <Section title="1. ข้อมูลที่เราเก็บ">
          <ul className="ml-4 list-disc space-y-1">
            <li>ชื่อและรูปโปรไฟล์สาธารณะจาก Facebook (public_profile) เมื่อคุณเข้าสู่ระบบ</li>
            <li>เบอร์โทรศัพท์ และที่อยู่จัดส่ง ที่คุณกรอกเอง</li>
            <li>LINE ID (ถ้าให้ไว้ — ไม่บังคับ)</li>
            <li>ประวัติคำสั่งซื้อ ใบพรีออเดอร์ และสถานะสมาชิก</li>
          </ul>
        </Section>

        <Section title="2. วัตถุประสงค์การใช้ข้อมูล">
          <ul className="ml-4 list-disc space-y-1">
            <li>ยืนยันตัวตนและเข้าสู่ระบบ</li>
            <li>จัดส่งสินค้าและติดต่อเรื่องคำสั่งซื้อ/ใบพรี</li>
            <li>คำนวณสิทธิพิเศษระบบสมาชิก (rank)</li>
          </ul>
        </Section>

        <Section title="3. การเปิดเผยข้อมูล">
          <p>เรา<b>ไม่ขายและไม่แชร์</b>ข้อมูลส่วนบุคคลของคุณกับบุคคลที่สามเพื่อการตลาด ข้อมูลถูกจัดเก็บอย่างปลอดภัยบนผู้ให้บริการฐานข้อมูล (Supabase) และใช้เพียงเพื่อให้บริการของร้านเท่านั้น</p>
        </Section>

        <Section title="4. สิทธิของคุณ">
          <p>คุณมีสิทธิขอดู แก้ไข หรือลบข้อมูลส่วนบุคคลของคุณได้ตลอดเวลา — ดูวิธีลบข้อมูลได้ที่ <Link href="/data-deletion" className="text-primary-soft underline">หน้าการลบข้อมูล</Link></p>
        </Section>

        <Section title="5. ติดต่อเรา">
          <p>LINE Official: <b>@ryumatoy</b> · หรือทักผ่านเพจ Facebook ของร้าน</p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-1.5 text-base font-bold">{title}</h2>
      <div className="text-[14px] leading-relaxed text-ink-muted2">{children}</div>
    </section>
  );
}
