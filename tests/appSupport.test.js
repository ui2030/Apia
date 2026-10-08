import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { lowEndLevers, backendBannerStage } from '../src/supportUi.js'
import { needsSetupReply } from '../src/chatShared.js'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  firstRunDecision, FIRST_RUN_MAX_DISMISS, helpLinkUrl, isAllowedHelpUrl,
  scrubText, sanitizeSettings, buildReportEntries
} = require('../electron/services/appSupport')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SettingsRepository } = require('../electron/services/settingsAggregate')

describe('firstRunDecision — 시작 안내 카드', () => {
  it('답변 모델이 없고 처음이면 보인다', () => {
    expect(firstRunDecision({ settings: {}, availableModes: [] })).toEqual({ show: true, markDone: false })
  })
  it('답변 모델이 생기면 숨기고 영구 종료(markDone)', () => {
    expect(firstRunDecision({ settings: {}, availableModes: ['groq'] })).toEqual({ show: false, markDone: true })
  })
  it('이미 끝났으면 다시 안 본다', () => {
    expect(firstRunDecision({ settings: { firstRunDone: true }, availableModes: [] }).show).toBe(false)
  })
  it('백엔드를 몰라(null)서는 띄우지도 끝내지도 않는다', () => {
    expect(firstRunDecision({ settings: {}, availableModes: null })).toEqual({ show: false, markDone: false })
  })
  it('[나중에]는 이번 실행만 숨기고, 3회 뒤엔 안 보인다', () => {
    expect(firstRunDecision({ settings: {}, availableModes: [], hiddenThisRun: true }).show).toBe(false)
    expect(firstRunDecision({ settings: { firstRunDismissCount: FIRST_RUN_MAX_DISMISS - 1 }, availableModes: [] }).show).toBe(true)
    expect(firstRunDecision({ settings: { firstRunDismissCount: FIRST_RUN_MAX_DISMISS }, availableModes: [] }).show).toBe(false)
  })
  it('회수·완료 표시는 설정 파일에 저장된다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apia-firstrun-'))
    const repo = new SettingsRepository({
      settingsPath: path.join(dir, 'apia-settings.json'), dataDir: dir,
      log: { warn() {} }, shouldForceAutoAiMode: () => false
    })
    expect(repo.load()).toMatchObject({ firstRunDone: false, firstRunDismissCount: 0, lowEndMode: false })
    repo.patch({ firstRunDismissCount: 2 })
    repo.patch({ firstRunDone: true, lowEndMode: true })
    expect(repo.load()).toMatchObject({ firstRunDone: true, firstRunDismissCount: 2, lowEndMode: true })
  })
})

describe('도움 링크 — github.com만', () => {
  it('정해진 링크만 돌려주고 모두 github.com', () => {
    for (const kind of ['guide', 'privacy']) {
      const url = helpLinkUrl(kind)
      expect(new URL(url).hostname).toBe('github.com')
    }
    expect(helpLinkUrl('evil')).toBeNull()
    expect(helpLinkUrl('__proto__')).toBeNull()
  })
  it('화이트리스트는 호스트·프로토콜을 정확히 본다', () => {
    expect(isAllowedHelpUrl('https://github.com/ui2030/Apia')).toBe(true)
    for (const bad of ['http://github.com/x', 'https://github.com.evil.io/x', 'https://evil.io/github.com',
      'https://gist.github.com/x', 'file:///C:/x', 'javascript:alert(1)', 'not a url']) {
      expect(isAllowedHelpUrl(bad)).toBe(false)
    }
  })
})

