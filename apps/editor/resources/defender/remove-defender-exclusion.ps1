# Removes the install-directory exclusion added at install time. Run elevated by
# the NSIS uninstaller. Mirrors add-defender-exclusion.ps1.
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Remove-MpPreference -ExclusionPath $dir
