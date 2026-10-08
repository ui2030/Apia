// src/chatRenderer.js — entry script for the standalone chat window
// (`chat.html`). Phase F2.
//
// The wallpaper-mode main window doesn't receive clicks (it's behind desktop
// icons), so the actual chat surface lives in this separate floating
// BrowserWindow. Character-side effects (emotion, talk state, face-camera,
// citation chips) cross the IPC boundary as `character:notify` actions
// routed by `electron/main.js` to the main window's `onCharacterAction`.
//
// Codex MUST-FIX (F2 round 1):
//   - Action allowlist on the receiving side + window-existence guard.
//   - TTS lifecycle uses try/finally so a play/network failure can't strand
//     the character in 'talk' state forever.
//   - Close button hides the window (preventDefault) rather than destroying
//     it; reopen via tray click / Ctrl+Alt+A is instant.

import { analyzeWav } from './lipsyncRuntime.js'
import { toUserMessage, isActiveFrame, createSpeechQueue, pollWhileVisible, showFallbackOffer } from './chatShared.js'
import { createMicController } from './micListener.js'

const state = {
  history: [],
  voiceId: null,
  ttsEnabled: true,
  memoryTurns: 10,
  useWebDefault: false,
  isSending: false,
  // SSE 스트리밍 진행 상태(요청당 1개). requestId로 늦은 델타를 거른다.
  activeRequestId: null,
  streamRow: null,
  streamText: '',
  pendingUserText: '',
  // TTS 백그라운드 재생 중단용 공유 경로(task 2).
  activeAudio: null,
  abortSpeak: null,
  // 마이크 캡처 게이트 — main이 알려주는 이 창의 표시 상태가 단일 출처다.
  // fail-closed: 첫 chat:visibility 신호가 오기 전까지는 "안 보임"으로 간주한다
  // — show:false로 뜬 창이 로드 직후 첫 신호 전에 듣기 시작하는 틈 차단.
  micWindowVisible: false
}

function init() {
  if (!window.api) {
    console.warn('[chatRenderer] window.api missing — IPC unavailable')
    return
  }
  hydrateSettings()
  window.api.onSettingsApplied?.((settings) => applyRuntimeSettings(settings))
  loadVoices()
  bindUI()
  // 스트림 이벤트 구독(요청당이 아니라 1회). 늦은 프레임은 requestId로 무시.
  window.api.onChatStreamDelta?.((payload) => onStreamDelta(payload))
  window.api.onChatStreamDone?.((payload) => onStreamDone(payload))
  window.api.onChatStreamError?.((payload) => onStreamError(payload))
  // 선톡 — Apia가 먼저 건 한 줄을 AI 메시지로 띄우고 캐릭터를 말하게 한다.
  window.api.onProactiveOpener?.((payload) => handleOpener(payload))
  setupMic()
  startBackendPolling()
}

// 벽지모드 채팅창 백엔드 상태 실표시 — 헤더 status-dot에 색/툴팁 바인딩(task 3).
function startBackendPolling() {
  const dot = document.querySelector('.status-dot')
  if (!dot) return
  const tick = async () => {
    let ok = false
    try { ok = !!(await window.api?.checkBackend?.())?.ok } catch {}
    dot.style.background = ok ? '#4ade80' : '#ef4444'
    dot.title = ok ? 'AI 엔진 연결됨' : 'AI 엔진 꺼짐'
  }
  // 숨겨진(닫힌) 창이 5초마다 백엔드를 두드리던 낭비 차단 — 다시 보일 때 즉시 1회.
  pollWhileVisible(tick, 5000)
}

async function hydrateSettings() {
  try {
    const settings = await window.api.getSettings()
    applyRuntimeSettings(settings)
  } catch (error) {
    console.warn('[chatRenderer] settings hydrate failed', error)
  }
}

