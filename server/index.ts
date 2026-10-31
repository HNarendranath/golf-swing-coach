import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CoachingPayload,
  CoachingResponse,
  SwingFault,
  VoiceQAPayload,
  VoiceQAResponse,
} from '../src/types';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');
const SWINGS_DIR = path.join(DATA_DIR, 'swings');
const REFERENCE_PATH = path.join(DATA_DIR, 'reference.json');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

async function ensureDirs(): Promise<void> {
  await fs.mkdir(SWINGS_DIR, { recursive: true });
}

// Rolling session history (last 5 swings)
interface SwingSummaryEntry {
  swing_number: number;
  match_score: number;
  primary_fault: SwingFault | 'none';
  improved: SwingFault[];
  spoken_feedback: string;
}

let sessionHistory: SwingSummaryEntry[] = [];
let latestSwingPayload: CoachingPayload | null = null;

/**
 * Reloads .env dynamically so pasting GEMINI_API_KEY into .env works immediately without restarting.
 */
function getApiKey(): string {
  dotenv.config({ override: true });
  return (process.env.GEMINI_API_KEY || '').trim();
}

const COACH_SYSTEM_PROMPT = `You are a friendly, sharp golf coach giving live spoken feedback between swings.

Rules:
- Output is read aloud by TTS: no markdown, no bullet points, no emojis, and NEVER write unit abbreviations like "deg" or "cm" — write out "degrees" and "centimetres" in full words.
- Max 2 short sentences (around 20 to 28 words total). The golfer is standing with a club, not reading an essay.
- Address ONE fault only: the first fault in "faults_ranked". Give one concrete physical cue or feel.
- If "faults_ranked" is empty, congratulate a dialled-in swing and tell them to repeat that tempo.
- If "improved_since_last" is non-empty, praise that improvement in the first few words before addressing the top fault.
- Only comment on the metrics provided. Never mention grip, clubface, ball flight, or anything not measured.
- Check the recent session history if provided and NEVER repeat the exact same cue wording as the last swing; vary your phrasing.
- Respond ONLY with valid JSON matching: {"spoken": "...", "fault": "...", "drill": "..."}

Target ranges:
- tempo_ratio: around 3 to 1
- head_movement_cm: under 5 centimetres
- hip_sway_cm: under 5 centimetres
- shoulder_turn_deg: 80 to 90 degrees
- hip_turn_deg: 40 to 50 degrees
- x_factor_deg: around 40 degrees
- lead_arm_deg: over 160 degrees (straight lead arm)
- spine_angle_change_deg: under 5 degrees (standing up more than 5 degrees is early extension)
- weight_shift_cm: moves at least 3 centimetres toward the target at impact

Few-shot examples:

Input:
{"swing_number":1,"match_score":64,"metrics":{"tempo_ratio":2.1,"head_movement_cm":9,"hip_sway_cm":6,"shoulder_turn_deg":82,"x_factor_deg":36,"lead_arm_deg":146,"spine_angle_change_deg":3},"faults_ranked":["bent_lead_arm","head_movement","hip_sway","fast_tempo"],"previous_focus":null,"improved_since_last":[]}
Output:
{"spoken":"Your lead arm broke down to one hundred forty six degrees at the top. Push your lead hands wide away from your chest to keep that arm long.","fault":"bent_lead_arm","drill":"Wide Push-Away Backswing Drill"}

Input:
{"swing_number":2,"match_score":74,"metrics":{"tempo_ratio":2.3,"head_movement_cm":8,"hip_sway_cm":3,"shoulder_turn_deg":86,"x_factor_deg":40,"lead_arm_deg":165,"spine_angle_change_deg":4},"faults_ranked":["head_movement","fast_tempo"],"previous_focus":"bent_lead_arm","improved_since_last":["bent_lead_arm","hip_sway"]}
Output:
{"spoken":"Great job keeping that lead arm straight and locking in your hips. Now imagine your head is inside a small picture frame from takeaway through impact.","fault":"head_movement","drill":"Head-in-the-Box Mirror Cue"}

Input:
{"swing_number":3,"match_score":79,"metrics":{"tempo_ratio":1.9,"head_movement_cm":3,"hip_sway_cm":2,"shoulder_turn_deg":88,"x_factor_deg":42,"lead_arm_deg":168,"spine_angle_change_deg":3},"faults_ranked":["fast_tempo"],"previous_focus":"head_movement","improved_since_last":["head_movement"]}
Output:
{"spoken":"Rock solid head position on that one. You rushed the transition at under two to one, so count a smooth one-two-three up to the top before firing down.","fault":"fast_tempo","drill":"3-to-1 Count Tempo Drill"}

Input:
{"swing_number":4,"match_score":91,"metrics":{"tempo_ratio":2.9,"head_movement_cm":3,"hip_sway_cm":2,"shoulder_turn_deg":87,"x_factor_deg":41,"lead_arm_deg":169,"spine_angle_change_deg":2},"faults_ranked":[],"previous_focus":"fast_tempo","improved_since_last":["fast_tempo"]}
Output:
{"spoken":"Pure tempo right at three to one and ninety one percent match score. Hold that exact rhythm and hit another one just like it.","fault":"none","drill":"Rhythm Groove Repeat"}
`;

