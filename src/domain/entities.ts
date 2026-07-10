/**
 * Domain entities — the shape of the in-memory `Database`, mapped from the PRD
 * data models (design-reference/ryuma-prd.md §7, §10, §12, §17). Field names match
 * the Supabase schema in supabase/schema.sql so the adapter is a straight mapping.
 */

export type ProductType = 'wcf' | 'figure' | 'resin' | 'other';
export type ProductStatus = 'open' | 'production' | 'shipping' | 'arrived' | 'delivered' | 'closed';
export type TicketStatus = 'pending_approval' | 'active' | 'paid_full' | 'transferred' | 'shipped';
/** ขนส่งในไทย (พัสดุถึงหน้าบ้านลูกค้า). */
export type Carrier = 'ems' | 'jt' | 'flash' | 'kerry';
export type OrderStatus = 'pending_approval' | 'approved' | 'rejected';
export type TransferStatus = 'listed' | 'pending_admin' | 'approved' | 'cancelled';
export type RankName = 'bronze' | 'silver' | 'gold' | 'diamond' | 'legend';

/** ประเภท / Type — top category that groups makers (WCF, Resin, Bandai...). */
export interface Category {
  id: string;
  name: string;
  active: boolean; // only active types are offered on the storefront
}

export interface Manufacturer {
  id: string;
  name: string; // ค่าย เช่น "A+", "YZ"
  category_id: string; // ประเภท/Type this maker belongs to
  logo_url?: string; // Supabase Storage URL of the maker icon
}

/** เรื่อง / IP — independent of maker (One Piece, Naruto). */
export interface Franchise {
  id: string;
  name: string; // "One Piece"
  abbr: string; // 'op','nr','db' — used in ticket numbers
}

/**
 * ซีรีย์ / product line under a franchise (e.g. "Thriller Park" under One Piece).
 * `maker_ids` lists which manufacturers produce this series (many-to-many) — a
 * series can be shared by several ค่าย, and some ค่าย may not carry it.
 */
export interface Series {
  id: string;
  name: string;
  franchise_ids: string[]; // a series can span MULTIPLE เรื่อง (e.g. an "All Star" crossover line)
  maker_ids: string[];
}

export interface ProductVariant {
  id: string;
  product_id: string;
  name: string; // "Random Box", "Single - Luffy", "Full Set"
  price_total: number;
  deposit_amount: number;
  stock_qty?: number;
  image_url?: string; // per-variant image (shown when the customer picks this variant)
}

/** Deposit tier — Mega WCF carries a higher default deposit than standard WCF. */
export type WcfType = 'wcf' | 'mega_wcf';

export interface Product {
  id: string;
  franchise_id: string; // เรื่อง
  manufacturer_id: string; // ค่าย
  series_id?: string; // ซีรีย์ / arc (optional) — acts as a "platform" grouping
  series_name: string; // final display title = "ชื่อตัวละคร - ซีรีย์" (composed at save)
  character_name?: string; // the raw character name typed by admin (kept for editing round-trip)
  wcf_type?: WcfType; // WCF (มัดจำ 300) | Mega WCF (มัดจำ 500)
  cost_yuan?: number; // ต้นทุนหยวน (used by the price calculator)
  type: ProductType;
  description: string;
  description_en?: string;
  images: string[]; // Supabase Storage URLs (empty = placeholder)
  eta_note: string; // "Q3 2026"
  price_total: number;
  deposit_amount: number;
  is_stock: boolean; // true = พร้อมส่ง, false = พรีออเดอร์
  stock_qty?: number;
  // physical size (cm). height is the primary spec; width/depth are optional and only
  // shown when set. Kept as structured fields (not free text in the description).
  height_cm?: number;
  width_cm?: number;
  depth_cm?: number;
  has_variants: boolean;
  stock_origin?: 'preorder' | 'manual'; // admin-only: in-stock came from a pre-order conversion vs. created new
  status: ProductStatus;
  // Shipping (set when the lot leaves China → status 'shipping'):
  tracking_no?: string;
  shipped_at?: string; // date the lot left the China warehouse (ETA counts from here)
  // Close-order / production round (set when admin closes the pre-order round):
  production_qty?: number; // จำนวนไฟนอลที่สั่งผลิตจากค่าย
  surplus_qty?: number; // ส่วนเกินจากยอดจอง → กลายเป็นสต๊อกร้าน (production_qty − ordered)
  board_id?: string; // the closing-preorder board this product belongs to (1 product = 1 board)
  maker_code?: string; // optional maker item code shown on the poster (e.g. EL.085)
  created_at: string;
}