function applyRuntimeSettings(settings = {}) {
  if (typeof settings.voiceId === 'string') {
    state.voiceId = settings.voiceId || null
  } else if (settings.voiceId == null) {
    state.voiceId = null
  }
  if (typeof settings.ttsEnabled === 'boolean') state.ttsEnabled = settings.ttsEnabled
  if (Number.isFinite(settings.memoryTurns)) {
    state.memoryTurns = Math.max(1, Math.min(50, settings.memoryTurns))
  }
  if (typeof settings.useWebDefault === 'boolean') {
    state.useWebDefault = settings.useWebDefault
    const toggle = document.getElementById('chat-web-toggle')
    if (toggle) toggle.checked = state.useWebDefault
  }
  if (typeof settings.micEnabled === 'boolean') _mic.setEnabled(settings.micEnabled)
}

async function loadVoices() {
  if (!window.api?.getVoices) return
  try {
    const d = await window.api.getVoices()
    const selected = d.voices?.find((voice) => voice.id === state.voiceId) || d.voices?.[0]
    state.voiceId = selected?.id || null
    const vl = document.getElementById('voice-label')
    if (vl && selected) vl.textContent = selected.name
  } catch (error) {
    console.warn('[chatRenderer] loadVoices failed', error)
  }
}

function bindUI() {
  const sendBtn = document.getElementById('send-btn')
  const input = document.getElementById('chat-input')
  const closeBtn = document.getElementById('close-btn')

  sendBtn?.addEventListener('click', () => sendMessage(input?.value || ''))
  input?.addEventListener('keydown', (event) => {
    window.api?.ledgerInputStart?.() // 계측 전용(눈치 원장) — 응답→입력 시작 지연
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      sendMessage(input.value)
    }
  })
  // Close = hide. Window stays alive in memory so reopen is instant; main
  // process listens for `chat:hide` to swap the visibility flag.
  closeBtn?.addEventListener('click', () => {
    stopSpeakingNow() // 창을 닫으면 진행 중 TTS도 멈춘다(task 2)
    window.api?.chatHide?.()
  })
}

function setComposerBusy(busy) {
  const sendBtn = document.getElementById('send-btn')
  const input = document.getElementById('chat-input')
  if (sendBtn) sendBtn.disabled = busy
  if (input) input.disabled = busy
}

async function sendMessage(text, { allowCloudFallback = false, resend = false } = {}) {
  if (!text?.trim() || state.isSending) return
  // 새 전송은 이전 TTS 재생을 즉시 끊는다(task 2 공유 abort).
  stopSpeakingNow()
  state.isSending = true
  setComposerBusy(true)
  if (!resend) appendMessage('user', text) // 다시 보내기는 사용자 말풍선이 이미 있다
  const input = document.getElementById('chat-input')
  if (input) input.value = ''
  const loadingRow = appendMessage('ai', '● ● ●', true)

  state.streamRow = loadingRow
  state.streamText = ''
  state.activeRequestId = null
  state.pendingUserText = text

  if (!window.api?.chatStreamStart) {
    finalizeStream('AI 엔진에 연결되지 않았어요. 잠시 뒤 다시 시도하거나 앱을 다시 켜 주세요. 🔧', 'neutral', [], false)
    return
  }

  try {
    const historyLimit = Math.max(1, Math.min(50, state.memoryTurns)) * 2
    const toggle = document.getElementById('chat-web-toggle')
    const useWeb = toggle ? toggle.checked : state.useWebDefault
    const r = await window.api.chatStreamStart(
      text, state.history.slice(-historyLimit), { useWeb, allowCloudFallback }
    )
    state.activeRequestId = r?.requestId || null
    if (!state.activeRequestId) {
      finalizeStream(toUserMessage('backend unavailable'), 'neutral', [], false)
    }
  } catch (error) {
    finalizeStream(toUserMessage(error?.message || error), 'neutral', [], false)
  }
}

function onStreamDelta(payload) {
  if (!isActiveFrame(payload, state.activeRequestId) || !state.streamRow) return
  if (state.streamText === '') {
    const bubble = state.streamRow.querySelector('.msg-bubble')
    if (bubble) { bubble.classList.remove('typing'); bubble.textContent = '' }
  }
  state.streamText += payload.text || ''
  const bubble = state.streamRow.querySelector('.msg-bubble')
  if (bubble) bubble.textContent = state.streamText
  const messages = document.getElementById('messages')
  if (messages) messages.scrollTop = messages.scrollHeight
}

