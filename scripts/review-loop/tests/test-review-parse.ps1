<#
OFFLINE tests for review-parse.ps1 (Gate 005H). No model, no network. Real fixtures are derived from the archived
Codex reviews (tests\fixtures\review\SOURCES.txt); the rest are synthetic edge cases. Every ambiguous case must stop.
Usage: powershell -NoProfile -ExecutionPolicy Bypass -File test-review-parse.ps1
#>
$ErrorActionPreference = 'Stop'
$Kit = Split-Path -Parent $PSScriptRoot
$Parser = Join-Path $Kit 'review-parse.ps1'
$Fx = Join-Path $PSScriptRoot 'fixtures\review'
$script:n = 0; $script:fail = 0
function Check([string]$Label, [bool]$Ok, [string]$Info = '') { $script:n++; if (-not $Ok) { $script:fail++ }; Write-Host ('{0} {1}{2}' -f $(if ($Ok) { 'ok  ' } else { 'FAIL' }), $Label, $(if ($Info -and -not $Ok) { "  [$Info]" } else { '' })) }
. $Parser -LoadOnly

$Clone = 'C:\Users\GN User\cbc-codex-trial'
$G7 = @('app/api/auth/login/route.ts', 'app/api/scan/route.ts', 'docs/gates/gate-007a-scanner-rate-limiting.md', 'infra/supabase/migrations/001_scan_admission.down.sql',
  'infra/supabase/migrations/001_scan_admission.sql', 'inngest/functions/processScan.ts', 'lib/scan/providers/googleWebRisk.ts', 'lib/security/providerBudget.ts',
  'lib/security/rateLimit.ts', 'scripts/rate-limit/test-rate-limit.ts')
