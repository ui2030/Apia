/**
 * Pure helpers for the main-window "remember which monitor" policy.
 *
 * Apia's main window is a transparent, frameless, non-resizable overlay
 * sized to the display's `workArea`. "Remember bounds" therefore degenerates
 * to "remember which display the user pinned the overlay to" — restoring
 * raw x/y/w/h is wrong because the window can't be smaller than the work
 * area (resizable: false), and a screen disconnect would leave bounds
 * pointing into oblivion.
 *
 * Policy:
 *   - On save, we record an anchor point inside the current display's
 *     workArea (the centre is the obvious choice — it's robust to small
 *     workArea drift caused by taskbar / DPI changes).
 *   - On launch, we hand the saved anchor to `pickTargetWorkArea` along
 *     with the live display list; the function picks the display whose
 *     workArea contains the anchor, or falls back to the primary display
 *     when no monitor matches (typical after disconnect).
 *
 * Kept dependency-free so it can be exercised by vitest without any
 * Electron shim. The functions accept plain `{ x, y, width, height }`
 * objects and arrays of `{ workArea }` records.
 */

const MIN_DIMENSION = 64

/**
 * Validate a saved anchor blob from disk. Returns the normalized anchor
 * or `null` when any field is missing/non-finite. The aggregate uses this
 * to decide whether to honor the saved value at all.
 */
function normalizeAnchor(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/**
 * Validate a saved bounds blob for the secondary "remember width/height"
 * use case. Reserved for future when the overlay grows a resize handle.
 * Today the main window is non-resizable so we only need the anchor; this
 * helper is exported so the schema and the WindowManager can share one
 * validation rule when it lands.
 */
function normalizeBounds(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  const width = Number(raw.width)
  const height = Number(raw.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) return null
  return { x, y, width, height }
}

/**
 * Return true when (px, py) sits inside the given workArea record.
 * Edge-inclusive on the top-left, exclusive on the bottom-right — matches
 * how Electron's `screen.getDisplayMatching` resolves ties.
 */
function workAreaContains(workArea, px, py) {
  if (!workArea) return false
  const left = workArea.x
  const top = workArea.y
  const right = left + workArea.width
  const bottom = top + workArea.height
  return px >= left && py >= top && px < right && py < bottom
}

/**
 * Centre point of a workArea. Used at save time so the anchor is robust
 * to minor workArea drift between sessions (taskbar auto-hide, DPI scale).
 */
function workAreaCentre(workArea) {
  if (!workArea) return null
  return {
    x: workArea.x + Math.floor(workArea.width / 2),
    y: workArea.y + Math.floor(workArea.height / 2)
  }
}

/**
 * Given the saved anchor and the live `displays` array, return the
 * `workArea` of the display the overlay should restore onto. Falls back
 * to `primaryDisplay.workArea` when the anchor is missing or no display
 * matches (monitor was disconnected, anchor was on a phantom screen).
 *
 * `displays` is an array of `{ id?, workArea: { x, y, width, height } }`.
 * `primaryDisplay` is the same shape, used only for the fallback case.
 */
function pickTargetWorkArea({ anchor, displays, primaryDisplay }) {
  if (!primaryDisplay?.workArea) {
    throw new Error('windowBoundsPolicy: primaryDisplay.workArea is required for fallback')
  }
  const normalized = normalizeAnchor(anchor)
  if (!normalized) return primaryDisplay.workArea

  if (Array.isArray(displays)) {
    for (const display of displays) {
      if (workAreaContains(display?.workArea, normalized.x, normalized.y)) {
        return display.workArea
      }
    }
  }

  return primaryDisplay.workArea
}

module.exports = {
  MIN_DIMENSION,
  normalizeAnchor,
  normalizeBounds,
  workAreaContains,
  workAreaCentre,
  pickTargetWorkArea
}
