import { writeFileSync } from 'node:fs';
import { bootDb } from './pgdb';
(async () => {
  const { db, errors } = await bootDb('supabase');
  console.log('errors', errors.length);
  const r = await db.query<{ name: string; def: string }>(`select p.proname as name, pg_get_functiondef(p.oid) as def from pg_proc p
    where p.pronamespace = 'public'::regnamespace and (p.proname like 'ryuma_market%' or p.proname like 'ryuma_wallet%' or p.proname in ('reserve_ticket_nos','ryuma_guard_tickets','ryuma_split_share','ryuma_ticket_market_history','ryuma_ticket_transferred','ryuma_transfers_keep_recipient','ryuma_transfers_payout_vault','ryuma_order_items_market_lock','ryuma_tickets_market_nodelete')) order by 1`);
  writeFileSync(process.argv[2], r.rows.map((x) => `-- ===== ${x.name}\n${x.def}`).join('\n\n'));
  const t = await db.query<{ tgname: string; relname: string; fn: string }>(`select t.tgname, c.relname, p.proname fn from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid where not t.tgisinternal and c.relname in ('ticket_transfers','preorder_tickets','remaining_payments','order_items','users') order by 2,1`);
  console.log(t.rows.map((x) => `${x.relname}.${x.tgname}→${x.fn}`).join('\n'));
  const pol = await db.query<{ tablename: string; policyname: string; cmd: string; qual: string }>(`select tablename, policyname, cmd, qual from pg_policies where tablename in ('preorder_tickets','ticket_transfers','ticket_transfer_payouts','stock_reservations') order by 1,2`);
  console.log(pol.rows.map((x) => `${x.tablename}.${x.policyname}(${x.cmd}) ${x.qual}`).join('\n'));
})();
