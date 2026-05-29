"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

const POLL_INTERVAL_MS = 750
const MAX_WAIT_MS = 30000

export default function AutoRefresh({ scanId }: { scanId: string }) {
  const router = useRouter()

  useEffect(() => {
    let stopped = false
    let interval: ReturnType<typeof setInterval> | null = null
    const startTime = Date.now()

    const stopPolling = () => {
      stopped = true
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    }

    const poll = async () => {
      if (stopped) return

      if (Date.now() - startTime > MAX_WAIT_MS) {
        stopPolling()
        return
      }

      try {
        const response = await fetch(`/api/scan/${scanId}/status`, {
          cache: "no-store",
        })

        if (!response.ok) {
          stopPolling()
          return
        }

        const data: { status?: string; verdict?: string | null } = await response.json()

        if (data.status === "complete" || data.status === "failed") {
          stopPolling()
          router.refresh()
        }
      } catch {
        // Temporary network errors should not stop polling.
      }
    }

    interval = setInterval(poll, POLL_INTERVAL_MS)
    void poll()

    return () => {
      stopPolling()
    }
  }, [scanId, router])

  return null
}