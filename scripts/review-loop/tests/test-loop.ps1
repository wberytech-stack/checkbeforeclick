<#
OFFLINE tests for the Gate 005H review loop: cbc-review-loop.ps1 with loop-common.ps1, freeze.ps1, archive.ps1 and
verify-archive.ps1. No model, no network: the real runner runs through its own offline entry with fake Codex, and
headless Claude is tests\fake-claude.js. Every scenario uses a fresh temporary fixture.
Usage: powershell -NoProfile -ExecutionPolicy Bypass -File test-loop.ps1
#>
$ErrorActionPreference = 'Stop'
$Kit = Split-Path -Parent $PSScriptRoot
$Loop = Join-Path $Kit 'cbc-review-loop.ps1'
$Entry = Join-Path $PSScriptRoot 'loop-offline-entry.ps1'
$FakeCodex = Join-Path $PSScriptRoot 'fake-codex.js'
$FakeClaude = Join-Path $PSScriptRoot 'fake-claude.js'
$Verify = Join-Path $Kit 'verify-archive.ps1'
$Root = Join-Path ([IO.Path]::GetTempPath()) ('cbc-review-loop-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
[void](New-Item -ItemType Directory -Path $Root)
$script:n = 0; $script:fail = 0
function Check([string]$Label, [bool]$Ok, [string]$Info = '') { $script:n++; if (-not $Ok) { $script:fail++ }; Write-Host ('{0} {1}{2}' -f $(if ($Ok) { 'ok  ' } else { 'FAIL' }), $Label, $(if ($Info -and -not $Ok) { "  [$Info]" } else { '' })) }
function G([string]$Dir, [string[]]$A) { $o = & git -C $Dir @A 2>&1; if ($LASTEXITCODE -ne 0) { throw "git $($A -join ' ') failed: $o" }; return ($o -join "`n") }
function Tail([string]$s, [int]$n = 900) { return $s.Substring([Math]::Max(0, $s.Length - $n)) }
function Get-TSha([string]$P) { if (-not (Test-Path -LiteralPath $P)) { return "<missing:$P>" }; return (Get-FileHash -Algorithm SHA256 -LiteralPath $P).Hash.ToLower() }

# ---- fixture source repository (the "origin") --------------------------------------------------------
$Src = Join-Path $Root 'src'; [void](New-Item -ItemType Directory -Path $Src)
G $Src @('init', '--quiet', '-b', 'master') | Out-Null
G $Src @('config', 'user.email', 'test@example.invalid') | Out-Null; G $Src @('config', 'user.name', 'test') | Out-Null; G $Src @('config', 'core.autocrlf', 'false') | Out-Null
$baseFiles = @{ 'README.md' = "fixture`n"; '.gitignore' = "/.next/`n/node_modules`n"; 'AGENTS.md' = "# Fixture constitution`n`nA browser extension.`n"
  'app/api/scan/route.ts' = "export const x = 1`n"; 'tests/check.js' = "const fs=require('fs');if(process.env.LOOP_TEST_MARKER)fs.appendFileSync(process.env.LOOP_TEST_MARKER,'ran\n');const t=fs.readFileSync('app/api/scan/route.ts','utf8');process.exit(t.includes('BREAK')?1:0)`n" }
foreach ($k in $baseFiles.Keys) { $p = Join-Path $Src $k; [void](New-Item -ItemType Directory -Force -Path (Split-Path $p)); [IO.File]::WriteAllText($p, $baseFiles[$k]) }
G $Src @('add', '-A') | Out-Null; G $Src @('commit', '--quiet', '-m', 'base') | Out-Null; $Base = (G $Src @('rev-parse', 'HEAD')).Trim()

# ---- tools folder with a test gate-tests.json (gate 999T) ----------------------------------------------
$Tools = Join-Path $Root 'tools'; [void](New-Item -ItemType Directory -Path $Tools)
foreach ($f in @('cbc-codex-trial.ps1', 'review-parse.ps1', 'loop-common.ps1', 'archive.ps1', 'freeze.ps1', 'claude-fix-prompt.md', 'claude-settings.json')) { Copy-Item (Join-Path $Kit $f) $Tools }
[IO.File]::WriteAllText((Join-Path $Tools 'gate-tests.json'), '{"schema_version":1,"gates":{"999T":[["tests/check.js"]]}}')

function New-LoopCase([string]$Name) {
  $c = Join-Path $Root $Name; [void](New-Item -ItemType Directory -Path $c)
  G $c @('clone', '--quiet', '--no-checkout', $Src, 'workrepo') | Out-Null
  $repo = Join-Path $c 'workrepo'
  G $repo @('config', 'core.autocrlf', 'false') | Out-Null; G $repo @('config', 'user.email', 'test@example.invalid') | Out-Null; G $repo @('config', 'user.name', 'test') | Out-Null
  G $repo @('checkout', '--quiet', '-b', 'gate-999t', $Base) | Out-Null
  [void](New-Item -ItemType Directory -Force -Path (Join-Path $repo '.agents'), (Join-Path $repo 'lib\new'))
  [IO.File]::WriteAllText((Join-Path $repo '.agents\claude-handoff.yaml'), "status: in_progress`n")
  [IO.File]::AppendAllText((Join-Path $repo 'app\api\scan\route.ts'), "export const y = 2`n")
  [IO.File]::WriteAllText((Join-Path $repo 'lib\new\thing.ts'), "export const thing = 1`n")
  $rev = Join-Path $c 'review'; [void](New-Item -ItemType Directory -Force -Path (Join-Path $rev 'codex-trial\results')); [IO.File]::WriteAllText((Join-Path $rev 'existing.md'), "x`n")
  return [pscustomobject]@{ Dir = $c; Repo = $repo; Review = $rev; Results = (Join-Path $rev 'codex-trial\results'); Input = (Join-Path $rev 'codex-trial\inputs\loop-current')
    Trial = (Join-Path $c 'trial'); Canary = (Join-Path $c 'canary'); Run = (Join-Path $c 'run'); Temp = (Join-Path $c 'temp-canary.txt') }
}
function Run-Loop($Case, [string[]]$Answers, [string]$ReviewSeq = 'clean', [string]$Claude = 'fix', [int]$Rounds = 3, [string]$Gate = '999T', [string]$Codex = 'proof-ok,review-seq', [string]$Finding = 'app/api/scan/route.ts') {
  $af = Join-Path $Case.Dir ('answers-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt'); [IO.File]::WriteAllLines($af, $Answers)
  $env:FAKE_SCENARIO = $Codex; $env:FAKE_REVIEW_SEQ = $ReviewSeq; $env:FAKE_REVIEW_COUNTER = (Join-Path $Case.Dir 'review-counter.txt'); $env:FAKE_FINDING_PATH = $Finding; $env:LOOP_TEST_MARKER = (Join-Path $Case.Dir 'tests-ran.txt')
  $env:FAKE_STATE_FILE = (Join-Path $Case.Dir 'fake-sandbox-calls.txt'); $env:FAKE_CLAUDE = $Claude; $env:FAKE_CLAUDE_ARGV = (Join-Path $Case.Dir 'claude-argv.json')
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Entry, '-TGate', $Gate, '-TMaxRounds', $Rounds, '-TRepo', $Case.Repo, '-TReview', $Case.Review,
    '-TTrial', $Case.Trial, '-TCanary', $Case.Canary, '-TRun', $Case.Run, '-TTemp', $Case.Temp, '-TSource', $Src, '-TBase', $Base, '-TCodexJs', $FakeCodex,
    '-TFakeClaude', $FakeClaude, '-TToolsDir', $Tools, '-TAnswersFile', $af)
  $ErrorActionPreference = 'Continue'
  $o = & powershell.exe @a 2>&1 | Out-String; $code = $LASTEXITCODE
  $sess = @(Get-ChildItem -LiteralPath $Case.Results -Directory -Filter 'loop-*' | Sort-Object Name | Select-Object -Last 1)
  $summary = $null; if ($sess.Count) { try { $summary = Get-Content -Raw (Join-Path $sess[0].FullName 'loop-summary.json') | ConvertFrom-Json } catch { } }
  return [pscustomobject]@{ Code = $code; Out = $o; Session = $(if ($sess.Count) { $sess[0].FullName } else { $null }); Summary = $summary }
}
function Verified([string]$Dir) { $ErrorActionPreference = 'Continue'; $o = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Verify -Path $Dir 2>&1 | Out-String; return ($LASTEXITCODE -eq 0 -and $o -match 'VERIFIED') }
$A = '<auto>'

