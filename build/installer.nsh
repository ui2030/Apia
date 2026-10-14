; 제거 후 남던 것 정리(발주서28 D7). %APPDATA%\apia(대화·캐릭터)는 문서대로 남긴다.
; 업데이트 중 제거(isUpdated)는 건너뛴다 — 새 설치 파일을 지우면 안 된다.
!macro customUnInstallSection
  Section "-un.apiaCleanup"
    ${ifNot} ${isUpdated}
      ; 업데이트용 설치 파일 사본(~150MB). 나만 사용 설치일 때만 — 모든 사용자 설치에서
      ; $LOCALAPPDATA는 지우는 사람 것이라 남의 폴더일 수 있다.
      ${if} $installMode == "CurrentUser"
      ${andIf} ${FileExists} "$LOCALAPPDATA\apia-updater\installer.exe"
        RMDir /r "$LOCALAPPDATA\apia-updater"
      ${endIf}
      ; 비어 있을 때만 지운다(/r 없음).
      RMDir "$INSTDIR"
    ${endIf}
  SectionEnd
!macroend
