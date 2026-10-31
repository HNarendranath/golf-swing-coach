import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', geminiConfigured: Boolean(process.env.GEMINI_API_KEY) });
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