/**
 * A "closing pre-order board" (กระดานปิดพรี): a single maker's batch of items the
 * maker is about to stop taking orders for. One board = ONE maker (never mixed).
 * The poster is just a display image (any layout); the bookable items are the
 * products whose board_id points here. Closing the board → all its products → production.
 */
export type BoardStatus = 'open' | 'closed';
export interface PreorderBoard {
  id: string;
  maker_id: string; // ค่าย — always exactly one
  title: string;
  poster_url?: string; // the maker's grid/list poster (display only)
  note?: string;
  status: BoardStatus; // open = accepting bookings / "กำลังปิดพรี"; closed = archived (products → production)
  created_at: string;
  closed_at?: string;
}

/** Immutable snapshot of ONE production round — from either a board close OR a plain ปิดรอบสั่งผลิต
 *  (no board). History log: what each product booked vs. how many were ordered final, at close time.
 *  board_id/board_title are set only when the round came from a board. */
export interface BoardCloseLog {
  id: string;
  board_id?: string;
  board_title: string; // board title, or "ปิดรอบสั่งผลิต" for a non-board round
  maker_id: string;
  closed_at: string;
  lines: { product_id: string; name: string; booked: number; final: number; surplus: number }[];
}

/**
 * A re-opened sale of leftover/surplus stock on the SAME base product (SKU) — a
 * separate lot with its own price/deposit/qty. Existing pre-order buyers are
 * unaffected (their price is snapshotted). `status` 'open' = offered on the shop.
 */
export type BatchStatus = 'open' | 'closed';
export interface ProductBatch {
  id: string;
  product_id: string;
  label: string; // e.g. "สต๊อกเหลือ", "รอบ 2"
  price_total: number;
  deposit_amount: number;
  stock_qty: number;
  status: BatchStatus;
  created_at: string;
}

/** Audit log of a manual stock top-up on a product's surplus (with timestamp). */
export interface StockAddition {
  id: string;
  product_id: string;
  qty: number;
  note?: string;
  created_at: string;
}

/** A 15-min stock hold (server-managed via RPC). Loaded read-only for availability display. */
export type ReservationStatus = 'active' | 'paid' | 'confirmed' | 'released';
export interface StockReservation {
  id: string;
  product_id?: string;
  batch_id?: string;
  user_id?: string;
  order_id?: string;
  qty: number;
  status: ReservationStatus;
  reserved_until?: string;
  created_at?: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  variant_id?: string;
  qty: number;
  deposit_amount: number; // total deposit for this line (= unit_deposit × qty)
  // Price SNAPSHOT captured at order time — locks the customer's price even if the
  // product price is edited later. Optional for back-compat with older rows.
  unit_price?: number;
  unit_deposit?: number;
  batch_id?: string; // set when the buy came from a reopened stock batch
  coupon_id?: string;
}

export interface Order {
  id: string;
  user_id: string;
  total_deposit: number;
  slip_url: string;
  status: OrderStatus;
  created_at: string;
  approved_at?: string;
  reservation_ids?: string[]; // stock holds to confirm on approve / release on reject
  coupon_grant_id?: string; // an in-stock coupon applied at checkout (returned if the order is rejected)
  coupon_discount?: number; // baht discounted by that coupon (already subtracted from total_deposit)
  items: OrderItem[];
}

export interface PreorderTicket {
  id: string;
  ticket_no: string; // OP-2026-06-0001
  product_id: string;
  variant_id?: string;
  batch_id?: string; // bought from a reopened stock batch (for stock accounting + buyers list)
  owner_id: string;
  original_buyer_id: string;
  qty: number;
  deposit_paid: number;
  remaining_amount: number;
  remaining_paid: number;
  status: TicketStatus;
  product_status: ProductStatus; // mirrors the lot status for the timeline
  qr_code_url: string;
  // ในไทย → หน้าบ้านลูกค้า: กรอกเมื่อ ถึงไทย + จ่ายครบ → ตั๋วจบกระบวนการ (status 'shipped')
  carrier?: Carrier;
  parcel_no?: string;
  parcel_image?: string;
  shipped_out_at?: string; // เวลาที่แอดมินกดจัดส่งพัสดุ
  created_at: string;
  approved_at?: string;
}

/** A customer's payment of the remaining balance (ส่วนต่าง) on a ticket, awaiting admin approval. */
export type RemainingPaymentStatus = 'pending' | 'approved';
export interface RemainingPayment {
  id: string;
  ticket_id: string;
  user_id: string;
  amount: number;
  slip_url: string;
  status: RemainingPaymentStatus;
  created_at: string;
  approved_at?: string;
  coupon_grant_id?: string; // a pre-order coupon applied on this final payment
  coupon_discount?: number; // baht discounted (already removed from the ticket's remaining_amount)
}

