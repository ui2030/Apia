# 시각 QA 가이드 (E단계 — 상시 검증 러너)

모션·물리 코드를 건드렸으면 **항상** 이걸 돌린다:

```
npm run qa:visual
```

빌드 → 단위 테스트 → 시각 검증 3종을 순서대로 실행하고 마지막에 요약표를
출력한다. 하나라도 실패하면 exit 1. 병렬 실행 금지 — 한 GPU에 Electron
인스턴스를 여러 개 띄우면 프레임이 밀려 플레이크가 난다.

## 왜 빌드가 항상 첫 스텝인가 (dist 함정)

E2E는 `dist/` 번들을 로드한다. `src/`만 고치고 빌드를 안 하면 **옛 코드를
검증하고 통과 도장을 찍는** 함정에 빠진다. 실제로 당한 적 있는 함정이라
러너가 무조건 빌드부터 한다. 러너 밖에서 개별 체크를 돌릴 때도 `npm run
build` 먼저.

## 스텝별 단언과 통과 기준

| 스텝 | 단언 | 통과 기준 |
|---|---|---|
| build | vite 빌드 성공 | exit 0 |
| vitest | 단위 테스트 전체 | 전부 통과 |
| transition-check | ① 걷기 시작 ~1.5s 안에 VMD 클립 해제 ② 걷는 동안 다리 본 진동(legRange > 0.05) ③ 도착 후 치마 낙하량 ≥ idle 기준의 70% ④ 다음 클립 재생 시 mixer 재부착 + 치마 정상 | `TRANSITION CHECK PASSED` |
| tail-check | ① ★Up_しっぽ 모프 적용(しっぽ支 로컬 Y > 0) ② 꼬리 끝(しっぽ12) 월드 Y > 0.02(바닥 위) ③ 꼬리 중간(しっぽ7) 월드 Y > 0.3 | `TAIL CHECK PASSED` |
| vmd-check | 9개 idle 모션 × 3각도(정면/측면/후면) 스크린샷 + 휴식 자세. 렌더러 콘솔에 `[error]` 한 줄이라도 있으면 실패. `[VMD diag]` 라인은 정보용으로만 출력 | `VMD CHECK PASSED` |

skirt-walk-check.mjs는 단언이 없는 **진단 전용**(치마 출렁임 샘플링,
`APIA_SKIRT_NOCLIP=1` 귀속 모드)이라 러너에서 제외. 치마 이슈를 팔 때만
수동으로 돌린다.

## 스크린샷 — 눈으로 볼 것

자동 단언이 못 잡는 시각 품질은 사람이 본다. 러너가 끝에 폴더 목록을
출력하니 아래 기준으로 훑는다:

- `test-results/vmd-check/` (모션×3각도 + rest): **팔이 등 뒤로 꺾이면
  안 됨**(특히 측면·후면), 옷 뚫림·치마 텐트/판자 없음, 치마는 무릎 길이
- `test-results/tail-check/` (side/back): **꼬리가 바닥 위에 떠 있어야 함**,
  끌리거나 관통하면 실패
- `test-results/transition-check/`: 걷기 전후·재생 직후 치마가 말려 올라가지
  않았는지

## 측정 모드 (단언 끄고 기준값 채집)

- `APIA_TAIL_MEASURE=1 node tests/gui/tail-check.mjs` — 꼬리 측정값만 출력
- `APIA_SKIRT_NOCLIP=1 node tests/gui/skirt-walk-check.mjs` — 치마 귀속 모드

## 구현 메모

- 러너는 npm/npx를 거치지 않고 `node`로 vite/vitest 실행 파일을 직접
  호출한다. Windows에서 `.cmd`를 셸 없이 spawn하면 Node 18.20+에서
  EINVAL이고, `shell:true`는 따옴표 함정이 있어서다.
  **제약**: package.json의 `build`/`test` 스크립트에 vite/vitest 이외의
  로직이 추가되면 러너는 그걸 우회한다 — 그때는 run-visual-qa.mjs의
  steps 정의도 같이 고칠 것.
- 모든 스텝은 cwd=프로젝트 루트, 스텝별 타임아웃이 있고 초과 시 Windows는
  `taskkill /t /f`로 Electron 자식까지 트리째 종료한다.
