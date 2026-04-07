// src/chat.js - 채팅, STT, TTS
import { setState, getState } from './characterController.js'
import { setEmotion } from './characterController.js'
let _showBubble, _startSpeaking, _stopSpeaking, _applyEmotion
let _getTalkMotion, _getIdleMotion

const state = {
  chatOpen: false,
  history: [],
  voiceId: null,
  isListening: false
}

export function initChat({
  showBubble,
  startSpeaking,
  stopSpeaking,
  applyEmotion,
  getTalkMotion,
  getIdleMotion
}) {
  _showBubble = showBubble
  _startSpeaking = startSpeaking
  _stopSpeaking = stopSpeaking
  _applyEmotion = applyEmotion
  _getTalkMotion = getTalkMotion
  _getIdleMotion = getIdleMotion

  setupUI()
  startClickThroughManager()
  checkBackend()
  setInterval(checkBackend, 5000)
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

  function poll() {
    // :hover 셀렉터로 현재 마우스가 올라간 UI 확인
    const hovered = document.querySelector(
      '#chat-toggle:hover, #settings-btn:hover, ' +
      '#chat-panel.visible:hover, .world-object:hover'
    )

    if (hovered && !capturing) {
      // UI 위에 진입 → 클릭 수신 시작
      capturing = true
      clearTimeout(restoreTimer)
      window.api?.setIgnoreMouse(false)

    } else if (!hovered && capturing) {
      // UI 밖으로 나감 → 지연 후 클릭 통과 복원
      if (!restoreTimer) {
        restoreTimer = setTimeout(() => {
          restoreTimer = null
          // 타이머 만료 시점에 재확인
          const stillHovered = document.querySelector(
            '#chat-toggle:hover, #settings-btn:hover, ' +
            '#chat-panel.visible:hover, .world-object:hover'
          )
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

  // 캐릭터 근접 감지 (말풍선 전용)
  window.addEventListener('mousemove', (e) => {
    const nearChar = Math.hypot(
      e.clientX - (window.innerWidth - 140),
      e.clientY - (window.innerHeight - 250)
    ) < 150
    if (window.__onCharNearChange && nearChar !== window.__lastNearChar) {
      window.__lastNearChar = nearChar
      window.__onCharNearChange(nearChar)
    }
  })
}

function setupUI() {
  const chatToggle  = document.getElementById('chat-toggle')
  const settingsBtn = document.getElementById('settings-btn')
  const chatPanel   = document.getElementById('chat-panel')
  const chatInput   = document.getElementById('chat-input')
  const sendBtn     = document.getElementById('send-btn')
  const micBtn      = document.getElementById('mic-btn')

  chatToggle?.addEventListener('click', () => {
    state.chatOpen = !state.chatOpen
    chatPanel?.classList.toggle('visible', state.chatOpen)
    if (state.chatOpen) chatInput?.focus()
  })

  settingsBtn?.addEventListener('click', () => window.api?.openSettings())

  chatInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(chatInput.value) }
  })
  sendBtn?.addEventListener('click', () => sendMessage(chatInput?.value || ''))

  setupSTT(micBtn)
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
    state.voiceId = d.voices[0].id
    const vl = document.getElementById('voice-label')
    if (vl) vl.textContent = d.voices[0].name
  }
}

async function sendMessage(text) {
  if (!text?.trim()) return
  appendMessage('user', text)
  const inp = document.getElementById('chat-input')
  if (inp) inp.value = ''
  const loading = appendMessage('ai', '● ● ●', true)

  try {
    let reply = '백엔드가 연결되지 않아 오프라인 모드예요. 백엔드를 실행해주세요! 🔧'
    let emotion = 'neutral'

    if (window.api) {
      const r = await window.api.sendMessage(text, state.history)
      if (r.reply) { reply = r.reply; emotion = r.emotion || 'neutral' }
      if (r.error) reply = '오류: ' + r.error
    }

    loading.remove()
    appendMessage('ai', reply)
    state.history.push({ role:'user', content:text }, { role:'assistant', content:reply })
    if (state.history.length > 40) state.history = state.history.slice(-40)

    _showBubble?.(reply.slice(0,50)+(reply.length>50?'...':''), 4000)
    _applyEmotion?.(emotion)
    await speakText(reply)
    const talkMotion = _getTalkMotion?.({ emotion, text: reply })
    if (talkMotion && window.__applyMotion) {
      window.__applyMotion(talkMotion)
    }
  } catch(e) {
    loading.remove()
    appendMessage('ai', '오류가 발생했어요: ' + e.message)
  }
}

function startAutoWalkWhileSpeaking() {
  const x = (Math.random() * 5.2) - 2.6   // 대충 화면 안 범위
  const z = 1.2 + (Math.random() * 3.8)   // 카메라 앞쪽 범위

  walkTo({ x, z })
}

function finishSpeakingMotion() {
  _stopSpeaking?.()

  const s = getState?.()
  if (s !== 'walk' && s !== 'sit') {
    setState('idle')
  }
}

async function speakText(text) {
  if (!window.api) return

  try {
    _startSpeaking?.()

    const r = await window.api.tts(text)

    if (r.audio) {
      const bytes = atob(r.audio)
      const buf = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) {
        buf[i] = bytes.charCodeAt(i)
      }

      const audio = new Audio(
        URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
      )

      audio.onended = () => {
        _stopSpeaking?.()
        restoreIdleMotion()
        if (getState?.() === 'talk') setState('idle')
      }

      setState('talk')

      audio.play().catch(() => {
        _stopSpeaking?.()
        restoreIdleMotion()
        if (getState?.() === 'talk') setState('idle')
      })
    } else {
      _stopSpeaking?.()
      restoreIdleMotion()
      if (getState?.() === 'talk') setState('idle')
    }
  } catch (e) {
    _stopSpeaking?.()
    restoreIdleMotion()
    if (getState?.() === 'talk') setState('idle')
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

function appendMessage(role, text, isLoading=false) {
  const messages = document.getElementById('messages')
  if (!messages) return null
  const row = document.createElement('div'); row.className = `msg-row ${role}`
  const label = document.createElement('div'); label.className = 'msg-label'
  label.textContent = role==='ai' ? 'Apia' : '나'
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble'
  if (isLoading) bubble.style.opacity = '0.5'
  bubble.textContent = text
  row.appendChild(label); row.appendChild(bubble)
  messages.appendChild(row)
  messages.scrollTop = messages.scrollHeight
  return row
}

function restoreIdleMotion() {
  const idleMotion = _getIdleMotion?.()
  if (idleMotion && window.__applyMotion) {
    window.__applyMotion(idleMotion)
  }
}