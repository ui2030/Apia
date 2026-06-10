# VRMA motion clips

This folder is the drop location for `.vrma` animation clips played by the VRM
runtime. Filenames referenced by [`manifest.json`](../manifest.json) must match
exactly (case sensitive, forward slashes).

## Subfolders
- `idle/` — ambient loops (breathing, weight shift, look around)
- `talk/` — spoken animation layered on top of lipsync
- `react/` — one-shot reactions (nod, surprise, shy)
- `emote/` — reserved for future emote triggers

## Adding new clips
1. Drop a `.vrma` into the appropriate subfolder.
2. Add/edit the entry in [`manifest.json`](../manifest.json):
   ```json
   "motion_name_in_motionManager": {
     "path": "idle/my_clip.vrma",
     "loop": true,
     "fadeIn": 0.5
   }
   ```
3. The app auto-picks it up on next reload — no code change needed.

## Where clips come from
Three reliable sources, easiest first:

### 1. VRoid Project free 7-pack (BOOTH)
- Page: https://vroid.booth.pm/items/5512385
- 7 clips: Show full body / Greeting / Peace sign / Shoot / Spin / Model pose / Squat
- License: official VRoid pack, free, redistributable per BOOTH terms
- Workflow: BOOTH free checkout → download zip → drop the `.vrma` files into the
  matching subfolder (Squat → `idle/`, Greeting → `react/`, etc.) and rename to
  match a `manifest.json` slot, or add new slots.

### 2. pixiv/three-vrm `test.vrma` (sample, already shipped)
- A small sample is already in `idle/breath_soft.vrma`. License: MIT (pixiv).
- This is enough to verify the runtime picks `.vrma` up; it doesn't cover walk
  or sit. Replace with a real clip when one is ready.

### 3. Mixamo → VRMA via Blender headless (for walk/run/sit/idle full set)
- Mixamo has hundreds of mocap clips, free with an Adobe account.
- See [`scripts/README-mixamo.md`](../../../../scripts/README-mixamo.md) for the
  drop-folder layout (`mixamo-fbx/`) and the headless converter command
  (`npm run scripts/convert-mixamo.mjs` after installing Blender).
- Output lands in this folder, matching `manifest.json` filenames.

### 4. Quaternius Universal Animation Library (CC0)
- https://quaternius.itch.io/universal-animation-library — 120+ CC0 clips
  (locomotion, sit, swim, push, …) as `.glb`/`.fbx`.
- Convert with [`tk256ailab/fbx2vrma-converter`](https://github.com/tk256ailab/fbx2vrma-converter)
  (Node.js CLI) or the Blender pipeline above.

Clips that are missing from this folder are silently ignored — the procedural
motion layer (main.js `updateVRMBody`) keeps the character moving either way,
and Phase G adds spine weight-shift / shoulder counter-yaw / head lag during
walk + a breathing bend during sit so even the no-clip path looks closer to
the BlueArchive cafe vibe than the raw T-pose era.
