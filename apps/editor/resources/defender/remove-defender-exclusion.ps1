# Removes the exclusions added at install time (install root + updater cache).
# Run elevated by the NSIS uninstaller. Mirrors add-defender-exclusion.ps1: the
# install root is two levels up from this script at $INSTDIR\resources\defender.
$ErrorActionPreference = 'SilentlyContinue'
$resources = Split-Path -Parent $PSScriptRoot
$dir = Split-Path -Parent $resources
Remove-MpPreference -ExclusionPath $dir

$updateYml = Join-Path $resources 'app-update.yml'
$match = Select-String -Path $updateYml -Pattern '^updaterCacheDirName:\s*(.+)$' | Select-Object -First 1
if ($match) {
  $cacheDirName = $match.Matches[0].Groups[1].Value.Trim().Trim("'").Trim('"')
  if ($cacheDirName) {
    Remove-MpPreference -ExclusionPath (Join-Path $env:LOCALAPPDATA $cacheDirName)
  }
}
