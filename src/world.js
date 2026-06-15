import { Vector3 } from 'three'

import { FURNITURE_DEFAULT } from './furnitureLayout.js'

const WORLD_TYPES = new Set(['chair', 'point', 'decoration'])

// Phase D — derive the default interactive world objects from the shared
// furniture layout so the visual desk/chair/bed/plant in sceneRuntime and
// the clickable world targets in world.js stay at the same (x,z). Codex
// MUST-FIX: any drift here means the character walks to an empty floor
// while the visible furniture stays put.
const DEFAULT_WORLD_OBJECTS = FURNITURE_DEFAULT.map((f) => {
  const base = {
    id: f.id,
    type: f.type,
    label: f.label,
    x: f.position.x,
    y: f.position.y,
    z: f.position.z,
    bubbleText: f.bubbleText,
    autoBehavior: f.autoBehavior !== false,
    clickable: f.clickable !== false,
    hidden: f.hidden === true // 시각 소품은 라벨 없이 메시만 (sceneRuntime이 그림)
  }
  // 앉기 affordance는 type에 무관하게 interaction.sitOffset이 있으면 옮긴다
  // (chair뿐 아니라 활동 좌석으로 쓰는 어떤 가구든). 활동 시퀀서가 좌석 데이터를
  // worldManager.getObjectById로 읽기 때문.
  if (f.interaction && f.interaction.sitOffset) {
    base.sitOffset = f.interaction.sitOffset
    base.sitRotY = f.interaction.sitRotY
    base.seatHeight = f.interaction.seatHeight
  }
  // J단계 스마트 오브젝트 — 사물이 선언한 activity 어포던스를 월드 객체로 옮긴다.
  if (f.activity) base.activity = f.activity
  return base
})

const TYPE_DEFAULTS = {
  chair: {
    label: 'Chair',
    badge: 'CHAIR',
    anchorHeight: 0.82,
    screenOffsetY: 34,
    sitOffset: { x: 0, y: 0.04, z: -0.12 },
    sitRotY: Math.PI,
    autoBehavior: true,
    clickable: true,
    bubbleText: 'I will sit for a moment.'
  },
  point: {
    label: 'Spot',
    badge: 'POINT',
    anchorHeight: 0.16,
    screenOffsetY: 24,
    sitOffset: null,
    sitRotY: Math.PI,
    autoBehavior: true,
    clickable: true,
    bubbleText: 'I will head over there.'
  },
  decoration: {
    label: 'Decor',
    badge: 'DECOR',
    anchorHeight: 0.34,
    screenOffsetY: 22,
    sitOffset: null,
    sitRotY: Math.PI,
    autoBehavior: false,
    clickable: false,
    bubbleText: ''
  }
}

let activeWorldManager = null

function safeCall(fn, ...args) {
  try {
    if (typeof fn === 'function') return fn(...args)
  } catch (err) {
    console.error('[WORLD_CALLBACK_ERROR]', err)
  }
  return undefined
}

function cloneJson(data) {
  return JSON.parse(JSON.stringify(data))
}

function normalizeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function normalizeWorldType(type) {
  return WORLD_TYPES.has(type) ? type : 'point'
}

function normalizeSitOffset(offset, fallback = null) {
  if (!offset || typeof offset !== 'object') return fallback ? { ...fallback } : null
  return {
    x: normalizeNumber(offset.x, fallback?.x ?? 0),
    y: normalizeNumber(offset.y, fallback?.y ?? 0),
    z: normalizeNumber(offset.z, fallback?.z ?? 0)
  }
}

// J단계 스마트 오브젝트 — 사물이 선언한 activity 어포던스를 검증/정규화한다.
// normalizeWorldObject가 화이트리스트라 이 단계 없이는 activity가 통째로 사라진다
// (Codex MUST-FIX). 알 수 없는 step kind나 빈 steps면 활동을 버린다(null).
const ACTIVITY_STEP_KINDS = new Set(['goto', 'pose', 'sit', 'cleanup', 'prop'])
const PROP_KINDS = new Set(['cup', 'glass', 'book'])
const PROP_OPS = new Set(['attach', 'detach'])
const PROP_HANDS = new Set(['right', 'left'])
// 욕구 유틸리티 AI가 읽는 need 차원(0..1 압력). 활동이 채워주는 양(needFill).
const NEED_KEYS = new Set(['thirst', 'tiredness', 'boredom', 'comfort', 'care', 'hygiene'])

