import type { ReactNode } from 'react';
import '../styles/tokens.css';
import './globals.css';
import '../styles/factory-floor.css';

export const metadata = {
  title: 'Software Factory — Control Room',
  description: 'Local-first software factory control room (Control Room Ledger).',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
