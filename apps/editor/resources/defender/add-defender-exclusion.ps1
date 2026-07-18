# Adds this install directory to Windows Defender's exclusion list so the first
# read of the large app.asar is not blocked by a full real-time scan (which can
# make cold startup several seconds slower). Run elevated by the NSIS installer.
# Self-locating via $PSScriptRoot avoids passing the path through NSIS quoting.
# This script lives at $INSTDIR\resources\defender, so the install root is two
# levels up — that is the directory we actually want excluded.
$ErrorActionPreference = 'SilentlyContinue'
$resources = Split-Path -Parent $PSScriptRoot
$dir = Split-Path -Parent $resources
Add-MpPreference -ExclusionPath $dir

# Also exclude electron-updater's download cache (%LOCALAPPDATA%\<updaterCacheDirName>):
# Defender full-scans the downloaded installer and differential-reassembly output
# there on every update, slowing the update pipeline. The directory name is read
# from the bundled app-update.yml to avoid hardcoding the package name.
$updateYml = Join-Path $resources 'app-update.yml'
$match = Select-String -Path $updateYml -Pattern '^updaterCacheDirName:\s*(.+)$' | Select-Object -First 1
if ($match) {
  $cacheDirName = $match.Matches[0].Groups[1].Value.Trim().Trim("'").Trim('"')
  if ($cacheDirName) {
    Add-MpPreference -ExclusionPath (Join-Path $env:LOCALAPPDATA $cacheDirName)
  }
}
