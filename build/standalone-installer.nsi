; Independent of the upstream process-name kill / legacy uninstaller flow.
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define APP_EXECUTABLE_FILENAME "PaneFlow Desktop.exe"
Name "PaneFlow Desktop"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\PaneFlow Desktop"
InstallDirRegKey HKCU "Software\PaneFlow" "InstallLocation"
ShowInstDetails show
ShowUninstDetails show
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro addLangs
!macro AcquireInstallerLock
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\PaneFlow-Installer-6d314639") p .r0 ?e'
  Pop $1
  ${If} $0 == 0
  ${OrIf} $1 == 183
    SetErrorLevel 2
    Abort "Another PaneFlow installer or uninstaller is active. Retry after it finishes."
  ${EndIf}
  ; Keep the handle open until this process exits.
!macroend
Function .onInit
  !insertmacro AcquireInstallerLock
  SetShellVarContext current
  SetRegView 64
  !insertmacro customInit
FunctionEnd
Section "Install"
  !insertmacro customInit
  !insertmacro customCheckAppRunning
  SetOutPath "$INSTDIR"
  SetOverwrite on
  ClearErrors
  File /r "${PANEFLOW_APP_DIR}\*.*"
  ${If} ${Errors}
    SetErrorLevel 2
    Abort "Program files could not be replaced. Installation failed; use the saved recovery materials."
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall PaneFlow Desktop.exe"
  ${If} ${Errors}
    SetErrorLevel 2
    Abort "The uninstaller could not be written. Installation failed."
  ${EndIf}
  WriteRegStr HKCU "Software\PaneFlow" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaneFlow" "DisplayName" "PaneFlow Desktop"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaneFlow" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaneFlow" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaneFlow" "UninstallString" '$\"$INSTDIR\Uninstall PaneFlow Desktop.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaneFlow" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaneFlow" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\PaneFlow"
  CreateShortcut "$SMPROGRAMS\PaneFlow\PaneFlow Desktop.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
SectionEnd
Function un.onInit
  !insertmacro AcquireInstallerLock
  SetShellVarContext current
  SetRegView 64
FunctionEnd
Section "Uninstall"
  !insertmacro customUnInstall
  !insertmacro customCheckAppRunning
  ; Only package-owned files are eligible; unknown user files and external data remain.
  !include "${PANEFLOW_OWNED_FILES}"
  Delete "$INSTDIR\Uninstall PaneFlow Desktop.exe"
  RMDir "$INSTDIR"
  ReadRegStr $R7 HKCU "Software\PaneFlow" "InstallLocation"
  ${If} $R7 == $INSTDIR
    DeleteRegKey HKCU "Software\PaneFlow"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaneFlow"
    Delete "$SMPROGRAMS\PaneFlow\PaneFlow Desktop.lnk"
    RMDir "$SMPROGRAMS\PaneFlow"
  ${EndIf}
SectionEnd