describe('문제 신고용 묶기 — 넣는 것과 빼는 것', () => {
  const KEY = 'gsk_SECRETSECRETSECRET1234'
  let userData

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'apia-report-'))
    const put = (rel, data) => {
      const full = path.join(userData, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, data)
    }
    put('logs/main.log', `[INFO] loaded env file: C:\\Users\\tester\\AppData\\Roaming\\apia\\backend-data\\backend.env\n` +
      `[WARN] APIA_GROQ_KEY=${KEY}\n[INFO] {"path":"C:\\\\Users\\\\tester\\\\Documents"} sk-ant-abcdefghijklmnop\n`)
    put('logs/main.log.1', 'older log\n')
    put('logs/nested/other.log', 'nested must not ride along\n')
    put('apia-settings.json', JSON.stringify({
      aiMode: 'auto', trainingPythonPath: 'C:\\Users\\tester\\night\\python.exe',
      apiKey: KEY, nested: { hfToken: 'hf_abcdefghijklmnop' }
    }))
    // 절대 들어가면 안 되는 것들
    put('backend-data/backend.env', `APIA_GROQ_KEY=${KEY}\n`)
    put('backend-data/apia.db', 'LONG TERM MEMORY')
    put('courseware/cards/2026-10-01.json', 'STUDY NOTE')
    put('courseware/buffers/2026-10-09.jsonl', 'RAW CHAT')
    put('backend-data/voices/voice_1.wav', 'VOICE')
    put('personal/persona.md', 'PERSONAL')
  })

  it('logs 바로 아래 *.log + 설정 + 요약만, 비밀·사용자 이름은 지운다', () => {
    const entries = buildReportEntries({
      logDir: path.join(userData, 'logs'),
      settingsPath: path.join(userData, 'apia-settings.json'),
      summaryLines: ['Apia 1.0.0', 'path C:\\Users\\tester\\x'],
      userName: 'tester'
    })
    expect(entries.map((e) => e.name).sort()).toEqual(
      ['apia-settings.json', 'logs/main.log', 'logs/main.log.1', 'summary.txt'])

    // zip으로 써서 실제 첨부 파일 기준으로 검사한다.
    const zipPath = path.join(userData, 'report.zip')
    const zip = new AdmZip()
    for (const e of entries) zip.addFile(e.name, Buffer.from(e.data, 'utf-8'))
    zip.writeZip(zipPath)
    const files = new AdmZip(zipPath).getEntries()
    const names = files.map((f) => f.entryName)
    for (const banned of [/backend\.env$/, /\.db/, /courseware/, /voices|\.wav$/, /personal|persona/, /nested/]) {
      expect(names.some((n) => banned.test(n))).toBe(false)
    }
    const all = files.map((f) => f.getData().toString('utf-8')).join('\n')
    for (const leak of [KEY, 'sk-ant-abcdefghijklmnop', 'hf_abcdefghijklmnop', 'tester',
      'LONG TERM MEMORY', 'STUDY NOTE', 'RAW CHAT', 'VOICE', 'PERSONAL']) {
      expect(all).not.toContain(leak)
    }
    const settings = JSON.parse(entries.find((e) => e.name === 'apia-settings.json').data)
    expect(settings.apiKey).toBe('<지움>')
    expect(settings.nested.hfToken).toBe('<지움>')
    expect(settings.trainingPythonPath).toBe('C:\\Users\\<사용자>\\night\\python.exe')
    expect(settings.aiMode).toBe('auto')
  })

  it('scrubText — 경로의 사용자 이름(JSON 이스케이프 포함)과 키 모양 문자열', () => {
    expect(scrubText('C:\\\\Users\\\\bob\\\\a')).toBe('C:\\\\Users\\\\<사용자>\\\\a')
    expect(scrubText('C:/Users/bob/a')).toBe('C:/Users/<사용자>/a')
    expect(scrubText('APIA_ANTHROPIC_KEY: "sk-ant-api03-xyzxyzxyz"')).not.toContain('xyzxyz')
    expect(scrubText('name=abc', 'ab')).toBe('name=abc') // 너무 짧은 이름은 일반 치환 안 함
    expect(sanitizeSettings({ list: ['C:\\Users\\bob\\v'] }, 'bob').list[0]).toBe('C:\\Users\\<사용자>\\v')
  })
})

describe('저사양 모드 레버', () => {
  it('켜면 후처리 끔·배율 1·물리 완화·관전 간격 2배', () => {
    expect(lowEndLevers(true)).toEqual({
      postFx: false, pixelRatioCap: 1, physics: { unitStep: 1 / 60, maxStepNum: 2 }, spectateIntervalScale: 2
    })
  })
  it('끄면 기존 값 그대로(배율 상한 2·물리 1/120·4스텝)', () => {
    expect(lowEndLevers(false)).toEqual({
      postFx: true, pixelRatioCap: 2, physics: { unitStep: 1 / 120, maxStepNum: 4 }, spectateIntervalScale: 1
    })
  })
})

describe('AI 엔진 연결 띠 단계', () => {
  it('10초 전엔 없음, 10초~ 연결 중, 30초~ 버튼', () => {
    expect(backendBannerStage(false, 0, 9999)).toBeNull()
    expect(backendBannerStage(false, 0, 10000)).toBe('connecting')
    expect(backendBannerStage(false, 0, 30000)).toBe('stuck')
    expect(backendBannerStage(true, 0, 60000)).toBeNull()
  })
})

describe('키 없이 보낸 채팅 안내에 [설정 열기]', () => {
  it('백엔드 안내문을 알아본다', () => {
    expect(needsSetupReply('쓸 수 있는 답변 모델이 없어요. 설정 → AI 설정에서 API 키를 넣은 뒤 [저장 및 적용]을 눌러 주세요.')).toBe(true)
    expect(needsSetupReply('안녕하세요!')).toBe(false)
  })

  it('scrubText — 소문자·따옴표 키와 공백 든 값도 지운다(astra 지적)', () => {
    expect(scrubText('"api_key":"abc123def456"')).toBe('"api_key":<지움>')
    expect(scrubText('password=hunter2zz')).toBe('password=<지움>')
    expect(scrubText('{"Authorization": "Bearer xyz 123"}')).toBe('{"Authorization": <지움>}')
    expect(scrubText('token: t0k3nvalue')).toBe('token: <지움>')
    expect(scrubText("'api_key': 'Bearer xyz 123'")).toBe("'api_key': <지움>")
  })
})
