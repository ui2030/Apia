// 모션 파일(VMD) 검수 도구 — 다운로드/추출한 모션을 투입하기 전에 내용물을
// 확인한다. 어떤 본을 움직이는지, 표정 트랙이 있는지, 길이는 얼마인지,
// (모델을 주면) 우리 모델과 본 이름이 얼마나 맞는지까지.
//
// 사용:
//   node scripts/inspect-vmd.mjs <모션.vmd>
//   node scripts/inspect-vmd.mjs <모션.vmd> --model <모델.pmx>
import { readFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const vmdPath = args.find((a) => !a.startsWith('--'))
const modelIdx = args.indexOf('--model')
const pmxPath = modelIdx >= 0 ? args[modelIdx + 1] : null
if (!vmdPath) {
  console.error('사용법: node scripts/inspect-vmd.mjs <모션.vmd> [--model <모델.pmx>]')
  process.exit(2)
}

const { MMDParser } = await import('three/examples/jsm/libs/mmdparser.module.js')
const parser = new MMDParser.Parser()

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

const vmd = parser.parseVmd(toArrayBuffer(readFileSync(vmdPath)), true)

// ── 본 트랙 요약 ────────────────────────────────────────────────────────
const boneFrames = new Map() // 본 → 프레임 수
let maxFrame = 0
let rootMotionFrames = 0
const ROOT_BONES = new Set(['センター', 'グルーブ', '腰', '全ての親', '左足ＩＫ', '右足ＩＫ', '左足IK', '右足IK'])
for (const m of vmd.motions || []) {
  boneFrames.set(m.boneName, (boneFrames.get(m.boneName) || 0) + 1)
  if (m.frameNum > maxFrame) maxFrame = m.frameNum
  if (ROOT_BONES.has(m.boneName)) {
    const [x, y, z] = m.position || [0, 0, 0]
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) > 0.001) rootMotionFrames++
  }
}

// ── 표정(모프) 트랙 요약 ────────────────────────────────────────────────
const morphFrames = new Map()
for (const m of vmd.morphs || []) {
  morphFrames.set(m.morphName, (morphFrames.get(m.morphName) || 0) + 1)
  if (m.frameNum > maxFrame) maxFrame = m.frameNum
}

console.log(`\n=== ${path.basename(vmdPath)} ===`)
console.log(`대상 모델명(제작 시): ${vmd.metadata?.name || '(없음)'}`)
console.log(`길이: ${maxFrame} 프레임 ≈ ${(maxFrame / 30).toFixed(1)}초 (30fps 기준)`)
console.log(`본 키프레임: ${vmd.motions?.length ?? 0}개 / 본 ${boneFrames.size}종`)
console.log(`표정 키프레임: ${vmd.morphs?.length ?? 0}개 / 모프 ${morphFrames.size}종`)
console.log(`카메라 트랙: ${vmd.cameras?.length ?? 0} (앱에선 무시됨)`)
console.log(`루트 이동 키(센터/IK 위치): ${rootMotionFrames}개 ${rootMotionFrames ? '→ 앱이 자동 제거(제자리 재생)' : ''}`)

const topBones = [...boneFrames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
console.log('\n주요 본(키프레임 많은 순):')
for (const [name, n] of topBones) console.log(`  ${name}: ${n}`)

if (morphFrames.size) {
  const topMorphs = [...morphFrames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  console.log('\n표정 트랙(연기 포함 — 앱이 재생 중 표정 소유권을 클립에 양보):')
  for (const [name, n] of topMorphs) console.log(`  ${name}: ${n}`)
} else {
  console.log('\n표정 트랙 없음 — 몸동작 전용(표정은 앱 절차 표정이 담당)')
}

// ── 모델과 본 이름 대조 ────────────────────────────────────────────────
if (pmxPath) {
  const pmx = parser.parsePmx(toArrayBuffer(readFileSync(pmxPath)), true)
  const modelBones = new Set((pmx.bones || []).map((b) => b.name))
  const modelMorphs = new Set((pmx.morphs || []).map((m) => m.name))
  let hit = 0
  const misses = []
  for (const name of boneFrames.keys()) {
    if (modelBones.has(name)) hit++
    else misses.push(name)
  }
  const pct = boneFrames.size ? Math.round((hit / boneFrames.size) * 100) : 0
  console.log(`\n=== 모델 대조: ${path.basename(pmxPath)} ===`)
  console.log(`본 일치: ${hit}/${boneFrames.size} (${pct}%) ${pct >= 80 ? '✓ 호환 양호' : pct >= 50 ? '△ 일부만 적용됨' : '✗ 호환 낮음(표준 MMD 본명 아님?)'}`)
  if (misses.length) console.log(`모델에 없는 본(무시됨): ${misses.slice(0, 10).join(', ')}${misses.length > 10 ? ` … +${misses.length - 10}` : ''}`)
  if (morphFrames.size) {
    let mHit = 0
    for (const name of morphFrames.keys()) if (modelMorphs.has(name)) mHit++
    console.log(`표정 일치: ${mHit}/${morphFrames.size}`)
  }
}

console.log('\n다음 단계: docs/MOTION_SOURCING.md 참고 (폴더 배치 → manifest 등록 → qa 검수)')
