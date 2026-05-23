import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ShieldAlert, ShieldCheck, ShieldX, Search } from "lucide-react"

export default function DashboardPage() {
  return (
    <div className="space-y-8">

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-1">
            Welcome to CheckBeforeClick
          </p>
        </div>
        <Link href="/scan/new">
          <Button className="flex items-center gap-2">
            <Search className="h-4 w-4" />
            Check it now
          </Button>
        </Link>
      </div>

      <div className="bg-slate-900 rounded-lg p-6 flex items-center justify-between">
        <div>
          <p className="text-slate-300 text-sm font-medium">
            Got a suspicious email or link?
          </p>
          <p className="text-white text-lg font-semibold mt-1">
            Paste it and get a verdict in seconds
          </p>
        </div>
        <Link href="/scan/new">
          <Button variant="outline" className="bg-white text-slate-900 hover:bg-slate-100">
            Check it now
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Dangerous
            </CardTitle>
            <ShieldX className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-red-600">0</p>
            <p className="text-xs text-slate-400 mt-1">confirmed threats</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Suspicious
            </CardTitle>
            <ShieldAlert className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-amber-600">0</p>
            <p className="text-xs text-slate-400 mt-1">needs caution</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Safe
            </CardTitle>
            <ShieldCheck className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-green-600">0</p>
            <p className="text-xs text-slate-400 mt-1">cleared</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent scans</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12">
            <ShieldCheck className="h-12 w-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500 font-medium">No scans yet</p>
            <p className="text-slate-400 text-sm mt-1">
              Paste a suspicious link or email to run your first scan
            </p>
            <Link href="/scan/new" className="mt-4 inline-block">
              <Button variant="outline" className="mt-4">
                Run your first scan
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

    </div>
  )
}
