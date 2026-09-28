import { bootDb } from './pgdb';
(async () => {
  const { db } = await bootDb('supabase');
  for (const t of ['users', 'products', 'franchises', 'manufacturers', 'orders', 'order_items', 'preorder_tickets', 'remaining_payments', 'ticket_transfers', 'product_batches', 'product_variants', 'shop_settings', 'sourcing_requests', 'push_subscriptions', 'push_prefs', 'rank_tiers', 'series']) {
    const r = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [t]);
    console.log(`${t}: ` + r.rows.map((c) => `${c.column_name}${c.is_nullable === 'NO' ? '!' : ''}:${c.data_type.replace('timestamp with time zone', 'tstz').replace('character varying', 'varchar')}${c.column_default ? '=' + c.column_default.slice(0, 18) : ''}`).join(', '));
  }
  const trg = await db.query<{ tgname: string; relname: string }>(`select t.tgname, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace order by 2, 1`);
  console.log('\ntriggers: ' + trg.rows.map((r) => `${r.relname}.${r.tgname}`).join(', '));
  const pol = await db.query<{ tablename: string; policyname: string; cmd: string }>(`select tablename, policyname, cmd from pg_policies where tablename in ('preorder_tickets','ticket_transfers','remaining_payments','users') order by 1,2`);
  console.log('\npolicies: ' + pol.rows.map((r) => `${r.tablename}.${r.policyname}(${r.cmd})`).join(', '));
})();
