; Extra steps for the Kvistcode NSIS installer (bundle.windows.nsis.installerHooks).
;
; Before 0.3.0 the app was called "Armada". The installer keys its install folder and its
; uninstall entry on the product name, so without this an update installs Kvistcode next to
; the old Armada (two apps, two Start menu entries, and Armada's login item still starting
; the old version). Here the old per-user install is removed first, the way its own
; "Update" uninstall would: nothing in the data folder (dev.armada.app) is touched.

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  Push $2
  Push $3

  ; "DisplayName" must be exactly Armada, so an unrelated entry is never touched.
  ReadRegStr $0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Armada" "DisplayName"
  ReadRegStr $1 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Armada" "UninstallString"
  ReadRegStr $2 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Armada" "InstallLocation"
  ${If} $0 == "Armada"
  ${AndIf} $1 != ""
  ${AndIf} $2 != ""
    ; InstallLocation is stored quoted: "C:\...\Armada".
    StrCpy $3 $2 1
    ${If} $3 == '"'
      StrCpy $2 $2 -1 1
    ${EndIf}
    ; Never remove the folder this installer is installing into.
    ${If} $2 != "$INSTDIR"
    ${AndIf} ${FileExists} "$2\uninstall.exe"
      ClearErrors
      ; /S silent, /UPDATE keeps shortcuts, login item and app data; _?= runs it in place.
      ExecWait '$1 /S /UPDATE _?=$2' $3
      ; If it failed, leave the old install alone: both apps then stay, as before.
      ${If} ${Errors}
      ${OrIf} $3 != 0
        DetailPrint "Could not remove the old Armada install (exit code $3)"
      ${Else}
        ; Run in place, the uninstaller cannot delete itself or its folder.
        Delete "$2\uninstall.exe"
        RMDir "$2"
        ; The uninstall entry and shortcuts of the old product.
        DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Armada"
        ; Where Armada remembered its folder (publisher "Armada contributors").
        DeleteRegKey SHCTX "Software\Armada contributors\Armada"
        DeleteRegKey /ifempty SHCTX "Software\Armada contributors"
        Delete "$DESKTOP\Armada.lnk"
        Delete "$SMPROGRAMS\Armada.lnk"
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Armada"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
