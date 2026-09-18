// src/chat.js - 채팅, STT, TTS
import { setState, getState } from './characterController.js'
import { setEmotion, requestFaceCamera } from './characterController.js'
import { analyzeWav, playTimeline, stopTimeline } from './lipsyncRuntime.js'
import { createTouchClassifier } from './touchInteraction.js'
import { toUserMessage, isActiveFrame, createSpeechQueue, parseSfx, SFX_KINDS, pollWhileVisible } from './chatShared.js'

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
  speechReturnState: null,
  // SSE 스트리밍 진행 상태(요청당 1개). requestId로 늦은 델타를 거른다.
  activeRequestId: null,
  streamRow: null,
  streamText: '',
  pendingUserText: '',
  pendingTalkMotion: null,
  // TTS 백그라운드 재생 중단용 공유 경로(task 2).
  activeAudio: null,
  abortSpeak: null,
  // 지금 재생 중인 발화의 우선순위('user' | 'ambient' | null). 관전 코멘트가
  // 사용자 답변을 끊지 않게 하는 판단에 쓴다.
  speakingPriority: null
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
  // 스트림 이벤트 구독(1회). 늦은 프레임은 requestId로 무시.
  window.api?.onChatStreamDelta?.((payload) => onStreamDelta(payload))
  window.api?.onChatStreamDone?.((payload) => onStreamDone(payload))
  window.api?.onChatStreamError?.((payload) => onStreamError(payload))
  // 창이 숨겨져 있는 동안은 폴링을 멈춘다(닫기=hide라 예전엔 계속 돌았다).
  pollWhileVisible(checkBackend, 5000)
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
    // 창이 가려지면 :hover도 raycast도 무의미 — 본체 스킵(rAF는 유지, 복귀 시 재개).
    // 단 캡처 중이었다면 먼저 마우스 통과를 복원해야 클릭이 데스크톱으로 샌다.
    if (document.hidden) {
      if (capturing) {
        clearTimeout(restoreTimer)
        restoreTimer = null
        capturing = false
        window.api?.setIgnoreMouse(true)
      }
      requestAnimationFrame(poll)
      return
    }
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
    window.api?.ledgerInputStart?.() // 계측 전용(눈치 원장) — 응답→입력 시작 지연
    // !e.isComposing — 한글 IME 조합 중 Enter는 확정용이라 전송하면 안 됨(task 4)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(chatInput.value) }
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

