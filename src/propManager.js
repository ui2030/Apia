// src/propManager.js
//
// J단계 거주형 비서 — 손에 드는 소품(컵·유리잔·책) 관리. 커피를 마시거나 물을
// 마실 때 손에 실제로 컵이 들려 보이게 한다.
//
// 모델 불문(VRM·MMD/PMX): 손 본은 poseRig 레지스트리의 role('rWrist'/'lWrist')로
// 통일 접근한다. 소품은 본의 자식으로 parenting하지 않고(스킨드메시 본-자식 렌더·
// 스케일 상속의 불확실성 회피) 씬 루트에 두고 **매 프레임 본의 월드 변환을 복사**해
// 따라가게 한다. 동기화는 반드시 updateCharacter(루트 위치/회전까지 끝난) **뒤**에
// 호출해야 한다 — 그 전에 복사하면 한 프레임/루트 변환만큼 어긋난다(Codex MUST-FIX).
//
// 소품 에셋 GLB가 없어 절차적 메시로 생성(toon 룩의 방과 어우러지게 단순 형태).
import {
  Group,
  Mesh,
  CylinderGeometry,
  TorusGeometry,
  BoxGeometry,
  MeshStandardMaterial,
  Vector3,
  Quaternion,
  Euler
} from 'three'

// 소품별 표현. 컵·유리잔은 손 회전을 따라가면 기울어 쏟아지는 느낌이라 항상
// 월드 수직(중력 방향)으로 세운다(들고 걷든 앉든 자연스러움). 책은 손을 따라간다.
// lift = 본(손목) 위로 살짝 올려 손바닥 위에 놓인 느낌. scale = 캐릭터 크기에 곱해짐.
const PROP_CONF = {
  cup: { upright: true, lift: 0.04, scale: 1.0 },
  glass: { upright: true, lift: 0.045, scale: 1.0 },
  book: { upright: false, lift: 0.0, scale: 1.0, rot: { x: Math.PI / 2, y: 0, z: 0 } }
}
// 본을 따라가는 소품(책)의 손-로컬 회전 미세조정은 PROP_CONF.rot으로.

function buildCup() {
  const g = new Group()
  const mat = new MeshStandardMaterial({ color: 0xf3ece0, roughness: 0.6, metalness: 0.0 })
  const body = new Mesh(new CylinderGeometry(0.04, 0.034, 0.075, 16), mat)
  g.add(body)
  const coffee = new Mesh(
    new CylinderGeometry(0.036, 0.036, 0.01, 16),
    new MeshStandardMaterial({ color: 0x4a2c18, roughness: 0.4 })
  )
  coffee.position.y = 0.03
  g.add(coffee)
  const handle = new Mesh(new TorusGeometry(0.022, 0.007, 8, 16), mat)
  handle.position.set(0.045, 0, 0)
  handle.rotation.y = Math.PI / 2
  g.add(handle)
  return g
}

function buildGlass() {
  const g = new Group()
  const mat = new MeshStandardMaterial({ color: 0xbfe0ec, roughness: 0.15, metalness: 0.0, transparent: true, opacity: 0.55 })
  const body = new Mesh(new CylinderGeometry(0.034, 0.026, 0.09, 16), mat)
  g.add(body)
  const water = new Mesh(
    new CylinderGeometry(0.03, 0.024, 0.05, 16),
    new MeshStandardMaterial({ color: 0x8fcfe6, roughness: 0.1, transparent: true, opacity: 0.7 })
  )
  water.position.y = -0.015
  g.add(water)
  return g
}

function buildBook() {
  const g = new Group()
  const cover = new Mesh(
    new BoxGeometry(0.13, 0.18, 0.028),
    new MeshStandardMaterial({ color: 0x9c5b3b, roughness: 0.7 })
  )
  g.add(cover)
  const pages = new Mesh(
    new BoxGeometry(0.118, 0.166, 0.022),
    new MeshStandardMaterial({ color: 0xf4efe2, roughness: 0.9 })
  )
  pages.position.z = 0.004
  g.add(pages)
  return g
}

const BUILDERS = { cup: buildCup, glass: buildGlass, book: buildBook }

