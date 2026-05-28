"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

const POLL_INTERVAL_MS = 750
const MAX_WAIT_MS = 30000

export default function AutoRefresh({ scanId }: { scanId: string }) {
  const router = useRouter()

  useEffect(() => {
    let stopped = false
    const startTime = Date.now()

    const interval = setInterval(async () => {
      if (stopped) return

      if (Date.now() - startTime > MAX_WAIT_MS) {
        clearInterval(interval)
        return
      }

      try {
        const response = await fetch(`/api/scan/${scanId}/status`)

        if (!response.ok) {
          clearInterval(interval)
          return
        }

        const data: { status?: string; verdict?: string | null } = await response.json()

        if (data.status === "complete" || data.status === "failed") {
          clearInterval(interval)
          router.refresh()
        }
      } catch {
        // Temporary network errors should not stop polling while the scan is active.
      }
    }, POLL_INTERVAL_MS)

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [scanId, router])

  return null
}
