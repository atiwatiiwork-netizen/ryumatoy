'use client';

/**
 * ตาข่ายกันจอขาว (audit persist #7) — เดิมไม่มีไฟล์นี้เลย แปลว่า exception เดียว
 * ที่หลุดออกมาจาก effect/render = React ถอด root ทิ้งทั้งแอป กลายเป็นจอขาวสนิท
 * รีเฟรชกี่ครั้งก็ขาว (เพราะสาเหตุเดิมยังอยู่) และลูกค้าไม่มีทางรู้ว่าต้องทำอะไรต่อ
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-base px-6 text-center font-sans text-ink">
      <div className="max-w-[380px]">
        <img src="/ryuma-logo.png" alt="" width={52} height={52} className="mx-auto mb-4 rounded-xl opacity-90" />
        <div className="text-[17px] font-extrabold">ขออภัยครับ หน้านี้มีปัญหา</div>
        <div className="mt-1.5 text-[13px] text-ink-muted2">
          ข้อมูลการสั่งซื้อของคุณไม่ได้หายไปไหน — กดลองใหม่ได้เลย ถ้ายังไม่หายทักแอดมินได้ครับ
        </div>
        <div className="mt-5 flex flex-col gap-2">
          <button onClick={reset} className="w-full rounded-btn bg-cta py-3 text-sm font-bold text-white">ลองใหม่อีกครั้ง</button>
          <a href="/" className="w-full rounded-btn border border-subtle py-3 text-sm font-semibold text-ink-muted2">กลับหน้าแรก</a>
        </div>
        {error?.digest && <div className="mt-4 font-mono text-[10.5px] text-ink-faint">รหัสอ้างอิง {error.digest}</div>}
      </div>
    </div>
  );
}
