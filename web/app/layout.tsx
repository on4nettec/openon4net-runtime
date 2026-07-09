import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Open on4net',
  description: 'O2N Runtime — Digital Employees dashboard',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
