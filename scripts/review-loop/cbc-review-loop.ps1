<#
CheckBeforeClick Gate 005H - Claude -> Codex -> Claude review loop. FOUNDER-OPERATED. Windows PowerShell 5.1.

Run by the founder in an ordinary, interactive PowerShell window:
  powershell -NoProfile -ExecutionPolicy Bypass -File cbc-review-loop.ps1 -Gate 007A [-MaxRounds 1..3]

Per review round (at most -MaxRounds, never more than 3):
  1. If the four trial paths are occupied, they are cleared only when every file in them is byte-identical to an
     existing archive, and only after the founder types  CLEAR <id>.
  2. Freeze: the frozen set is exactly the working repository's uncommitted changes (minus .agents/claude-handoff.yaml),
     with the runner's path, size and count guards. inputs\loop-current is replaced only if already archived.
  3. The founder types  APPROVE ROUND <n> <manifest prefix>  (the only spending approval: 1 Codex Proof call,
     1 Codex Review call, and if findings remain and rounds are left, 1 headless Claude fix session).
  4. The verified runner (pinned copy) runs Proof, then Review, target Loop. Any runner failure stops the loop.
  5. All evidence is copied (never moved) into the session archive and SHA-256 verified.
  6. review-parse.ps1 classifies the review: clean (done), findings, or ambiguous (stop).
  7. Findings -> headless 'claude -p' (no Bash, no Write, no network tools, no MCP, no user or local settings,
     Edit allowed only on the frozen files, dontAsk permission mode). Afterwards HEAD, branch, refs, stashes and every
     non-frozen file must be unchanged; Claude's JSON decisions must cover every finding and match the files that
     actually changed; any founder_only decision stops. The founder then sees Claude's exact edits (diff) and the
     test commands, and types  RUN TESTS <n> <diff prefix>  before the gate's local tests (gate-tests.json) run
     unsandboxed; the repository must still match the shown diff, and the tests must pass.
The loop never commits, pushes, merges, migrates, deploys or changes cloud settings: its git access is read-only
(Invoke-LoopGit), and those actions are only listed for the founder on the final screen.
Exit codes: 0 clean review, 1 stopped or findings left open, 3 refused (usage or no interactive console).
#>
[CmdletBinding()]
param(
  [string]$Gate = '',
  [ValidateRange(1, 3)][int]$MaxRounds = 3,
  [switch]$LoadOnly    # defines the functions only (used by tests\loop-offline-entry.ps1); runs nothing
)
$ErrorActionPreference = 'Stop'
$LoopHere = $PSScriptRoot
. (Join-Path $LoopHere 'loop-common.ps1')
. (Join-Path $LoopHere 'archive.ps1')
. (Join-Path $LoopHere 'freeze.ps1')

