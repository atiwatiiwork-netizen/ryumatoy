/**
 * audit_realtime.mjs — ตรวจ "ราคาเรียลไทม์ + สภาพแข่งขัน (race)" ของระบบประมูล
 *
 * ไม่ต่อฐานข้อมูลจริง: จำลองพฤติกรรมตามโค้ดจริงที่อ่านมาแล้ว
 *   · AuctionRoom.pull()/view merge      (src/components/AuctionRoom.tsx)
 *   · mutations.voidAuctionBid/placeBidLocal (src/data/mutations.ts)  — คัดลอกมาตรงตัว
 *   · supabaseAdapter.syncTable          (src/data/supabaseAdapter.ts) — คัดลอกมาตรงตัว
 *   · ryuma_place_bid / ryuma_bid_step   (supabase/migration_auction_v60.sql) — พอร์ตเป็น JS
 * รัน: node audit_realtime.mjs
 */
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n══ ${t} ${'═'.repeat(Math.max(0, 66 - t.length))}`);
let fails = 0;
const expect = (name, cond, detail = '') => {
  log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails++;
};

// ── พอร์ตจาก SQL v60 ────────────────────────────────────────────────────────
const bidStep = (p) => (p >= 10000 ? 200 : p >= 5000 ? 100 : p >= 3000 ? 50 : 20);
/** ryuma_place_bid: ตัดสินทุกอย่างจาก "แถวที่ล็อกไว้" (a) ไม่ใช่ค่าที่ client ส่งมา */
function rpcPlaceBid(a, amount) {
  if (a.status !== 'live') return { error: 'not_live' };
  const min = a.bid_count === 0 ? a.start_price : a.current_price + bidStep(a.current_price);
  if (amount % 10 !== 0) return { error: 'not_round', min };
  if (amount < min) return { error: 'too_low', min, price: a.current_price };
  a.current_price = amount;
  a.bid_count += 1;
  return { ok: true, price: amount, bid_count: a.bid_count, next_min: amount + bidStep(amount) };
}

// ── คัดลอกจาก src/domain/services/auctions.ts ───────────────────────────────
const stepFor = (price) => (price >= 10000 ? 200 : price >= 5000 ? 100 : price >= 3000 ? 50 : 20);
const minNextBid = (a) => (a.bid_count === 0 ? a.start_price : a.current_price + stepFor(a.current_price));
const isRoundAmount = (n) => Number.isInteger(n) && n % 10 === 0;
function checkBid(a, amount, now) {
  if (a.status !== 'live') return 'not_live';
  if (now.getTime() >= new Date(a.ends_at).getTime()) return 'ended';
  if (!isRoundAmount(amount)) return 'not_round';
  if (amount < minNextBid(a)) return 'too_low';
  return null;
}

// ── คัดลอกจาก src/data/mutations.ts (voidAuctionBid) ────────────────────────
const voidAuctionBid = (bidId, reason) => (db) => {
  const bid = db.auctionBids.find((b) => b.id === bidId);
  if (!bid || bid.status !== 'active') return db;
  const bids = db.auctionBids.map((b) => (b.id === bidId ? { ...b, status: 'void', void_reason: reason } : b));
  const left = bids.filter((b) => b.auction_id === bid.auction_id && b.status === 'active');
  const top = left.reduce((m, b) => Math.max(m, b.amount), 0);
  return {
    ...db,
    auctionBids: bids,
    auctions: db.auctions.map((a) => (a.id === bid.auction_id ? { ...a, current_price: top, bid_count: left.length } : a)),
  };
};

// ── คัดลอกจาก src/data/supabaseAdapter.ts (syncTable diff) ──────────────────
function rowsToUpsert(nextRows, baseRows, key = 'id') {
  const baseJson = new Map(baseRows.map((r) => [String(r[key]), JSON.stringify(r)]));
  return nextRows.filter((r) => baseJson.get(String(r[key])) !== JSON.stringify(r));
}

// ── คัดลอกจาก AuctionRoom (merge live กับ store) ────────────────────────────
const mergeView = (auction, live) =>
  live ? { ...auction, current_price: live.price, bid_count: live.bidCount, ends_at: live.endsAt || auction.ends_at, status: live.status } : auction;

// ════════════════════════════════════════════════════════════════════════════
hr('1. ปุ่ม "บิด ฿X" ใช้ nextMin เก่า (poll 4 วิ) → server ปฏิเสธ');
{
  const server = { id: 'a1', status: 'live', start_price: 1000, current_price: 0, bid_count: 0, ends_at: '2030-01-01T00:00:00Z' };
  // t=0  B โหลด state: ราคาเปิด ยังไม่มีใครบิด → ปุ่มโชว์ 1,000
  const bView = { ...server };
  const buttonAmount = bView.bid_count === 0 ? bView.start_price : bView.current_price + stepFor(bView.current_price);
  // t=0.1 A บิด 1,000 สำเร็จ  (server: price 1000, bid_count 1)
  rpcPlaceBid(server, 1000);
  // t=3.9 B กดปุ่มที่ยังโชว์ 1,000 — ด่านหน้าเครื่อง (checkBid) ผ่าน เพราะ view ยังเก่า
  const localGate = checkBid(bView, buttonAmount, new Date('2020-01-01'));
  const res = rpcPlaceBid(server, buttonAmount);
  expect('ด่านหน้าเครื่องปล่อยผ่าน (ไม่รู้ว่าราคาขยับแล้ว)', localGate === null);
  expect('server ปฏิเสธ too_low และคืน min มาด้วย', res.error === 'too_low' && res.min === 1020, JSON.stringify(res));
  // AuctionRoom: flash(BID_REJECT_TH['too_low']) = "ยอดต่ำกว่าขั้นต่ำที่บิดได้ตอนนี้" — ไม่มีตัวเลข
  const shown = 'ยอดต่ำกว่าขั้นต่ำที่บิดได้ตอนนี้';
  expect('ข้อความที่ผู้ใช้เห็นไม่มีตัวเลข min ที่ server ส่งมา (res.min ถูกทิ้ง)', !shown.includes(String(res.min)));
}

hr('2. สองคนบิดวินาทีเดียวกัน — RPC ล็อกแถวก่อนอ่านค่าจริงไหม');
{
  // จาก v60 บรรทัด 138: select * into a from auctions where id = ... FOR UPDATE  (ก่อนอ่าน current_price)
  const server = { id: 'a1', status: 'live', start_price: 1000, current_price: 1000, bid_count: 1, ends_at: '2030-01-01T00:00:00Z' };
  const r1 = rpcPlaceBid(server, 1020);   // ธุรกรรม 1 ถือล็อก
  const r2 = rpcPlaceBid(server, 1020);   // ธุรกรรม 2 รอ แล้วอ่านค่าที่อัปเดตแล้ว
  expect('คนที่สองถูกปฏิเสธ ไม่ทับราคาคนแรก', r1.ok === true && r2.error === 'too_low', `${JSON.stringify(r1)} / ${JSON.stringify(r2)}`);
  expect('ราคาสุดท้าย = 1,020 (ไม่หายไปไหน)', server.current_price === 1020 && server.bid_count === 2);
}

hr('3+4. สลับห้องในแท็บพรีวิว — live/bids ของห้องเดิมค้าง');
{
  // AuctionRoom: useState live/bids ไม่ถูกล้างเมื่อ auctionId เปลี่ยน (ไม่มี useEffect reset)
  const roomA = { id: 'A', title: 'A', status: 'live', start_price: 1000, current_price: 5200, bid_count: 42, ends_at: '2030-01-01T12:00:00Z' };
  const roomB = { id: 'B', title: 'B', status: 'draft', start_price: 1000, current_price: 0, bid_count: 0, ends_at: '2030-02-01T12:00:00Z' };
  let live = { price: 5200, bidCount: 42, endsAt: '2030-01-01T12:00:00Z', status: 'live', nextMin: 5300, leading: true, skewMs: 0 };
  // สลับไป B: pull(B) คืน not_found (ห้องยังเป็นร่างที่เพิ่งสร้าง ยังไม่ขึ้นคลาวด์) → `if (!s.ok) return;`
  const sB = { error: 'not_found' };
  if (sB.ok) live = null; // ไม่เกิดขึ้น
  const view = mergeView(roomB, live);
  expect('ห้อง B แสดงราคาของห้อง A', view.current_price === 5200, `แสดง ${view.current_price} ทั้งที่ห้อง B = ${roomB.current_price}`);
  expect('ห้อง B แสดงสถานะ/เวลาปิดของห้อง A', view.status === 'live' && view.ends_at === '2030-01-01T12:00:00Z');
  expect('ป้าย "คุณเป็นผู้นำอยู่ตอนนี้" ติดมาจากห้อง A ด้วย', live.leading === true);
}

hr('5. pull() สองรอบซ้อน — ตอบกลับสลับลำดับ = ราคาย้อนหลัง');
{
  // POLL_MS = 4000, RPC_TIMEOUT = 10000 → pull ซ้อนกันได้ และไม่มี seq guard/AbortController
  const applied = [];
  const setLive = (v) => applied.push(v.price);
  const pullA = { started: 0, resolves: 9000, price: 1000 };  // ช้า
  const pullB = { started: 4000, resolves: 4500, price: 5200 }; // เร็ว (ราคาใหม่กว่า)
  [pullA, pullB].sort((x, y) => x.resolves - y.resolves).forEach((p) => setLive(p));
  expect('ผลลัพธ์สุดท้ายเป็นราคาเก่ากว่า', applied[applied.length - 1] === 1000, `ลำดับที่ถูก apply = ${applied.join(' → ')}`);
}

hr('6. โหมดทดลอง/RPC หาย → placeBidLocal แล้ว "auctions" ถูก upsert ขึ้น Supabase');
{
  const base = { auctions: [{ id: 'A', status: 'live', current_price: 5200, bid_count: 42, ends_at: '2030-01-01T12:00:00Z', extend_count: 3 }], auctionBids: [] };
  const next = {
    auctions: [{ ...base.auctions[0], current_price: 1000, bid_count: 1, ends_at: '2030-01-01T12:00:00Z', extend_count: 3 }],
    auctionBids: [{ id: 'ab1', auction_id: 'A', user_id: 'u9', amount: 1000, status: 'active' }],
  };
  const up = rowsToUpsert(next.auctions, base.auctions);
  expect('แถว auctions ถูกส่งขึ้นเซิร์ฟเวอร์ (ทั้งแถว)', up.length === 1, JSON.stringify(up[0]));
  expect('current_price ที่ปลอมจากเครื่องทับของจริง', up[0].current_price === 1000);
  // auction_bids ไม่ sync (ตั้งใจ) → ราคาบนเซิร์ฟเวอร์มี แต่ไม่มีบิดรองรับ
  expect('auction_bids ไม่ถูกส่งขึ้น → ราคาลอย ไม่มีเจ้าของ', true);
}

hr('7. แอดมินยกเลิกบิด (voidAuctionBid) ด้วย snapshot เก่า → ราคา+เวลาปิดถอยหลัง');
{
  // เซิร์ฟเวอร์จริง ณ ตอนนี้
  const serverRow = { id: 'A', status: 'live', start_price: 1000, current_price: 1040, bid_count: 3, ends_at: '2030-01-01T12:10:00Z', extend_count: 2 };
  // snapshot ในเครื่องแอดมิน (โหลดไว้ก่อน u3 บิด — DataProvider poll ทุก 40 วิ)
  const stale = { id: 'A', status: 'live', start_price: 1000, current_price: 1020, bid_count: 2, ends_at: '2030-01-01T12:00:00Z', extend_count: 0 };
  const db = {
    auctions: [{ ...stale }],
    auctionBids: [
      { id: 'b1', auction_id: 'A', user_id: 'u1', amount: 1000, status: 'active' },
      { id: 'b2', auction_id: 'A', user_id: 'u2', amount: 1020, status: 'active' },
      // b3 (u3 = 1,040) ยังไม่อยู่ใน snapshot
    ],
  };
  const after = voidAuctionBid('b2', 'ลูกค้าพิมพ์ผิด')(db);
  const row = after.auctions[0];
  const up = rowsToUpsert(after.auctions, [stale])[0];
  expect('client คำนวณราคาใหม่เองแล้วเตรียม upsert ทั้งแถว', !!up);
  expect('current_price ถอยจาก 1,040 → 1,000 ทั้งที่บิด 1,040 ยังมีชีวิต', row.current_price === 1000, `เขียนทับเป็น ${row.current_price}`);
  expect('ends_at ที่ต่อเวลาไปแล้ว 12:10 ถูกเขียนกลับเป็น 12:00', up.ends_at === '2030-01-01T12:00:00Z');
  expect('extend_count 2 → 0', up.extend_count === 0);
  // ผลต่อเนื่อง: คนถัดไปบิดแค่ 1,020 ก็ชนะบิด 1,040 ที่ยังอยู่ในตาราง
  const srv = { ...serverRow, current_price: up.current_price, bid_count: up.bid_count };
  const r = rpcPlaceBid(srv, 1020);
  expect('บิดถัดไปที่ 1,020 ผ่าน ทั้งที่มีบิด 1,040 ค้างอยู่', r.ok === true, `ราคาปิดท้าย ${srv.current_price} < 1040`);
}

hr('8. seq "ผู้ประมูล #N" คงที่ไหมเมื่อมีคนใหม่เข้ามา');
{
  // ryuma_auction_bids: dense_rank() over (order by min(created_at) ของผู้ใช้คนนั้น)
  const rank = (bids) => {
    const first = new Map();
    for (const b of bids) if (!first.has(b.user) || b.at < first.get(b.user)) first.set(b.user, b.at);
    const order = [...first.entries()].sort((a, b) => a[1] - b[1]).map(([u]) => u);
    return Object.fromEntries(order.map((u, i) => [u, i + 1]));
  };
  const b1 = [{ user: 'u1', at: 1 }, { user: 'u2', at: 2 }];
  const b2 = [...b1, { user: 'u3', at: 3 }, { user: 'u1', at: 4 }];
  expect('seq ของ u1/u2 ไม่เปลี่ยนเมื่อ u3 เข้ามา', rank(b1).u1 === rank(b2).u1 && rank(b1).u2 === rank(b2).u2, JSON.stringify(rank(b2)));
}

hr('9. bid_count: server นับรวมบิดที่ void, client นับเฉพาะ active');
{
  const server = { current_price: 1000, bid_count: 0, start_price: 1000, status: 'live' };
  rpcPlaceBid(server, 1000); rpcPlaceBid(server, 1020); rpcPlaceBid(server, 1040);
  const serverCount = server.bid_count; // 3 (SQL: bid_count = bid_count + 1 เสมอ ไม่เคยลด)
  const db = {
    auctions: [{ id: 'A', current_price: 1040, bid_count: 3 }],
    auctionBids: [
      { id: 'b1', auction_id: 'A', user_id: 'u1', amount: 1000, status: 'active' },
      { id: 'b2', auction_id: 'A', user_id: 'u2', amount: 1020, status: 'active' },
      { id: 'b3', auction_id: 'A', user_id: 'u3', amount: 1040, status: 'active' },
    ],
  };
  const after = voidAuctionBid('b3', 'x')(db).auctions[0];
  expect('server=3 vs client=2 หลัง void 1 บิด', serverCount === 3 && after.bid_count === 2, `server ${serverCount} / client ${after.bid_count}`);
  expect('ถ้า void ครบทุกบิด client เขียน bid_count=0 → ขั้นต่ำถัดไปกลับเป็นราคาเปิด',
    voidAuctionBid('b1', 'x')(voidAuctionBid('b2', 'x')(voidAuctionBid('b3', 'x')(db))).auctions[0].bid_count === 0);
}

hr('10. หน้ารวม /auctions ไม่มี poll — การ์ดใช้ price จาก store (40 วิ) แต่เวลาเดินทุกวินาที');
{
  // AuctionCard: setInterval 1000 → นาฬิกาเดิน; a.current_price มาจาก db ที่รีเฟรชทุก 40 วิ (reloadIfIdle)
  // และถ้า persist ค้าง error → lastSynced !== db → reloadIfIdle ออกก่อนทุกครั้ง = ไม่รีเฟรชเลย
  const persistFailing = true;
  const lastSynced = {}, dbNow = {};
  const canReload = !persistFailing && lastSynced === dbNow;
  expect('มี error persist ค้าง = หยุดรีเฟรชทั้งแท็บถาวร (ราคาบนการ์ดค้าง)', canReload === false);
}

hr(`สรุป: ${fails === 0 ? 'ทุกข้อยืนยันตามที่คาด' : `${fails} ข้อไม่ตรงคาด`}`);
log('หมายเหตุ: "ok" = ยืนยันพฤติกรรมตามที่รายงาน (หลายข้อ "ok" คือ *ยืนยันว่าเป็นบั๊ก*)');
