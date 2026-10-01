// src/micListener.js — 마이크 캡처 + VAD(음성 활동 감지) + WAV 인코딩 +
// 두 채팅 표면이 공유하는 마이크 컨트롤러(createMicController, 파일 맨 아래).
//
// 발주서 2단계: 기본 입력 마이크만, VAD로 발화 구간만 열고 무음이면 캡처 안 함
// (상시 녹음 아님). 발화 한 구간이 끝나면 그 PCM만 WAV로 묶어 onSegment로 넘긴다.
// **원음은 여기서도 저장하지 않는다** — 메모리 버퍼는 세그먼트를 넘기는 즉시 비운다.
// 시스템/루프백 오디오는 절대 잡지 않는다(getUserMedia 기본 마이크만) — 디스코드
// 같은 앱의 출력음은 애초에 이 파이프라인에 들어오지 않는다.

// ── 순수 VAD 상태기계 (DOM 없음 — node 단위 테스트 가능) ─────────────────────
//
// 에너지(RMS) 기반. 발화 시작 임계 이상이면 구간을 열고, 무음이 hangover만큼
// 이어지면 닫는다. 너무 짧은 구간(기침·클릭)은 버리고, 너무 긴 구간은 강제로 끊어
// STT가 한없이 커지지 않게 한다.
export function createVadSegmenter({
  onSegmentStart,
  onSegmentEnd,
  startThreshold = 0.02,   // 이 RMS 이상이면 발화 시작
  endThreshold = 0.012,    // 이 RMS 미만이면 무음(히스테리시스로 시작보다 낮게)
  hangoverMs = 700,        // 무음이 이만큼 이어지면 구간 종료
  minSpeechMs = 300,       // 이보다 짧은 구간은 잡음으로 버린다
  maxSegmentMs = 15000     // 이보다 길면 강제 종료(구간을 끊어 다음으로)
} = {}) {
  let inSpeech = false
  let speechStartT = 0
  let lastVoiceT = 0

  function reset() { inSpeech = false; speechStartT = 0; lastVoiceT = 0 }

  /** RMS 한 프레임 투입. 이벤트가 나면 'start'|'end' 문자열, 없으면 null. */
  function feed(rms, tMs) {
    if (!inSpeech) {
      if (rms >= startThreshold) {
        inSpeech = true
        speechStartT = tMs
        lastVoiceT = tMs
        onSegmentStart?.(tMs)
        return 'start'
      }
      return null
    }
    // 발화 중
    if (rms >= endThreshold) lastVoiceT = tMs
    const silentFor = tMs - lastVoiceT
    const speechLen = tMs - speechStartT
    if (silentFor >= hangoverMs || speechLen >= maxSegmentMs) {
      inSpeech = false
      const durationMs = lastVoiceT - speechStartT
      const kept = durationMs >= minSpeechMs
      onSegmentEnd?.({ startT: speechStartT, endT: lastVoiceT, durationMs, kept, forced: speechLen >= maxSegmentMs })
      return 'end'
    }
    return null
  }

  return { feed, reset, isSpeaking: () => inSpeech }
}

// ── WAV 인코딩 (16-bit PCM mono) ─────────────────────────────────────────────
// Float32 [-1,1] 샘플 → 표준 PCM WAV ArrayBuffer. 백엔드 whisper가 읽는 포맷.
export function encodeWav(samples, sampleRate) {
  const len = samples.length
  const buffer = new ArrayBuffer(44 + len * 2)
  const view = new DataView(buffer)
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + len * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)      // PCM chunk size
  view.setUint16(20, 1, true)       // PCM
  view.setUint16(22, 1, true)       // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true)       // block align
  view.setUint16(34, 16, true)      // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, len * 2, true)
  let off = 44
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return buffer
}