# ===== 1. one clean round =====
$c = New-LoopCase 'clean-1'; $r = Run-Loop $c @($A) 'clean' 'fix' 1
Check 'clean review in round 1: exit 0, result clean' ($r.Code -eq 0 -and $r.Summary.result -ceq 'clean') (Tail $r.Out)
Check 'clean: OFFLINE TEST MODE is announced' ($r.Out -match 'OFFLINE TEST MODE') ''
Check 'clean: approval prompt showed round, manifest, runner and call budget' ($r.Out -match 'review round 1 of max 1' -and $r.Out -match 'Frozen set: 2 files' -and $r.Out -match '1 Codex Proof call \+ 1 Codex Review call' -and $r.Out -match 'Type exactly:  APPROVE ROUND 1 [0-9a-f]{8}') ''
$rd = Join-Path $r.Session 'round-1'
Check 'clean: round archive holds input, run evidence, canaries, clone files and findings.json' (@(@('input\MANIFEST.sha256', 'input\files\app\api\scan\route.ts', 'run\proof-result.json', 'run\review.md', 'run\report-Review.md', 'canary\canary-outside.txt', 'temp\cbc-codex-canary.txt', 'clone\.next\cbc-canary.txt', 'clone\files\lib\new\thing.ts', 'clone\clone-facts.txt', 'results-copy\report-Review.md', 'findings.json') | Where-Object { -not (Test-Path (Join-Path $rd $_)) }).Count -eq 0) ''
Check 'clean: findings.json outcome clean' ((Get-Content -Raw (Join-Path $rd 'findings.json') | ConvertFrom-Json).outcome -ceq 'clean') ''
Check 'clean: pinned tool copies archived' (Test-Path (Join-Path $r.Session 'tools\cbc-codex-trial.ps1')) ''
Check 'clean: session archive verifies (MANIFEST.sha256)' (Verified $r.Session) ''
Check 'clean: trial paths left in place, no headless Claude call' ((Test-Path $c.Run) -and (Test-Path $c.Trial) -and -not (Test-Path (Join-Path $c.Dir 'claude-argv.json'))) ''
Check 'clean: final screen lists the founder-only actions' ($r.Out -match 'Founder decisions still pending' -and $r.Out -match '- commit' -and $r.Out -match '- push' -and $r.Out -match '- deploy') ''
Check 'clean: excluded handoff file is not frozen' (-not (Test-Path (Join-Path $rd 'input\files\.agents'))) ''
# a second session on the same case: the occupied trial paths are recognised from the first archive
$r2 = Run-Loop $c @($A, $A) 'clean' 'fix' 1
Check 'next session: occupied trial paths recognised, CLEAR approved, round clean' ($r2.Code -eq 0 -and $r2.Out -match 'Type exactly:  CLEAR cbcprobe[0-9a-f]{12}' -and $r2.Out -match 'trial paths cleared') (Tail $r2.Out)
Check 'next session: archived inputs\loop-current was replaced, earlier archive still verifies' ((Verified $r.Session) -and (Verified $r2.Session)) ''