export interface TicketTransfer {
  id: string;
  ticket_id: string;
  from_user_id: string;
  to_user_id?: string;
  asking_price: number;
  status: TransferStatus;
  note?: string;
  listed_at: string;
  approved_at?: string;
}

/**
 * A discount coupon TEMPLATE (admin-created). Fixed baht off. `scope` decides where it
 * applies: 'preorder' → the final/remaining payment only; 'instock' → at checkout on พร้อมส่ง
 * lines; 'both' → either. Optional `target_*` narrows it to one product or one maker (ค่าย).
 * Coupons are handed to specific customers via CouponGrant rows — there is no public code.
 * Legacy code/type/min_order/used_count kept nullable for column back-compat only. (ryuma-coupon-spec)
 */
export type CouponScope = 'preorder' | 'instock' | 'both';
export interface Coupon {
  id: string;
  label: string; // display name e.g. "ส่วนลด 200 สงกรานต์"
  value: number; // fixed baht off
  scope: CouponScope;
  target_product_id?: string; // restrict to one product (optional)
  target_maker_id?: string; // restrict to one ค่าย (optional)
  expires_at?: string; // ISO date; empty = never expires
  active: boolean; // admin can pause a coupon without deleting it
  created_at: string;
  // legacy columns (unused by the new system, kept so the coupons table stays compatible)
  code?: string;
  type?: 'percent' | 'fixed';
  min_order?: number;
  max_uses?: number;
  used_count?: number;
  rank_required?: RankName;
  campaign_id?: string; // set on coupons auto-generated by an Event reward claim (hidden from the coupon manager)
}

/** One customer's single-use instance of a coupon (admin granted it to them). */
export type CouponGrantStatus = 'active' | 'used' | 'revoked';
export interface CouponGrant {
  id: string;
  coupon_id: string;
  user_id: string;
  status: CouponGrantStatus;
  granted_at: string;
  used_at?: string;
  order_id?: string; // set when redeemed on an in-stock checkout
  ticket_id?: string; // set when redeemed on a pre-order remaining payment
  discount_amount?: number; // baht actually discounted (snapshot)
}

export interface RankTier {
  name: RankName;
  min_spend: number;
  discount_percent: number;
  free_shipping_per_month: number;
  early_access_hours: number;
}

/**
 * Event/กิจกรรม "พรีครบ N รายการ รับคูปอง". Time-bounded; only ONE active at a time (v1).
 * Counting rule (ryuma-event-spec): count = number of the customer's PRE-ORDER tickets
 * (no batch_id = not a stock round) created within [starts_at, ends_at]. Tiers are CUMULATIVE
 * and LOOP: after clearing the top tier a new cycle starts (top-tier threshold is the period).
 * Each reward = coupon_count coupons of coupon_value, granted at CLAIM time as fresh Coupon
 * templates expiring `reward_expiry_days` after the claim.
 */
export interface CampaignTier {
  threshold: number;    // number of pre-order tickets needed (5, 10, …)
  coupon_value: number; // baht per coupon
  coupon_count: number; // how many coupons this tier gives
}
export interface Campaign {
  id: string;
  name: string;
  banner_url?: string;      // homepage banner image
  product_blurb?: string;   // enticing text shown on product pages
  starts_at: string;        // ISO date (inclusive, from start of day)
  ends_at: string;          // ISO date (inclusive, to end of day)
  active: boolean;
  tiers: CampaignTier[];
  reward_scope: CouponScope;      // where the reward coupon can be used ('both' by default)
  reward_expiry_days: number;     // reward coupon expires this many days after it is claimed
  target_maker_id?: string;       // optional: reward coupon restricted to one ค่าย
  target_product_id?: string;     // optional: reward coupon restricted to one product
  created_at: string;
}

/** Record that one earned reward (campaign tier at a loop cycle) was GRANTED to a customer. One row
 *  per (campaign, user, tier_index, cycle) — its existence means "already granted", so it can't be
 *  double-granted. Earned-but-ungranted rewards are computed on the fly (no row until granted). */
export interface CampaignAward {
  id: string;
  campaign_id: string;
  user_id: string;
  tier_index: number; // the tier's THRESHOLD (not its array index) — stable when tiers are edited/reordered
  cycle: number;      // 0-based loop cycle (count period = top-tier threshold)
  claimed_at: string;
  coupon_id?: string; // the auto-generated Coupon template created for this grant
}

