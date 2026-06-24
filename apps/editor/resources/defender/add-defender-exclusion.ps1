# Adds this install directory to Windows Defender's exclusion list so the first
# read of the large app.asar is not blocked by a full real-time scan (which can
# make cold startup several seconds slower). Run elevated by the NSIS installer.
# Self-locating via $PSScriptRoot avoids passing the path through NSIS quoting.
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-MpPreference -ExclusionPath $dir