const QA_SYSTEM_PROMPT = `You are a friendly, knowledgeable golf coach answering a live voice question from a golfer standing on the mat.

Rules:
- Output is read aloud by TTS: no markdown, no bullet points, no emojis, no abbreviations like "deg" or "cm" — say "degrees" and "centimetres".
- Keep your answer to at most 3 short, natural sentences (around 35 to 45 words max).
- Ground your answer directly in the golfer's latest swing metrics and faults provided.
- Give one clear physical feel or drill they can try on their very next swing.
- Only reference metrics that are measured (tempo, head movement, hip sway, shoulder turn, hip turn, X-factor, lead arm angle, spine angle, weight shift).`;

/**
 * Deterministic coaching fallback lines per fault (used if API key is missing, Wi-Fi drops, or timeout > 2.5s).
 */
const FALLBACK_TEMPLATES: Record<
  SwingFault | 'none',
  Array<{ spoken: string; drill: string }>
> = {
  bent_lead_arm: [
    {
      spoken: 'Try to keep your lead arm long and extended at the top, like you are pushing the club wide away from your sternum.',
      drill: 'Wide Arc Push-Away Drill',
    },
    {
      spoken: 'Your lead elbow bent at the top of the backswing. Feel your lead tricep stay connected and reach for width.',
      drill: 'Straight Lead Arm Width Cue',
    },
  ],
  head_movement: [
    {
      spoken: 'Keep your head steady over the ball through impact, as if the crown of your head is resting under a doorframe.',
      drill: 'Steady Crown Doorframe Cue',
    },
    {
      spoken: 'Your head drifted too much during the backswing. Focus on rotating your shoulders around a quiet, centered nose.',
      drill: 'Centered Spine Pivot Drill',
    },
  ],
  hip_sway: [
    {
      spoken: 'Your hips slid laterally away from the target. Feel like you are turning your trail hip pocket behind you inside a barrel.',
      drill: 'Turn-in-a-Barrel Hip Drill',
    },
    {
      spoken: 'Watch the lateral hip sway on the takeaway. Brace the inside of your trail foot and rotate instead of sliding.',
      drill: 'Trail Foot Brace Drill',
    },
  ],
  fast_tempo: [
    {
      spoken: 'Your transition at the top was a little quick. Count a smooth one-two-three on the way back and one through the ball.',
      drill: 'Three-to-One Tempo Count',
    },
    {
      spoken: 'Give the club a split-second pause to settle at the top so your tempo gets closer to three to one.',
      drill: 'Top-of-Swing Pause Drill',
    },
  ],
  slow_tempo: [
    {
      spoken: 'Your backswing was overly slow and deliberate. Let the club swing back with a more athletic three to one rhythm.',
      drill: 'Athletic Rhythm Woosh Drill',
    },
  ],
  early_extension: [
    {
      spoken: 'Your spine stood up through impact. Keep your belt buckle tilted down and your glutes pressed back against an imaginary wall.',
      drill: 'Wall Tush-Line Drill',
    },
    {
      spoken: 'Maintain your address spine angle through the ball by keeping your chest covering the ground a fraction longer.',
      drill: 'Chest-Down Impact Cue',
    },
  ],
  poor_shoulder_turn: [
    {
      spoken: 'Get a fuller shoulder turn by pointing your lead shoulder behind the ball at the top of the backswing.',
      drill: 'Back-to-Target Turn Cue',
    },
  ],
  low_x_factor: [
    {
      spoken: 'Create more coil by keeping your lower body quiet while turning your shoulders fully against your hips.',
      drill: 'Resisted Hip-Shoulder Coil Drill',
    },
  ],
  no_weight_shift: [
    {
      spoken: 'Shift your pressure into your lead heel before the club starts down so you finish balanced on your front foot.',
      drill: 'Step-Through Weight Shift Drill',
    },
  ],
  poor_weight_shift: [
    {
      spoken: 'Shift your pressure into your lead heel before the club starts down so you finish balanced on your front foot.',
      drill: 'Step-Through Weight Shift Drill',
    },
  ],
  over_the_top: [
    {
      spoken: 'Let your hands drop into the slot on the downswing so the club approaches from the inside toward right field.',
      drill: 'Drop-in-the-Slot Inside Path Cue',
    },
  ],
  none: [
    {
      spoken: 'Dialled-in swing with great posture and tempo. Step up and groove that exact same feel again.',
      drill: 'Tempo Groove Repeat',
    },
  ],
};

