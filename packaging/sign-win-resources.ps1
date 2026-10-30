<#
.SYNOPSIS
  Sign, with Azure Artifact Signing (formerly Trusted Signing), every PE file in a packed app folder that carries no
  signature yet. after-pack.js runs it when RS_WIN_SIGN=1; it can also be run by hand on release\win-unpacked.

  What it signs: every .exe, .dll, .pyd and .node under the folder whose Authenticode status is NotSigned (about 160
  files, in resources\python, resources\ffmpeg and Electron's own DLLs), in ONE Invoke-TrustedSigning call.
  What it leaves alone: files that already carry a VALID signature (the Python runtime ships DLLs signed by Microsoft,
  the PSF, NVIDIA and Intel), and the .exe files directly in the folder, because electron-builder edits their resources
  and signs them itself afterwards (win.azureSignOptions). A file whose signature is present but not valid stops the
  build: that is a damaged or untrusted file, not something to sign over.

  Reads RS_AZURE_ENDPOINT, RS_AZURE_ACCOUNT and RS_AZURE_PROFILE from the environment. The TrustedSigning module reads
  AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET itself (Azure EnvironmentCredential). Nothing but file names
  and counts is printed.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\sign-win-resources.ps1 -Root app\release\win-unpacked
#>
param(
  [Parameter(Mandatory)][string]$Root,
  [string]$Timestamp = "http://timestamp.acs.microsoft.com",   # the server and digests electron-builder itself uses
  [int]$TimeoutSeconds = 900                                     # per signtool batch (the module's default is 300)
)
$ErrorActionPreference = "Stop"
$Root = (Get-Item -LiteralPath $Root).FullName   # long form, like the FullName of every file below (Resolve-Path keeps 8.3 names)
$missing = @("RS_AZURE_ENDPOINT", "RS_AZURE_ACCOUNT", "RS_AZURE_PROFILE", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET" |
  Where-Object { -not [Environment]::GetEnvironmentVariable($_) })
if ($missing.Count) { throw "sign-win-resources: these environment variables must be set: $($missing -join ', ')" }
$sw = [Diagnostics.Stopwatch]::StartNew()

$pe = @(Get-ChildItem $Root -Recurse -File | Where-Object { $_.Extension -in ".exe", ".dll", ".pyd", ".node" })
$toSign = [Collections.Generic.List[string]]::new()
$kept = 0
$skipped = 0
$bad = @()
foreach ($f in $pe) {
  if ($f.DirectoryName -eq $Root -and $f.Extension -eq ".exe") { $skipped++; continue }   # electron-builder signs these
  $sig = Get-AuthenticodeSignature -LiteralPath $f.FullName
  switch ($sig.Status.ToString()) {
    "Valid"     { $kept++ }
    "NotSigned" { $toSign.Add($f.FullName) }
    default     { $bad += "{0}  [{1}] {2}" -f $f.FullName.Substring($Root.Length + 1), $sig.Status, $sig.StatusMessage }
  }
}
foreach ($line in $bad) { "BAD SIGNATURE: $line" }
if ($bad.Count) { throw "sign-win-resources: $($bad.Count) file(s) carry a signature that does not verify; not signing over them" }
"sign-win-resources: {0} PE files under {1}: {2} already validly signed (left alone), {3} left to electron-builder, {4} to sign" -f `
  $pe.Count, $Root, $kept, $skipped, $toSign.Count
if ($toSign.Count -eq 0) { "sign-win-resources: nothing to sign"; exit 0 }
$withComma = @($toSign | Where-Object { $_.Contains(",") })
if ($withComma.Count) { throw "sign-win-resources: Invoke-TrustedSigning takes a comma-separated file list, so a path may not contain a comma: $($withComma -join ' ; ')" }

Import-Module TrustedSigning -MinimumVersion 0.5.0 -ErrorAction Stop
$params = @{
  Endpoint = $env:RS_AZURE_ENDPOINT
  CodeSigningAccountName = $env:RS_AZURE_ACCOUNT
  CertificateProfileName = $env:RS_AZURE_PROFILE
  Files = ($toSign -join ",")
  FileDigest = "SHA256"
  TimestampRfc3161 = $Timestamp
  TimestampDigest = "SHA256"
  Timeout = $TimeoutSeconds
}
Invoke-TrustedSigning @params | Out-Null

$still = @($toSign | Where-Object { (Get-AuthenticodeSignature -LiteralPath $_).Status.ToString() -ne "Valid" })
foreach ($f in $still) { "STILL NOT VALID: $($f.Substring($Root.Length + 1))" }
if ($still.Count) { throw "sign-win-resources: $($still.Count) file(s) do not verify after signing" }
"sign-win-resources: signed {0} files in {1:N0}s" -f $toSign.Count, $sw.Elapsed.TotalSeconds
