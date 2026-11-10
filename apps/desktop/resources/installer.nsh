!macro customHeader
  InstallDir "$LOCALAPPDATA\Programs\qone"
!macroend

!macro customInit
  ${if} $installMode == "CurrentUser"
    StrCpy $INSTDIR "$LocalAppData\Programs\qone"
  ${else}
    StrCpy $INSTDIR "$PROGRAMFILES\qone"
  ${endif}
!macroend

!macro customInstall
  ${GetFileName} $INSTDIR $0
  ${If} $0 == "${APP_FILENAME}"
    ${GetParent} $INSTDIR $INSTDIR
  ${EndIf}
!macroend
