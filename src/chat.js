// src/chat.js - 채팅, STT, TTS
import { setState, getState } from './characterController.js'
import { setEmotion, requestFaceCamera } from './characterController.js'
import { analyzeWav, playTimeline, stopTimeline } from './lipsyncRuntime.js'
import { createTouchClassifier } from './touchInteraction.js'

// Step 3: character raycaster injected by main.js. null = wallpaper mode
// active (or just no character loaded) — click-through manager skips the
// raycast branch and pointerdown ignores hits. Stays nullable so updates
// from settings broadcasts can flip it at runtime.
let _characterRaycaster = null
export function setCharacterRaycaster(fn) {
  _characterRaycaster = typeof fn === 'function' ? fn : null
}
let _showBubble, _startSpeaking, _stopSpeaking, _applyEmotion
let _getTalkMotion, _getIdleMotion, _onUserCall, _onPet, _onGrab

const state = {
  chatOpen: false,
  history: [],
  voiceId: null,
  ttsEnabled: true,
  memoryTurns: 10,
  useWebDefault: false,
  isListening: false,
  isSending: false,
  speechReturnState: null
}

export function initChat({
  showBubble,
  startSpeaking,
  stopSpeaking,
  applyEmotion,
  getTalkMotion,
  getIdleMotion,
  onUserCall,
  onPet,
  onGrab
}) {
  _showBubble = showBubble
  _startSpeaking = startSpeaking
  _stopSpeaking = stopSpeaking
  _applyEmotion = applyEmotion
  _getTalkMotion = getTalkMotion
  _getIdleMotion = getIdleMotion
  _onUserCall = onUserCall
  _onPet = onPet
  _onGrab = onGrab

  setupUI()
  startClickThroughManager()
  hydrateSettings()
  window.api?.onSettingsApplied?.((settings) => {
    applyRuntimeSettings(settings)
    loadVoices()
  })
  checkBackend()
  setInterval(checkBackend, 5000)
}

function applyRuntimeSettings(settings = {}) {
  if (typeof settings.voiceId === 'string') {
    state.voiceId = settings.voiceId || null
  } else if (settings.voiceId == null) {
    state.voiceId = null
  }

  if (typeof settings.ttsEnabled === 'boolean') {
    state.ttsEnabled = settings.ttsEnabled
  }

  if (Number.isFinite(settings.memoryTurns)) {
    state.memoryTurns = Math.max(1, Math.min(50, settings.memoryTurns))
  }

  if (typeof settings.useWebDefault === 'boolean') {
    state.useWebDefault = settings.useWebDefault
    const toggle = document.getElementById('chat-web-toggle')
    if (toggle) toggle.checked = state.useWebDefault
  }
}

async function hydrateSettings() {
  if (!window.api?.getSettings) return

  try {
    const settings = await window.api.getSettings()
    applyRuntimeSettings(settings)
  } catch (error) {
    console.warn('[Chat] failed to hydrate settings', error)
  }
}

// ═══════════════════════════════════════════════════════════════
// 클릭 통과 관리 — CSS :hover Polling 방식
// ═══════════════════════════════════════════════════════════════
//
// [이전 방식들이 실패한 이유]
//   mouseenter/mouseleave, mousemove 좌표 비교 등은 전부
//   setIgnoreMouseEvents 상태 변경 시 브라우저가 이벤트를
//   재평가하면서 진동(oscillation)이 발생함.
//
// [새 방식]
//   CSS :hover는 forward:true에서 안정적으로 적용됨
//   (tooltip이 뜨는 것이 증거).
//   매 프레임 querySelector로 :hover 요소를 확인하고,
//   상태 전환 시 debounce를 걸어 진동을 원천 차단함.
// ═══════════════════════════════════════════════════════════════

