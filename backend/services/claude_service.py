"""
services/claude_service.py
통합 AI 서비스 — ai_config.py 의 AI_MODE로 전환
지원: local (Qwen2.5) / hf_api / claude / groq
"""

import re
from typing import List, Tuple
from ai_config import (
    AI_MODE, MODEL_ID, HF_TOKEN, ANTHROPIC_KEY, GROQ_KEY,
    SYSTEM_PROMPT, MAX_NEW_TOKENS, TEMPERATURE, TOP_P
)


class ClaudeService:
    def __init__(self):
        print(f"[AI] 모드: {AI_MODE} | 모델: {MODEL_ID}")
        self.mode = AI_MODE
        self._model = None
        self._tok = None
        self._torch = None
        self._init()

    def _init(self):
        if self.mode == "local":
            self._init_local()
        elif self.mode == "hf_api":
            self._init_hf_api()
        elif self.mode == "claude":
            self._init_claude()
        elif self.mode == "groq":
            self._init_groq()

    def _init_local(self):
        try:
            import torch
            from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig

            print(f"[AI] CUDA 사용 가능: {torch.cuda.is_available()}")
            print(f"[AI] 모델 로딩 중... (첫 실행 후 캐싱됨)")

            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_use_double_quant=True,
                bnb_4bit_quant_type="nf4"
            )

            self._tok = AutoTokenizer.from_pretrained(MODEL_ID)
            self._model = AutoModelForCausalLM.from_pretrained(
                MODEL_ID,
                quantization_config=bnb_config,
                device_map="auto",
                low_cpu_mem_usage=True
            )
            self._model.eval()
            self._torch = torch
            print("[AI] 모델 로딩 완료 ✅")

        except ImportError as e:
            print(f"[AI] ImportError: {e}")
            self.mode = "fallback"
        except Exception as e:
            print(f"[AI] 로컬 로딩 실패: {type(e).__name__}: {e}")
            self.mode = "fallback"

    def _init_hf_api(self):
        try:
            from huggingface_hub import InferenceClient
            self._hf_client = InferenceClient(model=MODEL_ID, token=HF_TOKEN or None)
            print("[AI] HuggingFace Inference API 초기화 완료")
        except ImportError as e:
            print(f"[AI] ImportError: {e}")
            self.mode = "fallback"

    def _init_claude(self):
        try:
            import anthropic
            self._claude = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
            print("[AI] Claude API 초기화 완료")
        except ImportError as e:
            print(f"[AI] ImportError: {e}")
            self.mode = "fallback"

    def _init_groq(self):
        try:
            from groq import Groq
            self._groq = Groq(api_key=GROQ_KEY)
            print("[AI] Groq API 초기화 완료")
        except ImportError as e:
            print(f"[AI] ImportError: {e}")
            self.mode = "fallback"

    async def chat(self, message: str, history: List) -> Tuple[str, str]:
        if self.mode == "local":
            reply = await self._chat_local(message, history)
        elif self.mode == "hf_api":
            reply = await self._chat_hf_api(message, history)
        elif self.mode == "claude":
            reply = await self._chat_claude(message, history)
        elif self.mode == "groq":
            reply = await self._chat_groq(message, history)
        else:
            reply = "AI 엔진이 초기화되지 않았어요. 설정을 확인해주세요 🔧 [EMOTION:sad]"
        return self._parse_emotion(reply)

    async def _chat_local(self, message: str, history: List) -> str:
        import asyncio

        def _infer():
            # 히스토리 구성
            messages = [{"role": "system", "content": SYSTEM_PROMPT}]
            for h in history[-10:]:
                messages.append({"role": h.role, "content": h.content})
            messages.append({"role": "user", "content": message})

            # 텍스트 템플릿 적용 후 토크나이즈
            text = self._tok.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True
            )
            inputs = self._tok(text, return_tensors="pt").to("cuda")
            input_ids = inputs["input_ids"]

            with self._torch.no_grad():
                output = self._model.generate(
                    input_ids,
                    max_new_tokens=MAX_NEW_TOKENS,
                    temperature=TEMPERATURE,
                    top_p=TOP_P,
                    do_sample=True,
                    pad_token_id=self._tok.eos_token_id,
                    eos_token_id=self._tok.eos_token_id,
                )

            generated = output[0][input_ids.shape[-1]:]
            return self._tok.decode(generated, skip_special_tokens=True)

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _infer)
        except Exception as e:
            print(f"[AI] 추론 오류: {e}")
            return f"추론 오류가 발생했어요 😢 [EMOTION:sad]"

    async def _chat_hf_api(self, message: str, history: List) -> str:
        import asyncio

        def _call():
            messages = [{"role": "system", "content": SYSTEM_PROMPT}]
            for h in history[-10:]:
                messages.append({"role": h.role, "content": h.content})
            messages.append({"role": "user", "content": message})
            response = self._hf_client.chat_completion(
                messages=messages, max_tokens=MAX_NEW_TOKENS, temperature=TEMPERATURE
            )
            return response.choices[0].message.content

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _call)
        except Exception as e:
            return f"HuggingFace API 오류: {str(e)[:80]} [EMOTION:sad]"

    async def _chat_claude(self, message: str, history: List) -> str:
        try:
            messages = []
            for h in history[-20:]:
                messages.append({"role": h.role, "content": h.content})
            messages.append({"role": "user", "content": message})
            response = self._claude.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=MAX_NEW_TOKENS,
                system=SYSTEM_PROMPT,
                messages=messages
            )
            return response.content[0].text
        except Exception as e:
            return f"Claude API 오류: {str(e)[:80]} [EMOTION:sad]"

    async def _chat_groq(self, message: str, history: List) -> str:
        import asyncio

        def _call():
            messages = [{"role": "system", "content": SYSTEM_PROMPT}]
            for h in history[-10:]:
                messages.append({"role": h.role, "content": h.content})
            messages.append({"role": "user", "content": message})
            response = self._groq.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=messages,
                max_tokens=MAX_NEW_TOKENS,
                temperature=TEMPERATURE,
            )
            return response.choices[0].message.content

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _call)
        except Exception as e:
            return f"Groq API 오류: {str(e)[:80]} [EMOTION:sad]"

    def _parse_emotion(self, text: str) -> Tuple[str, str]:
        emotion = "neutral"
        match = re.search(r'\[EMOTION:(\w+)\]', text)
        if match:
            emotion = match.group(1)
            text = re.sub(r'\s*\[EMOTION:\w+\]', '', text).strip()
        return text, emotion
