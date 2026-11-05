import type { Metadata } from "next";
import { AzureWelcomeTheme } from "./theme";
import { ArrowRight, CheckCircle2, FileSearch, Fingerprint, LockKeyhole, ScanSearch, ShieldCheck } from "lucide-react";

export const metadata: Metadata = {
  title: "CheckBeforeClick | Know the risk before the click",
  description: "Investigate suspicious links with clear verdicts and evidence-backed security intelligence.",
};

const features = [
  {
    Icon: ScanSearch,
    title: "Analyze without opening",
    description: "Submit a suspicious URL for reputation analysis without visiting the destination yourself.",
  },
  {
    Icon: FileSearch,
    title: "Understand the evidence",
    description: "See the scan status, threat signals and supporting findings in one investigation view.",
  },
  {
    Icon: LockKeyhole,
    title: "Keep investigations private",
    description: "Authenticated workspaces separate scan history and evidence by organization.",
  },
] as const;

export default function AzureWelcomePage() {
  return (
    <AzureWelcomeTheme>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-3 focus:text-slate-950">
        Skip to main content
      </a>
      <header className="relative z-10 border-b border-slate-200 bg-white/90 dark:border-slate-200 dark:border-white/10 dark:bg-[#0c1727]/90">
        <nav aria-label="Main navigation" className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <a href="/azure/welcome" aria-label="CheckBeforeClick home" className="inline-flex items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-400">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/15 text-blue-700 dark:text-sky-300 ring-1 ring-blue-400/30" aria-hidden="true"><ShieldCheck size={23} /></span>
            <span className="flex flex-col">
              <span className="text-base font-bold tracking-tight">CheckBeforeClick</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Security intelligence</span>
            </span>
          </a>
          <div className="flex flex-wrap items-center gap-3">
            <a href="/azure" className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-950 dark:text-white focus-visible:outline-2 focus-visible:outline-blue-400">Security Center</a>
            <a href="/auth/azure/start" className="inline-flex items-center gap-2 rounded-lg border border-sky-400/40 bg-sky-400/10 px-4 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-400/20 focus-visible:outline-2 focus-visible:outline-blue-400">
              Sign in <ArrowRight size={15} aria-hidden="true" />
            </a>
          </div>
        </nav>
      </header>

      <main id="main">
        <section className="relative isolate overflow-hidden">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_75%_15%,rgba(37,99,235,0.24),transparent_50%),radial-gradient(ellipse_at_15%_70%,rgba(14,165,233,0.10),transparent_50%)]" />
          <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-5 pb-20 pt-16 sm:px-8 sm:pt-24 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16 lg:pb-28">
            <div>
              <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-sky-400/25 bg-sky-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-blue-800 dark:text-sky-200">
                <span className="h-2 w-2 rounded-full bg-sky-400" aria-hidden="true" />
                Clarity before action
              </p>
              <h1 className="max-w-3xl text-4xl font-bold leading-[1.12] tracking-tight text-slate-950 dark:text-white sm:text-5xl lg:text-6xl">
                Know the risk.<br /><span className="bg-gradient-to-r from-sky-300 to-blue-400 bg-clip-text text-transparent">Before the click.</span>
              </h1>
              <p className="mt-7 max-w-xl text-base leading-8 text-slate-600 dark:text-slate-300 sm:text-lg">
                Suspicious link? Investigate its reputation, review the evidence and make a more informed decision—without opening the destination.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <a href="/azure" className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-blue-950/40 hover:bg-blue-400 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300">
                  Open Security Center <ArrowRight size={17} aria-hidden="true" />
                </a>
                <a href="/auth/azure/start" className="inline-flex min-h-12 items-center gap-2 rounded-lg border border-slate-300 dark:border-white/25 px-6 py-3 text-sm font-semibold text-slate-950 dark:text-white hover:bg-slate-100 dark:hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300">
                  Create account or sign in
                </a>
              </div>
              <p className="mt-5 max-w-lg text-xs leading-6 text-slate-500 dark:text-slate-400">A reputation check is one signal, not proof that a link is safe. Never enter sensitive information on a site you do not trust.</p>
            </div>

            <div aria-label="How a link investigation is organized" className="rounded-2xl border border-sky-300/15 bg-white/90 dark:bg-[#122238]/90 p-4 shadow-2xl shadow-black/30 sm:p-6">
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-white/10 pb-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-950 dark:text-white"><ShieldCheck size={18} className="text-blue-700 dark:text-sky-300" aria-hidden="true" /> Investigation workflow</div>
                <span className="rounded-full border border-slate-300 dark:border-white/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">How it works</span>
              </div>
              <ol className="mt-5 space-y-4">
                {[
                  { number: "01", title: "Submit a URL", detail: "Enter a suspicious link in the Security Center." },
                  { number: "02", title: "Review the analysis", detail: "Follow the scan status and inspect available threat signals." },
                  { number: "03", title: "Decide with context", detail: "Read the verdict and evidence before taking action." },
                ].map((step) => (
                  <li key={step.number} className="flex gap-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-[#0b192b] p-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-xs font-bold text-blue-700 dark:text-sky-300">{step.number}</span>
                    <div><p className="font-semibold text-slate-950 dark:text-white">{step.title}</p><p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">{step.detail}</p></div>
                  </li>
                ))}
              </ol>
              <p className="mt-5 flex items-start gap-2 text-xs leading-6 text-slate-500 dark:text-slate-400"><CheckCircle2 size={16} className="mt-1 shrink-0 text-blue-700 dark:text-sky-300" aria-hidden="true" /> Designed to distinguish confirmed threats from inconclusive results.</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="capabilities-title" className="border-t border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-[#0d192a] px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700 dark:text-sky-300">Purpose-built security</p>
            <h2 id="capabilities-title" className="mt-3 max-w-2xl text-2xl font-bold tracking-tight text-slate-950 dark:text-white sm:text-3xl">Sophisticated intelligence. Clear decisions.</h2>
            <div className="mt-9 grid gap-4 md:grid-cols-3">
              {features.map(({ Icon, title, description }) => (
                <article key={title} className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#13243a] p-6">
                  <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-sky-400/10 text-blue-700 dark:text-sky-300" aria-hidden="true"><Icon size={22} /></span>
                  <h3 className="mt-5 text-lg font-semibold text-slate-950 dark:text-white">{title}</h3>
                  <p className="mt-3 text-sm leading-7 text-slate-600 dark:text-slate-300">{description}</p>
                </article>
              ))}
            </div>
            <p className="mt-8 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"><Fingerprint size={16} aria-hidden="true" /> English-language experience · Built for security-conscious teams and individuals</p>
          </div>
        </section>
      </main>
    </AzureWelcomeTheme>
  );
}
