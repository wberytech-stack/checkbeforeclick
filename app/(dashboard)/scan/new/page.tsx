"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Shield, Loader2 } from "lucide-react"

export default function NewScanPage() {
  const router = useRouter()
  const [input, setInput] = useState("")
  const [activeTab, setActiveTab] = useState("url")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const placeholders: Record<string, string> = {
    url: "Paste a suspicious URL or domain here\n\nExamples:\nhttps://micros0ft-login-security.com/verify\npayroll-update-2024.net",
    email: "Paste the full email body here including headers if available\n\nExample:\nFrom: Microsoft Security <security@micros0ft-alert.com>\nSubject: Your account has been suspended\n\nClick here to verify: https://bit.ly/abc123",
    header: "Paste the raw email header here\n\nExample:\nReceived: from mail.suspicious-domain.com\nFrom: support@paypal-secure.net\nReply-To: support@gmail.com",
  }

  const labels: Record<string, string> = {
    url: "URL or Domain",
    email: "Full Email",
    header: "Email Header",
  }

  async function handleSubmit() {
    if (!input.trim()) {
      setError("Please paste something to check")
      return
    }

    setLoading(true)
    setError("")

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: input.trim(),
          input_type: activeTab,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || "Something went wrong. Please try again.")
        setLoading(false)
        return
      }

      router.push(`/scan/${data.scan_id}`)
    } catch {
      setError("Could not connect. Please check your connection and try again.")
      setLoading(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Check suspicious content</h1>
        <p className="text-slate-500 text-sm mt-1">
          Paste a suspicious link, email, or header. We check it and explain what we find.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-slate-600" />
            What do you want to check?
          </CardTitle>
          <CardDescription>
            Choose the type of content you are checking, then paste it below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={activeTab} onValueChange={(val) => { setActiveTab(val); setInput(""); setError("") }}>
            <TabsList className="grid grid-cols-3 w-full">
              <TabsTrigger value="url">URL or Domain</TabsTrigger>
              <TabsTrigger value="email">Full Email</TabsTrigger>
              <TabsTrigger value="header">Email Header</TabsTrigger>
            </TabsList>

            <TabsContent value="url" className="mt-4">
              <Textarea
                placeholder={placeholders.url}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="min-h-40 font-mono text-sm resize-none"
              />
            </TabsContent>

            <TabsContent value="email" className="mt-4">
              <Textarea
                placeholder={placeholders.email}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="min-h-40 font-mono text-sm resize-none"
              />
            </TabsContent>

            <TabsContent value="header" className="mt-4">
              <Textarea
                placeholder={placeholders.header}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="min-h-40 font-mono text-sm resize-none"
              />
            </TabsContent>
          </Tabs>

          {error && (
            <div className="bg-red-50 text-red-700 text-sm px-4 py-3 rounded-md">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <p className="text-xs text-slate-400">
              {input.length > 0 ? `${input.length} characters` : "Nothing pasted yet"}
            </p>
            <Button
              onClick={handleSubmit}
              disabled={loading || !input.trim()}
              className="min-w-32"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Checking...
                </>
              ) : (
                <>
                  <Shield className="h-4 w-4 mr-2" />
                  Check it now
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4 text-center">
        <div className="bg-white rounded-lg p-4 border border-slate-200">
          <p className="text-sm font-medium text-slate-700">URLs and domains</p>
          <p className="text-xs text-slate-400 mt-1">Check if a link is safe before clicking</p>
        </div>
        <div className="bg-white rounded-lg p-4 border border-slate-200">
          <p className="text-sm font-medium text-slate-700">Full emails</p>
          <p className="text-xs text-slate-400 mt-1">Paste an email to check the sender and links</p>
        </div>
        <div className="bg-white rounded-lg p-4 border border-slate-200">
          <p className="text-sm font-medium text-slate-700">Email headers</p>
          <p className="text-xs text-slate-400 mt-1">Check technical email authentication</p>
        </div>
      </div>
    </div>
  )
}

