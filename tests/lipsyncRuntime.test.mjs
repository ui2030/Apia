import { describe, it, expect } from 'vitest'
import { isWavBuffer, analyzeWav, updateMouthMMD, stopTimeline } from '../src/lipsyncRuntime.js'

describe('updateMouthMMD — 클립 소유 입 모프 양보', () => {
  function mouthModel() {
    const morphs = { 'あ': 0, 'い': 1, 'う': 2, 'え': 3, 'お': 4 }
    const influences = new Array(5).fill(0)
    return { model: { type: 'mmd', obj: { morphTargetInfluences: influences }, morphs }, influences, morphs }
  }

  it('발화 중이 아니면 클립이 연기하는 입 모프를 덮지 않는다', () => {
    stopTimeline?.()
    const { model, influences, morphs } = mouthModel()
    model._vmdClipActive = true
    model._clipMorphNames = new Set(['あ'])
    influences[morphs['あ']] = 0.6 // 클립(mixer)이 연기한 입 벌림
    for (let i = 0; i < 30; i++) updateMouthMMD(model, 1 / 60, false, 0)
    expect(influences[morphs['あ']]).toBe(0.6) // 0으로 감쇠시키지 않음(양보)
  })

  it('폴백 발화 중엔 립싱크가 우선한다(말이 주인)', () => {
    stopTimeline?.()
    const { model, influences, morphs } = mouthModel()
    model._vmdClipActive = true
    model._clipMorphNames = new Set(['あ'])
    influences[morphs['あ']] = 0.6
    for (let i = 0; i < 30; i++) updateMouthMMD(model, 1 / 60, true, Math.PI / 2) // 사인파 폴백 발화
    expect(influences[morphs['あ']]).toBeGreaterThan(0.3) // 립싱크가 구동
    expect(influences[morphs['あ']]).not.toBe(0.6) // 클립 값 그대로가 아님
  })
})

// 'RIFF' <size> 'WAVE' header, then arbitrary tail.
function wavHeader(extraBytes = 0) {
  const buf = new Uint8Array(12 + extraBytes)
  buf.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  buf.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  return buf.buffer
}

function bytes(arr) {
  return new Uint8Array(arr).buffer
}

describe('isWavBuffer — only RIFF/WAVE passes the decode gate', () => {
  it('accepts a real WAV header', () => {
    expect(isWavBuffer(wavHeader(64))).toBe(true)
  })

  it('rejects MP3 with an ID3 tag', () => {
    // 'ID3' + version/flags + padding
    expect(isWavBuffer(bytes([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0, 0, 0]))).toBe(false)
  })

  it('rejects bare-MP3 frame sync (0xFF 0xFB ...)', () => {
    expect(isWavBuffer(bytes([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false)
  })

  it('rejects RIFF that is not WAVE (e.g. AVI/WEBP)', () => {
    const b = new Uint8Array(12)
    b.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
    b.set([0x41, 0x56, 0x49, 0x20], 8) // 'AVI '
    expect(isWavBuffer(b.buffer)).toBe(false)
  })

  it('rejects too-short buffers', () => {
    expect(isWavBuffer(bytes([0x52, 0x49, 0x46, 0x46]))).toBe(false)
  })

  it('rejects non-ArrayBuffer input', () => {
    expect(isWavBuffer(null)).toBe(false)
    expect(isWavBuffer(new Uint8Array(12))).toBe(false) // a view, not an ArrayBuffer
  })
})

describe('analyzeWav — non-WAV short-circuits to null without decoding', () => {
  it('returns null for MP3 without throwing (never reaches decodeAudioData)', async () => {
    // No OfflineAudioContext in Node — if the gate failed and decode ran, this
    // would throw. The gate must return null first.
    await expect(analyzeWav(bytes([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).resolves.toBeNull()
  })

  it('returns null for non-ArrayBuffer input', async () => {
    await expect(analyzeWav(null)).resolves.toBeNull()
  })
})
