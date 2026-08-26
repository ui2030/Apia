// VMD fade-handler drain (memory-leak fix): non-loop VMD 클립이 supersede/해제/
// 모델정리로 finished 없이 사라질 때 helper-소유 mixer에 건 리스너가 잔류하던
// 누수. clearVMDFadeHandlers가 저장한 그 mixer에서 정확히 떼는지 검증.
import { describe, it, expect, beforeEach } from 'vitest'
import { AnimationClip, AnimationMixer, Object3D, VectorKeyframeTrack } from 'three'
import {
  clearVMDFadeHandlers,
  cachedVmdClip,
  clearClipCache,
  prepareVmdClip,
  playVRMAnimation,
  playFBXAnimation,
} from '../src/animationRuntime.js'

function fakeMixer() {
  const removed = []
  return {
    removed,
    removeEventListener(type, h) { removed.push([type, h]) },
  }
}

describe('clearVMDFadeHandlers', () => {
  it('removes each handler from its own mixer and empties the set', () => {
    const m1 = fakeMixer()
    const m2 = fakeMixer()
    const h1 = () => {}
    const h2 = () => {}
    const model = { _vmdFadeHandlers: new Set([
      { mixer: m1, handler: h1 },
      { mixer: m2, handler: h2 },
    ]) }

    clearVMDFadeHandlers(model)

    expect(m1.removed).toEqual([['finished', h1]])
    expect(m2.removed).toEqual([['finished', h2]])
    expect(model._vmdFadeHandlers.size).toBe(0)
  })

  it('is a no-op when no handler set exists', () => {
    expect(() => clearVMDFadeHandlers({})).not.toThrow()
    expect(() => clearVMDFadeHandlers(null)).not.toThrow()
  })
})

// ── VMD 클립 캐시 ──────────────────────────────────────────────────────
// 자율 행동이 9~16초마다 클립을 트는데 예전엔 매번 같은 .vmd를 다시 받아
// 파싱했다. 캐시가 (1) 같은 url을 한 번만 로드하고 (2) 모델이 바뀌면 반드시
// 비워지는지가 핵심 — 트랙은 본 이름에 묶여 있어 남으면 오작동한다.
function clipWithTracks(names) {
  return {
    tracks: names.map((name) => ({ name })),
  }
}

describe('cachedVmdClip', () => {
  beforeEach(() => clearClipCache())

  it('같은 url을 동시에 두 번 재생해도 로더는 한 번만 돈다', async () => {
    let calls = 0
    const load = () => { calls += 1; return Promise.resolve(clipWithTracks(['a.quaternion'])) }

    const [a, b] = await Promise.all([
      cachedVmdClip('x.vmd', load),
      cachedVmdClip('x.vmd', load), // 아직 첫 로드가 in-flight
    ])

    expect(calls).toBe(1)
    expect(a).toBe(b) // 같은 clip 객체 — 후처리도 한 번만 돌았다는 뜻
  })

  it('두 번째 재생은 파싱 없이 캐시에서 나온다', async () => {
    let calls = 0
    const load = () => { calls += 1; return Promise.resolve(clipWithTracks([])) }
    await cachedVmdClip('y.vmd', load)
    await cachedVmdClip('y.vmd', load)
    expect(calls).toBe(1)
  })

  it('캐릭터 교체(clearClipCache) 뒤엔 다시 로드한다 — 트랙이 본 이름에 묶여 있다', async () => {
    let calls = 0
    const load = () => { calls += 1; return Promise.resolve(clipWithTracks([])) }
    await cachedVmdClip('z.vmd', load)
    clearClipCache()
    await cachedVmdClip('z.vmd', load)
    expect(calls).toBe(2)
  })

  it('실패한 로드는 캐시에 남지 않는다', async () => {
    let calls = 0
    const load = () => { calls += 1; return Promise.reject(new Error('boom')) }
    await expect(cachedVmdClip('bad.vmd', load)).rejects.toThrow('boom')
    await expect(cachedVmdClip('bad.vmd', load)).rejects.toThrow('boom')
    expect(calls).toBe(2)
  })

  it('LRU 8개를 넘으면 가장 오래 안 쓴 것부터 버린다', async () => {
    const calls = []
    const load = (u) => () => { calls.push(u); return Promise.resolve(clipWithTracks([])) }
    for (let i = 0; i < 8; i += 1) await cachedVmdClip(`c${i}.vmd`, load(`c${i}`))
    await cachedVmdClip('c0.vmd', load('c0')) // 터치 — c1이 최고참이 된다
    await cachedVmdClip('c8.vmd', load('c8')) // 9번째 → c1 축출
    expect(calls).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'])

    await cachedVmdClip('c0.vmd', load('c0-again')) // 살아있어야 함
    await cachedVmdClip('c1.vmd', load('c1-again')) // 축출됐으니 다시 로드
    expect(calls[calls.length - 1]).toBe('c1-again')
    expect(calls).not.toContain('c0-again')
  })
})

