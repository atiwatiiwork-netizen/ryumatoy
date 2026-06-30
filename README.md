# Ryuma (ริวมะ) — Next.js + Tailwind build

The **PRD-spec** build of Ryuma: **Next.js (App Router) + Tailwind CSS + TypeScript + Supabase**,
deploy on **Vercel** (see `../RyumaToyApp/design-reference/ryuma-prd.md` §2). This is the
sibling of the Vite preview in `../RyumaToyApp` — same domain logic, real URL routing
+ SSR-ready rendering + Tailwind design system.

## Run

```bash
npm install
npm run dev      # http://localhost:3000
```

No Supabase keys needed for the preview — boots on seed data (`src/data/seed.ts`) in
`localStorage`. Floating switch (bottom-right) jumps between the customer site and `/admin`.

## Routes (PRD §19)

| URL | Screen |
|---|---|
| `/` | Home (responsive: mobile PWA ↔ desktop top-nav) |
| `/shop`, `/shop/[id]` | Catalog + product detail |
| `/cart`, `/checkout` | Cart + PromptPay checkout (slip upload) |
| `/wallet`, `/wallet/[ticketNo]` | Digital wallet + ticket (QR, timeline, P2P) |
| `/profile` | Profile + rank |
| `/admin`, `/admin/orders/[id]` | Dashboard + slip approval |
| `/api/line-send` | LINE push (server route) |

## Structure

```
src/
  app/
    layout.tsx            root: next/font, Providers
    (customer)/           customer route group → CustomerShell (responsive)
    admin/                admin route group → AdminShell (desktop side-nav)
    api/line-send/route.ts
  components/             Tailwind UI + shells + Icon
  domain/                entities + pure services  (shared with the Vite build)
  data/                  seed, store, persistence, mutations
  state/                 DataProvider, CartProvider, ToastProvider ('use client')
  lib/theme.ts           status / rank className maps + baht()
tailwind.config.ts        Ryuma design tokens (HANDOFF.md §Design Tokens)
```

Design tokens live in `tailwind.config.ts`; status/rank palettes (paired text/bg/border
keyed by a runtime value) live in `src/lib/theme.ts`.

## Production
1. Supabase project → run `supabase/schema.sql` → enable Facebook OAuth.
2. `.env.local.example` → `.env.local`, fill `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Implement a Supabase adapter and point `src/data/store.ts` at it when `hasSupabase`.
4. Deploy to Vercel (Next.js is first-class). Set `LINE_CHANNEL_TOKEN`.
