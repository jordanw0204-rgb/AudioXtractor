param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$OutputDirectory)
Add-Type -AssemblyName System.Drawing
$iconOriginal = [System.Drawing.Image]::FromFile($Source)
try {
  foreach ($iconSize in @(16,32,48,128)) {
    $iconBitmap = New-Object System.Drawing.Bitmap($iconSize,$iconSize)
    $iconGraphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
    try {
      $iconGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $iconGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $iconGraphics.DrawImage($iconOriginal,0,0,$iconSize,$iconSize)
      $iconBitmap.Save((Join-Path $OutputDirectory "icon$iconSize.png"),[System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $iconGraphics.Dispose(); $iconBitmap.Dispose() }
  }
} finally { $iconOriginal.Dispose() }
