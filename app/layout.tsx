import type { Metadata, Viewport } from 'next';
import { Noto_Sans_JP } from 'next/font/google';
import './globals.css';

const noto = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-noto',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ごみ分別アプリ - 長野市',
  description: '長野市のごみ分別・収集カレンダーアプリ',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#1a1a2e',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={noto.variable}>
      <body className="font-sans antialiased">
        <div className="min-h-screen bg-slate-100 flex justify-center">
          <div className="w-full max-w-md min-h-screen bg-slate-100 relative">
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
