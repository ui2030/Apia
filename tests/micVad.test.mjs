// 마이크 VAD 상태기계 + WAV 인코딩 단위 테스트. DOM/Web Audio를 안 건드리는
// 순수 부분만 검증한다(캡처 래퍼는 실기/GUI 검증 몫).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createVadSegmenter, encodeWav, createMicController, createMicListener } from '../src/micListener.js'

describe('createVadSegmenter', () => {
  it('opens a segment above start threshold and closes after hangover of silence', () => {
    const events = []
    const seg = createVadSegmenter({
      startThreshold: 0.02, endThreshold: 0.012, hangoverMs: 700, minSpeechMs: 300, maxSegmentMs: 15000,
      onSegmentStart: (t) => events.push(['start', t]),
      onSegmentEnd: (e) => events.push(['end', e])
    })
    // 무음 → 발화 시작
    expect(seg.feed(0.005, 0)).toBeNull()
    expect(seg.feed(0.05, 100)).toBe('start')
    expect(seg.isSpeaking()).toBe(true)
    // 발화 지속
    seg.feed(0.04, 400)
    seg.feed(0.03, 700)
    // 무음 시작 — hangover(700ms) 전엔 안 닫힌다
    expect(seg.feed(0.001, 1000)).toBeNull()
    expect(seg.isSpeaking()).toBe(true)
    // hangover 경과 → 종료
    expect(seg.feed(0.001, 1500)).toBe('end')
    expect(seg.isSpeaking()).toBe(false)
    const end = events.find((e) => e[0] === 'end')[1]
    expect(end.kept).toBe(true) // 700ms 발화 > minSpeechMs
  })

  it('discards a segment shorter than minSpeechMs', () => {
    let last = null
    const seg = createVadSegmenter({
      startThreshold: 0.02, endThreshold: 0.012, hangoverMs: 500, minSpeechMs: 300,
      onSegmentEnd: (e) => { last = e }
    })
    seg.feed(0.05, 0)      // start
    seg.feed(0.001, 100)   // 짧은 발화 뒤 무음
    seg.feed(0.001, 700)   // hangover 경과 → 종료(발화 길이 ~100ms)
    expect(last.kept).toBe(false)
  })

  it('force-closes an over-long segment', () => {
    let last = null
    const seg = createVadSegmenter({
      startThreshold: 0.02, endThreshold: 0.012, hangoverMs: 5000, maxSegmentMs: 1000, minSpeechMs: 100,
      onSegmentEnd: (e) => { last = e }
    })
    seg.feed(0.05, 0)
    seg.feed(0.05, 500)
    const evt = seg.feed(0.05, 1200) // 계속 말해도 maxSegmentMs 넘으면 끊는다
    expect(evt).toBe('end')
    expect(last.forced).toBe(true)
  })
})

