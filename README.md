# PrepPilot MVP

PrepPilot is a full-stack starter for turning university notes, PDFs, PPTs, and PYQs into an organized revision workspace.

## Run it

```bash
cd prepPilot
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:3000.

The app works without an AI key. In that mode it uses deterministic local topic detection and practice-question templates. Add `OPENAI_API_KEY` to `.env` to enable AI flashcard generation. Keep the key on the server; never place it in `public/app.js`.

If you want to clear previously uploaded demo data, stop the server and run `Remove-Item data/preppilot.json` in PowerShell, then start the server again.

Practice questions are generated from the extracted source text and related PYQs. For deeper exam-style question writing, add an AI key in `.env`; the server prompt requires concrete concepts, algorithms, diagrams, formulas, comparisons, and marking-oriented answer outlines instead of generic filler. Practice cards include Reveal answer. Flashcards are single-card, flip-to-answer cards with previous and next arrows.

## What is implemented

- PDF, PPTX, TXT, and Markdown upload
- PDF text extraction and basic PPTX slide-text extraction
- Topic detection with source-file tracking
- PYQ detection from filenames and question extraction
- Important-topic stars based on source/PYQ evidence
- Practice-set generation for every detected topic
- AI flashcard endpoint with a safe local fallback
- Pomodoro session logging
- Deadline storage
- Persistent JSON storage in `data/preppilot.json`
- Responsive dashboard UI

## Next production steps

1. Replace JSON storage with PostgreSQL.
2. Add OCR for scanned PDFs.
3. Add embeddings and RAG retrieval instead of sending whole documents to a model.
4. Add user authentication and per-user data ownership.
5. Add a review queue for low-confidence topic mappings.
6. Add question-answer evaluation and progress analytics.

## Final MVP additions

- Upload material under a named subject.
- Practice is grouped as Subject -> Topic.
- PYQs are classified using filename and question-paper structure cues; duplicate questions receive a stable key and occurrence count.
- Practice generation prioritizes code writing, output prediction, debugging, tracing, implementation, numerical work, and edge cases.
- The Pomodoro timer stays in the header with pause/resume and close controls.

## Clear Windows run steps

1. Extract the ZIP and open PowerShell in the extracted folder:

```powershell
cd C:\Users\shrij\Downloads\prepPilot-final
```

2. Install dependencies once:

```powershell
npm install
```

3. Create and open the environment file:

```powershell
Copy-Item .env.example .env
notepad .env
```

Put your real API key in `.env`:

```env
OPENAI_API_KEY=sk-proj-your_actual_key_here
OPENAI_MODEL=gpt-4o-mini
PORT=3000
```

Replace the placeholder with the key created at https://platform.openai.com/api-keys. Never share the key or place it in `public/app.js`.

4. Start the app:

```powershell
npm run dev
```

5. Open `http://localhost:3000`. Enter a subject name in **My Material**, upload a PDF or PPTX, open **Practice**, select the subject and topic, and click **Generate set**.

## Troubleshooting

If port 3000 is already being used:

```powershell
$processId = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($processId) { Stop-Process -Id $processId -Force }
npm run dev
```

If old topics remain, stop the server and reset only the generated local database:

```powershell
Remove-Item .\data\preppilot.json -ErrorAction SilentlyContinue
npm run dev
```

If the browser says `Failed to fetch`, make sure the PowerShell server is running and that you opened `http://localhost:3000`, not `index.html` directly. You do not need to run `npm install` again unless `package.json` changes.
