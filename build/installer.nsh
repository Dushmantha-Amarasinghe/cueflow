; Custom NSIS hooks for the Cueflow installer.
;
; Ensure the app always installs into its own "Cueflow" subfolder, even when
; the user browses to a custom location (e.g. D:\Installed Softwares). Without
; this, NSIS uses the chosen folder verbatim and spills files loose into it.
;
; Uses only core commands (StrCmp / StrCpy / StrLen) so it doesn't depend on
; LogicLib being included at this point in the build.

Function .onVerifyInstDir
  Push $0
  Push $1
  StrLen $0 "Cueflow"
  StrCpy $1 "$INSTDIR" "" -$0       ; last 7 characters of $INSTDIR
  StrCmp $1 "Cueflow" done          ; already ends with Cueflow → leave as-is
    StrCpy $INSTDIR "$INSTDIR\Cueflow"
  done:
  Pop $1
  Pop $0
FunctionEnd
