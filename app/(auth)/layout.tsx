export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="w-full max-w-md px-4">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-900">
            CheckBeforeClick
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Suspicious link and email checker
          </p>
        </div>
        {children}
      </div>
    </div>
  )
}