function onStreamDone(payload) {
  if (!isActiveFrame(payload, state.activeRequestId)) return
  const reply = payload.reply || state.streamText || '...'
  const emotion = payload.emotion || 'neutral'
  const citations = Array.isArray(payload.citations) ? payload.citations : []
  const text = state.pendingUserText
  finalizeStream(reply, emotion, citations, true)
  // 교사 대신 로컬이 답한 날의 첫 답에만 붙는 안내(main이 하루 1회로 거른다).
  if (payload.notice) appendMessage('ai', payload.notice)
  if (payload.fallbackOffer) offerCloudFallback(payload.fallbackOffer, text)
}

// 발주서 23 — 고른 클라우드 모델이 안 켜져 다른 클라우드로 대신 답할지 묻는다.
// 안내 답은 대화가 아니므로 기록에서 뺀다 — [이번만]/[앞으로 항상]이 같은 말을
// 다시 보낼 때 기록에 두 번 들어가지 않게.
function offerCloudFallback(offer, text) {
  state.history.splice(-2)
  showFallbackOffer({
    doc: document,
    append: (t) => appendMessage('ai', t),
    offer,
    resend: () => sendMessage(text, { allowCloudFallback: true, resend: true }),
    savePolicy: (policy) => window.api?.saveSettings?.({ cloudFallbackPolicy: policy }),
    openSettings: () => window.api?.openSettings?.()
  })
}

function onStreamError(payload) {
  if (!isActiveFrame(payload, state.activeRequestId)) return
  finalizeStream(toUserMessage(payload.error), 'neutral', [], false)
}

// 라이브 버블을 최종 내용으로 확정하고 컴포저를 즉시 푼다. speak는 tts가 있고
// success일 때만 백그라운드로(재생 완료를 기다리지 않는다 — task 2).
function finalizeStream(reply, emotion, citations, speak) {
  const row = state.streamRow
  if (row) {
    const bubble = row.querySelector('.msg-bubble')
    if (bubble) { bubble.classList.remove('typing'); bubble.style.opacity = ''; bubble.textContent = reply }
    if (Array.isArray(citations) && citations.length > 0) {
      row.appendChild(renderCitationChips(citations))
    }
    const messages = document.getElementById('messages')
    if (messages) messages.scrollTop = messages.scrollHeight
  }

  state.history.push(
    { role: 'user', content: state.pendingUserText },
    { role: 'assistant', content: reply }
  )
  const localHistoryLimit = Math.max(1, Math.min(50, state.memoryTurns)) * 2
  if (state.history.length > localHistoryLimit) {
    state.history = state.history.slice(-localHistoryLimit)
  }

  state.activeRequestId = null
  state.streamRow = null
  state.streamText = ''
  state.isSending = false
  setComposerBusy(false)

  if (speak) {
    // Side effects on the wallpaper character — emotion + face-camera + bubble.
    window.api?.notifyCharacter?.({ action: 'emotion', value: emotion })
    window.api?.notifyCharacter?.({
      action: 'bubble',
      text: reply.slice(0, 50) + (reply.length > 50 ? '...' : '')
    })
    window.api?.notifyCharacter?.({ action: 'face-camera', durationMs: 12000 })
    // fire-and-forget: composer already unlocked, TTS plays in background.
    speakWithLipsync(reply, emotion)
  }
}

// 진행 중 오디오/립싱크를 즉시 중단(공유 abort 경로). 새 전송·창 닫힘에서 호출.
function stopSpeakingNow() {
  if (state.abortSpeak) {
    const fn = state.abortSpeak
    state.abortSpeak = null
    try { fn() } catch {}
  }
}

// chat.js speakText와 같은 계약 — 진행 중 재생을 끊고 큐에 태운다. 이 창은
// lipsync-start/stop을 IPC로 보내므로, 겹치면 메인 창의 _preLipsyncState까지
// 'talk'로 덮여 캐릭터가 talk 상태에 갇힌다.
const _speechQueue = createSpeechQueue()