function normalizeNeedFill(needFill) {
  if (!needFill || typeof needFill !== 'object') return {}
  const out = {}
  for (const k of Object.keys(needFill)) {
    if (NEED_KEYS.has(k) && Number.isFinite(needFill[k])) out[k] = clamp(needFill[k], 0, 1)
  }
  return out
}

function normalizeActivity(activity) {
  if (!activity || typeof activity !== 'object') return null
  if (!Array.isArray(activity.steps) || activity.steps.length === 0) return null

  const steps = []
  for (const raw of activity.steps) {
    if (!raw || typeof raw !== 'object') continue
    if (!ACTIVITY_STEP_KINDS.has(raw.kind)) continue
    const step = { kind: raw.kind }
    if (typeof raw.targetId === 'string') step.targetId = raw.targetId
    if (Number.isFinite(raw.durationMs)) step.durationMs = clamp(raw.durationMs, 200, 60000)
    if (typeof raw.bubble === 'string') step.bubble = raw.bubble
    if (typeof raw.motion === 'string') step.motion = raw.motion
    if (raw.faceCamera === true) step.faceCamera = true
    if (raw.reach === true) step.reach = true // 마시기/읽기 — 팔 IK 입-도달
    // prop 스텝 — 손에 소품 들기/내려놓기. op·propKind·hand 화이트리스트.
    if (step.kind === 'prop') {
      step.op = PROP_OPS.has(raw.op) ? raw.op : 'attach'
      if (PROP_KINDS.has(raw.propKind)) step.propKind = raw.propKind
      step.hand = PROP_HANDS.has(raw.hand) ? raw.hand : 'right'
      if (step.op === 'attach' && !step.propKind) continue // 붙일 소품 미지정 → 무의미
    }
    // goto/sit은 어디로 갈지(targetId) 없으면 의미가 없다.
    if ((step.kind === 'goto' || step.kind === 'sit') && !step.targetId) continue
    steps.push(step)
  }
  if (steps.length === 0) return null

  return {
    id: typeof activity.id === 'string' ? activity.id : 'activity',
    label: typeof activity.label === 'string' ? activity.label : '',
    focus: typeof activity.focus === 'string' ? activity.focus : null,
    needFill: normalizeNeedFill(activity.needFill),
    // autonomous:false면 자율(욕구 AI) 선택 대상에서 제외 — 클릭으로만 발동.
    // 사용자 제작 월드의 숨김 헬퍼 활동을 옵트인으로(Codex NICE-TO-HAVE).
    autonomous: activity.autonomous !== false,
    steps
  }
}

function normalizeWorldObject(object = {}, index = 0) {
  const type = normalizeWorldType(object.type)
  const defaults = TYPE_DEFAULTS[type]
  const label = object.label || object.name || defaults.label

  return {
    id: object.id || `world_${type}_${index}`,
    type,
    name: object.name || label,
    label,
    badge: object.badge || defaults.badge,
    x: normalizeNumber(object.x, 0),
    y: normalizeNumber(object.y, 0),
    z: normalizeNumber(object.z, 0),
    anchorHeight: normalizeNumber(object.anchorHeight, defaults.anchorHeight),
    screenOffsetY: normalizeNumber(object.screenOffsetY, defaults.screenOffsetY),
    sitOffset: normalizeSitOffset(object.sitOffset, defaults.sitOffset),
    sitRotY: normalizeNumber(object.sitRotY, defaults.sitRotY),
    seatHeight: Number.isFinite(object.seatHeight) ? object.seatHeight : null,
    autoBehavior: object.autoBehavior !== false && defaults.autoBehavior !== false,
    clickable: object.clickable !== false && defaults.clickable !== false,
    hidden: object.hidden === true,
    bubbleText: typeof object.bubbleText === 'string' ? object.bubbleText : defaults.bubbleText,
    activity: normalizeActivity(object.activity)
  }
}

