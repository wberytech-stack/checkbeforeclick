import Link from "next/link"
import { Shield } from "lucide-react"

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div className="flex items-center gap-8">
              <Link href="/dashboard" className="flex items-center gap-2">
                <Shield className="h-6 w-6 text-slate-900" />
                <span className="font-bold text-slate-900">CheckBeforeClick</span>
              </Link>
              <div className="hidden md:flex items-center gap-6">
                <Link href="/dashboard" className="text-sm font-medium text-slate-900">
                  Dashboard
                </Link>
                <Link href="/scan/new" className="text-sm text-slate-500 hover:text-slate-900">
                  New scan
                </Link>
                <Link href="/history" className="text-sm text-slate-500 hover:text-slate-900">
                  History
                </Link>
                <Link href="/watchlist" className="text-sm text-slate-500 hover:text-slate-900">
                  Watchlist
                </Link>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-slate-500">My Organization</span>
              <Link
                href="/auth/signout"
                className="text-sm text-slate-500 hover:text-slate-900"
              >
                Sign out
              </Link>
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  )
}