# ===== 2. finding -> Claude fix -> clean =====
$c = New-LoopCase 'fix-then-clean'; $r = Run-Loop $c @($A, $A, $A, $A) 'finding,clean' 'fix' 3
Check 'finding then clean: exit 0 after one fix round' ($r.Code -eq 0 -and $r.Summary.result -ceq 'clean' -and (@($r.Summary.rounds) -join ',') -ceq 'round-1,round-2') (Tail $r.Out 1500)
$fx = Join-Path $r.Session 'round-1\fix'
Check 'fix: claude-response.json, diff.patch, tests.txt and the changed file copy archived' (@(@('claude-response.json', 'claude-transcript.jsonl', 'claude-prompt.txt', 'claude-argv.txt', 'diff.patch', 'tests.txt', 'after\app\api\scan\route.ts') | Where-Object { -not (Test-Path (Join-Path $fx $_)) }).Count -eq 0) ''
Check 'fix: gate tests ran and passed' ((Get-Content -Raw (Join-Path $fx 'tests.txt')) -match '== PASS node tests/check.js') ''
Check 'fix: Prompt C showed the decisions and changed files before round 2' ($r.Out -match 'Fix round 1 summary' -and $r.Out -match 'F1: fixed \[app/api/scan/route.ts\]' -and $r.Out -match 'APPROVE ROUND 2 [0-9a-f]{8}') ''
Check 'fix: round 2 froze the fixed file (new manifest)' ((Get-TSha (Join-Path $r.Session 'round-1\input\MANIFEST.sha256')) -cne (Get-TSha (Join-Path $r.Session 'round-2\input\MANIFEST.sha256'))) ''
$argv = @((Get-Content -Raw (Join-Path $c.Dir 'claude-argv.json') | ConvertFrom-Json) | ForEach-Object { $_ })   # PS 5.1 emits a JSON array as one object
function ArgAfter([string]$f) { $i = [array]::IndexOf($argv, $f); if ($i -ge 0 -and $i + 1 -lt $argv.Count) { return [string]$argv[$i + 1] }; return '' }
Check 'claude argv: -p, stream-json, dontAsk, project settings only, strict empty MCP, no session persistence' ($argv -ccontains '-p' -and (ArgAfter '--output-format') -ceq 'stream-json' -and (ArgAfter '--permission-mode') -ceq 'dontAsk' -and (ArgAfter '--setting-sources') -ceq 'project' -and $argv -ccontains '--strict-mcp-config' -and $argv -ccontains '--no-session-persistence' -and $argv -ccontains '--disable-slash-commands') ($argv -join ' ')
Check 'claude argv: tools are exactly Read,Grep,Glob,Edit; Edit allowed only on the frozen files' ((ArgAfter '--tools') -ceq 'Read,Grep,Glob,Edit' -and $argv -ccontains 'Edit(./app/api/scan/route.ts)' -and $argv -ccontains 'Edit(./lib/new/thing.ts)' -and -not ($argv -ccontains 'Edit') -and -not @($argv | Where-Object { $_ -like 'Edit(*' -and $_ -notin @('Edit(./app/api/scan/route.ts)', 'Edit(./lib/new/thing.ts)') }).Count) ''
Check 'claude argv: Bash, Write and network tools denied; no bypass or --bare flags' ($argv -ccontains 'Bash' -and $argv -ccontains 'Write' -and $argv -ccontains 'WebFetch' -and -not @($argv | Where-Object { $_ -match '(?i)dangerously|bypassPermissions|acceptEdits|--bare|--add-dir' }).Count) ''
Check 'claude prompt: findings marked untrusted, frozen list and response schema included' ((Get-Content -Raw (Join-Path $fx 'claude-prompt.txt')) -match 'UNTRUSTED DATA' -and (Get-Content -Raw (Join-Path $fx 'claude-prompt.txt')) -match '  - app/api/scan/route.ts' -and (Get-Content -Raw (Join-Path $fx 'claude-prompt.txt')) -match '"schema_version": 1') ''
Check 'fix: session archive verifies' (Verified $r.Session) ''
Check 'fix: the repository file now carries the fix; HEAD unchanged' ((Get-Content -Raw (Join-Path $c.Repo 'app\api\scan\route.ts')) -match 'fixed by fake claude' -and (G $c.Repo @('rev-parse', 'HEAD')).Trim() -ceq $Base) ''