function startClickThroughManager() {
  let capturing = false
  let restoreTimer = null
  const RESTORE_DELAY = 300

  // Step 3 — last known mouse position so the per-frame raycaster knows
  // where to shoot. window mousemove because the canvas is click-through
  // when we're not capturing.
  let mouseX = null
  let mouseY = null
  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX
    mouseY = e.clientY
  }, { passive: true })

  // 5단계 — 캐릭터 직접 상호작용(클릭·쓰다듬기·드래그). 포인터 시퀀스를 순수
  // 분류기에 흘려 tap/pet/grab으로 배타 분류한다. tap = 기존 채팅 토글(계약 유지),
  // pet/grab = main 주입 반응. 벽지모드는 _characterRaycaster=null이라 dormant(클릭과
  // 동일 제약). raycast는 제스처 중에만 수행해 비용 제한.
  let gestureActive = false
  const onCharAt = (x, y) => !!_characterRaycaster && _characterRaycaster(x, y) === true
  const touch = createTouchClassifier({
    onTap: () => { document.getElementById('chat-toggle')?.click() }, // 기존 토글 계약 유지
    onPet: () => { if (typeof _onPet === 'function') _onPet() },
    onGrab: () => { if (typeof _onGrab === 'function') _onGrab() }
  })

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return // primary button only — right-click is OS
    if (!_characterRaycaster) return
    if (!onCharAt(e.clientX, e.clientY)) return
    gestureActive = true // Codex MUST-FIX: 제스처 동안 click-through 복구 잠금
    touch.feed({ type: 'down', x: e.clientX, y: e.clientY, t: e.timeStamp, onChar: true })
  })
  window.addEventListener('pointermove', (e) => {
    if (!gestureActive) return
    touch.feed({ type: 'move', x: e.clientX, y: e.clientY, t: e.timeStamp, onChar: onCharAt(e.clientX, e.clientY) })
  })
  const endGesture = (e, type) => {
    if (!gestureActive) return
    touch.feed({ type, x: e.clientX ?? mouseX ?? 0, y: e.clientY ?? mouseY ?? 0, t: e.timeStamp ?? 0, onChar: false })
    gestureActive = false
  }
  window.addEventListener('pointerup', (e) => endGesture(e, 'up'))
  window.addEventListener('pointercancel', (e) => endGesture(e, 'cancel'))
  window.addEventListener('blur', () => { if (gestureActive) { touch.feed({ type: 'cancel', x: 0, y: 0, t: 0, onChar: false }); gestureActive = false } })

  function characterHover() {
    if (!_characterRaycaster || mouseX == null) return false
    return _characterRaycaster(mouseX, mouseY) === true
  }
  // 제스처 진행 중엔 항상 캡처 유지(드래그가 캐릭터를 벗어나도 move/up 유실 방지).
  function gestureHolding() { return gestureActive }

  function poll() {
    const hovered = gestureHolding() || document.querySelector(
      '#chat-toggle:hover, #settings-btn:hover, ' +
      '#chat-panel.visible:hover, .world-object:hover'
    ) || characterHover()

    if (hovered && !capturing) {
      capturing = true
      clearTimeout(restoreTimer)
      window.api?.setIgnoreMouse(false)

    } else if (!hovered && capturing) {
      if (!restoreTimer) {
        restoreTimer = setTimeout(() => {
          restoreTimer = null
          const stillHovered = gestureHolding() || document.querySelector(
            '#chat-toggle:hover, #settings-btn:hover, ' +
            '#chat-panel.visible:hover, .world-object:hover'
          ) || characterHover()
          if (!stillHovered) {
            capturing = false
            window.api?.setIgnoreMouse(true)
          }
        }, RESTORE_DELAY)
      }
    }

    requestAnimationFrame(poll)
  }

  requestAnimationFrame(poll)
}

function setupUI() {
  const chatToggle  = document.getElementById('chat-toggle')
  const settingsBtn = document.getElementById('settings-btn')
  const chatPanel   = document.getElementById('chat-panel')
  const chatInput   = document.getElementById('chat-input')
  const sendBtn     = document.getElementById('send-btn')
  const micBtn      = document.getElementById('mic-btn')

  chatToggle?.addEventListener('click', () => setChatOpen(!state.chatOpen))

  settingsBtn?.addEventListener('click', () => window.api?.openSettings())

  chatInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(chatInput.value) }
  })
  sendBtn?.addEventListener('click', () => sendMessage(chatInput?.value || ''))

  setupSTT(micBtn)
}

// 채팅 패널 열고/닫기 — state.chatOpen을 항상 동기화한다(Codex MUST-FIX: 외부
// 경로 show-main-chat가 DOM만 바꾸면 다음 토글이 상태 불일치로 오동작). 여는 것은
// "부름"이라 onUserCall(컴퓨터 앞으로)도 호출.
export function setChatOpen(open) {
  state.chatOpen = !!open
  const panel = document.getElementById('chat-panel')
  const toggle = document.getElementById('chat-toggle')
  if (panel) panel.classList.toggle('visible', state.chatOpen)
  if (state.chatOpen) {
    if (toggle) toggle.style.display = ''
    document.getElementById('chat-input')?.focus()
    if (typeof _onUserCall === 'function') _onUserCall()
  }
}

