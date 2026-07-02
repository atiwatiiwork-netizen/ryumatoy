import type { Database } from '../domain/entities';

/**
 * Seed database — realistic sample content so the preview is playable without a
 * Supabase connection. Mirrors the catalog/ticket shapes in the PRD. Product
 * images are left empty on purpose; the UI renders the striped placeholder.
 */

const ME = 'u-me'; // the logged-in customer in preview

export const CURRENT_USER_ID = ME;

export const SEED_DATABASE: Database = {
  users: [
    { id: ME, display_name: 'Atiwat T.', facebook_id: 'fb-001', rank: 'bronze', total_spent: 32400, preferred_lang: 'th', rank_seen: 'bronze' },
    { id: 'u-2', display_name: 'Ploy K.', facebook_id: 'fb-002', rank: 'silver', total_spent: 8200, preferred_lang: 'th' },
    { id: 'u-3', display_name: 'Nut R.', facebook_id: 'fb-003', rank: 'diamond', total_spent: 64000, preferred_lang: 'th' },
    { id: 'u-admin', display_name: 'Ryuma Admin', rank: 'diamond', total_spent: 0, preferred_lang: 'th' },
  ],

  categories: [
    { id: 'cat-wcf', name: 'WCF', active: true },
    { id: 'cat-resin', name: 'Resin', active: false },
    { id: 'cat-bandai', name: 'Bandai', active: false },
  ],

  manufacturers: [
    { id: 'm-bandai', name: 'Bandai', category_id: 'cat-wcf' },
    { id: 'm-megahouse', name: 'MegaHouse', category_id: 'cat-wcf' },
    { id: 'm-prime1', name: 'Prime1Studio', category_id: 'cat-resin' },
  ],

  franchises: [
    { id: 'f-op', name: 'One Piece', abbr: 'op' },
    { id: 'f-nr', name: 'Naruto', abbr: 'nr' },
    { id: 'f-db', name: 'Dragon Ball', abbr: 'db' },
    { id: 'f-bl', name: 'Bleach', abbr: 'bl' },
  ],

  series: [
    { id: 's-op-wcf', name: 'WCF Vol.38', franchise_id: 'f-op', maker_ids: ['m-bandai', 'm-megahouse'] },
    { id: 's-nr-gem', name: 'GEM Series', franchise_id: 'f-nr', maker_ids: ['m-megahouse'] },
  ],

  products: [
    {
      id: 'p-1', franchise_id: 'f-op', manufacturer_id: 'm-bandai', series_id: 's-op-wcf', series_name: 'Luffy Gear 5', type: 'wcf',
      description: 'World Collectable Figure ลอตใหม่ล่าสุด ลูฟี่กียร์ 5 พร้อมฐานพิเศษ',
      images: [], eta_note: 'Q3 2026', price_total: 1290, deposit_amount: 590,
      is_stock: false, has_variants: true, status: 'open', created_at: '2026-06-20',
    },
    {
      id: 'p-2', franchise_id: 'f-nr', manufacturer_id: 'm-megahouse', series_id: 's-nr-gem', series_name: 'Uchiha Sasuke', type: 'figure',
      description: 'GEM Series ซาสึเกะ ดีเทลสูง พร้อมเอฟเฟกต์ชิโดริ',
      images: [], eta_note: 'Q4 2026', price_total: 4200, deposit_amount: 1500,
      is_stock: false, has_variants: false, status: 'production', created_at: '2026-06-12',
    },
    {
      id: 'p-3', franchise_id: 'f-db', manufacturer_id: 'm-prime1', series_name: 'Super Saiyan Goku 1/4', type: 'resin',
      description: 'เรซินสเกล 1/4 โกคูซูเปอร์ไซย่า งานปั้นพรีเมียม Prime1Studio',
      images: [], eta_note: 'Q1 2027', price_total: 28900, deposit_amount: 9000,
      is_stock: false, has_variants: false, status: 'shipping', created_at: '2026-05-30',
    },
    {
      id: 'p-4', franchise_id: 'f-op', manufacturer_id: 'm-bandai', series_name: 'Zoro', type: 'wcf',
      description: 'โซโลลอตก่อนหน้า ถึงไทยแล้ว พร้อมเรียกเก็บส่วนต่าง',
      images: [], eta_note: 'ถึงไทยแล้ว', price_total: 1190, deposit_amount: 500,
      is_stock: false, has_variants: false, status: 'arrived', created_at: '2026-04-18',
    },
    {
      id: 'p-5', franchise_id: 'f-bl', manufacturer_id: 'm-megahouse', series_name: 'Kurosaki Ichigo', type: 'figure',
      description: 'อิจิโกะร่างบังไค พร้อมส่งทันที',
      images: [], eta_note: 'พร้อมส่ง', price_total: 3600, deposit_amount: 3600,
      is_stock: true, stock_qty: 4, has_variants: false, status: 'open', created_at: '2026-06-25',
    },
    {
      id: 'p-6', franchise_id: 'f-nr', manufacturer_id: 'm-megahouse', series_name: 'Kakashi Hatake', type: 'wcf',
      description: 'คาคาชิ WCF พร้อมส่ง',
      images: [], eta_note: 'พร้อมส่ง', price_total: 890, deposit_amount: 890,
      is_stock: true, stock_qty: 7, has_variants: false, status: 'open', created_at: '2026-06-22',
    },
  ],

  boards: [],

  batches: [],

  stockAdditions: [],

  variants: [
    { id: 'v-1a', product_id: 'p-1', name: 'Random Box (สุ่ม)', price_total: 1290, deposit_amount: 590 },
    { id: 'v-1b', product_id: 'p-1', name: 'Single — Luffy', price_total: 1490, deposit_amount: 690 },
    { id: 'v-1c', product_id: 'p-1', name: 'Full Set (6 ตัว)', price_total: 6900, deposit_amount: 3000 },
  ],

  orders: [
    {
      id: 'o-1', user_id: 'u-2', total_deposit: 2090, slip_url: '', status: 'pending_approval',
      created_at: '2026-06-29T10:24:00',
      items: [
        { id: 'oi-1', order_id: 'o-1', product_id: 'p-1', variant_id: 'v-1a', qty: 1, deposit_amount: 590 },
        { id: 'oi-2', order_id: 'o-1', product_id: 'p-2', qty: 1, deposit_amount: 1500 },
      ],
    },
    {
      id: 'o-2', user_id: 'u-3', total_deposit: 9000, slip_url: '', status: 'pending_approval',
      created_at: '2026-06-30T08:05:00',
      items: [{ id: 'oi-3', order_id: 'o-2', product_id: 'p-3', qty: 1, deposit_amount: 9000 }],
    },
  ],

  tickets: [
    {
      id: 't-1', ticket_no: 'OP-2026-06-0001', product_id: 'p-1', variant_id: 'v-1b', owner_id: ME,
      original_buyer_id: ME, qty: 1, deposit_paid: 690, remaining_amount: 800, remaining_paid: 0,
      status: 'active', product_status: 'open', qr_code_url: '', created_at: '2026-06-21', approved_at: '2026-06-21',
    },
    {
      id: 't-2', ticket_no: 'NR-2026-06-0007', product_id: 'p-2', owner_id: ME,
      original_buyer_id: ME, qty: 1, deposit_paid: 1500, remaining_amount: 2700, remaining_paid: 0,
      status: 'active', product_status: 'production', qr_code_url: '', created_at: '2026-06-13', approved_at: '2026-06-13',
    },
    {
      id: 't-3', ticket_no: 'OP-2026-04-0012', product_id: 'p-4', owner_id: ME,
      original_buyer_id: ME, qty: 1, deposit_paid: 500, remaining_amount: 690, remaining_paid: 690,
      status: 'paid_full', product_status: 'arrived', qr_code_url: '', created_at: '2026-04-19', approved_at: '2026-04-19',
    },
  ],

  remainingPayments: [],

  rankRequests: [],

  stockReservations: [],

  transfers: [
    { id: 'tr-1', ticket_id: 't-3', from_user_id: ME, asking_price: 1500, status: 'listed', note: 'จ่ายครบแล้ว พร้อมโอน', listed_at: '2026-06-28' },
  ],

  coupons: [
    { id: 'c-1', code: 'RYUMA50', type: 'fixed', value: 50, min_order: 500, used_count: 12, max_uses: 100 },
    { id: 'c-2', code: 'GOLD5', type: 'percent', value: 5, min_order: 0, used_count: 3, rank_required: 'gold' },
  ],

  rankTiers: [
    { name: 'bronze', min_spend: 0, discount_percent: 0, free_shipping_per_month: 0, early_access_hours: 0 },
    { name: 'silver', min_spend: 5000, discount_percent: 3, free_shipping_per_month: 0, early_access_hours: 0 },
    { name: 'gold', min_spend: 20000, discount_percent: 5, free_shipping_per_month: 1, early_access_hours: 24 },
    { name: 'diamond', min_spend: 50000, discount_percent: 8, free_shipping_per_month: 99, early_access_hours: 48 },
  ],

  paymentAccounts: [
    { id: 'pay-1', name: 'Ryuma Toy Shop', number: '081-234-5678', active: true },
  ],

  settings: {
    bank_name: 'ไทยพาณิชย์ (SCB)',
    bank_account: 'Ryuma Toy Shop',
    promptpay_number: '081-234-5678',
    line_oa_id: '@ryumatoy',
    yuan_base: 288,
    baht_base: 1550,
    baht_per_yuan: 5,
    deposit_wcf: 300,
    deposit_mega: 500,
    eta_min_days: 7,
    eta_max_days: 10,
    rank_silver_pieces: 1,
    rank_gold_pieces: 50,
    rank_gold_deposit_pct: 50,
    instock_disc_gold_type: 'percent',
    instock_disc_gold_value: 0,
    announcements: [],
  },
};