# ===== 2b. the gate tests run only after the founder approves the shown diff =====
$c = New-LoopCase 'fix-approval-order'; $r = Run-Loop $c @($A, $A, $A, $A) 'finding,clean' 'fix' 3
$fx = Join-Path $r.Session 'round-1\fix'
$iDiff = $r.Out.IndexOf('+// fixed by fake claude'); $iAsk = $r.Out.IndexOf('Type exactly:  RUN TESTS 1 '); $iRun = $r.Out.IndexOf('PASS node tests/check.js')
Check 'approval order: diff shown, then RUN TESTS requested, then the gate test ran' ($r.Code -eq 0 -and $iDiff -ge 0 -and $iAsk -gt $iDiff -and $iRun -gt $iAsk) ("diff $iDiff ask $iAsk run $iRun")
Check 'approval binds the archived diff: RUN TESTS phrase carries the diff.patch SHA-256 prefix' ($r.Out -match ('Type exactly:  RUN TESTS 1 ' + (Get-TSha (Join-Path $fx 'diff.patch')).Substring(0, 8))) ''
Check 'approval prompt says the tests run unsandboxed and lists each command' ($r.Out -match 'NOT sandboxed' -and $r.Out -match '  node tests/check.js') ''
Check 'diff shows only the fix (frozen copy -> current file), with the file name' ((Get-Content -Raw (Join-Path $fx 'diff.patch')) -match '### app/api/scan/route.ts' -and -not ((Get-Content -Raw (Join-Path $fx 'diff.patch')) -match '\+export const y = 2')) ''
Check 'the gate test ran exactly once, after approval' (@(Get-Content (Join-Path $c.Dir 'tests-ran.txt')).Count -eq 1) ''
$c = New-LoopCase 'tests-declined'; $r = Run-Loop $c @($A, 'no') 'finding,clean' 'fix' 3
Check 'declined test approval: stop with exit 1' ($r.Code -eq 1 -and $r.Summary.reason -match "approval not given \(expected 'RUN TESTS 1 [0-9a-f]{8}'\)") ($r.Summary.reason)
Check 'declined: no gate test ran, no tests.txt, no round 2' (-not (Test-Path (Join-Path $c.Dir 'tests-ran.txt')) -and -not (Test-Path (Join-Path $r.Session 'round-1\fix\tests.txt')) -and -not (Test-Path (Join-Path $r.Session 'round-2'))) ''
Check "declined: Claude's diff and edits stay archived; archive verifies" ((Test-Path (Join-Path $r.Session 'round-1\fix\diff.patch')) -and (Test-Path (Join-Path $r.Session 'round-1\fix\after\app\api\scan\route.ts')) -and (Verified $r.Session)) ''
$c = New-LoopCase 'tests-declined-break'; $r = Run-Loop $c @($A, '') 'finding,clean' 'break-tests' 3
Check 'declined with breaking code: the edited code never executed' ($r.Code -eq 1 -and -not (Test-Path (Join-Path $c.Dir 'tests-ran.txt'))) ''
$c = New-LoopCase 'fix-untracked'; $r = Run-Loop $c @($A, $A, $A, $A) 'finding,clean' 'fix' 3 '999T' 'proof-ok,review-seq' 'lib/new/thing.ts'
$d = $(if ($r.Session) { Get-Content -Raw (Join-Path $r.Session 'round-1\fix\diff.patch') } else { '' })
Check 'fix on an untracked (new) file: the diff shows the edit and the loop completes' ($r.Code -eq 0 -and $d -match '### lib/new/thing.ts' -and $d -match '\+// fixed by fake claude') (Tail $r.Out)

