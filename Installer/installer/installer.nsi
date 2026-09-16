; Google Photos Quota Reclaim - Windows installer
; Built with NSIS (makensis)

!include "MUI2.nsh"

Name "Google Photos Quota Reclaim"
OutFile "dist\GPhotoStorageSaver-Setup.exe"
InstallDir "$LOCALAPPDATA\GPhotoStorageSaver"
InstallDirRegKey HKCU "Software\GPhotoStorageSaver" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

Var StartMenuFolder

;--------------------------------
; UI

!define MUI_ABORTWARNING
!define MUI_ICON "build\stage\icon.ico"
!define MUI_UNICON "build\stage\icon.ico"

!define MUI_FINISHPAGE_RUN "$INSTDIR\Launch.bat"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Google Photos Quota Reclaim now"
!define MUI_FINISHPAGE_RUN_WORKINGDIRECTORY "$INSTDIR"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "notice.txt"
!insertmacro MUI_PAGE_DIRECTORY

!define MUI_STARTMENUPAGE_REGISTRY_ROOT "HKCU"
!define MUI_STARTMENUPAGE_REGISTRY_KEY "Software\GPhotoStorageSaver"
!define MUI_STARTMENUPAGE_REGISTRY_VALUENAME "StartMenuFolder"
!insertmacro MUI_PAGE_STARTMENU Application $StartMenuFolder

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

;--------------------------------
; Install

Section "Install" SecInstall
  SetOutPath "$INSTDIR"
  File "build\stage\Launch.bat"
  File "build\stage\README.md"
  File "build\stage\icon.ico"

  SetOutPath "$INSTDIR\source"
  File /r "build\stage\source\*.*"

  SetOutPath "$INSTDIR\adb"
  File /r "build\stage\adb\*.*"

  SetOutPath "$INSTDIR\node"
  File "build\stage\node\node.exe"

  CreateDirectory "$INSTDIR\downloads"

  WriteRegStr HKCU "Software\GPhotoStorageSaver" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Add/Remove Programs entry
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GPhotoStorageSaver" "DisplayName" "Google Photos Quota Reclaim"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GPhotoStorageSaver" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GPhotoStorageSaver" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GPhotoStorageSaver" "DisplayVersion" "1.0.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GPhotoStorageSaver" "Publisher" "GPhotoStorageSaver"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GPhotoStorageSaver" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GPhotoStorageSaver" "NoRepair" 1

  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    CreateDirectory "$SMPROGRAMS\$StartMenuFolder"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\Google Photos Quota Reclaim.lnk" "$INSTDIR\Launch.bat" "" "$INSTDIR\icon.ico" 0 SW_SHOWMINIMIZED
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  !insertmacro MUI_STARTMENU_WRITE_END

  CreateShortCut "$DESKTOP\Google Photos Quota Reclaim.lnk" "$INSTDIR\Launch.bat" "" "$INSTDIR\icon.ico" 0 SW_SHOWMINIMIZED
SectionEnd

;--------------------------------
; Uninstall
; Note: deliberately leaves $INSTDIR\downloads and $INSTDIR\source\manifest.json.bak*
; alone if present, since those hold the user's recovery data/state, not just program files.

Section "Uninstall"
  Delete "$INSTDIR\Launch.bat"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\source\node_modules"
  RMDir /r "$INSTDIR\source\api"
  RMDir /r "$INSTDIR\source\lib"
  RMDir /r "$INSTDIR\source\steps"
  Delete "$INSTDIR\source\index.html"
  Delete "$INSTDIR\source\server.mjs"
  Delete "$INSTDIR\source\package.json"
  Delete "$INSTDIR\source\package-lock.json"
  RMDir "$INSTDIR\source"
  RMDir /r "$INSTDIR\adb"
  RMDir /r "$INSTDIR\node"
  RMDir "$INSTDIR"

  !insertmacro MUI_STARTMENU_GETFOLDER Application $StartMenuFolder
  Delete "$SMPROGRAMS\$StartMenuFolder\Google Photos Quota Reclaim.lnk"
  Delete "$SMPROGRAMS\$StartMenuFolder\Uninstall.lnk"
  RMDir "$SMPROGRAMS\$StartMenuFolder"
  Delete "$DESKTOP\Google Photos Quota Reclaim.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GPhotoStorageSaver"
  DeleteRegKey HKCU "Software\GPhotoStorageSaver"
SectionEnd
