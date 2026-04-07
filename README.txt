1) 아래 패키지가 필요합니다.
   npm install extract-zip

2) 파일 배치
   - electron/main.js -> 이 폴더의 electron/main.js로 교체
   - electron/preload.js -> 이 폴더의 electron/preload.js로 교체
   - electron/services/registryService.js 추가
   - electron/services/characterImportService.js 추가
   - electron/ipc/registerCharacterIpc.js 추가

3) 개발 중 캐릭터 저장 위치
   process.cwd()/src/assets/characters

4) 배포 후 캐릭터 저장 위치
   app.getPath('userData')/characters

5) 렌더러에서 호출 예시
   const result = await window.api.pickZipAndImport()
   또는
   const result = await window.api.importCharacterZip({
     zipPath: 'C:/path/model.zip',
     displayName: '마리',
     customName: '우리집 마리',
     summary: '차분한 아이돌풍 캐릭터',
     description: '원본 설명이나 사용자 설명'
   })
