; Portable instances may contain irreplaceable identity data next to the executable.
; Refuse these destinations rather than silently moving or deleting that data.
; Override upstream process-name termination: other installed instances may be active.
!macro customCheckAppRunning
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ClearErrors
    FileOpen $R8 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "The target PaneFlow executable is in use or cannot be written. Close this installation and retry. Other PaneFlow instances have not been stopped." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    FileClose $R8
  ${EndIf}
!macroend

Function .onVerifyInstDir
  IfFileExists "$INSTDIR\data\*.*" 0 safe_directory
    Abort
  safe_directory:
FunctionEnd

!macro customInit
  IfFileExists "$INSTDIR\data\*.*" 0 safe_initial_directory
    MessageBox MB_OK|MB_ICONSTOP "This directory contains portable PaneFlow data. Choose a new installation directory. The existing identity and configuration have not been changed." /SD IDOK
    Abort
  safe_initial_directory:
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\data\*.*" 0 safe_uninstall_directory
    MessageBox MB_OK|MB_ICONSTOP "PaneFlow data exists inside this installation directory. Uninstall/update has stopped to preserve it. Back up and explicitly migrate this data before retrying." /SD IDOK
    Abort
  safe_uninstall_directory:
!macroend
