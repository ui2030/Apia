# 🚀 Apia Project SETUP.md

## 📌 프로젝트 개요

Apia는
**3D 캐릭터 기반 데스크탑 AI 비서 시스템**이다.

단순 챗봇이 아니라:

* 캐릭터가 존재하고
* 말하고
* 감정 반응하고
* 움직이며
* 사용자와 상호작용하는

**캐릭터 중심 AI 인터페이스**를 목표로 한다.

---

## 🧱 프로젝트 구조

```bash
Apia/
├── electron/              # Electron 메인 프로세스
│   ├── main.js
│   └── preload.js
│
├── src/                   # 프론트엔드 (Three.js + UI)
│   ├── main.js
│   ├── chat.js
│   ├── world.js
│   ├── characterController.js
│   ├── motionManager.js
│   ├── characterRuntime.js
│
│   └── assets/
│       ├── characters/
│       │   ├── <character>/
│       │   │   ├── model.vrm
│       │   │   ├── profile.json
│       │   │   ├── interpretation_presets.json
│       │   │   └── motions/
│       │   └── ...
│       └── environments/
│
├── backend/               # FastAPI AI 서버
│   ├── main.py
│   ├── ai_config.py
│   ├── routers/
│   ├── services/
│   └── data/
│
├── index.html
├── settings.html
├── vite.config.mjs
├── package.json
```

---

## ⚙️ 실행 방법

### 1️⃣ 프론트 (Vite)

```bash
npm install
npm run dev
```

---

### 2️⃣ Electron 실행

```bash
npm run electron
```

또는 동시에 실행:

```bash
npm run dev
```

---

### 3️⃣ 백엔드 (FastAPI)

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

---

## 🧠 시스템 핵심 구조

### 🔹 1. 캐릭터 시스템

캐릭터는 2단 구조로 동작한다.

#### ✔️ Canonical (원본)

* profile.json

#### ✔️ Interpretation (해석)

* interpretation_presets.json

---

### 🔹 2. Character Runtime

파일:

```bash
src/characterRuntime.js
```

역할:

* 캐릭터 로드
* 성격 합성
* 모션 그룹 제공
* AI 프롬프트 컨텍스트 생성

---

### 🔹 3. Motion System

파일:

```bash
src/motionManager.js
```

역할:

* 캐릭터 성격 기반 모션 선택
* 랜덤 자연성 확보
* 상태 기반 행동 결정

---

### 🔹 4. Character Controller

파일:

```bash
src/characterController.js
```

역할:

* 실제 움직임 처리
* idle / walk / talk 상태 관리
* 감정 반영
* 시선 추적

---

### 🔹 5. Chat System

파일:

```bash
src/chat.js
```

역할:

* 사용자 입력 처리
* AI 응답 요청
* TTS 실행
* 감정 → 캐릭터 전달

---

### 🔹 6. Backend (AI)

파일:

```bash
backend/
```

역할:

* AI 응답 생성
* 감정 분석
* 웹 검색
* 파일 검색
* 장기 기억

---

## 🧬 캐릭터 설계 구조

### profile.json

```json
{
  "canonicalPersona": { ... },
  "motionPresetGroups": { ... },
  "systemPrompt": "..."
}
```

---

### interpretation_presets.json

```json
{
  "default": {},
  "shy": { "offset": {...} },
  "hardboiled": { "offset": {...} }
}
```

---

## 🎭 핵심 철학

### ❌ 잘못된 방식

* 설정창에서 성격 선택

### ✅ 올바른 방식

* 캐릭터 고유 성격 유지
* 사용자 해석 레이어 추가

👉 “캐릭터 연기 스타일 변경”

---

## 🤖 AI 구조

AI는 단순 응답이 아니라:

* 캐릭터 성격 기반 응답
* 감정 출력
* 모션 힌트 생성
* 음성 스타일 반영

---

## 🧩 확장 기능

### 🔹 1. 웹 검색

* 최신 정보 응답

### 🔹 2. 파일 접근

* 사용자 문서 기반 답변

### 🔹 3. GraphRAG (향후)

* 관계 기반 기억 시스템

---

## 🎯 목표 기능

* [x] 캐릭터 렌더링
* [x] 채팅 + TTS
* [x] 감정 반영
* [x] 모션 시스템
* [x] 자율 행동
* [ ] 환경 상호작용
* [ ] 장기 기억
* [ ] 개인 파일 이해
* [ ] 캐릭터 성격 진화

---

## ⚠️ 주의사항

### 1. 모션 관련

* Mixamo: FBX Binary / 30fps / Without Skin

### 2. 스케일 문제

* baseScale + userScale 구조 유지

### 3. 클릭 문제

* Electron pointer-events 구조 유지

---

## 🚀 다음 개발 단계

1. motionManager 고도화
2. 자율 행동 시스템
3. 캐릭터 감정 강화
4. 환경 인식 시스템
5. 개인 데이터 연동

---

## 💬 최종 목표

> "단순한 AI가 아니라
> 바탕화면 위에서 살아 움직이며
> 사용자와 관계를 형성하는 캐릭터"

---

END
