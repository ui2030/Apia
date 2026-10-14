// src/supportUi.js — 처음 켜는 사람을 위한 화면 조각 (발주서 24).
// 시작 안내 카드 · AI 엔진 연결 띠 · 그래픽 실패 카드 · 저사양 모드 레버.
// DOM은 인자로 받은 doc만 만지고 IPC는 api(window.api)로만 부른다 — 두 채팅
// 표면(오버레이·벽지 채팅창)과 메인 창이 같은 조각을 쓴다.

/** 저사양 모드가 움직이는 레버. 새 렌더 경로 없이 이미 있는 손잡이만 돌린다. */
export function lowEndLevers(on) {
  return on
    // 20fps(50ms 프레임) — 물리 1/60·최대 3스텝 = 50ms까지 정속. 렌더 해상도 절반
    // (pixelRatio 0.5) — 소프트웨어 렌더링에선 픽셀 수가 곧 CPU다(발주서28 D2).
    ? { postFx: false, pixelRatioCap: 0.5, targetFps: 20, shadows: false, outline: false, physics: { unitStep: 1 / 60, maxStepNum: 3 }, spectateIntervalScale: 2 }
    : { postFx: true, pixelRatioCap: 2, targetFps: 60, shadows: true, outline: true, physics: { unitStep: 1 / 120, maxStepNum: 4 }, spectateIntervalScale: 1 }
}

/** 첫 5초 평균 프레임 간격이 이보다 길면 소프트웨어 렌더링급으로 본다. */
export const SLOW_FRAME_MS = 80
const SOFTWARE_RENDERER_RE = /SwiftShader|llvmpipe|Basic Render Driver/i

/**
 * 그래픽 카드 없이 그리는 중인가 — 이유 문자열 또는 null. 3중 판정:
 * 메인의 GPU 장치 이름 · WebGL 렌더러 문자열 · 실측 프레임 간격(가장 믿을 만함).
 */
export function softwareRenderReason({ gpu = '', webglRenderer = '', avgFrameMs = 0 } = {}) {
  // gpu는 main의 gpuSummary(장치 이름을 ' / '로 이음). 그래픽 카드 있는 PC에도 Basic Render
  // Driver가 둘째 장치로 늘 끼어 있다(실측: 'NVIDIA … / Microsoft Basic Render Driver') —
  // 장치가 그것뿐일 때만 그래픽 카드 없음.
  const devices = String(gpu).split(' / ').filter(Boolean)
  if (devices.length && devices.every((d) => /Basic Render Driver/i.test(d))) return 'gpu-info'
  if (SOFTWARE_RENDERER_RE.test(webglRenderer)) return 'webgl-renderer'
  if (avgFrameMs > SLOW_FRAME_MS) return 'frame-time'
  return null
}

/** 버튼 없는 한 줄 안내(몇 초 뒤 사라짐). */
export function showNoticeCard({ doc, text, ms = 12000 }) {
  doc.getElementById('apia-notice-card')?.remove()
  const c = el(doc, 'div', CARD_CSS + 'position:fixed;right:24px;bottom:60px;width:300px;z-index:100;pointer-events:none;', text)
  c.id = 'apia-notice-card'
  doc.body.appendChild(c)
  setTimeout(() => c.remove(), ms)
  return c
}

export const BANNER_CONNECTING_MS = 10000
export const BANNER_STUCK_MS = 30000

/** 연결이 마지막으로 확인된 때(sinceMs)부터 지난 시간으로 띠 단계를 정한다. */
export function backendBannerStage(online, sinceMs, nowMs) {
  if (online) return null
  const t = nowMs - sinceMs
  if (t >= BANNER_STUCK_MS) return 'stuck'
  if (t >= BANNER_CONNECTING_MS) return 'connecting'
  return null
}

const CARD_CSS = 'background:rgba(16,12,34,0.95);border:1px solid rgba(124,58,237,0.5);' +
  'border-radius:12px;padding:12px 14px;color:rgba(255,255,255,0.92);font-size:12px;' +
  'line-height:1.55;box-shadow:0 6px 20px rgba(0,0,0,0.45);user-select:none;'
