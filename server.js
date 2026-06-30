const path = require('path');
const fs = require('fs');

// ─── Keys ────────────────────────────────────────────────────────────────────
// Local dev: hardcoded below
// Production (Render/Railway): set in dashboard — these if(!x) lines won't override them
// GROQ_API_KEY — set in Render dashboard environment variables
if (!process.env.GROQ_MODEL)         process.env.GROQ_MODEL         = 'llama-3.3-70b-versatile';
if (!process.env.PORT)               process.env.PORT               = '3001';
// ASSEMBLYAI_API_KEY — set in Render dashboard environment variables
// FRONTEND_URL: set this to your Render/Railway URL in the dashboard
// Locally it defaults to localhost
if (!process.env.FRONTEND_URL)       process.env.FRONTEND_URL       = 'http://localhost:3001';

const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const { randomUUID: uuidv4 } = require('crypto');
const axios    = require('axios');
const { spawn, exec } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Cloudflare Tunnel Manager ────────────────────────────────────────────────
let publicUrl = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
let cloudflareProcess = null;

async function startCloudflareTunnel() {
  return new Promise((resolve) => {
    console.log('[Cloudflare] Starting tunnel...');

    // Check if cloudflared is installed
    exec('cloudflared --version', (err) => {
      if (err) {
        console.log('[Cloudflare] cloudflared not found. Install it:');
        console.log('  winget install cloudflare.cloudflared');
        console.log('[Cloudflare] Running on localhost only for now.');
        resolve(null);
        return;
      }

      cloudflareProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let resolved = false;

      const handleOutput = (data) => {
        const output = data.toString();
        // Extract the trycloudflare.com URL
        const match = output.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
        if (match && !resolved) {
          resolved = true;
          publicUrl = match[0];
          process.env.FRONTEND_URL = publicUrl;
          console.log('');
          console.log('╔══════════════════════════════════════════════════════════════╗');
          console.log('║           🌐 CLOUDFLARE TUNNEL ACTIVE                       ║');
          console.log(`║   Public URL: ${publicUrl.padEnd(47)}║`);
          console.log('║   Share this URL with candidates!                           ║');
          console.log('╚══════════════════════════════════════════════════════════════╝');
          console.log('');
          resolve(publicUrl);
        }
      };

      cloudflareProcess.stdout.on('data', handleOutput);
      cloudflareProcess.stderr.on('data', handleOutput);

      cloudflareProcess.on('close', (code) => {
        console.log('[Cloudflare] Tunnel closed with code:', code);
        if (!resolved) resolve(null);
      });

      // Timeout after 15 seconds
      setTimeout(() => {
        if (!resolved) {
          console.log('[Cloudflare] Timeout — running on localhost only');
          resolve(null);
        }
      }, 15000);
    });
  });
}

// Cleanup on exit
process.on('SIGINT', () => {
  if (cloudflareProcess) cloudflareProcess.kill();
  process.exit();
});
process.on('SIGTERM', () => {
  if (cloudflareProcess) cloudflareProcess.kill();
  process.exit();
});

