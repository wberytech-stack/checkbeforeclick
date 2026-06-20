import type { ReactNode } from "react"
import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import {
  getUserOrgContext,
  getScanById,
  getEvidenceForScan,
  getVendorResultsForScan,
} from "@/lib/data"
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
  ExternalLink,
} from "lucide-react"
import AutoRefresh from "./AutoRefresh"

type Verdict = "safe" | "suspicious" | "dangerous" | "unknown"
type Severity = "critical" | "high" | "medium" | "low" | "info" | "good"

const verdictConfig: Record<Verdict, {
  label: string
  summary: string
  action: string
  icon: ReactNode
  heroBg: string
  heroBorder: string
  labelColor: string
}> = {
  safe: {
    label: "Looks safe based on current checks",
    summary: "No known threats were found for this link.",
    action: "You can open it, but do not enter passwords, payment details, or sensitive information unless you expected this site.",
    icon: <ShieldCheck className="h-14 w-14 text-green-500" />,
    heroBg: "bg-green-50",
    heroBorder: "border-green-200",
    labelColor: "text-green-800",
  },
  suspicious: {
    label: "Be careful",
    summary: "Some warning signs were found.",
    action: "Do not enter credentials or sensitive information. Ask your IT team before opening.",
    icon: <ShieldAlert className="h-14 w-14 text-amber-500" />,
    heroBg: "bg-amber-50",
    heroBorder: "border-amber-200",
    labelColor: "text-amber-800",
  },
  dangerous: {
    label: "Do not open",
    summary: "This appears dangerous based on the checks we ran.",
    action: "Do not open this link. Report it to your IT or security team immediately.",
    icon: <ShieldX className="h-14 w-14 text-red-500" />,
    heroBg: "bg-red-50",
    heroBorder: "border-red-200",
    labelColor: "text-red-800",
  },
  unknown: {
    label: "Could not determine",
    summary: "We could not make a confident determination.",
    action: "If you were not expecting this, do not click. Ask IT or verify through another trusted channel.",
    icon: <ShieldQuestion className="h-14 w-14 text-slate-400" />,
    heroBg: "bg-slate-50",
    heroBorder: "border-slate-200",
    labelColor: "text-slate-700",
  },
}

function getVerdictConfig(verdict: string | null) {
  if (!verdict || !(verdict in verdictConfig)) return verdictConfig.unknown
  return verdictConfig[verdict as Verdict]
}

function getRecommendedAction(scan: { verdict: string | null; recommended_action?: string | null }): string {
  if (scan.recommended_action) return scan.recommended_action
  return getVerdictConfig(scan.verdict).action
}

function SeverityIcon({ severity }: { severity: Severity }) {
  const icons: Record<Severity, ReactNode> = {
    critical: <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />,
    high: <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" />,
    medium: <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0" />,
    low: <AlertCircle className="h-4 w-4 text-amber-400 flex-shrink-0" />,
    info: <Info className="h-4 w-4 text-slate-400 flex-shrink-0" />,
    good: <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />,
  }
  return <>{icons[severity]}</>
}

function VendorVerdict({ verdict }: { verdict: string | null }) {
  const config: Record<string, { label: string; color: string }> = {
    clean: { label: "Clean", color: "text-green-600" },
    dangerous: { label: "Flagged", color: "text-red-600" },
    skipped: { label: "Skipped", color: "text-slate-400" },
    error: { label: "Error", color: "text-slate-400" },
  }
  const c = verdict && verdict in config
    ? config[verdict]
    : { label: verdict ?? "No result", color: "text-slate-500" }
  return <span className={`text-sm font-medium ${c.color}`}>{c.label}</span>
}

