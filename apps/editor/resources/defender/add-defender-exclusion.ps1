# Adds this install directory to Windows Defender's exclusion list so the first
# read of the large app.asar is not blocked by a full real-time scan (which can
# make cold startup several seconds slower). Run elevated by the NSIS installer.
# Self-locating via $PSScriptRoot avoids passing the path through NSIS quoting.
# This script lives at $INSTDIR\resources\defender, so the install root is two
# levels up — that is the directory we actually want excluded.
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Add-MpPreference -ExclusionPath $dir
