// src/postFx.js — 후처리 합성기 (쇼츠 격차 #2: 블룸 + 비네트).
//
// 구조 (Codex 사전검토 반영, three r164 소스 확인):
//   OutlineScenePass(외곽선 렌더를 컴포저 체인에 편입)
//   → SavePass(블룸 전 원본 보관 — **알파 소스**)
//   → UnrealBloomPass(readBuffer를 제자리 변형, needsSwap=false)
//   → AlphaVignettePass(rgb=블룸+비네트, **a=원본** — 알파 불변 보장)
//   → OutputPass(ACES 톤매핑+sRGB, 알파 보존 r164 확인)
//
// 왜 알파 복원이 핵심인가: 과거 블룸 합성기는 알파를 깨서(투명 오버레이가
// 검게 뜸) 제거됐다(ROOM 주석의 역사). UnrealBloomPass는 지금도 알파를
// 오염시키므로, 블룸 **전** 장면의 알파를 SavePass로 떠놨다가 마지막에
// 그대로 되살린다 — 방 밖 투명 영역은 데스크톱이 그대로 비친다(블룸이
// 실루엣 밖으로 번지는 헤일로는 알파 0에 눌려 안 보임 — 수용).
//
// 톤매핑 주의: three는 렌더타깃에 그릴 땐 톤매핑/색공간 변환을 건너뛰므로
// 체인 중간은 선형이고 OutputPass가 renderer.toneMapping(ACES)+노출을
// 마지막에 1회 적용 — 직접 렌더와 색이 일치한다(이중 적용 없음).
//
// MSAA: 컴포저 기본 RT는 안티앨리어싱이 없어 현재 캔버스 AA 대비 지글거린다
// → WebGL2에서 samples:4 HalfFloat 타깃 명시(Codex MUST-FIX).
import {
  HalfFloatType,
  Vector2,
  WebGLRenderTarget,
} from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js'
import { SavePass } from 'three/examples/jsm/postprocessing/SavePass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

// 외곽선 렌더(OutlineEffect.render)를 컴포저 첫 패스로. r164 RenderPass의
// 타깃/클리어 규약을 그대로 따르고 렌더 호출만 outlineEffect로 바꾼다
// (OutlineEffect는 내부에서 renderer.render를 부르고, 그건 현재 바인딩된
// 타깃을 존중한다 — r164 소스 확인).
class OutlineScenePass extends Pass {
  constructor(scene, camera, outlineEffect) {
    super()
    this.scene = scene
    this.camera = camera
    this.outlineEffect = outlineEffect
    this.clear = true
    this.needsSwap = false // RenderPass와 동일 — readBuffer에 그린다
  }

  render(renderer, _writeBuffer, readBuffer) {
    const oldAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer)
    if (this.clear) renderer.clear()
    this.outlineEffect.render(this.scene, this.camera)
    renderer.autoClear = oldAutoClear
  }
}

// rgb: 블룸 결과 × 비네트 / a: 블룸 전 원본 — 알파는 어떤 경우에도 불변.
const AlphaVignetteShader = {
  name: 'AlphaVignetteShader',
  uniforms: {
    tDiffuse: { value: null }, // 블룸 적용된 장면
    tBase: { value: null },    // 블룸 전 장면(알파 소스)
    vignette: { value: 0.32 }, // 0=끔, 1=강함
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBase;
    uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec4 bloomed = texture2D(tDiffuse, vUv);
      float a = texture2D(tBase, vUv).a;
      float d = distance(vUv, vec2(0.5)) * 1.4142; // 모서리≈1
      float vig = mix(1.0, smoothstep(1.18, 0.55, d), vignette);
      gl_FragColor = vec4(bloomed.rgb * vig, a);
    }`,
}

/**
 * @returns {{ render(scene,camera):void, setSize(w,h,dpr):void,
 *             setEnabled(on):void, isEnabled():boolean,
 *             setBloom({strength,radius,threshold}):void, setVignette(v):void }}
 */
export function createPostFx({ renderer, scene, camera, outlineEffect }) {
  const size = renderer.getSize(new Vector2())
  const dpr = renderer.getPixelRatio()

  // WebGL2면 MSAA 4 샘플 HalfFloat 타깃(현 캔버스 AA와 시각 동급).
  const isWebGL2 = renderer.capabilities.isWebGL2
  const rt = new WebGLRenderTarget(size.x * dpr, size.y * dpr, {
    type: HalfFloatType,
    samples: isWebGL2 ? 4 : 0,
  })
  const composer = new EffectComposer(renderer, rt)
  composer.setPixelRatio(dpr)
  composer.setSize(size.x, size.y)

  const scenePass = new OutlineScenePass(scene, camera, outlineEffect)
  const savePass = new SavePass() // 블룸 전 스냅숏(알파 소스)
  const bloomPass = new UnrealBloomPass(new Vector2(size.x, size.y), 0.35, 0.4, 0.85)
  const finalPass = new ShaderPass(AlphaVignetteShader)
  finalPass.uniforms.tBase.value = savePass.renderTarget.texture
  const outputPass = new OutputPass()

  composer.addPass(scenePass)
  composer.addPass(savePass)
  composer.addPass(bloomPass)
  composer.addPass(finalPass)
  composer.addPass(outputPass)

  let enabled = true

  return {
    render(sc, cam) {
      if (!enabled) {
        outlineEffect.render(sc, cam)
        return
      }
      scenePass.scene = sc
      scenePass.camera = cam
      composer.render()
    },
    setSize(w, h, pixelRatio) {
      if (Number.isFinite(pixelRatio)) composer.setPixelRatio(pixelRatio)
      composer.setSize(w, h) // SavePass 포함 전 패스에 전파(r164 확인)
    },
    setEnabled(on) { enabled = !!on },
    isEnabled() { return enabled },
    setBloom({ strength, radius, threshold } = {}) {
      if (Number.isFinite(strength)) bloomPass.strength = strength
      if (Number.isFinite(radius)) bloomPass.radius = radius
      if (Number.isFinite(threshold)) bloomPass.threshold = threshold
    },
    setVignette(v) {
      if (Number.isFinite(v)) finalPass.uniforms.vignette.value = Math.max(0, Math.min(1, v))
    },
  }
}