// ─── AI Provider Layer ────────────────────────────────────────────────────────
// Priority: Groq (free) → Gemini (free) → Ollama (local) → Claude (paid)
const PROVIDERS = {
  groq: {
    name: 'Groq — Llama 3.1 (Free)',
    available: () => !!process.env.GROQ_API_KEY,
    call: async (sys, user, maxTokens) => {
      const GROQ_MODELS = [
        process.env.GROQ_MODEL,
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'mixtral-8x7b-32768',
        'gemma2-9b-it',
      ].filter(Boolean);
      let res, lastErr;
      for (const model of GROQ_MODELS) {
        try {
          res = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            { model, max_tokens: maxTokens, temperature: 0, seed: 42, messages: [{ role:'system', content:sys },{ role:'user', content:user }] },
            { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
          );
          console.log(`[Groq] Model used: ${model}`);
          break;
        } catch(e) {
          const code = e.response?.data?.error?.code;
          if (code === 'model_decommissioned' || code === 'model_not_found') {
            console.warn(`[Groq] Model ${model} unavailable, trying next...`);
            lastErr = e; continue;
          }
          throw e;
        }
      }
      if (!res) throw lastErr || new Error('All Groq models failed');
      return res.data.choices[0].message.content;
    }
  },

  gemini: {
    name: 'Google Gemini (Free)',
    available: () => !!process.env.GEMINI_API_KEY,
    call: async (sys, user, maxTokens) => {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: sys + '\n\n' + user }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0 }
        }
      );
      return res.data.candidates[0].content.parts[0].text;
    }
  },

  ollama: {
    name: 'Ollama (Local — Free)',
    available: () => !!process.env.OLLAMA_MODEL,
    call: async (sys, user) => {
      const res = await axios.post(
        `${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`,
        {
          model: process.env.OLLAMA_MODEL || 'llama3.1',
          stream: false,
          messages: [
            { role: 'system', content: sys },
            { role: 'user',   content: user }
          ]
        }
      );
      return res.data.message.content;
    }
  },

  claude: {
    name: 'Claude — Anthropic (Paid)',
    available: () => !!process.env.ANTHROPIC_API_KEY,
    call: async (sys, user, maxTokens) => {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: sys,
        messages: [{ role: 'user', content: user }]
      });
      return msg.content[0].text;
    }
  }
};

function getProvider() {
  for (const name of ['groq', 'gemini', 'ollama', 'claude']) {
    if (PROVIDERS[name].available()) return PROVIDERS[name];
  }
  throw new Error('No AI provider configured. Set GROQ_API_KEY on line 5 of server.js');
}

async function callAI(sys, user, maxTokens = 2000) {
  const provider = getProvider();
  console.log(`[AI] Using: ${provider.name}`);
  try {
    const raw = await provider.call(sys, user, maxTokens);
    return raw.replace(/```json|```/g, '').trim();
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[AI Error]', JSON.stringify(detail, null, 2));
    throw new Error(JSON.stringify(detail));
  }
}

// Startup log
const active = ['groq','gemini','ollama','claude'].filter(p => PROVIDERS[p].available());
console.log('\n[AI] Provider:', active.length ? PROVIDERS[active[0]].name : 'NONE — set key on line 5');
console.log('');

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.docx', '.doc', '.txt'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  }
});

const sessions = new Map();

// ─── Analysis cache — same JD+Resume always returns same result ───────────────
const analysisCache  = new Map();
const questionsCache = new Map();

function makeCacheKey(jd, resume, extra = '') {
  // Simple hash based on content length + first/last 100 chars
  const jdSig     = jd.length + jd.substring(0, 100) + jd.slice(-100);
  const resumeSig = resume.length + resume.substring(0, 100) + resume.slice(-100);
  return Buffer.from(jdSig + resumeSig + extra).toString('base64').slice(0, 64);
}

// ─── File text extractor ─────────────────────────────────────────────────────
async function extractText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const buf = fs.readFileSync(filePath);
  if (ext === '.pdf') {
    const d = await pdfParse(buf); return d.text;
  } else if (ext === '.docx' || ext === '.doc') {
    const r = await mammoth.extractRawText({ buffer: buf }); return r.value;
  }
  return buf.toString('utf-8');
}