function rmsOf(frame) {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

// ── 캡처 래퍼 (DOM/Web Audio) ────────────────────────────────────────────────
//
// onSegment(wavArrayBuffer)로 발화 한 구간의 WAV를 넘긴다. 넘긴 즉시 버퍼를 비운다.
export function createMicListener({ onSegment, onError, vad = {} } = {}) {
  let stream = null
  let ctx = null
  let node = null
  let source = null
  let segmenter = null
  let running = false
  let sampleRate = 16000
  let chunks = [] // 현재 발화 구간의 Float32 프레임들
  // getUserMedia 대기 중 stop()이 끼어드는 레이스 차단용 세대 토큰. 대기가 끝났을 때
  // 세대가 바뀌어 있으면(그새 stop 또는 새 start) 방금 받은 스트림을 즉시 반납한다 —
  // 안 그러면 "표시등은 꺼졌는데 OS 마이크는 켜진" 캡처가 남는다(astra MUST-FIX).
  let epoch = 0

  async function start() {
    if (running) return true
    const myEpoch = ++epoch
    let acquired
    try {
      // 기본 마이크만. video 없음, 시스템/루프백 오디오 없음.
      acquired = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch (error) {
      onError?.(error)
      return false
    }
    if (myEpoch !== epoch) {
      try { acquired.getTracks().forEach((t) => t.stop()) } catch {}
      return false
    }
    stream = acquired
    ctx = new (window.AudioContext || window.webkitAudioContext)()
    sampleRate = ctx.sampleRate
    source = ctx.createMediaStreamSource(stream)
    // ponytail: ScriptProcessorNode는 deprecated지만 별도 worklet 모듈 파일 없이
    // 바로 PCM 프레임을 준다. 프레임 드랍이 문제되면 AudioWorklet로 승급.
    const frameSize = 2048
    node = ctx.createScriptProcessor(frameSize, 1, 1)
    segmenter = createVadSegmenter({
      ...vad,
      onSegmentStart: () => { chunks = [] },
      onSegmentEnd: ({ kept }) => {
        const captured = chunks
        chunks = [] // 원음 버퍼 즉시 비움
        if (!kept || captured.length === 0) return
        let total = 0
        for (const c of captured) total += c.length
        const merged = new Float32Array(total)
        let off = 0
        for (const c of captured) { merged.set(c, off); off += c.length }
        try { onSegment?.(encodeWav(merged, sampleRate)) } catch (error) { onError?.(error) }
      }
    })
    node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      const tMs = ctx.currentTime * 1000
      const before = segmenter.isSpeaking()
      const evt = segmenter.feed(rmsOf(input), tMs)
      // 발화 중이면 프레임을 쌓는다(start를 낸 이 프레임도 포함).
      if (segmenter.isSpeaking() || (before && evt === 'end')) chunks.push(new Float32Array(input))
    }
    source.connect(node)
    node.connect(ctx.destination)
    running = true
    return true
  }

  function stop() {
    epoch++ // 대기 중인 start()가 있으면 무효화(스트림은 그쪽이 반납)
    running = false
    try { node && (node.onaudioprocess = null) } catch {}
    try { source?.disconnect() } catch {}
    try { node?.disconnect() } catch {}
    try { ctx?.close() } catch {}
    try { stream?.getTracks().forEach((t) => t.stop()) } catch {}
    stream = null; ctx = null; node = null; source = null; segmenter = null; chunks = []
  }

  // ponytail: 일시정지(pause)는 두지 않는다. "잠깐 멈춤"도 stop()으로 스트림을
  // 완전히 놓는다 — 그래야 OS의 마이크 사용 표시까지 꺼져서 "듣고 있는지"가
  // 화면 밖에서도 정직해진다. 다시 켤 때 getUserMedia를 한 번 더 부르는 비용은
  // 그 정직함 값으로 싸다.
  return { start, stop, isRunning: () => running }
}

// ── 마이크 컨트롤러 (두 채팅 표면 공용) ──────────────────────────────────────
//
// 프라이버시 계약(발주서 12 §C-2)이 **여기 한 곳에** 있다. 벽지 채팅창
// (chatRenderer.js)과 인월드 채팅(chat.js)이 각자 이 판단을 들고 있으면 한쪽만
// 고쳐져서 "표시등이 안 보이는데 듣고 있는 창"이 생긴다.
//   ① 기본 OFF — settings.micEnabled를 사용자가 직접 켠다.
//   ② 표시등 = 캡처의 동어반복 — 표시등(🎤)이 실제로 보이는 상태에서만 캡처가
//      돈다. "보인다"의 정의만 표면마다 달라서 isSurfaceVisible로 주입받는다
//      (벽지 창은 main의 chat:visibility, 인월드는 패널 열림 + 창 비은닉).
//      fail-closed: 아직 모르면 false를 돌려줄 것.
//   ③ 원음 무저장 — createMicListener가 세그먼트를 넘기는 즉시 버퍼를 비우고,
//      main의 stt:transcribe도 디스크에 쓰지 않는다. 남는 건 전사 텍스트뿐.
//
// onText(text) — 전사된 한 문장. 표면이 자기 채팅 전송 경로로 흘린다.
// getButton() — 표시등으로 쓸 🎤 버튼(없어도 동작은 한다).
const EAR_CLOSE_RE = /귀\s*(좀\s*)?닫아|그만\s*들어/

export function createMicController({ onText, isSurfaceVisible, getButton } = {}) {
  let enabled = false
  let paused = false
  let mic = null

  const shouldListen = () => enabled && !paused && isSurfaceVisible?.() === true

  function updateIndicator() {
    const btn = getButton?.()
    if (!btn) return
    btn.style.display = enabled ? '' : 'none'
    btn.classList.toggle('listening', shouldListen() && !!mic?.isRunning?.())
    btn.title = !enabled ? '음성 듣기 꺼짐(설정에서 켜기)'
      : paused ? '멈춤 — 눌러서 다시 듣기'
        : '듣는 중 — 눌러서 멈춤("귀 닫아")'
  }

  function sync() {
    if (shouldListen()) {
      if (!mic) {
        mic = createMicListener({
          onSegment: (wav) => { if (shouldListen()) transcribeAndRoute(wav) },
          onError: (error) => console.warn('[mic] capture error', error)
        })
      }
      if (!mic.isRunning()) mic.start().then(() => updateIndicator())
      else updateIndicator()
    } else {
      // 멈춤은 일시정지가 아니라 완전 정지 — 스트림을 놓아 OS 마이크 표시도 끈다.
      mic?.stop?.()
      if (!enabled) paused = false
      updateIndicator()
    }
  }

  // 전사된 텍스트는 채팅 입력으로만 간다("내가 말하면 받아 적어 전송").
  // "귀 닫아"는 전송하지 않고 멈춤으로만 쓴다 — 멈추라는 말이 대화로 새지 않게.
  function routeTranscript(text) {
    const t = String(text || '').trim()
    if (!t) return
    if (EAR_CLOSE_RE.test(t)) { paused = true; sync(); return }
    if (!shouldListen()) return
    onText?.(t)
  }

  async function transcribeAndRoute(wav) {
    try {
      const r = await window.api?.mic?.transcribe?.(wav)
      routeTranscript(r?.text)
    } catch (error) {
      console.warn('[mic] transcribe failed', error)
    }
  }

  return {
    sync,
    setEnabled(on) { enabled = on === true; sync() },
    togglePause() { paused = !paused; sync() },
    isEnabled: () => enabled,
    shouldListen,
    routeTranscript,
    transcribeAndRoute
  }
}
