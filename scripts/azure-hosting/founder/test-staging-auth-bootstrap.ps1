<#
  Gate 006C - offline tests for staging-auth-bootstrap.lib.ps1 / Initialize-StagingAuthTest.ps1.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/azure-hosting/founder/test-staging-auth-bootstrap.ps1

  No network, no gh, no Supabase: Invoke-Gh and Invoke-CbcHttp are replaced by stateful
  mocks that still pass every call through the real allow-lists (Test-GhAllowed /
  Test-HttpAllowed) and record violations.
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'staging-auth-bootstrap.lib.ps1')

$script:Pass = 0; $script:Fail = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  if ($Ok) { $script:Pass++; Write-Host "ok   $Name" } else { $script:Fail++; Write-Host "FAIL $Name $(if ($Detail) { "- $Detail" })" }
}

$STG = 'zgxmvpbvvakpsnzcymsf'; $PROD = 'qnjqwmcsfpmpnvlnomat'
$APPHOST = 'ca-cbc-web-stg-cc-001.lemonmeadow-5efc7b91.canadacentral.azurecontainerapps.io'
$ORG1 = '11111111-1111-4111-8111-111111111111'; $ORG2 = '22222222-2222-4222-8222-222222222222'
function B64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function Jwt($claims) { "$(B64 '{"alg":"HS256"}').$(B64 ($claims | ConvertTo-Json -Compress)).c2lnbmF0dXJl" }
$ANON = Jwt @{ iss = 'supabase'; ref = $STG; role = 'anon' }

function New-World([hashtable]$o = @{}) {
  $w = @{
    Login = 'wberytech-stack'; UserId = 4242
    Vars = @{ CBC_STG_NEXT_PUBLIC_SUPABASE_URL = "https://$STG.supabase.co"; CBC_STG_NEXT_PUBLIC_SUPABASE_ANON_KEY = $ANON; CBC_STG_NEXT_PUBLIC_APP_URL = "https://$APPHOST" }
    Settings = @{ external = @{ email = $true }; disable_signup = $false; mailer_autoconfirm = $true }
    EnvExists = $false; Reviewers = @(); Policies = @(); Secrets = @{}; EnvVars = @{}
    Custom = $null; Protected = $false; DbpNull = $false; WaitTimer = $null; PreventSelfReview = $false; ReviewerType = 'User'
    ExtraRule = $null; PoliciesFail = $false; PostMasterNoop = $false; EnvLookup = $null
    Users = @{}; Orgs = @($ORG1, $ORG2, $ORG1, $ORG2, $ORG1, $ORG2); RowsReadable = $true; ProfileMissing = $false; SignupFail = $false; FailSecret = $null
    GhLog = New-Object System.Collections.ArrayList; HttpLog = New-Object System.Collections.ArrayList
    Violations = New-Object System.Collections.ArrayList; SecretArgs = New-Object System.Collections.ArrayList
  }
  foreach ($k in $o.Keys) { $w[$k] = $o[$k] }
  $script:W = $w
}

function Get-MockEnvJson($w) {
  $rules = @()
  if (@($w.Reviewers).Count) { $rules += @{ type = 'required_reviewers'; prevent_self_review = $w.PreventSelfReview; reviewers = @($w.Reviewers | ForEach-Object { @{ type = $w.ReviewerType; reviewer = @{ id = $_ } } }) } }
  if ($w.WaitTimer) { $rules += @{ type = 'wait_timer'; wait_timer = $w.WaitTimer } }
  if ($w.Custom -or $w.Protected) { $rules += @{ type = 'branch_policy' } }
  if ($w.ExtraRule) { $rules += @{ type = $w.ExtraRule } }
  $dbp = if ($w.DbpNull) { $null } else { @{ protected_branches = $w.Protected; custom_branch_policies = $w.Custom } }
  return (@{ name = 'staging-auth-test'; deployment_branch_policy = $dbp; protection_rules = $rules } | ConvertTo-Json -Depth 6 -Compress)
}