// ─── Route: Intake ────────────────────────────────────────────────────────────
app.post('/api/intake', upload.fields([
  { name: 'resume', maxCount: 1 },
  { name: 'jd_file', maxCount: 1 }
]), async (req, res) => {
  try {
    const { jd_text, experience_level, interview_type, candidate_name, role_title, role_category } = req.body;
    let jdContent = jd_text || '';
    let resumeContent = '';

    if (req.files?.jd_file?.[0]) {
      const f = req.files.jd_file[0];
      jdContent = await extractText(f.path, f.originalname);
      fs.unlinkSync(f.path);
    }
    if (req.files?.resume?.[0]) {
      const f = req.files.resume[0];
      resumeContent = await extractText(f.path, f.originalname);
      fs.unlinkSync(f.path);
    }

    if (!jdContent || !resumeContent)
      return res.status(400).json({ error: 'Both JD and Resume are required.' });

    const sessionId = uuidv4();
    sessions.set(sessionId, {
      jd: jdContent, resume: resumeContent,
      experience_level, interview_type, candidate_name, role_title,
      created_at: new Date().toISOString()
    });

    res.json({ success: true, sessionId });
  } catch (err) {
    console.error('[Intake]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Analyze red flags ─────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const session = sessions.get(req.body.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  try {
    const prompt = `Analyze this Job Description and Candidate Resume. Identify red flags.

JOB DESCRIPTION:
${session.jd}

CANDIDATE RESUME:
${session.resume}

Return ONLY valid JSON with this structure:
{
  "candidate_summary": "2-3 sentence summary",
  "role_summary": "1-2 sentence summary of what the role needs",
  "match_score": 72,
  "red_flags": [
    {
      "type": "skill_gap|tenure|title_inflation|domain_mismatch|employment_gap|keyword_stuffing|other",
      "severity": "high|medium|low",
      "title": "Short title",
      "detail": "Specific detail",
      "probe_question": "Question to ask in interview"
    }
  ],
  "strengths": [
    { "title": "Strength title", "detail": "Why this is positive" }
  ],
  "recommended_focus_areas": ["area1", "area2", "area3"]
}`;

    const cacheKey = makeCacheKey(session.jd, session.resume);
    if (analysisCache.has(cacheKey)) {
      console.log('[Analyze] Cache hit');
      session.analysis = analysisCache.get(cacheKey);
      return res.json({ success: true, analysis: session.analysis, cached: true });
    }
    const sys = 'You are a senior technical recruiter. Return ONLY valid JSON, no markdown, no extra text.';
    const raw = await callAI(sys, prompt, 2000);
    const analysis = JSON.parse(raw);
    analysisCache.set(cacheKey, analysis);
    session.analysis = analysis;
    res.json({ success: true, analysis });
  } catch (err) {
    console.error('[Analyze]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Generate questions ────────────────────────────────────────────────
app.post('/api/questions', async (req, res) => {
  const session = sessions.get(req.body.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  try {
    const expLevel  = session.experience_level || '3-5';
    const roleTitle = (session.role_title || '').toLowerCase();
    const analysis  = session.analysis || {};

    // ── Detect role category from job title ───────────────────────────────────
    const isPMO = /pmo|project manager|programme manager|delivery manager|scrum master|agile coach/i.test(roleTitle);
    const isHR  = /\bhr\b|human resource|talent acquisition|recruiter|people ops|hrbp/i.test(roleTitle);
    const isMgr = /\bmanager\b|\bdirector\b|\bvp\b|vice president|head of|\bcxo\b|\bceo\b|\bcto\b|\bcoo\b|\bcfo\b/i.test(roleTitle);
    const isBA  = /business analyst|product owner|product manager|\bba\b|functional consultant/i.test(roleTitle);
    const isQA  = /\bqa\b|quality assurance|tester|test engineer|sdet/i.test(roleTitle);

    // Role-type question matrix (technical, scenario, architecture, behavioural, coding)
    const roleMatrix = {
      pmo:       { technical: 1, scenario: 4, architecture: 0, behavioural: 4, coding: 0, note: 'PMO/Delivery — project delivery, stakeholder management, risk, governance. NO coding, NO architecture.' },
      hr:        { technical: 0, scenario: 3, architecture: 0, behavioural: 5, coding: 0, note: 'HR/Talent — people management, hiring, culture, conflict resolution. NO technical, NO coding.' },
      manager:   { technical: 2, scenario: 3, architecture: 1, behavioural: 3, coding: 0, note: 'Management — leadership, strategy, team building. NO coding. Architecture = strategic/org thinking only.' },
      ba:        { technical: 2, scenario: 4, architecture: 1, behavioural: 2, coding: 0, note: 'Business Analyst — requirements, process, stakeholder comms. NO coding.' },
      qa:        { technical: 3, scenario: 2, architecture: 1, behavioural: 2, coding: 1, note: 'QA Engineer — coding = test automation scripts only, NOT algorithms.' },
      developer: { technical: 3, scenario: 2, architecture: 1, behavioural: 2, coding: 2, note: 'Developer — coding is mandatory. Architecture scales with seniority.' },
    };

    // Use explicit role_category from form if provided, else auto-detect from title
    let roleType = session.role_category || 'auto';
    if (roleType === 'auto' || roleType === 'developer') {
      // Auto-detect from title
      if (isPMO)      roleType = 'pmo';
      else if (isHR)  roleType = 'hr';
      else if (isMgr) roleType = 'manager';
      else if (isBA)  roleType = 'ba';
      else if (isQA)  roleType = 'qa';
      else            roleType = 'developer';
    }
    // architect maps to developer matrix but with max architecture
    if (roleType === 'architect') {
      roleMatrix.architect = { technical: 3, scenario: 3, architecture: 4, behavioural: 2, coding: 0, note: 'Architect — deep architecture, system design, no coding exercises.' };
    }

    // Experience level labels and modifiers (only applied to dev/QA roles)
    const expLabels = {
      '0-2': 'Junior (0-2 yrs)', '3-5': 'Mid-level (3-5 yrs)',
      '6-10': 'Senior (6-10 yrs)', '10+': 'Principal/Lead (10+ yrs)'
    };
    const expArchBonus   = { '0-2': 0, '3-5': 0, '6-10': 1, '10+': 2 };
    const expCodingBonus = { '0-2': 1, '3-5': 0, '6-10': -1, '10+': -2 };

    const base = { ...roleMatrix[roleType] };
    if (roleType === 'developer' || roleType === 'qa') {
      base.architecture = Math.max(0, base.architecture + (expArchBonus[expLevel] || 0));
      base.coding       = Math.max(0, base.coding + (expCodingBonus[expLevel] || 0));
    }
    const expLabel = expLabels[expLevel] || expLabels['3-5'];
    const config   = { ...base, label: expLabel, roleType };

    const prompt = `Generate interview questions for a ${config.label} ${roleType.toUpperCase()} role.

Role Title: ${session.role_title || 'Not specified'}
Role Category: ${roleType} — ${base.note}
Red flags to probe: ${(analysis.red_flags || []).map(f => f.title).join(', ') || 'None'}
Focus areas: ${(analysis.recommended_focus_areas || []).join(', ') || 'General'}

JD summary: ${session.jd?.substring(0, 1000)}
Resume summary: ${session.resume?.substring(0, 1000)}

Generate EXACTLY this many questions per section:
- Technical: ${config.technical}
- Scenario-based: ${config.scenario}
- Architecture/Thought Process: ${config.architecture}
- Behavioural: ${config.behavioural}
- Coding Exercise: ${config.coding}

STRICT ROLE RULES — follow these absolutely:
- PMO / Project Manager / Delivery Manager: ZERO coding, ZERO architecture. Questions must be about project delivery, risk management, stakeholder communication, governance, timelines, and change management.
- HR / Talent / Recruiter: ZERO coding, ZERO technical, ZERO architecture. Pure behavioural and situational questions about people management, culture, and hiring.
- Manager / Director / VP: ZERO coding. Architecture = strategic thinking and org design only, NOT system design.
- Business Analyst / Product Owner: ZERO coding. Technical = domain/process/requirements knowledge only.
- QA Engineer: Coding = test automation (Selenium, Postman, Cypress, pytest) NOT algorithms.
- Developer / Engineer / Architect: Coding is mandatory. Architecture scales with experience level.

Return ONLY valid JSON, no markdown:
{
  "experience_label": "${config.label}",
  "role_type": "${roleType}",
  "sections": [
    {
      "type": "technical|scenario|architecture|behavioural|coding",
      "label": "Section Label",
      "questions": [
        {
          "id": "q1",
          "question": "Question text",
          "intent": "What this tests",
          "expected_answer_depth": "What a good answer covers",
          "follow_up": "Follow-up probe",
          "scoring_guide": "1=poor 3=average 5=excellent",
          "time_minutes": 5,
          "is_coding": false,
          "coding_language_hint": null,
          "starter_code": null
        }
      ]
    }
  ]
}

For coding questions: set is_coding=true, add starter_code skeleton, set coding_language_hint.
Skip sections with count 0 entirely.`;

    const qCacheKey = makeCacheKey(session.jd, session.resume, expLevel + (session.role_title || ''));
    if (questionsCache.has(qCacheKey)) {
      console.log('[Questions] Cache hit');
      session.questions = questionsCache.get(qCacheKey);
      return res.json({ success: true, questions: session.questions, cached: true });
    }
    const sys = 'You are a senior technical interviewer. Return ONLY valid JSON, no markdown, no extra text.';
    const raw = await callAI(sys, prompt, 4000);
    const questions = JSON.parse(raw);
    questionsCache.set(qCacheKey, questions);
    session.questions = questions;
    res.json({ success: true, questions });
  } catch (err) {
    console.error('[Questions]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Evaluate answer ───────────────────────────────────────────────────
app.post('/api/evaluate-answer', async (req, res) => {
  const { sessionId, questionId, question, intent, expected, transcript, score } = req.body;
  try {
    const prompt = `Evaluate this candidate answer.

QUESTION: ${question}
TESTS: ${intent}
EXPECTED: ${expected}
INTERVIEWER SCORE: ${score}/5
ANSWER: "${transcript}"

Return ONLY valid JSON:
{
  "verdict": "strong|adequate|weak|off_topic",
  "score_ai": 4,
  "summary": "2-3 sentence assessment",
  "positives": ["what they got right"],
  "gaps": ["what was missing"],
  "red_flags_surfaced": ["concerns raised"],
  "follow_up_needed": true,
  "suggested_follow_up": "follow-up question if needed"
}`;

    const sys = 'You are an expert technical interviewer. Return ONLY valid JSON, no markdown.';
    const raw = await callAI(sys, prompt, 800);
    const feedback = JSON.parse(raw);

    const session = sessions.get(sessionId);
    if (session) {
      if (!session.answers) session.answers = {};
      session.answers[questionId] = { transcript, score, feedback };
    }
    res.json({ success: true, feedback });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Evaluate code ─────────────────────────────────────────────────────
app.post('/api/evaluate-code', async (req, res) => {
  const { sessionId, questionId, question, code, language } = req.body;
  try {
    const apexNote = language?.toLowerCase().includes('apex') ?
      'This is Salesforce Apex code. Evaluate it for: proper governor limit awareness, bulkification patterns, SOQL inside loops (antipattern), trigger best practices, null checks, and Salesforce-specific best practices.' :
      '';

    const prompt = `Evaluate this coding submission.

PROBLEM: ${question}

CODE (${language}):
${code}

${apexNote}

Return ONLY valid JSON:
{
  "verdict": "excellent|good|average|poor",
  "overall_score": 4,
  "correctness":  { "score": 4, "comment": "correctness analysis" },
  "efficiency":   { "score": 3, "comment": "time/space complexity" },
  "code_quality": { "score": 4, "comment": "readability and structure" },
  "edge_cases":   { "score": 2, "comment": "edge cases handled/missed" },
  "summary": "2-3 sentence overall assessment",
  "what_was_good": ["positives"],
  "improvements": ["improvements needed"],
  "sample_better_approach": "describe optimal approach without writing full code"
}`;

    const sys = 'You are a senior software engineer. Return ONLY valid JSON, no markdown.';
    const raw = await callAI(sys, prompt, 1200);
    const feedback = JSON.parse(raw);

    const session = sessions.get(sessionId);
    if (session) {
      if (!session.answers) session.answers = {};
      session.answers[questionId] = { code, language, feedback };
    }
    res.json({ success: true, feedback });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Final report ──────────────────────────────────────────────────────
app.post('/api/report', async (req, res) => {
  const session = sessions.get(req.body.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  try {
    const answersText = Object.entries(session.answers || {}).map(([qId, ans]) => {
      const q = findQuestion(session.questions, qId);
      return `Q: ${q?.question || qId}
Answer: ${ans.transcript || ans.code || 'N/A'}
Score: ${ans.score || ans.feedback?.overall_score || 'N/A'}/5
Feedback: ${ans.feedback?.summary || ''}`;
    }).join('\n\n---\n\n');

    const prompt = `Generate a post-interview hiring report.

CANDIDATE: ${session.candidate_name || 'Candidate'}
ROLE: ${session.role_title || 'Role'}
EXPERIENCE: ${session.experience_level} years
RED FLAGS: ${(session.analysis?.red_flags || []).map(f => `${f.title}: ${f.detail}`).join('; ') || 'None'}

INTERVIEW ANSWERS:
${answersText || 'No answers recorded'}

Return ONLY valid JSON:
{
  "overall_score": 72,
  "recommendation": "strong_hire|hire|hold|no_hire",
  "recommendation_reasoning": "2-3 sentence justification",
  "executive_summary": "3-4 sentence summary for hiring manager",
  "section_scores": {
    "technical":    { "score": 4, "comment": "assessment" },
    "scenario":     { "score": 3, "comment": "assessment" },
    "architecture": { "score": 0, "comment": "not assessed" },
    "behavioural":  { "score": 4, "comment": "assessment" },
    "coding":       { "score": 3, "comment": "assessment" }
  },
  "red_flags_confirmed": ["confirmed red flags"],
  "red_flags_cleared":   ["cleared red flags"],
  "standout_moments":    ["strong answers"],
  "concerns":            ["remaining concerns"],
  "suggested_next_step": "Make offer|Second round|Take-home|Reject",
  "suggested_package_note": "offer/negotiation notes",
  "questions_for_next_round": ["probes for next round"]
}`;

    const sys = 'You are a hiring expert. Return ONLY valid JSON, no markdown, no extra text.';
    const raw = await callAI(sys, prompt, 2500);
    const report = JSON.parse(raw);
    session.report = report;
    res.json({ success: true, report, candidate_name: session.candidate_name, role_title: session.role_title });
  } catch (err) {
    console.error('[Report]', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── Route: Regenerate / generate single question ─────────────────────────────
app.post('/api/regenerate-question', async (req, res) => {
  const { sessionId, sectionType, experienceLevel, roleTitle, existingQuestion, context } = req.body;
  const session = sessions.get(sessionId);

  const sectionLabels = {
    technical: 'Technical', scenario: 'Scenario Based',
    architecture: 'Architecture & Thought Process',
    behavioural: 'Behavioural', coding: 'Coding Exercise'
  };

  const expMap = {
    '0-2': 'Junior (0-2 years)',
    '3-5': 'Mid-level (3-5 years)',
    '6-10': 'Senior (6-10 years)',
    '10+': 'Principal/Lead (10+ years)'
  };

  try {
    const prompt = `Generate ONE interview question of type: ${sectionLabels[sectionType] || sectionType}

Role: ${roleTitle || 'Software Developer'}
Experience level: ${expMap[experienceLevel] || experienceLevel}
Focus areas: ${context || 'general'}
${existingQuestion ? `This replaces the existing question: "${existingQuestion}" — make it different and better.` : 'This is an additional question for the panel.'}
${sectionType === 'coding' ? 'For coding: provide a clear problem statement, starter code skeleton, and set is_coding=true.' : ''}

Return ONLY a single valid JSON object (not an array):
{
  "question": "The full question text",
  "intent": "What this question tests",
  "expected_answer_depth": "What a good answer covers",
  "follow_up": "A follow-up probe question",
  "scoring_guide": "1=poor 3=average 5=excellent",
  "time_minutes": 5,
  "is_coding": false,
  "coding_language_hint": null,
  "starter_code": null
}`;

    const sys = 'You are a senior technical interviewer. Return ONLY a single valid JSON object, no array, no markdown.';
    const raw = await callAI(sys, prompt, 800);

    // Handle both object and array responses
    let parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) parsed = parsed[0];

    res.json({ success: true, question: parsed });
  } catch (err) {
    console.error('[Regenerate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Public URL (for candidate link generation) ───────────────────────
app.get('/api/public-url', (req, res) => {
  const url = process.env.FRONTEND_URL || publicUrl;
  const isPublic = !url.includes('localhost') && !url.includes('127.0.0.1');
  res.json({ url, isPublic });
});

// ─── Route: Provider status ───────────────────────────────────────────────────
app.get('/api/provider-status', (req, res) => {
  const list = ['groq','gemini','ollama','claude'].map(n => ({
    name: n, label: PROVIDERS[n].name, active: PROVIDERS[n].available()
  }));
  const current = list.find(p => p.active);
  res.json({ providers: list, active: current?.name || null, label: current?.label || 'None configured' });
});

// ─── Route: Get session ───────────────────────────────────────────────────────
app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true, session });
});

// ─── Route: Push question to candidate ───────────────────────────────────────
app.post('/api/session/:id/push-question', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const { question, question_index, total_questions } = req.body;
  session.current_question = question;
  session.question_index   = question_index;
  session.total_questions  = total_questions;
  res.json({ success: true });
});

// ─── Route: Create Jitsi video room (100% free, no API key needed) ────────────
app.post('/api/room/create', async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  // Generate a unique room name
  const roomName = `HireIQ-${sessionId.slice(0, 12)}-${Date.now().toString(36)}`;
  const jitsiUrl = `https://meet.jit.si/${roomName}`;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

  const room = {
    name: roomName,
    url: jitsiUrl,
    interviewer_token: null,
    candidate_link: `${frontendUrl}/candidate.html?session=${sessionId}&room=${encodeURIComponent(roomName)}&roomUrl=${encodeURIComponent(jitsiUrl)}`,
    provider: 'jitsi',
  };

  session.room = room;
  console.log(`[Room] Jitsi room created: ${jitsiUrl}`);
  res.json({ success: true, room, provider: 'jitsi' });
});

// ─── Route: AssemblyAI token ──────────────────────────────────────────────────
app.post('/api/transcription/token', async (req, res) => {
  if (!process.env.ASSEMBLYAI_API_KEY)
    return res.json({ success: true, token: 'demo_token', demo: true });
  try {
    const r = await axios.post(
      'https://api.assemblyai.com/v2/realtime/token',
      { expires_in: 3600 },
      { headers: { authorization: process.env.ASSEMBLYAI_API_KEY } }
    );
    res.json({ success: true, token: r.data.token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Save transcript ───────────────────────────────────────────────────
app.post('/api/transcription/save', (req, res) => {
  const { sessionId, questionId, text, is_final } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!session.transcripts) session.transcripts = {};
  if (!session.transcripts[questionId]) session.transcripts[questionId] = '';
  if (is_final)
    session.transcripts[questionId] += (session.transcripts[questionId] ? ' ' : '') + text;
  res.json({ success: true });
});

// ─── Candidate page ───────────────────────────────────────────────────────────
app.get('/candidate.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'candidate.html'));
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function findQuestion(questionsData, qId) {
  if (!questionsData?.sections) return null;
  for (const section of questionsData.sections) {
    const q = section.questions?.find(q => q.id === qId);
    if (q) return q;
  }
  return null;
}

// ─── Start server + Cloudflare tunnel ────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 HireIQ running at http://localhost:${PORT}`);
  console.log('[AI] Provider:', ['groq','gemini','ollama','claude'].filter(p => PROVIDERS[p].available()).map(p => PROVIDERS[p].name)[0] || 'NONE');
  console.log('');

  // Auto-start Cloudflare tunnel
  await startCloudflareTunnel();
});