const BTN_CSS = 'font:inherit;font-size:11px;padding:4px 10px;border-radius:8px;cursor:pointer;' +
  'background:rgba(124,58,237,0.35);border:1px solid rgba(124,58,237,0.55);color:#fff;white-space:nowrap;'
const GHOST_CSS = BTN_CSS + 'background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.18);'

function el(doc, tag, css, text) {
  const node = doc.createElement(tag)
  if (css) node.style.cssText = css
  if (text != null) node.textContent = text
  return node
}

function button(doc, label, onClick, css = BTN_CSS) {
  const b = el(doc, 'button', css, label)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

// 오버레이 메인 창은 평소 마우스를 통과시킨다(forward:true라 mousemove는 온다).
// 카드 위에 있을 때만 클릭을 받는다.
function captureMouseOnHover(node, api) {
  node.addEventListener('mouseenter', () => api?.setIgnoreMouse?.(false))
  node.addEventListener('mouseleave', () => api?.setIgnoreMouse?.(true))
}

/**
 * 시작 안내 카드. floating=true면 캐릭터 옆에 떠 있는 카드(메인 오버레이),
 * false면 host 맨 위(anchor 뒤)에 끼우는 블록(채팅 창). refresh()가 main에 다시
 * 물어 보이거나 사라진다 — 키가 들어와 답변 모델이 생기면 main이 영구 종료한다.
 */
export const ENGINE_LINES = Object.freeze({
  starting: 'AI 엔진을 켜는 중이에요… (느린 PC에서는 1분쯤 걸릴 수 있어요)',
  slow: '오래 걸리네요… 계속 기다리는 중이에요',
  failed: 'AI 엔진이 켜지지 않았어요. 설정 → 정보·도움 → 문제 신고용 묶기로 알려 주세요'
})
const ENGINE_POLL_MS = 3000

export function createFirstRunCard({ doc, api, host, anchor = null, floating = false }) {
  let card = null
  let engineLine = null
  let busy = false
  let pollTimer = null

  function remove() {
    if (card && floating) api?.setIgnoreMouse?.(true)
    card?.remove()
    card = null
    engineLine = null
    clearTimeout(pollTimer)
  }

  // 엔진 단계 줄 — 연결되면(engine=null) 그 줄만 사라진다.
  function setEngine(engine) {
    const text = engine ? ENGINE_LINES[engine] || ENGINE_LINES.starting : ''
    engineLine.textContent = text
    engineLine.style.display = text ? 'block' : 'none'
    engineLine.style.color = engine === 'failed' ? '#fca5a5' : '#fde68a'
    clearTimeout(pollTimer)
    pollTimer = engine ? setTimeout(refresh, ENGINE_POLL_MS) : null
  }

  function build() {
    const c = el(doc, 'div', CARD_CSS + (floating
      ? 'position:fixed;right:320px;bottom:120px;width:300px;z-index:50;pointer-events:auto;'
      : 'margin:8px 10px 0;'))
    c.className = 'apia-card'
    c.id = 'first-run-card'
    engineLine = el(doc, 'div', 'display:none;font-size:11px;margin-bottom:8px;')
    engineLine.id = 'first-run-engine'
    c.appendChild(engineLine)
    c.appendChild(el(doc, 'div', 'font-weight:600;margin-bottom:8px;', '환영해요. 대화하려면 두 가지만 하면 돼요.'))
    const step = (num, label, note, onClick) => {
      const row = el(doc, 'div', 'display:flex;align-items:center;gap:8px;margin:4px 0;')
      row.appendChild(el(doc, 'span', 'color:#a78bfa;font-weight:700;', num))
      row.appendChild(button(doc, label, onClick))
      if (note) row.appendChild(el(doc, 'span', 'font-size:10px;color:rgba(255,255,255,0.5);', note))
      return row
    }
    c.appendChild(step('①', 'API 키 넣기', null, () => api?.openSettings?.('ai')))
    c.appendChild(step('②', '캐릭터 넣기', '선택', () => api?.openSettings?.('character')))
    const foot = el(doc, 'div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;')
    foot.appendChild(el(doc, 'span', 'font-size:10.5px;color:rgba(255,255,255,0.6);', '키 없이도 캐릭터와 방은 구경할 수 있어요'))
    foot.appendChild(button(doc, '나중에', () => {
      remove()
      api?.firstRun?.dismiss?.()
    }, GHOST_CSS))
    c.appendChild(foot)
    if (floating) captureMouseOnHover(c, api)
    return c
  }

  async function refresh() {
    if (busy || !api?.firstRun?.state) return
    busy = true
    try {
      const state = await api.firstRun.state()
      if (!state?.show) { remove(); return }
      if (!card) {
        card = build()
        if (anchor) anchor.after(card)
        else host.appendChild(card)
      }
      setEngine(state.engine || null)
    } catch {
      // main에 못 물으면 카드는 그대로 둔다(다음 refresh에서 다시 판단).
    } finally {
      busy = false
    }
  }

  return { refresh, remove }
}

/**
 * 채팅창 상단 연결 띠. report(ok)를 상태 확인 때마다 부른다. 10초 넘게 끊기면
 * "연결 중" 안내, 30초 넘으면 [다시 시도](이미 있는 백엔드 재시작) [로그 묶기].
 */
export function createBackendBanner({ doc, api, anchor, now = () => Date.now() }) {
  let online = false
  let since = now() // 마지막으로 연결이 확인된 때(처음엔 창이 뜬 때)
  let shown = null
  let note = ''

  const bar = el(doc, 'div', 'display:none;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 12px;' +
    'font-size:11px;color:#fde68a;background:rgba(245,158,11,0.12);border-bottom:1px solid rgba(245,158,11,0.25);')
  bar.id = 'backend-banner'
  anchor?.after(bar)

  function render(force = false) {
    const stage = backendBannerStage(online, since, now())
    if (stage === shown && !force) return
    shown = stage
    bar.style.display = stage ? 'flex' : 'none'
    bar.replaceChildren()
    if (!stage) return
    bar.appendChild(el(doc, 'span', 'flex:1;min-width:120px;', note || 'AI 엔진에 연결 중이에요…'))
    if (stage !== 'stuck') return
    bar.appendChild(button(doc, '다시 시도', async () => {
      note = 'AI 엔진을 다시 켜는 중이에요…'
      since = now() - BANNER_CONNECTING_MS // 기다리는 동안 "연결 중"으로, 20초 뒤 다시 버튼
      render(true)
      try { await api?.restartBackend?.() } catch {}
      note = ''
      render(true)
    }))
    bar.appendChild(button(doc, '로그 묶기', async () => {
      const r = await api?.bundleReport?.().catch(() => null)
      note = r?.ok ? '묶었어요. 깃허브 이슈에 첨부해 주세요' : '로그를 묶지 못했어요'
      render(true)
    }, GHOST_CSS))
  }

  const timer = setInterval(() => render(), 1000)
  return {
    report(ok) {
      if (ok) { online = true; since = now(); note = '' } else if (online) { online = false; since = now() }
      render()
    },
    stop: () => clearInterval(timer)
  }
}

/** WebGL을 못 만들었거나 잃었을 때 흰(빈) 화면 대신 띄우는 안내. */
export function showGraphicsFailCard({ doc, api }) {
  if (doc.getElementById('gfx-fail-card')) return
  const c = el(doc, 'div', CARD_CSS +
    'position:fixed;right:24px;bottom:60px;width:300px;z-index:100;pointer-events:auto;')
  c.id = 'gfx-fail-card'
  c.appendChild(el(doc, 'div', 'margin-bottom:10px;',
    '그래픽을 그리지 못했어요. 그래픽 드라이버를 업데이트하거나 저사양 모드를 켜 보세요.'))
  c.appendChild(button(doc, '저사양 모드 켜고 다시 시작', () => api?.relaunchLowEnd?.()))
  captureMouseOnHover(c, api)
  doc.body.appendChild(c)
}
