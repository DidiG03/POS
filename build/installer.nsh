; Custom NSIS hooks for electron-builder.
; This runs during install/uninstall.
;
; Goal:
; - Set user-level environment variables so the POS works "out of the box"
;   without the user manually adding them.
;
; Variables set (HKCU\Environment):
; - ENABLE_ADMIN=true
; - POS_CLOUD_URL=https://pos-api-1075917751068.europe-west1.run.app

!macro customInstall
  ; ENABLE_ADMIN
  ReadRegStr $0 HKCU "Environment" "ENABLE_ADMIN"
  StrCmp $0 "" 0 +2
    WriteRegStr HKCU "Environment" "ENABLE_ADMIN" "true"

  ; POS_CLOUD_URL
  ReadRegStr $1 HKCU "Environment" "POS_CLOUD_URL"
  StrCmp $1 "" 0 +2
    WriteRegStr HKCU "Environment" "POS_CLOUD_URL" "https://pos-api-1075917751068.europe-west1.run.app"

  ; Broadcast environment change (so new processes can see it immediately).
  ; HWND_BROADCAST = 0xFFFF, WM_SETTINGCHANGE = 0x001A
  System::Call 'user32::SendMessageTimeoutA(i 0xffff, i 0x001A, i 0, t "Environment", i 0, i 5000, *i .r2)'
!macroend

!macro customUnInstall
  ; Remove only if values match what we set (avoid deleting user custom values).
  ReadRegStr $0 HKCU "Environment" "ENABLE_ADMIN"
  StrCmp $0 "true" 0 +2
    DeleteRegValue HKCU "Environment" "ENABLE_ADMIN"

  ReadRegStr $1 HKCU "Environment" "POS_CLOUD_URL"
  StrCmp $1 "https://pos-api-1075917751068.europe-west1.run.app" 0 +2
    DeleteRegValue HKCU "Environment" "POS_CLOUD_URL"

  System::Call 'user32::SendMessageTimeoutA(i 0xffff, i 0x001A, i 0, t "Environment", i 0, i 5000, *i .r2)'
!macroend

