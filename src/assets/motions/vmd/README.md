# VMD motion clips (MMD)

MMD 캐릭터용 `.vmd` 모션 클립 드롭 위치. VRMA 매니페스트(`../manifest.json`)와
같은 motion-name 키를 mirror해서, 같은 motion name(예: `idle_breath_soft`)에 대해
모델 타입에 따라 자동 선택된다 — 활성 모델이 VRM이면 VRMA 클립이, MMD이면 VMD
클립이 픽업된다.

> **상태**: 런타임 와이어링 완료. `manifest.json`에 매핑된 경로에 `.vmd` 파일을
> 드롭하면 **다음 build/dev 재시작부터** 자동 픽업된다 (Vite `import.meta.glob` —
> 빌드 타임에 URL이 emit된다. 패키지된 앱은 런타임 파일시스템을 스캔하지 않음).
> 매니페스트에는 있지만 파일이 없는 키는 `resolveMmdMotionAsset`이 null을 반환해서
> 정적 pose로 유지된다 (에러 안 남).

## 서브폴더
- `idle/` — 자연스러운 루프 (호흡, 무게 이동, 둘러보기)
- `talk/` — 대화 중 레이어드 모션
- `react/` — 1회성 리액션 (끄덕임, 놀람, 수줍음)
- `emote/` — 향후 이모트 트리거 예약

## 클립 추가
**Step 5 of /goal 이후**: manifest.json 안 만져도 됨. `idle/foo.vmd` 드롭만 하면
`motionAssets.js`가 *filename → motion key* (`idle_foo`)로 자동 등록한다.

1. 적절한 서브폴더에 `.vmd` 파일을 드롭.
2. **dev 서버 재시작 / `npm run build`** — `.vmd`는 Vite의 `import.meta.glob`로
   빌드 타임에 hashed URL로 변환된다. 패키지된 런타임에서 파일시스템을 직접 스캔하지
   않는다. 클립을 드롭하고도 안 보이면 build 다시 돌렸는지부터 확인.
3. (선택) loop/fadeIn 메타데이터를 미세조정하고 싶으면 [`manifest.json`](./manifest.json)에
   엔트리 추가 — 매니페스트가 있으면 그게 자동 등록값보다 우선.
   ```json
   "motion_name": {
     "path": "idle/my_clip.vmd",
     "loop": true,
     "fadeIn": 0.5
   }
   ```

## 현재 들어 있는 모션 (idle/)
[Deedee524 Idle Animation Pack](https://www.deviantart.com/deedee524/art/Idle-Animation-Pack-759426476)
— 게임 사용 OK, 크레딧 필수, 원본 재배포 X. 라이센스 전문은
[`idle/LICENSE-deedee524.txt`](./idle/LICENSE-deedee524.txt) 참조. 10개 클립:

- `idle_confident` — 팔짱 + 좌우 둘러보기
- `idle_air_scent` — 공기 냄새 맡기
- `idle_fix_hair` — 머리 매만지기
- `idle_skywatch` — 하늘 올려다보기
- `idle_stretch` — 스트레칭
- `idle_sway` — 팔/허리 좌우 흔들기
- `idle_tidy` — 옷 털기
- `idle_tracker` — 주변 살피기
- `idle_impatient` — 발 동동
- `idle_mermay` — 꼬리 모션 (인어 캐릭터용; 키사키 꼬리 본에도 자동 매핑)

`.vmd` 바이너리는 `.gitignore`로 git에서 제외 (원본 재배포 금지 준수). 사용자가
[원본 페이지](https://www.deviantart.com/deedee524/art/Idle-Animation-Pack-759426476)에서
받아 본 폴더에 드롭 → auto-register가 픽업.

## 런타임 흐름
- `src/motionAssets.js` `resolveMmdMotionAsset(name)` → `{ url, loop, fadeIn } | null`
- `src/main.js` `playMotion(motion)`이 `currentModel.type === 'mmd'`면 VMD 경로로 라우팅
- 재생: `playMMDAnimation(url, { loop })` → `MMDLoader.loadAnimation` → `MMDAnimationHelper.add(mesh, { animation: clip, physics: false })`
- non-loop: 내부 mixer에 `LoopOnce` + `clampWhenFinished` — 마지막 프레임에서 멈춤

## VRMA와의 관계
이름 키는 VRMA 매니페스트(`../manifest.json`)와 일대일 mirror. 같은 `motion_name`이
양쪽에 존재하면, 활성 모델 타입에 따라 적절한 쪽이 자동으로 선택된다. 빈 손에 클립만
들고 와서 드롭해도 됨.

## 누락된 클립
어느 한쪽이 비어 있어도 동작은 안전:
- VRM 측: 매 프레임 도는 `updateVRMBody` 절차적 layer가 캐릭터를 움직인다.
- MMD 측: 정적 pose 유지 + 모프 기반 lipsync는 그대로 작동. helper가 animation 없는
  mesh를 update해도 무해.

## fadeIn 필드
VRMA에서는 cross-fade duration으로 쓰이고, VMD에서는 현재 metadata로만 보관 중
(`MMDAnimationHelper`가 fade API를 직접 노출하지 않음). 향후 mixer 레벨에서 직접
fade가 필요해지면 동일 값을 활용할 수 있도록 매니페스트에 유지.
