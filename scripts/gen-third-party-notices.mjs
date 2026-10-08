/**
 * THIRD_PARTY_NOTICES.md 생성기 — 설치본에 실제로 들어가는 제3자 구성요소만 모은다.
 *
 *   node scripts/gen-third-party-notices.mjs          # 파일을 새로 쓴다
 *   node scripts/gen-third-party-notices.mjs --check  # 재생성 결과가 현재 파일과 다르면 exit 1
 *
 * 출처:
 *  - npm: `npm ls --omit=dev --all --json --long` (= app.asar 안 node_modules와 일치, 2026-10-09 실측)
 *  - pip: 패키징 venv(backend-build/pkg-venv, `npm run build:backend`가 만든다)의 importlib.metadata
 *         빌드 도구(BUILD_ONLY)는 exe에 안 들어가므로 뺀다(PyInstaller TOC로 실측)
 *  - 그 외(런타임 DLL·Electron·에셋): 아래 MANUAL 표 — 자동 수집이 안 되는 것
 * 출력에 날짜·절대경로를 넣지 않는다 — 재실행 diff 0이 release:check의 조건이다.
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = join(root, 'THIRD_PARTY_NOTICES.md')
const venvPython = join(root, 'backend-build', 'pkg-venv', 'Scripts', 'python.exe')

// 패키징 venv에 있지만 ApiaBackend.exe에 안 들어가는 것 — 빌드 도구, 명시 제외 모듈(watchfiles),
// 런타임에 import되지 않는 것(pycparser·tabulate·빈 메타 패키지 pypiwin32). PyInstaller TOC 대조(2026-10-09).
const BUILD_ONLY = new Set(['pip', 'setuptools', 'pyinstaller', 'pyinstaller-hooks-contrib', 'altgraph', 'pefile', 'pywin32-ctypes', 'watchfiles', 'pycparser', 'tabulate', 'pypiwin32'])

// 메타데이터의 라이선스 표기가 비었거나 틀린 것의 수동 보정. 키 = 'npm:이름' / 'pip:이름'(소문자).
const OVERRIDES = {}

// GPL류·비상업·재배포 제한 판정 — 맞으면 문서 맨 위 "주의" 표에 올라간다.
const CAUTION = /\b(A?GPL|LGPL)|General Public License|non-?commercial|재배포 금지/i

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`

const readRepo = (p) => readFileSync(join(root, p), 'utf8')

// 자동 수집 밖의 번들 구성요소. text = 첨부할 고지 본문(없으면 note로 위치 안내).
const MANUAL = [
  { group: '런타임', name: 'Electron', version: '44.2.0', license: 'MIT', url: 'https://github.com/electron/electron', note: '설치 폴더의 LICENSE.electron.txt (electron-builder가 자동 동봉)' },
  { group: '런타임', name: 'Chromium 및 그 구성요소(FFmpeg 포함)', version: 'Electron 44.2.0 내장', license: 'BSD-3-Clause 외 다수 (ffmpeg.dll은 LGPL-2.1)', url: 'https://www.chromium.org/', note: '설치 폴더의 LICENSES.chromium.html (자동 동봉, 구성요소별 전문 포함)' },
  { group: '런타임', name: 'Python', version: '3.11.3', license: 'PSF-2.0', url: 'https://www.python.org/', note: 'https://docs.python.org/3.11/license.html — ApiaBackend.exe 안의 python311.dll·표준 라이브러리' },
  { group: '런타임', name: 'PyInstaller 부트로더', version: '6.x', license: 'GPL-2.0-or-later WITH Bootloader-exception', url: 'https://pyinstaller.org/', note: '부트로더 예외 조항으로 비GPL 프로그램과 함께 배포 가능 — https://github.com/pyinstaller/pyinstaller/blob/develop/COPYING.txt' },
  { group: '런타임', name: 'libsndfile (soundfile 동봉 DLL)', version: 'soundfile 0.12.1 동봉', license: 'LGPL-2.1-or-later', url: 'https://github.com/libsndfile/libsndfile', note: 'ApiaBackend.exe 안 _soundfile_data/libsndfile_64bit.dll — 동적 링크 DLL 형태. 소스: https://github.com/libsndfile/libsndfile' },
  { group: '런타임', name: 'OpenSSL (libssl/libcrypto)', version: '1.1.x', license: 'OpenSSL AND SSLeay', url: 'https://www.openssl.org/source/license-openssl-ssleay.txt', note: 'This product includes software developed by the OpenSSL Project for use in the OpenSSL Toolkit (http://www.openssl.org/). This product includes cryptographic software written by Eric Young (eay@cryptsoft.com).' },
  { group: '런타임', name: 'SQLite', version: 'anaconda 동봉', license: 'Public Domain', url: 'https://www.sqlite.org/copyright.html' },
  { group: '런타임', name: 'libffi', version: 'anaconda 동봉', license: 'MIT', url: 'https://github.com/libffi/libffi/blob/master/LICENSE' },
  { group: '런타임', name: 'zlib', version: 'anaconda 동봉', license: 'Zlib', url: 'https://zlib.net/zlib_license.html' },
  { group: '런타임', name: 'bzip2 (libbz2)', version: 'anaconda 동봉', license: 'bzip2-1.0.6', url: 'https://sourceware.org/bzip2/' },
  { group: '런타임', name: 'XZ Utils (liblzma)', version: 'anaconda 동봉', license: '0BSD / Public Domain', url: 'https://tukaani.org/xz/' },
  { group: '런타임', name: 'Microsoft Visual C++ 런타임 (VCRUNTIME140·UCRT)', version: '-', license: 'Microsoft 재배포 가능 파일 조항', url: 'https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files' },
  { group: '런타임', name: 'ammo.js (three 동봉, 물리)', version: 'three 0.164.1 동봉', license: 'Zlib', url: 'https://github.com/kripken/ammo.js', note: 'three/examples/jsm/libs/ammo.wasm.* — Bullet Physics 포트' },
  { group: '런타임', name: 'mmdparser (three 동봉)', version: 'three 0.164.1 동봉', license: 'MIT', url: 'https://github.com/takahirox/mmd-parser' },
  { group: '런타임', name: 'fflate (three 동봉, FBXLoader)', version: 'three 0.164.1 동봉', license: 'MIT', url: 'https://github.com/101arrowz/fflate' },
  { group: '에셋', name: 'Kenney Furniture Kit 2.0 (가구 GLB)', version: '2.0', license: 'CC0-1.0', url: 'https://kenney.nl/assets/furniture-kit', text: readRepo('src/assets/room/License.txt').trim() },
  { group: '에셋', name: 'ambientCG 텍스처 (WoodFloor051·Wallpaper002A·Fabric030)', version: '1K JPG', license: 'CC0-1.0', url: 'https://ambientcg.com', text: readRepo('src/assets/textures/LICENSE-ambientCG.txt').trim() },
  { group: '에셋', name: 'VRMA 모션 클립 (virtual-avatar-sdk)', version: '-', license: 'MIT', url: 'https://github.com/hirokazuniimoto/virtual-avatar-sdk', text: `Copyright (c) 2026 Virtual Avatar SDK Contributors\n\n${MIT}` },
  { group: '에셋', name: 'VRMA 모션 클립 (vrm-viewer)', version: '-', license: 'MIT', url: 'https://github.com/tk256ailab/vrm-viewer', text: `Copyright (c) 2025 TK256\n\n${MIT}` },
  { group: '에셋', name: 'VRMA 샘플 클립 (three-vrm test.vrma)', version: '-', license: 'MIT', url: 'https://github.com/pixiv/three-vrm', note: '@pixiv/three-vrm과 같은 라이선스 — 아래 npm 항목 전문 참조' },
  { group: '에셋', name: 'Deedee524 Idle Animation Pack (VMD 원본 9종)', version: '-', license: '원본 재배포 금지 · 크레딧 필수 (작가 고유 조건)', url: 'https://www.deviantart.com/deedee524/art/Idle-Animation-Pack-759426476', note: 'git에선 제외(.gitignore)지만 로컬에 파일이 있으면 vite 빌드가 dist/assets에 넣어 설치본에 들어간다: air_scent·confident·fix_hair·impatient·skywatch·stretch·sway·tidy·tracker.vmd. Credit: motions by deedee524.', text: readRepo('src/assets/motions/vmd/idle/LICENSE-deedee524.txt').split('NOTES:')[0].trim(), caution: true },
  { group: '자체', name: 'win-wallpaper.exe', version: '-', license: 'Apia 자체 코드 (scripts/win-wallpaper.cs)', url: '-' }
]

function licenseFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
}

function npmPackages() {
  const tree = JSON.parse(execSync('npm ls --omit=dev --all --json --long', { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }))
  const seen = new Map()
  ;(function walk(node) {
    for (const [name, dep] of Object.entries(node.dependencies || {})) {
      const key = `${name}@${dep.version}`
      if (!seen.has(key) && dep.path) {
        const pkg = JSON.parse(readFileSync(join(dep.path, 'package.json'), 'utf8'))
        const lic = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type || pkg.licenses?.map((l) => l.type || l).join(' OR '))
        seen.set(key, { group: 'npm', name, version: dep.version, license: lic || 'UNKNOWN', url: `https://www.npmjs.com/package/${name}`, texts: licenseFiles(dep.path) })
      }
      walk(dep)
    }
  })(tree)
  return [...seen.values()]
}

const PY = `
import importlib.metadata as md, json, re
out = []
for d in md.distributions():
    m = d.metadata
    lic = m.get('License-Expression') or ''
    raw = (m.get('License') or '').strip()
    if raw.upper() == 'UNKNOWN': raw = ''
    if not lic and raw and len(raw) <= 80 and '\\n' not in raw: lic = raw
    if not lic:
        cls = [c.split('::')[-1].strip() for c in (m.get_all('Classifier') or []) if c.startswith('License ::')]
        lic = ' / '.join(cls)
    texts = []
    for f in sorted(d.files or [], key=str):
        if re.search(r'(^|/)(licen[cs]e|copying|notice)[^/]*$', str(f), re.I) and '.dist-info' in str(f):
            try: texts.append(open(f.locate(), encoding='utf-8', errors='replace').read())
            except Exception: pass
    if not texts and len(raw) > 80: texts.append(raw)
    out.append({'name': m['Name'], 'version': d.version, 'license': lic or 'UNKNOWN', 'texts': texts})
print(json.dumps(out))
`

function pipPackages() {
  if (!existsSync(venvPython)) throw new Error('[NOTICES_NO_PKG_VENV] backend-build/pkg-venv 없음 — npm run build:backend 먼저')
  const r = spawnSync(venvPython, ['-c', PY], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, PYTHONUTF8: '1' } })
  if (r.status !== 0) throw new Error(`[NOTICES_PIP_FAILED] ${r.stderr}`)
  const byName = new Map()
  for (const p of JSON.parse(r.stdout)) {
    if (BUILD_ONLY.has(p.name.toLowerCase())) continue
    byName.set(p.name.toLowerCase(), { group: 'pip', ...p, url: `https://pypi.org/project/${p.name}/` })
  }
  return [...byName.values()]
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const sortKey = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.version.localeCompare(b.version)

function render() {
  const npm = npmPackages().sort(sortKey)
  const pip = pipPackages().sort(sortKey)
  for (const p of [...npm, ...pip]) {
    const o = OVERRIDES[`${p.group}:${p.name.toLowerCase()}`]
    if (o) Object.assign(p, o)
  }
  const all = [...MANUAL, ...npm, ...pip]
  const unknown = all.filter((p) => p.license === 'UNKNOWN')
  if (unknown.length) console.warn(`[NOTICES_WARN] 라이선스 미상(OVERRIDES에 보정 필요): ${unknown.map((p) => p.name).join(', ')}`)

  const table = (rows) => ['| 이름 | 버전 | 라이선스 | 출처 |', '| --- | --- | --- | --- |', ...rows.map((p) => `| ${cell(p.name)} | ${cell(p.version)} | ${cell(p.license)} | ${cell(p.url)} |`)].join('\n')
  const cautions = all.filter((p) => p.caution || CAUTION.test(p.license))

  const L = []
  L.push('# Third-Party Notices', '')
  L.push('Apia 설치본(Apia-Setup-*.exe)에 포함되는 제3자 구성요소와 라이선스 고지.', '')
  L.push('이 파일은 `node scripts/gen-third-party-notices.mjs`로 생성한다 — 직접 고치지 말고 스크립트의 MANUAL/OVERRIDES 표를 고친 뒤 재생성할 것.', '')
  L.push('개발 환경 전용(설치본 미포함): seed-vc(GPL-3.0, 음성 복제 실험), torch·transformers·openai-whisper 등 로컬 모델 스택, devDependencies(electron-builder·vite·vitest·playwright 등).', '')
  L.push('## 주의 — GPL류·재배포 제한 항목', '', table(cautions), '')
  for (const g of ['런타임', '에셋', '자체']) L.push(`## ${g}`, '', table(MANUAL.filter((p) => p.group === g)), '')
  L.push('## npm 패키지 (Electron 앱 런타임 의존성)', '', table(npm), '')
  L.push('## Python 패키지 (ApiaBackend.exe에 번들)', '', table(pip), '')

  L.push('## 라이선스 전문', '')
  L.push('같은 본문은 한 번만 싣고 해당 패키지를 위에 나열한다.', '')
  for (const p of MANUAL.filter((p) => p.note || p.text)) {
    L.push(`### ${p.name}`, '')
    if (p.note) L.push(p.note, '')
    if (p.text) L.push('```text', p.text, '```', '')
  }
  const byText = new Map()
  const noText = []
  for (const p of [...npm, ...pip]) {
    if (!p.texts.length) { noText.push(p); continue }
    const body = p.texts.map((t) => t.replace(/\r\n/g, '\n').trim()).join('\n\n-----\n\n')
    if (!byText.has(body)) byText.set(body, [])
    byText.get(body).push(`${p.name}@${p.version}`)
  }
  for (const [body, names] of byText) {
    L.push(`### ${names.join(', ')}`, '', '```text', body.replace(/```/g, "'''"), '```', '')
  }
  if (noText.length) {
    L.push('### 패키지에 라이선스 파일이 없는 항목', '', '아래는 라이선스 이름만 메타데이터에 있고 전문 파일이 동봉돼 있지 않다 — 해당 표준 라이선스 본문을 따른다.', '')
    for (const p of noText) L.push(`- ${p.name}@${p.version} — ${p.license}`)
    L.push('')
  }
  return L.join('\n')
}

const text = render().replace(/\r\n?/g, '\n')
if (process.argv.includes('--check')) {
  const current = existsSync(outPath) ? readFileSync(outPath, 'utf8').replace(/\r\n?/g, '\n') : ''
  if (current !== text) {
    console.error('[NOTICES_STALE] THIRD_PARTY_NOTICES.md가 최신이 아니다 — node scripts/gen-third-party-notices.mjs 로 재생성')
    process.exit(1)
  }
  console.log('[NOTICES_OK] THIRD_PARTY_NOTICES.md 최신')
} else {
  writeFileSync(outPath, text)
  console.log(`[NOTICES_WRITTEN] ${outPath}`)
}
