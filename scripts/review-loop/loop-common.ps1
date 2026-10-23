<#
CheckBeforeClick Gate 005H - shared helpers for the review loop (dot-sourced; defines functions only).
Processes are started directly with an argument list (no cmd.exe, no shell strings). Git access is read-only:
Invoke-LoopGit refuses every subcommand outside a fixed allow-list.
#>

$LoopGitAllowed = @('status', 'rev-parse', 'for-each-ref', 'diff', 'show-ref', 'ls-files')   # plus 'stash list' only
$LoopForbiddenRx = '(?i)(^|/)\.env|(^|/)\.git(/|$)|(^|/)node_modules/|(^|/)\.next/|(^|/)package(-lock)?\.json$|\.(pem|key|pfx|p12)$|(^|/)\.npmrc$|(^|/)\.pgpass$|(^|/)id_(rsa|ed25519|ecdsa)|(^|/)\.claude/|(^|/)\.codex/|^AGENTS\.md$|^CLAUDE\.md$|(^|/)secrets?\.(json|ya?ml|txt)$|(^|/)credentials?(\.[a-z]+)?$'
$LoopPathRx = '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
$LoopExcluded = @('.agents/claude-handoff.yaml')
$LoopStatusCodes = @(' M', 'M ', 'MM', 'A ', 'AM', '??')
$LoopMaxFiles = 40
$LoopMaxBytes = 2MB

