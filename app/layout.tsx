import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
        <main className="flex-1">{children}</main>
        <footer className="border-t px-4 py-4 text-center text-xs text-muted-foreground">
          © 2026 Wabcan Inc. CheckBeforeClick is a product of Wabcan Inc.
        </footer>
      </body>
    </html>
  )
}
