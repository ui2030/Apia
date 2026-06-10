# Mixamo FBX motion clips

이 폴더는 Mixamo 같은 곳에서 받은 `.fbx` 모션 클립을 드롭하는 곳이에요.
`animationRuntime.playFBXAnimation`이 자동으로 본 이름을 VRM에 맞게
재매핑하고(`mixamorig:LeftArm` → 모델의 `leftUpperArm` 본), Mixamo의
센티미터 단위 hips 이동을 미터로 환산해 줍니다.

## 사용법
1. [Mixamo](https://www.mixamo.com/)에 Adobe 계정으로 로그인 (무료)
2. `walk` / `idle` / `sit` 등 원하는 클립을 골라 **FBX Binary, Skin: With Skin, 30 fps**
3. 다운로드한 `.fbx`를 `idle/`, `talk/`, `react/`, `emote/` 하위 폴더에 드롭
4. [`manifest.json`](./manifest.json)에 매핑 추가:
   ```json
   "idle_neutral": { "path": "idle/my_walk.fbx", "loop": true, "fadeIn": 0.4 }
   ```
   `idle_neutral` 키는 `src/motionManager.js`의 모션 이름과 같아야 자동 픽업됩니다.

## 라이센스 (중요)
- Mixamo asset은 [Adobe 약관](https://www.mixamo.com/faq) 상 **개인·상업 사용 자유**지만
  **재배포는 회색지대**입니다.
- 이 폴더의 `*.fbx`는 `.gitignore`로 git에 안 묻히게 했지만
  **vite `import.meta.glob`이 빌드 시 dist/에 포함**시킵니다.
  즉 사용자가 `npm run dist:win`으로 패키지를 만든 뒤 그 패키지를
  **다른 사람에게 공유하면 라이센스 위반 가능성**이 있습니다.
- 본인 컴퓨터에서 본인 라이센스로만 사용하면 안전합니다.
- **다음 패스 (TODO)**: 사용자 .fbx를 user-data 경로(`%APPDATA%/apia/motions/fbx/`)에
  두고 런타임에 IPC + custom file protocol로 fetch하는 흐름으로 완전 분리할 예정입니다.
  그 패스가 들어가기 전까지 이 폴더는 *dev/test 용도*로만 봐주세요.

## 알려진 한계 (정밀화 후속 패스)
- VRM 모델이 A-pose, Mixamo 클립이 T-pose라 어깨 각도가 살짝 어색할 수 있어요.
- Hand·finger 본은 retarget에서 빠짐 (Mixamo 손가락은 30+ 본).
- MMD/PMX 모델은 이 폴더의 `.fbx`를 자동으로 못 씁니다 (본 구조가 달라요).
  PMX용 모션은 [`src/assets/motions/vmd/`](../vmd/README.md)를 참고하세요.