const PRAISE_LABELS: Record<SwingFault, string> = {
  bent_lead_arm: 'Nice job straightening that lead arm.',
  head_movement: 'Much steadier head position on that swing.',
  hip_sway: 'Great improvement locking in your hip sway.',
  fast_tempo: 'Much smoother tempo on that one.',
  slow_tempo: 'Better pace on the takeaway.',
  early_extension: 'Great job holding your spine angle through impact.',
  poor_shoulder_turn: 'Much fuller shoulder turn at the top.',
  low_x_factor: 'Great upper-to-lower body coil at the top.',
  no_weight_shift: 'Great weight transfer onto your lead side.',
  poor_weight_shift: 'Great weight transfer onto your lead side.',
  over_the_top: 'Much better inside path through the ball.',
};

function buildFallbackCoaching(payload: CoachingPayload): Omit<CoachingResponse, 'latencyMs' | 'source'> {
  const primaryFault: SwingFault | 'none' = payload.faults_ranked[0] || 'none';
  const candidates = FALLBACK_TEMPLATES[primaryFault] || FALLBACK_TEMPLATES.none;
  const pick = candidates[payload.swing_number % candidates.length];

  let prefix = '';
  if (payload.improved_since_last && payload.improved_since_last.length > 0) {
    const firstImproved = payload.improved_since_last[0];
    prefix = (PRAISE_LABELS[firstImproved] || 'Nice improvement from last swing.') + ' ';
  }

  return {
    spoken: `${prefix}${pick.spoken}`.trim(),
    fault: primaryFault,
    drill: pick.drill,
  };
}

function buildFallbackQA(question: string, latest: CoachingPayload | null): string {
  const q = question.toLowerCase();
  const topFault = latest?.faults_ranked?.[0];

  if (q.includes('head')) {
    const cm = latest?.metrics.head_movement_cm ?? 8;
    return `Your head moved about ${Math.round(cm)} centimetres during the swing, which shifts your low point. Focus on staring at a single dimple on the back of the ball while your shoulders rotate underneath your chin.`;
  }
  if (q.includes('arm') || q.includes('elbow')) {
    const deg = latest?.metrics.lead_arm_deg ?? 148;
    return `Your lead arm bent to ${Math.round(deg)} degrees at the top, which narrows your swing arc. Feel like you are pushing your hands wide away from your chest on the takeaway and keeping your trail elbow soft.`;
  }
  if (q.includes('hip') || q.includes('sway')) {
    return `When your hips slide sideways instead of rotating, it is tough to get your weight back to the target in time. Feel your trail hip pocket turn behind your heel as if you are rotating inside a narrow barrel.`;
  }
  if (q.includes('tempo') || q.includes('fast') || q.includes('rushed')) {
    const ratio = latest?.metrics.tempo_ratio ?? 2.0;
    return `Your tempo ratio was ${ratio.toFixed(1)} to one, whereas pros average around three to one. Count a smooth one-two-three up to the top of your backswing to give the club time to set.`;
  }
  if (q.includes('spine') || q.includes('extension') || q.includes('stand')) {
    return `Standing up out of your posture through impact pushes the club off plane. Keep your glutes pressed back against an imaginary wall until after your hands pass the ball.`;
  }

  if (topFault) {
    const fb = FALLBACK_TEMPLATES[topFault]?.[0] || FALLBACK_TEMPLATES.none[0];
    return `To fix that ${topFault.replace(/_/g, ' ')}, focus on one simple feel on your next swing. ${fb.spoken}`;
  }

  return `Focus on a smooth three to one tempo and keeping your head steady over the ball. Take a rehearsal swing at half speed to feel the positions before hitting full speed.`;
}