function global:Invoke-Gh([string[]]$GhArgs, [string]$StdIn = $null) {
  $w = $script:W; $line = $GhArgs -join ' '; [void]$w.GhLog.Add($line)
  if (-not (Test-GhAllowed $GhArgs)) { [void]$w.Violations.Add("gh $line"); Stop-Bootstrap "refused gh call outside the bootstrap allow-list" }
  $j = { param($o) @{ Code = 0; Out = ($o | ConvertTo-Json -Depth 6 -Compress) } }
  switch -regex ($line) {
    '^api user$' { return (& $j @{ login = $w.Login; id = $w.UserId }) }
    '^api repos/wberytech-stack/checkbeforeclick$' { return (& $j @{ full_name = 'wberytech-stack/checkbeforeclick' }) }
    '^api repos/[^ ]+/actions/variables/(\S+)$' { return (& $j @{ name = $Matches[1]; value = $w.Vars[$Matches[1]] }) }
    '^api -X PUT repos/[^ ]+/environments/staging-auth-test --input -$' {
      $b = ConvertFrom-Json $StdIn; $w.EnvExists = $true; $w.Reviewers = @($b.reviewers | ForEach-Object { $_.id }); $w.Custom = $b.deployment_branch_policy.custom_branch_policies
      return @{ Code = 0; Out = '{}' } }
    '^api repos/[^ ]+/environments/staging-auth-test$' {
      if (-not $w.EnvExists) { return @{ Code = 1; Out = '{"message":"Not Found"}' } }
      return @{ Code = 0; Out = (Get-MockEnvJson $w) } }
    # The preflight lookup: `gh api -i` prints the HTTP status line and headers, a blank
    # line, then the body; gh exits nonzero for 4xx/5xx. EnvLookup selects a failure mode.
    '^api -i repos/[^ ]+/environments/staging-auth-test$' {
      $nf = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}'
      $ok = "HTTP/2.0 200 OK`nContent-Type: application/json; charset=utf-8`nX-Github-Request-Id: ABC`n`n" + (Get-MockEnvJson $w)
      $missing = "HTTP/2.0 404 Not Found`nContent-Type: application/json; charset=utf-8`n`n$nf"
      switch ($w.EnvLookup) {
        '403' { return @{ Code = 1; Out = "HTTP/2.0 403 Forbidden`nContent-Type: application/json`n`n{""message"":""Resource not accessible by integration"",""status"":""403""}" } }
        '500' { return @{ Code = 1; Out = "HTTP/2.0 500 Internal Server Error`nContent-Type: application/json`n`n{""message"":""Server Error""}" } }
        '401' { return @{ Code = 1; Out = "HTTP/2.0 401 Unauthorized`n`n{""message"":""Bad credentials""}" } }
        'cli' { return @{ Code = 4; Out = '' } }
        'network' { return @{ Code = 1; Out = '' } }
        'malformed' { return @{ Code = 0; Out = 'HTTP/2.0 200 OK<html>gateway</html>' } }
        'no-status' { return @{ Code = 1; Out = $nf } }
        '404-exit0' { return @{ Code = 0; Out = $missing } }
        '200-exit1' { return @{ Code = 1; Out = $ok } }
        '404-other-body' { return @{ Code = 1; Out = "HTTP/2.0 404 Not Found`n`n{""message"":""Repository not found""}" } }
        '404-no-body' { return @{ Code = 1; Out = "HTTP/2.0 404 Not Found`nContent-Type: text/html`n`n<html>404</html>" } }
        '200-other-name' { return @{ Code = 0; Out = ($ok -replace '"name":"staging-auth-test"', '"name":"azure-production"') } }
        'crlf' { $t = if ($w.EnvExists) { $ok } else { $missing }; return @{ Code = $(if ($w.EnvExists) { 0 } else { 1 }); Out = ($t -replace "`n", "`r`n") } }
      }
      if ($w.EnvExists) { return @{ Code = 0; Out = $ok } }
      return @{ Code = 1; Out = $missing } }
    '^api repos/[^ ]+/deployment-branch-policies$' {
      if ($w.PoliciesFail) { return @{ Code = 1; Out = '' } }
      return (& $j @{ branch_policies = @($w.Policies | ForEach-Object { if ($_ -match '^tag:(.+)$') { @{ name = $Matches[1]; type = 'tag' } } else { @{ name = $_; type = 'branch' } } }) }) }
    'deployment-branch-policies -f name=master' { if (-not $w.PostMasterNoop) { $w.Policies = @($w.Policies) + 'master' }; return @{ Code = 0; Out = '{}' } }
    '^secret set (\S+) ' { [void]$w.SecretArgs.Add($line); if ($w.FailSecret -eq $Matches[1]) { return @{ Code = 1; Out = '' } }; $w.Secrets[$Matches[1]] = $StdIn; return @{ Code = 0; Out = '' } }
    '^secret list ' { return (& $j @($w.Secrets.Keys | ForEach-Object { @{ name = $_ } })) }
    '^variable set (\S+) .* --body (\S+)$' { $w.EnvVars[$Matches[1]] = $Matches[2]; return @{ Code = 0; Out = '' } }
    '^variable list ' { return (& $j @($w.EnvVars.Keys | ForEach-Object { @{ name = $_; value = $w.EnvVars[$_] } })) }
  }
  [void]$w.Violations.Add("unmocked gh $line"); return @{ Code = 9; Out = '' }
}

function global:Invoke-CbcHttp([string]$Method, [string]$Url, [hashtable]$Headers = @{}, [string]$Body = $null, [string]$AppHost = $null) {
  $w = $script:W; [void]$w.HttpLog.Add(@{ Method = $Method; Url = $Url; Headers = $Headers; Body = $Body })
  if (-not (Test-HttpAllowed $Method $Url $AppHost)) { [void]$w.Violations.Add("http $Method $Url"); Stop-Bootstrap "refused $Method outside the bootstrap allow-list" }
  $u = [Uri]$Url; $json = { param($s, $o) @{ Status = $s; Body = ($o | ConvertTo-Json -Depth 6 -Compress); SetCookie = @() } }
  if ($Headers.apikey -and $Headers.apikey -ne $ANON) { [void]$w.Violations.Add('wrong apikey') }
  # Build every request with the real constructor, exactly as Invoke-CbcHttp passes it.
  $req = New-CbcHttpRequest $Method $Url $Headers $Body
  if ($Method -eq 'GET' -and $null -ne $req.Content) { [void]$w.Violations.Add("GET with content $Url") }
  switch ($u.AbsolutePath) {
    '/auth/v1/settings' { return (& $json 200 $w.Settings) }
    '/auth/v1/signup' {
      $b = ConvertFrom-Json $Body
      if ($w.SignupFail) { return (& $json 500 @{ msg = 'boom' }) }
      if ($w.Users.ContainsKey($b.email)) { return (& $json 422 @{ code = 422; error_code = 'user_already_exists'; msg = 'User already registered' }) }
      $uid = [guid]::NewGuid().ToString(); $org = $w.Orgs[$w.Users.Count]
      $w.Users[$b.email] = @{ uid = $uid; org = $org; pw = $b.password; token = "tok-$uid" }
      return (& $json 200 @{ access_token = "tok-$uid"; user = @{ id = $uid; email = $b.email; email_confirmed_at = '2026-10-25T00:00:00Z' } }) }
    '/auth/v1/logout' { return @{ Status = 204; Body = ''; SetCookie = @() } }
    '/rest/v1/users' {
      $tok = ([string]$Headers.authorization) -replace '^Bearer ', ''
      $usr = @($w.Users.Values | Where-Object { $_.token -eq $tok })[0]
      if (-not $w.RowsReadable -or -not $usr -or $w.ProfileMissing) { return @{ Status = 200; Body = '[]'; SetCookie = @() } }
      return @{ Status = 200; Body = "[{""id"":""$($usr.uid)"",""organization_id"":""$($usr.org)""}]"; SetCookie = @() } }
    '/api/auth/login' {
      $b = ConvertFrom-Json $Body; $usr = $w.Users[$b.email]
      if (-not $usr -or $usr.pw -ne $b.password) { return (& $json 401 @{ error = 'x' }) }
      return @{ Status = 200; Body = '{"ok":true}'; SetCookie = @("sb-$STG-auth-token=base64-x; Path=/; HttpOnly") } }
    '/auth/signout' { return @{ Status = 307; Body = ''; SetCookie = @() } }
  }
  if ($u.AbsolutePath -match '^/api/scan/[0-9a-f-]+/status$') { return @{ Status = $(if ($w.ProfileMissing) { 403 } else { 404 }); Body = '{}'; SetCookie = @() } }
  [void]$w.Violations.Add("unmocked http $Method $Url"); return @{ Status = 599; Body = ''; SetCookie = @() }
}

