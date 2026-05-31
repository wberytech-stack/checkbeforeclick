import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Search,
  Loader2,
  Link as LinkIcon,
  Mail,
  FileText,
  Activity,
} from "lucide-react"

type Verdict = "safe" | "suspicious" | "dangerous" | "unknown"
type ScanStatus = "pending" | "processing" | "complete" | "failed"

type ScanRow = {
  id: string
  raw_input: string
  input_type: string
  verdict: Verdict | null
  status: ScanStatus
  created_at: string
  risk_score: number | null
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return "Just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

const inputTypeLabels: Record<string, string> = {
  url: "Link",
  domain: "Domain",
  email: "Email",
  header: "Header",
}

function ActivityRow({ scan }: { scan: ScanRow }) {
  const isInProgress = scan.status === "pending" || scan.status === "processing"
  const isFailed = scan.status === "failed"

  let tileBg = "bg-green-50"
  let tileColor = "text-green-600"
  let Icon = LinkIcon
  let badgeLabel = "Safe"
  let badgeClass = "text-green-700 bg-green-50"

  if (isInProgress) {
    tileBg = "bg-cbc-primary-soft"
    tileColor = "text-cbc-primary"
    Icon = Loader2
    badgeLabel = "Checking…"
    badgeClass = "text-cbc-muted bg-cbc-surface-warm"
  } else if (isFailed) {
    tileBg = "bg-cbc-surface-warm"
    tileColor = "text-cbc-muted"
    Icon = scan.input_type === "email" ? Mail : FileText
    badgeLabel = "Failed"
    badgeClass = "text-cbc-muted bg-cbc-surface-warm"
  } else if (scan.verdict === "dangerous") {
    tileBg = "bg-red-50"
    tileColor = "text-red-600"
    Icon = ShieldX
    badgeLabel = "Do not open"
    badgeClass = "text-red-700 bg-red-50"
  } else if (scan.verdict === "suspicious") {
    tileBg = "bg-amber-50"
    tileColor = "text-amber-600"
    Icon = ShieldAlert
    badgeLabel = "Be careful"
    badgeClass = "text-amber-700 bg-amber-50"
  } else if (scan.verdict === "unknown") {
    tileBg = "bg-cbc-surface-warm"
    tileColor = "text-cbc-muted"
    Icon = ShieldAlert
    badgeLabel = "Unclear"
    badgeClass = "text-cbc-muted bg-cbc-surface-warm"
  } else {
    Icon = scan.input_type === "email" ? Mail : scan.input_type === "header" ? FileText : LinkIcon
  }

  return (
    <Link
      href={`/scan/${scan.id}`}
      className="flex items-center gap-3 px-5 py-3.5 border-b border-cbc-border last:border-0 hover:bg-cbc-surface-warm transition-colors"
    >
      <div className={`w-9 h-9 rounded-lg ${tileBg} flex items-center justify-center flex-shrink-0`}>
        <Icon className={`h-4 w-4 ${tileColor} ${isInProgress ? "animate-spin" : ""}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-cbc-ink truncate">{scan.raw_input}</p>
        <p className="text-xs text-cbc-muted mt-0.5">
          {inputTypeLabels[scan.input_type] ?? scan.input_type} · {formatRelativeTime(scan.created_at)}
        </p>
      </div>
      <span className={`text-xs font-medium px-2.5 py-1 rounded-md flex-shrink-0 ${badgeClass}`}>
        {badgeLabel}
      </span>
    </Link>
  )
}

export default async function DashboardPage() {
  const authClient = await createClient()
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser()

  if (authError || !user) {
    redirect("/login")
  }

  const supabase = createServiceClient()
  const { data: userRecord } = await supabase
    .from("users")
    .select("id, organization_id, full_name")
    .eq("id", user.id)
    .single()

  if (!userRecord) {
    redirect("/login")
  }

  const { data: completedScans } = await supabase
    .from("scans")
    .select("verdict, created_at")
    .eq("organization_id", userRecord.organization_id)
    .eq("status", "complete")

  const counts = { dangerous: 0, suspicious: 0, safe: 0 }
  if (completedScans) {
    for (const s of completedScans) {
      if (s.verdict === "dangerous") counts.dangerous++
      else if (s.verdict === "suspicious") counts.suspicious++
      else if (s.verdict === "safe") counts.safe++
    }
  }

  // Total checked this week — org-scoped, last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString()
  const { count: weekCount } = await supabase
    .from("scans")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", userRecord.organization_id)
    .gte("created_at", sevenDaysAgo)

  const { data: recentScans } = await supabase
    .from("scans")
    .select("id, raw_input, input_type, verdict, status, created_at, risk_score")
    .eq("organization_id", userRecord.organization_id)
    .order("created_at", { ascending: false })
    .limit(10)

  const scans = (recentScans ?? []) as ScanRow[]
  const hasScans = scans.length > 0
  const firstName = userRecord.full_name?.trim()?.split(" ")[0] || null

  const hour = new Date().getHours()
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-cbc-ink tracking-tight">
            {firstName ? `${greeting}, ${firstName}` : greeting}
          </h1>
          <p className="text-sm text-cbc-muted mt-1">
            Here's what your team has checked recently
          </p>
        </div>
        <Link href="/scan/new">
          <button className="flex items-center gap-2 bg-cbc-ink text-cbc-primary-fg rounded-lg px-4 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity">
            <Search className="h-4 w-4" />
            Check something
          </button>
        </Link>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-cbc-surface border border-cbc-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-cbc-muted">Total checked</span>
            <Activity className="h-4 w-4 text-cbc-primary" />
          </div>
          <p className="text-3xl font-semibold text-cbc-ink leading-none">{weekCount ?? 0}</p>
          <p className="text-xs text-cbc-muted mt-2">this week</p>
        </div>

        <div className="bg-cbc-surface border border-cbc-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-cbc-muted">Do not open</span>
            <span className="w-2 h-2 rounded-full bg-red-500" />
          </div>
          <p className="text-3xl font-semibold text-red-600 leading-none">{counts.dangerous}</p>
          <p className="text-xs text-cbc-muted mt-2">confirmed threats</p>
        </div>

        <div className="bg-cbc-surface border border-cbc-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-cbc-muted">Be careful</span>
            <span className="w-2 h-2 rounded-full bg-amber-500" />
          </div>
          <p className="text-3xl font-semibold text-amber-600 leading-none">{counts.suspicious}</p>
          <p className="text-xs text-cbc-muted mt-2">needs caution</p>
        </div>

        <div className="bg-cbc-surface border border-cbc-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-cbc-muted">Looks safe</span>
            <span className="w-2 h-2 rounded-full bg-green-500" />
          </div>
          <p className="text-3xl font-semibold text-green-600 leading-none">{counts.safe}</p>
          <p className="text-xs text-cbc-muted mt-2">cleared</p>
        </div>
      </div>

      {/* Recent activity */}
      <div className="bg-cbc-surface border border-cbc-border rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-cbc-border">
          <span className="text-sm font-medium text-cbc-ink">Recent activity</span>
          {hasScans && (
            <Link href="/history" className="text-xs text-cbc-primary hover:opacity-80">
              View all
            </Link>
          )}
        </div>

        {hasScans ? (
          <div>
            {scans.map((scan) => (
              <ActivityRow key={scan.id} scan={scan} />
            ))}
          </div>
        ) : (
          <div className="text-center py-14 px-5">
            <div className="w-12 h-12 rounded-xl bg-cbc-primary-soft flex items-center justify-center mx-auto mb-4">
              <ShieldCheck className="h-6 w-6 text-cbc-primary" />
            </div>
            <p className="text-cbc-ink font-medium">No scans yet</p>
            <p className="text-cbc-muted text-sm mt-1 max-w-xs mx-auto">
              Paste a suspicious link or email and get a clear verdict in seconds
            </p>
            <Link href="/scan/new" className="mt-5 inline-block">
              <button className="bg-cbc-ink text-cbc-primary-fg rounded-lg px-4 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity">
                Run your first scan
              </button>
            </Link>
          </div>
        )}
      </div>

    </div>
  )
}