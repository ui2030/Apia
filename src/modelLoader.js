// src/modelLoader.js

import * as THREE from 'three'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'

export async function loadModelFromManifest(manifest) {
  const loader = new MMDLoader()

  // ⭐ 텍스처 자동 복구 핵심
  loader.manager.setURLModifier((url) => {
    const fileName = url.split('/').pop().toLowerCase()

    const candidates = manifest.textureBasenameMap[fileName]

    if (candidates && candidates.length > 0) {
      console.log('[텍스처 복구]', fileName, '→', candidates[0].fileUrl)
      return candidates[0].fileUrl
    }

    return url
  })

  return new Promise((resolve, reject) => {
    loader.load(
      manifest.entryFileUrl,
      (mesh) => resolve(mesh),
      undefined,
      reject
    )
  })
}