function speakWithLipsync(text, emotion) {
  if (!window.api?.tts || !state.ttsEnabled) return Promise.resolve()
  stopSpeakingNow()
  return _speechQueue(() => _speakOnce(text, emotion))
}

// emotion은 운율(피치·속도)용 — 백엔드가 이모지/마크다운을 정화하면서 그 감정을
// 목소리 톤으로 옮긴다. 안 넘겨도 텍스트 단서로 추정된다.
async function _speakOnce(text, emotion) {
  let audio = null
  let audioUrl = null
  let started = false
  try {
    const r = await window.api.tts(text, state.voiceId, emotion)
    if (r?.disabled || !r?.audio) return
    // 음성 복제 폴백 안내 — 세션당 1회 (chat.js와 동일 계약)
    if (r?.fallback && !state.voiceFallbackNotified && String(state.voiceId || '').startsWith('custom:')) {
      state.voiceFallbackNotified = true
      appendMessage('ai', '(설정한 캐릭터 목소리를 준비하지 못해서 기본 목소리로 말했어요. 잠시 뒤에는 캐릭터 목소리로 돌아올 수 있어요.)')
    }
    const bytes = atob(r.audio)
    const buf = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i += 1) buf[i] = bytes.charCodeAt(i)
    audioUrl = URL.createObjectURL(new Blob([buf], { type: r.mime || 'audio/wav' }))
    audio = new Audio(audioUrl)
    state.activeAudio = audio

    // H단계 — 이 창이 오디오를 재생하고 캐릭터(메인 창)는 IPC로만 입을
    // 움직인다. 비짐 타임라인을 여기서 분석해 lipsync-start에 실어 보내되,
    // 반드시 play() 성공 **후** offsetSec(=currentTime)과 함께 — 수신 시점
    // t0에서 그만큼 되감아 IPC 지연을 흡수한다 (Codex MUST-FIX).
    // 분석은 Blob 버퍼가 아닌 복제본으로 (decodeAudioData가 detach).
    const visemeTimeline = await analyzeWav(buf.buffer.slice(0))

    await new Promise((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        state.abortSpeak = null
        try { audio.pause() } catch {}
        resolve()
      }
      audio.onended = finish
      audio.onerror = finish
      // 공유 abort 경로: stopSpeakingNow()가 재생을 즉시 끊을 수 있게 finish를 건다.
      state.abortSpeak = finish
      audio.play().then(() => {
        // 이미 abort된 발화면 lipsync-start를 보내지 않는다 — 보내면 메인 창이
        // setState('talk')로 들어간 뒤 짝이 되는 stop을 못 받아 talk에 갇힌다.
        if (finished) return
        window.api.notifyCharacter?.({
          action: 'lipsync-start',
          value: visemeTimeline
            ? { timeline: visemeTimeline, offsetSec: audio.currentTime || 0 }
            : undefined
        })
        started = true
      }).catch(finish)
    })
  } catch (error) {
    console.warn('[chatRenderer] tts failed', error)
  } finally {
    // Codex MUST-FIX (F2 round 2): only send lipsync-stop if we sent
    // lipsync-start. An early return (disabled/no audio/error) without the
    // start would otherwise let main.js force the character back to 'idle'
    // and cancel an in-flight face-camera walk or a sit-in-progress.
    if (started) {
      window.api?.notifyCharacter?.({ action: 'lipsync-stop' })
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    if (state.activeAudio === audio) state.activeAudio = null
    if (state.abortSpeak) state.abortSpeak = null
  }
}

const MAX_MSG_ROWS = 200 // L단계 — 채팅 DOM 무한 누적 방지(오래된 행 프루닝)
function appendMessage(role, text, isLoading = false, citations = null) {
  const messages = document.getElementById('messages')
  if (!messages) return null
  const row = document.createElement('div')
  row.className = `msg-row ${role}`
  const label = document.createElement('div')
  label.className = 'msg-label'
  label.textContent = role === 'ai' ? 'Apia' : '나'
  const bubble = document.createElement('div')
  bubble.className = 'msg-bubble'
  if (isLoading) bubble.classList.add('typing') // 대기 인디케이터 애니메이션(task 5)
  bubble.textContent = text
  row.appendChild(label)
  row.appendChild(bubble)
  if (Array.isArray(citations) && citations.length > 0) {
    row.appendChild(renderCitationChips(citations))
  }
  messages.appendChild(row)
  while (messages.children.length > MAX_MSG_ROWS) messages.firstElementChild?.remove()
  messages.scrollTop = messages.scrollHeight
  return row
}

