import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = { title: 'سوق غزة | Gaza Store', description: 'سوق غزة المحلي — منتجات، خدمات، وفرص من أهل غزة' }

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>
}
