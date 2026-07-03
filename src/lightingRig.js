// src/lightingRig.js — 시간대 라이팅 리그 (조명 패스, 쇼츠 격차 #1).
//
// 목표: "장난감 방 → 분위기 있는 방". 참조 쇼츠의 본체는 창으로 들어오는
// 방향성 빛(노을이면 낮은 고도의 주황 키라이트 + 긴 그림자)과 낮은 앰비언트
// 대비다. 여기에 하루리듬(아침/낮/노을/밤)을 실시간으로 태워 "같은 방이
// 시간 따라 다른 표정"이 되게 한다 — 캐릭터 하루리듬(크로노타입)과 함께
// 거주감을 만드는 시그니처.
//
// 구조(Codex 사전검토 반영):
//  - computeLighting(hour): **순수 함수** — three/document 의존 없음(색은
//    [r,g,b] 0..1 배열). node 단위테스트 가능. 앵커 4개(6/12/18/22h)를
//    24h 랩어라운드 smoothstep 보간.
//  - createLightingRig(handles): 씬의 명명된 라이트/창 재질을 쥐고
//    setHour(타깃 상태 계산) + tick(dt)(지수 lerp로 부드럽게 수렴 —
//    시간 경계에서 팝 없음)을 제공. 하늘 캔버스는 상태가 유의미하게
//    변할 때만(>1%/500ms 스로틀) 다시 그린다.
//
// 캐릭터 가독성 바닥: 밤에도 amb+key+데스크램프 합이 실루엣을 읽을 수준을
// 유지(스크린샷 검수로 튜닝). 그림자 해상도(1024)는 변경 없음 — 성능 동일.

// ── 색 유틸(순수 — three.Color 미사용) ─────────────────────────────
function hexToRgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]
}
function lerp(a, b, t) { return a + (b - a) * t }
function lerpRgb(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)] }
function lerpVec(a, b, t) { return a.map((v, i) => lerp(v, b[i], t)) }
function smoothstep(t) { return t * t * (3 - 2 * t) }

// ── 시간대 앵커 ──────────────────────────────────────────────────────
// 좌표계: 창은 뒷벽(z=0, x중앙, y1.7)에 있고 방은 z+로 깊다(카메라 z+측).
// key.pos는 "창 너머 태양 위치"(z 음수=창 밖), keyTarget은 방 안 조사점.
// 고도가 낮을수록(노을) 빛이 방 깊숙이 들어와 긴 그림자가 생긴다.
// rim은 창측 상단에서 캐릭터 활동 영역(0,1.2,3.2)을 향해 — 역광 윤곽.
const ANCHORS = [
  // 창 유리 주의: 하늘 텍스처가 map(×paneColor)과 emissiveMap(×emissiveIntensity)
  // 둘 다에 물려 **이중 가산** — emissive를 1.0 위로 올리면 ACES에서 하늘이
  // 희멀겋게 날아간다(1차 튜닝 실측). 채도는 텍스처 색으로 내고 emissive는
  // 0.6~0.95 범위에서 "은은한 발광"만 담당.
  { // 아침 6시 — 부드러운 금빛, 낮은 고도(동틀녘), 산뜻한 하늘
    hour: 6,
    ambient: { color: hexToRgb(0xf2e4d4), intensity: 0.30 },
    key: { color: hexToRgb(0xffe3b8), intensity: 0.72, pos: [-2.4, 2.6, -1.6] },
    keyTarget: [0.3, 0.9, 3.6],
    rim: { color: hexToRgb(0xffe8c8), intensity: 0.22, pos: [1.2, 2.8, -0.8] },
    fill: { intensity: 0.10 },
    deskGlow: { intensity: 0.18 },
    sky: { top: hexToRgb(0x6faede), mid: hexToRgb(0xffd292), horizon: hexToRgb(0xd9a86e), sunY: 0.66, sunAlpha: 1.0, sunSize: 0.11 },
    pane: { emissiveIntensity: 0.72, color: hexToRgb(0xe8f2ff) },
  },
  { // 낮 12시 — 밝고 뉴트럴, 높은 고도(짧은 그림자), 파란 하늘
    // 방 리워크: 낮을 한 단계 더 밝고 깨끗하게(밝은 애니 인테리어 무드).
    hour: 12,
    ambient: { color: hexToRgb(0xfff5ea), intensity: 0.47 },
    key: { color: hexToRgb(0xfffdf2), intensity: 0.82, pos: [-1.4, 5.4, 0.4] },
    keyTarget: [0, 1.0, 3.0],
    rim: { color: hexToRgb(0xeaf2ff), intensity: 0.12, pos: [1.5, 3.2, -0.6] },
    fill: { intensity: 0.10 },
    deskGlow: { intensity: 0.12 },
    sky: { top: hexToRgb(0x4f9ade), mid: hexToRgb(0xa6d0f0), horizon: hexToRgb(0xd6ecc8), sunY: 0.20, sunAlpha: 0.9, sunSize: 0.07 },
    pane: { emissiveIntensity: 0.78, color: hexToRgb(0xe0f0ff) },
  },
  { // 노을 18시 — 쇼츠의 기준 컷. 낮은 고도 주황 키 + 림 최대 + 앰비언트 다운
    hour: 18,
    ambient: { color: hexToRgb(0xffd9bc), intensity: 0.26 },
    key: { color: hexToRgb(0xffa155), intensity: 1.0, pos: [-2.2, 1.7, -1.4] },
    keyTarget: [0.4, 0.85, 4.4],
    rim: { color: hexToRgb(0xffb47e), intensity: 0.34, pos: [1.0, 2.4, -0.8] },
    fill: { intensity: 0.11 },
    deskGlow: { intensity: 0.42 },
    sky: { top: hexToRgb(0x7fa8d8), mid: hexToRgb(0xffab5e), horizon: hexToRgb(0xd87838), sunY: 0.60, sunAlpha: 1.0, sunSize: 0.14 },
    pane: { emissiveIntensity: 0.95, color: hexToRgb(0xffeedd) },
  },
  { // 밤 22시 — 차가운 달빛+채도 있는 남색 앰비언트, 방의 주인공은 데스크 램프
    hour: 22,
    ambient: { color: hexToRgb(0x415a9e), intensity: 0.21 },
    key: { color: hexToRgb(0x9fb4e0), intensity: 0.22, pos: [1.8, 4.2, -1.2] },
    keyTarget: [0, 1.0, 3.4],
    rim: { color: hexToRgb(0x8fa8d8), intensity: 0.24, pos: [1.4, 2.8, -0.8] },
    fill: { intensity: 0.08 },
    deskGlow: { intensity: 0.85 },
    sky: { top: hexToRgb(0x0c1630), mid: hexToRgb(0x18294e), horizon: hexToRgb(0x2a3d66), sunY: 0.30, sunAlpha: 0.0, sunSize: 0.06 },
    pane: { emissiveIntensity: 0.6, color: hexToRgb(0x9db2d8) },
  },
]

