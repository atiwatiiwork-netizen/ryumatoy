/** ตรวจ "คูปองแต้ม" (rework 2026-09-12 ค่ำ: คูปอง / Event / ภารกิจ ให้เป็นแต้มแทนส่วนลดตรง) — รัน: npm run audit:points */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.TZ = 'Asia/Bangkok';
import { SEED_DATABASE } from '../../src/data/seed';
import { createCoupon, grantCoupon, grantCouponToRank, revokeGrant, deleteCoupon, grantCampaignRewards, approveMission, submitMission, setMissionConfig, submitRemainingPayment, rejectRemainingPayment } from '../../src/data/mutations';
import { balanceOf, lifetimeOf, couponRewardId, redeemHoldId } from '../../src/domain/services/points';
import { usableGrantsFor, instockCouponsFor, preorderCouponsForTicket, isPointsCoupon, couponAlreadyGranted, orphanUsedGrants, scopeAllows } from '../../src/domain/services/coupons';
import { unclaimedAwards, nextTierProgress } from '../../src/domain/services/campaigns';
import type { Database, Order, PreorderTicket } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail ?? ''); } };

const base: Database = structuredClone(SEED_DATABASE);
const U = 'u-me', U2 = 'u-audit-cp';
const seedPts = base.coupons.find((c) => c.scope === 'points')!;
const bahtCoupon = base.coupons.find((c) => c.scope === 'both')!;
base.users.push({ id: U2, display_name: 'Audit CP', rank: 'bronze', created_at: '2026-01-01' } as any);

// ── A) มอบคูปองแต้ม → แต้มเข้าทันที · grant = ใบเสร็จ (used) · ไม่โผล่ในคูปองใช้ได้ ────────
{
  let db = structuredClone(base);
  ok('A0 seed มีคูปองแต้ม (scope points) และ isPointsCoupon จับได้', !!seedPts && isPointsCoupon(seedPts) && !isPointsCoupon(bahtCoupon));
  const before = balanceOf(db, U);
  db = grantCoupon(seedPts.id, [U], 'u-admin')(db);
  const g = db.couponGrants.find((x) => x.coupon_id === seedPts.id && x.user_id === U)!;
  ok('A1 มอบแล้ว: grant used ทันที + discount_amount = แต้ม', !!g && g.status === 'used' && !!g.used_at && g.discount_amount === seedPts.value, g);
  const row = db.pointLedger.find((e) => e.id === couponRewardId(g.id))!;
  ok('A2 แถวแต้ม pl-coupon-<grant> kind coupon_reward +100 ผูก grant', !!row && row.kind === 'coupon_reward' && row.delta === seedPts.value && row.ref_type === 'coupon_grant' && row.ref_id === g.id && row.created_by === 'u-admin', row);
  ok('A3 คงเหลือ +100 · ยอดสะสม (lifetime) นับด้วย', balanceOf(db, U) === before + seedPts.value && lifetimeOf(db, U) >= seedPts.value);
  ok('A4 ไม่โผล่ใน usableGrantsFor / in-stock / pre-order pickers', usableGrantsFor(db, U).every((x) => x.grant.id !== g.id) && instockCouponsFor(db, U, db.products.map((p) => p.id)).every((x) => x.grant.id !== g.id) && preorderCouponsForTicket(db, U, db.products[0]).every((x) => x.grant.id !== g.id));
  ok('A5 scopeAllows(points) = false ทั้งสองทาง', !scopeAllows('points', true) && !scopeAllows('points', false));
  ok('A6 ไม่ถูกนับเป็น orphan (ไม่มี order/ticket)', orphanUsedGrants(db, U).every((o) => o.grant.id !== g.id));
  // มอบซ้ำ → ข้าม (ได้รับแล้ว)
  const n = db.pointLedger.length, ng = db.couponGrants.length;
  db = grantCoupon(seedPts.id, [U], 'u-admin')(db);
  ok('A7 มอบซ้ำคนเดิม → ข้าม (couponAlreadyGranted) ไม่ให้แต้มซ้ำ', db.pointLedger.length === n && db.couponGrants.length === ng && couponAlreadyGranted(db, seedPts.id, U));
  // มอบซ้ำในลิสต์เดียว (uid ซ้ำ) → ครั้งเดียว
  let d2 = structuredClone(base);
  d2 = grantCoupon(seedPts.id, [U2, U2], 'u-admin')(d2);
  ok('A8 uid ซ้ำในลิสต์เดียว → ให้ครั้งเดียว', d2.couponGrants.filter((x) => x.coupon_id === seedPts.id && x.user_id === U2).length === 1 && balanceOf(d2, U2) === seedPts.value);
  // revoke ไม่มีผลกับ grant used
  const bal = balanceOf(db, U);
  db = revokeGrant(g.id)(db);
  ok('A9 revokeGrant ไม่แตะใบเสร็จแต้ม (used) · แต้มยังอยู่', db.couponGrants.find((x) => x.id === g.id)?.status === 'used' && balanceOf(db, U) === bal);
  // ลบคูปอง → grant หาย แต่แถวแต้มยังอยู่ (เงินให้ไปแล้ว)
  db = deleteCoupon(seedPts.id)(db);
  ok('A10 ลบคูปองแต้ม: grant หาย · แถวแต้มยังอยู่ คงเหลือเท่าเดิม', !db.couponGrants.some((x) => x.coupon_id === seedPts.id) && db.pointLedger.some((e) => e.id === couponRewardId(g.id)) && balanceOf(db, U) === bal);
  // มอบทั้ง rank
  let d3 = structuredClone(base);
  const rankUsers = d3.users.filter((u) => !u.is_admin && u.id !== 'u-admin' && u.rank === 'bronze').map((u) => u.id);
  d3 = grantCouponToRank(seedPts.id, 'bronze', 'u-admin')(d3);
  ok('A11 มอบทั้ง rank → ทุกคนใน rank ได้แต้ม (คนละแถว)', rankUsers.length > 0 && rankUsers.every((uid) => balanceOf(d3, uid) >= seedPts.value && d3.pointLedger.some((e) => e.kind === 'coupon_reward' && e.user_id === uid)), rankUsers);
}

