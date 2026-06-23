!macro preInit
  ; Default install directory to Program Files (electron-builder has no installDir option).
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\Universe Editor"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\Universe Editor"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES\Universe Editor"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES\Universe Editor"
!macroend

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
