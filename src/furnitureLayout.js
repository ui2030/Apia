/**
 * Single source of truth for furniture placement in the Apia room.
 *
 * Phase D — Codex MUST-FIX: the visual furniture (built in sceneRuntime) and
 * the interactive world objects (world.js DEFAULT_WORLD_OBJECTS) MUST share
 * one set of coordinates. Without this, a user who tweaks an interactive
 * point or chair via the settings UI would split it from the visual mesh,
 * and the character would walk to an empty floor while the box stays put.
 *
 * Each entry has:
 *   - `id`         : matches world.json object id (string)
 *   - `type`       : 'chair' | 'point' | 'decoration' (world-side semantics)
 *   - `label`      : Korean user-facing label
 *   - `position`   : { x, y, z } floor center of the furniture footprint
 *   - `size`       : { w, h, d } box footprint (used by sceneRuntime)
 *   - `color`      : hex literal, room palette
 *   - `interaction`: { sitOffset, sitRotY }  (chair only — character lands here)
 *   - `bubbleText` : line the character shows when interacting (Korean)
 *
 * Hex palette: warm pastel "Blue Archive cafe" — cream walls, walnut wood,
 * sage/cream accents, blush pink soft furnishings. Codex NICE-TO-HAVE: keep
 * HemisphereLight off in the first pass; the wood + cream palette already
 * reads warm under the new ambient + sun colors.
 */
export const FURNITURE_DEFAULT = Object.freeze([
  {
    id: 'desk',
    type: 'point',
    label: '책상',
    position: { x: -2.2, y: 0, z: 1.2 },
    size: { w: 1.6, h: 0.78, d: 0.8 },
    color: 0xa67c52, // walnut
    bubbleText: '책상에서 잠깐 둘러볼게요.',
    autoBehavior: true,
    clickable: true,
  },
  {
    id: 'bed',
    type: 'point',
    label: '침대',
    position: { x: 2.4, y: 0, z: 4.2 },
    size: { w: 1.6, h: 0.45, d: 2.0 },
    color: 0xf5f0e6, // mattress cream
    pillowColor: 0xffd2dc, // blush pillow
    bubbleText: '잠깐 침대에 걸쳐 있을게요.',
    autoBehavior: true,
    clickable: true,
  },
  {
    id: 'chair_window',
    type: 'chair',
    label: '창가 의자',
    position: { x: 1.95, y: 0, z: 3.4 },
    size: { w: 0.55, h: 0.85, d: 0.55 },
    color: 0x8b6f47, // chair wood
    seatHeight: 0.45,
    interaction: {
      sitOffset: { x: 0, y: 0.45, z: -0.08 },
      sitRotY: Math.PI * 0.9,
    },
    bubbleText: '창가에 앉아 있을게요.',
    autoBehavior: true,
    clickable: true,
  },
  {
    id: 'plant',
    type: 'point',
    label: '화분',
    position: { x: -2.6, y: 0, z: 4.6 },
    size: { w: 0.35, h: 0.6, d: 0.35 },
    color: 0xbfa07a, // terracotta-ish
    foliageColor: 0x7ea36a, // sage green
    bubbleText: '화분이 잘 자라고 있나 볼게요.',
    autoBehavior: true,
    clickable: true,
  },
  {
    id: 'rug',
    type: 'decoration',
    label: '러그',
    position: { x: 0, y: 0.01, z: 3.0 }, // above shadowFloor (y=0.001)
    size: { w: 4.0, h: 0.0, d: 3.0 }, // h=0 because rug is a thin plane
    color: 0xd0a896, // dusty rose
    autoBehavior: false,
    clickable: false,
  },
])
