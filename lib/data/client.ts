// PRIVATE privileged client factory.
// Do NOT import this file from anywhere outside lib/data/.
// All privileged data access goes through lib/data/index.ts.
// This is the ONLY file in the repo allowed to read SUPABASE_SERVICE_ROLE_KEY.
import "server-only"
import { createClient } from "@supabase/supabase-js"

export function createPrivilegedClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}