function Run-Boot([hashtable]$p = @{}) {
  $logs = New-Object System.Collections.ArrayList
  $args2 = @{ EmailBase = 'founder@example.com'; Log = { param($m) [void]$logs.Add($m) } }
  foreach ($k in $p.Keys) { $args2[$k] = $p[$k] }
  $err = $null; $rep = $null; $type = $null
  try { $rep = Invoke-StagingAuthBootstrap @args2 } catch { $err = $_.Exception.Message; $type = $_.Exception.GetType().Name }
  return @{ Report = $rep; Error = $err; Type = $type; Log = ($logs -join "`n") }
}
$writes = { @($script:W.GhLog | Where-Object { $_ -match '^(api -X|secret set|variable set)' }).Count + @($script:W.HttpLog | Where-Object { $_.Url -match '/signup$' }).Count }

# ------------------------------------------------------------------ fresh run
New-World
$r = Run-Boot
$w = $script:W
Check 'fresh: completes with verification PASS' ($null -eq $r.Error -and @($r.Report.Verification.Values | Where-Object { -not $_ }).Count -eq 0) "$($r.Error)"
Check 'fresh: no call outside the allow-lists' ($w.Violations.Count -eq 0) ($w.Violations -join '; ')
Check 'fresh: environment with the founder as reviewer and master-only deployments' ($w.EnvExists -and ($w.Reviewers -join ',') -eq '4242' -and $w.Custom -eq $true -and ($w.Policies -join ',') -eq 'master')
Check 'fresh: two staging users created through signup with derived plus-addresses' (@($w.Users.Keys | Sort-Object) -join ',' -eq 'founder+cbc-stg-test-a-g1@example.com,founder+cbc-stg-test-b-g1@example.com')
Check 'fresh: four secrets stored, values only on stdin (never in arguments)' ($w.Secrets.Count -eq 4 -and @($w.SecretArgs | Where-Object { $_ -match '--body' }).Count -eq 0 -and ($w.SecretArgs | ForEach-Object { $_ }) -notmatch ([regex]::Escape($w.Secrets['CBC_TEST_A_PASSWORD'])))
Check 'fresh: stored passwords equal the signup passwords' ($w.Secrets['CBC_TEST_A_PASSWORD'] -eq $w.Users['founder+cbc-stg-test-a-g1@example.com'].pw -and $w.Secrets['CBC_TEST_B_PASSWORD'] -eq $w.Users['founder+cbc-stg-test-b-g1@example.com'].pw)
$pa = $w.Secrets['CBC_TEST_A_PASSWORD']; $pb = $w.Secrets['CBC_TEST_B_PASSWORD']
Check 'fresh: passwords are 32 characters, all four classes, independent' ($pa.Length -eq 32 -and $pb.Length -eq 32 -and $pa -ne $pb -and $pa -cmatch '[A-Z]' -and $pa -cmatch '[a-z]' -and $pa -match '[0-9]' -and $pa -match '[^A-Za-z0-9]')
Check 'fresh: organization variables set, distinct, observed' ($w.EnvVars['CBC_TEST_A_ORG_ID'] -eq $ORG1 -and $w.EnvVars['CBC_TEST_B_ORG_ID'] -eq $ORG2 -and $r.Report.OrgEvidence -like 'VERIFIED*')
Check 'fresh: log never contains a password, key or token' ($r.Log -notmatch [regex]::Escape($pa) -and $r.Log -notmatch [regex]::Escape($pb) -and $r.Log -notmatch [regex]::Escape($ANON) -and $r.Log -notmatch 'tok-')
Check 'fresh: signup sessions are logged out' (@($w.HttpLog | Where-Object { $_.Url -match '/auth/v1/logout$' }).Count -eq 2)
Check 'fresh: no workflow call, no admin endpoint, no service-role key' (@($w.GhLog | Where-Object { $_ -match 'workflow|run ' }).Count -eq 0 -and @($w.HttpLog | Where-Object { $_.Url -match '/admin' }).Count -eq 0)
Check 'fresh: outcome VERIFIED with both accounts verified by this run' ($r.Report.Outcome -eq 'VERIFIED' -and $r.Report.Accounts.A -eq 'VERIFIED' -and $r.Report.Accounts.B -eq 'VERIFIED')
Check 'fresh: report lists what was created' (($r.Report.Created -join '|') -match 'environment staging-auth-test' -and ($r.Report.Created -join '|') -match 'staging user founder\+cbc-stg-test-b-g1@example\.com' -and ($r.Report.Created -join '|') -match 'variable CBC_TEST_B_ORG_ID')

