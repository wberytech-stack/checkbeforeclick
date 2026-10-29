<#
CheckBeforeClick Gate 005H - strict parser for one Codex review run. Windows PowerShell 5.1 compatible. Read-only.

Classifies the evidence of ONE passed runner Review (report-Review.md, review.md, review-events.jsonl) as exactly one of:
  clean      no finding marker at all, no "Review comment" header, and an explicit no-defects statement;
  findings   a "Review comment:" header followed only by well-formed findings
             "- [P0-3] <title> <em dash> <path>:<line>[-<line>]" with indented bodies, every path inside the
             frozen set, and every "[P<digit>" marker in the text belonging to a parsed finding;
  ambiguous  anything else. Ambiguous always stops the loop; nothing is guessed.
Codex findings are data for the fix round, never approval of anything.

Usage: powershell -NoProfile -ExecutionPolicy Bypass -File review-parse.ps1 -RunDir <dir> -FrozenManifest <MANIFEST.sha256>
         -CloneRoot <trial clone path> -OutFile <findings.json>
Exit codes: 0 clean, 1 findings, 2 ambiguous, 3 usage error. The JSON file is written in every non-usage case.
#>
[CmdletBinding()]
param(
  [string]$RunDir = '',
  [string]$FrozenManifest = '',
  [string]$CloneRoot = '',
  [string]$OutFile = '',
  [switch]$LoadOnly    # defines the functions only (used by tests); runs nothing
)
$ErrorActionPreference = 'Stop'

$ParseSchemaVersion = 1
$MaxReviewChars = 200000
$PassHeader = '# Codex trial - Review - RESULT: PASS'
$EmDash = [string][char]0x2014
$FindingRx = '^- \[P([0-3])\] (.+) ' + $EmDash + ' (.+?):([0-9]+)(?:-([0-9]+))?$'
$HeaderRx = '^Review comments?:$'
$MarkerRx = '\[P[0-9]'
$CleanRx = '(?i)\bno (actionable |blocking |material )?(defects|issues|findings|problems|bugs)\b|\b(did not|didn''t) (identify|find)\b|\bfound no\b'
$CaveatRx = '(?i)\bnot (exercised|tested|run|verified|covered)\b|\bcould not\b|\bunable to\b'

