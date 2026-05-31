import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  ShieldQuestion,
  Search,
  Loader2,
  ExternalLink,
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

function RecentScanBadge({ status, verdict }: { status: ScanStatus; verdict: Verdict | null }) {
  if (status === "pending" || status === "processing") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking…
      </span>
    )
  }
  if (status === "failed") {
    return <span className="text-xs font-medium text-slate-400">Failed</span>
  }
  const config: Record<Verdict, { label: string; color: string }> = {
    safe: { label: "Safe", color: "text-green-600" },
    suspicious: { label: "Be careful", color: "text-amber-600" },
    dangerous: { label: "Do not open", color: "text-red-600" },
    unknown: { label: "Unclear", color: "text-slate-500" },
  }
  const c = verdict && verdict in config ? config[verdict] : config.unknown
  return <span className={`text-xs font-semibold ${c.color}`}>{c.label}</span>
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

export default async function DashboardPage() {
  // 1. Authenticate user server-side
  const authClient = await createClient()
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser()

  if (authError || !user) {
    redirect("/login")
  }

  // 2. Load organization_id from public.users — never trust client
  const supabase = createServiceClient()
  const { data: userRecord } = await supabase
    .from("users")
    .select("id, organization_id, full_name")
    .eq("id", user.id)
    .single()

  if (!userRecord) {
    redirect("/login")
  }

  // 3. Count query — completed scans only, org-scoped
  const { data: completedScans } = await supabase
    .from("scans")
    .select("verdict")
    .eq("organization_id", userRecord.organization_id)
    .eq("status", "complete")

  const counts = {
    dangerous: 0,
    suspicious: 0,
    safe: 0,
  }
  if (completedScans) {
    for (const s of completedScans) {
      if (s.verdict === "dangerous") counts.dangerous++
      else if (s.verdict === "suspicious") counts.suspicious++
      else if (s.verdict === "safe") counts.safe++
    }
  }

  // 4. Recent scans — all statuses, org-scoped, newest first
  const { data: recentScans } = await supabase
    .from("scans")
    .select("id, raw_input, input_type, verdict, status, created_at, risk_score")
    .eq("organization_id", userRecord.organization_id)
    .order("created_at", { ascending: false })
    .limit(10)

  const scans = (recentScans ?? []) as ScanRow[]
  const hasScans = scans.length > 0
  const firstName = userRecord.full_name?.trim()?.split(" ")[0] || null

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-1">
            {firstName ? `Welcome back, ${firstName}` : "Welcome to CheckBeforeClick"}
          </p>
        </div>
        <Link href="/scan/new">
          <Button className="flex items-center gap-2">
            <Search className="h-4 w-4" />
            Check it now
          </Button>
        </Link>
      </div>

      {/* CTA banner */}
      <div className="bg-slate-900 rounded-lg p-6 flex items-center justify-between">
        <div>
          <p className="text-slate-300 text-sm font-medium">
            Got a suspicious email or link?
          </p>
          <p className="text-white text-lg font-semibold mt-1">
            Paste it and get a verdict in seconds
          </p>
        </div>
        <Link href="/scan/new">
          <Button variant="outline" className="bg-white text-slate-900 hover:bg-slate-100">
            Check it now
          </Button>
        </Link>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Dangerous</CardTitle>
            <ShieldX className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-red-600">{counts.dangerous}</p>
            <p className="text-xs text-slate-400 mt-1">confirmed threats</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Suspicious</CardTitle>
            <ShieldAlert className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-amber-600">{counts.suspicious}</p>
            <p className="text-xs text-slate-400 mt-1">needs caution</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Safe</CardTitle>
            <ShieldCheck className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-green-600">{counts.safe}</p>
            <p className="text-xs text-slate-400 mt-1">cleared</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent scans */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent scans</CardTitle>
        </CardHeader>
        <CardContent>
          {hasScans ? (
            <div className="divide-y divide-slate-100">
              {scans.map((scan) => (
                <Link
                  key={scan.id}
                  href={`/scan/${scan.id}`}
                  className="flex items-center justify-between py-3 hover:bg-slate-50 -mx-2 px-2 rounded-lg transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <ExternalLink className="h-4 w-4 text-slate-300 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm text-slate-700 truncate">{scan.raw_input}</p>
                      <p className="text-xs text-slate-400">
                        {inputTypeLabels[scan.input_type] ?? scan.input_type} · {formatRelativeTime(scan.created_at)}
                      </p>
                    </div>
                  </div>
                  <div className="flex-shrink-0 ml-3">
                    <RecentScanBadge status={scan.status} verdict={scan.verdict} />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <ShieldQuestion className="h-12 w-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-500 font-medium">No scans yet</p>
              <p className="text-slate-400 text-sm mt-1">
                Paste a suspicious link or email to run your first scan
              </p>
              <Link href="/scan/new" className="mt-4 inline-block">
                <Button variant="outline" className="mt-4">Run your first scan</Button>
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  )
}