// ── B) คูปองบาท (แบบเก่า) ยังทำงานเหมือนเดิม ─────────────────────────────────────
{
  let db = structuredClone(base);
  db = grantCoupon(bahtCoupon.id, [U], 'u-admin')(db);
  const g = db.couponGrants.find((x) => x.coupon_id === bahtCoupon.id && x.user_id === U)!;
  ok('B1 คูปองบาท: grant active · ไม่มีแถวแต้ม · โผล่ใน usable', g?.status === 'active' && !db.pointLedger.some((e) => e.ref_id === g.id) && usableGrantsFor(db, U).some((x) => x.grant.id === g.id));
  const n = db.couponGrants.length;
  db = grantCoupon(bahtCoupon.id, [U], 'u-admin')(db);
  ok('B2 ถือ active อยู่ → มอบซ้ำข้าม', db.couponGrants.length === n);
  db = revokeGrant(g.id)(db);
  db = grantCoupon(bahtCoupon.id, [U], 'u-admin')(db);
  ok('B3 ถอนแล้วมอบใหม่ได้ (แบบเก่า)', db.couponGrants.filter((x) => x.coupon_id === bahtCoupon.id && x.user_id === U && x.status === 'active').length === 1);
}

// ── C) Event แบบแต้ม: พรีครบชั้น → 1 รางวัล = แต้ม × จำนวน แถวเดียว · idempotent ─────────
{
  let db = structuredClone(base);
  const c = db.campaigns.find((x) => x.id === 'ev-1')!;
  ok('C0 seed Event เป็นแบบแต้ม', c.reward_scope === 'points');
  // สร้างใบพรี 5 ใบในช่วงกิจกรรม (อนุมัติแล้ว) ให้ U2
  const when = new Date(c.starts_at + 'T10:00:00').toISOString();
  for (let i = 0; i < 5; i++) {
    const oid = `o-cp${i}`, iid = `oi-cp${i}`;
    db.orders.push({ id: oid, user_id: U2, total_deposit: 300, slip_url: '', status: 'approved', created_at: when, approved_at: when,
      items: [{ id: iid, order_id: oid, product_id: db.products[0].id, qty: 1, deposit_amount: 300, unit_price: 1600, unit_deposit: 300 }] } as Order);
    db.tickets.push({ id: `t-${iid}`, ticket_no: `CP-${i}`, product_id: db.products[0].id, owner_id: U2, original_buyer_id: U2, qty: 1, deposit_paid: 300, remaining_amount: 1300, remaining_paid: 0,
      status: 'active', product_status: 'production', qr_code_url: '', created_at: when, approved_at: when } as PreorderTicket);
  }
  const pendingBefore = unclaimedAwards(db, c, U2, new Date(when));
  ok('C1 ครบ 5 → มีรางวัลค้าง 1 ชั้น', pendingBefore.length === 1 && pendingBefore[0].tier.threshold === 5, pendingBefore);
  const np = nextTierProgress(db, c, U2, new Date(when));
  ok('C2 nextTierProgress มี total = แต้ม×จำนวน (ชั้นถัดไป 10: 200×2 = 400)', np?.nextRequired === 10 && np.total === 400 && np.value === 200, np);
  const bal0 = balanceOf(db, U2);
  db = grantCampaignRewards(c.id, U2, 'u-admin')(db);
  const award = db.campaignAwards.find((a) => a.campaign_id === c.id && a.user_id === U2)!;
  const coupon = db.coupons.find((x) => x.id === award?.coupon_id)!;
  const grant = db.couponGrants.find((x) => x.coupon_id === coupon?.id)!;
  ok('C3 รางวัล = คูปองแต้ม 100 (100×1) · grant used · แถวแต้ม +100 · campaign_id ผูก', !!award && coupon?.scope === 'points' && coupon.value === 100 && coupon.campaign_id === c.id && grant?.status === 'used' && db.pointLedger.some((e) => e.id === couponRewardId(grant.id) && e.delta === 100), { award, coupon, grant });
  ok('C4 คงเหลือ +100', balanceOf(db, U2) === bal0 + 100);
  const n = db.pointLedger.length;
  db = grantCampaignRewards(c.id, U2, 'u-admin')(db);
  ok('C5 ให้ซ้ำไม่ได้ (award มีแล้ว)', db.pointLedger.length === n && db.campaignAwards.filter((a) => a.campaign_id === c.id && a.user_id === U2).length === 1);
  // Event แบบคูปองบาท (legacy) ยังแจกเป็นคูปอง active
  let d2 = structuredClone(db);
  d2.campaigns = d2.campaigns.map((x) => (x.id === c.id ? { ...x, reward_scope: 'both' as const, id: 'ev-legacy' } : x));
  d2.campaignAwards = [];
  d2 = grantCampaignRewards('ev-legacy', U2, 'u-admin')(d2);
  const lg = d2.couponGrants.filter((x) => x.user_id === U2 && x.status === 'active');
  ok('C6 Event แบบคูปองบาท: grant active 1 ใบ ไม่มีแถวแต้มเพิ่ม', lg.length === 1 && d2.pointLedger.length === db.pointLedger.length, lg.length);
}