// 두 채팅 표면이 공유하는 게이트. 여기가 새면 "표시등이 안 보이는데 듣는 창"이
// 생기므로, 버튼(DOM) 없이도 판단만 단독 검증한다.
describe('createMicController', () => {
  // node 환경엔 navigator.mediaDevices가 없어서 실제 캡처 시도는 곱게 실패한다
  // (그 실패 처리도 계약의 일부다). 예상된 경고라 로그만 삼킨다.
  let warn
  beforeAll(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterAll(() => warn.mockRestore())

  const make = (visible = true) => {
    const sent = []
    const ctl = createMicController({
      onText: (t) => sent.push(t),
      isSurfaceVisible: () => visible
    })
    return { ctl, sent }
  }

  it('기본 OFF — 켜지 않으면 듣지도, 전사를 흘리지도 않는다', () => {
    const { ctl, sent } = make(true)
    expect(ctl.isEnabled()).toBe(false)
    expect(ctl.shouldListen()).toBe(false)
    ctl.routeTranscript('안녕')
    expect(sent).toEqual([])
  })

  it('켜고 표면이 보이면 전사가 채팅으로 간다', () => {
    const { ctl, sent } = make(true)
    ctl.setEnabled(true)
    expect(ctl.shouldListen()).toBe(true)
    ctl.routeTranscript('  안녕 반가워  ')
    expect(sent).toEqual(['안녕 반가워'])
  })

  it('표면이 안 보이면 켜져 있어도 듣지 않는다(표시등 = 캡처)', () => {
    const { ctl, sent } = make(false)
    ctl.setEnabled(true)
    expect(ctl.shouldListen()).toBe(false)
    ctl.routeTranscript('몰래 들은 말')
    expect(sent).toEqual([])
  })

  it('"귀 닫아"는 전송하지 않고 멈춤으로만 쓴다', () => {
    const { ctl, sent } = make(true)
    ctl.setEnabled(true)
    ctl.routeTranscript('이제 귀 좀 닫아')
    expect(sent).toEqual([])
    expect(ctl.shouldListen()).toBe(false)
    ctl.togglePause()                      // 버튼으로 재개
    expect(ctl.shouldListen()).toBe(true)
  })

  it('마스터를 끄면 멈춤도 함께 풀린다(다시 켤 때 이유 없이 벙어리이지 않게)', () => {
    const { ctl } = make(true)
    ctl.setEnabled(true)
    ctl.togglePause()
    expect(ctl.shouldListen()).toBe(false)
    ctl.setEnabled(false)
    ctl.setEnabled(true)
    expect(ctl.shouldListen()).toBe(true)
  })
})

describe('createMicListener — getUserMedia 레이스', () => {
  it('대기 중 stop()이 끼어들면 뒤늦게 받은 스트림을 즉시 반납한다(fail-closed)', async () => {
    // 표시등이 꺼진 뒤 OS가 마이크를 내주는 시나리오 — 여기서 캡처가 살아남으면
    // "표시등 없는데 듣는 창"이 된다(astra MUST-FIX 회귀 테스트).
    let resolveGum
    const trackStop = vi.fn()
    const fakeStream = { getTracks: () => [{ stop: trackStop }] }
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => new Promise((r) => { resolveGum = r }) }
    })
    try {
      const mic = createMicListener({})
      const pending = mic.start()
      mic.stop()               // 대기 중 취소(숨김/끄기)
      resolveGum(fakeStream)   // OS가 뒤늦게 스트림을 내준다
      expect(await pending).toBe(false)
      expect(trackStop).toHaveBeenCalled() // 즉시 반납 — OS 마이크 표시도 꺼진다
      expect(mic.isRunning()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('start()가 겹치면 이긴(나중) 쪽만 남고 진 쪽 스트림은 반납된다', async () => {
    const resolvers = []
    const stops = [vi.fn(), vi.fn()]
    const streamOf = (i) => ({ getTracks: () => [{ stop: stops[i] }] })
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => new Promise((r) => { resolvers.push(r) }) }
    })
    // 진 쪽은 스트림만 반납하고 끝나므로 AudioContext는 이긴 쪽에서만 필요하다 —
    // 최소 가짜로 스텁한다.
    vi.stubGlobal('window', {
      AudioContext: class {
        constructor() { this.sampleRate = 16000 }
        createMediaStreamSource() { return { connect() {}, disconnect() {} } }
        createScriptProcessor() { return { connect() {}, disconnect() {} } }
        close() {}
      }
    })
    try {
      const mic = createMicListener({})
      const first = mic.start()
      const second = mic.start() // running이 아직 false라 겹칠 수 있다
      resolvers[1](streamOf(1))  // 나중 start(현 세대)가 먼저 도착
      expect(await second).toBe(true)
      resolvers[0](streamOf(0))  // 이전 세대가 뒤늦게 도착
      expect(await first).toBe(false)
      expect(stops[0]).toHaveBeenCalled()     // 진 쪽 즉시 반납
      expect(stops[1]).not.toHaveBeenCalled() // 이긴 쪽은 계속 듣는다
      expect(mic.isRunning()).toBe(true)
      mic.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('encodeWav', () => {
  it('writes a valid 16-bit PCM mono WAV header', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const buf = encodeWav(samples, 16000)
    const view = new DataView(buf)
    const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n))
    expect(str(0, 4)).toBe('RIFF')
    expect(str(8, 4)).toBe('WAVE')
    expect(str(36, 4)).toBe('data')
    expect(view.getUint16(20, true)).toBe(1)      // PCM
    expect(view.getUint16(22, true)).toBe(1)      // mono
    expect(view.getUint32(24, true)).toBe(16000)  // sample rate
    expect(view.getUint16(34, true)).toBe(16)     // bits
    expect(buf.byteLength).toBe(44 + samples.length * 2)
    // clamp 확인 — +1.0은 0x7fff, -1.0은 -0x8000
    expect(view.getInt16(44 + 3 * 2, true)).toBe(0x7fff)
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-0x8000)
  })
})