export interface User {
  id: string;
  display_name: string;
  facebook_id?: string;
  rank: RankName;
  total_spent: number;
  avatar_url?: string;
  preferred_lang: 'th' | 'en';
  rank_seen?: RankName; // rank the user was already congratulated for (popup shows once)
  // new signups start unapproved; admin approves before they can order.
  // undefined = legacy/seed user (treated as approved).
  approved?: boolean;
  // ระงับชั่วคราว (กันสปาย): admin suspends a dormant new member — catalog RLS (is_app_approved)
  // hides everything from them until unsuspended. Reversible, unlike delete/reject.
  suspended?: boolean;
  member_code?: string; // RYU-000x, assigned by admin on approval (reference only, not a login secret)
  fb_link?: string; // Facebook profile link/name given at signup (admin cross-checks)
  pin_reset?: boolean; // admin allowed this user to set a new PIN (forgot-PIN flow)
  auth_id?: string; // Supabase Auth uid (uuid) this app-user is linked to; RLS keys on it
  is_admin?: boolean; // server-side admin flag (used by RLS is_app_admin())
  // captured after admin approval (phone required = login id, address required, line optional)
  phone?: string;
  shipping_address?: string;
  line_id?: string;
  created_at?: string; // signup time (from users.created_at, backfilled from the auth account)
}

/** A pending/approved request to promote a user's rank (auto-raised at thresholds or admin-forced). */
export type RankRequestStatus = 'pending' | 'approved' | 'rejected';
export interface RankRequest {
  id: string;
  user_id: string;
  from_rank: RankName;
  to_rank: RankName;
  pieces: number; // qty accumulated at request time
  status: RankRequestStatus;
  created_at: string;
  resolved_at?: string;
}

/** A payable account shown at checkout. Multiple may exist; `active` ones are
 *  offered to customers (the first active is the default). */
export interface PaymentAccount {
  id: string;
  name: string; // ชื่อบัญชี / พร้อมเพย์
  number: string; // เลขบัญชี / เบอร์พร้อมเพย์
  qr_url?: string; // Supabase Storage URL of the PromptPay QR image
  active: boolean;
}

export interface ShopSettings {
  bank_name: string;
  bank_account: string;
  promptpay_number: string;
  line_oa_id: string;
  // Pricing calculator config (editable — yuan rate fluctuates):
  // price(฿) = baht_base + (yuan − yuan_base) × baht_per_yuan
  yuan_base: number; // 288
  baht_base: number; // 1550
  baht_per_yuan: number; // 5
  deposit_wcf: number; // 300
  deposit_mega: number; // 500
  eta_min_days: number; // 7  — ETA window after leaving China
  eta_max_days: number; // 10
  // Rank system (piece-based). Thresholds are editable here.
  rank_silver_pieces: number; // 1  — buy/pre-order this many pieces → request Silver
  rank_gold_pieces: number; // 50 — accumulate this many → request Gold
  rank_gold_deposit_pct: number; // 50 — Gold pays this % of the standard deposit (rest rolls into remaining; total unchanged)
  instock_disc_gold_type: 'percent' | 'baht'; // Gold in-stock discount kind
  instock_disc_gold_value: number; // 0 by default
  // homepage hero banner (admin-controlled)
  hero_product_id?: string; // featured product; empty = auto-pick first open pre-order
  hero_image_url?: string; // custom banner image; empty = product image / placeholder
  // homepage promo/announcement carousel (admin-controlled slides, shown above the hero)
  announcements?: PromoBanner[];
}

/** One device's Web-Push subscription (a customer may hold several — phone + desktop).
 *  endpoint is unique per device/browser; keys are the browser-issued encryption pair.
 *  Rows are written by the OWNER (enable toggle) and read by admin to send. */
export interface PushSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

/** A promo/announcement slide on the customer home carousel. */
export interface PromoBanner {
  id: string;
  image_url: string;
  link?: string; // optional: internal path (/shop/xxx) or external URL; empty = not clickable
  caption?: string; // optional alt/label text
}

/** The whole app database as one JSON object (single source of truth). */
export interface Database {
  users: User[];
  categories: Category[];
  manufacturers: Manufacturer[];
  franchises: Franchise[];
  series: Series[];
  products: Product[];
  boards: PreorderBoard[];
  boardLogs: BoardCloseLog[];
  batches: ProductBatch[];
  stockAdditions: StockAddition[];
  variants: ProductVariant[];
  orders: Order[];
  tickets: PreorderTicket[];
  remainingPayments: RemainingPayment[];
  rankRequests: RankRequest[];
  stockReservations: StockReservation[];
  transfers: TicketTransfer[];
  coupons: Coupon[];
  couponGrants: CouponGrant[];
  campaigns: Campaign[];
  campaignAwards: CampaignAward[];
  pushSubscriptions: PushSubscription[];
  rankTiers: RankTier[];
  paymentAccounts: PaymentAccount[];
  settings: ShopSettings;
}
