# Apia — 에이전트 작업 규칙

데스크톱에서 3D 캐릭터가 생활하는 Electron 앱. 상세 맥락은 아래 문서 순서로 읽는다.

## 먼저 읽기

1. [AGENT_WORKING_SET.md](AGENT_WORKING_SET.md) — 런타임 파일 지도 + 검증 명령
2. [REGRESSION_NOTES.md](REGRESSION_NOTES.md) — 회귀 이력과 예방 규칙 (패키징/시작/로더 만지기 전 필수)

## 철칙

- **E2E/GUI 하네스는 dist를 로드한다** — `src/` 수정 후 `npm run build` 없이 하네스를 돌리면 옛 코드를 검증하게 됨
- 검증 게이트: `npm run verify` (빌드+구문검사+vitest). backend 수정 시 `backend/.venv/Scripts/python.exe -m pytest backend`
- GUI 검증용으로 띄운 electron/백엔드는 검증 즉시 종료하고, 턴 종료 전 잔류 프로세스 확인
- 방/가구 상호작용 튜닝 시 `WORLD_VERSION` 범프 필수 (localStorage 캐시가 옛 배치를 되살림)
- 방향·좌표는 주석을 믿지 말고 실측으로 확인

## 커밋 (public repo)

- 이번 작업 파일만 명시 스테이징 — `git add -A` 금지. `435t2.txt`, `backend/apia.db*`는 커밋 금지
- 커밋 전 스테이징 diff에서 캐릭터/작품 고유명사 검사 — 발견 시 일반 용어("캐릭터", "모델")로 교체
- 문체: 한국어 한 줄 제목 + 짧은 불릿 4~6, 장식 문구·트레일러 없음

## 코드 스타일

- 문제를 푸는 최소한의 코드 — 예비용 추상화·미래 대비 스캐폴딩 금지
- 특정 모델 전용 가정 금지 — 모델은 교체 가능 전제(어댑터/프로필로 흡수)
- 주석은 코드가 못 보여주는 제약만 (검증 이력·리뷰 대화는 주석에 남기지 않음)
