<#
CheckBeforeClick Gate 005H - read-only verification of review evidence archives. Windows PowerShell 5.1 compatible.

  -Path <archive>    verify one archive
  -All <results>     verify every archive folder directly under <results> (and loop sessions' rounds)

An archive with MANIFEST.sha256 must match it exactly (no missing, changed or unlisted files). An older archive with
only MANIFEST.md (the hand-run Codex trial archives) is checked against every "| ... | <relative> | <sha256> | ... |"
row of its table; files present but not in the table are reported as unlisted, not as failures. Nothing is written.
Exit codes: 0 all verified, 1 any problem, 3 usage.
#>
[CmdletBinding()]
param([string]$Path = '', [string]$All = '', [switch]$LoadOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'loop-common.ps1')
. (Join-Path $PSScriptRoot 'archive.ps1')

function Test-LegacyArchive([string]$Dir) {
  $why = New-Object System.Collections.Generic.List[string]; $info = New-Object System.Collections.Generic.List[string]; $listed = @{}; $rows = 0
  $md = Join-Path $Dir 'MANIFEST.md'
  foreach ($l in [IO.File]::ReadAllLines($md)) {
    if ($l -cmatch '^\| [^|]+ \| ([^|]+?) \| ([0-9a-f]{64}) \| [^|]+ \|$') {
      $rows++; $rel = $Matches[1].Trim(); $h = $Matches[2]; $listed[$rel.Replace('/', '\')] = $true
      $got = Get-LoopSha (Join-Path $Dir $rel)
      if ($got -eq '<missing>') { $why.Add("missing: $rel") } elseif ($got -cne $h) { $why.Add("changed: $rel") }
    }
  }
  if ($rows -eq 0) { $why.Add('MANIFEST.md has no hash rows') }
  Get-ChildItem -LiteralPath $Dir -Recurse -File -Force | ForEach-Object { $rel = $_.FullName.Substring($Dir.TrimEnd('\').Length + 1); if ($rel -ne 'MANIFEST.md' -and -not $listed.ContainsKey($rel)) { $info.Add("unlisted (legacy table): $rel") } }
  return [pscustomobject]@{ Problems = @($why.ToArray()); Info = @($info.ToArray()); Rows = $rows }
}
function Test-OneArchive([string]$Dir) {
  if (Test-Path -LiteralPath (Join-Path $Dir 'MANIFEST.sha256')) { $p = @(Test-ShaManifest $Dir); return [pscustomobject]@{ Kind = 'MANIFEST.sha256'; Problems = $p; Info = @(); Rows = @(Get-Content -LiteralPath (Join-Path $Dir 'MANIFEST.sha256')).Count } }
  if (Test-Path -LiteralPath (Join-Path $Dir 'MANIFEST.md')) { $r = Test-LegacyArchive $Dir; return [pscustomobject]@{ Kind = 'MANIFEST.md (legacy)'; Problems = $r.Problems; Info = $r.Info; Rows = $r.Rows } }
  return [pscustomobject]@{ Kind = 'none'; Problems = @('no MANIFEST.sha256 or MANIFEST.md'); Info = @(); Rows = 0 }
}
function Invoke-VerifyMain {
  if ([bool]$Path -eq [bool]$All) { Write-Host 'Usage: -Path <archive> | -All <results folder>'; return 3 }
  $dirs = @(if ($Path) { (Resolve-Path -LiteralPath $Path).ProviderPath } else { Get-ChildItem -LiteralPath $All -Directory | ForEach-Object { $_.FullName } })
  $bad = 0
  foreach ($d in $dirs) {
    $r = Test-OneArchive $d
    $ok = $r.Problems.Count -eq 0; if (-not $ok) { $bad++ }
    Write-Host ('{0} {1}  [{2}, {3} entries]' -f $(if ($ok) { 'VERIFIED' } else { 'FAILED  ' }), (Split-Path $d -Leaf), $r.Kind, $r.Rows)
    foreach ($p in $r.Problems) { Write-Host "    problem: $p" }
    foreach ($i in $r.Info) { Write-Host "    info: $i" }
  }
  Write-Host ("archives: {0}, failed: {1}" -f $dirs.Count, $bad)
  if ($bad) { return 1 }; return 0
}
if ($LoadOnly) { return }
exit (Invoke-VerifyMain)