# ------------------------------------------------------------------ R1: stored credentials are not proof
$before = $w.Users.Count
$pwBefore = $w.Secrets['CBC_TEST_A_PASSWORD']
$snapshot = { @{ Gh = $script:W.GhLog.Count; Http = $script:W.HttpLog.Count } }
$s0 = & $snapshot
$r2 = Run-Boot
$newWrites = @($script:W.GhLog | Select-Object -Skip $s0.Gh | Where-Object { $_ -match '^(api -X|secret set|variable set)' }).Count
Check 'R1 rerun without a choice: STOP (not PASS), offers -Replace and -AttestExisting, writes nothing' ($r2.Type -eq 'CbcStop' -and $r2.Error -match '-Replace -Generation 2' -and $r2.Error -match '-AttestExisting' -and $newWrites -eq 0 -and $script:W.Users.Count -eq $before) "$($r2.Error)"
$r3 = Run-Boot @{ AttestExisting = $true }
Check 'R1 -AttestExisting without organization ids: STOP' ($r3.Error -match '-AttestExisting needs -OrgIdA')
$r4 = Run-Boot @{ AttestExisting = $true; OrgIdA = $ORG2; OrgIdB = $ORG1 }
Check 'R1 -AttestExisting with ids contradicting the stored variables: STOP' ($r4.Error -match 'inconsistent' -and $script:W.EnvVars['CBC_TEST_A_ORG_ID'] -eq $ORG1)
$s1 = & $snapshot
$r5 = Run-Boot @{ AttestExisting = $true; OrgIdA = $ORG1; OrgIdB = $ORG2 }
Check 'R1 -AttestExisting with matching ids: outcome ATTESTED (not VERIFIED), accounts ATTESTED' ($null -eq $r5.Error -and $r5.Report.Outcome -eq 'ATTESTED' -and $r5.Report.Accounts.A -eq 'ATTESTED' -and $r5.Report.Accounts.B -eq 'ATTESTED') "$($r5.Error)"
Check 'R1 -AttestExisting: no signup, no secret write, and says sign-in is NOT verified' (@($script:W.HttpLog | Select-Object -Skip $s1.Http | Where-Object { $_.Url -match '/signup$' }).Count -eq 0 -and @($script:W.GhLog | Select-Object -Skip $s1.Gh | Where-Object { $_ -match '^secret set' }).Count -eq 0 -and $r5.Log -match 'NOT verified by this run')
$r6 = Run-Boot @{ Replace = $true; Generation = 2 }
Check 'R1 -Replace -Generation 2: fresh pair created and verified, secrets overwritten, outcome VERIFIED' ($null -eq $r6.Error -and $r6.Report.Outcome -eq 'VERIFIED' -and $script:W.Users.ContainsKey('founder+cbc-stg-test-a-g2@example.com') -and $script:W.Secrets['CBC_TEST_A_EMAIL'] -eq 'founder+cbc-stg-test-a-g2@example.com' -and $script:W.Secrets['CBC_TEST_A_PASSWORD'] -ne $pwBefore -and $script:W.Secrets['CBC_TEST_A_PASSWORD'] -eq $script:W.Users['founder+cbc-stg-test-a-g2@example.com'].pw) "$($r6.Error)"
Check 'R1 -Replace: report asks to delete the earlier users' (($r6.Report.Notes -join ' ') -match 'delete the earlier staging user for account A')
$r7 = Run-Boot @{ Replace = $true; AttestExisting = $true; OrgIdA = $ORG1; OrgIdB = $ORG2 }
Check 'R1 -Replace with -AttestExisting: STOP' ($r7.Error -match 'not both')
New-World
$r8 = Run-Boot @{ AttestExisting = $true; OrgIdA = $ORG1; OrgIdB = $ORG2 }
Check 'R1 -AttestExisting with nothing stored: STOP, nothing written' ($r8.Error -match 'no account has stored credentials' -and (& $writes) -eq 0)

# ------------------------------------------------------------------ R2: only one secret stored is PARTIAL
New-World @{ FailSecret = 'CBC_TEST_A_PASSWORD' }
$p1 = Run-Boot
Check 'R2 password secret fails after email stored: PARTIAL (CbcPartial), with recovery' ($p1.Type -eq 'CbcPartial' -and $p1.Error -match '^PARTIAL' -and $p1.Error -match '-Replace -Generation 2' -and $p1.Error -match 'delete the orphaned staging user') "$($p1.Type) $($p1.Error)"
Check 'R2: exactly one of the pair is stored and no organization variable is set' (($script:W.Secrets.Keys -join ',') -eq 'CBC_TEST_A_EMAIL' -and $script:W.EnvVars.Count -eq 0)
$script:W.FailSecret = $null
$s2 = & $snapshot
$p2 = Run-Boot
Check 'R2 plain rerun: PARTIAL again (never an ordinary success), writes nothing' ($p2.Type -eq 'CbcPartial' -and $p2.Error -match 'only CBC_TEST_A_EMAIL' -and @($script:W.GhLog | Select-Object -Skip $s2.Gh | Where-Object { $_ -match '^(api -X|secret set|variable set)' }).Count -eq 0) "$($p2.Type) $($p2.Error)"
$p3 = Run-Boot @{ AttestExisting = $true; OrgIdA = $ORG1; OrgIdB = $ORG2 }
Check 'R2 -AttestExisting cannot paper over a partial pair: still PARTIAL' ($p3.Type -eq 'CbcPartial')
$p4 = Run-Boot @{ Replace = $true; Generation = 2 }
Check 'R2 recovery with -Replace -Generation 2: completes VERIFIED with both pairs stored' ($null -eq $p4.Error -and $p4.Report.Outcome -eq 'VERIFIED' -and $script:W.Secrets.Count -eq 4 -and $script:W.Secrets['CBC_TEST_A_PASSWORD'] -eq $script:W.Users['founder+cbc-stg-test-a-g2@example.com'].pw) "$($p4.Error)"
New-World @{ FailSecret = 'CBC_TEST_B_EMAIL' }
$p5 = Run-Boot
Check 'R2 first secret of a pair fails: STOP (not PARTIAL), nothing stored for that account' ($p5.Type -eq 'CbcStop' -and $p5.Error -match 'no credential could be stored' -and -not $script:W.Secrets.ContainsKey('CBC_TEST_B_PASSWORD'))

