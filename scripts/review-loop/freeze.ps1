<#
CheckBeforeClick Gate 005H - freezes the working repository's uncommitted changes for one review round
(dot-sourced after loop-common.ps1 and archive.ps1). The frozen set is exactly the repository's changed files
(minus the fixed exclusion list); nothing is chosen by hand. An existing input folder is replaced only when an
identical copy of it already sits in an archive.
#>

function Find-ArchivedInput([string]$InputDir, [string]$ResultsDir) {
  $want = Get-LoopSha (Join-Path $InputDir 'MANIFEST.sha256')
  foreach ($m in @(Get-ChildItem -LiteralPath $ResultsDir -Recurse -File -Force -Filter 'MANIFEST.sha256' | Where-Object { (Split-Path (Split-Path $_.FullName) -Leaf) -eq 'input' -and (Get-LoopSha $_.FullName) -ceq $want })) {
    $arch = Split-Path $m.FullName
    $live = @(Get-ChildItem -LiteralPath $InputDir -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($InputDir.TrimEnd('\').Length + 1) } | Sort-Object)
    $old = @(Get-ChildItem -LiteralPath $arch -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($arch.TrimEnd('\').Length + 1) } | Sort-Object)
    if (($live -join '|') -ceq ($old -join '|') -and -not @($live | Where-Object { (Get-LoopSha (Join-Path $InputDir $_)) -cne (Get-LoopSha (Join-Path $arch $_)) }).Count) { return $arch }
  }
  return $null
}
function New-LoopFreeze([string]$Repo, [string]$InputDir, [string]$ResultsDir) {
  # Returns @{ Ok; Why[]; ManifestSha; Paths[] }. Never deletes an input folder that is not archived.
  if (-not $InputDir.EndsWith('\codex-trial\inputs\loop-current')) { throw "refused: unexpected input folder $InputDir" }
  if (Test-Path -LiteralPath $InputDir) {
    $arch = Find-ArchivedInput $InputDir $ResultsDir
    if (-not $arch) { return [pscustomobject]@{ Ok = $false; Why = @("existing $InputDir is not archived anywhere under $ResultsDir; refusing to replace it"); ManifestSha = ''; Paths = @() } }
    Remove-Item -LiteralPath $InputDir -Recurse -Force
  }
  $cs = Get-ChangedSet $Repo
  $why = @(); if ($cs.Unsupported.Count) { $why += 'unsupported changes (deletions, renames or quoted paths): ' + ($cs.Unsupported -join ' / ') }
  $why += @(Test-LoopPaths $cs.Paths)
  $bytes = 0; foreach ($p in $cs.Paths) { $f = Join-Path $Repo $p.Replace('/', '\'); if (Test-Path -LiteralPath $f -PathType Leaf) { $bytes += (Get-Item -LiteralPath $f).Length } }
  if ($bytes -gt $LoopMaxBytes) { $why += "changed files total $bytes bytes, more than $LoopMaxBytes" }
  if ($why.Count) { return [pscustomobject]@{ Ok = $false; Why = $why; ManifestSha = ''; Paths = $cs.Paths } }
  $lines = @()
  foreach ($p in $cs.Paths) {
    $src = Join-Path $Repo $p.Replace('/', '\'); $dst = Join-Path (Join-Path $InputDir 'files') $p.Replace('/', '\')
    [void](New-Item -ItemType Directory -Force -Path (Split-Path $dst)); Copy-Item -LiteralPath $src -Destination $dst
    $h = Get-LoopSha $dst; if ($h -cne (Get-LoopSha $src)) { throw "freeze copy mismatch: $p" }
    $lines += ($h + '  ' + $p)
  }
  Write-LoopUtf8 (Join-Path $InputDir 'MANIFEST.sha256') (($lines -join "`n") + "`n")
  return [pscustomobject]@{ Ok = $true; Why = @(); ManifestSha = (Get-LoopSha (Join-Path $InputDir 'MANIFEST.sha256')); Paths = $cs.Paths }
}
