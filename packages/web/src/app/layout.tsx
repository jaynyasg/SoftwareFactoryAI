import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Software Factory',
  description: 'Local-first software factory control room',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