# ===== 3. stops =====
function Stopped([string]$Label, $R, [string]$Why) { Check "stop: $Label (exit 1, reason)" ($R.Code -eq 1 -and $R.Summary.result -in @('stopped', 'open-findings') -and $R.Summary.reason -match $Why) ("exit $($R.Code); reason: $($R.Summary.reason)`n" + (Tail $R.Out 600)) }
$c = New-LoopCase 'limit'; $r = Run-Loop $c @($A, $A, $A, $A) 'finding,finding' 'fix' 2
Stopped 'round limit reached with findings open' $r 'round limit \(2\) reached with 1 open finding'
Check 'limit: result is open-findings and the archive verifies' ($r.Summary.result -ceq 'open-findings' -and (Verified $r.Session)) ''
$c = New-LoopCase 'ambiguous'; $r = Run-Loop $c @($A) 'ambiguous'
Stopped 'ambiguous review' $r 'ambiguous review result'
$c = New-LoopCase 'finding-outside'; $r = Run-Loop $c @($A) 'finding-outside'
Stopped 'finding outside the frozen set' $r 'ambiguous review result.*not in the frozen set'
$c = New-LoopCase 'wrong-phrase'; $r = Run-Loop $c @('APPROVE ROUND 1 00000000') 'clean'
Stopped 'wrong approval phrase' $r 'approval not given'
Check 'wrong phrase: no runner call was made' (-not (Test-Path $c.Run) -and -not (Test-Path $c.Trial)) ''
$c = New-LoopCase 'no-answer'; $r = Run-Loop $c @() 'clean'
Stopped 'no approval typed' $r 'approval not given'
$c = New-LoopCase 'unknown-trial'; [void](New-Item -ItemType Directory -Path $c.Run); [IO.File]::WriteAllText((Join-Path $c.Run 'mystery.txt'), 'x'); $r = Run-Loop $c @($A) 'clean'
Stopped 'unrecognised trial path content' $r 'not byte-identical to any archive'
Check 'unknown trial content left untouched' (Test-Path (Join-Path $c.Run 'mystery.txt')) ''
$c = New-LoopCase 'unknown-input'; [void](New-Item -ItemType Directory -Force -Path $c.Input); [IO.File]::WriteAllText((Join-Path $c.Input 'MANIFEST.sha256'), "x`n"); $r = Run-Loop $c @($A) 'clean'
Stopped 'unarchived inputs\loop-current' $r 'not archived anywhere'
Check 'unarchived input left untouched' (Test-Path (Join-Path $c.Input 'MANIFEST.sha256')) ''
$c = New-LoopCase 'env-file'; [IO.File]::WriteAllText((Join-Path $c.Repo '.env.local'), "X=1`n"); $r = Run-Loop $c @($A) 'clean'
Stopped 'forbidden .env file among the changes' $r 'forbidden path: \.env\.local'
$c = New-LoopCase 'deleted-file'; Remove-Item (Join-Path $c.Repo 'README.md'); $r = Run-Loop $c @($A) 'clean'
Stopped 'deleted file among the changes' $r 'unsupported changes'
$c = New-LoopCase 'proof-fails'; $r = Run-Loop $c @($A) 'clean' 'fix' 3 '999T' 'proof-ok,review-seq,os-w1-allowed'
Stopped 'runner Proof failure' $r 'runner Proof failed'
Check 'proof failure: evidence archived (report and sandbox probe)' ((Test-Path (Join-Path $r.Session 'round-1\run\report-Proof.md')) -and (Test-Path (Join-Path $r.Session 'round-1\runner-Proof-console.txt')) -and (Verified $r.Session)) ''
$c = New-LoopCase 'no-gate-tests'; $r = Run-Loop $c @($A) 'clean' 'fix' 3 '998T'
Stopped 'fix rounds without a gate-tests entry' $r 'no entry for 998T'
$c = New-LoopCase 'project-settings'; [void](New-Item -ItemType Directory -Path (Join-Path $c.Repo '.claude')); [IO.File]::WriteAllText((Join-Path $c.Repo '.claude\settings.json'), '{"permissions":{"allow":["Bash"]}}'); $r = Run-Loop $c @($A) 'clean'
Stopped 'project Claude settings that grant permissions' $r 'project Claude settings contain permissions'