// Phase G — bumped to 2 for the 자취방 redesign. A saved world.json from the
// old layout (e.g. with the now-removed 'desk' point) must NOT linger as a
// clickable/auto target; on a version mismatch we regenerate from the current
// FURNITURE_DEFAULT (Codex MUST-FIX). User edits to the old layout are dropped
// — unavoidable when the room itself changed.
// J단계 — 3으로 올림: 새 chair + coffeeMachine(activity 어포던스)를 기존 저장
// 월드(v2)가 못 받아 기능이 조용히 사라지는 문제(Codex MUST-FIX). 버전 불일치 시
// 현재 FURNITURE_DEFAULT로 재생성된다.
// J단계 — 4로 올림: 여러 스마트 오브젝트(물·휴식·독서·화분) + prop/needFill 메타가
// 추가돼 저장 월드(v3)가 못 받던 것(Codex MUST-FIX).
// J단계 — 5로 올림: 화장실(door 활동)·컴퓨터 데스크/의자/모니터 추가(Codex MUST-FIX).
const WORLD_VERSION = 5

export function createDefaultWorld() {
  return {
    version: WORLD_VERSION,
    objects: DEFAULT_WORLD_OBJECTS.map((object, index) =>
      normalizeWorldObject(cloneJson(object), index)
    )
  }
}

function createWorldElement(object) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `world-object type-${object.type}`
  button.dataset.objectId = object.id

  const badge = document.createElement('span')
  badge.className = 'world-object-badge'
  badge.textContent = object.badge

  const label = document.createElement('span')
  label.className = 'world-object-label'
  label.textContent = object.label

  button.appendChild(badge)
  button.appendChild(label)
  return button
}

export function updateWorldLabels(camera) {
  activeWorldManager?.updateLayout(camera)
}

export function getActiveWorldManager() {
  return activeWorldManager
}

export async function initWorld(options = {}) {
  const manager = new WorldManager(options)
  activeWorldManager = manager
  await manager.load()
  return manager
}

export class WorldManager {
  constructor({ scene, camera, renderer, showBubble, onWalkTo, onStartActivity, onDebug, onWorldUpdated } = {}) {
    this.scene = scene ?? null
    this.camera = camera ?? null
    this.renderer = renderer ?? null
    this.showBubble = showBubble ?? null
    this.onWalkTo = onWalkTo ?? null
    // J단계 스마트 오브젝트 — activity 사물 클릭 시 활동 시퀀서를 시작하는 훅.
    this.onStartActivity = onStartActivity ?? null
    this.onDebug = onDebug ?? (() => {})
    this.onWorldUpdated = onWorldUpdated ?? (() => {})
    this.world = createDefaultWorld()
    this.root = document.getElementById('world-layer')
    this.elements = new Map()
    this._projectVector = new Vector3()
  }

  log(message) {
    this.onDebug(message)
  }

  normalizeWorld(world) {
    if (!world || typeof world !== 'object') return createDefaultWorld()

    // 옛 레이아웃(version < 2)은 통째로 새 자취방 기본값으로 마이그레이션 —
    // 제거된 'desk' 같은 stale 오브젝트가 살아남지 않게(Codex MUST-FIX).
    if (world.version !== WORLD_VERSION) return createDefaultWorld()

    const objects = Array.isArray(world.objects)
      ? world.objects.map((object, index) => normalizeWorldObject(object, index))
      : []

    if (objects.length === 0 && world.disableDefaults !== true) {
      return createDefaultWorld()
    }

    return {
      version: WORLD_VERSION,
      ...world,
      objects
    }
  }

