import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import pdfParse from "pdf-parse";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const uploadDir = path.join(__dirname, "uploads");
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(uploadDir, { recursive: true });

const dbFile = path.join(dataDir, "preppilot.json");
const emptyDb = { files: [], topics: [], questions: [], flashcards: [], sessions: [], deadlines: [] };

async function readDb() {
  try { return JSON.parse(await fs.readFile(dbFile, "utf8")); }
  catch { await writeDb(emptyDb); return structuredClone(emptyDb); }
}
async function writeDb(db) { await fs.writeFile(dbFile, JSON.stringify(db, null, 2)); }

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".pdf", ".pptx", ".txt", ".md"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

function cleanText(value = "") {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function questionKey(text = "") {
  const normalized = text.toLowerCase().replace(/question\s*\d+|\d+\s*[.)]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  return crypto.createHash("sha1").update(normalized).digest("hex");
}

function classifyDocument(filename, text) {
  const filenameCue = /pyq|previous|question.?paper|exam|mid.?term|end.?term|university.?paper|semester.?paper/i.test(filename);
  const structureCues = [
    /attempt\s+(any|all)|answer\s+(any|the following)/i.test(text),
    /\b(?:q|question)\s*\d+\s*[.):]/i.test(text),
    /\b(?:19|20)\d{2}\b/.test(text) && /marks?|maximum|duration|time/i.test(text)
  ].filter(Boolean).length;
  const isPyq = filenameCue || structureCues >= 2;
  return { documentType: isPyq ? "pyq" : "study_material", classificationConfidence: filenameCue ? 0.98 : isPyq ? 0.84 : 0.9 };
}

async function extractText(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === ".pdf") {
    const result = await pdfParse(await fs.readFile(file.path));
    return cleanText(result.text);
  }
  if (extension === ".pptx") {
    const zip = new AdmZip(file.path);
    const slides = zip.getEntries()
      .filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }))
      .map(entry => entry.getData().toString("utf8").replace(/<[^>]+>/g, " "));
    return cleanText(slides.join(" "));
  }
  return cleanText(await fs.readFile(file.path, "utf8"));
}

function inferTopics(text, filename = "") {
  const searchable = `${filename} ${text}`;
  const candidates = [
    ["TypeScript", /typescript|\b\.ts\b/i],
    ["Web Storage", /web\s*storage|localstorage|sessionstorage/i],
    ["HTML, CSS and JavaScript", /html|css|javascript|dom|web development/i],
    ["Processes", /process management|process states|thread|context switch/i],
    ["CPU Scheduling", /cpu scheduling|round robin|fcfs|sjf|priority scheduling/i],
    ["Deadlocks", /deadlock|banker'?s algorithm|circular wait/i],
    ["Memory Management", /memory management|paging|segmentation|page replacement/i],
    ["Computer Networks", /computer network|tcp|udp|ip address|routing protocol/i],
    ["Database Systems", /database systems?|\bsql\b|normalization|\bjdbc\b|database transaction/i],
    ["Data Structures", /data structures?|linked list|binary tree|graph traversal|stack operations|queue operations/i],
    ["Java and OOP", /\bjava\b|java swing|inheritance|polymorphism|object[- ]oriented programming/i]
  ];
  const found = candidates.filter(([, pattern]) => pattern.test(searchable)).map(([name]) => name);
  return found.length ? found : ["General Concepts"];
}

function extractQuestions(text, sourceFile) {
  return text.split(/(?=(?:Q(?:uestion)?\s*\d+|\d+\s*[.)]))/i)
    .map(cleanText)
    .filter(item => item.length > 20 && item.length < 1200)
    .slice(0, 100)
    .map((question, index) => ({
      id: `q-${Date.now()}-${index}`,
      key: questionKey(question),
      text: question,
      year: null,
      type: /calculate|find|solve|numerical|compute/i.test(question) ? "numerical" : "long_answer",
      marks: null,
      topics: inferTopics(question),
      source: "uploaded PYQ",
      sourceFile,
      occurrences: 1,
      answer: "No answer was included in the uploaded PYQ. Use the source material to solve and verify this question.",
      answer: "No answer was included in the uploaded PYQ. Use the original study material to prepare and verify this answer."
    }));
}