# ===== 4. Claude fix-round stops =====
function ClaudeStop([string]$Scenario, [string]$Why) {
  $c = New-LoopCase "claude-$Scenario"; $r = Run-Loop $c @($A, $A) 'finding,clean' $Scenario 3
  Stopped "Claude '$Scenario'" $r $Why
  Check "Claude '$Scenario': no round 2 Codex call; archive verifies" (-not (Test-Path (Join-Path $r.Session 'round-2\run')) -and (Verified $r.Session)) ''
  return $c
}
$null = ClaudeStop 'edit-outside' 'changed files outside the frozen set: .agents/claude-handoff.yaml'
$null = ClaudeStop 'edit-tracked' 'changed which files are modified'
$null = ClaudeStop 'new-file' 'changed which files are modified'
$c = ClaudeStop 'commit' 'changed git Refs'
$null = ClaudeStop 'founder-only' 'founder decision needed for: F1'
$null = ClaudeStop 'reject-all' 'applied no fix'
$null = ClaudeStop 'malformed' 'not the required JSON object'
$null = ClaudeStop 'lie-unchanged' 'listed as fixed but unchanged'
$null = ClaudeStop 'unlisted-change' 'changed but not listed under any fixed decision'
$null = ClaudeStop 'missing-decision' 'cover each finding exactly once'
$null = ClaudeStop 'error-result' 'did not finish successfully'
$null = ClaudeStop 'exit1' 'exited with 1'
$null = ClaudeStop 'break-tests' 'gate test command\(s\) failed'
$c = New-LoopCase 'claude-fenced'; $r = Run-Loop $c @($A, $A, $A, $A) 'finding,clean' 'fix,fenced' 3
Check 'a fenced JSON reply is accepted' ($r.Code -eq 0) (Tail $r.Out)

