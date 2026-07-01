/**
 * Domain entities — the shape of the in-memory `Database`, mapped from the PRD
 * data models (design-reference/ryuma-prd.md §7, §10, §12, §17). Field names match
 * the Supabase schema in supabase/schema.sql so the adapter is a straight mapping.
 */

export type ProductType = 'wcf' | 'figure' | 'resin' | 'other';
export type ProductStatus = 'open' | 'production' | 'shipping' | 'arrived' | 'closed';
export type TicketStatus = 'pending_approval' | 'active' | 'paid_full' | 'transferred';
export type OrderStatus = 'pending_approval' | 'approved' | 'rejected';
export type TransferStatus = 'listed' | 'pending_admin' | 'approved' | 'cancelled';
export type RankName = 'bronze' | 'silver' | 'gold' | 'diamond';

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
  franchise_id: string;
  maker_ids: string[];
}

export interface ProductVariant {
  id: string;
  product_id: string;
  name: string; // "Random Box", "Single - Luffy", "Full Set"
  price_total: number;
  deposit_amount: number;
  stock_qty?: number;
}

/** Deposit tier — Mega WCF carries a higher default deposit than standard WCF. */
export type WcfType = 'wcf' | 'mega_wcf';

export interface Product {
  id: string;
  franchise_id: string; // เรื่อง
  manufacturer_id: string; // ค่าย
  series_id?: string; // ซีรีย์ (optional)
  series_name: string; // ชื่อสินค้า (display title)
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
  has_variants: boolean;
  status: ProductStatus;
  // Close-order / production round (set when admin closes the pre-order round):
  production_qty?: number; // จำนวนไฟนอลที่สั่งผลิตจากค่าย
  surplus_qty?: number; // ส่วนเกินจากยอดจอง → กลายเป็นสต๊อกร้าน (production_qty − ordered)
  created_at: string;
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
  items: OrderItem[];
}

export interface PreorderTicket {
  id: string;
  ticket_no: string; // OP-2026-06-0001
  product_id: string;
  variant_id?: string;
  owner_id: string;
  original_buyer_id: string;
  qty: number;
  deposit_paid: number;
  remaining_amount: number;
  remaining_paid: number;
  status: TicketStatus;
  product_status: ProductStatus; // mirrors the lot status for the timeline
  qr_code_url: string;
  created_at: string;
  approved_at?: string;
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

export interface Coupon {
  id: string;
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  min_order: number;
  max_uses?: number;
  used_count: number;
  rank_required?: RankName;
  expires_at?: string;
}

export interface RankTier {
  name: RankName;
  min_spend: number;
  discount_percent: number;
  free_shipping_per_month: number;
  early_access_hours: number;
}

export interface User {
  id: string;
  display_name: string;
  facebook_id?: string;
  rank: RankName;
  total_spent: number;
  avatar_url?: string;
  preferred_lang: 'th' | 'en';
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
}

/** The whole app database as one JSON object (single source of truth). */
export interface Database {
  users: User[];
  categories: Category[];
  manufacturers: Manufacturer[];
  franchises: Franchise[];
  series: Series[];
  products: Product[];
  variants: ProductVariant[];
  orders: Order[];
  tickets: PreorderTicket[];
  transfers: TicketTransfer[];
  coupons: Coupon[];
  rankTiers: RankTier[];
  paymentAccounts: PaymentAccount[];
  settings: ShopSettings;
}
