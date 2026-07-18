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
  ; Broadcast the PATH change with SMTO_ABORTIFHUNG (0x2) + 1s timeout. NSIS's
  ; own `SendMessage /TIMEOUT` uses SMTO_NORMAL, which serially waits the full
  ; timeout on EVERY hung top-level window — one stuck process on the desktop
  ; adds 5s per window to silent updates (measured: 7 hung windows = +35s).
  ; ABORTIFHUNG skips windows already marked hung; the short timeout bounds the
  ; edge case where the mark lags (e.g. freshly suspended processes). Healthy
  ; windows process WM_SETTINGCHANGE in milliseconds, so 1s loses nothing.
  System::Call 'user32::SendMessageTimeout(p 0xFFFF, i 0x1A, p 0, t "Environment", i 0x2, i 1000, *p .r0)'

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

  ; Offer to add Windows Defender exclusions for the install directory and the
  ; updater download cache. Without them, Defender full-scans the ~80MB app.asar
  ; on first read every cold start (seconds of startup latency) and re-scans the
  ; downloaded installer on every update. Opting in needs admin rights (one UAC
  ; prompt); declining leaves the app fully functional, just slower.
  ;
  ; Skip on silent runs AND on updates: the exclusions are registered by path and
  ; the update reinstalls into the same INSTDIR, so whatever was granted at first
  ; install is still in effect. Re-running here would only pop an unexpected UAC
  ; prompt mid-update. (Updates are no longer silent — the assisted installer now
  ; shows its progress page — so IfSilent alone no longer covers them.)
  IfSilent skipDefenderExclusion
  ${if} ${isUpdated}
    Goto skipDefenderExclusion
  ${endif}
  MessageBox MB_YESNO|MB_ICONQUESTION "为提升启动与更新速度，建议将安装目录和更新缓存目录加入 Windows Defender 排除项。$\n$\n若不加入，每次启动时 Defender 会扫描程序文件（启动可能多花数秒），每次更新时还会重复扫描下载的安装包。$\n$\n是否现在加入？（需要管理员授权）" /SD IDYES IDNO skipDefenderExclusion
  ExecShellWait "runas" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\defender\add-defender-exclusion.ps1"' SW_HIDE
  skipDefenderExclusion:
!macroend

; Auto-updates run the assisted installer non-silently so users see a progress
; page instead of an anxiety-inducing multi-second blackout (the app has already
; quit at that point). The two macros below keep that flow click-free:

; Skip the per-user/per-machine choice page on updates by forcing the mode the
; existing installation used (initMultiUser has already read both registry hives
; by the time this runs inside the page's pre callback).
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
    ${andIf} $hasPerUserInstallation == "0"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

; Replace the default finish page block (same StartApp + run-checkbox behavior
; for fresh installs), but on updates relaunch the app immediately and close the
; installer without waiting for a click — the install section only auto-runs the
; app when silent, so the relaunch must happen here.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function finishPagePre
    ${if} ${isUpdated}
      Call StartApp
      Abort
    ${endif}
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE finishPagePre
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnInstall
  ; Remove context menu entries from Windows Explorer.
  DeleteRegKey HKCU "Software\Classes\*\shell\Open with Universe Editor"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Open with Universe Editor"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Open with Universe Editor"

  ; Remove $INSTDIR\bin from user PATH. Writes the registry directly instead of
  ; [Environment]::SetEnvironmentVariable, whose .NET implementation does its own
  ; SMTO_NORMAL broadcast (1s per hung window); we broadcast once below instead.
  nsExec::Exec 'powershell -WindowStyle Hidden -Command "$$p = ([Environment]::GetEnvironmentVariable(\"PATH\", \"User\").Split(\";\") | Where-Object { $$_ -ne \"$INSTDIR\bin\" }) -join \";\"; Set-ItemProperty -Path \"HKCU:\Environment\" -Name PATH -Value $$p -Type ExpandString"'
  ; SMTO_ABORTIFHUNG + 1s — see customInstall. The silent uninstall runs during
  ; every auto-update, so a hung window here would also stall the update pipeline.
  System::Call 'user32::SendMessageTimeout(p 0xFFFF, i 0x1A, p 0, t "Environment", i 0x2, i 1000, *p .r0)'

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
