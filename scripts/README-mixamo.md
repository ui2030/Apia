# Mixamo FBX → VRMA conversion

This pipeline converts Mixamo animation FBX files into `.vrma` clips that Apia's
VRM runtime plays via [`playVRMAnimation`](../src/main.js).

## 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Blender | 4.x | Must be on PATH, or set `BLENDER_BIN` env var |
| VRM Add-on for Blender | 3.0+ | Install from https://github.com/saturday06/VRM_Addon_for_Blender and **enable** in Preferences → Add-ons |

Verify Blender from shell:
```bash
blender --version
```

## 2. Download Mixamo animations

1. Go to https://www.mixamo.com (Adobe account required).
2. Pick any free character (used only as a rig carrier; Apia swaps it out).
3. Pick an animation. **Export settings:**
   - Format: **FBX Binary (.fbx)**
   - Skin: **Without Skin**
   - Frames per Second: **30**
   - Keyframe Reduction: **none**
4. Save into the folder structure below.

## 3. Folder layout

Drop FBX files into `mixamo-fbx/` at the repo root, mirroring the
VRMA category layout:

```
mixamo-fbx/
  idle/
    breath_soft.fbx
    look_around.fbx
  talk/
    explain.fbx
    happy.fbx
  react/
    big_nod.fbx
    surprised.fbx
```

Filenames (without `.fbx`) must match an entry in
[`src/assets/motions/manifest.json`](../src/assets/motions/manifest.json).

## 4. Run the batch converter

```bash
node scripts/convert-mixamo.mjs
```

Output lands in `src/assets/motions/vrma/<category>/<name>.vrma`. Vite picks them
up automatically on next dev/build — no code change required.

## 5. Troubleshooting

**"VRMA export operator unavailable"**
Older VRM addon versions don't expose a VRMA export operator. The script falls
back to saving a `.blend` next to the target path. Open it and use
**File → Export → VRM Animation (.vrma)** manually.

**"no armature found"**
The FBX export from Mixamo must include the skeleton. Re-export with
**Skin: Without Skin** (armature is still included; only mesh is stripped).

**Animation looks wrong after loading in app**
Mixamo rigs are Y-up while some VRM models use a slightly different rest pose.
If arms point sideways in-app, the clip was exported against a rig whose T-pose
differs from Apia's A-pose. Fix either:
- Re-bake the Mixamo animation against a matching A-pose rest pose, or
- Nudge `setupVRMRestPose` in [`src/main.js`](../src/main.js) so its rest pose
  matches the clip's reference pose.

## 6. What this pipeline doesn't do

- **Does not download from Mixamo automatically.** Mixamo requires login/captcha
  and has no public download API. You must download FBX files manually.
- **Does not retarget between skeletons.** It renames Mixamo bones to VRM
  humanoid names and assumes the rig proportions are close enough. For heavily
  stylised VRM models (chibi, large heads) you may need additional retargeting
  in Blender before invoking the script.