$PR43 = @('.agents/state.yaml', 'docs/gates/gate-006c-p5b-key-vault-secrets.md', 'docs/gates/gate-006c-staging-readiness-plan.md')
function Fx([string]$Name, [string[]]$Frozen, [string]$Root = $Clone) {
  $d = Join-Path $Fx $Name
  return Get-ReviewOutcome -ReviewText ([IO.File]::ReadAllText((Join-Path $d 'review.md'))) -EventsText ([IO.File]::ReadAllText((Join-Path $d 'review-events.jsonl'))) `
    -ReportText ([IO.File]::ReadAllText((Join-Path $d 'report-Review.md'))) -FrozenPaths $Frozen -CloneRoot $Root
}
function Ev([string[]]$Texts) { return (($Texts | ForEach-Object { ConvertTo-Json -Compress -InputObject @{ type = 'item.completed'; item = @{ id = 'i'; type = 'agent_message'; text = $_ } } }) -join "`n") }
function Syn([string]$Text, [string]$Events = $null, [string]$Report = $PassHeader, [string[]]$Frozen = $G7) {
  if ($null -eq $Events -or $Events -eq '') { $Events = Ev @($Text) }
  return Get-ReviewOutcome -ReviewText $Text -EventsText $Events -ReportText $Report -FrozenPaths $Frozen -CloneRoot $Clone
}
$D = [string][char]0x2014
function Fd([string]$P, [string]$Title, [string]$Path, [string]$Lines, [string]$Body = '  Body text explaining the defect.') { return "- [$P] $Title $D ${Path}:$Lines`n$Body" }
$Sum = 'Summary paragraph.'

# ===== 1. real archived reviews =====
$r = Fx 'pr43-attempt04-clean' $PR43
Check 'real PR43 attempt 4: clean' ($r.outcome -ceq 'clean' -and @($r.findings).Count -eq 0) (($r.reasons) -join '; ')
$r = Fx 'g7-full15-clean' $G7
Check 'real Gate007A full 15-file review: clean' ($r.outcome -ceq 'clean') (($r.reasons) -join '; ')
Check 'real full 15-file review: the "not exercised" caveat is recorded, not treated as a finding' (@($r.caveats).Count -eq 1 -and $r.caveats[0] -match 'not exercised') ($r.caveats -join ' | ')
$r = Fx 'g7-cycle1-p2' $G7
Check 'real cycle 1: one P2 finding at lib/security/rateLimit.ts:61-64' ($r.outcome -ceq 'findings' -and @($r.findings).Count -eq 1 -and $r.findings[0].priority -ceq 'P2' -and $r.findings[0].path -ceq 'lib/security/rateLimit.ts' -and $r.findings[0].line_start -eq 61 -and $r.findings[0].line_end -eq 64) (($r.reasons) -join '; ')
Check 'real cycle 1: title and body captured' ($r.findings[0].title -ceq 'Bound retained attempts and keys in the in-memory limiter' -and $r.findings[0].body -match '^When an attacker repeatedly calls') ''
$r = Fx 'g7-cycle2-p1' $G7
Check 'real cycle 2: one P1 finding at lib/security/rateLimit.ts:181-183' ($r.outcome -ceq 'findings' -and $r.findings[0].priority -ceq 'P1' -and $r.findings[0].path -ceq 'lib/security/rateLimit.ts' -and $r.findings[0].line_start -eq 181 -and $r.findings[0].line_end -eq 183) (($r.reasons) -join '; ')
$r = Fx 'g7-cycle3-p2' $G7
Check 'real cycle 3: one P2 finding at the migration, line 104' ($r.outcome -ceq 'findings' -and $r.findings[0].path -ceq 'infra/supabase/migrations/001_scan_admission.sql' -and $r.findings[0].line_start -eq 104 -and $r.findings[0].line_end -eq 104) (($r.reasons) -join '; ')
Check 'real cycle 3: summary kept separately from the finding' ($r.summary -match '^The offline tests pass' -and -not ($r.summary -match 'Review comment')) ''
$r = Fx 'g7-cycle2-p1' @('lib/security/providerBudget.ts')
Check 'real cycle 2 with a frozen set that lacks the file: ambiguous' ($r.outcome -ceq 'ambiguous' -and ($r.reasons -join ';') -match 'not in the frozen set') ''
$r = Fx 'g7-cycle2-p1' $G7 'C:\Users\Other\clone'
Check 'real cycle 2 with a different clone root: ambiguous (path outside the clone)' ($r.outcome -ceq 'ambiguous' -and ($r.reasons -join ';') -match 'outside the clone') ''

# ===== 2. synthetic positives =====
$two = "$Sum`n`nReview comment:`n`n" + (Fd 'P1' 'First' "$Clone\lib\security\rateLimit.ts" '10-12') + "`n`n" + (Fd 'P3' 'Second' 'app/api/scan/route.ts' '7' "  Line one.`n  Line two.")
$r = Syn $two
Check 'two findings (absolute and relative paths, single line number): findings' ($r.outcome -ceq 'findings' -and @($r.findings).Count -eq 2 -and $r.findings[1].path -ceq 'app/api/scan/route.ts' -and $r.findings[1].line_end -eq 7 -and $r.findings[1].body -ceq "Line one.`nLine two.") (($r.reasons) -join '; ')
$r = Syn ($two.Replace("`n", "`r`n"))
Check 'CRLF line endings parse the same' ($r.outcome -ceq 'findings' -and @($r.findings).Count -eq 2) (($r.reasons) -join '; ')
$r = Syn ($two.Replace('Review comment:', 'Review comments:'))
Check 'plural "Review comments:" header accepted' ($r.outcome -ceq 'findings') (($r.reasons) -join '; ')
foreach ($t in @('No issues found in the changes.', "I did not identify any defects.", 'No blocking findings.')) { $r = Syn $t; Check "clean wording accepted: $t" ($r.outcome -ceq 'clean') (($r.reasons) -join '; ') }

# ===== 3. synthetic ambiguous cases (each must stop) =====
function Amb([string]$Label, $Res, [string]$Why) { Check "ambiguous: $Label" ($Res.outcome -ceq 'ambiguous' -and (($Res.reasons -join ' || ') -match $Why)) (($Res.reasons) -join ' || ') }
Amb 'empty review.md' (Syn '' (Ev @(''))) 'review.md is empty'
Amb 'runner report is FAIL' (Syn 'No issues found.' $null '# Codex trial - Review - RESULT: FAIL') 'PASS header'
Amb 'runner report missing' (Syn 'No issues found.' $null '') 'PASS header'
Amb 'two final agent messages' (Syn 'No issues found.' (Ev @('No issues found.', 'No issues found.'))) 'exactly 1 final agent message'
Amb 'no agent message' (Syn 'No issues found.' '{"type":"turn.completed"}') 'exactly 1 final agent message'
Amb 'review.md differs from the agent message' (Syn 'No issues found.' (Ev @('No issues found. Also [P1] something.'))) 'differs from the final agent message'
Amb 'unparseable event line' (Syn 'No issues found.' ((Ev @('No issues found.')) + "`nnot json")) 'unparseable'
Amb 'stray [P1] marker in clean text' (Syn 'No issues found, though [P1] style concerns exist.') 'P markers'
Amb 'finding without a header' (Syn ("$Sum`n`n" + (Fd 'P2' 'X' 'app/api/scan/route.ts' '3'))) 'P markers'
Amb 'header without findings' (Syn "$Sum`n`nReview comment:`n`nNothing concrete.") 'unrecognized line|without any well-formed finding'
Amb 'priority P4' (Syn ("$Sum`n`nReview comment:`n`n" + (Fd 'P4' 'X' 'app/api/scan/route.ts' '3'))) 'unrecognized line|P markers'
Amb 'path outside the frozen set' (Syn ("$Sum`n`nReview comment:`n`n" + (Fd 'P2' 'X' 'lib/other.ts' '3'))) 'not in the frozen set'
Amb 'path traversal' (Syn ("$Sum`n`nReview comment:`n`n" + (Fd 'P2' 'X' '../outside.ts' '3'))) 'outside the clone'
Amb 'absolute path outside the clone' (Syn ("$Sum`n`nReview comment:`n`n" + (Fd 'P2' 'X' 'C:\Windows\x.ts' '3'))) 'outside the clone'
Amb 'reversed line range' (Syn ("$Sum`n`nReview comment:`n`n" + (Fd 'P2' 'X' 'app/api/scan/route.ts' '10-5'))) 'invalid line range'
Amb 'line zero' (Syn ("$Sum`n`nReview comment:`n`n" + (Fd 'P2' 'X' 'app/api/scan/route.ts' '0'))) 'invalid line range'
Amb 'finding with no body' (Syn ("$Sum`n`nReview comment:`n`n" + (Fd 'P2' 'X' 'app/api/scan/route.ts' '3' ''))) 'no body'
Amb 'unindented text after the findings' (Syn ("$Sum`n`nReview comment:`n`n" + (Fd 'P2' 'X' 'app/api/scan/route.ts' '3') + "`n`nAlso consider refactoring.")) 'unrecognized line'
Amb 'marker inside a finding body' (Syn ("$Sum`n`nReview comment:`n`n" + (Fd 'P2' 'X' 'app/api/scan/route.ts' '3' '  Related to [P1] above.'))) 'P markers'
Amb 'ASCII hyphen instead of the em dash separator' (Syn ("$Sum`n`nReview comment:`n`n- [P2] X - app/api/scan/route.ts:3`n  Body.")) 'unrecognized line|P markers'
Amb 'two headers' (Syn ("$Sum`n`nReview comment:`n`n" + (Fd 'P2' 'X' 'app/api/scan/route.ts' '3') + "`n`nReview comment:`n`n" + (Fd 'P2' 'Y' 'app/api/scan/route.ts' '4'))) 'more than one'
Amb 'clean text without a no-defects statement' (Syn 'The change looks reasonable overall.') 'no explicit no-defects statement'
Amb 'oversized review.md' (Syn ('No issues found. ' + ('x' * 200001))) 'exceeds'

# ===== 4. command-line entry: exit codes and the JSON file =====
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('cbc-review-parse-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); [void](New-Item -ItemType Directory -Path $tmp)
$man = Join-Path $tmp 'MANIFEST.sha256'; [IO.File]::WriteAllText($man, (($G7 | ForEach-Object { ('ab' * 32) + '  ' + $_ }) -join "`n") + "`n")
foreach ($case in @(@('g7-full15-clean', 0, 'clean'), @('g7-cycle2-p1', 1, 'findings'))) {
  $out = Join-Path $tmp ($case[0] + '.json')
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Parser -RunDir (Join-Path $Fx $case[0]) -FrozenManifest $man -CloneRoot $Clone -OutFile $out | Out-Null; $code = $LASTEXITCODE
  $j = $null; try { $j = [IO.File]::ReadAllText($out) | ConvertFrom-Json } catch { }
  Check "CLI $($case[0]): exit $($case[1]) and JSON outcome $($case[2])" ($code -eq $case[1] -and $null -ne $j -and $j.outcome -ceq $case[2] -and $j.schema_version -eq 1) ("exit $code")
}
$amb = Join-Path $tmp 'amb'; [void](New-Item -ItemType Directory -Path $amb)
Copy-Item (Join-Path $Fx 'g7-cycle2-p1\*') $amb; [IO.File]::WriteAllText((Join-Path $amb 'report-Review.md'), "# Codex trial - Review - RESULT: FAIL`n")
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Parser -RunDir $amb -FrozenManifest $man -CloneRoot $Clone -OutFile (Join-Path $tmp 'amb.json') | Out-Null
Check 'CLI ambiguous: exit 2 and JSON written' ($LASTEXITCODE -eq 2 -and (Test-Path (Join-Path $tmp 'amb.json'))) ("exit $LASTEXITCODE")
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Parser -RunDir $amb | Out-Null
Check 'CLI usage error: exit 3' ($LASTEXITCODE -eq 3) ("exit $LASTEXITCODE")
Remove-Item -LiteralPath $tmp -Recurse -Force

# ===== 5. static checks =====
$tok = $null; $perr = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($Parser, [ref]$tok, [ref]$perr)
Check 'parser parses with no errors' ($perr.Count -eq 0) (($perr | ForEach-Object { $_.Message }) -join '; ')
Check 'parser is ASCII only' (-not @([IO.File]::ReadAllBytes($Parser) | Where-Object { $_ -gt 127 }).Count) ''
$src = [IO.File]::ReadAllText($Parser)
Check 'parser starts no process, writes only -OutFile, and has no network or git access' (-not ($src -match '(?i)Start-Process|Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|Invoke-Expression|\biex\b|\bgit\b|Remove-Item|Set-Content|Out-File')) ''
Check 'fixture sources recorded (5 reviews x 3 files)' (@(Get-Content (Join-Path $Fx 'SOURCES.txt') | Where-Object { $_ -match ' [0-9a-f]{64}$' }).Count -eq 15) ''

Write-Host ("`nreview-parse tests: {0} checks, {1} failed" -f $script:n, $script:fail)
exit $(if ($script:fail -eq 0) { 0 } else { 1 })