function setComposerBusy(isBusy) {
  const chatInput = document.getElementById('chat-input')
  const sendBtn = document.getElementById('send-btn')
  const micBtn = document.getElementById('mic-btn')

  if (chatInput) chatInput.disabled = isBusy
  if (sendBtn) sendBtn.disabled = isBusy
  if (micBtn) micBtn.disabled = isBusy
}

async function checkBackend() {
  const statusEl = document.getElementById('backend-status')
  if (!statusEl) return
  if (!window.api) { statusEl.textContent = '개발 모드'; statusEl.className='offline'; return }
  const r = await window.api.checkBackend()
  if (r.ok) {
    statusEl.textContent = '● 연결됨'; statusEl.className = 'online'
    loadVoices()
  } else {
    statusEl.textContent = '● 백엔드 오프라인'; statusEl.className = 'offline'
  }
}

async function loadVoices() {
  if (!window.api) return
  const d = await window.api.getVoices().catch(()=>({voices:[]}))
  if (d.voices?.length) {
    const selected = d.voices.find((voice) => voice.id === state.voiceId) || d.voices[0]
    state.voiceId = selected?.id || null
    const vl = document.getElementById('voice-label')
    if (vl && selected) vl.textContent = selected.name
  }
}

async function sendMessage(text) {
  if (!text?.trim()) return
  if (state.isSending) return

  state.isSending = true
  setComposerBusy(true)
  appendMessage('user', text)
  const inp = document.getElementById('chat-input')
  if (inp) inp.value = ''
  const loading = appendMessage('ai', '● ● ●', true)

  // 호출 응답 = 최우선 인터럽트 — 사용자가 부르면(메시지 전송) 하던 일을 멈추고
  // 컴퓨터 앞으로 와 앉아 마주본다. main.js가 onUserCall로 관할(성격 타이밍·priority).
  // 핸들러 없으면 기존 동작(쳐다보며 한 발 다가옴)으로 폴백.
  if (typeof _onUserCall === 'function') _onUserCall()
  else requestFaceCamera({ durationMs: 12000, approach: true })

  try {
    let reply = '백엔드가 연결되지 않아 오프라인 모드예요. 백엔드를 실행해주세요! 🔧'
    let emotion = 'neutral'

    let citations = []
    if (window.api) {
      const historyLimit = Math.max(1, Math.min(50, state.memoryTurns)) * 2
      // Per-message toggle wins over settings default. The toggle lives in
      // the chat panel header (chat-web-toggle); when absent or unchecked we
      // fall back to the saved default.
      const toggle = document.getElementById('chat-web-toggle')
      const useWeb = toggle ? toggle.checked : state.useWebDefault
      const r = await window.api.sendMessage(
        text, state.history.slice(-historyLimit), { useWeb }
      )
      if (r.reply) { reply = r.reply; emotion = r.emotion || 'neutral' }
      if (Array.isArray(r.citations)) citations = r.citations
      if (r.error) reply = '오류: ' + r.error
    }

    loading?.remove()
    appendMessage('ai', reply, false, citations)
    state.history.push({ role:'user', content:text }, { role:'assistant', content:reply })
    const localHistoryLimit = Math.max(1, Math.min(50, state.memoryTurns)) * 2
    if (state.history.length > localHistoryLimit) {
      state.history = state.history.slice(-localHistoryLimit)
    }

    _showBubble?.(reply.slice(0,50)+(reply.length>50?'...':''), 4000)
    _applyEmotion?.(emotion)
    const talkMotion = _getTalkMotion?.({ emotion, text: reply })
    await speakText(reply, talkMotion)
  } catch(e) {
    loading?.remove()
    appendMessage('ai', '오류가 발생했어요: ' + e.message)
  } finally {
    state.isSending = false
    setComposerBusy(false)
  }
}

function finishSpeakingMotion({ didEnterTalk = false } = {}) {
  _stopSpeaking?.()

  const previousState =
    state.speechReturnState && state.speechReturnState !== 'talk'
      ? state.speechReturnState
      : 'idle'

  state.speechReturnState = null

  if (didEnterTalk && getState?.() === 'talk') {
    setState(previousState)
  }

  if (didEnterTalk && previousState === 'idle') {
    restoreIdleMotion()
  }
}

