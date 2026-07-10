import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Thai, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600', '700', '800'], variable: '--font-inter' });
const thai = Noto_Sans_Thai({ subsets: ['thai'], weight: ['400', '500', '600', '700', '800'], variable: '--font-thai' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['500'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Ryuma · ริวมะ — Pre-order Figure & WCF',
  description: 'พรีออเดอร์ Figure, WCF, Resin หลากหลาย Franchise — จองด้วยมัดจำผ่าน PromptPay ติดตามใบพรีแบบดิจิทัล',
  // iOS "Add to Home Screen" reads apple-touch-icon (else it renders a letter tile);
  // Android/Chrome installs read manifest.json. appleWebApp.title keeps the icon label short ("Ryuma").
  icons: { icon: '/ryuma-logo.png', apple: '/apple-touch-icon.png' },
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'Ryuma', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#0a0809',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={`${inter.variable} ${thai.variable} ${mono.variable}`}>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
