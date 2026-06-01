"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { Mail, Lock, ArrowRight } from "lucide-react"
import { AuthShell } from "@/components/auth/AuthShell"

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = searchParams.get("next") || "/dashboard"

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setLoading(true)

    const supabase = createClient()

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    setLoading(false)

    if (error) {
      setError("Invalid email or password.")
      return
    }

    router.push(next)
    router.refresh()
  }

  return (
    <AuthShell
      headline="Know what's safe before you click."
      subhead="Check suspicious links and emails before they reach your team — and get a clear, plain-English verdict in seconds."
      title="Welcome back"
      subtitle="Sign in to continue to your dashboard"
      footer={
        <>
          New to checkbeforeclick?{" "}
          <Link href="/register" className="font-semibold text-[#6d5ef0] hover:text-[#5d4ee0]">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1.5 block text-[13px] font-medium text-[#3a4156]">
            Email
          </label>
          <div className="flex h-11 items-center gap-2.5 rounded-[10px] border border-[#dcdcd6] bg-white px-3 transition-all focus-within:border-[#6d5ef0] focus-within:ring-2 focus-within:ring-[#6d5ef0]/15">
            <Mail className="h-4 w-4 flex-shrink-0 text-[#9aa1b0]" />
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full bg-transparent text-sm text-[#13182a] outline-none placeholder:text-[#aab0bc]"
              placeholder="you@company.com"
            />
          </div>
        </div>

        <div>
          <label htmlFor="password" className="mb-1.5 block text-[13px] font-medium text-[#3a4156]">
            Password
          </label>
          <div className="flex h-11 items-center gap-2.5 rounded-[10px] border border-[#dcdcd6] bg-white px-3 transition-all focus-within:border-[#6d5ef0] focus-within:ring-2 focus-within:ring-[#6d5ef0]/15">
            <Lock className="h-4 w-4 flex-shrink-0 text-[#9aa1b0]" />
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full bg-transparent text-sm text-[#13182a] outline-none placeholder:text-[#aab0bc]"
              placeholder="Your password"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-[10px] border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-[#6d5ef0] text-sm font-semibold text-white shadow-[0_1px_2px_rgba(19,24,42,0.18)] transition-all hover:bg-[#5d4ee0] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Signing in..." : "Sign in"}
          {!loading && <ArrowRight className="h-4 w-4" />}
        </button>
      </form>
    </AuthShell>
  )
}