function Get-Sha256Text([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}
function ConvertTo-RepoPath([string]$Raw, [string]$Root) {
  # Returns a repository-relative path with forward slashes, or $null when the path is outside the clone.
  $p = $Raw.Trim()
  if ($Root) {
    $r = $Root.TrimEnd('\', '/')
    if ($p.Length -gt $r.Length + 1 -and $p.StartsWith($r, [StringComparison]::OrdinalIgnoreCase) -and ($p[$r.Length] -eq [char]'\' -or $p[$r.Length] -eq [char]'/')) { $p = $p.Substring($r.Length + 1) }
  }
  $p = $p.Replace('\', '/')
  if ($p.StartsWith('./')) { $p = $p.Substring(2) }
  if ($p -match '^[A-Za-z]:' -or $p.StartsWith('/') -or @($p -split '/' | Where-Object { $_ -eq '..' -or $_ -eq '.' -or $_ -eq '' }).Count) { return $null }
  return $p
}
function Get-ReviewOutcome {
  param([string]$ReviewText, [string]$EventsText, [string]$ReportText, [string[]]$FrozenPaths, [string]$CloneRoot)
  $reasons = New-Object System.Collections.Generic.List[string]
  $findings = New-Object System.Collections.Generic.List[object]
  $text = ([string]$ReviewText).Replace("`r`n", "`n").Trim()

  # 1. The runner itself must have passed this Review.
  $first = (([string]$ReportText).Replace("`r`n", "`n") -split "`n")[0]
  if ($first -cne $PassHeader) { $reasons.Add('report-Review.md does not start with the runner PASS header') }
  # 2. review.md must be present, bounded, and identical to the single final agent message in the event log.
  if ($text.Length -eq 0) { $reasons.Add('review.md is empty') }
  if ($text.Length -gt $MaxReviewChars) { $reasons.Add("review.md exceeds $MaxReviewChars characters") }
  $msgs = New-Object System.Collections.Generic.List[string]; $bad = 0
  foreach ($line in (([string]$EventsText) -split "`r?`n")) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $e = $null; try { $e = $line | ConvertFrom-Json } catch { $bad++; continue }
    if ([string]$e.type -ceq 'item.completed' -and $null -ne $e.item -and [string]$e.item.type -ceq 'agent_message') { $msgs.Add(([string]$e.item.text).Replace("`r`n", "`n").Trim()) }
  }
  if ($bad) { $reasons.Add("review-events.jsonl has $bad unparseable lines") }
  if ($msgs.Count -ne 1) { $reasons.Add("expected exactly 1 final agent message, found $($msgs.Count)") }
  elseif ($msgs[0] -cne $text) { $reasons.Add('review.md differs from the final agent message in the event log') }

  # 3. Structure: summary, optional "Review comment:" header, findings with indented bodies.
  $lines = @($text -split "`n")
  $hdr = @(for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -cmatch $HeaderRx) { $i } })
  if ($hdr.Count -gt 1) { $reasons.Add('more than one "Review comment" header') }
  $summaryEnd = $(if ($hdr.Count) { $hdr[0] } else { $lines.Count })
  $summary = (($lines | Select-Object -First $summaryEnd) -join "`n").Trim()
  if ($hdr.Count -eq 1) {
    $cur = $null; $bodies = @{}
    for ($i = $hdr[0] + 1; $i -lt $lines.Count; $i++) {
      $l = $lines[$i]
      if ($l -cmatch $FindingRx) {
        $g = @($Matches[1], $Matches[2], $Matches[3], $Matches[4], $Matches[5])   # copied before any other match runs
        $path = ConvertTo-RepoPath $g[2] $CloneRoot
        $ls = [int]$g[3]; $le = $(if ($g[4]) { [int]$g[4] } else { $ls })
        $cur = [pscustomobject]@{ id = ('F' + ($findings.Count + 1)); priority = ('P' + $g[0]); title = $g[1].Trim(); path = $path; raw_path = $g[2]; line_start = $ls; line_end = $le; body = '' }
        $findings.Add($cur); $bodies[$cur.id] = New-Object System.Collections.Generic.List[string]
        if ($null -eq $path) { $reasons.Add("$($cur.id): path is outside the clone: $($g[2])") }
        elseif (@($FrozenPaths) -cnotcontains $path) { $reasons.Add("$($cur.id): path is not in the frozen set: $path") }
        if ($ls -lt 1 -or $le -lt $ls) { $reasons.Add("$($cur.id): invalid line range $ls-$le") }
      } elseif ($l.Trim().Length -eq 0) {
        if ($null -ne $cur) { $bodies[$cur.id].Add('') }
      } elseif ($l.StartsWith('  ') -and $null -ne $cur) {
        $bodies[$cur.id].Add($l.Substring(2))
      } else {
        $reasons.Add("unrecognized line after the Review comment header: $($l.Substring(0, [Math]::Min(80, $l.Length)))")
      }
    }
    foreach ($f in $findings) { $f.body = (($bodies[$f.id].ToArray()) -join "`n").Trim() }
    if ($findings.Count -eq 0) { $reasons.Add('"Review comment" header without any well-formed finding') }
    if (@($findings | Where-Object { -not $_.body }).Count) { $reasons.Add('a finding has no body') }
  }
  # 4. Every [P<digit> marker anywhere must belong to a parsed finding header.
  $markers = ([regex]::Matches($text, $MarkerRx)).Count
  if ($markers -ne $findings.Count) { $reasons.Add("found $markers [P markers but $($findings.Count) well-formed findings") }
  # 5. Clean needs an explicit no-defects statement.
  if ($hdr.Count -eq 0 -and $markers -eq 0 -and -not ($text -match $CleanRx)) { $reasons.Add('no findings, but no explicit no-defects statement either') }

  $caveats = @([regex]::Split($text, '(?<=[.;])\s+') | Where-Object { $_ -match $CaveatRx } | ForEach-Object { $_.Trim() })
  $outcome = $(if ($reasons.Count) { 'ambiguous' } elseif ($findings.Count) { 'findings' } else { 'clean' })
  return [pscustomobject]@{
    schema_version = $ParseSchemaVersion; outcome = $outcome; reasons = @($reasons.ToArray()); findings = @($findings.ToArray())
    summary = $summary; caveats = $caveats; review_sha256 = (Get-Sha256Text $text)
  }
}
function Read-ManifestPaths([string]$Path) {
  return @(([IO.File]::ReadAllText($Path) -split "`n") | Where-Object { $_ -ne '' } | ForEach-Object { if ($_ -cmatch '^[0-9a-f]{64}  (.+)$') { $Matches[1] } else { '<malformed manifest line>' } })
}
function Invoke-ParseMain {
  if (-not $RunDir -or -not $FrozenManifest -or -not $CloneRoot -or -not $OutFile) { Write-Host 'Usage: -RunDir -FrozenManifest -CloneRoot -OutFile'; return 3 }
  $read = { param($f) if (Test-Path -LiteralPath $f -PathType Leaf) { [IO.File]::ReadAllText($f) } else { '' } }
  $res = Get-ReviewOutcome -ReviewText (& $read (Join-Path $RunDir 'review.md')) -EventsText (& $read (Join-Path $RunDir 'review-events.jsonl')) `
    -ReportText (& $read (Join-Path $RunDir 'report-Review.md')) -FrozenPaths (Read-ManifestPaths $FrozenManifest) -CloneRoot $CloneRoot
  [IO.File]::WriteAllText($OutFile, (ConvertTo-Json -InputObject $res -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("review outcome: " + $res.outcome + " (findings " + @($res.findings).Count + ")")
  foreach ($r in $res.reasons) { Write-Host "  ambiguous: $r" }
  switch ($res.outcome) { 'clean' { return 0 } 'findings' { return 1 } default { return 2 } }
}

if ($LoadOnly) { return }
exit (Invoke-ParseMain)
