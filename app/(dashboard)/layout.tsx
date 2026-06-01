"use client"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { BrandLockup } from "@/components/brand/BrandLockup"
import { createClient } from "@/lib/supabase/client"

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push("/login")
    router.refresh()
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Top bar */}
          <div className="flex justify-between h-16 items-center">
            <div className="flex items-center gap-8">
              <Link href="/dashboard" className="flex items-center">
                <BrandLockup size={26} />
              </Link>
              {/* Desktop nav */}
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
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>

        {/* Mobile nav — always visible below top bar on small screens */}
        <div className="md:hidden border-t border-slate-100 overflow-x-auto">
          <div className="flex gap-6 px-4 py-3 text-sm whitespace-nowrap">
            <Link href="/dashboard" className="font-medium text-slate-900">
              Dashboard
            </Link>
            <Link href="/scan/new" className="text-slate-500 hover:text-slate-900">
              New scan
            </Link>
            <Link href="/history" className="text-slate-500 hover:text-slate-900">
              History
            </Link>
            <Link href="/watchlist" className="text-slate-500 hover:text-slate-900">
              Watchlist
            </Link>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  )
}