# ===== 5. usage and production refusals =====
$o = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Loop -Gate 'bad' 2>&1 | Out-String
Check 'usage: an invalid -Gate is refused (exit 3)' ($LASTEXITCODE -eq 3) ''
$o = 'x' | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Loop -Gate '007A' 2>&1 | Out-String
Check 'production: refuses without an interactive console (exit 3), before creating anything' ($LASTEXITCODE -eq 3 -and $o -match 'interactive PowerShell window') $o

# ===== 6. units: read-only git, write-once archives, verify-archive =====
. (Join-Path $Kit 'loop-common.ps1'); . (Join-Path $Kit 'archive.ps1')
foreach ($sub in @(@('commit', '-m', 'x'), @('push'), @('merge', 'x'), @('reset', '--hard'), @('checkout', 'x'), @('branch', '-D', 'x'), @('tag', 'x'), @('stash', 'push'), @('stash'), @('config', 'x'), @('clone', 'x'), @('fetch'), @('add', '.'), @('rm', 'x'), @('worktree', 'add', 'x'), @('update-ref', 'x', 'y'))) {
  $refused = $false; try { $null = Invoke-LoopGit $sub $Root } catch { $refused = $_.Exception.Message -match 'refused' }
  Check "read-only git: '$($sub -join ' ')' refused before any process starts" $refused ''
}
$okList = $false; try { $null = Invoke-LoopGit @('stash', 'list') $c.Repo; $okList = $true } catch { }
Check "read-only git: 'stash list' allowed" $okList ''
$w = Join-Path $Root 'write-once'; [void](New-Item -ItemType Directory -Path $w); [IO.File]::WriteAllText((Join-Path $w 'a.txt'), 'a')
$null = Write-ShaManifest $w; $again = $false; try { $null = Write-ShaManifest $w } catch { $again = $_.Exception.Message -match 'write-once' }
Check 'archive manifest is write-once' $again ''
$dup = $false; try { $null = Copy-LoopVerified @(, @((Join-Path $w 'a.txt'), 'a.txt')) $w } catch { $dup = $_.Exception.Message -match 'already exists' }
Check 'archive copy refuses to overwrite an existing file' $dup ''
Check 'verify-archive: intact archive VERIFIED' (Verified $w) ''
[IO.File]::AppendAllText((Join-Path $w 'a.txt'), 'x'); Check 'verify-archive: changed file FAILED' (-not (Verified $w)) ''
[IO.File]::WriteAllText((Join-Path $w 'extra.txt'), 'e'); $o = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Verify -Path $w 2>&1 | Out-String
Check 'verify-archive: unlisted file reported' ($o -match 'not listed: extra.txt') ''
$cl = $false; try { Clear-TrialPaths ([pscustomobject]@{ Trial = 'C:\x'; Canary = 'C:\y'; Run = 'C:\z'; Temp = 'C:\t' }) @{ Trial = 'C:\other'; Canary = 'C:\y'; Run = 'C:\z'; Temp = 'C:\t' } } catch { $cl = $_.Exception.Message -match 'refused' }
Check 'clear: a trial path that differs from the expected one is refused' $cl ''

