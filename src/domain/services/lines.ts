import type { Database, LineMember, Product, ProductBatch, ProductLine } from '../entities';
import { inClosedBoard, inLiveAuction, isStockTwin, preorderOpenForOrder, productNameKey, variantsOf } from './catalog';
import { availableFor, batchAvailable, myPendingHold, pendingHeld, userBatchQuota } from './reservations';
import { isAdminUser } from './admins';
import { hasPreorderTicket, specialGateEnabled } from './tickets';

/**
 * ไลน์ (พรียกไลน์ · v81 · memory ryuma-line-spec) — ตัวจำแนกเดียวของป้ายสถานะบนรูปหมู่
 *
 * หลัก: **ไม่เก็บสถานะ** — ทุกป้ายคำนวณสดจากสินค้า/สต๊อก/รอบพิเศษ/ตั๋วใน db ทุกครั้งที่หน้าวาด
 *   แอดมินปิดรอบ/รับของ/แปลงเป็นสต๊อก/ขายหมด ที่หน้าไหนก็ตาม ป้ายบนรูปเปลี่ยนตามเอง (แท็บแอดมินทันที ·
 *   ลูกค้าตามรอบรีเฟรช 40 วิ/โฟกัสของ DataProvider) · ข้อยกเว้นเดียว: manual_state ของตัวที่ยังไม่ผูกสินค้า
 *
 * ⚠ สต๊อกฝั่งลูกค้าต้องใช้เลขจาก server (ctx.live = useLiveStockMap) — RLS ให้ลูกค้าเห็นแค่ตั๋วตัวเอง
 *   สูตร local จึงนับ "ขายแล้ว" ไม่ครบ (audit 2026-07-30) · สูตรรวมเหมือน ProductCard/BatchCard: min(local, live + hold ตัวเอง)
 */

/** สวิตช์ใหญ่ฝั่งลูกค้า (app_config 'lines_public') — ไม่มีแถว = ปิด (เจ้าของ 2026-10-07: "ให้แอดมินลองดูก่อน")
 *  ⚠ ด่านจริงอยู่ฝั่ง server (RLS product_lines_read + ryuma_lines_open ใน v81) ตัวนี้แค่ซ่อน/โชว์หน้าจอ */
