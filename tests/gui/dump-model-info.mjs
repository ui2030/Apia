// One-off diagnostic: dump the loaded PMX model's bone names, morph names,
// and rigid-body diagnostics so we can tell which mesh region the
// floor-dragging white object belongs to (tail? dress train?) and whether
// the model ships coverage morphs.
import { launchApia } from './helpers/launchApia.mjs'

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

await new Promise((r) => setTimeout(r, 4500))

const info = await mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  if (!scene) return null
  let mesh = null
  scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return null
  const mmd = mesh.geometry?.userData?.MMD
  return {
    boneNames: mesh.skeleton.bones.map((b) => b.name),
    morphNames: Object.keys(mesh.morphTargetDictionary || {}),
    rigidBodyCount: mmd?.rigidBodies?.length ?? 0,
    constraintCount: mmd?.constraints?.length ?? 0,
    // bone index → name for rigid bodies so we can map physics chains
    rigidBodies: (mmd?.rigidBodies || []).map((rb) => ({
      name: rb.name,
      boneIndex: rb.boneIndex,
      type: rb.type,
      groupIndex: rb.groupIndex
    }))
  }
})

if (!info) {
  console.error('no skinned mesh found')
} else {
  console.log('=== BONES (' + info.boneNames.length + ') ===')
  console.log(info.boneNames.join(' | '))
  console.log('\n=== MORPHS (' + info.morphNames.length + ') ===')
  console.log(info.morphNames.join(' | '))
  console.log('\n=== PHYSICS ===')
  console.log('rigidBodies:', info.rigidBodyCount, 'constraints:', info.constraintCount)
  const byName = {}
  for (const rb of info.rigidBodies) {
    const key = rb.name.replace(/[0-9０-９]+$/u, '')
    byName[key] = (byName[key] || 0) + 1
  }
  console.log('rigid body name groups:', JSON.stringify(byName, null, 1))
}

await cleanup()
process.exit(0)
