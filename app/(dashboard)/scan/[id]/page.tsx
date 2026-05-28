import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  ShieldX,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Info,
  Loader2,
  ArrowLeft,
} from "lucide-react"
import AutoRefresh from "./AutoRefresh"

type Verdict = "safe" | "suspicious" | "dangerous" | "unknown"
type Severity = "critical" | "high" | "medium" | "low" | "info" | "good"

function VerdictBadge({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return <Badge variant="outline">Pending</Badge>
  const config = {
    safe: { label: "Safe", className: "bg-green-100 text-green-800 border-green-200" },
    suspicious: { label: "Suspicious", className: "bg-amber-100 text-amber-800 border-amber-200" },
    dangerous: { label: "Dangerous", className: "bg-red-100 text-red-800 border-red-200" },
    unknown: { label: "Unknown", className: "bg-slate-100 text-slate-700 border-slate-200" },
  }
  const { label, className } = config[verdict]
  return <Badge className={className}>{label}</Badge>
}

function VerdictIcon({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return <ShieldQuestion className="h-12 w-12 text-slate-300" />
  const icons = {
    safe: <ShieldCheck className="h-12 w-12 text-green-500" />,
    suspicious: <ShieldAlert className="h-12 w-12 text-amber-500" />,
    dangerous: <ShieldX className="h-12 w-12 text-red-500" />,
    unknown: <ShieldQuestion className="h-12 w-12 text-slate-400" />,
  }
  return icons[verdict]
}

function VerdictCardColor(verdict: Verdict | null): string {
  if (!verdict) return "border-slate-200 bg-slate-50"
  return {
    safe: "border-green-200 bg-green-50",
    suspicious: "border-amber-200 bg-amber-50",
    dangerous: "border-red-200 bg-red-50",
    unknown: "border-slate-200 bg-slate-50",
  }[verdict]
}

function SeverityIcon({ severity }: { severity: Severity }) {
  const icons: Record<Severity, React.ReactNode> = {
    critical: <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />,
    high: <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" />,
    medium: <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0" />,
    low: <AlertCircle className="h-4 w-4 text-amber-400 flex-shrink-0" />,
    info: <Info className="h-4 w-4 text-slate-400 flex-shrink-0" />,
    good: <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />,
  }
  return <>{icons[severity]}</>
}

export default async function ScanResultPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
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
    .select("id, organization_id")
    .eq("id", user.id)
    .single()

  if (!userRecord) {
    redirect("/login")
  }

  const { data: scan, error: scanError } = await supabase
    .from("scans")
    .select("*")
    .eq("id", id)
    .eq("organization_id", userRecord.organization_id)
    .single()

  if (scanError || !scan) {
    notFound()
  }

  const { data: evidence } = await supabase
    .from("evidence_items")
    .select("*")
    .eq("scan_id", id)
    .order("score_impact", { ascending: false })

  const { data: vendors } = await supabase
    .from("vendor_results")
    .select("*")
    .eq("scan_id", id)

  const isInProgress = scan.status === "pending" || scan.status === "processing"

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>

      <div>
        <p className="text-xs text-slate-400 font-mono truncate">{scan.raw_input}</p>
        <p className="text-xs text-slate-400 mt-1">
          Submitted {new Date(scan.created_at).toLocaleString()}
        </p>
      </div>

      {isInProgress && <AutoRefresh scanId={id} />}

      {isInProgress && (
        <Card className="border-slate-200">
          <CardContent className="py-12 text-center">
            <Loader2 className="h-10 w-10 text-slate-400 animate-spin mx-auto mb-4" />
            <p className="text-slate-700 font-medium">
              {scan.status === "pending" ? "Scan queued..." : "Checking now..."}
            </p>
            <p className="text-slate-400 text-sm mt-1">
              This usually takes a few seconds. The page will update automatically.
            </p>
          </CardContent>
        </Card>
      )}

      {scan.status === "failed" && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-8 text-center">
            <ShieldX className="h-10 w-10 text-red-400 mx-auto mb-4" />
            <p className="text-red-700 font-medium">Scan could not be completed</p>
            <p className="text-red-500 text-sm mt-1">A system error occurred. Please try again.</p>
            <Link href="/scan/new" className="mt-4 inline-block">
              <Button variant="outline" className="mt-4">Try again</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {scan.status === "complete" && (
        <>
          <Card className={`border ${VerdictCardColor(scan.verdict)}`}>
            <CardContent className="py-6">
              <div className="flex items-start gap-4">
                <VerdictIcon verdict={scan.verdict} />
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2 flex-wrap">
                    <VerdictBadge verdict={scan.verdict} />
                    {scan.risk_score !== null && (
                      <span className="text-sm text-slate-500">
                        Risk: <strong>{scan.risk_score}/100</strong>
                      </span>
                    )}
                    {scan.confidence_score !== null && (
                      <span className="text-sm text-slate-500">
                        Confidence:{" "}
                        <strong>
                          {scan.confidence_score >= 70 ? "High" : scan.confidence_score >= 45 ? "Medium" : "Low"}
                        </strong>
                      </span>
                    )}
                  </div>
                  {scan.ai_explanation && (
                    <p className="text-slate-700 text-sm leading-relaxed">{scan.ai_explanation}</p>
                  )}
                  {!scan.ai_explanation && (
                    <p className="text-slate-500 text-sm">
                      {scan.verdict === "unknown"
                        ? "Not enough information to make a confident determination."
                        : scan.verdict === "safe"
                        ? "No threats detected based on available sources."
                        : scan.verdict === "suspicious"
                        ? "Some signals suggest this may be risky. Review the evidence below."
                        : "This content has been flagged as dangerous. Do not interact with it."}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {scan.recommended_action && (
            <Card className="border-slate-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-700">Recommended action</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-slate-700 text-sm">{scan.recommended_action}</p>
              </CardContent>
            </Card>
          )}

          {evidence && evidence.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-700">Why we flagged it</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {evidence.map((item) => (
                  <div key={item.id} className="flex items-start gap-3 py-2 border-b border-slate-100 last:border-0">
                    <SeverityIcon severity={item.severity as Severity} />
                    <div>
                      <p className="text-sm font-medium text-slate-800">{item.title}</p>
                      {item.detail && <p className="text-xs text-slate-500 mt-0.5">{item.detail}</p>}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {vendors && vendors.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-700">Sources checked</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  {vendors.map((v) => (
                    <div key={v.id} className="bg-slate-50 rounded-md p-3 border border-slate-200">
                      <p className="text-xs text-slate-500 capitalize">{v.vendor_name.replace(/_/g, " ")}</p>
                      <p className={`text-sm font-medium mt-0.5 capitalize ${
                        v.verdict === "dangerous" ? "text-red-600"
                        : v.verdict === "clean" ? "text-green-600"
                        : v.verdict === "skipped" ? "text-slate-400"
                        : "text-slate-600"
                      }`}>
                        {v.verdict || "No result"}
                      </p>
                      {v.error_message && <p className="text-xs text-slate-400 mt-0.5">{v.error_message}</p>}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex gap-3">
            <Link href="/scan/new"><Button variant="outline">Check another</Button></Link>
            <Link href="/dashboard"><Button variant="outline">Back to dashboard</Button></Link>
          </div>
        </>
      )}
    </div>
  )
}