export function createPropManager({ scene, getCurrentModel } = {}) {
  const cache = new Map() // kind → Group(메시, 재사용)
  let held = null // { kind, hand, mesh }
  let reaching = false // 마시기/읽기 단계 — 팔 IK로 손을 입까지 가져갈지(렌더 루프가 읽음)

  const _pos = new Vector3()
  const _quat = new Quaternion()
  const _scale = new Vector3()
  const _offsetV = new Vector3()
  const _localQuat = new Quaternion()
  const _euler = new Euler()

  function meshFor(kind) {
    if (cache.has(kind)) return cache.get(kind)
    const build = BUILDERS[kind]
    if (!build) return null
    const m = build()
    m.visible = false
    cache.set(kind, m)
    return m
  }

  // 손 본 해석(모델 불문). dummy/poseRig 없음/본 없음이면 null.
  function resolveHandBone(model, hand) {
    const role = hand === 'left' ? 'lWrist' : 'rWrist'
    return model?.poseRig?.registry?.roles?.get?.(role)?.bone || null
  }

  function attach({ kind, hand = 'right' } = {}) {
    const mesh = meshFor(kind)
    if (!mesh) return false
    // 이미 다른 소품을 들고 있으면 먼저 내려놓는다(손 하나).
    if (held && held.mesh !== mesh) detach()
    held = { kind, hand, mesh }
    if (!mesh.parent) scene?.add?.(mesh)
    mesh.visible = false // 첫 sync 전 깜빡임 방지(본 위치 잡힌 뒤 보이기)
    return true
  }

  function detach() {
    reaching = false
    if (!held) return
    const { mesh } = held
    mesh.visible = false
    mesh.parent?.remove?.(mesh)
    held = null
  }

  // 마시기/읽기 단계 동안 팔 IK 입-도달 on/off(activityRunner가 호출).
  function setReach(on) { reaching = !!on }
  function isReaching() { return reaching && !!held }

  // 매 프레임 updateCharacter 뒤 호출. 본 월드 변환을 복사해 소품을 손에 고정.
  function sync() {
    if (!held) return
    const { mesh, hand } = held
    const model = getCurrentModel?.()
    const bone = resolveHandBone(model, hand)
    if (!model || model.type === 'dummy' || !bone) {
      mesh.visible = false // 손 못 찾으면 숨김(Codex: 폴백 안전)
      return
    }

    bone.updateWorldMatrix(true, false)
    bone.matrixWorld.decompose(_pos, _quat, _scale)

    const conf = PROP_CONF[held.kind] || PROP_CONF.cup
    const mirror = hand === 'left' ? -1 : 1
    // 캐릭터 전체 스케일에 소품 크기를 맞춘다(루트 setScalar 기준).
    const charScale = model.root?.scale?.x || 1

    // 위치 = 손목 월드 + 위로 살짝(lift). 컵이 손바닥 위에 놓인 느낌.
    mesh.position.copy(_pos)
    mesh.position.y += conf.lift * charScale

    if (conf.upright) {
      // 컵·유리잔 — 항상 월드 수직(중력). 손이 어떤 자세든 안 쏟아진다.
      mesh.quaternion.identity()
    } else {
      // 책 등 — 손 회전을 따라가되 로컬 보정.
      _euler.set(conf.rot?.x || 0, (conf.rot?.y || 0) * mirror, conf.rot?.z || 0)
      _localQuat.setFromEuler(_euler)
      mesh.quaternion.copy(_quat).multiply(_localQuat)
    }

    mesh.scale.setScalar(conf.scale * charScale)
    mesh.visible = true
  }

  function state() {
    if (!held) return null
    const p = held.mesh.position // 씬 루트 자식이라 local=world
    return { kind: held.kind, hand: held.hand, visible: held.mesh.visible, pos: { x: p.x, y: p.y, z: p.z } }
  }

  // 소품을 든 팔의 clip role('lArm'/'rArm'). 이 팔은 "마시기" 클립이 일부러
  // 들어올리므로, 런타임 팔처짐 보정에서 제외해 어깨 lift가 상쇄되지 않게 한다.
  function heldArmRole() {
    if (!held) return null
    return held.hand === 'left' ? 'lArm' : 'rArm'
  }

  function dispose() {
    detach()
    for (const m of cache.values()) m.parent?.remove?.(m)
    cache.clear()
  }

  return { attach, detach, sync, state, dispose, heldArmRole, setReach, isReaching }
}

export default createPropManager
