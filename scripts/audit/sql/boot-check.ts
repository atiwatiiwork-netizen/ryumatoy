import { bootDb } from './pgdb';
(async () => {
  const t0 = Date.now();
  const { db, errors, files } = await bootDb('supabase');
  console.log(`files ${files.length} · errors ${errors.length} · ${Date.now() - t0}ms`);
  for (const e of errors) console.log(`- ${e.file}: ${e.error.slice(0, 140)}\n    ${e.stmt.slice(0, 140)}`);
  const fns = await db.query<{ proname: string }>(`select proname from pg_proc where proname like 'ryuma_market_%' order by 1`);
  console.log('market fns', fns.rows.map((r) => r.proname).join(', '));
})();
