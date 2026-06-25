import type { ReactNode } from 'react';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';

export const metadata = {
  title: 'liquidity-tax',
  description: 'DeFi position & tax dashboard',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Sidebar />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