  syncElements() {
    if (!this.root) return

    const nextIds = new Set(
      this.world.objects
        .filter((object) => !object.hidden)
        .map((object) => object.id)
    )

    for (const [id, element] of this.elements) {
      if (!nextIds.has(id)) {
        element.remove()
        this.elements.delete(id)
      }
    }

    for (const object of this.world.objects) {
      if (object.hidden) continue

      let element = this.elements.get(object.id)
      if (!element) {
        element = createWorldElement(object)
        element.addEventListener('click', () => {
          this.interactWith(object.id, { source: 'click' })
        })
        this.root.appendChild(element)
        this.elements.set(object.id, element)
      }

      element.className = `world-object type-${object.type}`
      element.dataset.objectId = object.id
      const [badge, label] = element.children
      if (badge) badge.textContent = object.badge
      if (label) label.textContent = object.label
      element.disabled = !object.clickable
      element.setAttribute('aria-label', object.label)
      element.style.pointerEvents = object.clickable ? 'auto' : 'none'
      element.style.opacity = object.clickable ? '1' : '0.72'
    }
  }

  updateLayout(camera = this.camera) {
    if (!this.root || !camera) return

    for (const object of this.world.objects) {
      const element = this.elements.get(object.id)
      if (!element) continue

      this._projectVector.set(object.x, object.y + object.anchorHeight, object.z)
      this._projectVector.project(camera)

      const isVisible =
        this._projectVector.z >= -1 &&
        this._projectVector.z <= 1 &&
        Math.abs(this._projectVector.x) <= 1.25 &&
        Math.abs(this._projectVector.y) <= 1.25

      if (!isVisible) {
        element.style.display = 'none'
        continue
      }

      const screenX = (this._projectVector.x * 0.5 + 0.5) * window.innerWidth
      const screenY = (-this._projectVector.y * 0.5 + 0.5) * window.innerHeight

      element.style.display = 'flex'
      element.style.left = `${screenX}px`
      element.style.top = `${screenY - object.screenOffsetY}px`
    }
  }

  async load() {
    try {
      const result = await window.api.loadWorld()
      this.world = this.normalizeWorld(result)
      this.syncElements()
      this.updateLayout(this.camera)
      safeCall(this.onWorldUpdated, this.world)
      this.log(`[WORLD_LOAD_OK] objects=${this.world.objects.length}`)
      return this.world
    } catch (error) {
      console.error('[WORLD_LOAD_ERROR]', error)
      this.world = createDefaultWorld()
      this.syncElements()
      this.updateLayout(this.camera)
      safeCall(this.onWorldUpdated, this.world)
      this.log('[WORLD_LOAD_FALLBACK_DEFAULT]')
      return this.world
    }
  }

  async save() {
    try {
      const result = await window.api.saveWorld(this.world)
      if (!result?.ok) {
        this.log(`[WORLD_SAVE_ERROR] ${result?.error || 'unknown'}`)
        return result
      }
      this.log('[WORLD_SAVE_OK]')
      return result
    } catch (error) {
      console.error('[WORLD_SAVE_ERROR]', error)
      this.log(`[WORLD_SAVE_ERROR] ${error.message || 'unknown'}`)
      return { ok: false, error: error.message || 'unknown' }
    }
  }

  setWorld(nextWorld) {
    this.world = this.normalizeWorld(nextWorld)
    this.syncElements()
    this.updateLayout(this.camera)
    safeCall(this.onWorldUpdated, this.world)
    return this.world
  }

  getWorld() {
    return this.world
  }

  getObjectById(id) {
    return this.world.objects.find((object) => object.id === id) || null
  }

  getInteractiveObjects({ includeDecor = false } = {}) {
    return this.world.objects.filter((object) => {
      if (object.hidden) return false
      if (!object.clickable) return false
      if (object.autoBehavior === false) return false
      if (!includeDecor && object.type === 'decoration') return false
      return true
    })
  }

  // J단계 스마트 오브젝트 — activity 어포던스를 선언한 사물들. 자율 활동(욕구 AI)이
  // 여기서 골라 사슬을 시작한다. activity는 명시적 어포던스라 autoBehavior:false나
  // hidden(라벨만 숨김, 메시는 렌더됨)이어도 대상에 포함한다(Codex MUST-FIX:
  // hidden 필터가 싱크대/책장 같은 deco 활동을 가로막던 것).
  getActivityObjects() {
    return this.world.objects.filter((object) => object.activity && object.activity.autonomous !== false)
  }

