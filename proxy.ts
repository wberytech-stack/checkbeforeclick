import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { classifyAzureWebPath, isAzureWebPath } from "./src/security/azureWebRouting"

const protectedRoutes = [
  "/dashboard",
  "/scan",
  "/history",
  "/watchlist",
  "/settings",
]

function isProtectedPath(pathname: string) {
  return protectedRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`))
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Azure production image is a deliberately small allowlisted application.
  // Do not instantiate a Supabase client or expose old demo routes in this mode.
  if (process.env.CBC_AZURE_ONLY_MODE === "1") {
    const decision = classifyAzureWebPath(pathname);
    if (decision === "redirect") {
      return NextResponse.redirect(new URL("/azure/welcome", request.url), 307);
    }
    if (decision === "deny") {
      return new NextResponse("Not Found", {
        status: 404,
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    return NextResponse.next();
  }

  // The new Azure routes authenticate with their own opaque PostgreSQL session.
  // The legacy Supabase middleware must never intercept their OIDC callback.
  if (isAzureWebPath(pathname)) return NextResponse.next();

  let response = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))

          response = NextResponse.next({
            request,
          })

          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user && isProtectedPath(pathname)) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = "/login"
    redirectUrl.searchParams.set("next", pathname)
    return NextResponse.redirect(redirectUrl)
  }

  if (user && (pathname === "/login" || pathname === "/register")) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = "/dashboard"
    return NextResponse.redirect(redirectUrl)
  }

  return response
}

export const config = {
  matcher: [
    // Exclude only framework assets and liveness. Extension-based exclusions would
    // let a legacy dynamic API route ending in .json/.js bypass Azure-only denial.
    "/((?!_next/static|_next/image|favicon.ico|api/healthz$).*)",
  ],
}
