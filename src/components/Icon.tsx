/**
 * Minimal inline-SVG icon set (stroke style, à la lucide). Self-contained so the
 * app needs no icon dependency; swap for `lucide-react` keeping the same names
 * when desired. Pure component — safe in both server and client trees.
 */
export type IconName =
  | 'home' | 'store' | 'wallet' | 'user' | 'bell' | 'search' | 'sliders'
  | 'chevronRight' | 'arrowLeft' | 'arrowRight' | 'heart' | 'share' | 'cart'
  | 'plus' | 'minus' | 'truck' | 'ticket' | 'qr' | 'copy' | 'camera' | 'tag'
  | 'x' | 'check' | 'dashboard' | 'box' | 'swap' | 'settings' | 'logout'
  | 'bolt' | 'chat' | 'warning' | 'verified' | 'payments';

const P: Record<IconName, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  store: 'M3 9l1-5h16l1 5M4 9v11h16V9M4 9h16M9 20v-5h6v5',
  wallet: 'M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2zM16 12h3M3 7l2-3h11l2 3',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  bell: 'M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6M10 21a2 2 0 004 0',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  sliders: 'M4 6h11M19 6h1M4 12h1M9 12h11M4 18h7M15 18h5M15 6v0M5 12v0M11 18v0',
  chevronRight: 'M9 6l6 6-6 6',
  arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  arrowRight: 'M5 12h14M12 5l7 7-7 7',
  heart: 'M12 21s-7-4.6-9.5-9A5 5 0 0112 5a5 5 0 019.5 7c-2.5 4.4-9.5 9-9.5 9z',
  share: 'M4 12v8h16v-8M12 16V3M8 7l4-4 4 4',
  cart: 'M3 4h2l2 13h11l2-9H6M9 21a1 1 0 100-2 1 1 0 000 2zM18 21a1 1 0 100-2 1 1 0 000 2z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  truck: 'M3 6h11v9H3zM14 9h4l3 3v3h-7M7 18a2 2 0 100-3 2 2 0 000 3zM18 18a2 2 0 100-3 2 2 0 000 3z',
  ticket: 'M4 7a2 2 0 012-2h12a2 2 0 012 2 2 2 0 000 4 2 2 0 000 4 2 2 0 01-2 2H6a2 2 0 01-2-2 2 2 0 000-4 2 2 0 000-4zM14 5v14',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  camera: 'M4 8h3l2-2h6l2 2h3v12H4zM12 17a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
  tag: 'M3 3h8l10 10-8 8L3 11zM7.5 7.5v0',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l4 4 10-10',
  dashboard: 'M3 3h8v8H3zM13 3h8v5h-8zM13 11h8v10h-8zM3 13h8v8H3z',
  box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8',
  swap: 'M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.2-1.6l2-1.5-2-3.4-2.3 1a7 7 0 00-2.8-1.6L13.5 2h-3l-.4 2.3a7 7 0 00-2.8 1.6l-2.3-1-2 3.4 2 1.5A7 7 0 005 12a7 7 0 00.2 1.6l-2 1.5 2 3.4 2.3-1a7 7 0 002.8 1.6l.4 2.3h3l.4-2.3a7 7 0 002.8-1.6l2.3 1 2-3.4-2-1.5A7 7 0 0019 12z',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  chat: 'M21 12a8 8 0 01-11.5 7.2L4 21l1.8-5.5A8 8 0 1121 12z',
  warning: 'M12 3l9 16H3zM12 10v4M12 17v0',
  verified: 'M12 2l2.4 1.8 3 .3 1 2.8 2.2 2-1 2.8.4 3-2.6 1.5-1.4 2.6-3-.4-2.6 1.5-2.6-1.5-3 .4-1.4-2.6L2.4 16l1-2.8-2.2-2 2.2-2-1-2.8 3-.3zM9 12l2 2 4-4',
  payments: 'M2 7h16v9H2zM2 11h16M6 19h16v-9M9 11.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z',
};

export function Icon({
  name,
  size = 22,
  strokeWidth = 1.8,
  fill = 'none',
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  fill?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0 }}
      aria-hidden
    >
      <path d={P[name]} />
    </svg>
  );
}
