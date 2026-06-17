// D단계 진단: PMX를 직접 파싱해 꼬리(しっぽ) 체인의 본/강체/조인트 파라미터와
// ★Up_しっぽ 본 모프(모델 제작자가 의도한 "꼬리 올림" 자세)를 덤프한다.
// three.js가 본 모프를 적용하지 않으므로, 이 데이터를 코드에서 재현할 근거.
import { readFileSync } from 'node:fs'
import { MMDParser } from '../../node_modules/three/examples/jsm/libs/mmdparser.module.js'

// Local-only debug tool — point APIA_PMX at your model file.
const PMX = process.env.APIA_PMX || 'src/assets/model/model.pmx'
const buf = readFileSync(PMX)
const parser = new MMDParser.Parser()
const pmx = parser.parsePmx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), true)

const isTail = (n) => /しっぽ/.test(n)

console.log('=== TAIL BONES ===')
pmx.bones.forEach((b, i) => {
  if (!isTail(b.name)) return
  console.log(i, b.name, 'parent=', pmx.bones[b.parentIndex]?.name, 'pos=', b.position.map((v) => +v.toFixed(3)))
})

console.log('\n=== TAIL RIGID BODIES ===')
pmx.rigidBodies.forEach((rb, i) => {
  if (!isTail(rb.name)) return
  console.log(i, rb.name, {
    bone: pmx.bones[rb.boneIndex]?.name,
    type: rb.type, // 0=뼈추종 1=물리 2=물리+뼈위치
    shape: rb.shapeType,
    weight: rb.weight,
    friction: rb.friction,
    restitution: rb.restitution,
    posDamp: rb.positionDamping,
    rotDamp: rb.rotationDamping,
    group: rb.groupIndex,
  })
})

console.log('\n=== TAIL CONSTRAINTS ===')
pmx.constraints.forEach((c, i) => {
  if (!isTail(c.name)) return
  console.log(i, c.name, {
    bodies: [pmx.rigidBodies[c.rigidBodyIndex1]?.name, pmx.rigidBodies[c.rigidBodyIndex2]?.name],
    rotMin: c.rotationConstraint1?.map((v) => +(v * 57.2958).toFixed(1)),
    rotMax: c.rotationConstraint2?.map((v) => +(v * 57.2958).toFixed(1)),
    springRot: c.springRotation,
  })
})

console.log('\n=== BONE MORPHS (★ 계열) ===')
pmx.morphs.forEach((m) => {
  if (m.type !== 2) return // 2 = bone morph
  if (!/しっぽ|胸上げ/.test(m.name)) return
  console.log(m.name, 'elements:', m.elementCount)
  m.elements.forEach((el) => {
    console.log('  bone=', pmx.bones[el.index]?.name,
      'trans=', el.position.map((v) => +v.toFixed(4)),
      'rotQ=', el.rotation.map((v) => +v.toFixed(4)))
  })
})