function sourceSentences(sourceText) {
  return sourceText.split(/[.!?]+/).map(cleanText).filter(sentence => sentence.length > 45).slice(0, 8);
}

function sourceConcepts(sourceText) {
  const known = sourceText.match(/\b(?:TypeScript|JavaScript|localStorage|sessionStorage|interface|class|object|inheritance|polymorphism|encapsulation|abstraction|DOM|API|algorithm|normalization|transaction|paging|segmentation|deadlock|TCP|UDP|routing|binary tree|linked list|stack|queue|SQL)\b/gi) || [];
  return [...new Set(known.map(item => item.trim()))].slice(0, 8);
}

function codeSeed(topic) {
  if (/typescript/i.test(topic)) return `interface Student { id: number; name: string; }\nfunction display(student: Student): string { return student.name; }`;
  if (/web storage/i.test(topic)) return `localStorage.setItem("user", JSON.stringify({ name: "Asha", marks: 80 }));\nconst user = JSON.parse(localStorage.getItem("user"));\nconsole.log(user.marks);`;
  if (/java|oop/i.test(topic)) return `class Parent { void show() { System.out.println("Parent"); } }\nclass Child extends Parent { void show() { System.out.println("Child"); } }\nParent item = new Child();\nitem.show();`;
  return `Use the exact code, algorithm, formula, input, and output examples extracted from the uploaded PPT.`;
}

function makePracticeSet(topic, count = 8, sourceText = "") {
  const evidence = sourceSentences(sourceText);
  const concepts = sourceConcepts(sourceText);
  const anchor = evidence[0] || `No usable source passage was extracted for ${topic}`;
  if (!evidence.length) {
    return [{ id: `practice-${Date.now()}-0`, text: `Practice generation paused: no readable source passage was found for ${topic}. Re-upload a text-based PPT/PDF or enable OCR for scanned material.`, type: "needs_source", difficulty: "review", topic, source: "AI practice set", sourceEvidence: "No source evidence", answer: "No answer can be generated safely without readable study material." }];
  }
  const seed = codeSeed(topic);
  const templates = [
    [`Predict the exact output of this ${topic} code, then justify the result line by line. Modify one line so that the output changes as specified.\n\n${seed}`, "output_tracing", "medium", `Use the PPT code/API discussion: ${anchor}`],
    [`Write a complete executable program for this ${topic} problem using the approach shown in the PPT. Include input handling, processing, output, and a test case. Do not give pseudocode only.\n\nProblem context from the PPT: ${anchor}`, "code_writing", "hard", `PPT evidence: ${evidence.slice(0, 2).join("; ")}`],
    [`The following program has a bug related to ${topic}. Identify the error, explain why it occurs, provide the corrected code, and show the corrected output.\n\n${seed}`, "debugging", "hard", `Debug using these PPT concepts: ${concepts.join(", ") || topic}`],
    [`Trace this problem manually using the algorithm or procedure from the PPT. Show every intermediate state, variable value, data-structure change, or browser-storage value, and give the final output.\n\nInput/context: ${evidence.slice(0, 2).join("; ")}`, "step_by_step_problem", "hard", `PPT procedure: ${evidence.slice(0, 2).join("; ")}`],
    [`Implement the feature demonstrated in the PPT for ${topic}. Your answer must contain complete code, a short test case, expected output, and a brief explanation of time/space complexity or runtime behaviour.`, "implementation", "hard", `Implementation must use: ${evidence.slice(0, 3).join("; ")}`],
    [`Given a changed input and one edge case for the ${topic} example in the PPT, solve the problem and show how the output or state changes. Include corrected code if the original example is insufficient.`, "edge_case", "hard", `PPT example: ${anchor}`],
    [`Convert the PPT example into a university-level coding question. Ask the student to complete the missing code, predict the output, and explain the result for a second test case.\n\nSource example: ${evidence.slice(0, 2).join("; ")}`, "code_completion", "medium", `Source example: ${evidence.slice(0, 2).join("; ")}`],
    [`Create a difficult integrated programming problem combining ${concepts.slice(0, 2).join(" and ") || topic} with the related concept shown in the uploaded material. Require a complete solution, test cases, output, and marking-oriented explanation.`, "integrated_coding", "hard", `Integrated source evidence: ${evidence.slice(0, 3).join("; ")}`]
  ];
  return templates.slice(0, Math.max(1, Math.min(count, templates.length))).map(([text, type, difficulty, evidenceText], index) => ({
    id: `practice-${Date.now()}-${index}`,
    text, type, difficulty, topic, source: "AI practice set",
    sourceEvidence: evidenceText,
    answer: `Answer outline: Start with the relevant definition from the PPT, explain each mechanism or step in order, include the named example/diagram/comparison, state assumptions or limitations, and finish with the conclusion. Verify every technical detail against the uploaded source.`
  }));
}