  addObject(object = {}) {
    const nextObject = normalizeWorldObject(
      {
        id: object.id || `obj_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        ...object
      },
      this.world.objects.length
    )

    this.world.objects.push(nextObject)
    this.syncElements()
    this.updateLayout(this.camera)
    safeCall(this.onWorldUpdated, this.world)
    this.log(`[WORLD_ADD_OK] id=${nextObject.id}`)
    return nextObject
  }

  removeObject(id) {
    const before = this.world.objects.length
    this.world.objects = this.world.objects.filter((object) => object?.id !== id)
    const removed = before !== this.world.objects.length
    this.syncElements()
    this.updateLayout(this.camera)
    safeCall(this.onWorldUpdated, this.world)
    this.log(removed ? `[WORLD_REMOVE_OK] id=${id}` : `[WORLD_REMOVE_SKIP] id=${id}`)
    return removed
  }

  clear() {
    this.world = createDefaultWorld()
    this.syncElements()
    this.updateLayout(this.camera)
    safeCall(this.onWorldUpdated, this.world)
    this.log('[WORLD_CLEAR_OK]')
    return this.world
  }

  interactWith(objectId, { source = 'click' } = {}) {
    const object = this.getObjectById(objectId)
    if (!object || !object.clickable) return false

    // J단계 스마트 오브젝트 — activity를 선언한 사물이면 단순 walk-to 대신 활동
    // 사슬을 실행한다(걷기→포즈→앉기→정리). 핸들러가 있으면 그 결과를 그대로
    // 반환한다 — 이미 다른 활동 중이라 못 시작했어도(start=false) 일반 walk로
    // 폴백하지 않는다(진행 중 활동과 충돌 방지). 핸들러 자체가 없을 때만 폴백.
    if (object.activity && typeof this.onStartActivity === 'function') {
      const started = safeCall(this.onStartActivity, object.activity, { source }) === true
      if (started) {
        this.log(`[WORLD_ACTIVITY_${source.toUpperCase()}] id=${object.id} activity=${object.activity.id}`)
      }
      return started
    }

    if (typeof this.onWalkTo !== 'function') return false

    const label = object.label || object.name || object.type
    const startText = object.bubbleText || `I will head to ${label}.`

    safeCall(this.showBubble, startText, source === 'auto' ? 2400 : 3200)

    const payload = {
      x: object.x,
      z: object.z,
      onArrive: () => {
        if (source === 'auto') {
          safeCall(this.showBubble, `Made it to ${label}.`, 2200)
        } else if (object.type === 'chair') {
          safeCall(this.showBubble, `Settling into ${label}.`, 2600)
        }
      }
    }

    if (object.type === 'chair' && object.sitOffset) {
      payload.sitOffset = object.sitOffset
      payload.sitRotY = object.sitRotY
      payload.seatHeight = object.seatHeight
    }

    safeCall(this.onWalkTo, payload)
    this.log(`[WORLD_INTERACT_${source.toUpperCase()}] id=${object.id} type=${object.type}`)
    return true
  }

  triggerAutoBehavior(options = {}) {
    // Codex MUST-FIX round 1: options.includeDecor was ignored before — it
    // never reached getInteractiveObjects, so decoration items could never
    // be picked even when the caller explicitly asked. Now `triggerAutoBehavior`
    // passes the flag through. Default false to preserve existing behavior
    // when callers don't opt in.
    const candidates = this.getInteractiveObjects({
      includeDecor: options.includeDecor === true
    })
    if (!candidates.length) return false

    const chairs = candidates.filter((object) => object.type === 'chair')
    const points = candidates.filter((object) => object.type === 'point')
    const chairBias = clamp(
      Number.isFinite(options.chairBias) ? options.chairBias : 0.45,
      0.05,
      0.95
    )
    const pool =
      chairs.length > 0 && Math.random() < chairBias
        ? chairs
        : points.length > 0
          ? points
          : candidates

    const target = pool[Math.floor(Math.random() * pool.length)]
    return this.interactWith(target.id, { source: 'auto' })
  }
}

export default WorldManager
