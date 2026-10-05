// 음성 복제 설정 UI 검증 — 백엔드 없이 UI 배선만.
//
//   단언 1: 설정 창에 복제 UI 요소 5종 존재 (이름·파일·만들기·게이지·완료)
//   단언 2: 파일 미선택 시 만들기 버튼 disabled
//   단언 3: 복제 음성(custom:) 선택 시에만 미리듣기/삭제 행 표시
//   단언 4: 다중 파일 — 여러 개 선택 시 목록·합산 길이·개별 제거가 돌고,
//           합산이 5초 미만이면 만들기가 잠긴다
//   단언 5: 30초 초과 — 잠그지 않고 전부 받아 "앞 30초만 사용" 안내로 넘어간다
//   단언 6: 참조 전처리(앞뒤 무음 트림 + 피크 정규화)가 실제로 동작한다
//   단언 7: 먼저 말 걸기·마이크 둘 다 기본 꺼짐 + 제3자 동의 행 감춤(§C)
//   단언 8: 설정 창 콘솔에 페이지 에러 0건 (인라인 스크립트 문법/배선 오류 검출)
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 무음이 아닌(디코더가 삼키지 않게) 사인파 mono 16bit WAV 파일을 만든다. */
function writeSineWav(file, seconds, sr = 22050, freq = 220) {
  const n = Math.round(seconds * sr)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 12000), 44 + i * 2)
  }
  writeFileSync(file, buf)
  return file
}