async function generateWithAI(prompt, fallback) {
  if (!process.env.OPENAI_API_KEY) return fallback;
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Use only the supplied study material. If evidence is missing, say so. This is an exam practice generator: at least 80 percent of questions must be code writing, output prediction, debugging, code completion, algorithm tracing, numerical calculation, implementation, edge-case analysis, or concrete input/output problem solving. Avoid definition-only and vague theory questions. Use the exact language and APIs from the source. Return valid JSON only." },
        { role: "user", content: prompt }
      ]
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error("AI request failed; using local fallback:", error.message);
    return fallback;
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/dashboard", async (_req, res) => {
  const db = await readDb();
  const important = db.topics.filter(topic => topic.importance >= 3);
  res.json({
    files: db.files, topics: db.topics, questions: db.questions, flashcards: db.flashcards,
    subjects: [...new Set(db.files.map(file => file.subject).filter(Boolean))],
    stats: { files: db.files.length, topics: db.topics.length, questions: db.questions.length, important: important.length, sessions: db.sessions.length }
  });
});

app.post("/api/upload", upload.array("files", 10), async (req, res) => {
  const db = await readDb();
  const uploaded = [];
  const subject = cleanText(req.body.subject || "General Subject");
  for (const file of req.files || []) {
    try {
      const text = await extractText(file);
      const topics = inferTopics(text, file.originalname);
      const classification = classifyDocument(file.originalname, text);
      const record = { id: `file-${Date.now()}-${uploaded.length}`, name: file.originalname, subject, type: path.extname(file.originalname), size: file.size, topics, ...classification, text: text.slice(0, 120000), uploadedAt: new Date().toISOString() };
      db.files.push(record);
      topics.forEach(name => {
        const existing = db.topics.find(topic => topic.subject === subject && topic.name.toLowerCase() === name.toLowerCase());
        if (existing) { existing.sources += 1; existing.importance = Math.min(5, existing.importance + (classification.documentType === "pyq" ? 1 : 0)); }
        else db.topics.push({ id: `topic-${Date.now()}-${db.topics.length}`, subject, name, sources: 1, importance: classification.documentType === "pyq" ? 3 : 2, completed: false });
      });
      if (classification.documentType === "pyq") {
        for (const question of extractQuestions(text, file.originalname)) {
          const existing = db.questions.find(item => item.key === question.key && item.source === "uploaded PYQ");
          if (existing) { existing.occurrences = (existing.occurrences || 1) + 1; existing.sourceFile = `${existing.sourceFile}, ${file.originalname}`; }
          else db.questions.push(question);
        }
      }
      uploaded.push({ name: file.originalname, subject, extractedCharacters: text.length, topics, ...classification });
    } finally { await fs.unlink(file.path).catch(() => {}); }
  }
  await writeDb(db);
  res.json({ uploaded });
});

