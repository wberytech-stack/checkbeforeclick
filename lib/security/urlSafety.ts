import "server-only"

// Shared SSRF protection and URL safety module
// Used by both /api/scan (fast path) and Inngest worker (slow path)
// IMPORTANT: Before any server-side fetch, redirect following, screenshotting,
// or browser automation, resolved DNS IPs must also be validated.

export function isDecimalInteger(str: string): boolean {
  return /^\d+$/.test(str)
}

export function isHexEncoded(str: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(str)
}

export function isOctalEncoded(str: string): boolean {
  return /^0[0-7]+$/.test(str)
}

export function checkIPv4Safety(ip: string): string | null {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return null
  }
  const [a, b] = parts
  if (a === 0) return "0.0.0.0/8 reserved range"
  if (a === 10) return "10.0.0.0/8 private range"
  if (a === 127) return "127.0.0.0/8 loopback range"
  if (a === 169 && b === 254) return "169.254.0.0/16 link-local range"
  if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 private range"
  if (a === 192 && b === 168) return "192.168.0.0/16 private range"
  if (a >= 224 && a <= 239) return "224.0.0.0/4 multicast range"
  if (a >= 240) return "240.0.0.0/4 reserved range"
  return null
}

export function checkIPv6Safety(ip: string): string | null {
  const lower = ip.toLowerCase()
  if (lower === "::1") return "IPv6 loopback address"
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "IPv6 fc00::/7 private range"
  if (
    lower.startsWith("fe8") || lower.startsWith("fe9") ||
    lower.startsWith("fea") || lower.startsWith("feb")
  ) {
    return "IPv6 fe80::/10 link-local range"
  }
  return null
}

export const BLOCKED_SINGLE_LABELS = new Set([
  "localhost", "intranet", "internal", "local", "server",
  "gateway", "router", "printer", "nas", "admin", "vpn",
  "mail", "exchange", "dc", "fileserver",
])

export function checkHostnameSafety(hostname: string): string | null {
  if (!hostname || hostname.length === 0) return "Empty hostname"
  const lower = hostname.toLowerCase()

  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "localhost.localdomain"
  ) {
    return "Localhost is not allowed"
  }

  if (!lower.includes(".")) {
    if (BLOCKED_SINGLE_LABELS.has(lower)) {
      return `Internal hostname "${lower}" is not allowed`
    }
    return `Single-label hostname "${lower}" is not a valid public domain`
  }

  if (isDecimalInteger(lower)) return "Decimal-encoded IP addresses are not allowed"
  if (isHexEncoded(lower)) return "Hexadecimal-encoded IP addresses are not allowed"
  if (isOctalEncoded(lower)) return "Octal-encoded IP addresses are not allowed"

  const ipv4Blocked = checkIPv4Safety(lower)
  if (ipv4Blocked) return `Private/reserved IP blocked: ${ipv4Blocked}`

  const ipv6Candidate = lower.replace(/^\[/, "").replace(/\]$/, "")
  const ipv6Blocked = checkIPv6Safety(ipv6Candidate)
  if (ipv6Blocked) return `Private/reserved IPv6 blocked: ${ipv6Blocked}`

  return null
}

const BLOCKED_PROTOCOLS = [
  "file:", "ftp:", "gopher:", "data:",
  "javascript:", "ldap:", "dict:",
]

export function normalizeScanTarget(
  rawInput: string,
  inputType: string
): {
  ok: boolean
  normalizedUrl?: string
  domain?: string
  reason?: string
} {
  try {
    let rawUrl: string

    if (inputType === "url") {
      const raw = rawInput.trim()
      rawUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    } else if (inputType === "domain") {
      const domain = rawInput.trim().toLowerCase()
      if (/\s/.test(domain)) return { ok: false, reason: "Domain contains spaces and cannot be checked." }
      if (domain.includes("/") || domain.includes("\\")) return { ok: false, reason: "Input looks like a path, not a domain." }
      if (domain.length === 0 || domain.length > 253) return { ok: false, reason: "Domain length is invalid." }
      if (isDecimalInteger(domain) || isHexEncoded(domain) || isOctalEncoded(domain)) {
        return { ok: false, reason: "Encoded IP addresses are not allowed as domain input." }
      }
      const labelPattern = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
      if (!labelPattern.test(domain)) return { ok: false, reason: "Domain format is not valid." }
      rawUrl = `https://${domain}`
    } else {
      const match = rawInput.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/)
      if (!match) return { ok: false, reason: "No URL found in the submitted content." }
      rawUrl = match[0]
    }

    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return { ok: false, reason: "URL format is not valid." }
    }

    if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) {
      return { ok: false, reason: `Protocol "${parsed.protocol}" is not allowed.` }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "Only http and https URLs are supported." }
    }

    const hostnameDanger = checkHostnameSafety(parsed.hostname)
    if (hostnameDanger) return { ok: false, reason: hostnameDanger }

    return {
      ok: true,
      normalizedUrl: parsed.toString(),
      domain: parsed.hostname.toLowerCase(),
    }
  } catch {
    return { ok: false, reason: "Input could not be safely parsed." }
  }
}
