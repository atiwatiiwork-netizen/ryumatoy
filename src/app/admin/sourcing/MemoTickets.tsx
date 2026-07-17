'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { memoCustomersOf, type SourcingMemo, type MemoCustomer } from '@/domain/entities';

/**
 * 🎫 ตั๋วหาของ (การ์ดใบเล็กเหมือนตั๋วพรี) — วาดด้วย canvas แล้วเซฟเป็นรูป ส่งให้ลูกค้าในแชทเฟส
 * (ลูกค้าพวกนี้ไม่มีบัญชีในแอป). ออก "ทีละคน" — 1 ลูกค้า = 1 ใบ ตามที่เจ้าของสั่ง.
 * บนตั๋ว: โลโก้ร้าน + รูปสินค้า + ชื่อสินค้า + ชื่อลูกค้า + ยอดเต็ม/มัดจำ (+ค้าง).
 */

const W = 640, H = 860;

function loadImg(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Supabase storage รูป → กัน canvas taint ตอน toBlob (แบบ watermark.ts)
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const bahtTxt = (n: number) => `฿${n.toLocaleString('th-TH')}`;

async function drawTicket(canvas: HTMLCanvasElement, memo: SourcingMemo, customer: MemoCustomer, seq: number, total: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = W; canvas.height = H;

  // พื้นหลังแดงเข้ม + ขอบทอง (โทนเดียวกับแบรนด์)
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1c0d0d'); bg.addColorStop(0.5, '#2a0f0f'); bg.addColorStop(1, '#160a0a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 5; ctx.strokeRect(10, 10, W - 20, H - 20);
  ctx.strokeStyle = 'rgba(212,175,55,.35)'; ctx.lineWidth = 1.5; ctx.strokeRect(20, 20, W - 40, H - 40);

  // หัว: โลโก้ + ชื่อร้าน
  const logo = await loadImg('/ryuma-logo.png');
  if (logo) {
    ctx.save();
    ctx.beginPath(); ctx.arc(70, 74, 30, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(logo, 40, 44, 60, 60);
    ctx.restore();
  }
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 34px system-ui, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('Ryuma', 116, 70);
  ctx.fillStyle = '#e0b04a'; ctx.font = 'bold 19px system-ui, sans-serif';
  ctx.fillText('ตั๋วหาของ · SOURCING TICKET', 116, 98);
  // เลขใบ (ทีละคน)
  ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = '16px system-ui, sans-serif'; ctx.textAlign = 'right';
  ctx.fillText(`ใบที่ ${seq}/${total}`, W - 40, 70);
  const d = new Date(`${memo.started_at}T00:00:00`);
  ctx.fillText(isNaN(d.getTime()) ? '' : d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }), W - 40, 96);

  // รูปสินค้า (คงสัดส่วน แบบ cover)
  const imgY = 128, imgH = 380, imgX = 40, imgW = W - 80;
  ctx.fillStyle = '#0d0606'; ctx.fillRect(imgX, imgY, imgW, imgH);
  const pImg = memo.image_url ? await loadImg(memo.image_url) : null;
  if (pImg) {
    const scale = Math.max(imgW / pImg.width, imgH / pImg.height);
    const dw = pImg.width * scale, dh = pImg.height * scale;
    ctx.save(); ctx.beginPath(); ctx.rect(imgX, imgY, imgW, imgH); ctx.clip();
    ctx.drawImage(pImg, imgX + (imgW - dw) / 2, imgY + (imgH - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.font = 'bold 26px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('RYUMA', W / 2, imgY + imgH / 2);
  }
  ctx.strokeStyle = 'rgba(212,175,55,.5)'; ctx.lineWidth = 2; ctx.strokeRect(imgX, imgY, imgW, imgH);

  // ชื่อสินค้า (ตัดถ้ายาว)
  ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff'; ctx.font = 'bold 30px system-ui, sans-serif';
  let name = memo.product_name;
  while (ctx.measureText(name).width > W - 90 && name.length > 4) name = name.slice(0, -2);
  if (name !== memo.product_name) name += '…';
  ctx.fillText(name + (memo.qty > 1 ? `  ×${memo.qty}` : ''), W / 2, imgY + imgH + 52);

  // ชื่อลูกค้า (กล่องทอง)
  const custY = imgY + imgH + 80;
  ctx.fillStyle = 'rgba(212,175,55,.12)'; ctx.fillRect(40, custY, W - 80, 56);
  ctx.strokeStyle = 'rgba(212,175,55,.45)'; ctx.lineWidth = 1.5; ctx.strokeRect(40, custY, W - 80, 56);
  ctx.fillStyle = '#f1d27a'; ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.fillText(`👤 ${customer.name}`, W / 2, custY + 38);

  // ยอดเต็ม / มัดจำ / ค้าง
  const payY = custY + 84;
  const owe = (memo.price ?? 0) - (memo.deposit ?? 0);
  const box = (x: number, w: number, label: string, val: string, color: string) => {
    ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(x, payY, w, 84);
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1; ctx.strokeRect(x, payY, w, 84);
    ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.font = '17px system-ui, sans-serif';
    ctx.fillText(label, x + w / 2, payY + 30);
    ctx.fillStyle = color; ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.fillText(val, x + w / 2, payY + 64);
  };
  const bw = (W - 80 - 20) / 3;
  box(40, bw, 'ยอดเต็ม', memo.price != null ? bahtTxt(memo.price) : '—', '#ffffff');
  box(40 + bw + 10, bw, 'มัดจำแล้ว', memo.deposit != null ? bahtTxt(memo.deposit) : '—', '#4ade80');
  box(40 + (bw + 10) * 2, bw, 'ค้างชำระ', memo.price != null ? bahtTxt(Math.max(0, owe)) : '—', '#f87171');

  // ท้ายตั๋ว
  ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.font = '15px system-ui, sans-serif';
  ctx.fillText('เก็บภาพนี้ไว้เป็นหลักฐานการจอง · ร้าน Ryuma ริวมะ', W / 2, H - 44);
}

export function MemoTicketsModal({ memo, onClose }: { memo: SourcingMemo; onClose: () => void }) {
  const customers = memoCustomersOf(memo);
  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-black/80 p-4" onClick={onClose}>
      <div className="mx-auto max-w-[720px]" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between rounded-xl border border-subtle bg-surface-2 px-4 py-3">
          <div className="text-[14px] font-bold">🎫 ตั๋วหาของ — {memo.product_name} <span className="text-[12px] font-normal text-ink-faint">(ออกทีละคน · {customers.length} ใบ)</span></div>
          <button onClick={onClose} aria-label="ปิด" className="grid h-8 w-8 place-items-center rounded-full bg-surface-3 text-ink-faint"><Icon name="x" size={15} /></button>
        </div>
        <div className="flex flex-col gap-4">
          {customers.map((c, i) => <TicketCard key={i} memo={memo} customer={c} seq={i + 1} total={customers.length} />)}
        </div>
      </div>
    </div>
  );
}

function TicketCard({ memo, customer, seq, total }: { memo: SourcingMemo; customer: MemoCustomer; seq: number; total: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ref.current) void drawTicket(ref.current, memo, customer, seq, total).then(() => setReady(true));
  }, [memo, customer, seq, total]);

  const download = () => {
    ref.current?.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ticket-${memo.product_name.slice(0, 20)}-${customer.name}.png`.replace(/\s+/g, '-');
      a.click();
      URL.revokeObjectURL(a.href);
    });
  };

  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-3">
      <canvas ref={ref} className="w-full rounded-xl" style={{ aspectRatio: `${W}/${H}` }} />
      <button onClick={download} disabled={!ready} className="mt-2.5 w-full rounded-xl bg-cta py-2.5 text-[13px] font-bold text-white disabled:opacity-50">
        💾 เซฟรูปตั๋วของ {customer.name} (ส่งในแชทเฟส)
      </button>
    </div>
  );
}
