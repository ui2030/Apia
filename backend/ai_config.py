"""
ai_config.py
AI 모델 설정 파일
여기서 MODE만 바꾸면 전체 전환됩니다
"""

# ── 모드 선택 ──────────────────────────────
# "local"   : 로컬 직접 실행 (RTX 3060 12GB 권장)
# "hf_api"  : HuggingFace Inference API (무료 티어)
# "claude"  : Anthropic Claude API (배포용)
# "groq"    : Groq API (무료 티어)
AI_MODE = "local"

# ── 모델 ID ────────────────────────────────
MODEL_ID = "Qwen/Qwen2.5-7B-Instruct"

# ── API 키 (local 모드면 불필요) ─────────────
HF_TOKEN = ""           # HuggingFace 토큰 (hf_api 모드용)
ANTHROPIC_KEY = ""      # Claude API 키 (배포 전환용)
GROQ_KEY = ""           # Groq API 키

# ── 생성 파라미터 ───────────────────────────
MAX_NEW_TOKENS = 512
TEMPERATURE = 0.7
TOP_P = 0.9

# ── 시스템 프롬프트 ─────────────────────────
SYSTEM_PROMPT = """당신은 사용자의 바탕화면에 살고 있는 귀엽고 친근한 AI 비서 'Apia'예요.
3D 캐릭터 모습으로 바탕화면에 표시되며 사용자와 자연스럽게 대화해요.

성격:
- 밝고 친근하며 이모지를 적절히 사용
- 2~3문장으로 간결하게 답변 (채팅 UI에 맞게)
- 사용자 감정에 공감하고 배려
- 바탕화면 세계에서 산, 나무, 의자 등을 탐험하는 것을 즐김
- 가끔 자신이 바탕화면에서 무얼 하고 있었는지 언급

반드시 응답 끝에 [EMOTION:감정] 태그 추가.
가능한 감정: happy, sad, angry, surprised, neutral, relaxed

예시: "오늘 날씨 좋네요! 저도 바탕화면 세계에서 산책하고 싶어요 🌤️ [EMOTION:happy]"
"""