describe('prepareVmdClip', () => {
  it('루트/IK position 트랙만 걷어내고 나머지는 남긴다', () => {
    const clip = clipWithTracks([
      '.bones[センター].position',
      '.bones[左足ＩＫ].position', // 전각 표기도 같은 본
      '.bones[髪1].position',      // 머리카락 — 물리가 의존, 남아야 한다
      '.bones[左腕].quaternion',
    ])
    prepareVmdClip(clip, null, 'idle.vmd')
    expect(clip.tracks.map((t) => t.name)).toEqual([
      '.bones[髪1].position',
      '.bones[左腕].quaternion',
    ])
  })

  it('멱등 — 캐시된 클립에 다시 돌려도 트랙이 더 깎이지 않는다', () => {
    const clip = clipWithTracks(['.bones[腰].position', '.bones[左腕].quaternion'])
    prepareVmdClip(clip, null)
    const first = clip.tracks.map((t) => t.name)
    prepareVmdClip(clip, null)
    expect(clip.tracks.map((t) => t.name)).toEqual(first)
  })

  it('클립이 소유한 모프 이름을 clip에 달아둔다(재생마다 model로 옮겨 붙는다)', () => {
    const clip = clipWithTracks([
      '.morphTargetInfluences[まばたき]',
      '.bones[左腕].quaternion',
    ])
    prepareVmdClip(clip, null)
    expect([...clip._apiaMorphNames]).toEqual(['まばたき'])
  })

  it('모프 트랙이 없으면 null — 양보 로직이 그대로 절차 표정을 쓴다', () => {
    const clip = clipWithTracks(['.bones[左腕].quaternion'])
    prepareVmdClip(clip, null)
    expect(clip._apiaMorphNames).toBe(null)
  })
})

describe('캐시된 클립 + mixer.uncacheClip 공존', () => {
  // 누수 수정(011f788)이 페이드 후 mixer.uncacheClip(prevClip)을 부른다. 그건
  // mixer 내부의 action 바인딩만 지우고 clip 객체는 우리 Map이 계속 들고 있다 —
  // 같은 클립을 나중에 다시 걸었을 때 정상 동작해야 캐시가 성립한다.
  it('uncacheClip 이후 같은 clip을 다시 재생할 수 있다', () => {
    const obj = new Object3D()
    const clip = new AnimationClip('c', 1, [
      new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 10, 0, 0]),
    ])
    const mixer = new AnimationMixer(obj)

    const first = mixer.clipAction(clip)
    first.play()
    mixer.update(0.5)
    expect(obj.position.x).toBeGreaterThan(0)

    first.stop()
    mixer.uncacheClip(clip)
    obj.position.set(0, 0, 0)

    const second = mixer.clipAction(clip)
    expect(second).toBeTruthy()
    second.play()
    mixer.update(0.5)
    expect(obj.position.x).toBeGreaterThan(0)
  })
})

// ── 실패는 reject가 아니라 null resolve ─────────────────────────────────
// main.js playMotion은 재생 **전에** _vrmaClipActive=true를 낙관적으로 켠다.
// 여기 있는 bail 경로들이 throw가 아니라 null resolve라서, 호출부가 .catch만
// 걸어두면 플래그가 영구히 남아 절차 레이어(호흡·제스처)가 죽는다 — 실제로
// 그랬고, 지금은 .then에서 falsy를 정리한다. 그 계약을 여기 잠근다.
describe('playVRMAnimation / playFBXAnimation 실패 계약', () => {
  const ctxOf = (model) => ({ getCurrentModel: () => model })

  it('모델이 없으면 reject가 아니라 null로 resolve', async () => {
    await expect(playVRMAnimation('a.vrma', {}, ctxOf(null))).resolves.toBe(null)
  })

  it('VRM이 아닌 모델(MMD 등)이면 null', async () => {
    const mmd = { type: 'mmd', mixer: {} }
    await expect(playVRMAnimation('a.vrma', {}, ctxOf(mmd))).resolves.toBe(null)
  })

  it('mixer가 아직 없으면 null', async () => {
    const vrm = { type: 'vrm', mixer: null }
    await expect(playVRMAnimation('a.vrma', {}, ctxOf(vrm))).resolves.toBe(null)
  })

  it('FBX 경로도 같은 계약 — humanoid 없는 모델은 null', async () => {
    const vrm = { type: 'vrm', mixer: {}, obj: {} } // humanoid 없음
    await expect(playFBXAnimation('a.fbx', {}, ctxOf(vrm))).resolves.toBe(null)
  })
})
