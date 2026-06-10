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
    clickable: f.clickable !== false
  }
  if (f.type === 'chair' && f.interaction) {
    base.sitOffset = f.interaction.sitOffset
    base.sitRotY = f.interaction.sitRotY
  }
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
    autoBehavior: object.autoBehavior !== false && defaults.autoBehavior !== false,
    clickable: object.clickable !== false && defaults.clickable !== false,
    hidden: object.hidden === true,
    bubbleText: typeof object.bubbleText === 'string' ? object.bubbleText : defaults.bubbleText
  }
}

export function createDefaultWorld() {
  return {
    version: 1,
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
  constructor({ scene, camera, renderer, showBubble, onWalkTo, onDebug, onWorldUpdated } = {}) {
    this.scene = scene ?? null
    this.camera = camera ?? null
    this.renderer = renderer ?? null
    this.showBubble = showBubble ?? null
    this.onWalkTo = onWalkTo ?? null
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

    const objects = Array.isArray(world.objects)
      ? world.objects.map((object, index) => normalizeWorldObject(object, index))
      : []

    if (objects.length === 0 && world.disableDefaults !== true) {
      return createDefaultWorld()
    }

    return {
      version: 1,
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