// 5초 헬스 폴링은 성공할 때마다 /voices를 부르고 있었다(하루 17,000회).
// 목소리 목록은 백엔드가 새로 올라올 때만 바뀌므로 오프라인→온라인 전이에서만
// 부른다(첫 성공 포함 — 초기값은 null).
let _backendOnline = null
async function checkBackend() {
  const statusEl = document.getElementById('backend-status')
  if (!statusEl) return
  if (!window.api) { statusEl.textContent = '개발 모드'; statusEl.className='offline'; return }
  const r = await window.api.checkBackend()
  if (r.ok) {
    statusEl.textContent = '● 연결됨'; statusEl.className = 'online'
    if (_backendOnline !== true) loadVoices()
    _backendOnline = true
  } else {
    statusEl.textContent = '● 백엔드 오프라인'; statusEl.className = 'offline'
    _backendOnline = false
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

  // 새 전송은 이전 TTS 재생을 즉시 끊는다(task 2 공유 abort).
  stopSpeakingNow()
  state.isSending = true
  setComposerBusy(true)
  appendMessage('user', text)
  const inp = document.getElementById('chat-input')
  if (inp) inp.value = ''
  const loadingRow = appendMessage('ai', '● ● ●', true)

  state.streamRow = loadingRow
  state.streamText = ''
  state.activeRequestId = null
  state.pendingUserText = text
  state.pendingTalkMotion = null

  // 호출 응답 = 최우선 인터럽트 — 사용자가 부르면(메시지 전송) 하던 일을 멈추고
  // 컴퓨터 앞으로 와 앉아 마주본다. main.js가 onUserCall로 관할(성격 타이밍·priority).
  // 핸들러 없으면 기존 동작(쳐다보며 한 발 다가옴)으로 폴백.
  if (typeof _onUserCall === 'function') _onUserCall()
  else requestFaceCamera({ durationMs: 12000, approach: true })

  if (!window.api?.chatStreamStart) {
    finalizeStream('백엔드가 연결되지 않아 오프라인 모드예요. 백엔드를 실행해주세요! 🔧', 'neutral', [], false)
    return
  }

  try {
    const historyLimit = Math.max(1, Math.min(50, state.memoryTurns)) * 2
    // Per-message toggle wins over settings default (chat-web-toggle header).
    const toggle = document.getElementById('chat-web-toggle')
    const useWeb = toggle ? toggle.checked : state.useWebDefault
    const r = await window.api.chatStreamStart(
      text, state.history.slice(-historyLimit), { useWeb }
    )
    state.activeRequestId = r?.requestId || null
    if (!state.activeRequestId) {
      finalizeStream(toUserMessage('backend unavailable'), 'neutral', [], false)
    }
  } catch (e) {
    finalizeStream(toUserMessage(e?.message || e), 'neutral', [], false)
  }
}

function onStreamDelta(payload) {
  if (!isActiveFrame(payload, state.activeRequestId) || !state.streamRow) return
  const bubble = state.streamRow.querySelector('.msg-bubble')
  if (state.streamText === '' && bubble) { bubble.classList.remove('typing'); bubble.textContent = '' }
  state.streamText += payload.text || ''
  if (bubble) bubble.textContent = state.streamText
  const messages = document.getElementById('messages')
  if (messages) messages.scrollTop = messages.scrollHeight
}

function onStreamDone(payload) {
  if (!isActiveFrame(payload, state.activeRequestId)) return
  const reply = payload.reply || state.streamText || '...'
  const emotion = payload.emotion || 'neutral'
  const citations = Array.isArray(payload.citations) ? payload.citations : []
  finalizeStream(reply, emotion, citations, true)
}

function onStreamError(payload) {
  if (!isActiveFrame(payload, state.activeRequestId)) return
  finalizeStream(toUserMessage(payload.error), 'neutral', [], false)
}

// 라이브 버블을 최종 내용으로 확정하고 컴포저를 즉시 푼다(task 2 — 답 텍스트
// 확정 시점에 잠금 해제). TTS는 success일 때만 백그라운드로(완료를 기다리지 않음).
function finalizeStream(reply, emotion, citations, speak) {
  const row = state.streamRow
  if (row) {
    const bubble = row.querySelector('.msg-bubble')
    if (bubble) { bubble.classList.remove('typing'); bubble.textContent = reply }
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
    _showBubble?.(reply.slice(0, 50) + (reply.length > 50 ? '...' : ''), 4000)
    _applyEmotion?.(emotion)
    const talkMotion = _getTalkMotion?.({ emotion, text: reply })
    // fire-and-forget: composer already unlocked, TTS/lipsync plays in background.
    speakText(reply, talkMotion)
  }
}

// 진행 중 오디오/립싱크를 즉시 중단(공유 abort 경로). 새 전송에서 호출.
function stopSpeakingNow() {
  if (state.abortSpeak) {
    const fn = state.abortSpeak
    state.abortSpeak = null
    try { fn() } catch {}
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

// 발화 진입점. 진행 중 재생을 끊고(barge-in) 큐에 태워 앞 발화의 상태 복원이
// 끝난 뒤에 다음이 시작하게 한다 — 중첩 재생·speechReturnState 오염 차단.
// 모든 호출자가 여기를 지나므로 자율 리액션 드라이버도 자동으로 보호된다.
const _speechQueue = createSpeechQueue()

// priority — 'user'는 사용자에게 답하는 말이라 무엇이든 끊고 반드시 나간다.
// 'ambient'는 관전 코멘트 같은 혼잣말이라 **사용자 발화를 절대 끊지 않고**,
// 앞선 혼잣말만 갈아치운다. 큐가 밀리면 낡은 혼잣말은 스스로 빠진다.
function speakText(text, talkMotion = null, { priority = 'user', sfx = null } = {}) {
  if (!window.api) return Promise.resolve()
  if (!state.ttsEnabled) return Promise.resolve()
  if (priority === 'user' || state.speakingPriority === 'ambient') stopSpeakingNow()
  return _speechQueue(() => _speakOnce(text, talkMotion, priority, sfx), { priority })
}

// M2 — [SFX:x] 클립. 같은 Edge-TTS 목소리로 의성어를 미리 합성해 캐시한다:
// 외부 음원을 쓰면 음색이 튀고 라이선스 부담도 생기는데, 같은 목소리로 뽑으면
// 이질감이 0이고 새 백엔드 코드도 0이다(기존 /tts를 그대로 부른다).
// ponytail: 캐시는 voiceId별. 목소리를 바꾸면 통째로 버린다.
const _sfxCache = new Map()
let _sfxCacheVoice = null

async function fetchSfxClip(kind) {
  const phrase = SFX_KINDS[kind]
  if (!phrase || !window.api?.tts) return null
  if (_sfxCacheVoice !== state.voiceId) { _sfxCache.clear(); _sfxCacheVoice = state.voiceId }
  if (_sfxCache.has(kind)) return _sfxCache.get(kind)
  try {
    const r = await window.api.tts(phrase, state.voiceId)
    const clip = (r && !r.disabled && r.audio) ? r : null
    _sfxCache.set(kind, clip) // null도 캐시 — 매 코멘트마다 실패를 재시도하지 않게
    return clip
  } catch {
    _sfxCache.set(kind, null)
    return null
  }
}

function playClip(r) {
  return new Promise((resolve) => {
    try {
      const bytes = atob(r.audio)
      const buf = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([buf], { type: r.mime || 'audio/wav' }))
      const a = new Audio(url)
      const done = () => { URL.revokeObjectURL(url); resolve() }
      a.onended = done
      a.onerror = done
      a.play().catch(done)
    } catch { resolve() }
  })
}

async function _speakOnce(text, talkMotion = null, priority = 'user', sfx = null) {
  let didEnterTalk = false
  state.speakingPriority = priority

  try {
    // 비언어 발성이 먼저 — "후후" 하고 나서 말이 이어져야 자연스럽다.
    // 클립이 없으면(합성 실패 등) 그냥 건너뛴다. 문장만으로도 말은 통한다.
    if (sfx) {
      const clip = await fetchSfxClip(sfx)
      if (clip) await playClip(clip)
    }
    if (!text) return
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
      state.activeAudio = audio
      const cleanupAudio = () => {
        URL.revokeObjectURL(audioUrl)
        if (state.activeAudio === audio) state.activeAudio = null
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
          state.abortSpeak = null
          try { audio.pause() } catch {}
          stopTimeline()
          cleanupAudio()
          finishSpeakingMotion({ didEnterTalk })
          resolve()
        }

        // 공유 abort 경로: stopSpeakingNow()가 재생을 즉시 끊을 수 있게 등록.
        state.abortSpeak = finalizeAudio

        audio.onended = () => {
          finalizeAudio()
        }

        audio.onerror = () => {
          finalizeAudio()
        }

        // 타임라인은 재생이 실제로 시작된 뒤에 건다 — currentTime 보정으로
        // play() 지연을 흡수
        audio.play().then(() => {
          // finished면 이미 abort된 발화다 — finalizeAudio가 stopTimeline까지
          // 끝낸 뒤 play()가 뒤늦게 resolve되면 소리 없는 입뻐끔이 남는다.
          // 큐 도입으로 barge-in이 상시 경로가 되면서 실제로 걸리는 창이다.
          if (finished) return
          if (visemeTimeline) playTimeline(visemeTimeline, audio.currentTime || 0)
        }).catch(() => {
          finalizeAudio()
        })
      })
    }
  } catch (e) {
    finishSpeakingMotion({ didEnterTalk })
  } finally {
    state.speakingPriority = null
  }
}

