import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"

export default async function RootPage() {
  // Azure-only images never need Supabase login or legacy demo accounts.
  if (process.env.CBC_AZURE_ONLY_MODE === "1") redirect("/azure/welcome")
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (user) {
    redirect("/dashboard")
  } else {
    redirect("/login")
  }
}
