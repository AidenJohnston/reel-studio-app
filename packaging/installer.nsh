; Included by electron-builder's NSIS scripts (electron-builder.yml nsis.include).
;
; Puts Reel Studio in Explorer's "Open with" list for videos, and nothing more. electron-builder's own
; fileAssociations use APP_ASSOCIATE, which also overwrites HKCU\Software\Classes\.<ext> (the per-user default app)
; and never restores it on uninstall: on a Windows 11 test machine it replaced PotPlayer's entry for all seven types
; and left a dangling default after uninstalling. So only OpenWithProgids and our own class are written here.
!define RS_PROGID "ReelStudio.Video"

!macro rsOpenWith EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${RS_PROGID}" ""
!macroend
!macro rsOpenWithRemove EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${RS_PROGID}"
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\${RS_PROGID}" "" "Video"
  WriteRegStr SHCTX "Software\Classes\${RS_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHCTX "Software\Classes\${RS_PROGID}\shell\open" "" "Open with Reel Studio"
  WriteRegStr SHCTX "Software\Classes\${RS_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  ; the same extensions as mac.fileAssociations in electron-builder.yml
  !insertmacro rsOpenWith "mp4"
  !insertmacro rsOpenWith "mov"
  !insertmacro rsOpenWith "m4v"
  !insertmacro rsOpenWith "mkv"
  !insertmacro rsOpenWith "webm"
  !insertmacro rsOpenWith "avi"
  !insertmacro rsOpenWith "mts"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro rsOpenWithRemove "mp4"
  !insertmacro rsOpenWithRemove "mov"
  !insertmacro rsOpenWithRemove "m4v"
  !insertmacro rsOpenWithRemove "mkv"
  !insertmacro rsOpenWithRemove "webm"
  !insertmacro rsOpenWithRemove "avi"
  !insertmacro rsOpenWithRemove "mts"
  DeleteRegKey SHCTX "Software\Classes\${RS_PROGID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
