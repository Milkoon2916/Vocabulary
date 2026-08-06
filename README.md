# 단어장 퀴즈 — Render 배포용

Claude 아티팩트 안에서만 동작하던 버전을, 외부 사람들도 쓸 수 있는
독립 웹앱(React 프론트엔드 + Express 백엔드)으로 바꾼 버전이에요.

## 무엇이 바뀌었나요

| 기능 | 아티팩트 버전 | 이 버전 |
|---|---|---|
| 데이터 저장 | `window.storage` (Claude 전용) | Express 서버 + 파일 저장(`/api/kv/*`) |
| AI 자동완성/지문추출 | 브라우저에서 Anthropic API 직접 호출 | 서버가 Google Gemini API를 `GOOGLE_API_KEY`로 대신 호출 (`/api/ai/generate`) |
| 선생님 비밀번호 | 클라이언트에만 하드코딩 | 클라이언트 UI 잠금 + **서버도 같은 PIN을 검증**해서 단어장/학생 데이터 쓰기를 보호 |

## 로컬에서 테스트하기

```bash
# 1) 프론트엔드 빌드
cd client
npm install
npm run build
cd ..

# 2) 서버 설치 및 실행
npm install
cp .env.example .env   # GOOGLE_API_KEY 채워넣기
node server.js
```

`http://localhost:10000` 접속.

개발 중 프론트만 수정하면서 핫리로드 쓰고 싶다면:
```bash
# 터미널 1: 서버
node server.js

# 터미널 2: 프론트 (vite dev 서버, /api는 자동으로 10000번 서버로 프록시됨)
cd client && npm run dev
```

## Render에 배포하기

### 방법 A — Blueprint(render.yaml)로 한번에
1. 이 폴더를 GitHub 저장소로 올려요.
2. Render 대시보드 → **New +** → **Blueprint** → 저장소 선택 (`render.yaml`을 자동으로 인식해요).
3. `GOOGLE_API_KEY` 값을 입력하라고 물어보면 채워넣어요 (`sync: false`라서 대시보드에서 직접 입력).
4. Deploy.

### 방법 B — Docker 서비스 수동 생성
1. GitHub에 이 폴더를 올려요.
2. Render 대시보드 → **New +** → **Web Service** → 저장소 선택.
3. **Runtime**을 `Docker`로 선택 (Dockerfile을 자동으로 찾아요).
4. **Environment** 탭에서 아래 값을 추가:
   - `GOOGLE_API_KEY` = 여러분의 Google AI (Gemini) API 키 (필수)
   - `TEACHER_PIN` = 선생님 모드 비밀번호 (선택, 기본 `5136`)
   - `GOOGLE_MODEL` = 사용할 모델 (선택, 기본 `gemini-2.0-flash`)
5. Deploy 누르면 끝. 몇 분 뒤 `https://your-app.onrender.com` 같은 주소가 생겨요 — 이 주소를 학생들에게 공유하면 돼요.

## 선생님 비밀번호(PIN) 관련 주의

- 서버는 `TEACHER_PIN` 환경변수(기본 `5136`)로 단어장·학생 명단(`config`) 저장 요청을 검증해요.
- 클라이언트 화면의 잠금 비밀번호는 빌드 시점에 `VITE_TEACHER_PIN` 값으로 정해져요 (기본값도 `5136`이라 아무 설정 없이 그대로 써도 둘이 일치해요).
- **PIN을 바꾸고 싶다면 두 곳을 함께 바꿔야 해요**:
  1. 서버 환경변수 `TEACHER_PIN`
  2. `client/.env`의 `VITE_TEACHER_PIN` (또는 Docker 빌드 시 `--build-arg VITE_TEACHER_PIN=원하는값`) 후 재배포
- 값이 서로 다르면, 화면에서는 로그인이 되어 보여도 실제 저장(단어 추가/학생 등록 등)은 401 오류로 실패해요.

## 데이터 저장에 대해 꼭 알아두세요 (중요)

기본 설정은 컨테이너 안의 파일(`/app/data/kv-store.json`)에 데이터를 저장해요.
**Render는 기본적으로 컨테이너 파일시스템이 임시(ephemeral)라서, 재배포하거나 서비스가
재시작되면 이 데이터가 사라져요.**

데이터를 계속 유지하려면 둘 중 하나를 하세요:
1. **Render 영구 디스크(Persistent Disk)** 추가 (유료 플랜 필요) → `render.yaml`의 `disk` 주석을 풀고, `DATA_DIR=/app/data`로 맞추기.
2. 실제 데이터베이스(Postgres 등)로 저장소를 교체 — 규모가 커지거나 안정성이 중요해지면 이 방법을 권장해요. 필요하면 이 부분도 도와드릴 수 있어요.

## 보안에 대한 참고 (알아두면 좋아요)

이 앱은 "학원 선생님이 학생들과 간단히 쓰는" 정도의 가벼운 보호 수준으로 만들어졌어요.
외부에 완전히 공개하신다면 아래 정도는 참고해주세요:

- 학생 퀴즈 결과 저장(`results:*`)은 PIN 없이 누구나 쓸 수 있게 열려 있어요 (학생이 로그인 없이 코드만으로 퀴즈를 풀어야 하기 때문). 학생 코드를 아는 사람만 자기 결과를 저장할 수 있다는 정도의 보호예요.
- `GOOGLE_API_KEY`는 서버 환경변수로만 있고 클라이언트에는 절대 노출되지 않아요 — 이 부분은 안전해요.
- 접속자 수가 많아지거나 악의적인 사용이 걱정되면, 서버에 요청 속도 제한(rate limit)이나 진짜 로그인 시스템을 추가하는 걸 권장해요.

## 폴더 구조

```
render-app/
├── Dockerfile
├── render.yaml          # Render Blueprint (선택)
├── package.json         # 서버 의존성 (express)
├── server.js            # API + 정적 파일 서빙
├── .env.example
├── data/                 # 로컬 실행 시 저장 파일 위치
└── client/
    ├── package.json      # React/Vite/Tailwind 의존성
    ├── vite.config.js
    ├── index.html
    ├── .env.example
    └── src/
        ├── main.jsx
        ├── index.css
        └── App.jsx        # 원래 아티팩트 코드 (storage/AI 호출만 백엔드 연동으로 수정)
```