export const LINES_PUBLIC_KEY = 'lines_public';
export function linesPublicEnabled(db: Database): boolean {
  const row = db.appConfig.find((c) => c.key === LINES_PUBLIC_KEY);
  return (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
}
/** ลูกค้าเห็นไลน์นี้ได้ไหม — กติกาเดียวของทุกทางเข้า (แถบช็อป · ชิป "ดูทั้งไลน์" · หน้า /line · เติมฟอร์มหาของ):
 *  สวิตช์ใหญ่เปิด + ไม่ใช่ร่าง + มีรูปหมู่ + มีตัวที่ลูกค้าเห็นได้อย่างน้อย 1 ตัว
 *  (review 2026-10-07: เดิมเช็ครูปปกแค่ในแถบช็อป → ลบรูปแล้วไลน์ยังโผล่ทางชิปหน้าสินค้า/ลิงก์ตรง) */
export function lineOpenToCustomers(db: Database, line: ProductLine): boolean {
  return linesPublicEnabled(db) && line.active === true && !!line.cover_url
    && line.members.some((m) => lineMemberState(db, line, m, { uid: '' }).visible);
}
/** ใครเห็นไลน์นี้: แอดมินเห็นทุกไลน์ (รวมร่าง) · ลูกค้า = lineOpenToCustomers */
export function lineVisibleTo(db: Database, uid: string, line: ProductLine): boolean {
  return isAdminUser(db, uid) || lineOpenToCustomers(db, line);
}

// ── สินค้าของสมาชิก ─────────────────────────────────────────────────────────────

/** สินค้าที่ผูก (id ที่ถูกลบไปแล้วข้ามเอง) + "ของในมือ" ชื่อเดียวกัน (isStockTwin) ของสินค้าที่ผูก
 *  — ตอนแปลงพรีเป็นสต๊อก ของอาจถูกรวมเข้า SKU พร้อมส่งตัวเดิม (ไม่ใช่ใบพรีที่ผูกไว้) ถ้าไม่ตามไปดู
 *    ตัวในไลน์จะขึ้น "หาของ" ทั้งที่หน้าร้านมีของขายอยู่
 *  — ผูก SKU พร้อมส่งไว้ก็ต้องตามด้วย: ฟอร์มเพิ่มสินค้าทีละตัวสร้าง SKU พร้อมส่งชื่อซ้ำได้ (ไม่รวมสต๊อก)
 *    ตัวเก่าหมด ตัวใหม่ยังขายอยู่ → ไลน์ต้องเห็นตัวใหม่ (review 2026-10-07) */
export function memberProducts(db: Database, m: LineMember): { linked: Product[]; twins: Product[]; all: Product[] } {
  const seen = new Set<string>();
  const linked: Product[] = [];
  for (const id of m.product_ids ?? []) {
    if (seen.has(id)) continue;
    const p = db.products.find((x) => x.id === id);
    if (p) { linked.push(p); seen.add(id); }
  }
  const twins = db.products.filter((x) => !seen.has(x.id) && linked.some((p) => isStockTwin(x, p)));
  return { linked, twins, all: [...linked, ...twins] };
}

/** รูปย่อของสมาชิก: รูปที่แอดมินใส่ → รูปสินค้าที่ผูกตัวแรก */
export function memberThumb(db: Database, m: LineMember): string | undefined {
  if (m.image_url) return m.image_url;
  for (const p of memberProducts(db, m).linked) {
    const img = p.images?.[0] ?? db.variants.find((v) => v.product_id === p.id && v.image_url)?.image_url;
    if (img) return img;
  }
  return undefined;
}

/** ราคาที่โชว์ (ไม่มีส่วนลดยศ — เหมือนการ์ดหน้าร้าน) · มี variants ราคาไม่เท่ากัน = "เริ่ม" */
function priceOf(db: Database, p: Product): { price: number; from: boolean } {
  const vs = p.has_variants ? variantsOf(db, p.id).map((v) => v.price_total) : [];
  if (vs.length === 0) return { price: p.price_total, from: false };
  return { price: Math.min(...vs), from: Math.min(...vs) !== Math.max(...vs) };
}

const openBatchesOf = (db: Database, productId: string): ProductBatch[] =>
  db.batches.filter((b) => b.product_id === productId && b.status === 'open' && b.published !== false);

// ── สถานะสมาชิก ───────────────────────────────────────────────────────────────

export type LineTone = 'green' | 'blue' | 'purple' | 'amber' | 'gray';
export type LineKind =
  | 'stock'           // ของในมือ พร้อมส่ง (มีของ)
  | 'special'         // รอบพิเศษเปิดขาย (มีของ) — จ่ายเต็ม = พร้อมส่ง · มัดจำ = พรีรอบพิเศษ
  | 'preorder'        // กระดานหลักเปิดรับพรี
  | 'auction'         // อยู่ในห้องประมูล (หน้าร้านซ่อน — ห้ามขายซ้อน)
  | 'soldout_temp'    // หมดชั่วคราว (มีคนกำลังจ่าย/สลิปรอตรวจ อาจหลุดกลับมา)
  | 'closed'          // ปิดพรีแล้ว (รอสั่งผลิต / ผลิต / เดินทาง)
  | 'out'             // ของออกแล้ว ร้านไม่มีของ → หาของ
  | 'manual_preorder' // แอดมิน Add เอง: ค่ายเปิดพรี ยังไม่ลงระบบ → ทักร้าน
  | 'manual_stock'    // แอดมิน Add เอง: มีของ ยังไม่ลงระบบ → ทักร้าน
  | 'manual_sourcing' // แอดมิน Add เอง: ของออกแล้ว → หาของ
  | 'hidden';         // ไม่มีสินค้า + ไม่ได้ตั้งสถานะ → ลูกค้าไม่เห็น (แอดมินเห็นเป็นสีเทา)

export interface LineCta { label: string; href: string; external?: boolean }
export interface LineMemberState {
  kind: LineKind;
  tone: LineTone;
  label: string;      // ป้ายสั้นบนรูป (1–2 คำ)
  pinLabel: string;   // ป้ายบนรูปจริง (ของคุณ + ปิดพรี = "พรีแล้ว ✓")
  pinShort: string;   // คำย่อของ pinLabel ใช้เมื่อแถวเดียวไม่พอ ("Pre-Order" → "PRE") — คำที่สั้นอยู่แล้วใช้คำเดิม
  detail: string;     // บรรทัดรองในรายการใต้รูป
  cta?: LineCta;
  product?: Product;  // สินค้าที่ใช้ตัดสิน
  batch?: ProductBatch;
  /** อีกทางที่สั่งได้ของตัวเดียวกัน (review ลูกค้า 2026-10-16) — แถวโชว์ลิงก์เล็กใต้บรรทัดรอง */
  alt?: { label: string; href: string };
  /** เงื่อนไข/หมายเหตุบรรทัดแยกใต้แถว (detail ถูกตัด … บนจอ 375px — ข้อความสำคัญต้องไม่หาย) */
  note?: string;
  mine: boolean;      // ผู้ใช้คนนี้มีตั๋วของตัวนี้แล้ว (owner_id ตรง — หน้าพรีวิวแอดมินเห็นตั๋วทั้งร้าน ต้องกรองเสมอ)
  visible: boolean;   // ลูกค้าเห็นตัวนี้ไหม
}
export interface LineCtx {
  uid: string;
  /** เลขของเหลือจริงจาก server (useLiveStockMap) — ไม่มี = ใช้สูตร local (แอดมิน/พรีวิว/ออฟไลน์) */
  live?: (productId: string, batchId?: string) => number | undefined;
  lineOa?: string;
}

const baht = (n: number) => `฿${Math.round(n).toLocaleString('en-US')}`;
/** คำย่อของป้าย — ใช้เมื่อคำเต็มไม่พอแถวเดียวบนมือถือ (เจ้าของ 2026-10-08: มือถือต้องแถวเดียว) */
export const PIN_SHORT: Record<string, string> = { 'Pre-Order': 'PRE', 'ปิดพรีแล้ว': 'ปิดพรี', 'พรีแล้ว ✓': 'พรีแล้ว', 'ซื้อแล้ว ✓': 'ซื้อแล้ว', 'หมดชั่วคราว': 'หมดชั่วคราว' };
export const sourcingHref = (line: ProductLine, m: LineMember, product?: Product) =>
  `/sourcing?line=${encodeURIComponent(line.id)}&m=${encodeURIComponent(m.id)}${product ? `&src=${encodeURIComponent(product.id)}` : ''}`;
const lineOaCta = (lineOa?: string): LineCta | undefined =>
  lineOa ? { label: 'ทักร้าน', href: `https://line.me/R/ti/p/${encodeURIComponent(lineOa)}`, external: true } : undefined;

/**
 * ป้ายของสมาชิกหนึ่งตัว — เช็คตามลำดับ หยุดที่ข้อแรกที่จริง:
 *  1 ของในมือมีของ → พร้อมส่ง · 2 รอบพิเศษมีของ · 3 กระดานหลักเปิดพรี · 4 ติดประมูล · 5 หมดชั่วคราว ·
 *  6 ปิดพรีแล้ว (เดินทาง > ผลิต > รอสั่งผลิต) · 7 ของออกแล้ว ไม่มีของ → หาของ · ไม่มีสินค้า → manual_state / ซ่อน
 * ⚠ ข้อ 1 ต้องมาก่อนข้อ 3 เสมอ: พรีที่แปลงเป็นสต๊อกได้ status 'open' + is_stock (ไม่งั้นโชว์ "พรีเลย" บนของพร้อมส่ง)
 */
export function lineMemberState(db: Database, line: ProductLine, m: LineMember, ctx: LineCtx): LineMemberState {
  const { all } = memberProducts(db, m);
  const ids = new Set(all.map((p) => p.id));
  // "ของฉันแล้ว" = มีตั๋ว หรือมีออเดอร์ที่ส่งสลิปแล้วรอแอดมินตรวจ (ยังไม่มีตั๋ว) — เจ้าของ 2026-10-08: ต้องเตือนว่าพรีไปแล้ว กันสั่งซ้ำ
  //   "พรี" หรือ "ซื้อ" ตัดสินจากตั๋ว/ออเดอร์ของคนดูเอง ไม่ใช่จากสถานะตอนนี้ของตัวนั้น (review ลูกค้ารอบ 2 2026-10-16:
  //   เดิมพรีไว้แล้วมีของพร้อมส่งเข้ามา → ขึ้น "ซื้อแล้ว ✓" · ซื้อพร้อมส่งแล้วของหมด → ขึ้น "พรีแล้ว ✓")
  //   ซื้อ = จ่ายเต็ม (SKU พร้อมส่งที่ไม่มียอดค้าง / รอบจ่ายเต็ม) · ใบพรีที่แปลงเป็นสต๊อกทีหลังยังมียอดค้าง = ยังเป็น "พรี"
  const fullPayBatch = (bid?: string) => { const b = bid ? db.batches.find((x) => x.id === bid) : undefined; return !!b && b.deposit_amount >= b.price_total; };
  let ownPre = false, ownBuy = false, pendingMine = false;
  if (ctx.uid) {
    for (const t of db.tickets) {
      if (t.owner_id !== ctx.uid || t.status === 'transferred' || !ids.has(t.product_id)) continue;
      const stockP = !!db.products.find((p) => p.id === t.product_id)?.is_stock;
      if (fullPayBatch(t.batch_id) || (stockP && (t.remaining_amount ?? 0) === 0)) ownBuy = true; else ownPre = true;
    }
    for (const o of db.orders) {
      if (o.user_id !== ctx.uid || o.status !== 'pending_approval') continue;
      for (const i of o.items) {
        if (!ids.has(i.product_id)) continue;
        pendingMine = true;
        if (fullPayBatch(i.batch_id) || !!db.products.find((p) => p.id === i.product_id)?.is_stock) ownBuy = true; else ownPre = true;
      }
    }
  }
  const mine = ownPre || ownBuy;
  const mineLabel = ownPre ? 'พรีแล้ว ✓' : 'ซื้อแล้ว ✓';
  const make = (s: Omit<LineMemberState, 'mine' | 'pinLabel' | 'pinShort' | 'visible'> & { visible?: boolean }): LineMemberState => {
    // ของฉันแล้ว → ป้ายบนรูปบอก "พรีแล้ว ✓" / "ซื้อแล้ว ✓" ทุกสถานะ (กันสั่งซ้ำ · เจ้าของ 2026-10-08)
    const pinLabel = mine ? mineLabel : s.label;
    return { ...s, mine, visible: s.visible ?? true, pinLabel, pinShort: PIN_SHORT[pinLabel] ?? pinLabel };
  };

  // ── ยังไม่มีสินค้าในระบบ (หรือสินค้าที่ผูกถูกลบหมด) → สถานะที่แอดมินตั้งเอง ──
  if (all.length === 0) {
    switch (m.manual_state) {
      case 'preorder': return make({ kind: 'manual_preorder', tone: 'blue', label: 'Pre-Order', detail: 'ค่ายเปิดพรีแล้ว · สั่งผ่านร้าน', cta: lineOaCta(ctx.lineOa) });
      case 'stock': return make({ kind: 'manual_stock', tone: 'green', label: 'มีของ', detail: 'ร้านมีของ · สั่งผ่านร้าน', cta: lineOaCta(ctx.lineOa) });
      case 'sourcing': {
        // ไม่มี SKU ให้เทียบ → เทียบชื่อตัวละคร + ค่าย ของคำขอที่ยังไม่จบ (review ลูกค้ารอบ 2)
        const k = productNameKey(m.name);
        const askedManual = !!ctx.uid && !!k && db.sourcingRequests.some((r) => r.user_id === ctx.uid && r.maker_id === line.maker_id && productNameKey(r.character_name ?? '') === k && ['requested', 'quoted', 'paid', 'working'].includes(r.status));
        return askedManual
          ? make({ kind: 'manual_sourcing', tone: 'amber', label: 'หาของ', detail: 'ส่งคำขอหาของแล้ว · รอร้านตอบ', cta: { label: 'ดูคำขอ', href: '/sourcing' } })
          : make({ kind: 'manual_sourcing', tone: 'amber', label: 'หาของ', detail: 'ของออกแล้ว · ส่งเรื่องให้ร้านหาให้', cta: { label: 'หาของให้', href: sourcingHref(line, m) } });
      }
      default: return make({ kind: 'hidden', tone: 'gray', label: 'ยังไม่ตั้งสถานะ', detail: 'ยังไม่ผูกสินค้า + ไม่ได้ตั้งสถานะ — ลูกค้าไม่เห็นตัวนี้', visible: false });
    }
  }

  const stockLeft = (p: Product) => {
    const local = availableFor(db, p);
    const lv = ctx.live?.(p.id);
    return lv == null ? local : Math.min(local, lv + myPendingHold(db, ctx.uid, p.id));
  };
  const batchLeft = (b: ProductBatch) => {
    const local = batchAvailable(db, b);
    const lv = ctx.live?.(b.product_id, b.id);
    return lv == null ? local : Math.min(local, lv + myPendingHold(db, ctx.uid, b.product_id, b.id));
  };
  const sellable = all.filter((p) => !inLiveAuction(db, p.id));

  // ทางที่สั่งได้ตอนนี้ เรียงตามลำดับ: 1 ของในมือ > 2 กระดานหลักเปิดพรี > 3 รอบพิเศษ
  //   (เดิมรอบพิเศษมาก่อนกระดานหลัก — สวนกับหน้าสินค้าที่ขึ้นกระดานหลักก่อน · review ลูกค้า 2026-10-16)
  //   ทางแรก = ป้าย/ปุ่มหลัก · ทางที่ 2 (ถ้ามี) = ลิงก์ "อีกทาง" ใต้แถว ไม่ให้หายเพราะสินค้าถูกยุบออกจากช็อป
  type Opt = Omit<LineMemberState, 'mine' | 'pinLabel' | 'pinShort' | 'visible'> & { altLabel: string };
  const opts: Opt[] = [];
  const stockP = sellable.find((p) => p.is_stock && stockLeft(p) > 0);
  if (stockP) {
    const { price, from } = priceOf(db, stockP);
    const hand2 = stockP.stock_cond?.hand === 2 ? ' · มือ 2' : '';
    opts.push({ kind: 'stock', tone: 'green', label: 'พร้อมส่ง', detail: `${from ? 'เริ่ม ' : ''}${baht(price)} · พร้อมส่ง${hand2}`, cta: { label: 'ซื้อเลย', href: `/shop/${stockP.id}` }, product: stockP, altLabel: `หรือซื้อพร้อมส่ง ${baht(price)}` });
  }
  // กระดานหลัก (ไม่อยู่ในกระดานที่ปิดแล้ว · ไม่ติดประมูล) — ด่านเดียวกับหน้าสินค้า/ตะกร้า/submitOrder
  const preP = sellable.find((p) => preorderOpenForOrder(db, p));
  if (preP) {
    const { price, from } = priceOf(db, preP);
    opts.push({ kind: 'preorder', tone: 'blue', label: 'Pre-Order', detail: `${from ? 'เริ่ม ' : ''}${baht(price)} · Pre-Order`, cta: { label: 'พรีเลย', href: `/shop/${preP.id}` }, product: preP, altLabel: `หรือ Pre-Order ${from ? 'เริ่ม ' : ''}${baht(price)}` });
  }
  // รอบพิเศษเปิดขาย (published) ยังมีของ
  //   ด่านรอบพิเศษ (ต้องเคยพรี หรือมีพรีกระดานหลักพ่วงในตะกร้า) — คนที่ยังไม่ผ่านด่าน ห้ามเห็นปุ่ม "พรีเลย" กระพริบแล้วไปเจอหน้าล็อก
  //   บอกเงื่อนไขในแถวแทน · uid ว่าง (การ์ด/พรีวิวแอดมิน/ยังไม่ล็อกอิน) = ไม่ตัดสิน (เส้นทางลูกค้า 2026-10-16)
  const specLocked = !!ctx.uid && specialGateEnabled(db) && !hasPreorderTicket(db, ctx.uid);
  let specOpt: Opt | undefined;
  for (const p of sellable) {
    for (const b of openBatchesOf(db, p.id)) {
      if (specOpt || batchLeft(b) <= 0) continue;
      const fullPay = b.deposit_amount >= b.price_total;
      const href = `/shop/${p.id}?batch=${b.id}`;
      // ครบโควตาต่อคนของรอบนี้แล้ว (หน้าสินค้าปิดปุ่ม "ครบโควตา") → ไม่ชวน "พรีเลย" ที่กดแล้วไปเจอปุ่มปิด (review ลูกค้ารอบ 2)
      if (ctx.uid && userBatchQuota(db, ctx.uid, b.id) <= 0) {
        specOpt = { kind: 'special', tone: fullPay ? 'green' : 'blue', label: fullPay ? 'พร้อมส่ง' : 'Pre-Order', detail: `${baht(b.price_total)} · ${b.label || 'รอบพิเศษ'}`, note: 'ครบโควตาต่อคนของรอบนี้แล้ว', cta: { label: 'ดูรายละเอียด', href }, product: p, batch: b, altLabel: `หรือ${b.label || 'รอบพิเศษ'} ${baht(b.price_total)}` };
        continue;
      }
      const lockNote = specLocked ? 'เฉพาะคนที่เคยพรี (หรือพรีตัวอื่นพ่วงในตะกร้า)' : undefined;
      specOpt = fullPay
        ? { kind: 'special', tone: 'green', label: 'พร้อมส่ง', detail: `${baht(b.price_total)} · ${b.label || 'รอบพิเศษ'} · จ่ายเต็ม`, note: lockNote, cta: { label: specLocked ? 'ดูเงื่อนไข' : 'ซื้อเลย', href }, product: p, batch: b, altLabel: `หรือ${b.label || 'รอบพิเศษ'} ${baht(b.price_total)}` }
        : { kind: 'special', tone: 'blue', label: 'Pre-Order', detail: `${baht(b.price_total)} · พรี${b.label || 'รอบพิเศษ'}`, note: lockNote, cta: { label: specLocked ? 'ดูเงื่อนไข' : 'พรีเลย', href }, product: p, batch: b, altLabel: `หรือพรี${b.label || 'รอบพิเศษ'} ${baht(b.price_total)}` };
    }
  }
  if (specOpt) opts.push(specOpt);
  if (opts.length > 0) {
    const { altLabel, ...first } = opts[0];
    void altLabel;
    const second = opts[1];
    return make({ ...first, alt: second?.cta ? { label: `${second.altLabel} →`, href: second.cta.href } : undefined });
  }
  // 4 ติดห้องประมูล — หน้าร้านซ่อนอยู่ (ขายซ้อนไม่ได้) ห้ามตกไป "หาของ" ทั้งที่ร้านมีของ
  const inAuction = all.find((p) => inLiveAuction(db, p.id));
  if (inAuction) return make({ kind: 'auction', tone: 'gray', label: 'ประมูล', detail: 'อยู่ในห้องประมูล', product: inAuction }); // เทา: ไม่นับเป็น "ปิดพรีแล้ว" ในชิปหัวไลน์ (review ลูกค้ารอบ 2)
  // 5 หมดชั่วคราว (มีคนถือ hold/สลิปรอตรวจ — ถ้าไม่ผ่าน ของหลุดกลับมา) → พาไปหน้าสินค้าที่เช็คของสด
  //   (review ลูกค้ารอบ 2: เดิมคนที่จ่ายของชิ้นสุดท้ายเองเห็น "มีคนกำลังจ่ายเงิน" · ของที่คนอื่นซื้อหมดแต่ยังมีคน hold ตกไป "หาของ")
  const othersHold = (p: Product, bid?: string) => pendingHeld(db, p.id, bid) - myPendingHold(db, ctx.uid, p.id, bid);
  for (const p of sellable) {
    if (p.is_stock && stockLeft(p) <= 0 && othersHold(p) > 0)
      return make({ kind: 'soldout_temp', tone: 'gray', label: 'หมดชั่วคราว', detail: 'มีคนกำลังจ่ายเงิน · อาจมีของหลุด', cta: { label: 'ดูสินค้า', href: `/shop/${p.id}` }, product: p });
    for (const b of openBatchesOf(db, p.id))
      if (batchLeft(b) <= 0 && othersHold(p, b.id) > 0)
        return make({ kind: 'soldout_temp', tone: 'gray', label: 'หมดชั่วคราว', detail: 'มีคนกำลังจ่ายเงิน · อาจมีของหลุด', cta: { label: 'ดูสินค้า', href: `/shop/${p.id}?batch=${b.id}` }, product: p, batch: b });
  }
  // 6 ปิดพรีแล้ว — ใกล้ถึงมือที่สุดก่อน: เดินทาง > ผลิต > ปิดกระดานแล้วรอสั่งผลิต
  const pre = all.filter((p) => !p.is_stock);
  const closedPick =
    pre.find((p) => p.status === 'shipping') ??
    pre.find((p) => p.status === 'production') ??
    pre.find((p) => p.status === 'open' && inClosedBoard(db, p));
  if (closedPick) {
    const detail = closedPick.status === 'shipping' ? 'ปิดพรีแล้ว · กำลังเดินทางมาไทย' : closedPick.status === 'production' ? 'ปิดพรีแล้ว · กำลังผลิต' : 'ปิดพรีแล้ว · รอสั่งผลิต';
    return make({ kind: 'closed', tone: 'purple', label: 'ปิดพรีแล้ว', detail, cta: mine ? { label: 'ดูตั๋ว', href: '/wallet' } : { label: 'ดูรายละเอียด', href: `/shop/${closedPick.id}` }, product: closedPick });
  }
  // 7 ของออกแล้ว (ถึงไทย/ส่งมอบ/จบ หรือของในมือขายหมดจริง) และร้านไม่มีของ → ส่งเรื่องหาของ
  const ref = all.find((p) => !p.is_stock) ?? all[0];
  //   คนดูมีตั๋วของตัวนี้อยู่แล้ว (ของถึงไทย/ส่งมอบแล้ว) → ของของเขาเอง ห้ามชวน "หาของให้" (เส้นทางลูกค้า 2026-10-16 · เทสต์ J11)
  if (mine) {
    const own = all.find((p) => !p.is_stock && (p.status === 'arrived' || p.status === 'delivered' || p.status === 'closed')) ?? ref;
    const detail = pendingMine ? 'ส่งสลิปแล้ว · รอร้านตรวจ' : ownPre && own?.status === 'arrived' ? 'ของถึงไทยแล้ว · ดูตั๋วของคุณ' : 'ดูตั๋ว/สถานะของคุณ';
    // ซื้อพร้อมส่งอย่างเดียว = สีเทา "ซื้อแล้ว" (ไม่ใช่ "ปิดพรีแล้ว" สีม่วง · review ลูกค้ารอบ 2)
    return ownPre
      ? make({ kind: 'closed', tone: 'purple', label: 'ปิดพรีแล้ว', detail, cta: { label: 'ดูตั๋ว', href: '/wallet' }, product: own })
      : make({ kind: 'closed', tone: 'gray', label: 'ซื้อแล้ว', detail, cta: { label: 'ดูตั๋ว', href: '/wallet' }, product: own });
  }
  //   ส่งคำขอหาของตัวนี้ไว้แล้ว (ยังไม่จบ) → บอกว่าส่งแล้ว พาไปดูคำขอ แทนปุ่ม "หาของให้" (กันส่งซ้ำ · review ลูกค้า 2026-10-16)
  const asked = !!ctx.uid && db.sourcingRequests.some((r) => r.user_id === ctx.uid && !!r.source_product_id && ids.has(r.source_product_id) && ['requested', 'quoted', 'paid', 'working'].includes(r.status));
  if (asked) return make({ kind: 'out', tone: 'amber', label: 'หาของ', detail: 'ส่งคำขอหาของแล้ว · รอร้านตอบ', cta: { label: 'ดูคำขอ', href: '/sourcing' }, product: ref });
  return make({ kind: 'out', tone: 'amber', label: 'หาของ', detail: 'ของออกแล้ว · ร้านไม่มีของ', cta: { label: 'หาของให้', href: sourcingHref(line, m, ref) }, product: ref });
}

/** ตัวนี้ "เปิดรับพรีอยู่" ไหม (กระดานหลักเปิด หรือแอดมินตั้งเองว่าพรีออเดอร์) — ไม่ขึ้นกับสต๊อก
 *  ใช้นับชิป "เปิดพรี N" บนการ์ดไลน์ในหน้าช็อป: ตัวเลขสต๊อกฝั่งลูกค้าต้องถาม server ซึ่งการ์ดไม่ได้ถาม
 *  (review 2026-10-07: เดิมนับจาก kind ที่จัดลำดับตามสต๊อก local → ตัวเลขบนการ์ดไม่ตรงกับหน้าไลน์) */
export function memberOpenForPreorder(db: Database, m: LineMember): boolean {
  const { all } = memberProducts(db, m);
  if (all.length === 0) return m.manual_state === 'preorder';
  return all.some((p) => preorderOpenForOrder(db, p) && !inLiveAuction(db, p.id));
}

/** สถานะของทุกตัวในไลน์ (ลำดับ = เลข 1, 2, 3 …) */
export function lineStates(db: Database, line: ProductLine, ctx: LineCtx) {
  return line.members.map((m, i) => ({ member: m, no: i + 1, state: lineMemberState(db, line, m, ctx) }));
}

/** นับตามสี (ชิปบนการ์ดปก/หัวหน้าไลน์) — นับเฉพาะตัวที่ลูกค้าเห็น */
export function lineToneCounts(states: { state: LineMemberState }[]): Record<Exclude<LineTone, 'gray'>, number> {
  const c = { green: 0, blue: 0, purple: 0, amber: 0 };
  for (const { state } of states) if (state.visible && state.tone !== 'gray') c[state.tone]++;
  return c;
}

/** เช็กลิสต์ก่อนเปิดไลน์ (เจ้าของ 2026-10-16 รอบ 1 แทนสวิตช์ 2 ชั้นที่ทำให้งงว่า "กดเปิดแล้วทำไมลูกค้ายังไม่เห็น")
 *  ต้องครบ (required) = ชื่อ+ค่าย · รูปหมู่ · มีตัวที่ลูกค้าเห็นได้ ≥1 — ชุดเดียวกับ lineOpenToCustomers (ตัดสวิตช์ระบบออก ปุ่มเปิดให้เอง)
 *  ป้าย = ไม่บังคับ (ตัวที่ไม่อยู่ในรูปหมู่ เช่นตัวที่ค่ายยังไม่โชว์ จะไม่มีวันวางได้) แต่นับให้เห็น และถามก่อนเปิดถ้ายังไม่ครบ
 *  นับป้ายเฉพาะตัวที่ลูกค้าเห็น (ตัวที่ไม่มีสถานะ ลูกค้าไม่เห็นทั้งแถวและป้าย) */
export type LineCheckKey = 'info' | 'cover' | 'members' | 'pins';
export interface LineChecklist {
  items: { key: LineCheckKey; ok: boolean; required: boolean }[];
  okCount: number;
  ready: boolean;          // ครบทุกข้อที่บังคับ → กดเปิดได้
  live: boolean;           // ลูกค้าเห็นอยู่ตอนนี้ (= lineOpenToCustomers)
  visible: LineMember[];   // ตัวที่ลูกค้าเห็นได้ (ลำดับเดียวกับเลขบนรูป)
  hiddenN: number;         // ตัวที่ยังไม่ตั้งสถานะ (ลูกค้าไม่เห็น)
  pinned: number;          // ตัวที่ลูกค้าเห็นและวางป้ายแล้ว
  pinsMissing: LineMember[];
  firstProblem?: LineCheckKey; // ข้อบังคับข้อแรกที่ยังไม่ผ่าน (ใช้บอกเหตุผลบนปุ่ม)
}
export function lineChecklist(db: Database, line: ProductLine): LineChecklist {
  const visible = line.members.filter((m) => lineMemberState(db, line, m, { uid: '' }).visible);
  const pinsMissing = visible.filter((m) => !hasPin(m));
  const info = !!line.name.trim() && db.manufacturers.some((m) => m.id === line.maker_id);
  const live = lineOpenToCustomers(db, line);
  const items: LineChecklist['items'] = [
    { key: 'info', ok: info, required: true },
    { key: 'cover', ok: !!line.cover_url, required: true },
    { key: 'members', ok: visible.length > 0, required: true },
    { key: 'pins', ok: visible.length > 0 && pinsMissing.length === 0, required: false },
  ];
  const firstProblem = items.find((i) => i.required && !i.ok)?.key;
  return {
    items, okCount: items.filter((i) => i.ok).length, ready: !firstProblem, live, visible,
    hiddenN: line.members.length - visible.length, pinned: visible.length - pinsMissing.length, pinsMissing, firstProblem,
  };
}

/** วางป้ายอัตโนมัติ: กระจาย n ป้ายเท่าๆ กันซ้ายไปขวาที่ความสูง y% (รูปหมู่ของค่ายส่วนใหญ่ยืนเรียงซ้ายไปขวาตามลำดับ)
 *  แล้วแอดมินค่อยเลื่อนทั้งชุด / แตะหัวจริงทีละตัว · คืน % 2 ตำแหน่ง อยู่ในกรอบ 0–100 เสมอ */
export const PIN_AUTO_Y = 25;
export function autoPinSpread(n: number, y = PIN_AUTO_Y): { x: number; y: number }[] {
  const cy = Math.min(100, Math.max(0, y));
  return Array.from({ length: Math.max(0, n) }, (_, i) => ({ x: Math.round(((i + 0.5) / n) * 10000) / 100, y: cy }));
}

/** แผน "พรีทั้งเซต" (เจ้าของ 2026-10-16 รอบ 1): นับตัวที่พรีแล้ว / ยังขาด / ใส่ตะกร้าได้ทีเดียว
 *  ใส่ได้ทีเดียว = พรีกระดานหลักที่เปิดอยู่ ไม่มีแบบ A/B ยังไม่พรี ยังไม่อยู่ในตะกร้า (กติกาเดียวกับปุ่ม "พรีเลย" ในแถว)
 *  ตัวที่ใส่ไม่ได้ (มีแบบ/รอบพิเศษ/ปิดพรี) อยู่ใน skipped — ปุ่มบอกจำนวนที่ใส่ได้จริงเท่านั้น */
export interface LineSetPlan {
  mine: number; total: number;   // นับเฉพาะตัวที่มีสินค้าในระบบ (ตัวที่ Add เองติดตามไม่ได้)
  missing: { name: string; member: LineMember; state: LineMemberState }[];
  addable: { name: string; product: Product }[];
  inCart: number;
  rowOnly: string[];   // ยังขาด + สั่งได้ แต่ต้องกดที่แถว (มีแบบให้เลือก / รอบพิเศษ / พร้อมส่ง)
  tracked: { id: string; mine: boolean }[]; // ตัวที่นับใน x/y (จุดในการ์ดต้องวาดจากชุดนี้)
  deposit: number; // มัดจำรวมของตัวที่ใส่ได้ (ตัวเลขบนปุ่ม)
  missingDeposit: number; // มัดจำรวมของตัวที่ยังขาดและยังพรีกระดานหลักได้ (ตัวเลขในการ์ด x/y)
}
/** depositOf = มัดจำต่อชิ้น "ตามยศของคนดู" (ผู้เรียกส่ง lineDepositForRank) — ต้องตรงกับตะกร้า/checkout (DNA rank rule)
 *  ไม่ส่ง = มัดจำป้ายของสินค้า (ใช้ในเทสต์/ที่ที่ไม่มีคนดู) */
export function lineSetPlan(shown: { member: LineMember; state: LineMemberState }[], inCart: (productId: string) => boolean, depositOf: (p: Product) => number = (p) => p.deposit_amount): LineSetPlan {
  const vis = shown.filter((s) => s.state.visible && !!s.state.product);
  const missing = vis.filter((s) => !s.state.mine).map((s) => ({ name: s.member.name.trim() || '?', member: s.member, state: s.state }));
  const addable: LineSetPlan['addable'] = [];
  const rowOnly: string[] = [];
  let inCartN = 0;
  let missingDeposit = 0;
  for (const m of missing) {
    const p = m.state.product!;
    const k = m.state.kind;
    if (k === 'preorder') missingDeposit += depositOf(p);
    if (k === 'preorder' && !p.has_variants) {
      if (inCart(p.id)) inCartN++; else addable.push({ name: m.name, product: p });
    } else if (k === 'preorder' || k === 'special' || k === 'stock') rowOnly.push(m.name);
  }
  return { mine: vis.length - missing.length, total: vis.length, tracked: vis.map((x) => ({ id: x.member.id, mine: x.state.mine })), missing, addable, inCart: inCartN, rowOnly, deposit: addable.reduce((a, x) => a + depositOf(x.product), 0), missingDeposit };
}

/** รายการที่ต้องถามของเหลือจริงจาก server (ของในมือ + รอบพิเศษที่เปิด) — ไม่ซ้ำ ·
 *  ข้ามของที่ติดประมูล (ไม่มีวันขึ้นป้ายซื้อได้ ถามไปเปลืองโควตา) */
export function liveTargetsForLine(db: Database, line: ProductLine): { productId: string; batchId?: string }[] {
  const out: { productId: string; batchId?: string }[] = [];
  const seen = new Set<string>();
  const push = (productId: string, batchId?: string) => {
    const k = `${productId}|${batchId ?? ''}`;
    if (!seen.has(k)) { seen.add(k); out.push({ productId, batchId }); }
  };
  for (const m of line.members) {
    for (const p of memberProducts(db, m).all) {
      if (inLiveAuction(db, p.id)) continue;
      if (p.is_stock) push(p.id);
      for (const b of openBatchesOf(db, p.id)) push(p.id, b.id);
    }
  }
  return out;
}
/** เพดานจำนวนที่หน้าไลน์ถาม server ต่อรอบ — ไลน์ใหญ่ (13 ตัว × ของในมือ + รอบพิเศษ) เกิน 24 ของการ์ดหน้าร้านได้
 *  ตัวที่ไม่ได้ถาม = ใช้สูตร local ซึ่งฝั่งลูกค้านับขายแล้วไม่ครบ (RLS) → ขึ้น "พร้อมส่ง" บนของที่หมด (review 2026-10-07) */
export const LINE_LIVE_MAX = 48;

/** ไลน์ที่มีสินค้านี้ (ผูกตรงหรือเป็นของในมือชื่อเดียวกัน) และผู้ใช้คนนี้เห็นได้ — ปุ่ม "ดูทั้งไลน์" หน้าสินค้า */
export function linesOfProduct(db: Database, uid: string, productId: string): ProductLine[] {
  return db.productLines.filter((l) => lineVisibleTo(db, uid, l) && l.members.some((m) => memberProducts(db, m).all.some((p) => p.id === productId)));
}

/** ไลน์ที่โชว์บนหน้าร้าน: ลูกค้า = lineOpenToCustomers · แอดมิน = ทุกไลน์ (ป้ายร่างบอกเอง) */
export function shopLines(db: Database, uid: string, f: { makerId?: string | null; franchiseId?: string | null; query?: string } = {}): ProductLine[] {
  const q = f.query?.trim().toLowerCase();
  return db.productLines
    .filter((l) => lineVisibleTo(db, uid, l))
    .filter((l) => !f.makerId || l.maker_id === f.makerId)
    .filter((l) => !f.franchiseId || l.franchise_id === f.franchiseId)
    .filter((l) => !q || `${l.name} ${db.manufacturers.find((x) => x.id === l.maker_id)?.name ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** สินค้าที่ "อยู่ในไลน์ที่ผู้ใช้คนนี้เห็น" (ผูกตรง + ของคู่) — หน้าช็อปมุมมอง "ทั้งหมด" ยุบตัวพวกนี้ออกจากกริด
 *  ให้เหลือการ์ดไลน์ใบเดียว (เจ้าของ 2026-10-08 "เอาแบบยุบ") · ค้นหา/กรอง/หมวด ยังเห็นตัวเดี่ยวครบ (ผู้เรียกตัดสิน) */
export function productsInVisibleLines(db: Database, uid: string, f: { makerId?: string | null; franchiseId?: string | null } = {}): Set<string> {
  // ⚠ ต้องกรองเหมือนแถบไลน์ (LineStrip → shopLines ตัวกรองเดียวกัน) — ไม่งั้นกรองเรื่อง X แล้วไลน์ที่ไม่ระบุเรื่อง/เรื่องอื่น
  //   ไม่มีการ์ดโผล่ แต่สมาชิกถูกยุบหาย = หาไม่เจอนอกจากค้นหา (review ลูกค้า 2026-10-16)
  const out = new Set<string>();
  for (const l of shopLines(db, uid, f)) for (const m of l.members) for (const p of memberProducts(db, m).all) out.add(p.id);
  return out;
}

/** ไลน์ล่าสุด N ไลน์สำหรับหน้าแรก (เรียงตามวันที่สร้าง ใหม่สุดก่อน — shopLines เรียงให้แล้ว) */
export const homeLines = (db: Database, uid: string, n = 3): ProductLine[] => shopLines(db, uid).slice(0, n);
/** ป้าย "ใหม่" = สร้างภายใน 7 วัน */
export const isNewLine = (l: ProductLine, now = Date.now()): boolean => now - new Date(l.created_at).getTime() < 7 * 86_400_000;

// ── ป้ายบนรูป ─────────────────────────────────────────────────────────────────

/** มีพิกัดครบและอยู่ในกรอบรูป */
export const hasPin = (m: LineMember): boolean =>
  typeof m.pin_x === 'number' && typeof m.pin_y === 'number' && Number.isFinite(m.pin_x) && Number.isFinite(m.pin_y);

export const PIN_STEM_SHORT = 14;
export const PIN_STEM_TALL = 38;
/** เกินนี้ป้ายเริ่มซ้อนกัน → โชว์แค่วงกลมเลข ชื่อ+สถานะไปอยู่ในรายการใต้รูป */
export const PIN_COMPACT_OVER = 6;
export interface PinPlacement {
  id: string;
  x: number;               // % ของรูป
  y: number;
  stem: number;            // px ความยาวเส้นชี้ (= ชั้น + ส่วนต่าง snap)
  tier: number;            // ชั้นความสูง 0 = ต่ำสุด (แถวเดียว) · 1, 2 = ยกขึ้นเลี่ยงชน
  align: 'center' | 'left' | 'right'; // ป้ายชิดขอบรูปไม่ให้ล้นออก (ใช้เฉพาะโหมดสลับชั้น)
  dx: number;              // px ที่ป้ายถูกขยับออกจากหัว (โหมดจัดแถว — หางยังชี้หัว) · 0 = ตรงหัว
  below: boolean;          // จุดอยู่ใกล้ขอบบน → ป้ายลงด้านล่างแทน
  compact: boolean;
  /** ป้ายย่อ (ฟอนต์/ช่องไฟเล็กลง ~15%) — ใช้เมื่อย่อแล้วทุกป้ายพอดีแถวเดียว ดีกว่าสลับชั้นขึ้นลง (เจ้าของ 2026-10-08) */
  dense: boolean;
  /** ใช้คำย่อ (PosterPin.short เช่น "PRE") เพราะคำเต็มไม่พอแถวเดียว */
  short?: boolean;
}
/** อัตราย่อป้ายโหมด dense — ต้องตรงกับ CSS ใน LinePoster (ฟอนต์ 10px · วงเลข 15px · ช่องไฟแคบลง) */
export const PIN_DENSE_SCALE = 0.8;
/** ความสูงป้าย (px) + ระยะเผื่อ — ใช้ตัดสินว่าป้ายด้านบนจะล้นขอบรูปไหม */
const PIN_LABEL_ROOM = 34;
/** ระยะจากจุดถึงขอบป้ายตอนชิดซ้าย/ขวา (px) — ต้องตรงกับ LinePoster */
export const PIN_EDGE_INSET = 14;
/** ความกว้างป้ายโดยประมาณ (px) ที่ฟอนต์ 11px: วงเลข+ช่องไฟ ~38 + ~6.4/ตัวอักษร (สระบน-ล่าง/วรรณยุกต์ไทยไม่กินที่)
 *  วัดจริง 2026-10-08: "เปิดพรี" = 70px (ประมาณต้องไม่ต่ำกว่าของจริง ไม่งั้นบอกว่าพอดีแต่จริงทับ) */
export function pinLabelWidth(text: string): number {
  const visible = [...text].filter((ch) => !/[ัิ-ฺ็-๎]/.test(ch)).length;
  return 38 + visible * 6.4;
}
/**
 * จัดวางป้าย: เรียงตามแนวนอน แล้วเลือกเส้นสั้น/ยาวที่ "ชนป้ายข้างๆ น้อยที่สุด" (ฝั่งเดียวกัน) ·
 * ใกล้ขอบซ้าย/ขวาชิดขอบ · ใกล้ขอบบนกลับหัวลงล่าง · เกิน 6 ป้าย = โหมดย่อ (เลขอย่างเดียว)
 * `heightPx`/`widthPx` = ขนาดรูปจริงบนจอ (ถ้ารู้) + `w` ความกว้างป้าย → คิดชนกันเป็นพิกเซลจริง
 *   (เดิมเทียบแค่ห่างกันกี่ % — ป้ายชื่อยาวสองอันห่างกัน 20% ยังทับกันบนจอมือถือ · เจอตอนเทสต์ 2026-10-07)
 *   ไม่รู้ขนาด = ถือว่าห่างกันไม่ถึง 20% คือชน (ค่าประมาณสำหรับเทสต์/ก่อนรูปโหลด)
 */
/** ชั้นความสูงของป้าย (px ของเส้นชี้) — 3 ชั้น: หัวติดกัน 3 ตัว (เช่น 5 คนยืนเรียงกลางรูป) ยังไม่ทับกัน
 *  (เจ้าของ 2026-10-08: "กล่องข้อความเบียดกัน" — เดิมมี 2 ชั้น ป้ายที่ 3 ต้องเลือกทับอันใดอันหนึ่ง) */
export const PIN_STEMS = [PIN_STEM_SHORT, PIN_STEM_TALL, 62] as const;
/** หัวที่สูงต่างกันไม่เกินนี้ (px) ถือว่า "แถวเดียวกัน" → ป้ายจัดให้อยู่ระดับเดียวกัน (เจ้าของ 2026-10-08: "ให้ Snap กัน") */
export const PIN_SNAP_PX = 36;
/**
 * จัดกลุ่มหัวที่สูงไล่เลี่ยกัน (ฝั่งเดียวกัน) แล้วคืน "ระดับอ้างอิง" ของกลุ่ม = หัวที่สูงที่สุดในกลุ่ม (ฝั่งบน) /
 * ต่ำที่สุด (ฝั่งล่าง) — ป้ายของทุกคนในกลุ่มยึดระดับนี้ เส้นชี้ของคนที่หัวต่ำกว่ายาวขึ้นเท่าส่วนต่าง จุดยังอยู่บนหัวจริง
 */
function snapRows(pins: { id: string; y: number; below: boolean }[], H: number): Map<string, number> {
  const ref = new Map<string, number>();
  for (const below of [false, true]) {
    const side = pins.filter((p) => p.below === below).sort((a, b) => (below ? b.y - a.y : a.y - b.y));
    let anchor: number | null = null;
    for (const p of side) {
      const px = (p.y / 100) * H;
      if (anchor === null || Math.abs(px - anchor) > PIN_SNAP_PX) anchor = px;
      ref.set(p.id, anchor);
    }
  }
  return ref;
}
/** ความกว้างวงเลขโหมดย่อ (compact · >6 ป้าย) — ใช้จัดแถวเดียวได้เหมือนป้ายปกติ */
const PIN_COMPACT_W = 22;
/** หางป้ายต้องอยู่ในตัวป้าย: ขยับป้ายออกจากหัวได้ไม่เกิน (กว้าง/2 − ค่านี้) */
const PIN_TAIL_INSET = 10;
/**
 * จัดแถวเดียว (เจ้าของ 2026-10-08 "มือถือให้เรียงแบบ PC"): ป้ายทุกอันอยู่ชั้นเดียวกัน แล้ว "ขยับซ้าย/ขวา" หนีกัน
 * (หางยังชี้หัวตัวเอง) แทนการยกขึ้นลง — เรียงซ้าย→ขวา ดันอันที่ชนไปทางขวา ล้นขอบขวาค่อยดันกลับซ้ายทั้งแถว
 * คืน null ถ้าความกว้างรวมเกินรูป หรือหางจะหลุดออกนอกป้าย (ป้ายถูกดันไกลจากหัวเกิน)
 */
function packRow(items: { id: string; X: number; w: number }[], W: number, gapPx: number): Map<string, number> | null {
  const sorted = [...items].sort((a, b) => a.X - b.X);
  const lo: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const want = sorted[i].X - sorted[i].w / 2;
    lo[i] = Math.max(4, want, i > 0 ? lo[i - 1] + sorted[i - 1].w + gapPx : -Infinity);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const maxLo = (i < sorted.length - 1 ? lo[i + 1] - gapPx : W - 4) - sorted[i].w;
    if (lo[i] > maxLo) lo[i] = maxLo;
  }
  if (lo.length && lo[0] < 4) return null;
  const out = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    const dx = lo[i] + sorted[i].w / 2 - sorted[i].X;
    if (Math.abs(dx) > Math.max(0, sorted[i].w / 2 - PIN_TAIL_INSET)) return null;
    out.set(sorted[i].id, Math.round(dx));
  }
  return out;
}
/**
 * ลำดับการเลือก: 1) แถวเดียว ป้ายขนาดปกติ ขยับซ้ายขวาเลี่ยงชน 2) แถวเดียว ป้ายย่อ 20% 3) ไม่พอจริงๆ (จอแคบ+ป้ายยาว)
 * ค่อยสลับชั้นสั้น/ยาว · รู้ขนาดรูปเท่านั้นถึงจัดแถวได้ (ไม่รู้ = สลับชั้นแบบเดิม)
 */
/**
 * `ws` = ความกว้างป้ายแบบคำย่อ (เช่น "PRE" แทน "Pre-Order") — ขั้นที่ 3 ก่อนจะยอมแยก 2 แถว (เจ้าของ 2026-10-08 "เหมือนเดิม":
 * บนมือถือต้องแถวเดียว) · ลำดับ: เต็ม → เต็มย่อ 20% → คำย่อ → คำย่อย่อ 20% → สลับชั้น
 */
export function layoutPins(pins: { id: string; x: number; y: number; w?: number; ws?: number }[], heightPx?: number, widthPx?: number): PinPlacement[] {
  const compact = pins.length > PIN_COMPACT_OVER;
  const sized = compact ? pins.map((p) => ({ ...p, w: PIN_COMPACT_W })) : pins;
  if (widthPx && widthPx > 0 && sized.every((p) => p.w)) {
    const packed = layoutPinsAt(sized, heightPx, widthPx, false, true);
    if (packed) return packed;
    if (!compact) {
      const dense = layoutPinsAt(sized.map((p) => ({ ...p, w: (p.w ?? 0) * PIN_DENSE_SCALE })), heightPx, widthPx, true, true);
      if (dense) return dense;
      if (sized.some((p) => p.ws && p.ws < (p.w ?? 0))) {
        const shortW = sized.map((p) => ({ ...p, w: p.ws ?? p.w }));
        const short = layoutPinsAt(shortW, heightPx, widthPx, false, true);
        if (short) return short.map((p) => ({ ...p, short: true }));
        const shortDense = layoutPinsAt(shortW.map((p) => ({ ...p, w: (p.w ?? 0) * PIN_DENSE_SCALE })), heightPx, widthPx, true, true);
        if (shortDense) return shortDense.map((p) => ({ ...p, short: true }));
      }
    }
  }
  return layoutPinsAt(sized, heightPx, widthPx, false, false)!;
}
function layoutPinsAt(pins: { id: string; x: number; y: number; w?: number }[], heightPx: number | undefined, widthPx: number | undefined, dense: boolean, pack: boolean): PinPlacement[] | null {
  const compact = pins.length > PIN_COMPACT_OVER;
  const sorted = [...pins].sort((a, b) => a.x - b.x || a.y - b.y);
  const out: PinPlacement[] = [];
  const W = widthPx && widthPx > 0 ? widthPx : 0;
  const H = heightPx && heightPx > 0 ? heightPx : 0;
  const belowOf = (p: { y: number }) => (H ? (p.y / 100) * H < PIN_STEM_TALL + PIN_LABEL_ROOM : p.y < 22);
  const rows = H ? snapRows(sorted.map((p) => ({ id: p.id, y: p.y, below: belowOf(p) })), H) : null;
  const taken: Record<'up' | 'down', { x: number; lo: number; hi: number; tier: number }[]> = { up: [], down: [] };
  // โหมดจัดแถว: ทุกป้ายชั้น 0 ขยับซ้ายขวาแทน — แยกจัดฝั่งบน/ล่าง (คนละแถว)
  let dxOf: Map<string, number> | null = null;
  if (pack) {
    dxOf = new Map();
    for (const below of [false, true]) {
      const side = sorted.filter((p) => belowOf(p) === below).map((p) => ({ id: p.id, X: (p.x / 100) * W, w: p.w ?? 0 }));
      const r = packRow(side, W, dense ? 3 : 6);
      if (!r) return null;
      r.forEach((v, k) => dxOf!.set(k, v));
    }
  }
  for (const p of sorted) {
    const roomUp = H ? (p.y / 100) * H : Infinity;
    const roomDown = H ? ((100 - p.y) / 100) * H : Infinity;
    const below = belowOf(p);
    const side = below ? 'down' : 'up';
    // ส่วนต่างระหว่างหัวคนนี้กับระดับอ้างอิงของแถว (px) — บวกเข้าเส้นชี้ให้ป้ายอยู่แถวเดียวกัน
    const snap = rows ? Math.abs((p.y / 100) * H - rows.get(p.id)!) : 0;
    const room = (below ? roomDown : roomUp) - snap;
    const X = (p.x / 100) * W;
    const w = p.w ?? 0;
    if (dxOf) {
      out.push({ id: p.id, x: p.x, y: p.y, stem: PIN_STEM_SHORT + Math.round(snap), tier: 0, align: 'center', dx: dxOf.get(p.id) ?? 0, below, compact, dense });
      continue;
    }
    // ชิดขอบ: รู้ขนาด = ป้ายกลางล้นขอบรูปไหม · ไม่รู้ = ใช้ % เดิม
    const align: PinPlacement['align'] = W && w
      ? (X - w / 2 < 4 ? 'left' : X + w / 2 > W - 4 ? 'right' : 'center')
      : (p.x < 14 ? 'left' : p.x > 86 ? 'right' : 'center');
    const lo = align === 'center' ? X - w / 2 : align === 'left' ? X - PIN_EDGE_INSET : X + PIN_EDGE_INSET - w;
    const hi = lo + w;
    const overlap = (tier: number) => taken[side]
      .filter((q) => q.tier === tier)
      .reduce((s, q) => s + (W && w
        ? Math.max(0, Math.min(hi, q.hi) - Math.max(lo, q.lo) + (dense ? 3 : 6))  // พิกเซลที่ทับกัน (+ช่องไฟ · โหมดย่อยอมชิดกว่า)
        : Math.max(0, 20 - Math.abs(p.x - q.x))), 0);                               // ไม่รู้ขนาด: ใกล้กว่า 20% = ชน
    // ชั้นที่ใช้ได้ = เส้น+ป้ายยังอยู่ในรูป (ชั้นแรกใช้ได้เสมอ) → เลือกชั้นต่ำสุดที่ไม่ชนเลย ไม่มีเลย = ชั้นที่ชนน้อยสุด
    const usable = PIN_STEMS.map((s, i) => i).filter((i) => i === 0 || PIN_STEMS[i] + PIN_LABEL_ROOM <= room);
    const free = usable.find((i) => overlap(i) === 0);
    const tier = free ?? usable.reduce((best, i) => (overlap(i) < overlap(best) ? i : best), usable[0]);
    taken[side].push({ x: p.x, lo, hi, tier });
    out.push({ id: p.id, x: p.x, y: p.y, stem: PIN_STEMS[tier] + Math.round(snap), tier, align, dx: 0, below, compact, dense });
  }
  return out;
}

// ── เขียนแถว ──────────────────────────────────────────────────────────────────

const clampPct = (n: number) => Math.round(Math.min(100, Math.max(0, n)) * 100) / 100;
/** ทำความสะอาดสมาชิกก่อนเก็บ: พิกัดครบคู่ + อยู่ในกรอบ 0–100 · product_ids ไม่ซ้ำ · ทิ้งคีย์แปลกปลอม */
export function cleanMember(m: LineMember): LineMember {
  const out: LineMember = { id: m.id, name: m.name, product_ids: [...new Set((m.product_ids ?? []).filter(Boolean))] };
  if (m.image_url) out.image_url = m.image_url;
  if (m.manual_state === 'preorder' || m.manual_state === 'stock' || m.manual_state === 'sourcing') out.manual_state = m.manual_state;
  if (hasPin(m)) { out.pin_x = clampPct(m.pin_x!); out.pin_y = clampPct(m.pin_y!); }
  return out;
}
/** แถวที่จะเขียนลง product_lines — ช่องที่ล้างค่าต้องเป็น null (syncTable ส่ง JSON: undefined หาย = ค่าเก่าค้างใน DB)
 *  ⚠ ห้าม trim ชื่อที่นี่ — mutation นี้วิ่งทุกครั้งที่พิมพ์ trim จะกินเว้นวรรคท้ายจนพิมพ์ชื่อสองคำไม่ได้ */
export function cleanLineRow(l: ProductLine): ProductLine {
  return {
    id: l.id,
    maker_id: l.maker_id,
    franchise_id: l.franchise_id || null,
    name: l.name ?? '',
    cover_url: l.cover_url || null,
    note: l.note ?? null,
    members: (l.members ?? []).map(cleanMember),
    active: l.active === true,
    created_at: l.created_at,
    ...(l.updated_at ? { updated_at: l.updated_at } : {}),
  };
}

// ── หาของ: เติมฟอร์มจากลิงก์ ────────────────────────────────────────────────────

export interface SourcingPrefill { makerId?: string; frId?: string; cname: string; images: string[]; srcId?: string; note?: string }
/**
 * ค่าที่ฟอร์ม "ส่งเรื่องหาของ" เติมให้จากลิงก์ ?line=&m=&src= (ปุ่ม "หาของให้" ในหน้าไลน์)
 * ไลน์ที่ผู้ใช้มองไม่เห็น (ร่าง/สวิตช์ปิด) = ไม่ใช้ข้อมูลไลน์ · src ต้องเป็นสินค้าของตัวนั้นจริง (กันลิงก์ปนกัน)
 */
export function sourcingPrefill(db: Database, uid: string, q: { src?: string | null; line?: string | null; m?: string | null }): SourcingPrefill | null {
  const p = q.src ? db.products.find((x) => x.id === q.src) : undefined;
  const line = q.line ? db.productLines.find((l) => l.id === q.line) : undefined;
  const okLine = line && lineVisibleTo(db, uid, line) ? line : undefined;
  const idx = okLine && q.m ? okLine.members.findIndex((x) => x.id === q.m) : -1;
  const mem = okLine && idx >= 0 ? okLine.members[idx] : undefined;
  if (okLine && mem) {
    const mp = memberProducts(db, mem);
    const ref = p && mp.all.some((x) => x.id === p.id) ? p : mp.linked[0];
    const images = (mem.image_url ? [mem.image_url] : ref?.images?.length ? ref.images : okLine.cover_url ? [okLine.cover_url] : []).slice(0, 3);
    return {
      makerId: okLine.maker_id,
      frId: okLine.franchise_id ?? ref?.franchise_id,
      cname: mem.name,
      images,
      srcId: ref?.id,
      note: `จากไลน์ ${okLine.name} · ตัวที่ ${okLine.members.filter((x) => lineMemberState(db, okLine, x, { uid: '' }).visible).findIndex((x) => x.id === mem.id) + 1 || idx + 1}`,
    };
  }
  if (p) return { makerId: p.manufacturer_id, frId: p.franchise_id, cname: p.character_name ?? p.series_name, images: p.images.slice(0, 3), srcId: p.id };
  return null;
}