// ── D) ภารกิจ: approveMission → คูปองแต้ม → แต้มเข้า · อนุมัติซ้ำไม่ให้ซ้ำ ────────────────
{
  let db = structuredClone(base);
  db = createCoupon({ label: 'Event ภารกิจ · 100 แต้ม', value: 100, scope: 'points' })(db);
  const rc = db.coupons[0];
  db = setMissionConfig({ title: 'ภารกิจ', starts_at: '2026-01-01', ends_at: '2099-12-31', reward_coupon_id: rc.id, active: true })(db);
  db = submitMission(U2, 'https://x/proof.jpg')(db);
  const sub = db.missionSubmissions.find((s) => s.user_id === U2)!;
  const bal0 = balanceOf(db, U2);
  db = approveMission(sub.id)(db);
  ok('D1 อนุมัติภารกิจ → แต้ม +100 · grant used', balanceOf(db, U2) === bal0 + 100 && db.couponGrants.some((g) => g.coupon_id === rc.id && g.user_id === U2 && g.status === 'used'));
  const n = db.pointLedger.length;
  db = approveMission(sub.id)(db);
  ok('D2 อนุมัติซ้ำ → ไม่ให้ซ้ำ', db.pointLedger.length === n && balanceOf(db, U2) === bal0 + 100);
}