# ---- fixed configuration: NOT overridable from the command line ------------------------------------
$TestMode = $false
$RepoDir = Join-Path $env:USERPROFILE 'Documents\GitHub\checkbeforeclick'
$ReviewDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'chatgpt-review'
$KitDir = Join-Path $ReviewDir 'codex-trial'
$InputDir = Join-Path $KitDir 'inputs\loop-current'
$ResultsDir = Join-Path $KitDir 'results'
$TrialPaths = [pscustomobject]@{ Trial = (Join-Path $env:USERPROFILE 'cbc-codex-trial'); Canary = (Join-Path $env:USERPROFILE 'cbc-codex-canary'); Run = (Join-Path $env:USERPROFILE 'cbc-codex-run'); Temp = (Join-Path $env:TEMP 'cbc-codex-canary.txt') }
$ClaudeCommand = @((Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'))
$ClaudeTimeoutSec = 1800
$RunnerTimeoutSec = 2700
$TestTimeoutSec = 900
$ToolFiles = @('cbc-codex-trial.ps1', 'review-parse.ps1', 'loop-common.ps1', 'archive.ps1', 'freeze.ps1', 'claude-fix-prompt.md', 'claude-settings.json', 'gate-tests.json')
$ClaudeTools = 'Read,Grep,Glob,Edit'
$ClaudeDenied = @('Bash', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task')
$FounderOnlyList = @('commit', 'push', 'open or update a draft PR', 'merge (a Vercel production deployment while Vercel is live)', 'apply any migration', 'deploy', 'any Azure, Key Vault, Supabase, Vercel or cloud change')
$script:Answers = @(); $script:AnswerIdx = 0
$script:TestRunnerEntry = ''; $script:TestRunnerArgs = @()

# ---- logging, stopping, approvals -------------------------------------------------------------------
function Write-LoopLog([string]$Msg) {
  Write-Host $Msg
  if ($script:Session) { [IO.File]::AppendAllText((Join-Path $script:Session 'loop-log.txt'), ((Get-Date -Format 'HH:mm:ss') + ' ' + $Msg + "`n"), (New-Object System.Text.UTF8Encoding($false))) }
}
function Stop-Loop([string]$Reason) { throw ('LOOPSTOP: ' + $Reason) }
function Read-ApprovalLine {
  if ($TestMode) { if ($script:AnswerIdx -lt $script:Answers.Count) { return $script:Answers[$script:AnswerIdx++] }; return $null }
  return [Console]::ReadLine()
}
function Request-Approval([string]$Phrase, [string[]]$Lines) {
  if (-not $TestMode -and [Console]::IsInputRedirected) { Stop-Loop 'no interactive console: approvals must be typed by the founder' }
  Write-LoopLog ''
  foreach ($l in $Lines) { Write-LoopLog ('  ' + $l) }
  Write-LoopLog "Type exactly:  $Phrase"
  $ans = Read-ApprovalLine
  if ($TestMode -and $ans -ceq '<auto>') { $ans = $Phrase }   # offline tests only; TestMode is never set in production
  Write-LoopLog ('  answer: ' + $(if ($null -eq $ans) { '<none>' } else { $ans }))
  if ($ans -cne $Phrase) { Stop-Loop "approval not given (expected '$Phrase')" }
}

# ---- runner, parser, tests --------------------------------------------------------------------------
function Invoke-Runner([string]$Mode, [string]$Manifest, [string]$Base, [string]$RoundDir) {
  $ps = Join-Path $PSHOME 'powershell.exe'
  if ($TestMode) { $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:TestRunnerEntry, '-TrialMode', $Mode, '-Confirm') + $script:TestRunnerArgs + @('-TTarget', 'Loop', '-TManifest', $Manifest, '-TInputBase', $Base) }
  else { $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $script:Tools 'cbc-codex-trial.ps1'), '-Mode', $Mode, '-ConfirmModelCall', '-Target', 'Loop', '-InputManifestSha256', $Manifest, '-InputBaseSha', $Base) }
  Write-LoopLog "[runner] $Mode (target Loop, manifest $($Manifest.Substring(0, 12))...)"
  $r = Invoke-LoopProc $ps $a $env:TEMP $RunnerTimeoutSec
  Write-LoopUtf8 (Join-Path $RoundDir "runner-$Mode-console.txt") ($r.StdOut + "`n--- stderr ---`n" + $r.StdErr)
  $res = @(($r.StdOut -split "`r?`n") | Where-Object { $_ -match '^RESULT: ' }) | Select-Object -Last 1
  Write-LoopLog ("  " + $(if ($res) { $res } else { '<no RESULT line>' }) + " (exit $($r.ExitCode), $($r.Seconds) s)")
  if ($r.TimedOut) { return -1 }
  return $r.ExitCode
}
function Invoke-Parser([string]$RoundDir) {
  $ps = Join-Path $PSHOME 'powershell.exe'; $out = Join-Path $RoundDir 'findings.json'
  $r = Invoke-LoopProc $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $script:Tools 'review-parse.ps1'), '-RunDir', $TrialPaths.Run,
    '-FrozenManifest', (Join-Path $InputDir 'MANIFEST.sha256'), '-CloneRoot', $TrialPaths.Trial, '-OutFile', $out) $env:TEMP 300
  Write-LoopUtf8 (Join-Path $RoundDir 'parse-console.txt') ($r.StdOut + $r.StdErr)
  $j = $null; try { $j = [IO.File]::ReadAllText($out) | ConvertFrom-Json } catch { }
  if ($null -eq $j -or @(0, 1, 2) -notcontains $r.ExitCode) { Stop-Loop "review parser failed (exit $($r.ExitCode))" }
  return $j
}
function Get-GateTests {
  $cfg = [IO.File]::ReadAllText((Join-Path $script:Tools 'gate-tests.json')) | ConvertFrom-Json
  $entry = $null; if ($cfg.gates.PSObject.Properties.Name -ccontains $Gate) { $entry = $cfg.gates.$Gate }
  if ($null -eq $entry) { return $null }
  $tests = @()
  foreach ($t in @($entry)) {
    $parts = @($t | ForEach-Object { [string]$_ })
    if ($parts.Count -lt 1 -or -not ($parts[0] -cmatch $LoopPathRx) -or @($parts[0] -split '/' | Where-Object { $_ -eq '..' }).Count) { Stop-Loop "gate-tests.json: unsafe script path '$($parts[0])'" }
    if (@($parts | Select-Object -Skip 1 | Where-Object { -not ($_ -cmatch '^[A-Za-z0-9._/=-]+$') }).Count) { Stop-Loop "gate-tests.json: unsafe argument in '$($parts -join ' ')'" }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoDir $parts[0].Replace('/', '\')) -PathType Leaf)) { Stop-Loop "gate-tests.json: '$($parts[0])' does not exist in the repository" }
    $tests += , $parts
  }
  return , $tests
}
function Invoke-GateTests($Tests, [string]$OutFile) {
  $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
  $log = New-Object System.Collections.Generic.List[string]; $failed = 0
  foreach ($t in $Tests) {
    $r = Invoke-LoopProc $node @($t) $RepoDir $TestTimeoutSec
    $ok = (-not $r.TimedOut -and $r.ExitCode -eq 0); if (-not $ok) { $failed++ }
    $line = ('{0} node {1} (exit {2}{3})' -f $(if ($ok) { 'PASS' } else { 'FAIL' }), ($t -join ' '), $r.ExitCode, $(if ($r.TimedOut) { ', timed out' } else { '' }))
    Write-LoopLog "  $line"; $log.Add("== $line"); $log.Add($r.StdOut); $log.Add('--- stderr ---'); $log.Add($r.StdErr)
  }
  Write-LoopUtf8 $OutFile (($log.ToArray()) -join "`n")
  return $failed
}

# ---- headless Claude fix round ----------------------------------------------------------------------
function Test-ProjectClaudeSettings {
  # --setting-sources project still loads <repo>\.claude\settings.json; it must not grant permissions or run hooks.
  $f = Join-Path $RepoDir '.claude\settings.json'
  if (-not (Test-Path -LiteralPath $f)) { return }
  $j = $null; try { $j = [IO.File]::ReadAllText($f) | ConvertFrom-Json } catch { Stop-Loop "project Claude settings are not valid JSON: $f" }
  $bad = @(@('permissions', 'hooks', 'env', 'apiKeyHelper', 'statusLine') | Where-Object { @($j.PSObject.Properties.Name) -ccontains $_ })
  if ($bad.Count) { Stop-Loop ("project Claude settings contain " + ($bad -join ', ') + "; the headless fix session would inherit them") }
}
function Get-ClaudeArgs([string[]]$Frozen, [string]$Settings, [string]$Mcp) {
  return @('-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text', '--permission-mode', 'dontAsk',
    '--setting-sources', 'project', '--settings', $Settings, '--strict-mcp-config', '--mcp-config', $Mcp,
    '--no-session-persistence', '--disable-slash-commands', '--tools', $ClaudeTools,
    '--allowedTools') + @('Read', 'Grep', 'Glob') + @($Frozen | ForEach-Object { "Edit(./$_)" }) + @('--disallowedTools') + $ClaudeDenied
}
function Read-ClaudeResponse([string]$Transcript) {
  $results = @()
  foreach ($l in (Get-LoopLines $Transcript)) { $e = $null; try { $e = $l | ConvertFrom-Json } catch { Stop-Loop 'Claude transcript has a non-JSON line' }; if ([string]$e.type -ceq 'result') { $results += , $e } }
  if ($results.Count -ne 1) { Stop-Loop "expected exactly 1 result event from Claude, found $($results.Count)" }
  $res = $results[0]
  if ([string]$res.subtype -cne 'success' -or $res.is_error -eq $true) { Stop-Loop "Claude did not finish successfully (subtype '$($res.subtype)')" }
  $txt = ([string]$res.result).Trim()
  if ($txt -match '^```(json)?\s*\n([\s\S]*)\n```$') { $txt = $Matches[2].Trim() }
  try { return ($txt | ConvertFrom-Json) } catch { Stop-Loop 'Claude reply is not the required JSON object' }
}
function Test-ClaudeDecisions($Resp, [int]$Round, $Findings, [string[]]$Frozen, [string[]]$Changed) {
  $why = New-Object System.Collections.Generic.List[string]
  if ($Resp.schema_version -ne 1 -or $Resp.round -ne $Round) { $why.Add('schema_version must be 1 and round must be ' + $Round) }
  $dec = @($Resp.decisions)
  $ids = @($Findings | ForEach-Object { [string]$_.id } | Sort-Object); $got = @($dec | ForEach-Object { [string]$_.finding_id } | Sort-Object)
  if (($ids -join '|') -cne ($got -join '|')) { $why.Add("decisions must cover each finding exactly once (findings: $($ids -join ', '); decisions: $($got -join ', '))") }
  $fixedFiles = @()
  foreach ($d in $dec) {
    $files = @($d.files | ForEach-Object { [string]$_ })
    if (@('fixed', 'rejected', 'founder_only') -cnotcontains [string]$d.decision) { $why.Add("$($d.finding_id): unknown decision '$($d.decision)'"); continue }
    if (-not ([string]$d.rationale).Trim()) { $why.Add("$($d.finding_id): rationale missing") }
    $outside = @($files | Where-Object { $Frozen -cnotcontains $_ }); if ($outside.Count) { $why.Add("$($d.finding_id): files outside the frozen set: $($outside -join ', ')") }
    if ([string]$d.decision -ceq 'fixed') {
      if (-not $files.Count) { $why.Add("$($d.finding_id): fixed but no files listed") }
      $unchanged = @($files | Where-Object { $Changed -cnotcontains $_ }); if ($unchanged.Count) { $why.Add("$($d.finding_id): listed as fixed but unchanged: $($unchanged -join ', ')") }
      $fixedFiles += $files
    } elseif ($files.Count) { $why.Add("$($d.finding_id): $($d.decision) must list no files") }
  }
  $unlisted = @($Changed | Where-Object { $fixedFiles -cnotcontains $_ }); if ($unlisted.Count) { $why.Add("changed but not listed under any fixed decision: $($unlisted -join ', ')") }
  return @($why.ToArray())
}
function Invoke-ClaudeFix([int]$Round, [string]$RoundDir, [string[]]$Frozen, $Parsed, $Tests) {
  Write-LoopLog "[claude] headless fix session for $(@($Parsed.findings).Count) finding(s)"
  Test-ProjectClaudeSettings
  $fix = Join-Path $RoundDir 'fix'; [void](New-Item -ItemType Directory -Path $fix)
  $mcp = Join-Path $fix 'empty-mcp.json'; Write-LoopUtf8 $mcp '{"mcpServers":{}}'
  $findings = @($Parsed.findings | ForEach-Object { [ordered]@{ id = $_.id; priority = $_.priority; title = $_.title; path = $_.path; line_start = $_.line_start; line_end = $_.line_end; body = $_.body } })
  $prompt = [IO.File]::ReadAllText((Join-Path $script:Tools 'claude-fix-prompt.md')).Replace('{{GATE}}', $Gate).Replace('{{ROUND}}', [string]$Round).
    Replace('{{FROZEN_FILES}}', (($Frozen | ForEach-Object { "  - $_" }) -join "`n")).Replace('{{FINDINGS_JSON}}', (ConvertTo-Json -InputObject @($findings) -Depth 5))
  Write-LoopUtf8 (Join-Path $fix 'claude-prompt.txt') $prompt
  $argv = Get-ClaudeArgs $Frozen (Join-Path $script:Tools 'claude-settings.json') $mcp
  $exe = $ClaudeCommand[0]; $full = @($ClaudeCommand | Select-Object -Skip 1) + $argv
  Write-LoopUtf8 (Join-Path $fix 'claude-argv.txt') ((@($exe) + $full) -join "`n")
  $pre = Get-RepoState $RepoDir $Frozen
  $r = Invoke-LoopProc $exe $full $RepoDir $ClaudeTimeoutSec $prompt
  Write-LoopUtf8 (Join-Path $fix 'claude-transcript.jsonl') $r.StdOut; Write-LoopUtf8 (Join-Path $fix 'claude-stderr.txt') $r.StdErr
  $post = Get-RepoState $RepoDir $Frozen
  foreach ($k in @('Head', 'Branch', 'Refs', 'Stash')) { if ([string]$pre.$k -cne [string]$post.$k) { Stop-Loop "the Claude session changed git $k (HEAD, branch, refs and stashes must stay unchanged)" } }
  $prePaths = @($pre.Status -split "`n" | Where-Object { $_ } | ForEach-Object { $_.Substring(3) } | Sort-Object); $postPaths = @($post.Status -split "`n" | Where-Object { $_ } | ForEach-Object { $_.Substring(3) } | Sort-Object)
  if (($prePaths -join '|') -cne ($postPaths -join '|')) { Stop-Loop ('the Claude session changed which files are modified: before [' + ($prePaths -join ', ') + '] after [' + ($postPaths -join ', ') + ']') }
  $keys = @(@($pre.Hashes.Keys) + @($post.Hashes.Keys) | Sort-Object -Unique)
  $outside = @($keys | Where-Object { $Frozen -cnotcontains $_ -and [string]$pre.Hashes[$_] -cne [string]$post.Hashes[$_] })
  if ($outside.Count) { Stop-Loop ('the Claude session changed files outside the frozen set: ' + ($outside -join ', ')) }
  if ($r.TimedOut) { Stop-Loop "the Claude session timed out after $ClaudeTimeoutSec s" }
  if ($r.ExitCode -ne 0) { Stop-Loop "the Claude session exited with $($r.ExitCode)" }
  $changed = @($Frozen | Where-Object { [string]$pre.Hashes[$_] -cne [string]$post.Hashes[$_] })
  $resp = Read-ClaudeResponse $r.StdOut
  Write-LoopUtf8 (Join-Path $fix 'claude-response.json') (ConvertTo-Json -InputObject $resp -Depth 6)
  if ($changed.Count) { $null = Copy-LoopVerified @($changed | ForEach-Object { , @((Join-Path $RepoDir $_.Replace('/', '\')), ('after\' + $_.Replace('/', '\'))) }) $fix }
  $why = @(Test-ClaudeDecisions $resp $Round @($Parsed.findings) $Frozen $changed)
  if ($why.Count) { Stop-Loop ('Claude decisions invalid: ' + ($why -join '; ')) }
  $fo = @(@($resp.decisions) | Where-Object { [string]$_.decision -ceq 'founder_only' })
  if ($fo.Count) { Stop-Loop ('founder decision needed for: ' + ((@($fo | ForEach-Object { "$($_.finding_id) ($($_.rationale))" })) -join '; ')) }
  if (-not $changed.Count) { Stop-Loop 'Claude applied no fix (all findings rejected); the founder decides whether to re-review' }

  # The founder sees Claude's exact edits (frozen copy -> current file) and approves them BEFORE any gate test runs:
  # the tests execute repository code, which may include what Claude just changed, with the founder's user rights.
  $diff = Get-FixDiff $RoundDir $changed
  Write-LoopUtf8 (Join-Path $fix 'diff.patch') $diff
  $diffSha = Get-LoopSha (Join-Path $fix 'diff.patch')
  $summary = @("Fix round $Round summary:")
  foreach ($d in @($resp.decisions)) { $summary += ("  {0}: {1} {2} - {3}" -f $d.finding_id, $d.decision, $(if (@($d.files).Count) { '[' + (@($d.files) -join ', ') + ']' } else { '' }), $d.rationale) }
  $summary += ('  changed files: ' + ($changed -join ', '))
  $selfTested = @($Tests | Where-Object { $Frozen -ccontains $_[0] } | ForEach-Object { $_[0] }); if ($selfTested.Count) { $summary += ('  NOTE: these test files are in the frozen set, so the fix could have changed them: ' + ($selfTested -join ', ')) }
  $lines = @($summary) + @('', "--- Claude's edits (diff.patch, SHA-256 $diffSha) ---") + @(($diff -split "`r?`n")) + @('--- end of diff ---', '',
    'Approving runs these local tests NOW, with your user rights and NOT sandboxed (they may execute the code above):') + @($Tests | ForEach-Object { '  node ' + ($_ -join ' ') })
  Request-Approval "RUN TESTS $Round $($diffSha.Substring(0, 8))" $lines
  $now = Get-RepoState $RepoDir $Frozen
  foreach ($k in @('Head', 'Branch', 'Refs', 'Stash', 'Status')) { if ([string]$post.$k -cne [string]$now.$k) { Stop-Loop "the repository changed (git $k) after the fix diff was shown; nothing was run" } }
  if (@(@(@($post.Hashes.Keys) + @($now.Hashes.Keys)) | Sort-Object -Unique | Where-Object { [string]$post.Hashes[$_] -cne [string]$now.Hashes[$_] }).Count) { Stop-Loop 'repository files changed after the fix diff was shown; nothing was run' }

  Write-LoopLog '[tests] gate tests after the approved fix'
  $failed = Invoke-GateTests $Tests (Join-Path $fix 'tests.txt')
  $after = Get-RepoState $RepoDir $Frozen
  foreach ($k in @('Head', 'Branch', 'Refs', 'Stash', 'Status')) { if ([string]$now.$k -cne [string]$after.$k) { Stop-Loop "the gate tests changed git $k" } }
  if (@($after.Hashes.Keys | Where-Object { [string]$now.Hashes[$_] -cne [string]$after.Hashes[$_] }).Count) { Stop-Loop 'the gate tests changed repository files' }
  if ($failed) { Stop-Loop "$failed gate test command(s) failed after the fix (see fix\tests.txt)" }
  $summary += ('  gate tests: all ' + @($Tests).Count + ' passed (run after the founder approved the diff)')
  return , $summary
}
function Get-FixDiff([string]$RoundDir, [string[]]$Changed) {
  # Claude's edits only: the round's frozen copy (input\files) against the current repository file.
  $parts = @()
  foreach ($p in $Changed) {
    $old = Join-Path $RoundDir ('input\files\' + $p.Replace('/', '\')); $new = Join-Path $RepoDir $p.Replace('/', '\')
    $parts += "### $p"
    $parts += (Invoke-LoopGit @('diff', '--no-color', '--no-index', '--', $old, $new) $RepoDir @(0, 1)).TrimEnd()
  }
  return (($parts -join "`n") + "`n")
}

# ---- one review round -------------------------------------------------------------------------------
function Get-RunId {
  $pr = Join-Path $TrialPaths.Run 'proof-result.json'
  if (Test-Path -LiteralPath $pr) { try { $n = [string]([IO.File]::ReadAllText($pr) | ConvertFrom-Json).nonce; if ($n -cmatch '^cbcprobe[0-9a-f]{16}$') { return $n.Substring(0, 20) } } catch { } }
  return ('run' + (Get-LoopSha (Join-Path $TrialPaths.Run 'report-Proof.md')).Substring(0, 12))
}
function Invoke-Round([int]$N, [string[]]$PrevSummary) {
  $rd = Join-Path $script:Session "round-$N"; [void](New-Item -ItemType Directory -Path $rd)
  Write-LoopLog "=== Round $N of $MaxRounds"
  $st = Get-RepoState $RepoDir
  if ($st.Head -cne $script:Base -or $st.Branch -cne $script:Branch) { Stop-Loop "repository HEAD or branch changed during the session ($($st.Branch) $($st.Head))" }
  if (@(@($TrialPaths.Trial, $TrialPaths.Canary, $TrialPaths.Run, $TrialPaths.Temp) | Where-Object { Test-Path -LiteralPath $_ }).Count) {
    $arch = Find-ArchiveForTrial $TrialPaths $ResultsDir
    if (-not $arch) { Stop-Loop 'the trial paths hold content that is not byte-identical to any archive; archive or inspect it by hand' }
    $id = Get-RunId
    Request-Approval "CLEAR $id" @("The trial paths hold run $id, archived at $arch (every file byte-identical).", 'Clearing removes only the four trial paths.')
    Clear-TrialPaths $TrialPaths $script:ExpectedTrial
    Write-LoopLog '  trial paths cleared'
  }
  $fz = New-LoopFreeze $RepoDir $InputDir $ResultsDir
  if (-not $fz.Ok) { Stop-Loop ('freeze refused: ' + ($fz.Why -join '; ')) }
  $in = Copy-LoopVerified (@(Get-ChildItem -LiteralPath $InputDir -Recurse -File -Force | ForEach-Object { , @($_.FullName, ('input\' + $_.FullName.Substring($InputDir.Length + 1))) })) $rd
  if ($in.Failed) { Stop-Loop 'input archive copy did not verify' }
  $script:Frozen = @($fz.Paths)
  $lines = @()
  if ($PrevSummary) { $lines += $PrevSummary; $lines += '' }
  $lines += @("Gate $Gate - review round $N of max $MaxRounds - base $($script:Base.Substring(0, 7)) - branch $($script:Branch)",
    "Frozen set: $($fz.Paths.Count) files - manifest $($fz.ManifestSha) - runner $($script:RunnerSha.Substring(0, 12))... (pinned)")
  $lines += @($fz.Paths | ForEach-Object { "  $_" })
  $lines += ('This round: 1 Codex Proof call + 1 Codex Review call' + $(if ($N -lt $MaxRounds) { '; if findings, 1 headless Claude fix session.' } else { '; last round (no fix session).' }))
  Request-Approval "APPROVE ROUND $N $($fz.ManifestSha.Substring(0, 8))" $lines
  $proof = Invoke-Runner 'Proof' $fz.ManifestSha $script:Base $rd
  if ($proof -ne 0) { Save-RoundEvidence $rd; Stop-Loop "runner Proof failed (exit $proof); see round-$N\runner-Proof-console.txt" }
  $rev = Invoke-Runner 'Review' $fz.ManifestSha $script:Base $rd
  if ($rev -ne 0) { Save-RoundEvidence $rd; Stop-Loop "runner Review failed (exit $rev); see round-$N\runner-Review-console.txt" }
  Save-RoundEvidence $rd
  $parsed = Invoke-Parser $rd
  Write-LoopLog "[review] outcome: $($parsed.outcome), findings: $(@($parsed.findings).Count)"
  foreach ($f in @($parsed.findings)) { Write-LoopLog "  $($f.id) [$($f.priority)] $($f.title) - $($f.path):$($f.line_start)-$($f.line_end)" }
  foreach ($c in @($parsed.caveats)) { Write-LoopLog "  caveat: $c" }
  if ($parsed.outcome -ceq 'ambiguous') { Stop-Loop ('ambiguous review result: ' + (@($parsed.reasons) -join '; ')) }
  if ($parsed.outcome -ceq 'clean') { return [pscustomobject]@{ Done = $true; Summary = @() } }
  if ($N -ge $MaxRounds) { $script:OpenFindings = $true; Stop-Loop "round limit ($MaxRounds) reached with $(@($parsed.findings).Count) open finding(s)" }
  $sum = Invoke-ClaudeFix $N $rd $script:Frozen $parsed $script:Tests
  return [pscustomobject]@{ Done = $false; Summary = $sum }
}
function Save-RoundEvidence([string]$RoundDir) {
  $res = Save-TrialEvidence $TrialPaths $RoundDir $script:Frozen $ResultsDir
  Write-LoopLog "  archived $(@($res.Rows).Count) evidence files to $RoundDir (mismatches: $($res.Failed))"
  if ($res.Failed) { Stop-Loop 'evidence archive copy did not verify' }
}

# ---- session ----------------------------------------------------------------------------------------
function Invoke-LoopMain {
  if ($Gate -cnotmatch '^[0-9]{3}[A-Z]$') { Write-Host 'Usage: cbc-review-loop.ps1 -Gate <NNNX, e.g. 007A> [-MaxRounds 1..3]'; return 3 }
  if (-not $TestMode -and [Console]::IsInputRedirected) { Write-Host 'Refusing: run this in an interactive PowerShell window; every approval is typed by the founder.'; return 3 }
  $script:ExpectedTrial = @{ Trial = $TrialPaths.Trial; Canary = $TrialPaths.Canary; Run = $TrialPaths.Run; Temp = $TrialPaths.Temp }
  $name = "loop-$Gate-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  $script:Session = Join-Path $ResultsDir $name
  if (Test-Path -LiteralPath $script:Session) { Write-Host "Refusing: $($script:Session) already exists"; $script:Session = $null; return 3 }
  [void](New-Item -ItemType Directory -Force -Path $script:Session)
  $script:Tools = Join-Path $script:Session 'tools'
  $result = 'stopped'; $reason = ''; $script:OpenFindings = $false; $script:Frozen = @()
  try {
    Write-LoopLog "Review loop for Gate $Gate (max $MaxRounds rounds)$(if ($TestMode) { ' - OFFLINE TEST MODE: NOT A REVIEW' })"
    $tc = Copy-LoopVerified @($ToolFiles | ForEach-Object { , @((Join-Path $LoopHere $_), ('tools\' + $_)) }) $script:Session
    if ($tc.Failed) { Stop-Loop 'tool copy did not verify' }
    $script:RunnerSha = Get-LoopSha (Join-Path $script:Tools 'cbc-codex-trial.ps1')
    foreach ($row in $tc.Rows) { Write-LoopLog ("  pinned " + $row.Rel + ' ' + $row.Sha) }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoDir '.git'))) { Stop-Loop "working repository not found: $RepoDir" }
    $st = Get-RepoState $RepoDir; $script:Base = $st.Head; $script:Branch = $st.Branch
    Write-LoopLog "  repository $RepoDir on $($script:Branch) at $($script:Base)"
    $script:Tests = $null
    if ($MaxRounds -gt 1) {
      if (-not (Test-Path -LiteralPath $ClaudeCommand[0] -PathType Leaf)) { Stop-Loop "Claude Code not found at $($ClaudeCommand[0])" }
      $script:Tests = Get-GateTests
      if ($null -eq $script:Tests) { Stop-Loop "gate-tests.json has no entry for $Gate; fix rounds need local tests (use -MaxRounds 1 for a review only)" }
      Test-ProjectClaudeSettings
    }
    $summary = @()
    for ($n = 1; $n -le $MaxRounds; $n++) {
      $r = Invoke-Round $n $summary
      if ($r.Done) { $result = 'clean'; break }
      $summary = $r.Summary
    }
  } catch {
    $m = $_.Exception.Message
    if ($m.StartsWith('LOOPSTOP: ')) { $reason = $m.Substring(10) } else { $reason = 'unexpected error: ' + $m }
    $result = $(if ($script:OpenFindings) { 'open-findings' } else { 'stopped' })
    Write-LoopLog "STOP: $reason"
  }
  Complete-Session $result $reason
  if ($result -ceq 'clean') { return 0 }; return 1
}
function Complete-Session([string]$Result, [string]$Reason) {
  $s = [ordered]@{ schema_version = 1; gate = $Gate; result = $Result; reason = $Reason; max_rounds = $MaxRounds; base = $script:Base; branch = $script:Branch
    runner_sha256 = $script:RunnerSha; rounds = @(Get-ChildItem -LiteralPath $script:Session -Directory -Filter 'round-*' | ForEach-Object { $_.Name }); finished = (Get-Date -Format 'o'); test_mode = [bool]$TestMode }
  Write-LoopUtf8 (Join-Path $script:Session 'loop-summary.json') (ConvertTo-Json -InputObject $s -Depth 4)
  Write-LoopLog ''
  Write-LoopLog "RESULT: $Result$(if ($Reason) { " - $Reason" })"
  Write-LoopLog "Archive: $($script:Session)"
  Write-LoopLog 'Founder decisions still pending (this loop cannot perform any of them):'
  foreach ($f in $FounderOnlyList) { Write-LoopLog "  - $f" }
  Write-LoopLog 'The trial paths were left in place.'
  $mh = Write-ShaManifest $script:Session
  $p = @(Test-ShaManifest $script:Session)
  Write-Host ("Archive MANIFEST.sha256 $mh - " + $(if ($p.Count) { 'VERIFY FAILED: ' + ($p -join '; ') } else { 'verified' }))
}

if ($LoadOnly) { return }
exit (Invoke-LoopMain)
