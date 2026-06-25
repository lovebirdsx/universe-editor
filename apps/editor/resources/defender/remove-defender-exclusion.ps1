# Removes the install-directory exclusion added at install time. Run elevated by
# the NSIS uninstaller. Mirrors add-defender-exclusion.ps1: the install root is
# two levels up from this script at $INSTDIR\resources\defender.
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Remove-MpPreference -ExclusionPath $dir
