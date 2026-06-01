import type { ReactNode } from "react"
import { BrandLockup } from "@/components/brand/BrandLockup"

type AuthShellProps = {
  headline: ReactNode
  subhead: string
  title: string
  subtitle: string
  children: ReactNode
  footer: ReactNode
}

function VerdictArtifact() {
  return (
    <div className="rounded-xl border border-[#2a3350] bg-[#1b2236] p-3.5">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[rgba(62,207,142,0.16)]">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12.5 L10 17.5 L19 7" stroke="#3ecf8e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-white">portal.example</div>
          <div className="text-xs text-[#9aa1b8]">Checked just now &middot; looks safe based on current checks</div>
        </div>
        <span className="ml-auto flex-shrink-0 rounded-md bg-[rgba(62,207,142,0.14)] px-2.5 py-1 text-[11px] font-medium text-[#3ecf8e]">
          Looks safe
        </span>
      </div>
    </div>
  )
}

export function AuthShell({ headline, subhead, title, subtitle, children, footer }: AuthShellProps) {
  return (
    <main className="min-h-screen bg-[#f6f6f4] flex items-start sm:items-center justify-center p-4 sm:p-6 py-8 sm:py-10">
      <div className="w-full max-w-4xl overflow-hidden rounded-2xl border border-[#e7e7e3] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04),0_12px_40px_-12px_rgba(19,24,42,0.12)] grid md:grid-cols-[1.05fr_1fr]">

        <div className="relative hidden md:flex flex-col justify-between overflow-hidden bg-[#13182a] p-9">
          <div className="absolute inset-x-0 top-0 h-[3px] bg-[#6d5ef0]" />
          <svg
            className="pointer-events-none absolute -right-16 -top-12 opacity-[0.06]"
            width="320" height="320" viewBox="0 0 40 40" fill="none" aria-hidden="true"
          >
            <circle cx="20" cy="20" r="15" stroke="#fff" strokeWidth="1.5" />
            <circle cx="20" cy="20" r="9.5" stroke="#fff" strokeWidth="1.5" />
            <circle cx="20" cy="20" r="4" fill="#fff" />
          </svg>

          <div className="relative">
            <BrandLockup size={30} onDark />
          </div>

          <div className="relative">
            <h2 className="text-[27px] font-semibold leading-[1.2] tracking-[-0.02em] text-white">
              {headline}
            </h2>
            <p className="mt-4 max-w-[300px] text-[15px] leading-relaxed text-[#9aa1b8]">
              {subhead}
            </p>
            <div className="mt-7 max-w-[330px]">
              <VerdictArtifact />
            </div>
          </div>

          <div className="relative flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[#8b93ab]">
            <span>Verdicts in seconds</span>
            <span className="h-1 w-1 rounded-full bg-[#3a425c]" />
            <span>Private organization history</span>
            <span className="h-1 w-1 rounded-full bg-[#3a425c]" />
            <span>Built for teams</span>
          </div>
        </div>

        <div className="flex flex-col justify-center px-6 py-9 sm:px-10">

          <div className="mb-8 md:hidden rounded-xl bg-[#13182a] p-5">
            <BrandLockup size={24} onDark />
            <p className="mt-3 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-white">
              {headline}
            </p>
            <div className="mt-3.5">
              <div className="flex items-center gap-2.5 rounded-lg border border-[#2a3350] bg-[#1b2236] px-3 py-2.5">
                <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-[rgba(62,207,142,0.16)]">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5 12.5 L10 17.5 L19 7" stroke="#3ecf8e" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <span className="min-w-0 text-xs font-medium text-white">portal.example</span>
                <span className="ml-auto flex-shrink-0 rounded-md bg-[rgba(62,207,142,0.14)] px-2 py-0.5 text-[11px] font-medium text-[#3ecf8e]">Looks safe</span>
              </div>
            </div>
          </div>

          <div className="mx-auto w-full max-w-[340px]">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-[#13182a]">{title}</h1>
            <p className="mt-1.5 text-sm text-[#6b7280]">{subtitle}</p>

            <div className="mt-7">{children}</div>

            <div className="mt-7 border-t border-[#ececea] pt-5">
              <p className="text-center text-sm text-[#6b7280]">{footer}</p>
            </div>
          </div>
        </div>

      </div>
    </main>
  )
}