// ── E) แต้มจากคูปองใช้ตัดยอดได้เหมือนแต้มอื่น (เมื่อเปิดสวิตช์) · ปิดสวิตช์ = แค่สะสม ─────
{
  const db = structuredClone(base);
  db.settings.points_enabled = true;
  const withPts = grantCoupon(seedPts.id, [U], 'u-admin')(db);
  const t = withPts.tickets.find((x) => x.owner_id === U && x.remaining_amount - x.remaining_paid > 0 && x.status === 'active')!;
  const due = t.remaining_amount - t.remaining_paid;
  const off = submitRemainingPayment(t.id, U, due, 'slip', undefined, { points: 100 })(withPts);
  const rpOff = off.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending')!;
  ok('E1 สวิตช์ใช้แต้มปิด: ขอใช้ 100 → 0 (แต้มจากคูปองยังอยู่ครบ)', (rpOff.points_redeemed ?? 0) === 0 && balanceOf(off, U) >= 100);
  const enabled: Database = { ...withPts, appConfig: [{ key: 'points_redeem', value: { enabled: true } }, ...withPts.appConfig] };
  const on = submitRemainingPayment(t.id, U, due - 100, 'slip', undefined, { points: 100 })(enabled);
  const rpOn = on.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending')!;
  ok('E2 สวิตช์เปิด: ใช้แต้มจากคูปอง 100 ตัดยอดได้ (จอง pl-redeem)', rpOn.points_redeemed === 100 && on.pointLedger.some((e) => e.id === redeemHoldId(rpOn.id)));
}

// ── F) คืนคูปองตอนปฏิเสธ ต้องล้างค่าเป็น null (undefined ถูกตัดทิ้งตอนส่ง JSON → DB เก็บค่าเก่า) — audit 2026-09-23 ──
{
  let db = structuredClone(base);
  db = grantCoupon(bahtCoupon.id, [U], 'u-admin')(db);
  const g = db.couponGrants.find((x) => x.coupon_id === bahtCoupon.id && x.user_id === U)!;
  const t = db.tickets.find((x) => x.owner_id === U && x.remaining_amount - x.remaining_paid > 0 && x.status === 'active')!;
  const due = t.remaining_amount - t.remaining_paid;
  db = submitRemainingPayment(t.id, U, due - 100, 'slip', { grantId: g.id, discount: 100 })(db);
  const rp = db.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending')!;
  db = rejectRemainingPayment(rp.id)(db);
  const g2 = db.couponGrants.find((x) => x.id === g.id)!;
  ok('F1 ปฏิเสธสลิป → คูปองกลับ active และ ticket_id/used_at/discount เป็น null (ส่งถึง DB จริง)', g2.status === 'active' && g2.ticket_id === null && g2.used_at === null && g2.discount_amount === null && JSON.stringify(g2).includes('"ticket_id":null'), g2);
  // คูปองที่ถูกคืนแล้วเอาไปใช้ใบใหม่ แต่ order_id เก่าค้าง → ต้องไม่ถูกตีเป็น "ใช้ไม่สมบูรณ์"
  const stale = { ...db, couponGrants: db.couponGrants.map((x) => (x.id === g.id ? { ...x, order_id: 'o-ghost' } : x)) };
  const again = submitRemainingPayment(t.id, U, due - 100, 'slip', { grantId: g.id, discount: 100 })(stale);
  ok('F2 grant ใช้อยู่กับสลิปจริง แม้ order_id เก่าค้าง → ไม่ใช่ orphan', !orphanUsedGrants(again, U).some((o) => o.grant.id === g.id));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