# ------------------------------------------------------------------ preflight stops before any write
foreach ($case in @(
    @{ N = 'GitHub signed in as someone else'; O = @{ Login = 'someone-else' }; Want = 'not wberytech-stack' },
    @{ N = 'staging URL variable points at production'; O = @{ Vars = @{ CBC_STG_NEXT_PUBLIC_SUPABASE_URL = "https://$PROD.supabase.co"; CBC_STG_NEXT_PUBLIC_SUPABASE_ANON_KEY = $ANON; CBC_STG_NEXT_PUBLIC_APP_URL = "https://$APPHOST" } }; Want = 'not the staging project' },
    @{ N = 'public key belongs to production'; O = @{ Vars = @{ CBC_STG_NEXT_PUBLIC_SUPABASE_URL = "https://$STG.supabase.co"; CBC_STG_NEXT_PUBLIC_SUPABASE_ANON_KEY = (Jwt @{ ref = $PROD; role = 'anon' }); CBC_STG_NEXT_PUBLIC_APP_URL = "https://$APPHOST" } }; Want = 'not an anon key for the staging project' },
    @{ N = 'public key is a service-role key'; O = @{ Vars = @{ CBC_STG_NEXT_PUBLIC_SUPABASE_URL = "https://$STG.supabase.co"; CBC_STG_NEXT_PUBLIC_SUPABASE_ANON_KEY = (Jwt @{ ref = $STG; role = 'service_role' }); CBC_STG_NEXT_PUBLIC_APP_URL = "https://$APPHOST" } }; Want = 'not an anon key' },
    @{ N = 'app URL is production'; O = @{ Vars = @{ CBC_STG_NEXT_PUBLIC_SUPABASE_URL = "https://$STG.supabase.co"; CBC_STG_NEXT_PUBLIC_SUPABASE_ANON_KEY = $ANON; CBC_STG_NEXT_PUBLIC_APP_URL = 'https://checkbeforeclick.com' } }; Want = 'not the staging Container App' },
    @{ N = 'signup disabled'; O = @{ Settings = @{ external = @{ email = $true }; disable_signup = $true; mailer_autoconfirm = $true } }; Want = 'does not allow confirmed email signup' },
    @{ N = 'autoconfirm off'; O = @{ Settings = @{ external = @{ email = $true }; disable_signup = $false; mailer_autoconfirm = $false } }; Want = 'does not allow confirmed email signup' },
    @{ N = 'one credential secret already present without its pair'; O = @{ EnvExists = $true; Custom = $true; Reviewers = @(4242); Policies = @('master'); Secrets = @{ CBC_TEST_A_EMAIL = 'x' } }; Want = 'PARTIAL: environment holds only CBC_TEST_A_EMAIL' }
  )) {
  New-World $case.O
  $rr = Run-Boot
  Check "preflight: $($case.N) -> STOP, nothing written" ($rr.Error -match [regex]::Escape($case.Want) -and (& $writes) -eq 0 -and $script:W.Users.Count -eq 0) "$($rr.Error)"
}
New-World
$rr = Run-Boot @{ EmailBase = 'not-an-address' }
Check 'preflight: invalid -EmailBase -> STOP, nothing written' ($rr.Error -match 'EmailBase' -and (& $writes) -eq 0)
New-World @{ EnvExists = $true; Custom = $true; Reviewers = @(4242); Policies = @('master', 'release') }
$rr = Run-Boot
Check 'environment allowing other branches -> STOP with zero writes (no PUT, no POST, no secret, no signup)' ($rr.Error -match 'not compatible, so nothing was changed' -and (& $writes) -eq 0 -and @($script:W.GhLog | Where-Object { $_ -match '^api -X' }).Count -eq 0) "$($rr.Error)"

# ------------------------------------------------------------------ environment lookup: only a confirmed 404 means absent
# Any lookup that is not a clear 200 or 404 stops in preflight: no environment PUT/POST,
# no secret, no variable, no signup. Each case also runs with -Replace so that, without
# the fix, a run would otherwise go on to create the environment and the accounts.
foreach ($case in @(
    @{ N = 'HTTP 403'; Mode = '403'; Exists = $true; Want = 'not a clear 200 or 404 \(HTTP 403' },
    @{ N = 'HTTP 403 on an absent environment'; Mode = '403'; Exists = $false; Want = 'not a clear 200 or 404 \(HTTP 403' },
    @{ N = 'HTTP 500'; Mode = '500'; Exists = $true; Want = 'not a clear 200 or 404 \(HTTP 500' },
    @{ N = 'HTTP 401 (authentication failure)'; Mode = '401'; Exists = $false; Want = 'not a clear 200 or 404 \(HTTP 401' },
    @{ N = 'a GitHub CLI failure with no output'; Mode = 'cli'; Exists = $true; Want = 'returned no HTTP status \(gh exit 4' },
    @{ N = 'a network failure or timeout (no response)'; Mode = 'network'; Exists = $false; Want = 'returned no HTTP status \(gh exit 1' },
    @{ N = 'a malformed 200 response'; Mode = 'malformed'; Exists = $true; Want = 'not a clear 200 or 404 \(HTTP 200' },
    @{ N = 'a Not Found body without a status line'; Mode = 'no-status'; Exists = $false; Want = 'returned no HTTP status' },
    @{ N = 'a 404 status with gh exit 0 (contradictory)'; Mode = '404-exit0'; Exists = $false; Want = 'not a clear 200 or 404 \(HTTP 404, gh exit 0' },
    @{ N = 'a 200 status with gh exit 1 (contradictory)'; Mode = '200-exit1'; Exists = $true; Want = 'not a clear 200 or 404 \(HTTP 200, gh exit 1' },
    @{ N = 'a 404 for something other than the environment'; Mode = '404-other-body'; Exists = $false; Want = 'not a clear 200 or 404 \(HTTP 404' },
    @{ N = 'a 404 with a non-JSON body'; Mode = '404-no-body'; Exists = $false; Want = 'not a clear 200 or 404 \(HTTP 404' },
    @{ N = 'a 200 for a different environment'; Mode = '200-other-name'; Exists = $true; Want = 'not a clear 200 or 404 \(HTTP 200' }
  )) {
  $o = @{ EnvLookup = $case.Mode }
  if ($case.Exists) { $o.EnvExists = $true; $o.Custom = $true; $o.Reviewers = @(4242); $o.Policies = @('master') }
  New-World $o
  $rr = Run-Boot @{ Replace = $true; Generation = 2 }
  Check "lookup with $($case.N): STOP in preflight with zero writes" (
    $rr.Type -eq 'CbcStop' -and $rr.Error -match $case.Want -and $rr.Error -match 'nothing was changed' -and (& $writes) -eq 0 -and
    @($script:W.GhLog | Where-Object { $_ -match '^api -X' }).Count -eq 0 -and $script:W.Users.Count -eq 0 -and $script:W.Secrets.Count -eq 0) "$($rr.Error)"
}
New-World
$rr = Run-Boot
Check 'lookup: a confirmed 404 (status line, gh exit 1, Not Found body) permits creation' (
  $null -eq $rr.Error -and @($script:W.GhLog | Where-Object { $_ -match '^api -i repos/.+/environments/staging-auth-test$' }).Count -eq 1 -and
  @($script:W.GhLog | Where-Object { $_ -match '^api -X PUT' }).Count -eq 1 -and $rr.Report.Outcome -eq 'VERIFIED') "$($rr.Error)"
New-World @{ EnvLookup = 'crlf' }
$rr = Run-Boot
Check 'lookup: a confirmed 404 with CRLF line endings is still recognised' ($null -eq $rr.Error -and @($script:W.GhLog | Where-Object { $_ -match '^api -X PUT' }).Count -eq 1) "$($rr.Error)"
New-World @{ EnvExists = $true; Custom = $true; Reviewers = @(4242); Policies = @('master'); WaitTimer = 30; EnvLookup = 'crlf' }
$rr = Run-Boot
Check 'lookup: a confirmed 200 for a valid existing environment leaves it untouched (no PUT, no POST, wait timer kept)' (
  $null -eq $rr.Error -and @($script:W.GhLog | Where-Object { $_ -match '^api -X' }).Count -eq 0 -and $script:W.WaitTimer -eq 30) "$($rr.Error)"
