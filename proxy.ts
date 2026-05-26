import { NextResponse, type NextRequest } from "next/server"

const PROTECTED_PATHS = ["/dashboard", "/scan", "/history", "/watchlist", "/settings"]

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  const isProtectedPath = PROTECTED_PATHS.some(p => pathname.startsWith(p))

  const hasAuthCookie = request.cookies.getAll().some(
    c => c.name.startsWith("sb-") && c.name.endsWith("-auth-token")
  )

  if (isProtectedPath && !hasAuthCookie) {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    return NextResponse.redirect(url)
  }

  const response = NextResponse.next()
  response.headers.set("X-CBC-Proxy", "1")
  response.headers.set("X-Frame-Options", "DENY")
  response.headers.set("X-Content-Type-Options", "nosniff")
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  return response
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/inngest).*)"],
}
