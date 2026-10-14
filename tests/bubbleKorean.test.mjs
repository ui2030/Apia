// 말풍선 기본 대사에 영어 문장이 섞이지 않게(발주서28 D4 — "Made it to 의자." 재발 방지).
// showBubble(…)·bubbleText:·bubble: 에 박힌 문자열 리터럴(템플릿 포함)을 전부 훑어,
// 알파벳 단어가 있는데 한글이 하나도 없는 문장을 잡는다.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const LITERAL_RE = /(?:showBubble\s*[,(]\s*|bubbleText:\s*|bubble:\s*)(['"`])((?:(?!\1).)*)\1/g

describe('말풍선 기본 대사는 한국어', () => {
  it('영어만으로 된 말풍선 문자열이 없다', () => {
    const offenders = []
    for (const name of readdirSync(SRC).filter((n) => n.endsWith('.js'))) {
      const text = readFileSync(join(SRC, name), 'utf8')
      for (const m of text.matchAll(LITERAL_RE)) {
        const literal = m[2].replace(/\$\{[^}]*\}/g, '')
        if (/[A-Za-z]{2,}/.test(literal) && !/[가-힣]/.test(literal)) offenders.push(`${name}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
