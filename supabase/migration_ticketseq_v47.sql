-- ============================================================================
-- Ryuma - v47: server-side ATOMIC ticket_no allocation (fixes cross-customer collision).
-- Paste into the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- WHY: ticket_no was numbered client-side by counting db.tickets. In a CUSTOMER
-- session RLS shows only that customer's own tickets, so the count under-counts and
-- collides with numbers other customers already hold (ticket_no is globally UNIQUE)
-- → the insert fails → the ticket silently vanishes. This function hands out numbers
-- from the server, which sees ALL rows, so numbers are unique + race-free.
--
-- reserve_ticket_nos(prefix, count) reserves `count` consecutive numbers for a prefix
-- (e.g. 'OP-2026-07') and returns the FIRST number of the block. It self-corrects:
-- it never returns a number <= the real max already issued for that prefix, so it
-- stays collision-free even alongside any client-side numbering that remains (admin
-- approve / repairTickets, which run with full visibility anyway).
--
-- NOTE: this SUPERSEDES the earlier draft `next_ticket_nos` (which started counters at
-- 0 and could collide with tickets already issued). We drop that draft below and use a
-- new name, so the app safely falls back to client numbering until this file is applied.
-- ============================================================================

drop function if exists next_ticket_nos(text, int);   -- remove the unsafe draft

create table if not exists ticket_counters (
  prefix text primary key,
  n int not null default 0
);
alter table ticket_counters enable row level security;
-- No RLS policy on purpose: only the SECURITY DEFINER function below touches this table;
-- clients call the function, never the table directly.

create or replace function reserve_ticket_nos(p text, c int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  cnt int := greatest(coalesce(c, 1), 1);
  real_max int;
  start_n int;
begin
  -- highest number already issued for this prefix (server sees every row, ignoring RLS)
  select coalesce(max((substring(ticket_no from '(\d+)$'))::int), 0)
    into real_max
    from preorder_tickets
   where ticket_no like p || '-%';

  insert into ticket_counters(prefix, n) values (p, 0)
    on conflict (prefix) do nothing;

  update ticket_counters
     set n = greatest(n, real_max) + cnt
   where prefix = p
   returning n - cnt + 1 into start_n;

  return start_n;
end;
$$;

grant execute on function reserve_ticket_nos(text, int) to authenticated, anon;

-- self-check (optional):
-- select reserve_ticket_nos('TEST-2026-07', 3);  -- returns max(existing,counter)+1 for that prefix