app.post("/api/topics/:id/practice", async (req, res) => {
  const db = await readDb();
  const topic = db.topics.find(item => item.id === req.params.id);
  if (!topic) return res.status(404).json({ error: "Topic not found" });
  const topicFiles = db.files.filter(file => (file.topics || []).includes(topic.name));
  const sourceText = (topicFiles.length ? topicFiles : db.files).map(file => file.text).join(" ").slice(0, 24000);
  const relatedPyqs = db.questions.filter(question => question.source === "uploaded PYQ" && (question.topics || []).includes(topic.name)).map(question => question.text).join("\n").slice(0, 8000);
  const fallback = { questions: makePracticeSet(topic.name, Number(req.body.count) || 8, sourceText) };
  const aiResult = await generateWithAI(`Create an exam-quality practice set for the topic "${topic.name}" using only the supplied lecture material. Do not write generic filler such as "explain the topic". Each question must reference a concrete concept, mechanism, algorithm, diagram, formula, comparison, example, or condition found in the source. Produce a balanced set of short-answer, 10-mark long-answer, comparison, application, diagram/algorithm, numerical where possible, and integrated questions. Include a concise marking-oriented answer outline and sourceEvidence for each question. Never claim that a concept appears in the source unless the context supports it. Return JSON in the shape {"questions":[{"text":"...","type":"...","difficulty":"easy|medium|hard","answer":"...","sourceEvidence":"..."}]}.\n\nTopic: ${topic.name}\n\nLecture material:\n${sourceText}\n\nRelated PYQs:\n${relatedPyqs || "No PYQ was uploaded for this topic."}`, fallback);
  const questions = (aiResult.questions || fallback.questions).map((question, index) => ({ ...question, id: `practice-${Date.now()}-${index}`, topic: topic.name, subject: topic.subject, source: "AI practice set" }));
  db.questions.push(...questions);
  await writeDb(db);
  res.json({ topic, questions });
});

app.post("/api/topics/:id/flashcards", async (req, res) => {
  const db = await readDb();
  const topic = db.topics.find(item => item.id === req.params.id);
  if (!topic) return res.status(404).json({ error: "Topic not found" });
  const source = db.files.filter(file => file.subject === topic.subject && (file.topics || []).includes(topic.name)).map(file => file.text).join(" ").slice(0, 18000);
  const fallback = { cards: [
    { front: `What is ${topic.name}?`, back: `Review the definition and purpose of ${topic.name} in the uploaded material.` },
    { front: `List two important points about ${topic.name}.`, back: `Use the original notes and cite the relevant page when revising.` },
    { front: `What kind of question can be asked from ${topic.name}?`, back: `Prepare a definition, explanation, comparison, and application question.` }
  ]};
  const result = await generateWithAI(`Create 5 concise flashcards for the topic ${topic.name}. Source material: ${source}`, fallback);
  const cards = (result.cards || []).map((card, index) => ({ ...card, id: `card-${Date.now()}-${index}`, topic: topic.name, subject: topic.subject }));
  db.flashcards.push(...cards);
  await writeDb(db);
  res.json({ cards });
});

app.post("/api/sessions", async (req, res) => {
  const db = await readDb();
  const session = { id: `session-${Date.now()}`, topic: req.body.topic || "General study", minutes: Number(req.body.minutes) || 25, createdAt: new Date().toISOString() };
  db.sessions.push(session); await writeDb(db); res.json(session);
});

app.post("/api/deadlines", async (req, res) => {
  const db = await readDb();
  const deadline = { id: `deadline-${Date.now()}`, title: req.body.title, date: req.body.date, createdAt: new Date().toISOString() };
  db.deadlines.push(deadline); await writeDb(db); res.json(deadline);
});

app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || "Request failed" }));
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`PrepPilot running at http://localhost:${port} (${process.env.OPENAI_API_KEY ? "AI mode" : "source-grounded fallback mode"})`));
