import "server-only"

// Shared Google Web Risk caller
// Used by both /api/scan (fast path) and Inngest worker (slow path)

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  const timeout = new Promise<T>((resolve) =>
    setTimeout(() => resolve(fallback), ms)
  )
  try {
    return await Promise.race([promise, timeout])
  } catch {
    return fallback
  }
}

export async function checkGoogleWebRisk(url: string): Promise<{
  flagged: boolean
  threatType?: string
  error?: string
  skipped?: boolean
}> {
  const apiKey = process.env.GOOGLE_WEB_RISK_API_KEY

  if (!apiKey) {
    return { flagged: false, skipped: true, error: "API key not configured" }
  }

  try {
    const params = new URLSearchParams({ key: apiKey, uri: url })
    params.append("threatTypes", "MALWARE")
    params.append("threatTypes", "SOCIAL_ENGINEERING")
    params.append("threatTypes", "UNWANTED_SOFTWARE")

    const response = await fetch(
      `https://webrisk.googleapis.com/v1/uris:search?${params.toString()}`,
      { method: "GET", headers: { "Content-Type": "application/json" } }
    )

    if (!response.ok) {
      const errorText = await response.text()
      return { flagged: false, error: `API error ${response.status}: ${errorText}` }
    }

    const data = await response.json()
    const flagged = !!(data.threat?.threatTypes?.length > 0)
    const threatType = flagged ? data.threat.threatTypes[0] : undefined

    return { flagged, threatType }
  } catch (error) {
    return { flagged: false, error: String(error) }
  }
}
