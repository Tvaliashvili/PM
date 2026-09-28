# Pushes the R2 credentials in .r2.env to Supabase, trimming any stray
# whitespace or quotes - a secret with a space in it builds a hostname the
# browser cannot resolve. Run from the project root:
#   powershell -ExecutionPolicy Bypass -File .\set-r2-secrets.ps1

Set-Location $PSScriptRoot

if (-not (Test-Path .r2.env)) { Write-Host ".r2.env not found"; exit 1 }

$v = @{}
foreach ($line in Get-Content .r2.env) {
  if ($line -match '^\s*(R2_[A-Z_]+)\s*=\s*(.*)$') {
    $v[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
  }
}

foreach ($key in 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY') {
  if (-not $v[$key]) { Write-Host "$key is missing from .r2.env"; exit 1 }
}

Write-Host ("Account id: {0} chars (should be 32)" -f $v.R2_ACCOUNT_ID.Length)
Write-Host ("Access key: {0} chars (should be 32)" -f $v.R2_ACCESS_KEY_ID.Length)
Write-Host ("Secret:     {0} chars (should be 64)" -f $v.R2_SECRET_ACCESS_KEY.Length)

npx --yes supabase@latest secrets set `
  "R2_ACCOUNT_ID=$($v.R2_ACCOUNT_ID)" `
  "R2_BUCKET=site-photos" `
  "R2_ACCESS_KEY_ID=$($v.R2_ACCESS_KEY_ID)" `
  "R2_SECRET_ACCESS_KEY=$($v.R2_SECRET_ACCESS_KEY)"

if ($?) { npx --yes supabase@latest functions deploy photo-url }
