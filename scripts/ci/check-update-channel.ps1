# The built Windows installer says which update server it is for (packaging/make-config.js): a staging build carries
# STAGING_DESCRIPTION (app/src/shared/channel.ts) as its FileDescription and names the staging feed in app-update.yml,
# and a production build carries neither. app/src/main/updater-electron.ts installerRefusal depends on the first.
$ErrorActionPreference = 'Stop'
$staging = $env:RS_UPDATE_HOST -eq 'dl-staging.getreelstudio.com'
$channel = Get-Content -Raw -LiteralPath 'app/src/shared/channel.ts'
if ($channel -notmatch "export const STAGING_DESCRIPTION = '([^'\r\n]+)'") { throw 'STAGING_DESCRIPTION not found in app/src/shared/channel.ts' }
$marker = $Matches[1]
$installers = @(Get-ChildItem -LiteralPath 'app/release' -Filter '*Setup-*.exe')
if ($installers.Count -ne 1) { throw "expected one installer in app/release, found $($installers.Count)" }
$description = (Get-Item -LiteralPath $installers[0].FullName).VersionInfo.FileDescription
Write-Output "$($installers[0].Name): FileDescription '$description' (built for $(if ($staging) { 'staging' } else { 'production' }))"
if (($description -eq $marker) -ne $staging) { throw "the installer's FileDescription '$description' does not say it is a $(if ($staging) { 'staging' } else { 'production' }) build" }
$feed = if ($staging) { 'https://dl-staging.getreelstudio.com/u/' } else { 'https://dl.getreelstudio.com/u/' }
$yml = Get-Content -Raw -LiteralPath 'app/release/win-unpacked/resources/app-update.yml'
Write-Output "app-update.yml: $(($yml -split "`n" | Where-Object { $_ -match '^url:' }) -join ' ')"
if ($yml -notmatch "(?m)^url:[ \t]*$([regex]::Escape($feed))[ \t]*\r?$") { throw "app-update.yml does not name $feed" }
