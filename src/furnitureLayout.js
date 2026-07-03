/**
 * Single source of truth for furniture in the Apia 원룸(narrow galley studio).
 *
 * Phase G — laid out to match the reference image the user shared: a NARROW,
 * DEEP studio seen in one-point perspective from a foreground desk (the desk
 * itself lives in sceneRuntime as camera framing, not here). Structure:
 *   LEFT wall  : living — bookcase, bed (back), dresser, sofa + coffee table,
 *                rug, plant, floor lamp
 *   RIGHT wall : kitchen — fridge, sink, stove, counter — and the entry near
 *                the back (door, coat rack, shoe mat)
 *   BACK wall  : window (built in sceneRuntime) = the bright vanishing point
 *
 * Room is width≈5.8 (x −2.9..2.9), depth≈8 (z 0=back .. 8=front/camera side).
 * world.js reads only id/type/position/interaction/seatHeight/hidden; visual
 * fields (model/size/color/fitMode/modelRotY/yOffset) are ignored there.
 */
const deco = (o) => ({ type: 'decoration', autoBehavior: false, clickable: false, hidden: true, fitMode: 'height', modelRotY: 0, ...o })

export const FURNITURE_DEFAULT = Object.freeze([
  // ── Interactive (walk targets) ──────────────────────────────────────
  {
    id: 'bed',
    type: 'point',
    label: '침대',
    position: { x: -1.4, y: 0, z: 1.0 },
    size: { w: 2.0, h: 0.55, d: 1.1 },
    color: 0xf5f0e6,
    model: 'bedSingle.glb',
    fitMode: 'footprint',
    modelRotY: Math.PI / 2, // 옆으로 — 브로드사이드가 카메라를 향해 잘 보이게
    bubbleText: '잠깐 침대에 누워 있을게요.',
    autoBehavior: true,
    clickable: true,
    // 침대 가장자리에 앉아 쉬기(눕기 포즈는 모델 불문 어렵다 — Codex 권고대로
    // held-sit 가장자리 휴식으로 단순화). 피로(tiredness)를 회복.
    interaction: {
      sitOffset: { x: 0, y: 0.04, z: 0.2 }, // 침대 앞 가장자리 쪽
      sitRotY: 0, // 카메라 기준 상대각(0=사용자 마주봄) — yaw 규약 교정
      seatHeight: 0.42,
    },
    activity: {
      id: 'rest',
      label: '잠깐 쉬기',
      focus: 'self',
      needFill: { tiredness: 0.75 },
      steps: [
        { kind: 'sit', targetId: 'bed', durationMs: 12000, bubble: '잠깐 쉬어가자…' },
      ],
    },
  },
  {
    id: 'plant',
    type: 'point',
    label: '화분',
    position: { x: -2.4, y: 0, z: 5.4 },
    size: { w: 0.4, h: 0.62, d: 0.4 },
    color: 0xbfa07a,
    model: 'pottedPlant.glb',
    fitMode: 'height',
    modelRotY: 0,
    bubbleText: '화분이 잘 자라고 있나 볼게요.',
    autoBehavior: true,
    clickable: true,
    activity: {
      id: 'waterPlant',
      label: '화분 돌보기',
      focus: 'room',
      needFill: { care: 0.7, boredom: 0.2 },
      steps: [
        { kind: 'goto', targetId: 'plant', bubble: '화분에 물 줄까.' },
        { kind: 'pose', durationMs: 5000, bubble: '쑥쑥 자라라~' },
      ],
    },
  },
  // J단계 거주형 비서 — 앉아서 쉴 의자(거실 영역, 커피 마시기 등 활동의 좌석).
  // 소파(좌벽 x:-2.2)는 walkable 범위(minX -1.7) 밖이라 활동 좌석으로 부적합 →
  // 범위 안 빈 공간에 의자를 둔다. type:'chair'라 클릭/랜덤 앉기도 가능.
  {
    id: 'chair',
    type: 'chair',
    label: '의자',
    // 방 리워크 — 중앙 통로를 비우려 소파/커피테이블 존 쪽으로 붙임.
    position: { x: -0.95, y: 0, z: 4.45 },
    size: { w: 0.5, h: 0.78, d: 0.5 }, // 0.9는 사다리 등받이가 탑처럼 솟았음
    color: 0xa9855f,
    model: 'chair.glb',
    fitMode: 'height',
    modelRotY: 0, // 실측 교정: 앉은 방향(카메라) 기준 등받이가 뒤(창쪽)로 가는 값
    bubbleText: '잠깐 앉아 있을게요.',
    autoBehavior: true,
    clickable: true,
    interaction: {
      sitOffset: { x: 0, y: 0.04, z: -0.08 },
      sitRotY: 0, // 실측 교정: PI=창문 방향(등짐). 카메라 방향은 0.
      seatHeight: 0.4, // 의자 축소(0.9→0.78)에 비례해 좌면도 낮춤
    },
  },
  // J단계 첫 스마트 오브젝트 — 커피머신. activity 어포던스를 선언하고(심즈식),
  // 캐릭터/스케줄러가 방에 질의해 "커피 한 잔" 행동 사슬을 실행한다. autoBehavior는
  // false(랜덤 가구 픽으로 무의미하게 걸어가지 않게) — 전용 활동 슬롯/클릭으로만
  // 발동. 부엌 수납장(counter, h:0.9) 위에 올려둔다.
  {
    id: 'coffeeMachine',
    type: 'point',
    label: '커피머신',
    position: { x: 2.35, y: 0.84, z: 6.1 }, // 수납장 실측 윗면(0.837)
    size: { w: 0.3, h: 0.35, d: 0.3 },
    color: 0x4a4a4a,
    model: 'kitchenCoffeeMachine.glb',
    fitMode: 'height',
    modelRotY: -Math.PI / 2,
    bubbleText: '커피 한 잔 내려야지.',
    autoBehavior: false,
    clickable: true,
    activity: {
      id: 'brewCoffee',
      label: '커피 한 잔',
      focus: 'self', // 디렉터 focus 힌트(차분/혼자 시간)
      needFill: { comfort: 0.6, boredom: 0.35 }, // 커피 한 잔 = 안락함↑·심심함 해소
      steps: [
        { kind: 'goto', targetId: 'coffeeMachine', bubble: '커피 한 잔 내려야지.', faceCamera: false },
        { kind: 'pose', durationMs: 4000, bubble: '커피 내리는 중…' },
        { kind: 'prop', op: 'attach', propKind: 'cup', hand: 'left' }, // 왼손에 컵
        { kind: 'goto', targetId: 'chair', bubble: '여기 앉아서 마실까.' },
        // idle_sip = 왼팔을 얼굴 높이로 들어 컵을 입가로 → "홀짝이는" 모습.
        // (소품 든 팔은 팔처짐 보정에서 제외돼 어깨 lift가 살아난다 — main.js)
        { kind: 'sit', targetId: 'chair', durationMs: 9000, bubble: '한 모금… 좋다.', motion: 'idle_sip', reach: true },
        { kind: 'prop', op: 'detach' }, // 다 마심
        { kind: 'cleanup' }, // 성격 분기(부지런=싱크대로 정리 / 느긋=그냥 일어남)
      ],
    },
  },

  // J단계 거주형 비서 — "컴퓨터 너머 마주보기"(비전 핵심 연출). 카메라(=사용자)를
  // 향해 앉는 책상+의자+모니터. 앉으면 _sit가 커서 시선을 적용 → 화면 너머로
  // 사용자를 바라본다(시선 코드 불필요). 데스크는 의자 좌면(z3.3) 링 밖으로 띄워
  // 걷기 충돌을 피한다(Codex). autoBehavior:false=랜덤 앉기 제외, 활동/클릭만.
  {
    id: 'deskChair',
    type: 'chair',
    label: '책상 의자',
    // 방 리워크 — "서로의 모니터 너머 마주보기"가 핵심 컨셉이라 책상+의자를
    // **정중앙**으로. 사용자의 전경 데스크(화면 하단)와 정면으로 마주본다.
    position: { x: 0, y: 0, z: 3.25 },
    size: { w: 0.5, h: 0.78, d: 0.5 },
    color: 0x8a7a66,
    model: 'chair.glb',
    fitMode: 'height',
    modelRotY: 0, // 실측: PI는 등받이가 카메라쪽(앉은 몸 앞을 가림) — 0이 등받이=창쪽
    bubbleText: '컴퓨터 좀 할까.',
    autoBehavior: false,
    clickable: true,
    interaction: {
      sitOffset: { x: 0, y: 0.04, z: -0.08 },
      // 실측 교정: PI는 창문을 보고 앉았다(스크린샷 — 등이 카메라로). 이
      // 모델 래퍼 기준 카메라 방향은 0(뒤통수 스샷으로 확정, 주석만 믿지 말 것).
      sitRotY: 0,
      seatHeight: 0.4,
    },
    activity: {
      id: 'useComputer',
      label: '컴퓨터 너머 마주보기',
      focus: 'user', // 사용자 곁/마주봄
      needFill: { boredom: 0.5, comfort: 0.4 },
      steps: [
        { kind: 'sit', targetId: 'deskChair', durationMs: 16000, bubble: '오늘 뭐 하고 있어?' },
      ],
    },
  },
  // 책상(의자 앞, 카메라 쪽) — 모니터를 사이에 둬 "화면 너머" 구도. **정중앙**.
  // footprint를 키워 auto-fit 클램프가 높이를 뭉개지 않게(무릎 책상 수정) —
  // 렌더 높이는 실측 재확인 후 노트북 y와 동기.
  // 책상은 GLB 폐기 → 박스(table.glb는 식탁 비율이라 클램프로 0.4m 밖에 안 나옴
  // — 실측). 박스는 선언 치수(0.72 높이) 그대로 렌더되고 매끈한 단색 면이 밝은
  // 애니 인테리어 톤에도 맞는다.
  // 높이 0.68 + 노트북 낮은 프로파일 — 앉은 캐릭터의 **눈이 노트북 뚜껑 위로**
  // 보여야 마주보기가 산다(0.72+0.28 조합은 얼굴을 가렸음 — 스크린샷 검수).
  deco({ id: 'workDesk', label: '책상', position: { x: 0, y: 0, z: 4.0 }, size: { w: 1.05, h: 0.68, d: 0.55 }, color: 0xc9a678 }),
  // 노트북 — 화면이 의자(뒤쪽 -z, 캐릭터 앉는 방향)를 향하고 등판이 사용자를
  // 향한다("서로의 화면 너머" 연출). y = 박스 책상 윗면(정확히 0.68).
  deco({ id: 'monitor', label: '노트북', position: { x: 0, y: 0.68, z: 3.95 }, size: { w: 0.42, h: 0.22, d: 0.36 }, color: 0x23262b, model: 'laptop.glb', modelRotY: Math.PI }), // 실측: PI=등판이 사용자쪽·화면이 그녀쪽(0은 반대 — 스샷 확정)

  // ── LEFT wall — living ──────────────────────────────────────────────
  // 클램프로 0.4m 난쟁이가 되던 것 — d를 키우고 목표 높이를 현실화(1.25).
  deco({ id: 'bookcase', label: '책장', position: { x: -2.45, y: 0, z: 2.1 }, size: { w: 1.4, h: 1.25, d: 0.55 }, color: 0x9c7b52, model: 'bookcaseClosedWide.glb', modelRotY: Math.PI / 2,
    activity: {
      id: 'readBook', label: '책 읽기', focus: 'self',
      needFill: { boredom: 0.75, comfort: 0.2 },
      steps: [
        { kind: 'goto', targetId: 'bookcase', bubble: '뭐 읽을까~' },
        { kind: 'prop', op: 'attach', propKind: 'book', hand: 'left' },
        { kind: 'goto', targetId: 'chair', bubble: '앉아서 읽어야지.' },
        { kind: 'sit', targetId: 'chair', durationMs: 13000, bubble: '음… 재밌다.', motion: 'idle_sip', reach: true },
        { kind: 'prop', op: 'detach' },
        { kind: 'cleanup' },
      ],
    } }),
  deco({ id: 'dresser', label: '서랍장', position: { x: -2.5, y: 0, z: 3.2 }, size: { w: 0.9, h: 0.8, d: 0.5 }, color: 0xa07d55, model: 'sideTableDrawers.glb', modelRotY: Math.PI / 2 }),
  deco({ id: 'plant_small', label: '작은 화분', position: { x: -2.5, y: 0.36, z: 3.2 }, size: { w: 0.22, h: 0.32, d: 0.22 }, color: 0x7ea36a, model: 'plantSmall1.glb' }), // 서랍장 실측 윗면
  deco({ id: 'sofa', label: '소파', position: { x: -2.2, y: 0, z: 4.6 }, size: { w: 1.8, h: 0.78, d: 0.85 }, color: 0x8fae84, model: 'loungeSofa.glb', modelRotY: Math.PI / 2 }),
  deco({ id: 'coffeetable', label: '커피 테이블', position: { x: -1.2, y: 0, z: 4.7 }, size: { w: 0.85, h: 0.35, d: 0.55 }, color: 0xa9855f, model: 'tableCoffee.glb' }),
  // ── 생활 소품(소품 밀도 패스) — "사람이 사는 흔적". 전부 데코(걷기/클릭 무관).
  // y는 선언 높이가 아니라 **실측 가구 윗면**(tmp-bbox-probe): auto-fit footprint
  // 클램프 때문에 실제 렌더 높이가 선언 size.h보다 낮다(커피테이블 0.28, 책장
  // 0.40, 수납장 0.68). 책은 살짝 비스듬히(정렬된 방은 모델하우스처럼 죽는다).
  deco({ id: 'coffeetable_books', label: '읽던 책', position: { x: -1.05, y: 0.3, z: 4.62 }, size: { w: 0.3, h: 0.11, d: 0.24 }, color: 0xb08a5a, model: 'books.glb', modelRotY: 0.5 }),
  deco({ id: 'bookcase_books', label: '책 무더기', position: { x: -2.45, y: 0.545, z: 2.2 }, size: { w: 0.3, h: 0.14, d: 0.24 }, color: 0x9a7048, model: 'books.glb', modelRotY: Math.PI / 2 - 0.3 }),
  deco({ id: 'counter_plant', label: '허브 화분', position: { x: 2.5, y: 0.84, z: 6.3 }, size: { w: 0.2, h: 0.26, d: 0.2 }, color: 0x7ea36a, model: 'plantSmall1.glb', modelRotY: 1.1 }),
  deco({ id: 'rug', label: '러그', position: { x: -1.1, y: 0.012, z: 4.7 }, size: { w: 2.2, h: 0.0, d: 2.0 }, color: 0xd0a896, model: 'rugRounded.glb', fitMode: 'footprint' }),
  deco({ id: 'floorlamp', label: '플로어 램프', position: { x: -2.5, y: 0, z: 6.4 }, size: { w: 0.45, h: 1.5, d: 0.45 }, color: 0xd8c7a8, model: 'lampRoundFloor.glb' }),

  // ── RIGHT wall — kitchen + entry ────────────────────────────────────
  deco({ id: 'door', label: '현관문', position: { x: 2.75, y: 0, z: 1.2 }, size: { w: 0.3, h: 2.1, d: 1.2 }, color: 0x6f5638, model: 'doorwayFront.glb', modelRotY: -Math.PI / 2,
    activity: {
      id: 'bathroom', label: '화장실', focus: 'self',
      needFill: { hygiene: 0.9 },
      steps: [
        { kind: 'goto', targetId: 'door', bubble: '화장실 잠깐 다녀올게.' },
        { kind: 'pose', durationMs: 3000, bubble: '…' },
      ],
    } }),
  deco({ id: 'coatrack', label: '코트걸이', position: { x: 2.5, y: 0, z: 0.9 }, size: { w: 0.5, h: 1.7, d: 0.5 }, color: 0x8a7048, model: 'coatRackStanding.glb' }),
  deco({ id: 'doormat', label: '신발 두는 곳', position: { x: 2.1, y: 0.012, z: 1.7 }, size: { w: 0.8, h: 0.0, d: 0.6 }, color: 0x9a8a78, model: 'rugDoormat.glb', fitMode: 'footprint' }),
  deco({ id: 'fridge', label: '냉장고', position: { x: 2.55, y: 0, z: 2.7 }, size: { w: 0.9, h: 1.8, d: 0.8 }, color: 0xe9eaec, model: 'kitchenFridge.glb', modelRotY: -Math.PI / 2 }),
  deco({ id: 'sink', label: '싱크대', position: { x: 2.5, y: 0, z: 3.9 }, size: { w: 1.0, h: 0.9, d: 0.8 }, color: 0xd8d2c4, model: 'kitchenSink.glb', modelRotY: -Math.PI / 2,
    activity: {
      id: 'drinkWater', label: '물 한 잔', focus: 'self',
      needFill: { thirst: 0.85 },
      steps: [
        { kind: 'goto', targetId: 'sink', bubble: '물 좀 마셔야지.' },
        { kind: 'prop', op: 'attach', propKind: 'glass', hand: 'left' },
        { kind: 'pose', durationMs: 3500, bubble: '꿀꺽꿀꺽…', motion: 'idle_sip', reach: true },
        { kind: 'prop', op: 'detach' },
      ],
    } }),
  deco({ id: 'stove', label: '가스레인지', position: { x: 2.5, y: 0, z: 5.0 }, size: { w: 0.9, h: 0.9, d: 0.8 }, color: 0xcfcabe, model: 'kitchenStove.glb', modelRotY: -Math.PI / 2 }),
  deco({ id: 'counter', label: '주방 수납장', position: { x: 2.5, y: 0, z: 6.1 }, size: { w: 0.9, h: 0.9, d: 0.8 }, color: 0xb89a72, model: 'kitchenCabinet.glb', modelRotY: -Math.PI / 2 }),
])
