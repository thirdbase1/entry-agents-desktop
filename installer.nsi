!include "MUI2.nsh"

Name "Entry Desktop"
OutFile "dist/Entry-Desktop-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\EntryDesktop"
RequestExecutionLevel user

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Section "Entry Desktop" SecMain
  SetOutPath "$INSTDIR"

  File "native-gui/target/x86_64-pc-windows-gnu/release/entry-desktop.exe"
  File "dist/entry-agent-sidecar.exe"

  ; Create Start Menu & Desktop Shortcuts
  CreateDirectory "$SMPROGRAMS\Entry Desktop"
  CreateShortcut "$SMPROGRAMS\Entry Desktop\Entry Desktop.lnk" "$INSTDIR\entry-desktop.exe"
  CreateShortcut "$DESKTOP\Entry Desktop.lnk" "$INSTDIR\entry-desktop.exe"

  ; Register entry:// URL scheme for OAuth 2.0 Device Flow callback (entry://auth/complete)
  WriteRegStr HKCU "Software\Classes\entry" "" "URL:Entry Desktop Protocol"
  WriteRegStr HKCU "Software\Classes\entry" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\entry\shell\open\command" "" '"$INSTDIR\entry-desktop.exe" "%1"'

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\entry-desktop.exe"
  Delete "$INSTDIR\entry-agent-sidecar.exe"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\Entry Desktop\Entry Desktop.lnk"
  Delete "$DESKTOP\Entry Desktop.lnk"
  RMDir "$SMPROGRAMS\Entry Desktop"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Classes\entry"
SectionEnd
