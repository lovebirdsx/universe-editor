; No preInit override: electron-builder's multiUser logic already defaults
; per-machine installs to Program Files and per-user installs to
; %LocalAppData%\Programs\Universe Editor (matching VSCode's behavior).

!macro customInstall
  ; Add $INSTDIR\bin to user PATH so `ue` is available without admin rights.
  ReadRegStr $0 HKCU "Environment" "PATH"
  ${If} $0 == ""
    WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR\bin"
  ${Else}
    WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR\bin;$0"
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Add context menu entries to Windows Explorer (user-level, no admin required).
  ; Uses HKCU\Software\Classes which Windows merges with HKCR for the current user.
  WriteRegStr HKCU "Software\Classes\*\shell\Open with Universe Editor" "" "用 Universe Editor 打开"
  WriteRegStr HKCU "Software\Classes\*\shell\Open with Universe Editor" "Icon" "$INSTDIR\Universe Editor.exe,0"
  WriteRegStr HKCU "Software\Classes\*\shell\Open with Universe Editor\command" "" '"$INSTDIR\Universe Editor.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\Open with Universe Editor" "" "用 Universe Editor 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Open with Universe Editor" "Icon" "$INSTDIR\Universe Editor.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Open with Universe Editor\command" "" '"$INSTDIR\Universe Editor.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Open with Universe Editor" "" "用 Universe Editor 打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Open with Universe Editor" "Icon" "$INSTDIR\Universe Editor.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Open with Universe Editor\command" "" '"$INSTDIR\Universe Editor.exe" "%V"'

  ; Offer to add a Windows Defender exclusion for the install directory. Without
  ; it, Defender full-scans the ~80MB app.asar on first read every cold start,
  ; adding seconds of startup latency. Opting in needs admin rights (one UAC
  ; prompt); declining leaves the app fully functional, just slower to launch.
  ;
  ; Skip entirely on silent runs: the autoUpdater reinstalls silently into the
  ; same INSTDIR, and the exclusion is registered by path, so any exclusion added
  ; at first install is still in effect. Re-running here would only pop an
  ; unexpected UAC prompt mid-update.
  IfSilent skipDefenderExclusion
  MessageBox MB_YESNO|MB_ICONQUESTION "为提升启动速度，建议将安装目录加入 Windows Defender 排除项。$\n$\n若不加入，每次启动时 Defender 会扫描程序文件，导致启动明显变慢（可能多花数秒）。$\n$\n是否现在加入？（需要管理员授权）" /SD IDYES IDNO skipDefenderExclusion
  ExecShellWait "runas" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\defender\add-defender-exclusion.ps1"' SW_HIDE
  skipDefenderExclusion:
!macroend

!macro customUnInstall
  ; Remove context menu entries from Windows Explorer.
  DeleteRegKey HKCU "Software\Classes\*\shell\Open with Universe Editor"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Open with Universe Editor"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Open with Universe Editor"

  ; Remove $INSTDIR\bin from user PATH via PowerShell string manipulation.
  nsExec::Exec 'powershell -WindowStyle Hidden -Command "[Environment]::SetEnvironmentVariable(\"PATH\", (([Environment]::GetEnvironmentVariable(\"PATH\", \"User\").Split(\";\") | Where-Object { $$_ -ne \"$INSTDIR\bin\" }) -join \";\"), \"User\")"'
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Best-effort removal of the Defender exclusion added at install time. Elevation
  ; may be declined; if so the stale exclusion is harmless.
  ;
  ; Skip on silent runs: the autoUpdater silently runs the old uninstaller before
  ; reinstalling. Removing the exclusion there (and re-adding it above) would pop
  ; UAC prompts during an otherwise unattended update. Real uninstalls are
  ; interactive, so the exclusion is still cleaned up then.
  IfSilent skipDefenderRemoval
  ExecShellWait "runas" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\defender\remove-defender-exclusion.ps1"' SW_HIDE
  skipDefenderRemoval:
!macroend
