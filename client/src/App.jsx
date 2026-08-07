import React, { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  Copy,
  Check,
  X,
  ChevronRight,
  RotateCcw,
  Loader2,
  BookOpen,
  Users,
  BarChart3,
  ArrowLeft,
  Sparkles,
  FileText,
} from "lucide-react";

// ---------- 색 토큰 ----------
// bg: 서늘한 종이빛, ink: 짙은 남색, ok: 인주빛 초록(도장), warn: 형광펜 앰버, bad: 벽돌빛 레드
const COLORS = {
  bg: "#EEF1EF",
  card: "#FFFFFF",
  ink: "#1B2B34",
  inkSoft: "#5B6B73",
  line: "#D8DED9",
  ok: "#2F6F5E",
  okBg: "#E4F0EA",
  warn: "#F0B429",
  warnBg: "#FDF3D8",
  bad: "#C1483D",
  badBg: "#F8E5E2",
};

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

function genCode(existing) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 0/O/1/I 제외
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (existing.includes(code));
  return code;
}

const MAX_WORDS = 200; // 등록/시험 단어 상한
const DEFAULT_FOLDER = "기본";
const ALL_FOLDERS = "전체";

function getFolders(wordsets) {
  const set = new Set(wordsets.map((w) => w.folder || DEFAULT_FOLDER));
  return Array.from(set).sort();
}

// 학생에게 배정된 폴더 목록을 반환 (구버전 student.folder 문자열 필드와도 호환)
function getAssignedFolders(student) {
  if (!student) return [ALL_FOLDERS];
  if (Array.isArray(student.folders) && student.folders.length > 0) return student.folders;
  if (student.folder) return [student.folder];
  return [ALL_FOLDERS];
}