function renderCitationChips(citations) {
  const wrap = document.createElement('div')
  wrap.className = 'msg-citations'
  for (const c of citations) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'citation-chip'
    const label = c.title?.trim() || c.source_path || '출처'
    chip.textContent = `[${c.marker_number}] ${label}`
    if (c.snippet) chip.title = c.snippet
    if (c.source_kind === 'web' && c.source_path) {
      chip.addEventListener('click', (event) => {
        event.preventDefault()
        window.api?.openExternal?.(c.source_path)
      })
    } else {
      chip.disabled = true
    }
    wrap.appendChild(chip)
  }
  return wrap
}

// ── 선톡 표시 ────────────────────────────────────────────────────────────────
// main이 생성한 한 줄을 받아 AI 메시지로 띄우고, 캐릭터(메인 창)를 말하게 한다.
// 사용자가 답하면 일반 sendMessage 경로를 타 응답으로 확정된다(main이 관할).
function handleOpener(payload) {
  const text = String(payload?.text || '').trim()
  if (!text) return
  const emotion = payload?.emotion || 'neutral'
  appendMessage('ai', text)
  // 대화 맥락 유지 — 다음 답장의 history에 이 선톡을 어시스턴트 턴으로 넣는다.
  state.history.push({ role: 'assistant', content: text })
  const localHistoryLimit = Math.max(1, Math.min(50, state.memoryTurns)) * 2
  if (state.history.length > localHistoryLimit) state.history = state.history.slice(-localHistoryLimit)
  window.api?.notifyCharacter?.({ action: 'emotion', value: emotion })
  window.api?.notifyCharacter?.({ action: 'bubble', text: text.slice(0, 50) + (text.length > 50 ? '...' : '') })
  window.api?.notifyCharacter?.({ action: 'face-camera', durationMs: 12000 })
  speakWithLipsync(text)
}

// ── 마이크 ───────────────────────────────────────────────────────────────────
//
// 프라이버시 계약은 createMicController(micListener.js)가 한 곳에서 지킨다.
// 이 창이 주는 건 "보인다"의 정의뿐: **main의 chat:visibility가 단일 출처**다
// — 렌더러 visibilityState는 환경에 따라 거짓말을 한다. 창이 숨으면 캡처를
// 완전히 놓아 OS 마이크 표시까지 꺼진다.
const _mic = createMicController({
  onText: (text) => {
    const input = document.getElementById('chat-input')
    if (input) input.value = text
    sendMessage(text)
  },
  isSurfaceVisible: () => state.micWindowVisible,
  getButton: () => document.getElementById('mic-btn')
})

function setupMic() {
  const btn = document.getElementById('mic-btn')
  if (!btn) return
  // 버튼 = 멈춤 토글("귀 닫아"). 마스터 on/off는 설정 창에서.
  btn.addEventListener('click', () => {
    if (!_mic.isEnabled()) { window.api?.openSettings?.(); return }
    _mic.togglePause()
  })
  // 창이 숨거나 다시 보이면 캡처를 따라간다(표시등 = 캡처의 동어반복).
  window.api?.onChatVisibility?.(({ visible }) => {
    state.micWindowVisible = visible !== false
    _mic.sync()
  })
  // 테스트 훅 — 가짜 STT(WAV → 실제 transcribe IPC) 또는 전사 텍스트 직접 라우팅.
  window.__apiaMic = {
    transcribeAndRoute: _mic.transcribeAndRoute,
    routeTranscript: _mic.routeTranscript,
    shouldListen: _mic.shouldListen
  }
  _mic.sync()
}

init()
