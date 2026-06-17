# Apia 배포 가이드 (Windows)

데스크탑 앱을 설치 파일(`.exe`) 하나로 묶어 배포하는 방법과, 받은 사람이
설치·실행하는 방법을 정리한다.

## 산출물

| 파일 | 내용 |
| --- | --- |
| `release/Apia-Setup-<version>.exe` | NSIS 설치 파일. 사용자에게 전달하는 단일 산출물. |
| `release/win-unpacked/` | 설치 없이 바로 실행 가능한 풀어둔 빌드(스모크 검증용). |

설치 파일에 들어가는 것:

- 프론트엔드 빌드(`dist/`) + Electron 런타임
- 백엔드 실행 파일(`backend-dist/ApiaBackend.exe`) — FastAPI 서버를 PyInstaller로 단일 exe화
- Win11 "아이콘 뒤 벽지" 헬퍼(`scripts/win-wallpaper.exe`)와 네이티브 벽지 모듈

**로컬 LLM(torch/transformers 등)은 일부러 번들하지 않는다.** 패키지 백엔드는
클라우드/auto 모드(groq 무료 → 필요 시 유료 API) 전제로 가볍게(약 142MB) 유지한다.
로컬 모델 구동은 개발 환경(anaconda + CUDA)에서만 하며, 배포본 사용자는 API 키로 동작한다.

## 빌드 방법

```bash
# 전체 빌드 (백엔드 PyInstaller까지 새로 굽는다 — 백엔드 코드/의존성이 바뀌었을 때)
npm run dist:win

# 프론트/아이콘/Electron만 바뀐 경우 — 기존 backend-dist 재사용 (빠르고 디스크 절약)
npm run dist:win:nobackend
```

두 스크립트 모두 `verify:release`(필수 입력 사전점검: dist, 백엔드 exe, **build/icon.ico**,
아이콘 배선 등)를 통과해야 electron-builder로 넘어간다. 실제 패키징은
`scripts/run-release-builder.mjs`가 입력을 `C:\Users\Public\ApiaReleaseStage`로
스테이징한 뒤 수행하고(경로 길이/권한 이슈 회피), 끝나면 스테이지를 정리한다.

빌드 후 패키지 앱이 실제로 부팅되고 백엔드가 응답하는지 검증:

```bash
npm run smoke:release   # win-unpacked 실행 → 시작 마커 + /health /voices /tts /warmup /store 프로브
```

## 아이콘

앱 아이콘은 `build/icon.ico`(멀티 사이즈 16–256px). `scripts/gen-app-icon.py`로
생성한 중립 마크(둥근 사각 그라데이션 + 소문자 `a`)이며, 특정 캐릭터/IP를 쓰지 않는다.
디자인 교체 시 같은 스크립트를 고치거나 `build/icon.ico`를 직접 갈아끼우면 된다.

### 동봉 빌드 도구: `scripts/rcedit.exe`

Apia.exe에 아이콘·버전 정보를 새기는 데 쓰는 [electron/rcedit](https://github.com/electron/rcedit)
바이너리(MIT)다. electron-builder 기본 경로(`signAndEditExecutable`)는 이 PC에서
winCodeSign 추출 실패로 막히므로, repo에 직접 동봉해 `scripts/afterPack.cjs`가
호출한다(`npm ci`에도 살아남도록 transitive 의존 대신 고정). 업데이트 시
electron/rcedit 릴리스에서 새 바이너리로 교체한다.

## 설치 파일 받은 사람의 사용법

1. `Apia-Setup-<version>.exe` 실행.
2. **⚠️ "Windows의 PC 보호" 파란 경고가 뜬다** → `추가 정보` → `실행`.
   - 이 설치 파일은 **코드 서명이 안 돼 있어서** Windows SmartScreen이 경고한다.
     서명 인증서(OV/EV, 연 $200~400)를 붙이면 사라지지만, 현재는 **내부/베타 배포라
     서명 없이 나간다(수용된 리스크)**. 악성코드가 아니라 "발급자 미확인" 경고일 뿐이다.
3. 설치 경로 선택 가능(oneClick 아님) → 설치.
4. 바탕화면/시작 메뉴 바로가기 `Apia`로 실행.
5. 제거: 설정 → 앱 → Apia 제거, 또는 시작 메뉴 언인스톨러.

## 코드 서명 (향후)

SmartScreen 경고를 없애고 공개 배포 신뢰도를 올리려면 코드 서명이 필요하다.
유료 인증서 확보 후 `electron-builder.yml`의 `win.signAndEditExecutable`를 켜고
서명 설정을 추가한다. 그 전까지는 위 "추가 정보 → 실행" 안내로 대응한다.
