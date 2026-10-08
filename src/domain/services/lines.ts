import type { Database, LineMember, Product, ProductBatch, ProductLine } from '../entities';
import { inClosedBoard, inLiveAuction, isStockTwin, preorderOpenForOrder, variantsOf } from './catalog';
import { availableFor, batchAvailable, batchGoneState, myPendingHold, stockGoneState } from './reservations';
import { isAdminUser } from './admins';

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
  detail: string;     // บรรทัดรองในรายการใต้รูป
  cta?: LineCta;
  product?: Product;  // สินค้าที่ใช้ตัดสิน
  batch?: ProductBatch;
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
  const mine = !!ctx.uid && db.tickets.some((t) => t.owner_id === ctx.uid && t.status !== 'transferred' && ids.has(t.product_id));
  const make = (s: Omit<LineMemberState, 'mine' | 'pinLabel' | 'visible'> & { visible?: boolean }): LineMemberState => ({
    ...s,
    mine,
    visible: s.visible ?? true,
    pinLabel: mine && s.kind === 'closed' ? 'พรีแล้ว ✓' : s.label,
  });

  // ── ยังไม่มีสินค้าในระบบ (หรือสินค้าที่ผูกถูกลบหมด) → สถานะที่แอดมินตั้งเอง ──
  if (all.length === 0) {
    switch (m.manual_state) {
      case 'preorder': return make({ kind: 'manual_preorder', tone: 'blue', label: 'Pre-Order', detail: 'ค่ายเปิดพรีแล้ว · สั่งผ่านร้าน', cta: lineOaCta(ctx.lineOa) });
      case 'stock': return make({ kind: 'manual_stock', tone: 'green', label: 'มีของ', detail: 'ร้านมีของ · สั่งผ่านร้าน', cta: lineOaCta(ctx.lineOa) });
      case 'sourcing': return make({ kind: 'manual_sourcing', tone: 'amber', label: 'หาของ', detail: 'ของออกแล้ว · ส่งเรื่องให้ร้านหาให้', cta: { label: 'หาของให้', href: sourcingHref(line, m) } });
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

  // 1 ของในมือ (SKU พร้อมส่ง) ยังมีของ
  for (const p of sellable) {
    if (!p.is_stock || stockLeft(p) <= 0) continue;
    const { price, from } = priceOf(db, p);
    const hand2 = p.stock_cond?.hand === 2 ? ' · มือ 2' : '';
    return make({ kind: 'stock', tone: 'green', label: 'พร้อมส่ง', detail: `${from ? 'เริ่ม ' : ''}${baht(price)} · พร้อมส่ง${hand2}`, cta: { label: 'ซื้อเลย', href: `/shop/${p.id}` }, product: p });
  }
  // 2 รอบพิเศษเปิดขาย (published) ยังมีของ
  for (const p of sellable) {
    for (const b of openBatchesOf(db, p.id)) {
      if (batchLeft(b) <= 0) continue;
      const fullPay = b.deposit_amount >= b.price_total;
      return fullPay
        ? make({ kind: 'special', tone: 'green', label: 'พร้อมส่ง', detail: `${baht(b.price_total)} · ${b.label || 'รอบพิเศษ'} · จ่ายเต็ม`, cta: { label: 'ซื้อเลย', href: `/shop/${p.id}?batch=${b.id}` }, product: p, batch: b })
        : make({ kind: 'special', tone: 'blue', label: 'Pre-Order', detail: `${baht(b.price_total)} · พรี${b.label || 'รอบพิเศษ'}`, cta: { label: 'พรีเลย', href: `/shop/${p.id}?batch=${b.id}` }, product: p, batch: b });
    }
  }
  // 3 กระดานหลักเปิดรับพรี (ไม่อยู่ในกระดานที่ปิดแล้ว · ไม่ติดประมูล) — ด่านเดียวกับหน้าสินค้า/ตะกร้า/submitOrder
  for (const p of sellable) {
    if (!preorderOpenForOrder(db, p)) continue;
    const { price, from } = priceOf(db, p);
    return make({ kind: 'preorder', tone: 'blue', label: 'Pre-Order', detail: `${from ? 'เริ่ม ' : ''}${baht(price)} · เปิดรับพรี`, cta: { label: 'พรีเลย', href: `/shop/${p.id}` }, product: p });
  }
  // 4 ติดห้องประมูล — หน้าร้านซ่อนอยู่ (ขายซ้อนไม่ได้) ห้ามตกไป "หาของ" ทั้งที่ร้านมีของ
  const inAuction = all.find((p) => inLiveAuction(db, p.id));
  if (inAuction) return make({ kind: 'auction', tone: 'purple', label: 'ประมูล', detail: 'อยู่ในห้องประมูล', product: inAuction });
  // 5 หมดชั่วคราว (มีคนถือ hold/สลิปรอตรวจ — ถ้าไม่ผ่าน ของหลุดกลับมา) → พาไปหน้าสินค้าที่เช็คของสด
  for (const p of sellable) {
    if (p.is_stock && stockLeft(p) <= 0 && stockGoneState(db, p) === 'temp')
      return make({ kind: 'soldout_temp', tone: 'gray', label: 'หมดชั่วคราว', detail: 'มีคนกำลังจ่ายเงิน · อาจมีของหลุด', cta: { label: 'ดูสินค้า', href: `/shop/${p.id}` }, product: p });
    for (const b of openBatchesOf(db, p.id))
      if (batchLeft(b) <= 0 && batchGoneState(db, b) === 'temp')
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
export function layoutPins(pins: { id: string; x: number; y: number; w?: number }[], heightPx?: number, widthPx?: number): PinPlacement[] {
  const compact = pins.length > PIN_COMPACT_OVER;
  const sized = compact ? pins.map((p) => ({ ...p, w: PIN_COMPACT_W })) : pins;
  if (widthPx && widthPx > 0 && sized.every((p) => p.w)) {
    const packed = layoutPinsAt(sized, heightPx, widthPx, false, true);
    if (packed) return packed;
    if (!compact) {
      const dense = layoutPinsAt(sized.map((p) => ({ ...p, w: (p.w ?? 0) * PIN_DENSE_SCALE })), heightPx, widthPx, true, true);
      if (dense) return dense;
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
      note: `จากไลน์ ${okLine.name} · ตัวที่ ${idx + 1}`,
    };
  }
  if (p) return { makerId: p.manufacturer_id, frId: p.franchise_id, cname: p.character_name ?? p.series_name, images: p.images.slice(0, 3), srcId: p.id };
  return null;
}
