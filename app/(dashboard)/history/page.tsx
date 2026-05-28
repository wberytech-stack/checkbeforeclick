import Link from "next/link"

export default function HistoryPage() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-bold text-slate-900">Scan history</h1>
      <p className="mt-3 text-sm text-slate-500">
        Scan history is coming soon. For now, use your dashboard to view recent scan activity.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 inline-flex rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
      >
        Back to dashboard
      </Link>
    </div>
  )
}