async function speakText(text, talkMotion = null) {
  if (!window.api) return
  if (!state.ttsEnabled) return

  let didEnterTalk = false

  try {
    const r = await window.api.tts(text, state.voiceId)

    if (r?.disabled) {
      return
    }

    // 음성 복제 — 요청한 custom 음성이 아닌 대체 음성으로 합성된 경우
    // (모델 워밍업/변환 실패) 세션당 1회만 정직하게 알린다.
    if (r?.fallback && !state.voiceFallbackNotified && String(state.voiceId || '').startsWith('custom:')) {
      state.voiceFallbackNotified = true
      appendMessage('ai', '(설정한 캐릭터 음성을 준비하지 못해서 기본 음성으로 말했어요. 잠시 뒤 다시 적용될 수 있어요.)')
    }

    if (r.audio) {
      const bytes = atob(r.audio)
      const buf = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) {
        buf[i] = bytes.charCodeAt(i)
      }

      const audioUrl = URL.createObjectURL(new Blob([buf], { type: r.mime || 'audio/wav' }))
      const audio = new Audio(audioUrl)
      const cleanupAudio = () => {
        URL.revokeObjectURL(audioUrl)
      }

      // H단계 — 재생 전 비짐 분석. decodeAudioData가 버퍼를 detach하므로
      // Blob에 쓴 버퍼가 아니라 복제본을 넘긴다 (Codex MUST-FIX). 분석
      // 실패(null)면 lipsyncRuntime이 사인파 폴백으로 동작한다.
      const visemeTimeline = await analyzeWav(buf.buffer.slice(0))

      const previousState = getState?.()
      state.speechReturnState =
        previousState && previousState !== 'talk'
          ? previousState
          : 'idle'

      if (talkMotion && window.__applyMotion) {
        window.__applyMotion(talkMotion)
      }

      _startSpeaking?.()
      didEnterTalk = true
      setState('talk')

      await new Promise((resolve) => {
        let finished = false
        const finalizeAudio = () => {
          if (finished) return
          finished = true
          stopTimeline()
          cleanupAudio()
          finishSpeakingMotion({ didEnterTalk })
          resolve()
        }

        audio.onended = () => {
          finalizeAudio()
        }

        audio.onerror = () => {
          finalizeAudio()
        }

        // 타임라인은 재생이 실제로 시작된 뒤에 건다 — currentTime 보정으로
        // play() 지연을 흡수
        audio.play().then(() => {
          if (visemeTimeline) playTimeline(visemeTimeline, audio.currentTime || 0)
        }).catch(() => {
          finalizeAudio()
        })
      })
    }
  } catch (e) {
    finishSpeakingMotion({ didEnterTalk })
  }
}

function setupSTT(micBtn) {
  if (!micBtn) return
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    micBtn.title = '마이크 미지원'; return
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  const rec = new SR()
  rec.lang = 'ko-KR'; rec.continuous = false; rec.interimResults = false
  rec.onresult = e => {
    const text = e.results[0][0].transcript
    const inp = document.getElementById('chat-input')
    if (inp) inp.value = text
    sendMessage(text)
  }
  rec.onend = () => { state.isListening=false; micBtn.classList.remove('listening') }
  rec.onerror = () => { state.isListening=false; micBtn.classList.remove('listening') }

  micBtn.addEventListener('click', () => {
    if (state.isListening) rec.stop()
    else {
      state.isListening=true; micBtn.classList.add('listening')
      rec.start()
      _showBubble?.('듣고 있어요... 🎤', 2000)
    }
  })
}

function appendMessage(role, text, isLoading=false, citations=null) {
  const messages = document.getElementById('messages')
  if (!messages) return null
  const row = document.createElement('div'); row.className = `msg-row ${role}`
  const label = document.createElement('div'); label.className = 'msg-label'
  label.textContent = role==='ai' ? 'Apia' : '나'
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble'
  if (isLoading) bubble.style.opacity = '0.5'
  bubble.textContent = text
  row.appendChild(label); row.appendChild(bubble)
  if (Array.isArray(citations) && citations.length > 0) {
    row.appendChild(renderCitationChips(citations))
  }
  messages.appendChild(row)
  messages.scrollTop = messages.scrollHeight
  return row
}

// Codex MUST-FIX (frontend integration round 1): backend ChatCitation uses
// `source_path` for the URL (not `url`). Render a chip per marker; click
// opens the source via `window.api.openExternal`, which the main process
// gates to http/https only.
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

function restoreIdleMotion() {
  const idleMotion = _getIdleMotion?.()
  if (idleMotion && window.__applyMotion) {
    window.__applyMotion(idleMotion)
  }
}
