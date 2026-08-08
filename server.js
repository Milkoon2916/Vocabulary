import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "40mb" }));

// ---------- 파일 기반 key-value 저장소 ----------
// Render에 "영구 디스크(Persistent Disk)"를 /app/data 에 마운트하면
// 재배포/재시작 후에도 데이터가 유지돼요. 디스크가 없으면 컨테이너가
// 재시작될 때 데이터가 초기화돼요 (README 참고).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, "kv-store.json");

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store), "utf8");
}

// 동시 쓰기로 파일이 깨지지 않도록 순서대로 처리
let writeQueue = Promise.resolve();
function queuedWrite(fn) {
  writeQueue = writeQueue.then(fn).catch((e) => console.error("저장소 쓰기 오류", e));
  return writeQueue;
}

// 선생님 전용 데이터(단어장·학생 명단)는 비밀번호(PIN) 헤더가 맞아야 쓸 수 있게 보호
// (학생들이 채점 결과를 저장하는 "results:*" 키는 그대로 열어둠)
const TEACHER_PIN = process.env.TEACHER_PIN || "5136";
const PROTECTED_KEYS = new Set(["config"]);

function isAuthorizedWrite(req, key) {
  if (!PROTECTED_KEYS.has(key)) return true;
  return req.get("x-teacher-pin") === TEACHER_PIN;
}

app.get("/api/kv/:key", (req, res) => {
  const store = readStore();
  const key = req.params.key;
  if (!(key in store)) return res.status(404).json({ error: "not found" });
  res.json({ key, value: store[key] });
});

app.put("/api/kv/:key", async (req, res) => {
  const key = req.params.key;
  if (!isAuthorizedWrite(req, key)) {
    return res.status(401).json({ error: { message: "비밀번호가 올바르지 않아요." } });
  }
  const { value } = req.body || {};
  await queuedWrite(() => {
    const store = readStore();
    store[key] = value;
    writeStore(store);
  });
  res.json({ key, value });
});

app.delete("/api/kv/:key", async (req, res) => {
  const key = req.params.key;
  if (!isAuthorizedWrite(req, key)) {
    return res.status(401).json({ error: { message: "비밀번호가 올바르지 않아요." } });
  }
  await queuedWrite(() => {
    const store = readStore();
    delete store[key];
    writeStore(store);
  });
  res.json({ key, deleted: true });
});

// Gemini의 429(RESOURCE_EXHAUSTED) 응답에서 "몇 초 후 재시도"를 찾아냄.
// Gemini는 보통 error.details 안에 RetryInfo(retryDelay: "12s" 같은 형태)로 알려주고,
// 그게 없으면 에러 메시지 문구에서 초 단위 숫자를 파싱해봄.
function parseRetrySeconds(errBody, headers) {
  const details = errBody?.error?.details;
  if (Array.isArray(details)) {
    const retryInfo = details.find((d) =>
      (d["@type"] || "").includes("RetryInfo")
    );
    if (retryInfo?.retryDelay) {
      const n = parseFloat(retryInfo.retryDelay);
      if (!isNaN(n)) return n;
    }
  }
  const headerVal = headers?.get?.("retry-after");
  if (headerVal) {
    const n = parseFloat(headerVal);
    if (!isNaN(n) && n >= 0) return n;
  }
  const match = /retry.*?([\d.]+)\s*s/i.exec(errBody?.error?.message || "");
  if (match) return parseFloat(match[1]);
  return null;
}

async function callGemini(apiKey, model, promptText, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      generationConfig: {
        maxOutputTokens: maxTokens || 1000,
      },
    }),
  });
}

// ---------- AI 호출 프록시 (Google Gemini) ----------
// Gemini는 신용카드/결제 계정 연결 없이 구글 계정만 있으면
// Google AI Studio(https://aistudio.google.com/apikey)에서 바로 무료 API 키를 받을 수 있어요.
// 선생님이 앱 안에서 자기 API 키를 저장해두면 그 키를(x-gemini-api-key 헤더로) 우선 사용하고,
// 없으면 서버 환경변수(GEMINI_API_KEY, 관리자 기본 키)로 대체해요.
app.post("/api/ai/generate", async (req, res) => {
  try {
    const apiKey = req.get("x-gemini-api-key") || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: {
          message:
            "사용할 Gemini API 키가 없어요. 앱의 'AI 키 설정'에서 본인 키를 저장하거나, 서버에 GEMINI_API_KEY 환경변수를 설정해주세요.",
        },
      });
    }
    const { max_tokens, messages } = req.body || {};
    // 클라이언트는 [{ role: "user", content: "..." }] 형태로 하나만 보내요.
    const promptText = (messages || []).map((m) => m.content).join("\n");
    // 선생님이 앱의 "AI 키 설정"에서 직접 고른 모델(x-gemini-model 헤더)을 우선 사용하고,
    // 없으면 서버 환경변수(GEMINI_MODEL), 그것도 없으면 기본값을 사용해요.
    // gemini-2.0-flash는 서비스가 종료됐으니 기본값은 현재 무료 등급에 있는 모델로 둬요.
    const model =
      req.get("x-gemini-model") || process.env.GEMINI_MODEL || "gemini-3-flash";

    let geminiRes = await callGemini(apiKey, model, promptText, max_tokens);
    let geminiData = await geminiRes.json();

    // 순간적으로 분당 요청 한도에 걸린 경우, 안내된 시간만큼 한 번 기다렸다가 자동으로 재시도
    if (geminiRes.status === 429) {
      const waitSec = parseRetrySeconds(geminiData, geminiRes.headers);
      if (waitSec !== null && waitSec <= 45) {
        await new Promise((r) => setTimeout(r, Math.ceil(waitSec * 1000) + 500));
        geminiRes = await callGemini(apiKey, model, promptText, max_tokens);
        geminiData = await geminiRes.json();
      }
    }

    if (!geminiRes.ok) {
      const baseMsg = geminiData?.error?.message || "Gemini API 오류";
      const friendly =
        geminiRes.status === 429
          ? `${baseMsg} (요청이 몰려서 생기는 일시적인 속도 제한이에요. 잠시 후 다시 시도해주세요. 자주 발생한다면 '최대 단어 수'를 줄여보세요.)`
          : baseMsg;
      return res.status(geminiRes.status).json({ error: { message: friendly } });
    }

    // 프론트엔드가 기대하는 (Claude 스타일) 응답 형태로 변환
    const candidate = geminiData?.candidates?.[0];
    const text =
      (candidate?.content?.parts || []).map((p) => p.text || "").join("") || "";
    const stopReason =
      candidate?.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";

    res.json({
      content: [{ type: "text", text }],
      stop_reason: stopReason,
    });
  } catch (e) {
    console.error("AI 프록시 오류", e);
    res.status(500).json({ error: { message: e.message } });
  }
});

// ---------- 정적 프론트엔드 서빙 ----------
const CLIENT_DIST = path.join(__dirname, "client", "dist");
app.use(express.static(CLIENT_DIST));
app.get("*", (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, "index.html"));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`서버가 ${PORT} 포트에서 실행 중이에요.`);
});