/**
 * Sanitize TTS string so numbers/abbreviations are always read cleanly.
 */
function sanitizeSpokenText(text: string): string {
  return text
    .replace(/[*_#`~]/g, '')
    .replace(/\b(\d+(?:\.\d+)?)\s*deg\b/gi, '$1 degrees')
    .replace(/\b(\d+(?:\.\d+)?)\s*°/g, '$1 degrees')
    .replace(/\b(\d+(?:\.\d+)?)\s*cm\b/gi, '$1 centimetres')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Helper to call Gemini with a strict timeout.
 */
async function callGeminiWithTimeout<T>(
  work: (genAI: GoogleGenerativeAI) => Promise<T>,
  timeoutMs = 2500
): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    throw new Error('GEMINI_API_KEY not configured in .env');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  return await Promise.race([
    work(genAI),
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Gemini timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// Health & config status
app.get('/api/health', (_req, res) => {
  const key = getApiKey();
  res.json({
    status: 'ok',
    geminiConfigured: Boolean(key && key !== 'your_gemini_api_key_here'),
    historyCount: sessionHistory.length,
  });
});

// Reset rolling coaching session memory
app.post('/api/coach/reset', (_req, res) => {
  sessionHistory = [];
  latestSwingPayload = null;
  res.json({ status: 'cleared' });
});

// POST /api/coach — Generate spoken feedback after a swing
app.post('/api/coach', async (req, res) => {
  const startMs = Date.now();
  const payload = req.body as CoachingPayload;

  if (!payload || !payload.metrics) {
    res.status(400).json({ error: 'Invalid CoachingPayload: missing metrics' });
    return;
  }

  latestSwingPayload = payload;

  try {
    const result = await callGeminiWithTimeout(async (genAI) => {
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        systemInstruction: COACH_SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.6,
          maxOutputTokens: 180,
        },
      });

      const promptContext = {
        recent_session_history: sessionHistory.slice(-4),
        current_swing: payload,
      };

      const response = await model.generateContent(JSON.stringify(promptContext));
      const rawText = response.response.text();
      const parsed = JSON.parse(rawText) as {
        spoken?: string;
        fault?: SwingFault | 'none';
        drill?: string;
      };

      if (!parsed.spoken) {
        throw new Error('Missing spoken field in Gemini JSON output');
      }

      return {
        spoken: sanitizeSpokenText(parsed.spoken),
        fault: parsed.fault || payload.faults_ranked[0] || 'none',
        drill: parsed.drill || 'Tempo & Posture Feel Drill',
      };
    }, 3000);

    // Record in rolling history (keep last 5 swings)
    sessionHistory.push({
      swing_number: payload.swing_number,
      match_score: payload.match_score,
      primary_fault: result.fault,
      improved: payload.improved_since_last || [],
      spoken_feedback: result.spoken,
    });
    if (sessionHistory.length > 5) {
      sessionHistory.shift();
    }

    const responseBody: CoachingResponse = {
      ...result,
      latencyMs: Date.now() - startMs,
      source: 'gemini',
    };
    res.json(responseBody);
  } catch (err: any) {
    console.warn('[coach] Using fallback template:', err?.message || err);
    const fb = buildFallbackCoaching(payload);

    sessionHistory.push({
      swing_number: payload.swing_number,
      match_score: payload.match_score,
      primary_fault: fb.fault,
      improved: payload.improved_since_last || [],
      spoken_feedback: fb.spoken,
    });
    if (sessionHistory.length > 5) {
      sessionHistory.shift();
    }

    const responseBody: CoachingResponse = {
      ...fb,
      latencyMs: Date.now() - startMs,
      source: 'fallback',
    };
    res.json(responseBody);
  }
});

// POST /api/qa — Voice Q&A ("How do I fix that?", "Why does my head matter?")
app.post('/api/qa', async (req, res) => {
  const startMs = Date.now();
  const body = req.body as VoiceQAPayload;
  const question = (body?.question || '').trim();
  const swingContext = body?.latest_swing || latestSwingPayload;

  if (!question) {
    res.status(400).json({ error: 'Missing question' });
    return;
  }

  try {
    const spoken = await callGeminiWithTimeout(async (genAI) => {
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        systemInstruction: QA_SYSTEM_PROMPT,
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 160,
        },
      });

      const userPrompt = `Golfer's question: "${question}"
Latest swing data: ${JSON.stringify(swingContext || 'No swing recorded yet')}
Recent session history: ${JSON.stringify(sessionHistory.slice(-3))}

Reply in 2 to 3 short spoken sentences (plain text, no markdown, no abbreviations):`;

      const response = await model.generateContent(userPrompt);
      return sanitizeSpokenText(response.response.text());
    }, 3500);

    const responseBody: VoiceQAResponse = {
      spoken,
      latencyMs: Date.now() - startMs,
      source: 'gemini',
    };
    res.json(responseBody);
  } catch (err: any) {
    console.warn('[qa] Using fallback answer:', err?.message || err);
    const spoken = buildFallbackQA(question, swingContext);
    const responseBody: VoiceQAResponse = {
      spoken,
      latencyMs: Date.now() - startMs,
      source: 'fallback',
    };
    res.json(responseBody);
  }
});

