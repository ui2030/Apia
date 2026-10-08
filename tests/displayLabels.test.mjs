// 설정 창 표시용 사전(settings.html의 <display-labels> 블록)을 그대로 꺼내 돌린다.
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'

const html = await readFile(new URL('../settings.html', import.meta.url), 'utf-8')
const block = html.match(/\/\/ <display-labels>[^\n]*\n([\s\S]*?)\/\/ <\/display-labels>/)[1]
const displayLabel = new Function(`${block}; return displayLabel`)()

describe('표시용 사전', () => {
  it('모델 id를 화면 이름으로 바꾼다', () => {
    expect(displayLabel('groq')).toBe('Groq API')
    expect(displayLabel('claude')).toBe('Claude API')
    expect(displayLabel('claude_code')).toBe('Claude Code (구독)')
    expect(displayLabel('deepseek')).toBe('클라우드 모델 (DeepSeek)')
    expect(displayLabel('local')).toBe('로컬 모델')
    expect(displayLabel('hf_api')).toBe('HuggingFace API')
    expect(displayLabel('ollama_vlm')).toBe('Ollama (내 PC 그림 모델)')
    expect(displayLabel('auto')).toBe('자동 (권장)')
  })

  it('사유 코드는 정확히 같거나 앞부분이 같으면 바꾼다', () => {
    expect(displayLabel('no-observation')).toBe('본 것이 없음')
    expect(displayLabel('local path busy')).toBe('로컬 모델이 다른 일을 하는 중')
    expect(displayLabel('budget')).toBe('사용료 상한에 닿음')
    expect(displayLabel('daily budget reached ($0.0700 >= $0.07)')).toBe('오늘 사용료 상한에 닿아서 미룸')
  })

  it('사전에 없는 값은 숨기지 않고 원문 그대로 둔다', () => {
    expect(displayLabel('SomethingNew: boom')).toBe('SomethingNew: boom')
    expect(displayLabel('이미 한국어')).toBe('이미 한국어')
    expect(displayLabel('toString')).toBe('toString') // 객체 기본 속성에 걸리지 않는다
    expect(displayLabel(null)).toBe('')
  })
})
