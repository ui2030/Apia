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

const state = {
  history: [],
  voiceId: null,
  ttsEnabled: true,
  memoryTurns: 10,
  useWebDefault: false,
  isSending: false
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
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      sendMessage(input.value)
    }
  })
  // Close = hide. Window stays alive in memory so reopen is instant; main
  // process listens for `chat:hide` to swap the visibility flag.
  closeBtn?.addEventListener('click', () => {
    window.api?.chatHide?.()
  })
}

function setComposerBusy(busy) {
  const sendBtn = document.getElementById('send-btn')
  const input = document.getElementById('chat-input')
  if (sendBtn) sendBtn.disabled = busy
  if (input) input.disabled = busy
}

async function sendMessage(text) {
  if (!text?.trim() || state.isSending) return
  state.isSending = true
  setComposerBusy(true)
  appendMessage('user', text)
  const input = document.getElementById('chat-input')
  if (input) input.value = ''
  const loading = appendMessage('ai', '● ● ●', true)

  let reply = '백엔드 연결 실패. 잠시 후 다시 시도해주세요.'
  let emotion = 'neutral'
  let citations = []

  try {
    if (window.api) {
      const historyLimit = Math.max(1, Math.min(50, state.memoryTurns)) * 2
      const toggle = document.getElementById('chat-web-toggle')
      const useWeb = toggle ? toggle.checked : state.useWebDefault
      const r = await window.api.sendMessage(
        text, state.history.slice(-historyLimit), { useWeb }
      )
      if (r?.reply) { reply = r.reply; emotion = r.emotion || 'neutral' }
      if (Array.isArray(r?.citations)) citations = r.citations
      if (r?.error) reply = '오류: ' + r.error
    }
  } catch (error) {
    reply = '오류가 발생했어요: ' + (error?.message || error)
  } finally {
    loading?.remove()
    appendMessage('ai', reply, false, citations)
    state.history.push(
      { role: 'user', content: text },
      { role: 'assistant', content: reply }
    )
    const localHistoryLimit = Math.max(1, Math.min(50, state.memoryTurns)) * 2
    if (state.history.length > localHistoryLimit) {
      state.history = state.history.slice(-localHistoryLimit)
    }

    // Side effects on the wallpaper character — emotion + face-camera +
    // bubble. Action allowlist enforced on the main-process IPC handler.
    window.api?.notifyCharacter?.({ action: 'emotion', value: emotion })
    window.api?.notifyCharacter?.({
      action: 'bubble',
      text: reply.slice(0, 50) + (reply.length > 50 ? '...' : '')
    })
    window.api?.notifyCharacter?.({
      action: 'face-camera',
      durationMs: 12000
    })

    await speakWithLipsync(reply)
    state.isSending = false
    setComposerBusy(false)
  }
}

async function speakWithLipsync(text) {
  if (!window.api?.tts || !state.ttsEnabled) return
  let audio = null
  let audioUrl = null
  let started = false
  try {
    const r = await window.api.tts(text, state.voiceId)
    if (r?.disabled || !r?.audio) return
    const bytes = atob(r.audio)
    const buf = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i += 1) buf[i] = bytes.charCodeAt(i)
    audioUrl = URL.createObjectURL(new Blob([buf], { type: r.mime || 'audio/wav' }))
    audio = new Audio(audioUrl)

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
        resolve()
      }
      audio.onended = finish
      audio.onerror = finish
      audio.play().then(() => {
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
  }
}

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
  if (isLoading) bubble.style.opacity = '0.5'
  bubble.textContent = text
  row.appendChild(label)
  row.appendChild(bubble)
  if (Array.isArray(citations) && citations.length > 0) {
    row.appendChild(renderCitationChips(citations))
  }
  messages.appendChild(row)
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

init()
