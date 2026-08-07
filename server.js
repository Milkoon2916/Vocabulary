import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "8mb" }));

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

// ---------- AI 호출 프록시 (Groq) ----------
// Groq는 신용카드/결제 계정 연결 없이 이메일이나 구글 계정으로 가입만 하면
// 바로 무료 API 키를 받을 수 있어요 (https://console.groq.com/keys).
// 선생님이 앱 안에서 자기 API 키를 저장해두면 그 키를(x-groq-api-key 헤더로) 우선 사용하고,
// 없으면 서버 환경변수(GROQ_API_KEY, 관리자 기본 키)로 대체해요.
app.post("/api/ai/generate", async (req, res) => {
  try {
    const apiKey = req.get("x-groq-api-key") || process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: {
          message:
            "사용할 Groq API 키가 없어요. 앱의 'AI 키 설정'에서 본인 키를 저장하거나, 서버에 GROQ_API_KEY 환경변수를 설정해주세요.",
        },
      });
    }
    const { max_tokens, messages } = req.body || {};
    // 클라이언트는 [{ role: "user", content: "..." }] 형태로 하나만 보내요.
    const promptText = (messages || []).map((m) => m.content).join("\n");
    const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: max_tokens || 1000,
        messages: [{ role: "user", content: promptText }],
      }),
    });
    const groqData = await groqRes.json();

    if (!groqRes.ok) {
      return res.status(groqRes.status).json({
        error: { message: groqData?.error?.message || "Groq API 오류" },
      });
    }

    // 프론트엔드가 기대하는 (Claude 스타일) 응답 형태로 변환
    const choice = groqData?.choices?.[0];
    const text = choice?.message?.content || "";
    const stopReason = choice?.finish_reason === "length" ? "max_tokens" : "end_turn";

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
