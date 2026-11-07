param([ValidatePattern('^[a-p]{32}$')][string]$ExtensionId)
if (-not $ExtensionId) { $ExtensionId = Read-Host 'AudioXtractor extension ID from chrome://extensions' }
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'Invalid extension ID.' }
$companionRoot = $PSScriptRoot
$companionManifestPath = Join-Path $companionRoot 'com.audioxtractor.companion.json'
$companionTools = @{ ytDlp = (Get-Command yt-dlp -ErrorAction Stop).Source; ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source; node = (Get-Command node -ErrorAction Stop).Source }
[System.IO.File]::WriteAllText((Join-Path $companionRoot 'tools.json'), ($companionTools | ConvertTo-Json))
$companionOrigins = @("chrome-extension://$ExtensionId/")
if (Test-Path -LiteralPath $companionManifestPath) { $companionOrigins += (Get-Content -LiteralPath $companionManifestPath -Raw | ConvertFrom-Json).allowed_origins }
$companionHost = @{ name = 'com.audioxtractor.companion'; description = 'AudioXtractor local audio companion'; path = (Join-Path $companionRoot 'AudioXtractor.Native.exe'); type = 'stdio'; allowed_origins = @($companionOrigins | Sort-Object -Unique) }
[System.IO.File]::WriteAllText($companionManifestPath, ($companionHost | ConvertTo-Json))
foreach ($companionBrowser in @('Google\Chrome','Google\ChromeForTesting','Chromium','Microsoft\Edge','BraveSoftware\Brave-Browser')) {
  $companionKey = "HKCU:\Software\$companionBrowser\NativeMessagingHosts\com.audioxtractor.companion"
  New-Item -Path $companionKey -Force | Out-Null
  Set-Item -Path $companionKey -Value $companionManifestPath
}
Write-Output 'AudioXtractor companion is ready. Reopen the extension window.'
