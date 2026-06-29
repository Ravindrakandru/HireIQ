# HireIQ — AI Interview Platform

AI-powered end-to-end interview platform. Upload JD + Resume → red flag analysis → auto-generated questions → live interview room with real-time AI feedback → final report to HM/Recruiter.

---

## Architecture

```
Browser (Single Page App)
  └── public/index.html  ← Complete frontend (5 modules)

Node.js + Express Backend
  └── server.js          ← API + Claude integration

Claude AI (Anthropic)
  ├── Resume × JD analysis (red flags, match score)
  ├── Question generation (by experience level)
  ├── Per-answer feedback (transcript evaluation)
  ├── Code evaluation (coding exercises)
  └── Final report generation
```

---

## 5 Modules

| Step | What happens |
|---|---|
| **1. Intake** | Upload JD (paste or file) + Resume (PDF/DOCX) |
| **2. Analysis** | Claude produces red flag report + match score |
| **3. Questions** | Auto-generated questions by experience level |
| **4. Interview Room** | Live transcript entry, per-Q AI feedback, code editor |
| **5. Report** | Final hire/no-hire recommendation with full breakdown |

---

## Question Mix by Experience Level

| Level | Technical | Scenario | Architecture | Behavioural | Coding |
|---|---|---|---|---|---|
| 0–2 yrs | 3 | 0 | 0 | 3 | 2 |
| 3–5 yrs | 3 | 2 | 0 | 2 | 1 |
| 6–10 yrs | 3 | 3 | 2 | 2 | 0 |
| 10+ yrs | 2 | 3 | 3 | 3 | 0 |

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY
```

### 3. Run
```bash
npm run dev    # development
npm start      # production
```

Open http://localhost:3001

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/intake` | Upload JD + Resume, create session |
| POST | `/api/analyze` | Run Claude red flag analysis |
| POST | `/api/questions` | Generate questions by experience |
| POST | `/api/evaluate-answer` | Evaluate transcript answer |
| POST | `/api/evaluate-code` | Evaluate code submission |
| POST | `/api/report` | Generate final hiring report |
| GET | `/api/session/:id` | Get session data |

---

## File Support
- PDF, DOCX, DOC, TXT for both JD and Resume

---

## Production Notes
- Replace in-memory session store with PostgreSQL/Redis
- Add authentication (Auth0/Supabase)
- Add email delivery of reports (SendGrid)
- Add WebRTC for live audio/video (Daily.co)
- Add AssemblyAI for real-time speech-to-text
- Add Salesforce sync for candidate records