Check 'gh allow-list: -i is allowed only for the staging-auth-test lookup' (
  (Test-GhAllowed @('api', '-i', 'repos/wberytech-stack/checkbeforeclick/environments/staging-auth-test')) -and
  -not (Test-GhAllowed @('api', '-i', 'repos/wberytech-stack/checkbeforeclick/environments/azure-production')) -and
  -not (Test-GhAllowed @('api', '-i', '-X', 'PUT', 'repos/wberytech-stack/checkbeforeclick/environments/staging-auth-test')))
$libSrc = Get-Content -Raw (Join-Path $here 'staging-auth-bootstrap.lib.ps1')
Check 'source: preflight decides existence only through Get-EnvLookup' (
  $libSrc -match '\$envNow = Get-EnvLookup \$R \$E' -and @([regex]::Matches($libSrc, "Invoke-Gh @\('api', '-i'")).Count -eq 1)

# ------------------------------------------------------------------ existing environment: validated before any write
$compliant = @{ EnvExists = $true; Custom = $true; Reviewers = @(4242); Policies = @('master') }
foreach ($case in @(
    @{ N = 'an extra deployment branch'; O = @{ Policies = @('master', 'release') }; Want = 'other than branch master: branch:release' },
    @{ N = 'a tag deployment policy'; O = @{ Policies = @('master', 'tag:v*') }; Want = 'other than branch master: tag:v\*' },
    @{ N = 'an additional reviewer'; O = @{ Reviewers = @(4242, 777) }; Want = 'required reviewers are not exactly you' },
    @{ N = 'someone else as the only reviewer'; O = @{ Reviewers = @(777) }; Want = 'required reviewers are not exactly you' },
    @{ N = 'a team as reviewer'; O = @{ ReviewerType = 'Team' }; Want = 'required reviewers are not exactly you' },
    @{ N = 'no required reviewers'; O = @{ Reviewers = @() }; Want = 'required reviewers are not exactly you' },
    @{ N = 'deployments from any branch'; O = @{ DbpNull = $true }; Want = 'not restricted to selected branches' },
    @{ N = 'protected-branches mode'; O = @{ Protected = $true; Custom = $false }; Want = 'not restricted to selected branches' },
    @{ N = 'an unknown protection rule'; O = @{ ExtraRule = 'custom_deployment_protection' }; Want = 'unexpected protection rule type' },
    @{ N = 'branch policies unreadable'; O = @{ PoliciesFail = $true }; Want = 'branch policies could not be read' }
  )) {
  $o = $compliant.Clone(); foreach ($k in $case.O.Keys) { $o[$k] = $case.O[$k] }
  New-World $o
  $rr = Run-Boot @{ Replace = $true; Generation = 2 }
  $envWrites = @($script:W.GhLog | Where-Object { $_ -match '^api -X' }).Count
  Check "existing env with $($case.N): STOP before any write (no environment, secret, variable or signup write)" (
    $rr.Error -match 'not compatible, so nothing was changed' -and $rr.Error -match $case.Want -and (& $writes) -eq 0 -and $envWrites -eq 0) "$($rr.Error)"
}
New-World ($compliant.Clone())
$script:W.WaitTimer = 15; $script:W.PreventSelfReview = $true
$rr = Run-Boot
Check 'compliant existing env (with wait timer and self-review prevention): never PUT, never re-POSTed, stricter settings kept' (
  $null -eq $rr.Error -and @($script:W.GhLog | Where-Object { $_ -match '^api -X' }).Count -eq 0 -and $script:W.WaitTimer -eq 15 -and $script:W.PreventSelfReview -eq $true -and $rr.Log -match 'already compliant; not modified') "$($rr.Error)"
$o = $compliant.Clone(); $o.Policies = @()
New-World $o
$rr = Run-Boot
$envCalls = @($script:W.GhLog | Where-Object { $_ -match '^api -X' })
Check 'compliant env missing only the master policy (earlier interrupted run): adds master only, no PUT' (
  $null -eq $rr.Error -and $envCalls.Count -eq 1 -and $envCalls[0] -match '^api -X POST .*deployment-branch-policies -f name=master' -and ($script:W.Policies -join ',') -eq 'master') "$($rr.Error) $($envCalls -join ' | ')"
New-World
$rr = Run-Boot
$firstWrite = [array]::IndexOf(@($script:W.GhLog), @($script:W.GhLog | Where-Object { $_ -match '^api -X|^secret set|^variable set' })[0])
$lastPreflightRead = [array]::IndexOf(@($script:W.GhLog), @($script:W.GhLog | Where-Object { $_ -match '^api -i repos/.+/environments/staging-auth-test$' })[0])
Check 'absent env: created (PUT) and restricted (POST master), then re-read and validated before any account' (
  $null -eq $rr.Error -and @($script:W.GhLog | Where-Object { $_ -match '^api -X PUT' }).Count -eq 1 -and $firstWrite -gt $lastPreflightRead -and
  (@($script:W.GhLog) | Select-String -Pattern 'deployment-branch-policies -f name=master' | Select-Object -First 1).LineNumber -lt (@($script:W.GhLog) | Select-String -Pattern '^secret set' | Select-Object -First 1).LineNumber)
New-World @{ PostMasterNoop = $true }
$rr = Run-Boot
Check 'absent env whose master policy does not take effect: STOP before any account' ($rr.Error -match 'not as expected after setup' -and $script:W.Users.Count -eq 0 -and $script:W.Secrets.Count -eq 0)

