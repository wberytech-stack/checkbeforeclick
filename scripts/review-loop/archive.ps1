<#
CheckBeforeClick Gate 005H - evidence archiving for the review loop (dot-sourced after loop-common.ps1).
Archives are write-once: a destination that exists is refused, every copy is SHA-256 verified against its source,
and each archive gets a machine-checkable MANIFEST.sha256 ("<sha256>  <relative/path>", sorted, LF).
The four trial paths are cleared only when every file in them is byte-identical to an existing archive.
#>

function Copy-LoopVerified([object[]]$Pairs, [string]$Dest) {
  # $Pairs: @(source, relative destination). Returns rows; Failed counts copies whose hash differs.
  $rows = New-Object System.Collections.Generic.List[object]; $failed = 0
  foreach ($pr in $Pairs) {
    $src = [string]$pr[0]; $rel = [string]$pr[1]; $dst = Join-Path $Dest $rel
    if (Test-Path -LiteralPath $dst) { throw "refused: archive file already exists: $dst" }
    [void](New-Item -ItemType Directory -Force -Path (Split-Path $dst)); Copy-Item -LiteralPath $src -Destination $dst
    $hs = Get-LoopSha $src; $hd = Get-LoopSha $dst; if ($hs -cne $hd) { $failed++ }
    $rows.Add([pscustomobject]@{ Source = $src; Rel = $rel; Sha = $hd; Ok = ($hs -ceq $hd) })
  }
  return [pscustomobject]@{ Rows = $rows.ToArray(); Failed = $failed }
}
function Get-ShaManifestLines([string]$Dir) {
  $root = (Resolve-Path -LiteralPath $Dir).ProviderPath.TrimEnd('\')
  return @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object { $_.FullName -ne (Join-Path $root 'MANIFEST.sha256') } |
      ForEach-Object { [pscustomobject]@{ Rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/'); Full = $_.FullName } } |
      Sort-Object { $_.Rel } -CaseSensitive | ForEach-Object { (Get-LoopSha $_.Full) + '  ' + $_.Rel })
}
function Write-ShaManifest([string]$Dir) {
  $m = Join-Path $Dir 'MANIFEST.sha256'
  if (Test-Path -LiteralPath $m) { throw "refused: $m already exists (archives are write-once)" }
  $lines = Get-ShaManifestLines $Dir
  Write-LoopUtf8 $m (($lines -join "`n") + "`n")
  return (Get-LoopSha $m)
}
function Test-ShaManifest([string]$Dir) {
  # Returns problems: missing or changed files, files not listed, malformed lines. Empty = verified.
  $m = Join-Path $Dir 'MANIFEST.sha256'; $why = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath $m -PathType Leaf)) { $why.Add('MANIFEST.sha256 missing'); return @($why.ToArray()) }
  $listed = @{}
  foreach ($l in @(([IO.File]::ReadAllText($m) -split "`n") | Where-Object { $_ -ne '' })) {
    if (-not ($l -cmatch '^([0-9a-f]{64})  (.+)$')) { $why.Add("malformed line: $l"); continue }
    $h = $Matches[1]; $rel = $Matches[2]; $listed[$rel] = $true
    if (@($rel -split '/' | Where-Object { $_ -eq '..' }).Count) { $why.Add("unsafe path: $rel"); continue }
    $f = Join-Path $Dir $rel.Replace('/', '\')
    $got = Get-LoopSha $f
    if ($got -eq '<missing>') { $why.Add("missing: $rel") } elseif ($got -cne $h) { $why.Add("changed: $rel") }
  }
  foreach ($l in (Get-ShaManifestLines $Dir)) { $rel = $l.Substring(66); if (-not $listed.ContainsKey($rel)) { $why.Add("not listed: $rel") } }
  return @($why.ToArray())
}

# ---- the four trial paths ---------------------------------------------------------------------------
function Get-TrialFiles($T) {
  # Every file in the four trial paths that is evidence, as @(source, archive-relative path).
  $pairs = @()
  if (Test-Path -LiteralPath $T.Run) { $pairs += @(Get-ChildItem -LiteralPath $T.Run -Recurse -File -Force | Sort-Object FullName | ForEach-Object { , @($_.FullName, ('run\' + $_.FullName.Substring($T.Run.Length + 1))) }) }
  if (Test-Path -LiteralPath $T.Canary) { $pairs += @(Get-ChildItem -LiteralPath $T.Canary -Recurse -File -Force | Sort-Object FullName | ForEach-Object { , @($_.FullName, ('canary\' + $_.FullName.Substring($T.Canary.Length + 1))) }) }
  if (Test-Path -LiteralPath $T.Temp -PathType Leaf) { $pairs += , @($T.Temp, 'temp\cbc-codex-canary.txt') }
  $next = Join-Path $T.Trial '.next'
  if (Test-Path -LiteralPath $next) { $pairs += @(Get-ChildItem -LiteralPath $next -Recurse -File -Force | Sort-Object FullName | ForEach-Object { , @($_.FullName, ('clone\.next\' + $_.FullName.Substring($next.Length + 1))) }) }
  return , $pairs
}
function Get-CloneStatus($T) {
  if (-not (Test-Path -LiteralPath (Join-Path $T.Trial '.git'))) { return '' }
  return ((Get-LoopLines (Invoke-LoopGit @('status', '--porcelain=v1', '--ignored', '--untracked-files=all') $T.Trial)) -join ' | ')
}
function Save-TrialEvidence($T, [string]$Dest, [string[]]$FrozenPaths, [string]$ResultsDir) {
  # Copies (never moves) the run evidence into $Dest; the trial paths stay in place.
  $pairs = Get-TrialFiles $T
  if (Test-Path -LiteralPath (Join-Path $T.Trial '.git')) {
    foreach ($f in $FrozenPaths) { $src = Join-Path $T.Trial $f.Replace('/', '\'); if (Test-Path -LiteralPath $src -PathType Leaf) { $pairs += , @($src, ('clone\files\' + $f.Replace('/', '\'))) } }
  }
  foreach ($r in @('report-Proof.md', 'report-Review.md')) { $src = Join-Path $ResultsDir $r; if (Test-Path -LiteralPath $src -PathType Leaf) { $pairs += , @($src, "results-copy\$r") } }
  $res = Copy-LoopVerified $pairs $Dest
  if (Test-Path -LiteralPath (Join-Path $T.Trial '.git')) {
    $facts = @(('HEAD: ' + (Invoke-LoopGit @('rev-parse', 'HEAD') $T.Trial).Trim()),
      ('branch: ' + (Invoke-LoopGit @('rev-parse', '--abbrev-ref', 'HEAD') $T.Trial).Trim()),
      ('status: ' + (Get-CloneStatus $T)))
    [void](New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'clone')); Write-LoopUtf8 (Join-Path $Dest 'clone\clone-facts.txt') (($facts -join "`n") + "`n")
  }
  return $res
}
function Test-TrialMatchesArchive($T, [string]$Archive) {
  # True only if every live evidence file has a byte-identical copy in $Archive, the archive holds no live file
  # that has since disappeared, and the clone's frozen files and status equal what was recorded.
  $why = New-Object System.Collections.Generic.List[string]
  $live = Get-TrialFiles $T
  $liveRel = @{}; foreach ($p in $live) { $liveRel[[string]$p[1]] = $true; if ((Get-LoopSha $p[0]) -cne (Get-LoopSha (Join-Path $Archive $p[1]))) { $why.Add("differs from archive: $($p[1])") } }
  foreach ($sub in @('run', 'canary', 'temp', 'clone\.next')) {
    $d = Join-Path $Archive $sub
    if (Test-Path -LiteralPath $d) { Get-ChildItem -LiteralPath $d -Recurse -File -Force | ForEach-Object { $rel = $_.FullName.Substring($Archive.TrimEnd('\').Length + 1); if (-not $liveRel.ContainsKey($rel)) { $why.Add("archived but no longer live: $rel") } } }
  }
  if (Test-Path -LiteralPath (Join-Path $T.Trial '.git')) {
    $files = Join-Path $Archive 'clone\files'
    $frozen = @(); if (Test-Path -LiteralPath $files) { $frozen = @(Get-ChildItem -LiteralPath $files -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($files.Length + 1) }) }
    if (-not $frozen.Count) { $why.Add('archive has no clone\files to compare the live clone with') }
    foreach ($f in $frozen) { if ((Get-LoopSha (Join-Path $T.Trial $f)) -cne (Get-LoopSha (Join-Path $files $f))) { $why.Add("clone file differs: $f") } }
    $factsFile = Join-Path $Archive 'clone\clone-facts.txt'
    $rec = @(if (Test-Path -LiteralPath $factsFile) { Get-Content -LiteralPath $factsFile | Where-Object { $_ -like 'status: *' -or $_ -like 'status (incl. ignored): *' } })
    $recStatus = $null
    if ($rec.Count -and $rec[0] -like 'status: *') { $recStatus = $rec[0].Substring(8) }
    elseif ($rec.Count) { $lines = @(Get-Content -LiteralPath $factsFile); $i = [array]::IndexOf($lines, $rec[0]); if ($i -ge 0 -and $i + 1 -lt $lines.Count) { $recStatus = $lines[$i + 1] } }
    if ($null -eq $recStatus -or $recStatus -cne (Get-CloneStatus $T)) { $why.Add('clone status differs from the recorded status') }
  }
  return @($why.ToArray())
}
function Find-ArchiveForTrial($T, [string]$ResultsDir) {
  # Candidate archives are those whose run\proof-result.json (or run\report-Proof.md) equals the live one.
  $key = Join-Path $T.Run 'proof-result.json'; if (-not (Test-Path -LiteralPath $key)) { $key = Join-Path $T.Run 'report-Proof.md' }
  if (-not (Test-Path -LiteralPath $key)) { return $null }
  $leaf = Split-Path $key -Leaf; $want = Get-LoopSha $key
  $cands = @(Get-ChildItem -LiteralPath $ResultsDir -Recurse -File -Force -Filter $leaf | Where-Object { (Split-Path (Split-Path $_.FullName) -Leaf) -eq 'run' -and (Get-LoopSha $_.FullName) -ceq $want })
  foreach ($c in $cands) { $arch = Split-Path (Split-Path $c.FullName); if (@(Test-TrialMatchesArchive $T $arch).Count -eq 0) { return $arch } }
  return $null
}
function Clear-TrialPaths($T, [hashtable]$Expected) {
  # Exact-path guard: only the four configured paths, each compared with its expected value first.
  foreach ($k in @('Trial', 'Canary', 'Run', 'Temp')) { if ([string]$T.$k -cne [string]$Expected[$k]) { throw "refused: trial path $k is $($T.$k), expected $($Expected[$k])" } }
  foreach ($d in @($T.Trial, $T.Run, $T.Canary)) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }
  if (Test-Path -LiteralPath $T.Temp) { [IO.File]::Delete($T.Temp) }
  foreach ($p in @($T.Trial, $T.Run, $T.Canary, $T.Temp)) { if (Test-Path -LiteralPath $p) { throw "could not clear $p" } }
}
