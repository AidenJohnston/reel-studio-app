; Included by electron-builder's NSIS scripts (electron-builder.yml nsis.include).
;
; Every install also copies the installer to %LOCALAPPDATA%\<name>-updater\installer.exe, for electron-updater's
; differential downloads (app-builder-lib templates/nsis/include/installer.nsh, APP_INSTALLER_STORE_FILE), and the
; stock uninstaller never removes it: about 200-300 MB stayed behind after uninstalling 0.1.2 on Windows 11.
; Removed on a real uninstall only. An update runs the old uninstaller with --updated, and the new installer
; writes its own copy afterwards.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    !ifdef APP_INSTALLER_STORE_FILE
      Push $R0
      Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R0
      RMDir /r "$R0\pending"
      ; not recursive: the folder goes only when nothing else is in it
      RMDir "$R0"
      Pop $R0
    !endif
  ${endIf}
!macroend