/**
 * 순수: 시각(0..24 실수, 분 포함) → 보간된 라이팅 상태.
 * 앵커 사이는 smoothstep — 경계에서 미분 연속이라 시간 경과 팝이 없다.
 */
export function computeLighting(hour) {
  let h = Number.isFinite(hour) ? hour % 24 : 12
  if (h < 0) h += 24
  // 감싸는 앵커 쌍 찾기(24h 랩)
  let a = ANCHORS[ANCHORS.length - 1]
  let b = ANCHORS[0]
  for (let i = 0; i < ANCHORS.length; i++) {
    const cur = ANCHORS[i]
    const next = ANCHORS[(i + 1) % ANCHORS.length]
    const start = cur.hour
    const end = next.hour > cur.hour ? next.hour : next.hour + 24
    const hh = h >= start ? h : h + 24
    if (hh >= start && hh < end) { a = cur; b = next; break }
  }
  const span = (b.hour > a.hour ? b.hour : b.hour + 24) - a.hour
  const hh = h >= a.hour ? h : h + 24
  const t = smoothstep(span > 0 ? (hh - a.hour) / span : 0)
  return {
    ambientColor: lerpRgb(a.ambient.color, b.ambient.color, t),
    ambientIntensity: lerp(a.ambient.intensity, b.ambient.intensity, t),
    keyColor: lerpRgb(a.key.color, b.key.color, t),
    keyIntensity: lerp(a.key.intensity, b.key.intensity, t),
    keyPos: lerpVec(a.key.pos, b.key.pos, t),
    keyTarget: lerpVec(a.keyTarget, b.keyTarget, t),
    rimColor: lerpRgb(a.rim.color, b.rim.color, t),
    rimIntensity: lerp(a.rim.intensity, b.rim.intensity, t),
    rimPos: lerpVec(a.rim.pos, b.rim.pos, t),
    fillIntensity: lerp(a.fill.intensity, b.fill.intensity, t),
    deskGlowIntensity: lerp(a.deskGlow.intensity, b.deskGlow.intensity, t),
    skyTop: lerpRgb(a.sky.top, b.sky.top, t),
    skyMid: lerpRgb(a.sky.mid, b.sky.mid, t),
    skyHorizon: lerpRgb(a.sky.horizon, b.sky.horizon, t),
    sunY: lerp(a.sky.sunY, b.sky.sunY, t),
    sunAlpha: lerp(a.sky.sunAlpha, b.sky.sunAlpha, t),
    sunSize: lerp(a.sky.sunSize, b.sky.sunSize, t),
    paneEmissiveIntensity: lerp(a.pane.emissiveIntensity, b.pane.emissiveIntensity, t),
    paneColor: lerpRgb(a.pane.color, b.pane.color, t),
  }
}

