#!/usr/bin/env node
// scripts/convert-mixamo.mjs
// Batch-convert Mixamo FBX files to VRMA via Blender headless.
//
// Usage:
//   node scripts/convert-mixamo.mjs <inputDir> [outputDir]
//
// Defaults:
//   inputDir  -> ./mixamo-fbx   (drop Mixamo FBX files here; subfolders mirror target category)
//   outputDir -> ./src/assets/motions/vrma
//
// Naming convention:
//   mixamo-fbx/idle/breath_soft.fbx   ->   src/assets/motions/vrma/idle/breath_soft.vrma
//
// The target filename (without extension) must match a `path` entry in
// src/assets/motions/manifest.json for the clip to be picked up at runtime.

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BLENDER_CMD = process.env.BLENDER_BIN || 'blender'
const PY_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'mixamo-to-vrma.py')

// Preflight: confirm Blender is reachable before walking the FBX tree.
const probe = spawnSync(BLENDER_CMD, ['--version'], { stdio: 'pipe' })
if (probe.error || probe.status !== 0) {
  console.error(`[convert-mixamo] Blender not found at "${BLENDER_CMD}".`)
  console.error('Either add blender to PATH, or set BLENDER_BIN. Windows default:')
  console.error('  BLENDER_BIN="C:/Program Files/Blender Foundation/Blender 4.3/blender.exe" node scripts/convert-mixamo.mjs')
  process.exit(127)
}
console.log(`[convert-mixamo] ${String(probe.stdout).split('\n')[0].trim()}`)

const inputDir = resolve(process.argv[2] || './mixamo-fbx')
const outputDir = resolve(process.argv[3] || './src/assets/motions/vrma')

if (!existsSync(inputDir)) {
  console.error(`[convert-mixamo] input dir not found: ${inputDir}`)
  console.error('Create it and drop Mixamo FBX files in subfolders matching manifest categories.')
  process.exit(1)
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) {
      out.push(...walk(full))
    } else if (name.toLowerCase().endsWith('.fbx')) {
      out.push(full)
    }
  }
  return out
}

const fbxFiles = walk(inputDir)
if (fbxFiles.length === 0) {
  console.log(`[convert-mixamo] no .fbx files under ${inputDir}`)
  process.exit(0)
}

console.log(`[convert-mixamo] found ${fbxFiles.length} FBX file(s). Blender: ${BLENDER_CMD}`)

let ok = 0
let fail = 0
for (const fbx of fbxFiles) {
  const rel = relative(inputDir, fbx).replace(/\\/g, '/')
  const out = join(outputDir, rel.replace(/\.fbx$/i, '.vrma'))
  mkdirSync(dirname(out), { recursive: true })

  console.log(`\n--- ${rel} -> ${relative(process.cwd(), out)}`)
  const res = spawnSync(
    BLENDER_CMD,
    ['--background', '--python', PY_SCRIPT, '--', '--fbx', fbx, '--out', out],
    { stdio: 'inherit' }
  )

  if (res.status === 0) {
    ok += 1
  } else {
    fail += 1
    console.error(`[convert-mixamo] FAILED (${res.status}): ${rel}`)
  }
}

console.log(`\n[convert-mixamo] done. ok=${ok} fail=${fail}`)
process.exit(fail > 0 ? 1 : 0)
