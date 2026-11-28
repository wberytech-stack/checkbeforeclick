import type { Metadata } from "next"
import localFont from "next/font/local"
import "./globals.css"

const geistSans = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  style: "normal",
  display: "swap",
})

const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  style: "normal",
  display: "swap",
})

export const metadata: Metadata = {
  title: "CheckBeforeClick",
  description: "Suspicious link and email checker",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className={`${geistSans.className} min-h-full flex flex-col`}>
        <div className="min-h-0 flex-1">{children}</div>
        <footer className="border-t px-4 py-4 text-center text-xs text-muted-foreground">
          © 2026 Wabcan Inc. CheckBeforeClick is a product of Wabcan Inc.
        </footer>
      </body>
    </html>
  )
}