function scopeWordsByFolders(wordsets, assignedFolders) {
  if (!assignedFolders || assignedFolders.includes(ALL_FOLDERS)) return wordsets;
  const set = new Set(assignedFolders);
  return wordsets.filter((w) => set.has(w.folder || DEFAULT_FOLDER));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- storage helpers (백엔드 /api/kv 프록시) ----------
// 선생님 모드 잠금 해제 시 입력한 PIN을 기억해서, 단어장/학생 명단(config) 저장 요청에
// 헤더로 함께 실어 보내요. 서버가 이 PIN을 검증해서 아무나 데이터를 고치지 못하게 막아요.
let teacherPinForRequests = null;
export function setTeacherPinForRequests(pin) {
  teacherPinForRequests = pin;
}

async function kvGet(key) {
  try {
    const res = await fetch(`/api/kv/${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    return await res.json(); // { key, value }
  } catch {
    return null;
  }
}

async function kvSet(key, value) {
  const headers = { "Content-Type": "application/json" };
  if (key === "config" && teacherPinForRequests) {
    headers["x-teacher-pin"] = teacherPinForRequests;
  }
  const res = await fetch(`/api/kv/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `저장 실패 (status ${res.status})`);
  }
  return res.json();
}

// ---------- 선생님 개인 Groq API 키 (브라우저에만 저장, 서버 DB로는 전송·저장하지 않음) ----------
const TEACHER_API_KEY_STORAGE = "vocabQuiz.teacherGroqApiKey";

function getTeacherApiKey() {
  try {
    return localStorage.getItem(TEACHER_API_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}
function setTeacherApiKey(key) {
  try {
    if (key) localStorage.setItem(TEACHER_API_KEY_STORAGE, key);
    else localStorage.removeItem(TEACHER_API_KEY_STORAGE);
  } catch {
    // 브라우저가 localStorage를 막아둔 경우 조용히 무시 (서버 기본 키로 대체됨)
  }
}

async function loadConfig() {
  try {
    const res = await kvGet("config");
    return res ? JSON.parse(res.value) : { wordsets: [], students: [] };
  } catch {
    return { wordsets: [], students: [] };
  }
}
async function saveConfig(cfg) {
  try {
    await kvSet("config", JSON.stringify(cfg));
  } catch (e) {
    console.error("설정 저장 실패", e);
  }
}
async function loadResults(code) {
  try {
    const res = await kvGet(`results:${code}`);
    return res ? JSON.parse(res.value) : { wordStats: {}, attempts: [] };
  } catch {
    return { wordStats: {}, attempts: [] };
  }
}
async function saveResults(code, data) {
  try {
    await kvSet(`results:${code}`, JSON.stringify(data));
  } catch (e) {
    console.error("결과 저장 실패", e);
  }
}

// ---------- 폴더 단어 워드(Word) 다운로드 ----------
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 외부 라이브러리 없이, 브라우저 자체 기능(Blob)만으로 워드에서 열리는 .doc 파일을 생성
function exportFolderToWord(folderName, items) {
  let rows = "";
  items.forEach((w, i) => {
    const synAnt = [
      (w.synonyms || []).length ? `유의어: ${w.synonyms.map(escapeHtml).join(", ")}` : "",
      (w.antonyms || []).length ? `반의어: ${w.antonyms.map(escapeHtml).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("&nbsp;&nbsp;/&nbsp;&nbsp;");

    rows += `
      <tr>
        <td style="border:1px solid #ccc;padding:6px 8px;text-align:center;">${i + 1}</td>
        <td style="border:1px solid #ccc;padding:6px 8px;font-weight:bold;">${escapeHtml(w.word)}</td>
        <td style="border:1px solid #ccc;padding:6px 8px;">${escapeHtml(w.meaning)}</td>
        <td style="border:1px solid #ccc;padding:6px 8px;">${escapeHtml(w.example || "")}</td>
        <td style="border:1px solid #ccc;padding:6px 8px;font-size:11px;color:#555555;">${synAnt}</td>
      </tr>`;
  });

  const html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(folderName)}</title>
      <style>
        body { font-family: '맑은 고딕', 'Malgun Gothic', sans-serif; font-size: 11pt; }
        h1 { font-size: 18pt; margin-bottom: 2px; }
        .meta { color: #666666; font-size: 10pt; margin-bottom: 14px; }
        table { border-collapse: collapse; width: 100%; }
        th { background: #2F6F5E; color: #ffffff; padding: 6px 8px; border: 1px solid #ccc; text-align: left; font-size: 10pt; }
        td { font-size: 10.5pt; }
      </style>
    </head>
    <body>
      <h1>${escapeHtml(folderName)}</h1>
      <p class="meta">단어장 퀴즈 · 총 ${items.length}개</p>
      <table>
        <tr>
          <th style="width:6%;">번호</th>
          <th style="width:16%;">단어</th>
          <th style="width:20%;">뜻</th>
          <th style="width:38%;">예문</th>
          <th style="width:20%;">유의어/반의어</th>
        </tr>
        ${rows}
      </table>
    </body>
    </html>`;

  const blob = new Blob(["\ufeff", html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${folderName}_단어장.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- AI 자동완성 공용 호출 함수 ----------
async function callClaudeJsonArray(prompt, maxTokens) {
  let response;
  try {
    const headers = { "Content-Type": "application/json" };
    const personalKey = getTeacherApiKey();
    if (personalKey) headers["x-groq-api-key"] = personalKey;
    response = await fetch("/api/ai/generate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (networkErr) {
    throw new Error("네트워크 요청에 실패했어요 (인터넷 연결을 확인해주세요).");
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message || JSON.stringify(errBody);
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new Error(`API 오류 (status ${response.status})${detail ? ": " + detail : ""}`);
  }

  const data = await response.json();

  if (data?.stop_reason === "max_tokens") {
    throw new Error("응답이 중간에 잘렸어요. 요청 개수를 줄여서 다시 시도해주세요.");
  }

  const text = (data.content || []).map((b) => b.text || "").join("\n");
  if (!text.trim()) {
    throw new Error("AI 응답이 비어 있어요. 다시 시도해주세요.");
  }

  // 코드블록 표시나 앞뒤 설명 문구가 섞여 와도 배열 부분만 뽑아냄
  const match = text.match(/\[[\s\S]*\]/);
  const clean = (match ? match[0] : text.replace(/```json|```/g, "")).trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (parseErr) {
    throw new Error("AI 응답을 해석하지 못했어요. 개수를 줄이거나 다시 시도해주세요.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("AI 응답 형식이 예상과 달라요. 다시 시도해주세요.");
  }

  return parsed;
}

// ---------- AI 단어 정보 자동완성 ----------
async function fetchWordDetails(words) {
  const prompt = `당신은 한국 고등학교 1학년(고1) 영어 어휘 학습 자료를 만드는 도우미입니다.
아래 영어 단어 목록 각각에 대해 자연스러운 한국어 뜻, 그 단어를 포함한 영어 예문, 유의어, 반의어를 만들어주세요.
다른 설명이나 인사말, 마크다운 코드블록 없이 순수 JSON 배열만 출력하세요. 목록의 순서와 개수를 그대로 유지하세요. 각 항목은 아래 형식을 따르세요.

[
  {
    "word": "입력된 단어 그대로",
    "meaning": "간결한 한국어 뜻",
    "example": "이 단어를 포함한 자연스러운 영어 예문",
    "synonyms": ["고1 수준 유의어 (영어, 최대 2개)"],
    "antonyms": ["고1 수준 반의어 (영어, 있는 경우만 최대 2개)"]
  }
]

단어 목록:
${words.join(", ")}`;

  // 단어 수에 비례해서 토큰 한도를 넉넉하게 잡아 응답이 중간에 잘리지 않게 함
  const maxTokens = Math.min(6000, Math.max(1000, words.length * 350 + 500));
  return callClaudeJsonArray(prompt, maxTokens);
}

// ---------- 문제 유형 라벨 ----------
const TYPE_LABELS = {
  meaning: "다음 단어의 뜻은?",
  word: "다음 뜻에 해당하는 단어는?",
  synonym: "다음 단어와 뜻이 비슷한(유의어) 단어는?",
  antonym: "다음 단어와 반대되는 뜻(반의어)을 가진 단어는?",
};

// ---------- 퀴즈 생성 ----------
function buildQuiz(wordsets, wordStats, count, distractorPool) {
  const dPool = distractorPool && distractorPool.length > 0 ? distractorPool : wordsets;
  const pool = wordsets.map((w) => ({
    ...w,
    weight: 1 + (wordStats[w.id]?.wrong || 0) * 2,
  }));
  const n = Math.min(count, pool.length);
  const picked = [];
  let remaining = [...pool];
  for (let i = 0; i < n; i++) {
    const total = remaining.reduce((s, w) => s + w.weight, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= remaining[idx].weight;
      if (r <= 0) break;
    }
    idx = Math.min(idx, remaining.length - 1);
    picked.push(remaining[idx]);
    remaining.splice(idx, 1);
  }

  const allSynonyms = Array.from(
    new Set(dPool.flatMap((w) => w.synonyms || []))
  );
  const allAntonyms = Array.from(
    new Set(dPool.flatMap((w) => w.antonyms || []))
  );

  return picked.map((word) => {
    const others = dPool.filter((w) => w.id !== word.id);
    const canBlank =
      word.example &&
      word.example.toLowerCase().includes(word.word.toLowerCase());
    const hasSyn = (word.synonyms || []).length > 0;
    const hasAnt = (word.antonyms || []).length > 0;
    const typeChoices = ["meaning", "word"];
    if (canBlank) typeChoices.push("blank", "blank");
    if (hasSyn) typeChoices.push("synonym");
    if (hasAnt) typeChoices.push("antonym");
    const type = typeChoices[Math.floor(Math.random() * typeChoices.length)];

    if (type === "meaning") {
      const distractors = shuffle(others)
        .slice(0, 3)
        .map((w) => w.meaning);
      const options = shuffle([word.meaning, ...distractors]);
      return {
        id: word.id,
        word,
        type,
        prompt: word.word,
        options,
        answer: word.meaning,
      };
    }
    if (type === "word") {
      const distractors = shuffle(others)
        .slice(0, 3)
        .map((w) => w.word);
      const options = shuffle([word.word, ...distractors]);
      return {
        id: word.id,
        word,
        type,
        prompt: word.meaning,
        options,
        answer: word.word,
      };
    }
    if (type === "synonym" || type === "antonym") {
      const bank = type === "synonym" ? word.synonyms : word.antonyms;
      const globalBank = type === "synonym" ? allSynonyms : allAntonyms;
      const answer = bank[Math.floor(Math.random() * bank.length)];
      let distractors = shuffle(
        globalBank.filter((s) => s !== answer && !bank.includes(s))
      ).slice(0, 3);
      if (distractors.length < 3) {
        const extra = shuffle(others.map((w) => w.word)).slice(
          0,
          3 - distractors.length
        );
        distractors = [...distractors, ...extra];
      }
      const options = shuffle([answer, ...distractors]);
      return {
        id: word.id,
        word,
        type,
        prompt: word.word,
        options,
        answer,
      };
    }
    // blank
    const re = new RegExp(word.word, "i");
    const sentence = word.example.replace(re, "_____");
    return {
      id: word.id,
      word,
      type,
      prompt: sentence,
      answer: word.word,
    };
  });
}

// ================= 메인 =================
// 배포 시 클라이언트 빌드 환경변수 VITE_TEACHER_PIN 으로 바꿀 수 있어요.
// (서버의 TEACHER_PIN 환경변수와 같은 값으로 맞춰야 선생님 저장 요청이 통과돼요.)
const TEACHER_PASSWORD = import.meta.env.VITE_TEACHER_PIN || "5136";

export default function App() {
  const [role, setRole] = useState("select"); // select | teacher | student
  const [teacherUnlocked, setTeacherUnlocked] = useState(false);

  const goHome = () => {
    setRole("select");
    setTeacherUnlocked(false);
    setTeacherPinForRequests(null);
  };

  return (
    <div
      className="min-h-screen w-full flex flex-col items-center py-8 px-4"
      style={{ background: COLORS.bg, color: COLORS.ink }}
    >
      <div className="w-full max-w-3xl">
        <Header role={role} onHome={goHome} />
        {role === "select" && <RoleSelect onSelect={setRole} />}
        {role === "teacher" && !teacherUnlocked && (
          <TeacherPasswordGate onSuccess={() => setTeacherUnlocked(true)} />
        )}
        {role === "teacher" && teacherUnlocked && <TeacherView />}
        {role === "student" && <StudentView />}
      </div>
    </div>
  );
}

function TeacherPasswordGate({ onSuccess }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");

  const submit = () => {
    if (pw.trim() === TEACHER_PASSWORD) {
      setError("");
      setTeacherPinForRequests(pw.trim());
      onSuccess();
    } else {
      setError("비밀번호가 올바르지 않아요.");
    }
  };

  return (
    <Card>
      <SectionTitle>선생님 모드 비밀번호</SectionTitle>
      <p className="text-sm mt-1" style={{ color: COLORS.inkSoft }}>
        선생님만 접근할 수 있도록 비밀번호를 입력해주세요.
      </p>
      <div className="flex gap-3 mt-3">
        <Input
          type="password"
          placeholder="비밀번호"
          value={pw}
          onChange={setPw}
          onEnter={submit}
        />
        <button
          onClick={submit}
          className="px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap"
          style={{ background: COLORS.ink, color: "#fff" }}
        >
          확인
        </button>
      </div>
      {error && (
        <p className="text-sm mt-2" style={{ color: COLORS.bad }}>
          {error}
        </p>
      )}
    </Card>
  );
}

function Header({ role, onHome }) {
  return (
    <div className="flex items-center justify-between mb-8">
      <button
        onClick={onHome}
        className="flex items-center gap-2 group"
        style={{ color: COLORS.ink }}
      >
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm"
          style={{ background: COLORS.ink, color: "#fff" }}
        >
          단
        </div>
        <span
          className="font-serif text-xl tracking-tight"
          style={{ letterSpacing: "-0.02em" }}
        >
          단어장 퀴즈
        </span>
      </button>
      {role !== "select" && (
        <span
          className="text-xs px-3 py-1 rounded-full border"
          style={{ borderColor: COLORS.line, color: COLORS.inkSoft }}
        >
          {role === "teacher" ? "선생님 모드" : "학생 모드"}
        </span>
      )}
    </div>
  );
}

function RoleSelect({ onSelect }) {
  return (
    <div className="grid sm:grid-cols-2 gap-4">
      <button
        onClick={() => onSelect("teacher")}
        className="text-left p-6 rounded-2xl border transition hover:-translate-y-0.5"
        style={{ background: COLORS.card, borderColor: COLORS.line }}
      >
        <BookOpen size={22} style={{ color: COLORS.ok }} />
        <div className="mt-3 font-serif text-lg">선생님으로 시작</div>
        <div className="text-sm mt-1" style={{ color: COLORS.inkSoft }}>
          단어 등록, 학생 코드 발급, 결과 확인
        </div>
      </button>
      <button
        onClick={() => onSelect("student")}
        className="text-left p-6 rounded-2xl border transition hover:-translate-y-0.5"
        style={{ background: COLORS.card, borderColor: COLORS.line }}
      >
        <Users size={22} style={{ color: COLORS.warn }} />
        <div className="mt-3 font-serif text-lg">학생으로 참여</div>
        <div className="text-sm mt-1" style={{ color: COLORS.inkSoft }}>
          받은 코드를 입력하고 퀴즈 풀기
        </div>
      </button>
    </div>
  );
}

// ================= 선생님 =================
function TeacherView() {
  const [tab, setTab] = useState("words");
  const [config, setConfig] = useState({ wordsets: [], students: [] });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const cfg = await loadConfig();
    setConfig(cfg);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) return <Loading />;

  return (
    <div>
      <div className="flex gap-2 mb-6 flex-wrap">
        <TabButton active={tab === "words"} onClick={() => setTab("words")}>
          단어 관리
        </TabButton>
        <TabButton active={tab === "extract"} onClick={() => setTab("extract")}>
          지문 추출
        </TabButton>
        <TabButton
          active={tab === "students"}
          onClick={() => setTab("students")}
        >
          학생 관리
        </TabButton>
        <TabButton active={tab === "results"} onClick={() => setTab("results")}>
          결과 보기
        </TabButton>
        <TabButton active={tab === "aikey"} onClick={() => setTab("aikey")}>
          AI 키 설정
        </TabButton>
      </div>
      {tab === "words" && (
        <WordsTab config={config} setConfig={setConfig} />
      )}
      {tab === "extract" && (
        <PassageExtractTab config={config} setConfig={setConfig} />
      )}
      {tab === "students" && (
        <StudentsTab config={config} setConfig={setConfig} />
      )}
      {tab === "results" && <ResultsTab config={config} />}
      {tab === "aikey" && <ApiKeySettingsTab />}
    </div>
  );
}

function ApiKeySettingsTab() {
  const [keyInput, setKeyInput] = useState("");
  const [savedKey, setSavedKey] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setSavedKey(getTeacherApiKey());
  }, []);

  const save = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setTeacherApiKey(trimmed);
    setSavedKey(trimmed);
    setKeyInput("");
    setNotice("이 브라우저에 키를 저장했어요. 지금부터 자동완성/지문 추출에 이 키가 사용돼요.");
  };

  const clear = () => {
    setTeacherApiKey("");
    setSavedKey("");
    setNotice("저장된 키를 지웠어요. 앞으로는 서버 기본 키(설정되어 있다면)를 사용해요.");
  };

  const masked = (k) => (k.length <= 8 ? "••••••••" : `${k.slice(0, 4)}••••••••${k.slice(-4)}`);

  return (
    <div className="space-y-6">
      <Card>
        <SectionTitle>선생님 개인 Groq API 키</SectionTitle>
        <p className="text-sm mt-1" style={{ color: COLORS.inkSoft }}>
          단어 자동완성이나 지문 추출을 쓸 때, 관리자가 설정해둔 서버 공용 키 대신
          내 개인 Groq API 키를 쓰고 싶다면 여기에 저장하세요. 다른 선생님들과 사용량이
          섞이지 않고, 내 계정 할당량만 써요. Groq는 카드 등록 없이 이메일이나
          구글 계정으로 가입만 하면 바로 무료로 키를 받을 수 있어요.
        </p>
        <p className="text-xs mt-2" style={{ color: COLORS.inkSoft }}>
          이 키는 <b>이 브라우저에만</b> 저장돼요 (서버 데이터베이스에는 저장되지 않아요).
          다른 기기나 브라우저에서 로그인하면 다시 입력해야 해요.
        </p>

        <div className="mt-4">
          {savedKey ? (
            <div
              className="flex items-center justify-between flex-wrap gap-2 p-3 rounded-lg"
              style={{ background: COLORS.okBg, border: `1px solid ${COLORS.ok}` }}
            >
              <span className="text-sm font-mono" style={{ color: COLORS.ok }}>
                저장된 키: {masked(savedKey)}
              </span>
              <button
                onClick={clear}
                className="text-xs px-3 py-1.5 rounded-full"
                style={{ background: "#fff", border: `1px solid ${COLORS.line}`, color: COLORS.bad }}
              >
                키 삭제
              </button>
            </div>
          ) : (
            <p className="text-sm" style={{ color: COLORS.inkSoft }}>
              지금은 저장된 개인 키가 없어요. 서버 기본 키(관리자가 설정했다면)를 사용해요.
            </p>
          )}
        </div>

        <div className="flex gap-3 mt-4">
          <Input
            type="password"
            placeholder="gsk_로 시작하는 Groq API 키"
            value={keyInput}
            onChange={setKeyInput}
            onEnter={save}
          />
          <button
            onClick={save}
            disabled={!keyInput.trim()}
            className="px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap disabled:opacity-50"
            style={{ background: COLORS.ok, color: "#fff" }}
          >
            저장
          </button>
        </div>
        {notice && (
          <p className="text-xs mt-2" style={{ color: COLORS.ok }}>{notice}</p>
        )}
        <p className="text-xs mt-4" style={{ color: COLORS.inkSoft }}>
          키가 없다면{" "}
          <a
            href="https://console.groq.com/keys"
            target="_blank"
            rel="noreferrer"
            style={{ color: COLORS.ok, textDecoration: "underline" }}
          >
            Groq Console
          </a>
          에서 카드 등록 없이 무료로 발급받을 수 있어요.
        </p>
      </Card>
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 rounded-full text-sm font-medium transition"
      style={
        active
          ? { background: COLORS.ink, color: "#fff" }
          : { background: COLORS.card, color: COLORS.inkSoft, border: `1px solid ${COLORS.line}` }
      }
    >
      {children}
    </button>
  );
}

function WordsTab({ config, setConfig }) {
  const [word, setWord] = useState("");
  const [meaning, setMeaning] = useState("");
  const [example, setExample] = useState("");
  const [folder, setFolder] = useState(DEFAULT_FOLDER);
  const [synonyms, setSynonyms] = useState("");
  const [antonyms, setAntonyms] = useState("");
  const [bulk, setBulk] = useState("");
  const [bulkFolder, setBulkFolder] = useState(DEFAULT_FOLDER);
  const [filterFolder, setFilterFolder] = useState("전체");
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState(null);
  const [wordDocGenerating, setWordDocGenerating] = useState(null);
  const [wordDocError, setWordDocError] = useState("");
  const [saving, setSaving] = useState(false);
  const [limitMsg, setLimitMsg] = useState("");
  const [autoFilling, setAutoFilling] = useState(false);
  const [autoFillError, setAutoFillError] = useState("");

  const [autoWordsInput, setAutoWordsInput] = useState("");
  const [autoDestFolder, setAutoDestFolder] = useState(DEFAULT_FOLDER);
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoListError, setAutoListError] = useState("");
  const [autoExtracted, setAutoExtracted] = useState([]);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoNotice, setAutoNotice] = useState("");

  const folders = getFolders(config.wordsets);

  const commit = async (newWordsets) => {
    const newCfg = { ...config, wordsets: newWordsets };
    setConfig(newCfg);
    setSaving(true);
    await saveConfig(newCfg);
    setSaving(false);
  };

  const remainingSlots = MAX_WORDS - config.wordsets.length;

  const addOne = () => {
    if (!word.trim() || !meaning.trim()) return;
    if (remainingSlots <= 0) {
      setLimitMsg(`단어는 최대 ${MAX_WORDS}개까지만 등록할 수 있어요.`);
      return;
    }
    setLimitMsg("");
    const entry = {
      id: uid(),
      word: word.trim(),
      meaning: meaning.trim(),
      example: example.trim(),
      folder: folder.trim() || DEFAULT_FOLDER,
      synonyms: synonyms.split(",").map((s) => s.trim()).filter(Boolean),
      antonyms: antonyms.split(",").map((s) => s.trim()).filter(Boolean),
    };
    commit([...config.wordsets, entry]);
    setWord("");
    setMeaning("");
    setExample("");
    setSynonyms("");
    setAntonyms("");
  };

  const addBulk = () => {
    const lines = bulk.split("\n").map((l) => l.trim()).filter(Boolean);
    let entries = lines.map((line) => {
      const parts = line.split(",");
      return {
        id: uid(),
        word: (parts[0] || "").trim(),
        meaning: (parts[1] || "").trim(),
        example: parts.slice(2).join(",").trim(),
        folder: bulkFolder.trim() || DEFAULT_FOLDER,
      };
    }).filter((e) => e.word && e.meaning);
    if (entries.length === 0) return;
    if (remainingSlots <= 0) {
      setLimitMsg(`단어는 최대 ${MAX_WORDS}개까지만 등록할 수 있어요.`);
      return;
    }
    if (entries.length > remainingSlots) {
      entries = entries.slice(0, remainingSlots);
      setLimitMsg(`최대 ${MAX_WORDS}개 제한으로 ${entries.length}개만 추가했어요.`);
    } else {
      setLimitMsg("");
    }
    commit([...config.wordsets, ...entries]);
    setBulk("");
  };

  const remove = (id) => {
    commit(config.wordsets.filter((w) => w.id !== id));
  };

  const deleteFolder = (folderName) => {
    if (confirmDeleteFolder !== folderName) {
      setConfirmDeleteFolder(folderName);
      setTimeout(() => {
        setConfirmDeleteFolder((cur) => (cur === folderName ? null : cur));
      }, 3000);
      return;
    }
    const newWordsets = config.wordsets.filter(
      (w) => (w.folder || DEFAULT_FOLDER) !== folderName
    );
    commit(newWordsets);
    setConfirmDeleteFolder(null);
    if (filterFolder === folderName) setFilterFolder("전체");
  };

  const downloadFolderWord = (folderName, items) => {
    setWordDocGenerating(folderName);
    setWordDocError("");
    try {
      exportFolderToWord(folderName, items);
    } catch (e) {
      console.error("워드 파일 생성 실패", e);
      setWordDocError(`워드 파일을 만들지 못했어요: ${e.message || "알 수 없는 오류"}`);
    } finally {
      setWordDocGenerating(null);
    }
  };

  const autoFillSingle = async () => {
    if (!word.trim()) return;
    setAutoFilling(true);
    setAutoFillError("");
    try {
      const parsed = await fetchWordDetails([word.trim()]);
      const info = parsed && parsed[0];
      if (info) {
        setMeaning((info.meaning || "").trim());
        setExample((info.example || "").trim());
        setSynonyms(Array.isArray(info.synonyms) ? info.synonyms.join(", ") : "");
        setAntonyms(Array.isArray(info.antonyms) ? info.antonyms.join(", ") : "");
      } else {
        setAutoFillError("이 단어에 대한 정보를 만들지 못했어요.");
      }
    } catch (e) {
      console.error("자동완성 실패", e);
      setAutoFillError(`자동완성 중 문제가 발생했어요: ${e.message || "알 수 없는 오류"}`);
    } finally {
      setAutoFilling(false);
    }
  };

  const generateAutoList = async () => {
    const words = autoWordsInput
      .split(/[\n,]/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (words.length === 0) return;
    setAutoLoading(true);
    setAutoListError("");
    setAutoExtracted([]);
    try {
      const parsed = await fetchWordDetails(words);
      const entries = parsed
        .map((p) => ({
          id: uid(),
          word: (p.word || "").trim(),
          meaning: (p.meaning || "").trim(),
          example: (p.example || "").trim(),
          synonyms: Array.isArray(p.synonyms) ? p.synonyms.join(", ") : "",
          antonyms: Array.isArray(p.antonyms) ? p.antonyms.join(", ") : "",
          include: true,
        }))
        .filter((e) => e.word && e.meaning);
      if (entries.length === 0) {
        setAutoListError("단어 정보를 만들지 못했어요. 다시 시도해보세요.");
      }
      setAutoExtracted(entries);
    } catch (e) {
      console.error("자동완성 실패", e);
      setAutoListError(`자동완성 중 문제가 발생했어요: ${e.message || "알 수 없는 오류"}`);
    } finally {
      setAutoLoading(false);
    }
  };

  const updateAutoEntry = (id, field, value) => {
    setAutoExtracted((prev) =>
      prev.map((e) => (e.id === id ? { ...e, [field]: value } : e))
    );
  };
  const toggleAutoInclude = (id) => {
    setAutoExtracted((prev) =>
      prev.map((e) => (e.id === id ? { ...e, include: !e.include } : e))
    );
  };

  const addAutoSelected = async () => {
    const chosen = autoExtracted.filter((e) => e.include);
    if (chosen.length === 0) return;
    const remaining = MAX_WORDS - config.wordsets.length;
    if (remaining <= 0) {
      setAutoNotice(`단어는 최대 ${MAX_WORDS}개까지만 등록할 수 있어요.`);
      return;
    }
    let toAdd = chosen;
    let msg = "";
    if (chosen.length > remaining) {
      toAdd = chosen.slice(0, remaining);
      msg = `최대 ${MAX_WORDS}개 제한으로 ${toAdd.length}개만 추가했어요.`;
    }
    const newWords = toAdd.map((e) => ({
      id: uid(),
      word: e.word,
      meaning: e.meaning,
      example: e.example,
      folder: autoDestFolder.trim() || DEFAULT_FOLDER,
      synonyms: e.synonyms.split(",").map((s) => s.trim()).filter(Boolean),
      antonyms: e.antonyms.split(",").map((s) => s.trim()).filter(Boolean),
    }));
    setAutoSaving(true);
    await commit([...config.wordsets, ...newWords]);
    setAutoSaving(false);
    setAutoExtracted([]);
    setAutoWordsInput("");
    setAutoNotice(
      msg || `${newWords.length}개 단어를 "${autoDestFolder.trim() || DEFAULT_FOLDER}" 폴더에 추가했어요.`
    );
  };

  const autoIncludedCount = autoExtracted.filter((e) => e.include).length;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center justify-between">
          <SectionTitle>단어 추가</SectionTitle>
          <span className="text-xs" style={{ color: remainingSlots <= 0 ? COLORS.bad : COLORS.inkSoft }}>
            {config.wordsets.length} / {MAX_WORDS}
          </span>
        </div>
        <p className="text-xs mt-1" style={{ color: COLORS.inkSoft }}>
          단어만 입력하고 <Sparkles size={11} className="inline -mt-0.5" style={{ color: COLORS.ok }} /> 버튼을 누르면 뜻·예문·유의어·반의어를 AI가 채워줘요.
        </p>
        <div className="grid sm:grid-cols-4 gap-3 mt-3">
          <div className="flex gap-1.5">
            <Input placeholder="단어" value={word} onChange={setWord} disabled={remainingSlots <= 0} />
            <button
              type="button"
              onClick={autoFillSingle}
              disabled={remainingSlots <= 0 || !word.trim() || autoFilling}
              title="AI로 뜻·예문·유의어·반의어 자동완성"
              className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg disabled:opacity-50"
              style={{ background: COLORS.okBg, color: COLORS.ok, border: `1px solid ${COLORS.ok}` }}
            >
              {autoFilling ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            </button>
          </div>
          <Input placeholder="뜻" value={meaning} onChange={setMeaning} disabled={remainingSlots <= 0} />
          <Input placeholder="예문 (선택)" value={example} onChange={setExample} disabled={remainingSlots <= 0} />
          <div>
            <input
              list="folder-suggestions"
              value={folder}
              disabled={remainingSlots <= 0}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="폴더 (예: Day1)"
              className="w-full p-2.5 rounded-lg text-sm outline-none disabled:opacity-60"
              style={{ border: `1px solid ${COLORS.line}`, fontSize: "16px" }}
            />
            <datalist id="folder-suggestions">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 mt-3">
          <Input
            placeholder="유의어 (쉼표로 구분, 선택)"
            value={synonyms}
            onChange={setSynonyms}
            disabled={remainingSlots <= 0}
          />
          <Input
            placeholder="반의어 (쉼표로 구분, 선택)"
            value={antonyms}
            onChange={setAntonyms}
            disabled={remainingSlots <= 0}
          />
        </div>
        <button
          onClick={addOne}
          disabled={remainingSlots <= 0}
          className="mt-3 flex items-center gap-1 text-sm font-medium px-4 py-2 rounded-full disabled:opacity-50"
          style={{ background: COLORS.ok, color: "#fff" }}
        >
          <Plus size={16} /> 추가
        </button>
        {limitMsg && (
          <p className="text-xs mt-2" style={{ color: COLORS.bad }}>{limitMsg}</p>
        )}
        {autoFillError && (
          <p className="text-xs mt-2" style={{ color: COLORS.bad }}>{autoFillError}</p>
        )}
      </Card>

      <Card>
        <div className="flex items-center gap-2">
          <Sparkles size={18} style={{ color: COLORS.ok }} />
          <SectionTitle>단어만 입력하면 AI가 채워줄게요</SectionTitle>
        </div>
        <p className="text-xs mt-1" style={{ color: COLORS.inkSoft }}>
          단어를 줄바꿈이나 쉼표로 구분해서 여러 개 붙여넣으면, 뜻·예문·유의어·반의어를 AI가 한번에 만들어줘요. 추가하기 전에 검토·수정할 수 있어요.
        </p>
        <textarea
          value={autoWordsInput}
          onChange={(e) => setAutoWordsInput(e.target.value)}
          rows={3}
          placeholder={"abandon\nbrief\nchase"}
          className="w-full mt-2 p-3 rounded-lg text-sm outline-none resize-none"
          style={{ border: `1px solid ${COLORS.line}`, background: "#fafafa", fontSize: "16px" }}
        />
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <div>
            <label className="text-xs" style={{ color: COLORS.inkSoft }}>추가할 폴더</label>
            <input
              list="folder-suggestions"
              value={autoDestFolder}
              onChange={(e) => setAutoDestFolder(e.target.value)}
              placeholder="폴더 (예: Day1)"
              className="block mt-1 p-2 rounded-lg text-sm outline-none"
              style={{ border: `1px solid ${COLORS.line}`, fontSize: "16px" }}
            />
          </div>
          <button
            onClick={generateAutoList}
            disabled={autoLoading || !autoWordsInput.trim()}
            className="flex items-center gap-1 text-sm font-medium px-4 py-2.5 rounded-full disabled:opacity-50 mt-4"
            style={{ background: COLORS.ok, color: "#fff" }}
          >
            {autoLoading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {autoLoading ? "생성 중..." : "자동완성 생성"}
          </button>
        </div>
        {autoListError && (
          <p className="text-xs mt-2" style={{ color: COLORS.bad }}>{autoListError}</p>
        )}

        {autoExtracted.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-sm font-medium">생성 결과 ({autoExtracted.length}개)</span>
              <span className="text-xs" style={{ color: COLORS.inkSoft }}>
                선택됨 {autoIncludedCount}개 — 필요하면 내용을 직접 수정하세요
              </span>
            </div>
            <div className="mt-3 space-y-3">
              {autoExtracted.map((e) => (
                <div
                  key={e.id}
                  className="p-3 rounded-lg"
                  style={{
                    background: e.include ? "#fafafa" : "#f2f2f2",
                    border: `1px solid ${COLORS.line}`,
                    opacity: e.include ? 1 : 0.55,
                  }}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={e.include}
                      onChange={() => toggleAutoInclude(e.id)}
                      className="mt-2.5"
                    />
                    <div className="flex-1 grid sm:grid-cols-2 gap-2">
                      <Input
                        placeholder="단어"
                        value={e.word}
                        onChange={(v) => updateAutoEntry(e.id, "word", v)}
                      />
                      <Input
                        placeholder="뜻"
                        value={e.meaning}
                        onChange={(v) => updateAutoEntry(e.id, "meaning", v)}
                      />
                      <div className="sm:col-span-2">
                        <Input
                          placeholder="예문"
                          value={e.example}
                          onChange={(v) => updateAutoEntry(e.id, "example", v)}
                        />
                      </div>
                      <Input
                        placeholder="유의어 (쉼표 구분)"
                        value={e.synonyms}
                        onChange={(v) => updateAutoEntry(e.id, "synonyms", v)}
                      />
                      <Input
                        placeholder="반의어 (쉼표 구분)"
                        value={e.antonyms}
                        onChange={(v) => updateAutoEntry(e.id, "antonyms", v)}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={addAutoSelected}
              disabled={autoIncludedCount === 0 || autoSaving}
              className="mt-4 flex items-center gap-1 text-sm font-medium px-4 py-2 rounded-full disabled:opacity-50"
              style={{ background: COLORS.ink, color: "#fff" }}
            >
              {autoSaving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              선택한 단어 "{autoDestFolder.trim() || DEFAULT_FOLDER}" 폴더에 추가하기
            </button>
            {autoNotice && (
              <p className="text-xs mt-2" style={{ color: COLORS.ok }}>{autoNotice}</p>
            )}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>여러 개 한번에 추가</SectionTitle>
        <p className="text-xs mt-1" style={{ color: COLORS.inkSoft }}>
          한 줄에 하나씩, "단어,뜻,예문" 형식으로 입력하세요. 예문은 생략 가능합니다. (전체 {MAX_WORDS}개까지)
        </p>
        <div className="mt-2">
          <label className="text-xs" style={{ color: COLORS.inkSoft }}>이 목록을 넣을 폴더</label>
          <input
            list="folder-suggestions"
            value={bulkFolder}
            onChange={(e) => setBulkFolder(e.target.value)}
            placeholder="폴더 (예: Day1)"
            className="w-full mt-1 p-2 rounded-lg text-sm outline-none"
            style={{ border: `1px solid ${COLORS.line}`, fontSize: "16px" }}
          />
        </div>
        <textarea
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          rows={4}
          disabled={remainingSlots <= 0}
          placeholder={"abandon,버리다,He abandoned the plan.\nbrief,짧은,Keep it brief."}
          className="w-full mt-2 p-3 rounded-lg text-sm outline-none resize-none disabled:opacity-50"
          style={{ border: `1px solid ${COLORS.line}`, background: "#fafafa", fontSize: "16px" }}
        />
        <button
          onClick={addBulk}
          disabled={remainingSlots <= 0}
          className="mt-2 text-sm font-medium px-4 py-2 rounded-full disabled:opacity-50"
          style={{ background: COLORS.ink, color: "#fff" }}
        >
          일괄 추가
        </button>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <SectionTitle>등록된 단어 ({config.wordsets.length})</SectionTitle>
          <div className="flex items-center gap-2">
            {saving && <Loader2 size={14} className="animate-spin" style={{ color: COLORS.inkSoft }} />}
            {folders.length > 1 && (
              <select
                value={filterFolder}
                onChange={(e) => setFilterFolder(e.target.value)}
                className="text-xs p-1.5 rounded-lg outline-none"
                style={{ border: `1px solid ${COLORS.line}`, fontSize: "16px" }}
              >
                <option value="전체">전체 폴더</option>
                {folders.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            )}
          </div>
        </div>
        {wordDocError && (
          <p className="text-xs mt-2" style={{ color: COLORS.bad }}>{wordDocError}</p>
        )}
        {config.wordsets.length === 0 ? (
          <EmptyState text="아직 등록된 단어가 없어요. 위에서 추가해보세요." />
        ) : (
          <div className="mt-3 space-y-5">
            {(filterFolder === "전체" ? folders : [filterFolder]).map((f) => {
              const items = config.wordsets.filter((w) => (w.folder || DEFAULT_FOLDER) === f);
              if (items.length === 0) return null;
              return (
                <div key={f}>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <div
                      className="text-xs font-semibold px-2 py-1 rounded-full inline-block"
                      style={{ background: COLORS.okBg, color: COLORS.ok }}
                    >
                      {f} ({items.length})
                    </div>
                    <button
                      onClick={() => deleteFolder(f)}
                      className="text-[11px] px-2 py-1 rounded-full"
                      style={
                        confirmDeleteFolder === f
                          ? { background: COLORS.bad, color: "#fff" }
                          : { background: "transparent", color: COLORS.bad, border: `1px solid ${COLORS.badBg}` }
                      }
                    >
                      {confirmDeleteFolder === f ? "정말 삭제할까요? 다시 클릭" : "폴더 삭제"}
                    </button>
                    <button
                      onClick={() => downloadFolderWord(f, items)}
                      disabled={wordDocGenerating === f}
                      className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-full disabled:opacity-60"
                      style={{ background: "transparent", color: COLORS.ok, border: `1px solid ${COLORS.ok}` }}
                    >
                      {wordDocGenerating === f ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <FileText size={11} />
                      )}
                      {wordDocGenerating === f ? "생성 중..." : "워드 다운로드"}
                    </button>
                  </div>
                  <div className="divide-y" style={{ borderColor: COLORS.line }}>
                    {items.map((w) => (
                      <div key={w.id} className="py-2 flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium">{w.word} <span style={{ color: COLORS.inkSoft }}>— {w.meaning}</span></div>
                          {w.example && (
                            <div className="text-xs mt-0.5" style={{ color: COLORS.inkSoft }}>{w.example}</div>
                          )}
                          {((w.synonyms && w.synonyms.length > 0) || (w.antonyms && w.antonyms.length > 0)) && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {(w.synonyms || []).map((s) => (
                                <span key={"syn-" + s} className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: COLORS.okBg, color: COLORS.ok }}>
                                  유= {s}
                                </span>
                              ))}
                              {(w.antonyms || []).map((s) => (
                                <span key={"ant-" + s} className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: COLORS.badBg, color: COLORS.bad }}>
                                  반= {s}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <button onClick={() => remove(w.id)} className="p-1.5 rounded-full hover:opacity-70">
                          <Trash2 size={15} style={{ color: COLORS.bad }} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function PassageExtractTab({ config, setConfig }) {
  const [passage, setPassage] = useState("");
  const [destFolder, setDestFolder] = useState(DEFAULT_FOLDER);
  const [extractCount, setExtractCount] = useState(20);
  const [minExtractCount, setMinExtractCount] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [extracted, setExtracted] = useState([]);
  const [saving, setSaving] = useState(false);
  const folders = getFolders(config.wordsets);

  const extract = async () => {
    if (!passage.trim()) return;
    setLoading(true);
    setError("");
    setExtracted([]);
    const prompt = `당신은 한국 고등학교 1학년(고1) 영어 어휘 학습 자료를 만드는 도우미입니다.
아래 영어 지문에서 고1 학습자에게 유용한 핵심 어휘를 최소 ${minExtractCount}개, 최대 ${extractCount}개 골라주세요.
가능하면 반드시 최소 개수 이상을 채워주세요 — 지문에 실제로 등장하는 단어라면, 아주 쉬운 단어라도 좋으니 최소 개수를 맞추는 걸 우선하세요. 지문 자체가 너무 짧아서 그래도 최소 개수를 못 채운다면 나오는 만큼만 골라도 됩니다. 같은 단어를 중복해서 넣지 마세요.
다른 설명이나 인사말, 마크다운 코드블록 없이 순수 JSON 배열만 출력하세요. 각 항목은 아래 형식을 따르세요.

[
  {
    "word": "지문에 등장한 단어(원형 또는 지문 속 활용형)",
    "meaning": "간결한 한국어 뜻",
    "example": "이 단어가 포함된 지문 속 문장을 원문 그대로 인용",
    "synonyms": ["고1 수준 유의어 (영어, 최대 2개)"],
    "antonyms": ["고1 수준 반의어 (영어, 있는 경우만 최대 2개)"]
  }
]

지문:
"""
${passage.trim()}
"""`;
    try {
      const maxTokens = Math.min(6000, Math.max(1200, extractCount * 350 + 500));
      const parsed = await callClaudeJsonArray(prompt, maxTokens);
      const entries = parsed
        .map((p) => ({
          id: uid(),
          word: (p.word || "").trim(),
          meaning: (p.meaning || "").trim(),
          example: (p.example || "").trim(),
          synonyms: Array.isArray(p.synonyms) ? p.synonyms.join(", ") : "",
          antonyms: Array.isArray(p.antonyms) ? p.antonyms.join(", ") : "",
          include: true,
        }))
        .filter((e) => e.word && e.meaning);
      if (entries.length === 0) {
        setError("지문에서 단어를 추출하지 못했어요. 다른 지문으로 시도해보세요.");
      }
      setExtracted(entries);
    } catch (e) {
      console.error("추출 실패", e);
      setError(`추출 중 문제가 발생했어요: ${e.message || "알 수 없는 오류"}`);
    } finally {
      setLoading(false);
    }
  };

  const updateEntry = (id, field, value) => {
    setExtracted((prev) =>
      prev.map((e) => (e.id === id ? { ...e, [field]: value } : e))
    );
  };
  const toggleInclude = (id) => {
    setExtracted((prev) =>
      prev.map((e) => (e.id === id ? { ...e, include: !e.include } : e))
    );
  };

  const addSelected = async () => {
    const chosen = extracted.filter((e) => e.include);
    if (chosen.length === 0) return;
    const remainingSlots = MAX_WORDS - config.wordsets.length;
    if (remainingSlots <= 0) {
      setNotice(`단어는 최대 ${MAX_WORDS}개까지만 등록할 수 있어요.`);
      return;
    }
    let toAdd = chosen;
    let msg = "";
    if (chosen.length > remainingSlots) {
      toAdd = chosen.slice(0, remainingSlots);
      msg = `최대 ${MAX_WORDS}개 제한으로 ${toAdd.length}개만 추가했어요.`;
    }
    const newWords = toAdd.map((e) => ({
      id: uid(),
      word: e.word,
      meaning: e.meaning,
      example: e.example,
      folder: destFolder.trim() || DEFAULT_FOLDER,
      synonyms: e.synonyms.split(",").map((s) => s.trim()).filter(Boolean),
      antonyms: e.antonyms.split(",").map((s) => s.trim()).filter(Boolean),
    }));
    const newCfg = { ...config, wordsets: [...config.wordsets, ...newWords] };
    setConfig(newCfg);
    setSaving(true);
    await saveConfig(newCfg);
    setSaving(false);
    setExtracted([]);
    setPassage("");
    setNotice(msg || `${newWords.length}개 단어를 "${destFolder.trim() || DEFAULT_FOLDER}" 폴더에 추가했어요.`);
  };

  const includedCount = extracted.filter((e) => e.include).length;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center gap-2">
          <Sparkles size={18} style={{ color: COLORS.ok }} />
          <SectionTitle>지문에서 단어 자동 추출</SectionTitle>
        </div>
        <p className="text-xs mt-1" style={{ color: COLORS.inkSoft }}>
          영어 지문을 붙여넣으면 고1 수준의 핵심 어휘와 뜻, 예문, 유의어·반의어까지 자동으로 뽑아줘요. 결과는 추가하기 전에 검토·수정할 수 있어요.
        </p>
        <textarea
          value={passage}
          onChange={(e) => setPassage(e.target.value)}
          rows={6}
          placeholder="여기에 영어 지문을 붙여넣으세요..."
          className="w-full mt-3 p-3 rounded-lg text-sm outline-none resize-none"
          style={{ border: `1px solid ${COLORS.line}`, background: "#fafafa", fontSize: "16px" }}
        />
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <div>
            <label className="text-xs" style={{ color: COLORS.inkSoft }}>추가할 폴더</label>
            <input
              list="folder-suggestions-extract"
              value={destFolder}
              onChange={(e) => setDestFolder(e.target.value)}
              placeholder="폴더 (예: Day1)"
              className="block mt-1 p-2 rounded-lg text-sm outline-none"
              style={{ border: `1px solid ${COLORS.line}`, fontSize: "16px" }}
            />
            <datalist id="folder-suggestions-extract">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="text-xs" style={{ color: COLORS.inkSoft }}>최소 단어 수</label>
            <input
              type="number"
              min={1}
              max={extractCount}
              value={minExtractCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10) || 1;
                setMinExtractCount(Math.max(1, Math.min(extractCount, v)));
              }}
              className="block mt-1 w-20 p-2 rounded-lg text-sm outline-none"
              style={{ border: `1px solid ${COLORS.line}`, fontSize: "16px" }}
            />
          </div>
          <div>
            <label className="text-xs" style={{ color: COLORS.inkSoft }}>최대 단어 수</label>
            <input
              type="number"
              min={1}
              max={50}
              value={extractCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10) || 1;
                const next = Math.max(1, Math.min(50, v));
                setExtractCount(next);
                setMinExtractCount((prevMin) => Math.min(prevMin, next));
              }}
              className="block mt-1 w-20 p-2 rounded-lg text-sm outline-none"
              style={{ border: `1px solid ${COLORS.line}`, fontSize: "16px" }}
            />
          </div>
          <button
            onClick={extract}
            disabled={loading || !passage.trim()}
            className="flex items-center gap-1 text-sm font-medium px-4 py-2.5 rounded-full disabled:opacity-50 mt-4"
            style={{ background: COLORS.ok, color: "#fff" }}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
            {loading ? "추출 중..." : "단어 추출하기"}
          </button>
        </div>
        <p className="text-xs mt-1" style={{ color: COLORS.inkSoft }}>
          (최대 50개까지 늘릴 수 있어요. 최소 개수는 AI가 최대한 맞추려고 하지만, 지문이 아주 짧으면 그보다 적게 나올 수 있어요.)
        </p>
        {error && (
          <p className="text-xs mt-2" style={{ color: COLORS.bad }}>{error}</p>
        )}
      </Card>

      {extracted.length > 0 && (
        <Card>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <SectionTitle>추출 결과 ({extracted.length}개)</SectionTitle>
            <span className="text-xs" style={{ color: COLORS.inkSoft }}>
              선택됨 {includedCount}개 — 필요하면 내용을 직접 수정하세요
            </span>
          </div>
          <div className="mt-3 space-y-3">
            {extracted.map((e) => (
              <div
                key={e.id}
                className="p-3 rounded-lg"
                style={{
                  background: e.include ? "#fafafa" : "#f2f2f2",
                  border: `1px solid ${COLORS.line}`,
                  opacity: e.include ? 1 : 0.55,
                }}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={e.include}
                    onChange={() => toggleInclude(e.id)}
                    className="mt-2.5"
                  />
                  <div className="flex-1 grid sm:grid-cols-2 gap-2">
                    <Input
                      placeholder="단어"
                      value={e.word}
                      onChange={(v) => updateEntry(e.id, "word", v)}
                    />
                    <Input
                      placeholder="뜻"
                      value={e.meaning}
                      onChange={(v) => updateEntry(e.id, "meaning", v)}
                    />
                    <div className="sm:col-span-2">
                      <Input
                        placeholder="예문"
                        value={e.example}
                        onChange={(v) => updateEntry(e.id, "example", v)}
                      />
                    </div>
                    <Input
                      placeholder="유의어 (쉼표 구분)"
                      value={e.synonyms}
                      onChange={(v) => updateEntry(e.id, "synonyms", v)}
                    />
                    <Input
                      placeholder="반의어 (쉼표 구분)"
                      value={e.antonyms}
                      onChange={(v) => updateEntry(e.id, "antonyms", v)}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={addSelected}
            disabled={includedCount === 0 || saving}
            className="mt-4 flex items-center gap-1 text-sm font-medium px-4 py-2 rounded-full disabled:opacity-50"
            style={{ background: COLORS.ink, color: "#fff" }}
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            선택한 단어 "{destFolder.trim() || DEFAULT_FOLDER}" 폴더에 추가하기
          </button>
          {notice && (
            <p className="text-xs mt-2" style={{ color: COLORS.ok }}>{notice}</p>
          )}
        </Card>
      )}
    </div>
  );
}


function StudentsTab({ config, setConfig }) {
  const [name, setName] = useState("");
  const [assignFolders, setAssignFolders] = useState([ALL_FOLDERS]);
  const [copiedCode, setCopiedCode] = useState(null);
  const [editingCode, setEditingCode] = useState(null);
  const [editingFolders, setEditingFolders] = useState([ALL_FOLDERS]);
  const folders = getFolders(config.wordsets);

  const addStudent = async () => {
    if (!name.trim()) return;
    const code = genCode(config.students.map((s) => s.code));
    const entry = {
      code,
      name: name.trim(),
      folders: assignFolders.length > 0 ? assignFolders : [ALL_FOLDERS],
      createdAt: Date.now(),
    };
    const newCfg = { ...config, students: [...config.students, entry] };
    setConfig(newCfg);
    await saveConfig(newCfg);
    setName("");
  };

  const removeStudent = async (code) => {
    const newCfg = { ...config, students: config.students.filter((s) => s.code !== code) };
    setConfig(newCfg);
    await saveConfig(newCfg);
  };

  const startEditFolders = (s) => {
    setEditingCode(s.code);
    setEditingFolders(getAssignedFolders(s));
  };

  const cancelEditFolders = () => {
    setEditingCode(null);
  };

  const saveEditFolders = async () => {
    const newCfg = {
      ...config,
      students: config.students.map((s) =>
        s.code === editingCode
          ? { ...s, folders: editingFolders.length > 0 ? editingFolders : [ALL_FOLDERS], folder: undefined }
          : s
      ),
    };
    setConfig(newCfg);
    await saveConfig(newCfg);
    setEditingCode(null);
  };

  const copy = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 1500);
    } catch {}
  };

  return (
    <div className="space-y-6">
      <Card>
        <SectionTitle>학생 추가</SectionTitle>
        <p className="text-xs mt-1" style={{ color: COLORS.inkSoft }}>
          학생별로 풀 폴더를 하나 이상 지정할 수 있어요. "전체"로 두면 모든 폴더의 단어를 풀 수 있어요.
        </p>
        <div className="mt-3">
          <Input placeholder="학생 이름" value={name} onChange={setName} onEnter={addStudent} />
        </div>
        {folders.length > 0 && (
          <div className="mt-3">
            <FolderCheckboxGroup folders={folders} selected={assignFolders} onChange={setAssignFolders} />
          </div>
        )}
        <button
          onClick={addStudent}
          className="mt-3 flex items-center gap-1 text-sm font-medium px-4 py-2 rounded-full whitespace-nowrap"
          style={{ background: COLORS.ok, color: "#fff" }}
        >
          <Plus size={16} /> 코드 발급
        </button>
      </Card>

      <Card>
        <SectionTitle>학생 목록 ({config.students.length})</SectionTitle>
        {config.students.length === 0 ? (
          <EmptyState text="아직 등록된 학생이 없어요." />
        ) : (
          <div className="mt-3 space-y-2">
            {config.students.map((s) => {
              const assigned = getAssignedFolders(s);
              const isEditing = editingCode === s.code;
              return (
                <div
                  key={s.code}
                  className="p-3 rounded-lg"
                  style={{ background: "#fafafa", border: `1px solid ${COLORS.line}` }}
                >
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <div className="font-medium">{s.name}</div>
                      <div
                        className="font-mono text-sm tracking-widest mt-0.5"
                        style={{ color: COLORS.ok }}
                      >
                        {s.code}
                      </div>
                      {!isEditing && (
                        <div className="text-xs mt-1" style={{ color: COLORS.inkSoft }}>
                          배정 폴더: {assigned.includes(ALL_FOLDERS) ? "전체" : assigned.join(", ")}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {!isEditing && (
                        <button
                          onClick={() => startEditFolders(s)}
                          className="text-xs px-3 py-1.5 rounded-full"
                          style={{ background: "#fff", border: `1px solid ${COLORS.line}`, color: COLORS.inkSoft }}
                        >
                          폴더 수정
                        </button>
                      )}
                      <button
                        onClick={() => copy(s.code)}
                        className="p-2 rounded-full"
                        style={{ background: "#fff", border: `1px solid ${COLORS.line}` }}
                      >
                        {copiedCode === s.code ? (
                          <Check size={14} style={{ color: COLORS.ok }} />
                        ) : (
                          <Copy size={14} style={{ color: COLORS.inkSoft }} />
                        )}
                      </button>
                      <button onClick={() => removeStudent(s.code)} className="p-2 rounded-full">
                        <Trash2 size={14} style={{ color: COLORS.bad }} />
                      </button>
                    </div>
                  </div>
                  {isEditing && (
                    <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${COLORS.line}` }}>
                      <FolderCheckboxGroup
                        folders={folders}
                        selected={editingFolders}
                        onChange={setEditingFolders}
                      />
                      <div className="flex items-center gap-2 mt-3">
                        <button
                          onClick={saveEditFolders}
                          className="text-xs px-3 py-1.5 rounded-full font-medium"
                          style={{ background: COLORS.ok, color: "#fff" }}
                        >
                          저장
                        </button>
                        <button
                          onClick={cancelEditFolders}
                          className="text-xs px-3 py-1.5 rounded-full"
                          style={{ background: "#fff", border: `1px solid ${COLORS.line}`, color: COLORS.inkSoft }}
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function ResultsTab({ config }) {
  const [selected, setSelected] = useState(config.students[0]?.code || "");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    loadResults(selected).then((r) => {
      setResults(r);
      setLoading(false);
    });
  }, [selected]);

  if (config.students.length === 0) {
    return (
      <Card>
        <EmptyState text="학생을 먼저 등록해주세요." />
      </Card>
    );
  }

  const rows = results
    ? config.wordsets
        .map((w) => ({
          ...w,
          correct: results.wordStats[w.id]?.correct || 0,
          wrong: results.wordStats[w.id]?.wrong || 0,
        }))
        .filter((r) => r.correct + r.wrong > 0)
        .sort((a, b) => b.wrong - a.wrong)
    : [];

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>학생 선택</SectionTitle>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="mt-3 w-full p-2.5 rounded-lg text-sm outline-none"
          style={{ border: `1px solid ${COLORS.line}`, fontSize: "16px" }}
        >
          {config.students.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name} ({s.code})
            </option>
          ))}
        </select>
      </Card>

      <Card>
        <SectionTitle>단어별 정답/오답</SectionTitle>
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState text="아직 이 학생의 풀이 기록이 없어요." />
        ) : (
          <div className="mt-3 space-y-2">
            {rows.map((r) => {
              const needsReview = r.wrong >= 1 && r.wrong >= r.correct;
              return (
                <div
                  key={r.id}
                  className="flex items-center justify-between p-3 rounded-lg"
                  style={{
                    background: needsReview ? COLORS.warnBg : "#fafafa",
                    border: `1px solid ${needsReview ? COLORS.warn : COLORS.line}`,
                  }}
                >
                  <div>
                    <div className="font-medium">
                      {r.word} <span style={{ color: COLORS.inkSoft }}>— {r.meaning}</span>
                    </div>
                    {needsReview && (
                      <span
                        className="text-[11px] font-semibold px-1.5 py-0.5 rounded mt-1 inline-block"
                        style={{ background: COLORS.warn, color: "#3a2c00" }}
                      >
                        복습 필요
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span style={{ color: COLORS.ok }}>정답 {r.correct}</span>
                    <span style={{ color: COLORS.bad }}>오답 {r.wrong}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ================= 학생 =================
function StudentView() {
  const [phase, setPhase] = useState("code"); // code | ready | quiz | result
  const [codeInput, setCodeInput] = useState("");
  const [error, setError] = useState("");
  const [config, setConfig] = useState(null);
  const [student, setStudent] = useState(null);
  const [results, setResults] = useState(null);
  const [quiz, setQuiz] = useState([]);
  const [qIdx, setQIdx] = useState(0);
  const [answered, setAnswered] = useState(false);
  const [selectedOpt, setSelectedOpt] = useState(null);
  const [blankInput, setBlankInput] = useState("");
  const [sessionAnswers, setSessionAnswers] = useState([]);
  const [checking, setChecking] = useState(false);
  const [quizSize, setQuizSize] = useState(10);
  const [masteryMode, setMasteryMode] = useState(false);
  const [roundAnswers, setRoundAnswers] = useState([]);
  const [roundNumber, setRoundNumber] = useState(1);
  const [firstRoundSummary, setFirstRoundSummary] = useState(null);

  const submitCode = async () => {
    setChecking(true);
    setError("");
    const cfg = await loadConfig();
    setConfig(cfg);
    const found = cfg.students.find(
      (s) => s.code.toUpperCase() === codeInput.trim().toUpperCase()
    );
    setChecking(false);
    if (!found) {
      setError("코드를 찾을 수 없어요. 다시 확인해주세요.");
      return;
    }
    setStudent(found);
    const r = await loadResults(found.code);
    setResults(r);
    const scoped = scopeWordsByFolders(cfg.wordsets, getAssignedFolders(found));
    setQuizSize(Math.min(10, scoped.length));
    setPhase("ready");
  };

  const scopedWords = (() => {
    if (!config || !student) return [];
    return scopeWordsByFolders(config.wordsets, getAssignedFolders(student));
  })();

  const startQuiz = () => {
    const questions = buildQuiz(scopedWords, results.wordStats, quizSize);
    setQuiz(questions);
    setQIdx(0);
    setSessionAnswers([]);
    setRoundAnswers([]);
    setRoundNumber(1);
    setFirstRoundSummary(null);
    setAnswered(false);
    setSelectedOpt(null);
    setBlankInput("");
    setPhase("quiz");
  };

  const currentQ = quiz[qIdx];

  const submitAnswer = (isCorrect, given) => {
    setAnswered(true);
    const entry = { wordId: currentQ.id, correct: isCorrect, given };
    setSessionAnswers((prev) => [...prev, entry]);
    setRoundAnswers((prev) => [...prev, entry]);
  };

  const checkMCQ = (opt) => {
    if (answered) return;
    setSelectedOpt(opt);
    submitAnswer(opt === currentQ.answer, opt);
  };

  const checkBlank = () => {
    if (answered || !blankInput.trim()) return;
    const isCorrect =
      blankInput.trim().toLowerCase() === currentQ.answer.trim().toLowerCase();
    submitAnswer(isCorrect, blankInput.trim());
  };

  const next = async () => {
    if (qIdx + 1 < quiz.length) {
      setQIdx(qIdx + 1);
      setAnswered(false);
      setSelectedOpt(null);
      setBlankInput("");
      return;
    }

    // 이번 라운드(회차) 종료
    if (roundNumber === 1 && !firstRoundSummary) {
      setFirstRoundSummary({
        score: roundAnswers.filter((a) => a.correct).length,
        total: roundAnswers.length,
      });
    }

    const missedIds = Array.from(
      new Set(roundAnswers.filter((a) => !a.correct).map((a) => a.wordId))
    );

    if (masteryMode && missedIds.length > 0) {
      const missedWords = missedIds
        .map((id) => scopedWords.find((w) => w.id === id))
        .filter(Boolean);
      const nextQuestions = buildQuiz(
        missedWords,
        results.wordStats,
        missedWords.length,
        scopedWords
      );
      setQuiz(nextQuestions);
      setQIdx(0);
      setAnswered(false);
      setSelectedOpt(null);
      setBlankInput("");
      setRoundAnswers([]);
      setRoundNumber((n) => n + 1);
      return;
    }

    // 전체 완료 → 결과 저장
    const newStats = { ...results.wordStats };
    sessionAnswers.forEach((a) => {
      const cur = newStats[a.wordId] || { correct: 0, wrong: 0 };
      if (a.correct) cur.correct += 1;
      else cur.wrong += 1;
      newStats[a.wordId] = cur;
    });
    const newAttempts = [
      ...results.attempts,
      {
        date: Date.now(),
        score: sessionAnswers.filter((a) => a.correct).length,
        total: sessionAnswers.length,
      },
    ].slice(-30);
    const newResults = { wordStats: newStats, attempts: newAttempts };
    setResults(newResults);
    await saveResults(student.code, newResults);
    setPhase("result");
  };

  if (phase === "code") {
    return (
      <Card>
        <SectionTitle>학생 코드 입력</SectionTitle>
        <p className="text-sm mt-1" style={{ color: COLORS.inkSoft }}>
          선생님께 받은 코드를 입력하세요.
        </p>
        <div className="flex gap-3 mt-3">
          <Input
            placeholder="예: A3F9K2"
            value={codeInput}
            onChange={setCodeInput}
            onEnter={submitCode}
          />
          <button
            onClick={submitCode}
            disabled={checking}
            className="px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap"
            style={{ background: COLORS.ink, color: "#fff" }}
          >
            {checking ? <Loader2 size={16} className="animate-spin" /> : "입장"}
          </button>
        </div>
        {error && (
          <p className="text-sm mt-2" style={{ color: COLORS.bad }}>
            {error}
          </p>
        )}
      </Card>
    );
  }

  if (phase === "ready") {
    const assignedFolders = getAssignedFolders(student);
    const isAllFolders = assignedFolders.includes(ALL_FOLDERS);
    const scopedIds = new Set(scopedWords.map((w) => w.id));
    const wrongCount = Object.entries(results.wordStats).filter(
      ([id, s]) => scopedIds.has(id) && s.wrong > s.correct
    ).length;
    const maxSize = Math.min(MAX_WORDS, scopedWords.length);
    return (
      <Card>
        <SectionTitle>{student.name}님, 안녕하세요</SectionTitle>
        <p className="text-sm mt-2" style={{ color: COLORS.inkSoft }}>
          {isAllFolders ? (
            <>전체 {config.wordsets.length}개 단어 중에서 문제가 나와요.</>
          ) : (
            <>
              선생님이 배정한 <b>"{assignedFolders.join(", ")}"</b> 폴더 단어 {scopedWords.length}개 중에서 문제가 나와요.
            </>
          )}
          {wrongCount > 0 && ` 틀렸던 단어 ${wrongCount}개가 우선적으로 더 자주 나와요.`}
        </p>
        {scopedWords.length === 0 ? (
          <EmptyState text="아직 배정된 폴더에 단어가 없어요. 선생님께 문의해주세요." />
        ) : (
          <>
            <div className="flex items-center gap-2 mt-3">
              <label className="text-sm" style={{ color: COLORS.inkSoft }}>
                문제 수
              </label>
              <input
                type="number"
                min={1}
                max={maxSize}
                value={quizSize}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10) || 1;
                  setQuizSize(Math.max(1, Math.min(maxSize, v)));
                }}
                className="w-20 p-2 rounded-lg text-sm outline-none"
                style={{ border: `1px solid ${COLORS.line}`, fontSize: "16px" }}
              />
              <span className="text-xs" style={{ color: COLORS.inkSoft }}>
                (최대 {maxSize}개)
              </span>
            </div>
            <label
              className="flex items-center gap-2 mt-3 text-sm cursor-pointer select-none"
              style={{ color: COLORS.inkSoft }}
            >
              <input
                type="checkbox"
                checked={masteryMode}
                onChange={(e) => setMasteryMode(e.target.checked)}
              />
              모두 맞힐 때까지 반복하기 (틀린 단어만 계속 다시 출제돼요)
            </label>
            <button
              onClick={startQuiz}
              className="mt-4 px-5 py-2.5 rounded-full text-sm font-medium"
              style={{ background: COLORS.ok, color: "#fff" }}
            >
              퀴즈 시작
            </button>
          </>
        )}
      </Card>
    );
  }

  if (phase === "quiz" && currentQ) {
    return (
      <Card>
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-medium" style={{ color: COLORS.inkSoft }}>
            {qIdx + 1} / {quiz.length}
          </span>
          <div
            className="h-1.5 rounded-full flex-1 mx-3"
            style={{ background: COLORS.line }}
          >
            <div
              className="h-1.5 rounded-full"
              style={{
                background: COLORS.ok,
                width: `${((qIdx + (answered ? 1 : 0)) / quiz.length) * 100}%`,
                transition: "width .3s",
              }}
            />
          </div>
        </div>

        {roundNumber > 1 && (
          <div
            className="text-xs font-semibold px-2 py-1 rounded-full inline-block mb-3"
            style={{ background: COLORS.warnBg, color: "#8a6200" }}
          >
            재도전 {roundNumber}회차 · 틀린 단어만 다시 풀어요
          </div>
        )}

        {(currentQ.type === "meaning" ||
          currentQ.type === "word" ||
          currentQ.type === "synonym" ||
          currentQ.type === "antonym") && (
          <>
            <p className="text-sm" style={{ color: COLORS.inkSoft }}>{TYPE_LABELS[currentQ.type]}</p>
            <p className="font-serif text-2xl mt-1 mb-4">{currentQ.prompt}</p>
          </>
        )}
        {currentQ.type === "blank" && (
          <>
            <p className="text-sm" style={{ color: COLORS.inkSoft }}>빈칸에 알맞은 단어를 쓰세요</p>
            <p className="text-lg mt-1">{currentQ.prompt}</p>
            <p
              className="text-sm mt-1.5 mb-4 inline-block px-2 py-1 rounded"
              style={{ background: COLORS.okBg, color: COLORS.ok }}
            >
              뜻: {currentQ.word.meaning}
            </p>
          </>
        )}

        {currentQ.type !== "blank" ? (
          <div className="grid sm:grid-cols-2 gap-2">
            {currentQ.options.map((opt) => {
              let style = { border: `1px solid ${COLORS.line}`, background: "#fafafa" };
              if (answered) {
                if (opt === currentQ.answer) style = { border: `1px solid ${COLORS.ok}`, background: COLORS.okBg };
                else if (opt === selectedOpt) style = { border: `1px solid ${COLORS.bad}`, background: COLORS.badBg };
              }
              return (
                <button
                  key={opt}
                  onClick={() => checkMCQ(opt)}
                  className="text-left p-3 rounded-lg text-sm"
                  style={style}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              placeholder="정답 입력"
              value={blankInput}
              onChange={setBlankInput}
              onEnter={checkBlank}
              disabled={answered}
            />
            {!answered && (
              <button
                onClick={checkBlank}
                className="px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap"
                style={{ background: COLORS.ink, color: "#fff" }}
              >
                확인
              </button>
            )}
          </div>
        )}

        {answered && (
          <div className="mt-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2 text-sm">
              {sessionAnswers[sessionAnswers.length - 1]?.correct ? (
                <span className="flex items-center gap-1" style={{ color: COLORS.ok }}>
                  <Check size={16} /> 정답이에요
                </span>
              ) : (
                <span className="flex items-center gap-1" style={{ color: COLORS.bad }}>
                  <X size={16} /> 정답은 "{currentQ.answer}"
                </span>
              )}
            </div>
            <button
              onClick={next}
              className="flex items-center justify-center gap-1 px-4 py-2.5 rounded-full text-sm font-medium w-full sm:w-auto"
              style={{ background: COLORS.ink, color: "#fff" }}
            >
              {qIdx + 1 < quiz.length
                ? "다음"
                : masteryMode
                ? "채점하기"
                : "결과 보기"}{" "}
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </Card>
    );
  }

  if (phase === "result") {
    const score = sessionAnswers.filter((a) => a.correct).length;
    const missed = Array.from(new Set(sessionAnswers.filter((a) => !a.correct).map((a) => a.wordId)))
      .map((id) => config.wordsets.find((w) => w.id === id))
      .filter(Boolean);
    return (
      <Card>
        <SectionTitle>결과</SectionTitle>
        {masteryMode && firstRoundSummary ? (
          <>
            <p className="font-serif text-3xl mt-2">
              {firstRoundSummary.score} / {firstRoundSummary.total}
            </p>
            <p className="text-sm mt-1" style={{ color: COLORS.inkSoft }}>
              1차 시도 결과예요.{" "}
              {roundNumber > 1
                ? `틀린 단어를 ${roundNumber - 1}번 더 복습해서 모두 맞혔어요! 🎉`
                : "한 번에 전부 맞혔어요! 🎉"}
            </p>
          </>
        ) : (
          <p className="font-serif text-3xl mt-2">
            {score} / {sessionAnswers.length}
          </p>
        )}
        {missed.length > 0 ? (
          <div className="mt-4">
            <p className="text-sm mb-2" style={{ color: COLORS.inkSoft }}>
              {masteryMode
                ? "이번에 한 번이라도 틀렸던 단어예요. 다음에도 더 자주 나와요."
                : "이번에 틀린 단어예요. 다음 퀴즈에 더 자주 나와요."}
            </p>
            <div className="space-y-2">
              {missed.map((w) => (
                <div
                  key={w.id}
                  className="p-2.5 rounded-lg text-sm"
                  style={{ background: COLORS.warnBg, border: `1px solid ${COLORS.warn}` }}
                >
                  <b>{w.word}</b> — {w.meaning}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm mt-2" style={{ color: COLORS.ok }}>전부 맞혔어요! 🎉</p>
        )}
        <button
          onClick={() => setPhase("ready")}
          className="mt-5 flex items-center gap-1 px-4 py-2 rounded-full text-sm font-medium"
          style={{ background: COLORS.ok, color: "#fff" }}
        >
          <RotateCcw size={14} /> 다시 풀기
        </button>
      </Card>
    );
  }

  return <Loading />;
}

// ================= 공용 컴포넌트 =================
function FolderCheckboxGroup({ folders, selected, onChange }) {
  const isAll = !selected || selected.length === 0 || selected.includes(ALL_FOLDERS);

  const toggleAll = () => {
    if (!isAll) onChange([ALL_FOLDERS]);
  };
  const toggleFolder = (f) => {
    if (isAll) {
      onChange([f]);
      return;
    }
    if (selected.includes(f)) {
      const next = selected.filter((s) => s !== f);
      onChange(next.length > 0 ? next : [ALL_FOLDERS]);
    } else {
      onChange([...selected, f]);
    }
  };

  const chipStyle = (active) => ({
    border: `1px solid ${active ? COLORS.ok : COLORS.line}`,
    background: active ? COLORS.okBg : "#fff",
    color: active ? COLORS.ok : COLORS.inkSoft,
  });

  return (
    <div className="flex flex-wrap gap-2">
      <label
        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg cursor-pointer select-none"
        style={chipStyle(isAll)}
      >
        <input type="checkbox" checked={isAll} onChange={toggleAll} className="hidden" />
        전체
      </label>
      {folders.map((f) => {
        const checked = !isAll && selected.includes(f);
        return (
          <label
            key={f}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg cursor-pointer select-none"
            style={chipStyle(checked)}
          >
            <input type="checkbox" checked={checked} onChange={() => toggleFolder(f)} className="hidden" />
            {f}
          </label>
        );
      })}
    </div>
  );
}

function Card({ children }) {
  return (
    <div
      className="rounded-2xl p-5"
      style={{ background: COLORS.card, border: `1px solid ${COLORS.line}` }}
    >
      {children}
    </div>
  );
}
function SectionTitle({ children }) {
  return (
    <h3 className="font-serif text-lg" style={{ letterSpacing: "-0.01em" }}>
      {children}
    </h3>
  );
}
function EmptyState({ text }) {
  return (
    <p className="text-sm mt-3 py-4 text-center" style={{ color: COLORS.inkSoft }}>
      {text}
    </p>
  );
}
function Loading() {
  return (
    <div className="flex justify-center py-10">
      <Loader2 className="animate-spin" style={{ color: COLORS.inkSoft }} />
    </div>
  );
}
function Input({ placeholder, value, onChange, onEnter, disabled, type = "text" }) {
  return (
    <input
      type={type}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) onEnter();
      }}
      placeholder={placeholder}
      className="flex-1 w-full p-2.5 rounded-lg text-sm outline-none disabled:opacity-60"
      style={{ border: `1px solid ${COLORS.line}`, fontSize: "16px" }}
    />
  );
}