function isValidUrl(str: string): boolean {
  try {
    new URL(str.startsWith("http") ? str : `https://${str}`)
    return true
  } catch {
    return false
  }
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

  const ctx = await getUserOrgContext(user.id)

  if (!ctx) {
    redirect("/login")
  }

  const scan = await getScanById(ctx.organizationId, id)

  if (!scan) {
    notFound()
  }

  const evidence = await getEvidenceForScan(ctx.organizationId, id)
  const vendors = await getVendorResultsForScan(ctx.organizationId, id)

  const isInProgress = scan.status === "pending" || scan.status === "processing"
  const config = getVerdictConfig(scan.verdict)
  const recommendedAction = getRecommendedAction(scan)
  const urlLike = isValidUrl(scan.raw_input)

  return (
    <div className="max-w-2xl mx-auto space-y-5">

      {/* Back link */}
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-700 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>

      {/* Scan input chip */}
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
          Checked item
        </p>
        <div className="flex items-center gap-2">
          {urlLike && <ExternalLink className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />}
          <p className="text-sm text-slate-700 font-medium truncate">{scan.raw_input}</p>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Submitted {new Date(scan.created_at).toLocaleString()}
        </p>
      </div>

      {/* Polling for in-progress */}
      {isInProgress && <AutoRefresh scanId={id} />}

      {/* Pending / processing state */}
      {isInProgress && (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <Loader2 className="h-10 w-10 text-slate-300 animate-spin mx-auto mb-4" />
          <p className="text-slate-700 font-semibold text-lg">
            {scan.status === "pending" ? "Scan queued…" : "Checking now…"}
          </p>
          <p className="text-slate-400 text-sm mt-2">
            This usually takes a few seconds. The page will update automatically.
          </p>
        </div>
      )}

      {/* Failed state */}
      {scan.status === "failed" && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-10 text-center shadow-sm">
          <ShieldX className="h-10 w-10 text-red-300 mx-auto mb-4" />
          <p className="text-red-700 font-semibold text-lg">We could not complete this scan</p>
          <p className="text-red-500 text-sm mt-2">
            Please try again. If it keeps happening, contact support.
          </p>
          <Link href="/scan/new" className="mt-6 inline-block">
            <Button variant="outline" className="mt-2">Try again</Button>
          </Link>
        </div>
      )}

      {/* Complete state */}
      {scan.status === "complete" && (
        <>
          {/* Hero verdict card */}
          <div className={`rounded-2xl border ${config.heroBorder} ${config.heroBg} p-8 shadow-sm`}>
            <div className="flex flex-col items-center text-center gap-3">
              {config.icon}
              <h1 className={`text-2xl font-bold ${config.labelColor}`}>
                {config.label}
              </h1>
              <p className="text-slate-600 text-sm">{config.summary}</p>
              <p className="text-xs text-slate-400 mt-1">
                Checked using available reputation and safety signals in real time.
              </p>
            </div>
          </div>

          {/* Recommended action */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
              Recommended action
            </p>
            <p className="text-slate-800 text-sm leading-relaxed font-medium">
              {recommendedAction}
            </p>
          </div>

          {/* Why we think this */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-4">
              Why we think this
            </p>
            {evidence && evidence.length > 0 ? (
              <div className="space-y-3">
                {evidence.map((item) => (
                  <div key={item.id} className="flex items-start gap-3">
                    <SeverityIcon severity={item.severity as Severity} />
                    <div>
                      <p className="text-sm font-medium text-slate-800">{item.title}</p>
                      {item.detail && (
                        <p className="text-xs text-slate-500 mt-0.5">{item.detail}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                We completed the available checks and did not find warning signals.
              </p>
            )}
          </div>

          {/* What we checked */}
          {vendors && vendors.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-4">
                What we checked
              </p>
              <div className="space-y-2">
                {vendors.map((v) => (
                  <div key={v.id} className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                    <span className="text-sm text-slate-700">
                      {(() => {
                      const names: Record<string, string> = {
                        google_web_risk: "Google Web Risk",
                        domain_age: "Domain age check",
                      }
                      return names[v.vendor_name] ?? v.vendor_name.replace(/_/g, " ")
                    })()}
                    </span>
                    <VendorVerdict verdict={v.verdict} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Technical details — collapsed by default */}
          <details className="rounded-2xl border border-slate-200 bg-white shadow-sm group">
            <summary className="px-6 py-4 cursor-pointer list-none flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Technical details
              </p>
              <span className="text-xs text-slate-400 group-open:hidden">Show</span>
              <span className="text-xs text-slate-400 hidden group-open:inline">Hide</span>
            </summary>
            <div className="px-6 pb-5 space-y-1.5 text-xs text-slate-500 border-t border-slate-100 pt-4">
              {scan.risk_score !== null && (
                <div className="flex justify-between">
                  <span>Risk score</span>
                  <span className="font-medium text-slate-700">{scan.risk_score} / 100</span>
                </div>
              )}
              {scan.confidence_score !== null && (
                <div className="flex justify-between">
                  <span>Confidence</span>
                  <span className="font-medium text-slate-700">
                    {scan.confidence_score >= 70 ? "High" : scan.confidence_score >= 45 ? "Medium" : "Low"}
                    {" "}({scan.confidence_score})
                  </span>
                </div>
              )}
              {scan.scan_duration_ms !== null && (
                <div className="flex justify-between">
                  <span>Scan duration</span>
                  <span className="font-medium text-slate-700">{scan.scan_duration_ms}ms</span>
                </div>
              )}
              <div className="flex justify-between pt-1">
                <span>Scan ID</span>
                <span className="font-mono text-slate-400 text-xs">{scan.id}</span>
              </div>
            </div>
          </details>

          {/* Actions */}
          <div className="flex flex-col sm:flex-row gap-3 pb-6">
            <Link href="/scan/new" className="w-full sm:w-auto">
              <Button className="w-full sm:w-auto bg-slate-900 text-white hover:bg-slate-700">
                Check another
              </Button>
            </Link>
            <Link href="/dashboard" className="w-full sm:w-auto">
              <Button variant="outline" className="w-full sm:w-auto">
                Back to dashboard
              </Button>
            </Link>
            <Button
              variant="outline"
              disabled
              className="w-full sm:w-auto text-slate-400 cursor-not-allowed"
            >
              Report to IT — coming soon
            </Button>
          </div>
        </>
      )}
    </div>
  )
}