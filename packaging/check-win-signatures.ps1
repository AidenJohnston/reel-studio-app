<#
.SYNOPSIS
  Fail unless every PE file (.exe, .dll, .pyd, .node) in a packed app folder carries a valid Authenticode signature
  and, with -Installer, the installer does too. build-win.ps1 -Sign runs it after packaging. Run it by hand on
  release\win-unpacked or on an installed copy (%LOCALAPPDATA%\Programs\reel-studio).

  -Publisher additionally requires the installer certificate's CN to match (give the CN value or a full DN). That is
  what win.azureSignOptions.publisherName (RS_AZURE_PUBLISHER) must equal for electron-updater to accept an update.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\check-win-signatures.ps1 -Unpacked app\release\win-unpacked -Installer app\release\Reel-Studio-Setup-0.1.2-x64.exe
#>
param(
  [Parameter(Mandatory)][string]$Unpacked,
  [string]$Installer = "",
  [string]$Publisher = ""
)
$ErrorActionPreference = "Stop"
$Unpacked = (Get-Item -LiteralPath $Unpacked).FullName   # long form, like the FullName of every file below

function Get-CommonName([string]$dn) {
  $m = [regex]::Match($dn, '(?:^|,)\s*CN=((?:\\.|[^,])*)')
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return $dn.Trim()
}

$files = @(Get-ChildItem $Unpacked -Recurse -File | Where-Object { $_.Extension -in ".exe", ".dll", ".pyd", ".node" })
$byStatus = @{}
$notValid = @()
foreach ($f in $files) {
  $status = (Get-AuthenticodeSignature -LiteralPath $f.FullName).Status.ToString()
  $byStatus[$status] = 1 + [int]$byStatus[$status]
  if ($status -ne "Valid") { $notValid += "{0}  [{1}]" -f $f.FullName.Substring($Unpacked.Length + 1), $status }
}
$summary = ($byStatus.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "
"{0} PE files under {1}: {2}" -f $files.Count, $Unpacked, $summary
foreach ($line in $notValid) { "NOT SIGNED: $line" }
$failed = $notValid.Count -gt 0

if ($Installer) {
  $Installer = (Get-Item -LiteralPath $Installer).FullName
  $sig = Get-AuthenticodeSignature -LiteralPath $Installer
  "installer {0}: {1}" -f (Split-Path $Installer -Leaf), $sig.Status
  if ($sig.Status.ToString() -ne "Valid") {
    "INSTALLER NOT SIGNED: $($sig.StatusMessage)"
    $failed = $true
  } else {
    "  signed by:   $($sig.SignerCertificate.Subject)"
    "  timestamped: $(if ($sig.TimeStamperCertificate) { $sig.TimeStamperCertificate.Subject } else { 'NO (the signature expires with the certificate)' })"
    if ($Publisher) {
      $want = Get-CommonName $Publisher
      $have = Get-CommonName $sig.SignerCertificate.Subject
      if ($want -ne $have) {
        "PUBLISHER MISMATCH: the certificate CN is '$have', RS_AZURE_PUBLISHER says '$want'. Installed copies would refuse updates signed like this."
        $failed = $true
      }
    }
  }
}
if ($failed) { "SIGNATURE CHECK FAILED"; exit 1 }
"signature check passed"