const { app, mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

const pageErrors = []
try {
  await new Promise((r) => setTimeout(r, 3000))
  const settingsWindow = await openSettingsWindow(app, mainWindow)
  settingsWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 1500))

  const ui = await settingsWindow.evaluate(() => ({
    name: !!document.getElementById('voice-clone-name'),
    file: !!document.getElementById('voice-clone-file'),
    start: !!document.getElementById('voice-clone-start'),
    bar: !!document.getElementById('voice-clone-bar'),
    done: !!document.getElementById('voice-clone-done'),
    startDisabled: document.getElementById('voice-clone-start')?.disabled,
    actionsHidden: document.getElementById('voice-custom-actions')?.hidden
  }))
  const elementsOk = ui.name && ui.file && ui.start && ui.bar && ui.done
  const disabledOk = ui.startDisabled === true

  // custom 옵션을 주입해 선택 → 액션 행 토글 검증 (백엔드 없이).
  // hidden 프로퍼티가 아니라 **실제로 그려지는지**를 본다 — .row{display:flex}가
  // UA의 [hidden]{display:none}을 이겨서 "hidden인데 보이는" 행이 있었다.
  const toggleOk = await settingsWindow.evaluate(() => {
    const row = document.getElementById('voice-custom-actions')
    const visible = () => getComputedStyle(row).display !== 'none'
    const sel = document.getElementById('voice-select')
    const o = document.createElement('option')
    o.value = 'custom:voice_00000000'
    o.textContent = '테스트 (복제 음성)'
    sel.appendChild(o)
    sel.value = o.value
    sel.dispatchEvent(new Event('change'))
    const shown = visible() === true
    sel.value = ''
    sel.dispatchEvent(new Event('change'))
    const hidden = visible() === false
    return shown && hidden
  })

  // ── 단언 4: 다중 파일 ────────────────────────────────────────────────
  const tmpDir = path.resolve('test-results/voice-clone-ui')
  mkdirSync(tmpDir, { recursive: true })
  const wavA = writeSineWav(path.join(tmpDir, 'clip-a.wav'), 3.0)
  const wavB = writeSineWav(path.join(tmpDir, 'clip-b.wav'), 4.0, 22050, 330)

  const multiple = await settingsWindow.evaluate(() =>
    document.getElementById('voice-clone-file').multiple === true
  )

  // input은 hidden이라 액셔너빌리티 체크를 통과 못 한다 — 핸들로 직접 넣는다.
  const inputHandle = await settingsWindow.$('#voice-clone-file')
  await inputHandle.setInputFiles([wavA])
  await new Promise((r) => setTimeout(r, 700))
  const afterOne = await settingsWindow.evaluate(() => ({
    total: document.getElementById('voice-clone-total')?.textContent,
    rows: document.getElementById('voice-clone-file-label').querySelectorAll('button').length,
    startDisabled: document.getElementById('voice-clone-start').disabled
  }))

  await inputHandle.setInputFiles([wavB])
  await new Promise((r) => setTimeout(r, 700))
  const afterTwo = await settingsWindow.evaluate(() => ({
    total: document.getElementById('voice-clone-total')?.textContent,
    rows: document.getElementById('voice-clone-file-label').querySelectorAll('button').length,
    startDisabled: document.getElementById('voice-clone-start').disabled
  }))

  // 목록이 두 개 달린 상태를 증거로 한 장 남긴다 (제거 전).
  await settingsWindow.evaluate(() => {
    document.getElementById('voice-clone-file-label').scrollIntoView({ block: 'center' })
  })
  await new Promise((r) => setTimeout(r, 300))
  await settingsWindow.screenshot({ path: path.join(tmpDir, 'multi-file-list.png') })

  // 첫 항목 제거 → 4.0초만 남아 다시 잠겨야 한다
  await settingsWindow.evaluate(() => {
    document.getElementById('voice-clone-file-label').querySelector('button').click()
  })
  await new Promise((r) => setTimeout(r, 300))
  const afterRemove = await settingsWindow.evaluate(() => ({
    total: document.getElementById('voice-clone-total')?.textContent,
    rows: document.getElementById('voice-clone-file-label').querySelectorAll('button').length,
    startDisabled: document.getElementById('voice-clone-start').disabled
  }))

  console.log(`multi one=${JSON.stringify(afterOne)}`)
  console.log(`multi two=${JSON.stringify(afterTwo)}`)
  console.log(`multi removed=${JSON.stringify(afterRemove)}`)

  const multiOk =
    multiple === true &&
    afterOne.rows === 1 && /3\.0초/.test(afterOne.total || '') && afterOne.startDisabled === true &&
    afterTwo.rows === 2 && /7\.0초/.test(afterTwo.total || '') && afterTwo.startDisabled === false &&
    afterRemove.rows === 1 && /4\.0초/.test(afterRemove.total || '') && afterRemove.startDisabled === true

  // ── 단언 5: 30초 초과는 거절이 아니라 앞 30초 사용 ─────────────────────
  // 3분(180초) 파일 하나. 예전엔 버튼이 잠겼다 — 지금은 열려 있어야 한다.
  const wavLong = writeSineWav(path.join(tmpDir, 'clip-long.wav'), 180, 22050, 200)
  await settingsWindow.evaluate(() => {
    // 앞 단언이 남긴 목록을 비운다(제거 버튼 클릭).
    const list = document.getElementById('voice-clone-file-label')
    list.querySelectorAll('button').forEach((b) => b.click())
  })
  await inputHandle.setInputFiles([wavLong])
  await new Promise((r) => setTimeout(r, 2500))
  const afterLong = await settingsWindow.evaluate(() => ({
    total: document.getElementById('voice-clone-total')?.textContent,
    startDisabled: document.getElementById('voice-clone-start').disabled,
    usedSec: window.__apiaVoiceClone.cloneUsedSec(180)
  }))
  await settingsWindow.evaluate(() => {
    document.getElementById('voice-clone-file-label').scrollIntoView({ block: 'center' })
  })
  await new Promise((r) => setTimeout(r, 300))
  await settingsWindow.screenshot({ path: path.join(tmpDir, 'over-two-minutes-notice.png') })
  const overLongOk =
    afterLong.startDisabled === false &&
    /앞 30초만 사용/.test(afterLong.total || '') &&
    afterLong.usedSec === 30

  // ── 단언 6: 참조 전처리 ───────────────────────────────────────────────
  // 앞뒤 무음 + 작게 녹음된 말소리 → 트림되고 피크가 올라와야 한다.
  const prepOk = await settingsWindow.evaluate(() => {
    const sr = 22050
    const pcm = new Float32Array(sr * 3) // 3초: [무음 1s][말 1s][무음 1s]
    for (let i = sr; i < sr * 2; i++) pcm[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.05
    const out = window.__apiaVoiceClone.preprocessReferencePcm(pcm)
    let peak = 0
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
    return {
      trimmed: out.length < pcm.length * 0.6,   // 무음 2/3가 잘려나갔다
      normalized: peak > 0.9,                   // 0.05 피크가 0.95 근처로
      notEmpty: out.length > sr * 0.5
    }
  })
  const preprocessOk = prepOk.trimmed && prepOk.normalized && prepOk.notEmpty

  // §C 증거 — "먼저 말 걸기 · 음성 입력" 패널(둘 다 기본 꺼짐, 동의 행 감춤).
  const proactiveSection = await settingsWindow.evaluate(() => {
    const el = document.getElementById('proactive-section')
    el.scrollIntoView({ block: 'center' })
    return {
      openerChecked: document.getElementById('proactive-opener-toggle').checked,
      micChecked: document.getElementById('mic-enabled-toggle').checked,
      consentRowHidden: getComputedStyle(document.getElementById('mic-consent-row')).display === 'none'
    }
  })
  await new Promise((r) => setTimeout(r, 300))
  await settingsWindow.screenshot({ path: path.join(tmpDir, 'proactive-mic-section.png') })
  const defaultsOffOk = proactiveSection.openerChecked === false &&
    proactiveSection.micChecked === false && proactiveSection.consentRowHidden === true

  console.log(`proactiveSection=${JSON.stringify(proactiveSection)}`)
  console.log(`overLong=${JSON.stringify(afterLong)}`)
  console.log(`preprocess=${JSON.stringify(prepOk)}`)
  console.log(`elements=${JSON.stringify(ui)}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`\nelementsOk=${elementsOk} disabledOk=${disabledOk} toggleOk=${toggleOk} multiOk=${multiOk} overLongOk=${overLongOk} preprocessOk=${preprocessOk} defaultsOffOk=${defaultsOffOk} noErrors=${pageErrors.length === 0}`)
  if (!elementsOk || !disabledOk || !toggleOk || !multiOk || !overLongOk || !preprocessOk || !defaultsOffOk || pageErrors.length > 0) {
    console.error('VOICE CLONE UI CHECK FAILED')
    await cleanup()
    process.exit(1)
  }
  console.log('VOICE CLONE UI CHECK PASSED')
} finally {
  await cleanup()
}
process.exit(0)
