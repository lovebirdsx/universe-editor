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
!macroend

!macro customUnInstall
  ; Remove $INSTDIR\bin from user PATH via PowerShell string manipulation.
  nsExec::Exec 'powershell -WindowStyle Hidden -Command "[Environment]::SetEnvironmentVariable(\"PATH\", (([Environment]::GetEnvironmentVariable(\"PATH\", \"User\").Split(\";\") | Where-Object { $$_ -ne \"$INSTDIR\bin\" }) -join \";\"), \"User\")"'
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