/**
 * GET /api/reference — Reads saved reference swing from data/reference.json
 */
app.get('/api/reference', async (_req, res) => {
  try {
    const raw = await fs.readFile(REFERENCE_PATH, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: 'No reference swing saved yet' });
  }
});

/**
 * POST /api/reference — Saves a SwingRecording as data/reference.json
 */
app.post('/api/reference', async (req, res) => {
  try {
    await ensureDirs();
    const recording = req.body;
    await fs.writeFile(REFERENCE_PATH, JSON.stringify(recording, null, 2), 'utf-8');
    res.json({ status: 'saved', path: 'data/reference.json', id: recording.id });
  } catch (err) {
    console.error('[server] Failed to save reference swing:', err);
    res.status(500).json({ error: 'Failed to save reference swing' });
  }
});

/**
 * GET /api/swings — Lists saved user swings from data/swings/
 */
app.get('/api/swings', async (_req, res) => {
  try {
    await ensureDirs();
    const files = await fs.readdir(SWINGS_DIR);
    const jsonFiles = files
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();

    const summaries = await Promise.all(
      jsonFiles.slice(0, 20).map(async (filename) => {
        try {
          const raw = await fs.readFile(path.join(SWINGS_DIR, filename), 'utf-8');
          const parsed = JSON.parse(raw);
          return {
            id: parsed.id || filename.replace(/\.json$/, ''),
            filename,
            createdAt: parsed.createdAt,
            handedness: parsed.handedness,
            fps: parsed.fps,
            frameCount: Array.isArray(parsed.frames) ? parsed.frames.length : 0,
            phases: parsed.phases,
          };
        } catch {
          return null;
        }
      })
    );

    res.json({ swings: summaries.filter(Boolean) });
  } catch (err) {
    console.error('[server] Failed to list swings:', err);
    res.status(500).json({ error: 'Failed to list swings' });
  }
});

/**
 * GET /api/swings/:id — Loads a specific saved swing JSON
 */
app.get('/api/swings/:id', async (req, res) => {
  try {
    const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = path.join(SWINGS_DIR, `${safeId}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: 'Swing not found' });
  }
});

/**
 * POST /api/swings — Persists a captured SwingRecording to data/swings/swing-<timestamp>.json
 */
app.post('/api/swings', async (req, res) => {
  try {
    await ensureDirs();
    const recording = req.body;
    const timestamp = Date.now();
    const id = recording.id || `swing-${timestamp}`;
    const filename = `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
    const filePath = path.join(SWINGS_DIR, filename);

    const payload = {
      ...recording,
      id,
      createdAt: recording.createdAt || new Date(timestamp).toISOString(),
    };

    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    res.json({
      status: 'saved',
      id,
      filename: `data/swings/${filename}`,
      frameCount: Array.isArray(payload.frames) ? payload.frames.length : 0,
    });
  } catch (err) {
    console.error('[server] Failed to save swing:', err);
    res.status(500).json({ error: 'Failed to save swing recording' });
  }
});

app.listen(PORT, () => {
  console.log(`[server] Golf Swing Coach API listening on http://localhost:${PORT}`);
});