/**
 * M2 관전 코멘트 발화. [SFX:x]를 떼어 같은 목소리 클립을 먼저 흘리고, 남은
 * 문장을 평소 TTS/립싱크/표정 경로에 태운다. ambient라 사용자 발화를 안 끊는다.
 */
export function speakAmbient(rawText, talkMotion = null) {
  const { text, sfx } = parseSfx(rawText)
  if (!text && !sfx) return Promise.resolve()
  return speakText(text, talkMotion, { priority: 'ambient', sfx })
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

const MAX_MSG_ROWS = 200 // L단계 — 채팅 DOM 무한 누적 방지(오래된 행 프루닝)
function appendMessage(role, text, isLoading=false, citations=null) {
  const messages = document.getElementById('messages')
  if (!messages) return null
  const row = document.createElement('div'); row.className = `msg-row ${role}`
  const label = document.createElement('div'); label.className = 'msg-label'
  label.textContent = role==='ai' ? 'Apia' : '나'
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble'
  if (isLoading) bubble.classList.add('typing') // 대기 인디케이터 애니메이션(task 5)
  bubble.textContent = text
  row.appendChild(label); row.appendChild(bubble)
  if (Array.isArray(citations) && citations.length > 0) {
    row.appendChild(renderCitationChips(citations))
  }
  messages.appendChild(row)
  while (messages.children.length > MAX_MSG_ROWS) messages.firstElementChild?.remove()
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
