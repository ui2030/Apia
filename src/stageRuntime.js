// src/stageRuntime.js — 커뮤니티 스테이지(방) 임포트 어댑터 (쇼츠 격차 ④).
//
// 목표: 사용자가 받은 MMD 스테이지(.pmx, 텍스처 폴더 동봉) 또는 GLB 방을
// "파일 경로만 주면" 절차적 방 대신 통째로 로드. 캐릭터와 같은 file://
// 절대경로 방식이라 PMX 텍스처 상대경로가 살아있다(vite 번들 금지 이유 —
// modelRuntime.normalizeUrlToFetchable와 동일 규약).
//
// 정적 로드: MMDAnimationHelper에 등록하지 않는다 — 스테이지는 애니/물리/IK가
// 필요 없고(본이 있어도 바인드 포즈 정지), helper 등록은 캐릭터 물리 예산만
// 축낸다(Codex 확인: 정적 스테이지에 안전).
//
// 스케일 규약: .pmx 기본 0.08 (MMD 1유닛≈8cm — 캐릭터 정규화 1.6m/20유닛과
// 일치), .glb 기본 1.0 (미터). cfg로 재정의 가능.
import { getMmdRuntime, normalizeUrlToFetchable } from './modelRuntime.js'

let _seq = 0 // 로드 경쟁 가드(Codex MUST-FIX): 늦게 도착한 stale 로드/클리어 무시

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose?.()
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
    for (const m of mats) {
      for (const key of ['map', 'emissiveMap', 'gradientMap', 'normalMap', 'aoMap',
        'roughnessMap', 'metalnessMap', 'alphaMap', 'bumpMap', 'specularMap', 'envMap', 'lightMap']) {
        m[key]?.dispose?.()
      }
      m.dispose?.()
    }
  })
}

/**
 * @param {THREE.Scene} scene
 * @param {{ path: string, scale?: number, position?: {x?:number,y?:number,z?:number},
 *           rotY?: number, castShadow?: boolean, receiveShadow?: boolean,
 *           outline?: boolean }} cfg
 * @returns {Promise<THREE.Group|null>} 로드된 스테이지 루트(경쟁에서 밀렸으면 null)
 */
export async function loadStage(scene, cfg) {
  const token = ++_seq
  const path = String(cfg?.path || '')
  const url = normalizeUrlToFetchable(path)
  if (!url) throw new Error('stage path empty')
  const isPmx = /\.pmx$/i.test(path)

  let obj = null
  if (isPmx) {
    const { MMDLoader } = await getMmdRuntime()
    const loader = new MMDLoader()
    obj = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject))
  } else {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const gltf = await new Promise((resolve, reject) => new GLTFLoader().load(url, resolve, undefined, reject))
    obj = gltf.scene
  }
  if (token !== _seq) { disposeTree(obj); return null } // 그 사이 clear/새 로드 발생

  const scale = Number.isFinite(cfg.scale) ? cfg.scale : (isPmx ? 0.08 : 1.0)
  obj.scale.setScalar(scale)
  const p = cfg.position || {}
  obj.position.set(p.x || 0, p.y || 0, p.z || 0)
  obj.rotation.y = Number.isFinite(cfg.rotY) ? cfg.rotY : 0

  const castShadow = cfg.castShadow !== false
  const receiveShadow = cfg.receiveShadow !== false
  const outline = cfg.outline === true // 기본 꺼짐 — 고밀도 스테이지에서 외곽선
  // 아티팩트/비용(Codex MUST-FIX). OutlineEffect는 per-material
  // userData.outlineParameters.visible을 존중한다.
  obj.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = castShadow
    o.receiveShadow = receiveShadow
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) {
      if (!m) continue
      if (!outline) m.userData.outlineParameters = { visible: false }
    }
  })

  obj.name = 'apia-stage'
  scene.add(obj)
  return obj
}

/** 현재 시퀀스를 무효화(진행 중 로드가 있으면 도착 즉시 폐기됨). */
export function invalidateStageLoads() {
  ++_seq
}

export { disposeTree as disposeStageTree }