const rgbCss = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`

/** 하늘 캔버스 페인터 — 그라데이션 + 해/달 원반 + 지평 실루엣. */
export function drawSky(ctx, w, hgt, s) {
  const grad = ctx.createLinearGradient(0, 0, 0, hgt)
  grad.addColorStop(0, rgbCss(s.skyTop))
  grad.addColorStop(0.55, rgbCss(s.skyMid))
  grad.addColorStop(1, rgbCss(s.skyHorizon))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, hgt)
  if (s.sunAlpha > 0.01) {
    ctx.globalAlpha = s.sunAlpha
    ctx.fillStyle = 'rgba(255,242,210,0.95)'
    ctx.beginPath()
    ctx.arc(w * 0.38, hgt * s.sunY, hgt * s.sunSize, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }
  // 먼 풍경 실루엣(수평선 띠) — 기존 노을 텍스처의 실루엣 유지
  ctx.fillStyle = 'rgba(90,105,90,0.5)'
  ctx.fillRect(0, hgt * 0.86, w, hgt * 0.14)
}

/**
 * 씬 핸들을 쥐는 리그. handles: { ambient, key, rim, fill, deskGlow,
 * paneMat, skyCtx: {ctx,w,h,texture} }. 모두 명명된 참조(Codex MUST-FIX —
 * 인라인 add 금지). setHour는 타깃만 바꾸고 tick(dt)이 지수 수렴시킨다.
 */
export function createLightingRig(handles) {
  let target = computeLighting(12)
  let current = null // 첫 apply 전 — immediate 세팅 대상
  let skyDirty = true
  let lastSkyDraw = 0

  const RATE = 1.6 // 1/s — ~1.5s에 95% 수렴(시간 전환이 '스르륵')

  function applyState(s, now = 0) {
    const H = handles
    H.ambient.color.setRGB(...s.ambientColor)
    H.ambient.intensity = s.ambientIntensity
    H.key.color.setRGB(...s.keyColor)
    H.key.intensity = s.keyIntensity
    H.key.position.set(...s.keyPos)
    H.key.target.position.set(...s.keyTarget)
    H.rim.color.setRGB(...s.rimColor)
    H.rim.intensity = s.rimIntensity
    H.rim.position.set(...s.rimPos)
    H.fill.intensity = s.fillIntensity
    H.deskGlow.intensity = s.deskGlowIntensity
    if (H.paneMat) {
      H.paneMat.emissiveIntensity = s.paneEmissiveIntensity
      H.paneMat.color.setRGB(...s.paneColor)
    }
    // 램프 갓 발광(소품 밀도 패스) — GLB 로드가 비동기라 lampMats는 나중에
    // 채워지는 공유 배열. deskGlow 강도를 따라가 밤(0.85)엔 블룸 임계를 넘어
    // 헤일로가 생기고 낮(0.12)엔 꺼진 갓으로 보인다.
    if (H.lampMats) {
      for (const m of H.lampMats) {
        m.emissive.setRGB(1.0, 0.82, 0.55) // 따뜻한 전구색
        m.emissiveIntensity = s.deskGlowIntensity * 1.15
      }
    }
    // 하늘 리드로 — 상태가 흔들릴 때만 + 500ms 스로틀(캔버스 비용 절약)
    if (skyDirty && H.skyCtx && now - lastSkyDraw > 500) {
      drawSky(H.skyCtx.ctx, H.skyCtx.w, H.skyCtx.h, s)
      H.skyCtx.texture.needsUpdate = true
      lastSkyDraw = now
      skyDirty = false
    }
  }

  const NUM_KEYS = Object.keys(computeLighting(0)).filter((k) => typeof computeLighting(0)[k] === 'number')

  return {
    setHour(hour, { immediate = false } = {}) {
      target = computeLighting(hour)
      skyDirty = true
      if (immediate || !current) {
        current = { ...target }
        applyState(current, Infinity) // 스로틀 무시하고 즉시 하늘까지
        lastSkyDraw = 0
      }
      return { ...target }
    },
    tick(dt, nowMs = (typeof performance !== 'undefined' ? performance.now() : 0)) {
      if (!current) return
      const k = 1 - Math.exp(-RATE * Math.max(0, dt || 0))
      let moving = false
      for (const key of Object.keys(target)) {
        const tv = target[key]
        const cv = current[key]
        if (typeof tv === 'number') {
          const nv = lerp(cv, tv, k)
          if (Math.abs(nv - tv) > 1e-4) moving = true
          current[key] = nv
        } else if (Array.isArray(tv)) {
          current[key] = cv.map((v, i) => lerp(v, tv[i], k))
          if (current[key].some((v, i) => Math.abs(v - tv[i]) > 1e-4)) moving = true
        }
      }
      if (moving) skyDirty = true
      applyState(current, nowMs)
    },
    getState() { return current ? { ...current } : { ...target } },
    _numKeys: NUM_KEYS, // 테스트용
  }
}