# ===== 7. static checks =====
$runnerSrc = [IO.File]::ReadAllText((Join-Path $Kit 'cbc-codex-trial.ps1'))
$rx = [regex]::Match($runnerSrc, "(?m)^\`$LoopForbiddenRx = '([^']+)'").Groups[1].Value
Check 'loop and runner use the identical forbidden-path list' ($rx -ceq $LoopForbiddenRx) ''
foreach ($f in @('cbc-review-loop.ps1', 'loop-common.ps1', 'archive.ps1', 'freeze.ps1', 'verify-archive.ps1')) {
  $p = Join-Path $Kit $f; $tok = $null; $perr = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tok, [ref]$perr)
  $s = [IO.File]::ReadAllText($p)
  Check "$f parses, is ASCII only, starts no shell" ($perr.Count -eq 0 -and -not @([IO.File]::ReadAllBytes($p) | Where-Object { $_ -gt 127 }).Count -and -not ($s -match '(?i)cmd(\.exe)?\s*/c|ComSpec|Invoke-Expression|\biex\b|Start-Process')) (($perr | ForEach-Object { $_.Message }) -join '; ')
  Check "$f runs git only through Invoke-LoopGit" (-not ($s -match "(?m)(&\s*git\b|Invoke-LoopProc\s+[^\r\n]*\bgit\b|'git'\s*,)")) ''
  Check "$f passes no git write subcommand to Invoke-LoopGit" (-not ($s -match "Invoke-LoopGit\s+\(?@\('(commit|push|merge|reset|rebase|tag|checkout|switch|add|rm|restore|clean|apply|cherry-pick|revert|worktree|update-ref|fetch|pull|clone|config)'")) ''
}
$ls = [IO.File]::ReadAllText($Loop)
Check 'loop assigns TestMode only once, to false' (([regex]::Matches($ls, '\$TestMode\s*=')).Count -eq 1 -and $ls.Contains('$TestMode = $false')) ''
Check 'loop has no permission-bypass or --bare flags' (-not ($ls -match '(?i)dangerously|bypassPermissions|acceptEdits|''--bare''|--add-dir')) ''
Check 'loop production parameters are exactly Gate, LoadOnly, MaxRounds' ((@(([System.Management.Automation.Language.Parser]::ParseFile($Loop, [ref]$null, [ref]$null)).ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath } | Sort-Object) -join ',') -ceq 'Gate,LoadOnly,MaxRounds') ''
$cfg = Get-Content -Raw (Join-Path $Kit 'claude-settings.json') | ConvertFrom-Json
Check 'claude-settings.json denies Bash, Write, network, .env reads and hooks' ((@($cfg.permissions.deny) -ccontains 'Bash') -and (@($cfg.permissions.deny) -ccontains 'Write') -and (@($cfg.permissions.deny) -ccontains 'WebFetch') -and (@($cfg.permissions.deny) -ccontains 'Read(**/.env*)') -and $cfg.disableAllHooks -eq $true -and -not (@($cfg.PSObject.Properties.Name) -contains 'allow')) ''
$gt = Get-Content -Raw (Join-Path $Kit 'gate-tests.json') | ConvertFrom-Json
Check 'gate-tests.json lists only node script paths for 007A' (@($gt.gates.'007A').Count -eq 3 -and -not @(@($gt.gates.'007A') | Where-Object { -not ([string]@($_)[0] -cmatch $LoopPathRx) }).Count) ''

Get-ChildItem Env:FAKE_* | ForEach-Object { Remove-Item "Env:$($_.Name)" }
Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ("`nloop tests: {0} checks, {1} failed" -f $script:n, $script:fail)
exit $(if ($script:fail -eq 0) { 0 } else { 1 })
