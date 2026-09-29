// 마이크 VAD 상태기계 + WAV 인코딩 단위 테스트. DOM/Web Audio를 안 건드리는
// 순수 부분만 검증한다(캡처 래퍼는 실기/GUI 검증 몫).
import { describe, it, expect } from 'vitest'
import { createVadSegmenter, encodeWav } from '../src/micListener.js'

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
