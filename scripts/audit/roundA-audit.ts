/** เทสต์ฝั่งแอปของรอบ A (audit เปลี่ยนใบพรี 2026-10-03) — รัน: npm run audit:roundA
 *  ฝั่งฐานข้อมูลอยู่ที่ scripts/audit/sql/roundA-audit.ts (npm run audit:sql) */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.TZ = 'Asia/Bangkok';
import { rowPatch } from '../../src/data/rowPatch';
import { isTransientPersistError, friendlyPersistError, persistFailText } from '../../src/data/persistErrors';
import { syncTablePatch } from '../../src/data/supabaseAdapter';
import { Store } from '../../src/data/store';
import { SEED_DATABASE } from '../../src/data/seed';
import { approveRemainingPayment, rpOverDue, editTicketDeposit, repairTickets, fillMissingTicketsFor } from '../../src/data/mutations';
import { ticketTransferred, hasMarketHistory } from '../../src/domain/services/market';
import { dataIssues } from '../../src/domain/services/worklist';
import type { Database, PreorderTicket, Order, TicketTransfer, RemainingPayment } from '../../src/domain/entities';
import type { PersistenceAdapter } from '../../src/data/persistence';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── 1) rowPatch: ส่งเฉพาะช่องที่เปลี่ยน + token จากฐาน ─────────────────────────────────────
  {
    const base = { id: 't1', owner_id: 'uA', ticket_no: 'NR-1', product_status: 'production', deposit_paid: 300, market_rev: 0, delivery: { method: 'courier' } };
    const next = { ...base, product_status: 'shipping' };
    ok('P1 เปลี่ยนสถานะรอบอย่างเดียว → ส่งแค่ product_status + market_rev จากฐาน (ไม่ส่งเจ้าของ/เลขตั๋ว/เงิน)',
      JSON.stringify(rowPatch(base, next, 'id', ['market_rev'])) === JSON.stringify({ product_status: 'shipping', market_rev: 0 }), rowPatch(base, next, 'id', ['market_rev']));
    ok('P2 ไม่มีอะไรเปลี่ยน → null (ไม่ยิงคำขอ)', rowPatch(base, { ...base }, 'id', ['market_rev']) === null);
    const cleared = rowPatch(base, { ...base, delivery: undefined }, 'id', ['market_rev']);
    ok('P3 ลบช่องทิ้ง (undefined) → ส่ง null เพื่อเคลียร์บนเซิร์ฟเวอร์', !!cleared && cleared.delivery === null, cleared);
    ok('P4 แอปเผลอแก้ market_rev เอง → ไม่ถูกส่ง (ใช้ค่าจากฐานเสมอ)', rowPatch(base, { ...base, market_rev: 9 }, 'id', ['market_rev']) === null);
    const noTok = rowPatch({ id: 'u', name: 'a' }, { id: 'u', name: 'b' }, 'id', ['market_rev']);
    ok('P5 ฐานไม่มีคอลัมน์ token (ก่อนรัน v74) → ไม่ส่ง token', JSON.stringify(noTok) === JSON.stringify({ name: 'b' }), noTok);
    const u0 = { id: 'uB', rank: 'bronze', suspended: false, payout_accounts: [{ id: 'pa-0' }], payout_info: { account_name: 'B' } };
    ok('P6 users: แอดมินเปลี่ยนยศจากหน้าจอเก่า → ส่งแค่ rank (บัญชีรับเงินที่ลูกค้าเพิ่งแก้ไม่ถูกทับ)',
      JSON.stringify(rowPatch(u0, { ...u0, rank: 'silver' })) === JSON.stringify({ rank: 'silver' }));
  }

  // ── 2) แยก error ถาวร/ชั่วคราว ───────────────────────────────────────────────────────────────
  {
    ok('E1 เน็ตหลุด/หมดเวลา = ชั่วคราว (ลองใหม่)', isTransientPersistError('preorder_tickets: Failed to fetch') && isTransientPersistError('persist timed out') && isTransientPersistError('users: TypeError: NetworkError when attempting to fetch resource.'));
    ok('E2 ด่าน ryuma: / RLS / FK = ถาวร (ไม่วนส่งซ้ำ)', !isTransientPersistError('remaining_payments: ryuma: ใบนี้อยู่ระหว่างซื้อขาย') && !isTransientPersistError('users: new row violates row-level security policy for table "users"') && !isTransientPersistError('preorder_tickets: update or delete on table "preorder_tickets" violates foreign key constraint'));
    ok('E3 ข้อความรวมหลายตาราง: มีส่วนไหนชั่วคราว → ลองใหม่ทั้งก้อน (ไม่ทิ้งงาน)', isTransientPersistError('users: ryuma: x | orders: Failed to fetch'));
    ok('E4 ข้อความที่คนอ่านรู้เรื่อง: ตัดชื่อตาราง + ryuma: + ข้อความซ้ำ', friendlyPersistError('preorder_tickets: ryuma: ตั๋ว NR-1 เปลี่ยนมือแล้ว | remaining_payments: ryuma: ตั๋ว NR-1 เปลี่ยนมือแล้ว') === 'ตั๋ว NR-1 เปลี่ยนมือแล้ว');
    // review รอบ A: ค่าเริ่มต้นต้องเป็น "ลองใหม่" — error เซิร์ฟเวอร์ชั่วคราวแบบอื่นห้ามถูกทิ้ง
    const transient = ['preorder_tickets: Database connection error. Retrying the connection.', 'orders: deadlock detected', 'users: could not serialize access due to concurrent update',
      'preorder_tickets: no healthy upstream', 'orders: The network connection was lost.', 'users: error code: 520', 'orders: the database system is starting up', 'x: canceling statement due to statement timeout'];
    ok('E5 error เซิร์ฟเวอร์ชั่วคราวที่ไม่รู้จัก (PGRST000/deadlock/520/…) = ลองใหม่ ไม่ทิ้งงาน', transient.every(isTransientPersistError), transient.filter((m) => !isTransientPersistError(m)));
    ok('E6 ด่าน ryuma: ที่มีตัวเลข 502/503/504 ในข้อความ (เช่นแต้มคงเหลือ) ยังเป็นถาวร', !isTransientPersistError('remaining_payments: ryuma: แต้มไม่พอ (คงเหลือ 503 แต้ม)'));
    ok('E7 duplicate key = ถาวร · column ไม่มี (ยังไม่รัน SQL) = ชั่วคราว ลองใหม่ช้าๆ (audit 1005 รอบ 1 #2)', !isTransientPersistError('preorder_tickets: duplicate key value violates unique constraint "preorder_tickets_ticket_no_key"') && isTransientPersistError('users: column "x" does not exist'));
    ok('E8 persistFailText: ถาวร = "ไม่ได้บันทึก — เหตุผลจริง" · ชั่วคราว = ข้อความลองใหม่เดิม',
      persistFailText('preorder_tickets: ryuma: ตั๋ว A อยู่ระหว่างซื้อขาย', 'R') === 'ไม่ได้บันทึก — ตั๋ว A อยู่ระหว่างซื้อขาย' && persistFailText('x: Failed to fetch', 'R') === 'R');
  }

  // ── 3) Store: error ถาวร → แจ้งครั้งเดียว + โหลดของจริง (ไม่วนทุก 5 วิ) · ชั่วคราว → ลองใหม่ ─────────
  {
    const seed = structuredClone(SEED_DATABASE);
    let loads = 0, persists = 0, mode: 'perm' | 'transient' | 'ok' = 'perm';
    const adapter: PersistenceAdapter = {
      load: async () => { loads++; return structuredClone(seed); },
      persist: async () => { persists++; if (mode === 'perm') throw new Error('remaining_payments: ryuma: ใบนี้อยู่ระหว่างซื้อขาย'); if (mode === 'transient') { mode = 'ok'; throw new Error('preorder_tickets: Failed to fetch'); } },
      reset: async () => structuredClone(seed),
    } as PersistenceAdapter;
    const s = new Store(adapter);
    const errs: string[] = [];
    s.onPersistError = (m) => errs.push(m);
    await s.init();
    s.update((d) => ({ ...d, settings: { ...d.settings, shop_name: 'X1' } as any }));
    const r = await s.flush();
    await sleep(50);
    ok('S1 error ถาวร: flush คืนข้อความ · แจ้งครั้งเดียว (ข้อความอ่านง่าย) · โหลดของจริงทันที', !!r && errs.length === 1 && errs[0] === 'ใบนี้อยู่ระหว่างซื้อขาย' && loads === 2, { r, errs, loads });
    ok('S2 หลังโหลดใหม่ ค่าที่ถูกปฏิเสธกลับเป็นค่าบนเซิร์ฟเวอร์', (s.getState().settings as any).shop_name !== 'X1');
    const before = persists;
    await sleep(5_600);
    ok('S3 ไม่วนส่งซ้ำทุก 5 วิ (เดิมค้างแบบนี้ตลอดจนรีเฟรช)', persists === before && errs.length === 1, { persists, before, errs: errs.length });
    mode = 'transient';
    s.update((d) => ({ ...d, settings: { ...d.settings, shop_name: 'X2' } as any }));
    const r2 = await s.flush();
    await sleep(5_600);
    ok('S4 error ชั่วคราว: ยังลองใหม่อัตโนมัติ และสำเร็จรอบถัดไป · ค่ายังอยู่', !!r2 && persists >= before + 2 && (s.getState().settings as any).shop_name === 'X2', { persists, before });
    const fresh = await s.reload();
    ok('S5 reload() คืน true เมื่อโหลดสำเร็จ', fresh === true);
    const bad = new Store({ ...adapter, load: async () => { throw new Error('down'); } } as PersistenceAdapter);
    ok('S6 reload() คืน false เมื่อโหลดไม่สำเร็จ (ปุ่มแอดมินต้องไม่ทำต่อ)', (await bad.reload()) === false);
    // review รอบ A: poll/โฟกัสหน้าต่างระหว่าง reload ของปุ่ม ต้องไม่ทำให้ปุ่มขึ้น "โหลดไม่สำเร็จ" ปลอม
    const slow = new Store({ ...adapter, load: async () => { await sleep(200); return structuredClone(seed); } } as PersistenceAdapter);
    await slow.init();
    const pr = slow.reload({ safe: true });
    await sleep(20);
    void slow.reloadIfIdle();
    ok('S7 reloadIfIdle ระหว่าง reload ของปุ่ม → ปุ่มยังได้ true', (await pr) === true);
    const p1 = slow.reload({ safe: true });
    await sleep(20);
    const p2 = slow.reload({ safe: true });
    ok('S8 กดซ้ำ (reload ซ้อน) → ทั้งคู่ได้ true เมื่อโหลดสำเร็จ', (await p1) === true && (await p2) === true);
    // งานค้างลองใหม่ (ชั่วคราว) → reload แบบ safe ไม่โหลดทับ คืน false
    let failOnce = true;
    const pend = new Store({ ...adapter, persist: async () => { if (failOnce) { failOnce = false; throw new Error('x: Failed to fetch'); } } } as PersistenceAdapter);
    await pend.init();
    pend.update((d) => ({ ...d, settings: { ...d.settings, shop_name: 'PENDING' } as any }));
    const safe = await pend.reload({ safe: true });
    ok('S9 มีงานรอลองใหม่ → reload({safe}) คืน false และไม่ทับงานนั้น', safe === false && (pend.getState().settings as any).shop_name === 'PENDING', { safe });
    // error ถาวรระหว่างที่ผู้ใช้แก้ต่อ → การโหลดของจริงต้องไม่ทับ edit ใหม่
    let permOnce = true;
    const perm = new Store({ ...adapter, load: async () => { await sleep(150); return structuredClone(seed); },
      persist: async () => { if (permOnce) { permOnce = false; throw new Error('x: ryuma: ปฏิเสธ'); } } } as PersistenceAdapter);
    await perm.init();
    perm.update((d) => ({ ...d, settings: { ...d.settings, shop_name: 'BAD' } as any }));
    await perm.flush();
    perm.update((d) => ({ ...d, settings: { ...d.settings, hero_image_url: 'NEW-EDIT' } as any }));
    await sleep(400);
    ok('S10 หลัง error ถาวร edit ที่ทำต่อไม่หาย (ไม่โดนโหลดทับ)', (perm.getState().settings as any).hero_image_url === 'NEW-EDIT');
  }

  // ── 3b) syncTablePatch: UPDATE ที่ไม่โดนแถวไหน ห้ามนับว่าเซฟแล้ว ───────────────────────────────────
  {
    const calls: string[] = [];
    const fake = (rows: number, session: boolean) => ({
      from: () => ({
        update: (p: any) => ({ eq: () => ({ select: async () => { calls.push('update:' + JSON.stringify(p)); return { data: Array(rows).fill({ id: 'r1' }), error: null }; } }) }),
        upsert: async (r: any) => { calls.push('upsert:' + r.id); return { error: null }; },
        delete: () => ({ in: async () => ({ error: null }) }),
      }),
      auth: { getSession: async () => ({ data: { session: session ? { access_token: 't' } : null } }) },
    }) as any;
    const base = [{ id: 'r1', a: 1 }], next = [{ id: 'r1', a: 2 }];
    calls.length = 0; await syncTablePatch(fake(1, true), 't', next, base);
    ok('U1 แถวเดิม: ส่งเฉพาะช่องที่เปลี่ยน (UPDATE) ไม่ upsert ทั้งแถว', JSON.stringify(calls) === JSON.stringify(['update:{"a":2}']), calls);
    let err: unknown = null; calls.length = 0;
    try { await syncTablePatch(fake(0, false), 't', next, base); } catch (e) { err = e; }
    ok('U2 UPDATE ไม่โดนแถว + ไม่มี session (token กำลังต่ออายุ) → error ชั่วคราว (store ลองใหม่) ไม่บอกว่าเซฟแล้ว', !!err && isTransientPersistError((err as Error).message), (err as Error)?.message);
    calls.length = 0; await syncTablePatch(fake(0, true), 't', next, base);
    ok('U3 UPDATE ไม่โดนแถว + มี session → upsert ทั้งแถว (แถวที่ insert ไม่ขึ้นรอบก่อน)', calls.includes('upsert:r1'), calls);
  }

  // ── 4) mutation: สลิปเกินยอดค้าง · แก้มัดจำตั๋วเปลี่ยนมือ · ตัวซ่อมตั๋วไม่มินต์ทับ id เดิม ───────────
  {
    const db: Database = structuredClone(SEED_DATABASE);
    db.transfers = [];
    const P = db.products.find((p) => !p.is_stock)!;
    const when = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const mk = (id: string, owner: string, payer: string, over: Partial<PreorderTicket> = {}): PreorderTicket => ({ id, ticket_no: `NR-2026-10-${id.slice(-3)}`, product_id: P.id, owner_id: owner, original_buyer_id: payer, qty: 1, deposit_paid: 300, remaining_amount: 1390, remaining_paid: 0, status: 'active', product_status: 'production', qr_code_url: '', created_at: when, approved_at: when, ...over } as PreorderTicket);
    db.tickets.push(mk('t-oiA01', 'uB', 'uA'), mk('t-oiA02', 'uA', 'uA'), mk('t-oiA03', 'uA', 'uA', { qty: 2, deposit_paid: 600, remaining_amount: 2780 }), mk('tc-child01', 'uB', 'uA', { split_from: 't-oiA03' }));
    db.transfers.push({ id: 'tr-1', ticket_id: 't-oiA01', from_user_id: 'uA', to_user_id: 'uB', asking_price: 500, status: 'done', listed_at: when, approved_at: when } as TicketTransfer);
    const rp = (id: string, tid: string, amount: number): RemainingPayment => ({ id, ticket_id: tid, user_id: 'uA', amount, slip_url: 'https://x/s.jpg', status: 'pending', created_at: when });
    db.remainingPayments.push(rp('rp-over', 't-oiA02', 1500), rp('rp-fit', 't-oiA03', 2780));
    ok('M1 rpOverDue: โอน 1500 กับยอดค้าง 1390 → เกิน 110 · พอดี → 0', rpOverDue(db, db.remainingPayments.find((r) => r.id === 'rp-over')!) === 110 && rpOverDue(db, db.remainingPayments.find((r) => r.id === 'rp-fit')!) === 0);
    const a1 = approveRemainingPayment('rp-over')(db);
    ok('M2 อนุมัติสลิปที่โอนเกินยอดค้างไม่ได้ (เดิมส่วนเกินหายเงียบ)', a1 === db);
    const a2 = approveRemainingPayment('rp-fit')(db);
    ok('M3 สลิปพอดียอด อนุมัติได้ตามปกติ', a2.remainingPayments.find((r) => r.id === 'rp-fit')?.status === 'approved' && a2.tickets.find((t) => t.id === 't-oiA03')?.status === 'paid_full');
    ok('M4 ticketTransferred: ไฟนอลแล้ว / ใบแม่ที่ถูกแตก / ตั๋วลูก = true · ตั๋วธรรมดา = false',
      ticketTransferred(db, db.tickets.find((t) => t.id === 't-oiA01')!) && ticketTransferred(db, db.tickets.find((t) => t.id === 't-oiA03')!) && ticketTransferred(db, db.tickets.find((t) => t.id === 'tc-child01')!) && !ticketTransferred(db, db.tickets.find((t) => t.id === 't-oiA02')!));
    const listedOnly = { ...db, transfers: [{ id: 'tr-x', ticket_id: 't-oiA02', from_user_id: 'uA', asking_price: 1, status: 'cancelled', listed_at: when } as TicketTransfer] };
    ok('M5 ใบที่แค่เคยลงขายแล้วถอน: มีประวัติตลาด (ลบไม่ได้) แต่ยังไม่นับว่าเปลี่ยนมือ (แก้มัดจำได้)', hasMarketHistory(listedOnly, listedOnly.tickets.find((t) => t.id === 't-oiA02')!) && !ticketTransferred(listedOnly, listedOnly.tickets.find((t) => t.id === 't-oiA02')!));
    ok('M6 แก้มัดจำตั๋วที่เปลี่ยนมือแล้ว = ไม่ทำอะไร · ตั๋วธรรมดาแก้ได้', editTicketDeposit('t-oiA01', 500)(db) === db && editTicketDeposit('t-oiA02', 500)(db).tickets.find((t) => t.id === 't-oiA02')?.deposit_paid === 500);
    // ตัวซ่อมตั๋ว: ออเดอร์ A มี 2 รายการสินค้าเดียวกัน · ตั๋วของรายการที่ 2 มีอยู่แล้ว แต่ตั๋วรายการแรกหาย → ห้ามมินต์ทับ id เดิม
    const d2: Database = structuredClone(SEED_DATABASE);
    d2.transfers = [];
    const o: Order = { id: 'o-r', user_id: 'uR', total_deposit: 600, slip_url: 'x', status: 'approved', created_at: when, approved_at: when,
      items: [{ id: 'oiR1', order_id: 'o-r', product_id: P.id, qty: 1, deposit_amount: 300 }, { id: 'oiR2', order_id: 'o-r', product_id: P.id, qty: 1, deposit_amount: 300 }] } as Order;
    d2.orders.push(o);
    d2.tickets.push(mk('legacy-R', 'uR', 'uR', { remaining_paid: 400 }), mk('t-oiR2', 'uR', 'uR', { remaining_paid: 400 }));
    const fixed = repairTickets()(d2);
    const ids = fixed.tickets.filter((t) => t.owner_id === 'uR').map((t) => t.id);
    ok('M7 ซ่อมตั๋ว: ไม่สร้างแถว id ซ้ำทับตั๋วจริง (เดิมยอดที่จ่ายแล้วของใบนั้นหาย)', new Set(ids).size === ids.length && fixed.tickets.find((t) => t.id === 't-oiR2')?.remaining_paid === 400, ids);
    const healed = fillMissingTicketsFor('uR')(d2);
    const hids = healed.tickets.filter((t) => t.owner_id === 'uR').map((t) => t.id);
    ok('M8 self-heal ลูกค้า: ไม่สร้างแถว id ซ้ำเช่นกัน', new Set(hids).size === hids.length, hids);
  }

  // ── 5) dataIssues: ดีลไฟนอลแล้วแต่ตั๋วไม่อยู่กับผู้รับ ───────────────────────────────────────────
  {
    const db: Database = structuredClone(SEED_DATABASE);
    const when = new Date().toISOString();
    const P = db.products[0];
    db.transfers = [
      { id: 'tr-ok', ticket_id: 't-z1', from_user_id: 'uA', to_user_id: 'uB', asking_price: 1, status: 'done', listed_at: when, approved_at: '2026-10-01T00:00:00Z' } as TicketTransfer,
      { id: 'tr-chain', ticket_id: 't-z1', from_user_id: 'uB', to_user_id: 'uC', asking_price: 1, status: 'done', listed_at: when, approved_at: '2026-10-02T00:00:00Z' } as TicketTransfer,
      { id: 'tr-bad', ticket_id: 't-z2', from_user_id: 'uA', to_user_id: 'uB', asking_price: 1, status: 'done', listed_at: when, approved_at: when } as TicketTransfer,
    ];
    db.tickets.push({ id: 't-z1', ticket_no: 'Z1', product_id: P.id, owner_id: 'uC', original_buyer_id: 'uA', qty: 1, deposit_paid: 1, remaining_amount: 1, remaining_paid: 0, status: 'active', product_status: 'production', qr_code_url: '', created_at: when } as PreorderTicket,
      { id: 't-z2', ticket_no: 'Z2', product_id: P.id, owner_id: 'uA', original_buyer_id: 'uA', qty: 1, deposit_paid: 1, remaining_amount: 1, remaining_paid: 0, status: 'active', product_status: 'production', qr_code_url: '', created_at: when } as PreorderTicket);
    const iss = dataIssues(db).find((i) => i.key === 'transfer_owner');
    ok('D1 เตือน "ดีลไฟนอลแล้วแต่ตั๋วไม่อยู่กับผู้รับ" เฉพาะใบที่เพี้ยน (ส่งต่อเป็นทอดถูกต้อง = ไม่เตือน)', !!iss && iss.rows.length === 1 && iss.rows[0].id === 'tr-bad', iss);
  }

  console.log(`\nroundA-audit (app): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
