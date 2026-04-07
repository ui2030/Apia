function safeCall(fn, ...args) {
  try {
    if (typeof fn === 'function') return fn(...args)
  } catch (err) {
    console.error('[WORLD_CALLBACK_ERROR]', err)
  }
  return undefined
}

export function createDefaultWorld() {
  return { objects: [] }
}

export function updateWorldLabels(world = createDefaultWorld()) {
  const root = document.getElementById('world-labels')
  if (!root) return

  root.innerHTML = ''

  const objects = Array.isArray(world?.objects) ? world.objects : []
  for (const obj of objects) {
    const el = document.createElement('div')
    el.className = 'world-label'
    el.textContent = obj?.label || obj?.name || obj?.type || 'object'
    root.appendChild(el)
  }
}

export async function initWorld(options = {}) {
  const manager = new WorldManager(options)
  await manager.load()
  return manager
}

export class WorldManager {
  constructor({ onDebug, onWorldUpdated } = {}) {
    this.onDebug = onDebug ?? (() => {})
    this.onWorldUpdated = onWorldUpdated ?? (() => {})
    this.world = createDefaultWorld()
  }

  log(message) {
    this.onDebug(message)
  }

  normalizeWorld(world) {
    if (!world || typeof world !== 'object') return createDefaultWorld()
    if (!Array.isArray(world.objects)) return { ...world, objects: [] }
    return world
  }

  async load() {
    try {
      const result = await window.api.loadWorld()
      this.world = this.normalizeWorld(result)
      updateWorldLabels(this.world)
      safeCall(this.onWorldUpdated, this.world)
      this.log(`[WORLD_LOAD_OK] objects=${this.world.objects.length}`)
      return this.world
    } catch (error) {
      console.error('[WORLD_LOAD_ERROR]', error)
      this.world = createDefaultWorld()
      updateWorldLabels(this.world)
      safeCall(this.onWorldUpdated, this.world)
      this.log('[WORLD_LOAD_ERROR]')
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
    updateWorldLabels(this.world)
    safeCall(this.onWorldUpdated, this.world)
    return this.world
  }

  getWorld() {
    return this.world
  }

  addObject(object = {}) {
    const nextObject = {
      id: object.id || `obj_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      type: object.type || 'object',
      name: object.name || object.label || 'object',
      label: object.label || object.name || object.type || 'object',
      x: Number.isFinite(object.x) ? object.x : 0,
      y: Number.isFinite(object.y) ? object.y : 0,
      z: Number.isFinite(object.z) ? object.z : 0,
      ...object
    }

    this.world.objects.push(nextObject)
    updateWorldLabels(this.world)
    safeCall(this.onWorldUpdated, this.world)
    this.log(`[WORLD_ADD_OK] id=${nextObject.id}`)
    return nextObject
  }

  removeObject(id) {
    const before = this.world.objects.length
    this.world.objects = this.world.objects.filter((obj) => obj?.id !== id)
    const removed = before !== this.world.objects.length
    updateWorldLabels(this.world)
    safeCall(this.onWorldUpdated, this.world)
    this.log(removed ? `[WORLD_REMOVE_OK] id=${id}` : `[WORLD_REMOVE_SKIP] id=${id}`)
    return removed
  }

  clear() {
    this.world = createDefaultWorld()
    updateWorldLabels(this.world)
    safeCall(this.onWorldUpdated, this.world)
    this.log('[WORLD_CLEAR_OK]')
    return this.world
  }
}

export default WorldManager