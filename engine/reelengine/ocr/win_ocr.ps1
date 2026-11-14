# Reads the text in pictures with the text recognition built into Windows 10/11 (Windows.Media.Ocr),
# for mirror_detect.py. Usage: powershell -File win_ocr.ps1 <picture>...
# Prints one JSON line per picture: {"i": <index>, "lines": ["...", ...]} (or "error"). Each picture is
# read twice, as it is and at double size (capped at the engine's limit): small writing on a wall reads
# far better enlarged, and large writing better as it is. Nothing is written to disk.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(-1)
  $task.Result
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Write-Output '{"error":"no-ocr-language"}'; exit 0 }
$max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
for ($i = 0; $i -lt $Paths.Count; $i++) {
  $stream = $null
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Paths[$i])) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $lines = @()
    $big = [Math]::Min(2.0, $max / [Math]::Max($dec.PixelWidth, $dec.PixelHeight))
    foreach ($k in @(1.0, $big)) {
      $t = New-Object Windows.Graphics.Imaging.BitmapTransform
      $t.ScaledWidth = [uint32][Math]::Floor($dec.PixelWidth * $k)
      $t.ScaledHeight = [uint32][Math]::Floor($dec.PixelHeight * $k)
      $t.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Cubic
      $bmp = Await ($dec.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
          [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $t,
          [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
          [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
      foreach ($l in $res.Lines) { $lines += $l.Text }
      $bmp.Dispose()
      if ($k -ge $big) { break }
    }
    Write-Output (ConvertTo-Json -Compress @{ i = $i; lines = @($lines) })
  } catch {
    Write-Output (ConvertTo-Json -Compress @{ i = $i; error = "$($_.Exception.Message)" })
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}
