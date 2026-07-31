// โหมดพรีวิวด้วยข้อมูล seed (ไม่ต่อ Supabase) — `npm run dev:seed` แล้วเปิด http://localhost:3100
//
// ใช้ทดสอบหน้าจอฝั่งแอดมิน/ลูกค้าโดยไม่ต้องล็อกอินจริง: เมื่อ NEXT_PUBLIC_SUPABASE_* ว่าง
// hasSupabase = false → canLogin = false → AdminLock/OnboardGate ปิดตัวเอง และแอปวิ่งบน seed
// ใน localStorage. ข้อมูลจริงบนคลาวด์ไม่ถูกแตะเลย (ไม่มี client ให้เขียน)
//
// @next/env จะไม่ทับค่าที่มีอยู่แล้วใน process.env → ตั้งเป็นค่าว่างตรงนี้จึงชนะ .env.local
import { spawn } from 'node:child_process';

process.env.NEXT_PUBLIC_SUPABASE_URL = '';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = '';

const child = spawn('npx', ['next', 'dev', '-p', process.env.PORT || '3100'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
