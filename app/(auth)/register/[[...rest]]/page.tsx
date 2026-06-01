"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { Mail, Lock, User, Building2, ArrowRight } from "lucide-react"
import { AuthShell } from "@/components/auth/AuthShell"

export default function RegisterPage() {
  const router = useRouter()

  const [fullName, setFullName] = useState("")
  const [organizationName, setOrganizationName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setMessage("")
    setLoading(true)

    const cleanFullName = fullName.trim()
    const cleanOrganizationName = organizationName.trim()
    const cleanEmail = email.trim().toLowerCase()

    if (!cleanFullName || !cleanOrganizationName || !cleanEmail || !password) {
      setLoading(false)
      setError("Please complete all fields.")
      return
    }

    const supabase = createClient()

    const { data, error } = await supabase.auth.signUp({
      email: cleanEmail,
      password,
      options: {
        data: {
          full_name: cleanFullName,
          organization_name: cleanOrganizationName,
        },
      },
    })

    setLoading(false)

    if (error) {
      setError("Could not create your account. Please try again.")
      return
    }

    if (!data.session) {
      setMessage("Account created. Please check your email to confirm your account, then sign in.")
      return
    }

    router.push("/dashboard")
    router.refresh()
  }

  return (
    <AuthShell
      headline="Clarity before you click."
      subhead="Give your team a simple way to check suspicious links and emails — and a clear answer before anyone acts."
      title="Create your account"
      subtitle="Start checking suspicious links in a secure workspace"
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-[#6d5ef0] hover:text-[#5d4ee0]">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="fullName" className="mb-1.5 block text-[13px] font-medium text-[#3a4156]">
            Full name
          </label>
          <div className="flex h-11 items-center gap-2.5 rounded-[10px] border border-[#dcdcd6] bg-white px-3 transition-all focus-within:border-[#6d5ef0] focus-within:ring-2 focus-within:ring-[#6d5ef0]/15">
            <User className="h-4 w-4 flex-shrink-0 text-[#9aa1b0]" />
            <input
              id="fullName"
              type="text"
              autoComplete="name"
              required
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className="w-full bg-transparent text-sm text-[#13182a] outline-none placeholder:text-[#aab0bc]"
              placeholder="Your name"
            />
          </div>
        </div>

        <div>
          <label htmlFor="organizationName" className="mb-1.5 block text-[13px] font-medium text-[#3a4156]">
            Company or organization name
          </label>
          <div className="flex h-11 items-center gap-2.5 rounded-[10px] border border-[#dcdcd6] bg-white px-3 transition-all focus-within:border-[#6d5ef0] focus-within:ring-2 focus-within:ring-[#6d5ef0]/15">
            <Building2 className="h-4 w-4 flex-shrink-0 text-[#9aa1b0]" />
            <input
              id="organizationName"
              type="text"
              autoComplete="organization"
              required
              value={organizationName}
              onChange={(event) => setOrganizationName(event.target.value)}
              className="w-full bg-transparent text-sm text-[#13182a] outline-none placeholder:text-[#aab0bc]"
              placeholder="Acme Corp"
            />
          </div>
        </div>

        <div>
          <label htmlFor="email" className="mb-1.5 block text-[13px] font-medium text-[#3a4156]">
            Work email
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
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full bg-transparent text-sm text-[#13182a] outline-none placeholder:text-[#aab0bc]"
              placeholder="At least 8 characters"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-[10px] border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
            {error}
          </div>
        )}

        {message && (
          <div className="rounded-[10px] border border-green-200 bg-green-50 px-3.5 py-2.5 text-sm text-green-700">
            {message}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-[#6d5ef0] text-sm font-semibold text-white shadow-[0_1px_2px_rgba(19,24,42,0.18)] transition-all hover:bg-[#5d4ee0] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Creating account..." : "Create account"}
          {!loading && <ArrowRight className="h-4 w-4" />}
        </button>
      </form>
    </AuthShell>
  )
}
