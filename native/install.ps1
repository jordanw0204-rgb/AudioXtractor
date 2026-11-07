param([Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId)
$nativeProjectRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $nativeProjectRoot 'scripts/install-native.mjs') --extension-id $ExtensionId
exit $LASTEXITCODE
