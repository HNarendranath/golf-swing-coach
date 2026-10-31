# Golf Swing Coach

Real-time AI Golf Swing Coach built with MediaPipe Pose Landmarker, Three.js 3D Replay, Web Speech API, and Gemini (`gemini-2.5-flash`).

## Documentation
- [Implementation Plan & Architecture](docs/IMPLEMENTATION_PLAN.md)
- [5-Hour Hackathon Plan](docs/HACKATHON_PLAN.md)

## Project Structure
```text
golf-swing-coach/
├── docs/                        # Project & technical plans
├── server/
│   └── index.ts                 # Express backend (Gemini API + swing JSON persistence)
├── src/
│   ├── main.ts                  # Frontend entry point & UI orchestration
│   ├── style.css                # Dashboard styles
│   ├── types.ts                 # Shared TypeScript interfaces
│   ├── capture/                 # [Track A] MediaPipe Pose, One Euro Filter, Capture FSM
│   ├── analysis/                # [Track A/B] Phase detection, 9 metrics, Reference alignment
│   ├── visuals/                 # [Track B] 2D Canvas overlay & Three.js 3D skeleton replay
│   └── coaching/                # [Track C] Web Speech TTS + Push-to-Talk STT
└── data/                        # Reference & recorded swing JSON storage
```

## Quick Start
```bash
cp .env.example .env
# Add your GEMINI_API_KEY to .env
npm install
npm run dev
```