function Get-LoopSha([string]$Path) { if (Test-Path -LiteralPath $Path -PathType Leaf) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLower() }; return '<missing>' }
function Write-LoopUtf8([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false))) }
function ConvertTo-LoopArg([string]$s) {
  # Windows CommandLineToArgvW / MSVCRT quoting rules (same as the runner).
  if ($s.Length -gt 0 -and $s -notmatch '[\s"]') { return $s }
  $sb = New-Object System.Text.StringBuilder; [void]$sb.Append('"'); $bs = 0
  foreach ($ch in $s.ToCharArray()) {
    if ($ch -eq [char]'\') { $bs++ }
    elseif ($ch -eq [char]'"') { [void]$sb.Append([string]::new([char]'\', 2 * $bs + 1)); [void]$sb.Append('"'); $bs = 0 }
    else { if ($bs) { [void]$sb.Append([string]::new([char]'\', $bs)); $bs = 0 }; [void]$sb.Append($ch) }
  }
  [void]$sb.Append([string]::new([char]'\', 2 * $bs)); [void]$sb.Append('"')
  return $sb.ToString()
}
function Invoke-LoopProc([string]$Exe, [string[]]$ArgList, [string]$Cwd, [int]$TimeoutSec = 120, [string]$StdIn = $null) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.Arguments = ((@($ArgList) | ForEach-Object { ConvertTo-LoopArg ([string]$_) }) -join ' ')
  $psi.WorkingDirectory = $Cwd; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false); $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
  $prevIn = [Console]::InputEncoding
  try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
  try { $p = [System.Diagnostics.Process]::Start($psi) } finally { try { [Console]::InputEncoding = $prevIn } catch { } }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $to = $p.StandardOutput.ReadToEndAsync(); $te = $p.StandardError.ReadToEndAsync()
  try { if ($null -ne $StdIn) { $p.StandardInput.Write($StdIn) }; $p.StandardInput.Close() } catch { }
  $timedOut = -not $p.WaitForExit($TimeoutSec * 1000)
  if ($timedOut) {
    try { $k = New-Object System.Diagnostics.ProcessStartInfo; $k.FileName = (Join-Path $env:SystemRoot 'System32\taskkill.exe'); $k.Arguments = "/PID $($p.Id) /T /F"; $k.UseShellExecute = $false; $k.CreateNoWindow = $true; $k.RedirectStandardOutput = $true; $k.RedirectStandardError = $true; $kp = [System.Diagnostics.Process]::Start($k); [void]$kp.WaitForExit(30000) } catch { }
    [void]$p.WaitForExit(15000)
  } else { $p.WaitForExit() }
  [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($to, $te), 15000)
  $code = $null; if ($p.HasExited) { $code = $p.ExitCode }
  return [pscustomobject]@{ TimedOut = $timedOut; ExitCode = $code; StdOut = $(if ($to.IsCompleted) { $to.Result } else { '' }); StdErr = $(if ($te.IsCompleted) { $te.Result } else { '' }); Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}
function Get-LoopGitExe { $g = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $g) { throw 'git.exe not found' }; return $g.Source }
function Invoke-LoopGit([string[]]$ArgList, [string]$Cwd, [int[]]$OkCodes = @(0)) {
  # Read-only git only. Anything else is refused before a process starts. ($OkCodes: 'diff' exits 1 on differences.)
  $sub = [string]@($ArgList)[0]
  $ok = ($LoopGitAllowed -ccontains $sub) -or ($sub -ceq 'stash' -and @($ArgList).Count -eq 2 -and [string]$ArgList[1] -ceq 'list')
  if (-not $ok) { throw "refused: git $sub is not a read-only command" }
  $r = Invoke-LoopProc (Get-LoopGitExe) $ArgList $Cwd 120
  if ($r.TimedOut -or $OkCodes -notcontains $r.ExitCode) { throw "git $($ArgList -join ' ') failed (exit $($r.ExitCode)): $($r.StdErr.Trim())" }
  return $r.StdOut
}
function Get-LoopLines([string]$Text) { return @(($Text -split "`r?`n") | Where-Object { $_ -ne '' }) }

function Get-RepoState([string]$Repo, [string[]]$HashPaths = @()) {
  # Everything a fix round must leave untouched except the frozen files' contents.
  $st = Get-LoopLines (Invoke-LoopGit @('status', '--porcelain=v1', '--untracked-files=all') $Repo)
  $h = [ordered]@{}
  foreach ($p in (@($HashPaths) + @($st | ForEach-Object { $_.Substring(3) }) | Sort-Object -Unique)) { $h[$p] = Get-LoopSha (Join-Path $Repo $p.Replace('/', '\')) }
  return [pscustomobject]@{
    Head = (Invoke-LoopGit @('rev-parse', 'HEAD') $Repo).Trim()
    Branch = (Invoke-LoopGit @('rev-parse', '--abbrev-ref', 'HEAD') $Repo).Trim()
    Refs = (Get-LoopLines (Invoke-LoopGit @('for-each-ref', '--format=%(refname) %(objectname)') $Repo)) -join "`n"
    Stash = (Get-LoopLines (Invoke-LoopGit @('stash', 'list') $Repo)) -join "`n"
    Status = $st -join "`n"
    Hashes = $h
  }
}
function Get-ChangedSet([string]$Repo) {
  $st = Get-LoopLines (Invoke-LoopGit @('status', '--porcelain=v1', '--untracked-files=all') $Repo)
  $unsupported = @($st | Where-Object { $LoopStatusCodes -cnotcontains $_.Substring(0, 2) -or $_.Substring(3).StartsWith('"') -or $_.Substring(3).Contains(' -> ') })
  $paths = @($st | ForEach-Object { $_.Substring(3) } | Where-Object { $LoopExcluded -notcontains $_ } | Sort-Object)
  return [pscustomobject]@{ Paths = $paths; Unsupported = $unsupported }
}
function Test-LoopPaths([string[]]$Paths) {
  # Same guards as the runner's Loop target (the runner re-checks them independently).
  $p = @($Paths); $why = New-Object System.Collections.Generic.List[string]
  if ($p.Count -lt 1 -or $p.Count -gt $LoopMaxFiles) { $why.Add("changed files must be 1-$LoopMaxFiles, found $($p.Count)") }
  foreach ($x in $p) {
    if (-not ($x -cmatch $LoopPathRx) -or @($x -split '/' | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count) { $why.Add("unsafe path: $x") }
    elseif ($x -match $LoopForbiddenRx) { $why.Add("forbidden path: $x") }
  }
  return @($why.ToArray())
}
