import Link from 'next/link';

export const metadata = { title: 'การลบข้อมูลผู้ใช้ · Ryuma' };

export default function DataDeletionPage() {
  return (
    <div className="min-h-screen bg-base px-5 py-10 font-sans text-ink">
      <div className="mx-auto max-w-[720px]">
        <Link href="/" className="text-[13px] text-primary-soft">← กลับหน้าร้าน Ryuma</Link>
        <h1 className="mt-4 text-2xl font-extrabold">คำแนะนำการลบข้อมูลผู้ใช้ (Data Deletion)</h1>
        <p className="mt-1 text-[13px] text-ink-faint">Ryuma (ริวมะ) เคารพสิทธิ์ในข้อมูลส่วนบุคคลของคุณ</p>

        <section className="mt-6 text-[14px] leading-relaxed text-ink-muted2">
          <p>หากคุณต้องการให้เราลบข้อมูลส่วนบุคคลทั้งหมดที่เก็บไว้ (ชื่อ รูปโปรไฟล์ เบอร์โทร ที่อยู่ LINE ID และประวัติคำสั่งซื้อ) โปรดทำตามขั้นตอน:</p>
          <ol className="ml-4 mt-3 list-decimal space-y-2">
            <li>ทักหาเราทาง <b>LINE Official: @ryumatoy</b> หรือเพจ Facebook ของร้าน</li>
            <li>แจ้ง <b>ชื่อบัญชี Facebook</b> และ <b>เบอร์โทรศัพท์</b> ที่ใช้สมัคร พร้อมข้อความ “ขอลบข้อมูล”</li>
            <li>ทีมงานจะยืนยันตัวตนและ<b>ลบข้อมูลของคุณภายใน 7 วันทำการ</b> แล้วแจ้งกลับเมื่อดำเนินการเสร็จ</li>
          </ol>
          <p className="mt-4">หมายเหตุ: ข้อมูลที่จำเป็นตามกฎหมาย (เช่น หลักฐานการชำระเงิน/ภาษี) อาจถูกเก็บไว้ตามระยะเวลาที่กฎหมายกำหนดก่อนลบ</p>
          <p className="mt-4">อ่านเพิ่มเติมได้ที่ <Link href="/privacy" className="text-primary-soft underline">นโยบายความเป็นส่วนตัว</Link></p>
        </section>
      </div>
    </div>
  );
}