# ------------------------------------------------------------------ account and organization failures
New-World
$script:W.Users['founder+cbc-stg-test-a-g1@example.com'] = @{ uid = 'x'; org = $ORG1; pw = 'unknown'; token = 't' }
$rr = Run-Boot
Check 'user exists without stored credentials -> STOP with delete/-Generation advice, no secrets' ($rr.Error -match 'already exists' -and $rr.Error -match 'Generation 2' -and $script:W.Secrets.Count -eq 0)
New-World @{ SignupFail = $true }
$rr = Run-Boot
Check 'signup error -> STOP, nothing stored for the account' ($rr.Error -match 'did not return a confirmed user' -and $script:W.Secrets.Count -eq 0)
New-World @{ Orgs = @($ORG1, $ORG1) }
$rr = Run-Boot
Check 'both accounts observed in the same organization -> STOP, no organization variables' ($rr.Error -match 'SAME organization' -and $script:W.EnvVars.Count -eq 0)
New-World @{ RowsReadable = $false }
$rr = Run-Boot
Check 'own rows hidden by RLS and no org ids given -> STOP asking for -OrgIdA, credentials kept' ($rr.Error -match '-OrgIdA' -and $script:W.Secrets.Count -eq 4 -and $script:W.EnvVars.Count -eq 0) "$($rr.Error)"
Check 'own rows hidden: profile confirmed through the app (login, status probe, sign-out)' (@($script:W.HttpLog | Where-Object { $_.Url -match '/api/scan/[0-9a-f-]+/status$' }).Count -eq 2 -and @($script:W.HttpLog | Where-Object { $_.Url -match '/auth/signout$' }).Count -eq 2)
$rr = Run-Boot @{ OrgIdA = $ORG1; OrgIdB = $ORG2 }
Check 'hidden rows, rerun with only org ids -> STOP (stored accounts need -AttestExisting or -Replace)' ($rr.Error -match '-AttestExisting')
$rr = Run-Boot @{ AttestExisting = $true; OrgIdA = $ORG1; OrgIdB = $ORG2 }
Check 'hidden rows, rerun with -AttestExisting and org ids -> ATTESTED, accounts not recreated' ($null -eq $rr.Error -and $rr.Report.Outcome -eq 'ATTESTED' -and $rr.Report.OrgEvidence -like 'ATTESTED*' -and $script:W.Users.Count -eq 2 -and $script:W.EnvVars['CBC_TEST_B_ORG_ID'] -eq $ORG2) "$($rr.Error)"
New-World @{ RowsReadable = $false; ProfileMissing = $true }
$rr = Run-Boot @{ OrgIdA = $ORG1; OrgIdB = $ORG2 }
Check 'profile missing (app answers 403) -> STOP, the trigger did not map the account' ($rr.Error -match 'no public.users profile')
New-World
$rr = Run-Boot @{ OrgIdA = $ORG2 }
Check 'founder org id contradicts the observed one -> STOP, no organization variables' ($rr.Error -match 'inconsistent' -and $script:W.EnvVars.Count -eq 0)
New-World
$rr = Run-Boot @{ OrgIdA = 'ORG-1' }
Check 'malformed -OrgIdA -> STOP before any write' ($rr.Error -match 'lowercase UUID' -and (& $writes) -eq 0)

# ------------------------------------------------------------------ the allow-lists themselves
$R = 'wberytech-stack/checkbeforeclick'
foreach ($bad in @(
    @('workflow', 'run', 'staging-auth-journeys.yml'),
    @('api', '-X', 'POST', "repos/$R/actions/workflows/x/dispatches"),
    @('secret', 'set', 'CBC_TEST_A_PASSWORD', '--env', 'staging-auth-test', '--repo', $R, '--body', 'leak'),
    @('secret', 'set', 'OTHER', '--env', 'staging-auth-test', '--repo', $R),
    @('secret', 'set', 'CBC_TEST_A_EMAIL', '--env', 'azure-production', '--repo', $R),
    @('secret', 'set', 'CBC_TEST_A_EMAIL', '--env', 'staging-auth-test', '--repo', 'someone/else'),
    @('api', '-X', 'PUT', "repos/$R/environments/azure-production", '--input', '-'),
    @('api', '-X', 'DELETE', "repos/$R/environments/staging-auth-test"),
    @('variable', 'set', 'CBC_STG_NEXT_PUBLIC_SUPABASE_URL', '--repo', $R, '--body', 'x')
  )) { Check "gh allow-list refuses: $($bad -join ' ')" (-not (Test-GhAllowed $bad)) }
foreach ($bad in @(
    @('POST', "https://$STG.supabase.co/auth/v1/admin/users"),
    @('POST', "https://$STG.supabase.co/rest/v1/users"),
    @('GET', "https://$STG.supabase.co/rest/v1/scans?select=id"),
    @('GET', "https://$STG.supabase.co/rest/v1/users?select=*"),
    @('POST', "https://$PROD.supabase.co/auth/v1/signup"),
    @('POST', "http://$STG.supabase.co/auth/v1/signup"),
    @('POST', "https://$APPHOST/api/scan"),
    @('POST', 'https://checkbeforeclick.com/api/auth/login')
  )) { Check "HTTP allow-list refuses: $($bad -join ' ')" (-not (Test-HttpAllowed $bad[0] $bad[1] $APPHOST)) }

# ------------------------------------------------------------------ request construction (Windows PowerShell 5.1)
# Invoke-CbcHttp's $Body is [string], so a $null body arrives as ''. Each case passes it the
# same way. The first live preflight GET failed because '' still attached a JSON content.
$sbUrl = "https://$STG.supabase.co"
$get = New-CbcHttpRequest 'GET' "$sbUrl/auth/v1/settings" @{ apikey = $ANON } $null
Check 'request: GET with a $null body carries no content' ($null -eq $get.Content -and $get.Method.Method -eq 'GET' -and $get.Headers.Contains('apikey'))
$get2 = New-CbcHttpRequest 'GET' "https://$APPHOST/auth/signout" @{ cookie = 'c=1' }
Check 'request: GET with the body omitted carries no content' ($null -eq $get2.Content)
$json = '{"email":"a@example.com","password":"x"}'
$post = New-CbcHttpRequest 'POST' "$sbUrl/auth/v1/signup" @{ apikey = $ANON } $json
Check 'request: POST keeps its JSON body and content type' (
  $null -ne $post.Content -and $post.Content.ReadAsStringAsync().GetAwaiter().GetResult() -eq $json -and $post.Content.Headers.ContentType.MediaType -eq 'application/json')
$logout = New-CbcHttpRequest 'POST' "$sbUrl/auth/v1/logout" @{ apikey = $ANON } '{}'
Check 'request: logout POST keeps its {} body' ($logout.Content.ReadAsStringAsync().GetAwaiter().GetResult() -eq '{}')
$err = $null; try { $null = New-CbcHttpRequest 'GET' "$sbUrl/auth/v1/settings" @{} '{"x":1}' } catch { $err = $_.Exception.Message }
Check 'request: GET with a non-empty body is refused' ($err -match 'refused GET with a request body') "$err"

# Send a real GET on this runtime to a closed loopback port: nothing leaves the machine.
# Exception types and codes are asserted, not message text (messages are localised).
# On Windows PowerShell 5.1 a request that reaches the connection attempt fails as
# HttpRequestException > WebException (ConnectFailure) > SocketException (ConnectionRefused);
# the original bug failed before any connection with a ProtocolViolationException.
function Send-Loopback($Req) {
  $c = New-Object System.Net.Http.HttpClient; $c.Timeout = [TimeSpan]::FromSeconds(15)
  $r = @{ Sent = $false; Types = @(); WebStatus = $null; SocketCode = $null; Chain = '' }
  try { $null = $c.SendAsync($Req).GetAwaiter().GetResult(); $r.Sent = $true }
  catch {
    $e = $_.Exception
    while ($e) {
      $r.Types += $e.GetType().FullName
      if ($e -is [Net.WebException]) { $r.WebStatus = [string]$e.Status }
      if ($e -is [Net.Sockets.SocketException]) { $r.SocketCode = [string]$e.SocketErrorCode }
      $e = $e.InnerException
    }
    $r.Chain = $r.Types -join ' > '
  } finally { $c.Dispose() }
  return $r
}
function Get-ClosedLoopbackPort {
  $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}
if ($PSVersionTable.PSEdition -eq 'Desktop') {
  $port = Get-ClosedLoopbackPort
  $sent = Send-Loopback (New-CbcHttpRequest 'GET' "http://127.0.0.1:$port/auth/v1/settings" @{ apikey = 'x' } $null)
  Check 'request: real GET on Windows PowerShell 5.1 reaches the connection attempt and is refused (ConnectFailure / ConnectionRefused)' (
    -not $sent.Sent -and $sent.Types -contains 'System.Net.Http.HttpRequestException' -and $sent.WebStatus -eq 'ConnectFailure' -and
    $sent.SocketCode -eq 'ConnectionRefused' -and $sent.Types -notcontains 'System.Net.ProtocolViolationException') "$($sent.Chain) status=$($sent.WebStatus) socket=$($sent.SocketCode)"
  $port = Get-ClosedLoopbackPort
  $bad = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "http://127.0.0.1:$port/")
  $bad.Content = New-Object System.Net.Http.StringContent('', [Text.Encoding]::UTF8, 'application/json')
  $ctl = Send-Loopback $bad
  Check 'request: control - Windows PowerShell 5.1 refuses a GET with an empty content before connecting (ProtocolViolationException)' (
    -not $ctl.Sent -and $ctl.Types -contains 'System.Net.ProtocolViolationException' -and $null -eq $ctl.SocketCode) "$($ctl.Chain) socket=$($ctl.SocketCode)"
} else {
  Check 'request: this suite must run under Windows PowerShell 5.1 (powershell.exe), the runtime the bootstrap uses' $false "edition $($PSVersionTable.PSEdition)"
}

# ------------------------------------------------------------------ static source checks
$lib = Get-Content -Raw (Join-Path $here 'staging-auth-bootstrap.lib.ps1')
$entry = Get-Content -Raw (Join-Path $here 'Initialize-StagingAuthTest.ps1')
# Block comments first: stripping line comments first would remove the closing "#>".
$code = ($lib + $entry) -replace '(?s)<#.*?#>', '' -replace '(?m)^\s*#.*$', ''
Check 'source: no service-role key, no admin API, no auth.users insert' ($code -notmatch 'service_role|SERVICE_ROLE|/auth/v1/admin|auth\.users|sb_secret_')
Check 'source: no file writes (no plaintext credential file)' ($code -notmatch 'Set-Content|Out-File|Add-Content|WriteAllText|WriteAllBytes|Export-Clixml|ConvertTo-SecureString|>\s*\$')
Check 'source: secrets are written to gh stdin, not passed with --body' ($lib -match '\$p\.StandardInput\.Write\(\$StdIn\)' -and $code -notmatch "'secret', 'set'[^\n]*'--body'")
$entryCode = $entry -replace '(?s)<#.*?#>', ''
Check 'entry: exit 0 only for VERIFIED; ATTESTED exits 2; PARTIAL exits 3; STOP exits 1' (
  $entryCode -match "if \(\`$report\.Outcome -eq 'VERIFIED'\) \{[^}]*exit 0" -and $entryCode -match "RESULT: ATTESTED[^\n]*\n\s*exit 2" -and
  $entryCode -match "RESULT: PARTIAL[^\n]*\n\s*exit 3" -and $entryCode -match "RESULT: STOP[^\n]*\n\s*exit 1" -and @([regex]::Matches($entryCode, 'exit 0')).Count -eq 1)
Check 'entry: PARTIAL is recognised by exception type and never reported as PASS' (
  $entryCode -match '\$partial = \$_\.Exception\.GetType\(\)\.Name -eq ''CbcPartial''' -and
  $entryCode -match 'if \(\$partial\) \{\s*Write-Host "PARTIAL' -and $entryCode -match 'Not a completed bootstrap')
Check 'source: no workflow dispatch anywhere' ($code -notmatch 'workflow run|dispatches')
$http = $lib.Substring($lib.IndexOf('function Invoke-CbcHttp'))
$http = $http.Substring(0, $http.IndexOf("`n}") + 2)
Check 'source: Invoke-CbcHttp checks the allow-list first, keeps redirects and cookies off, and builds requests only through New-CbcHttpRequest' (
  $http -match '^function Invoke-CbcHttp[^\n]*\{\s*\n\s*if \(-not \(Test-HttpAllowed' -and $http -match 'AllowAutoRedirect = \$false' -and
  $http -match 'UseCookies = \$false' -and $http -match 'New-CbcHttpRequest \$Method \$Url \$Headers \$Body' -and $http -notmatch 'HttpRequestMessage|StringContent')

Write-Host ''
Write-Host "$($script:Pass) passed, $($script:Fail) failed"
exit $(if ($script:Fail -eq 0) { 0 } else { 1 })
