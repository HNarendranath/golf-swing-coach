# Golf Swing Coach: 5hr Hackathon Plan

## Stack
- **Phone → laptop video:** DroidCam / Iriun Webcam (phone appears as a webcam on Windows)
- **Pose:** MediaPipe Pose Landmarker (heavy model). Use `pose_world_landmarks` (3D, in metres, hip-centred) for the analysis and 3D replay, and image landmarks for the 2D overlay
- **Frontend:** browser app. three.js for the 3D replay, canvas overlay on the video
- **Coaching:** LLM (a small, fast model) + Web Speech API (STT via `SpeechRecognition`, TTS via `speechSynthesis`, both work in Chrome)

## Timeline
| Time | Task | Done when |
|---|---|---|
| 0:00–0:10 | Phone link | Phone feed visible in OpenCV/browser |
| 0:10–1:40 | Pose + swing capture | Auto-detects a swing, saves keypoints JSON |
| 1:40–3:10 | Swing analysis + overlay | Metrics computed; user path drawn against the reference |
| 3:10–4:10 | 3D replay | three.js skeleton replays a swing, scrubbable |
| 4:10–4:55 | Speech coaching | Spoken feedback after each swing + voice Q&A |
| 4:55–5:00 | Demo prep | Script + backup recording |

---

## Camera setup (decide first)
- **Face-on** (camera facing the golfer's chest, about 3 m away, at hip height): best for head movement, sway, hip/shoulder rotation, weight shift. **Default to this.**
- **Down-the-line** (behind the hands, looking at the target): best for swing plane and in-to-out path (draw/fade). Stretch goal.
- 60 fps if DroidCam allows it (the downswing takes about 0.25 s, so 30 fps gives only about 7 frames). Bright lighting, plain background, fitted clothes.
- A real club isn't needed. Mime with a stick/umbrella; MediaPipe tracks the body, not the club.

## Swing capture
1. **Smoothing:** run each landmark through a One Euro filter (or an EMA with α≈0.5). Raw MediaPipe output jitters.
2. **Trigger:** "address" = wrists below the hips and still (speed < threshold) for about 1 s → start recording.
3. **End:** wrists above the shoulders on the lead side, then still for 0.5 s → stop. Save `{t, landmarks[33][x,y,z,vis]}[]`.
4. Drop frames where key landmark visibility is < 0.5.

## Phase detection
Use the midpoint of both wrists ("hands"):
| Phase | Detection |
|---|---|
| Address | first still frame |
| Takeaway | hands start moving |
| Top | hands at max height (min y) before reversing |
| Impact | hands back near address height with peak speed |
| Finish | hands high on the lead side, still |

Phases are used to time-align with the reference swing and to compute tempo.

## Metrics (all from world landmarks)
| Metric | How | Good-ish target |
|---|---|---|
| **Tempo** | (top − takeaway) / (impact − top) | ~3:1 |
| **Head movement** | max displacement of nose from address, takeaway→impact | < 5 cm |
| **Hip sway** | lateral shift of hip midpoint at top vs address | < 5 cm away from target |
| **Shoulder turn** | angle of the shoulder line vs address, at the top (rotation about the vertical axis) | ~80–90° |
| **Hip turn** | same, for the hip line | ~40–50° |
| **X-factor** | shoulder turn − hip turn at the top | ~40° |
| **Lead arm** | elbow angle (shoulder–elbow–wrist) at the top | > 160° (straight) |
| **Spine angle** | torso tilt (hip mid → shoulder mid vs vertical): address vs impact | change < 5° ("early extension" if it stands up) |
| **Weight shift** | hip midpoint at impact vs address, toward the target | moves toward the target |

Thresholds are rough. Tune them on your own swings, and calibrate against your reference swing rather than textbook numbers if the two disagree.

**Note:** MediaPipe's z (depth) is noisy from a single camera, so rotation angles are approximate. Fine for a demo; just present them as estimates.

## Reference comparison + overlay
1. Record one "good" swing (best golfer on the team, or the best of several takes) → `reference.json`.
2. **Normalise** both swings: centre on the hip midpoint, scale by torso length (shoulder mid ↔ hip mid). This removes height and distance-to-camera differences.
3. **Time-align:** piecewise linear resample between phases (address→top→impact→finish) so both have the same frame count per phase. (Easier than DTW and good enough.)
4. **Overlay:** draw the reference hands path as a ghost line (green) and the user's path (red) on the video/canvas. Optionally draw a ghost skeleton at the same phase.
5. **Score:** mean distance between aligned hand positions → a 0–100 "swing match" score. Good for the demo.

## Draw vs fade (stretch)
Can't measure the clubface from pose alone. From down-the-line, approximate the path with the hands' direction through impact: hands moving out (away from the body) = in-to-out = draw tendency; across the body = out-to-in = fade/slice. Present it as a "path tendency", not as ball flight.

## 3D replay
- Feed world landmarks into three.js: spheres for joints, lines for the bones (use MediaPipe's `POSE_CONNECTIONS`).
- Slider to scrub frames, play at 0.25× speed, toggle the reference ghost skeleton.
- OrbitControls so judges can spin it around. Cheap and impressive.

---

## Coaching / prompt engineering

### Core principle: code measures, LLM talks
- Compute the metrics **and pick the faults deterministically** in code. The LLM only turns that structured data into natural coaching speech.
- Never send raw keypoints to the LLM: slow, expensive, and it will hallucinate analysis.

### What to send per swing
```json
{
  "swing_number": 3,
  "match_score": 72,
  "metrics": {
    "tempo_ratio": 2.1, "head_movement_cm": 9, "hip_sway_cm": 3,
    "shoulder_turn_deg": 85, "x_factor_deg": 38,
    "lead_arm_deg": 148, "spine_angle_change_deg": 7
  },
  "faults_ranked": ["bent_lead_arm", "head_movement", "fast_tempo"],
  "previous_focus": "head_movement",
  "improved_since_last": ["hip_sway"]
}
```

### System prompt skeleton
```
You are a friendly golf coach giving live spoken feedback between swings.

Rules:
- Output is read aloud by TTS: no markdown, no lists, no emojis, no numbers with units like "deg"; say "degrees".
- Max 2 short sentences (~25 words). The golfer is standing over the ball, not reading.
- Address ONE fault only: the first in faults_ranked. Give one concrete cue or feel ("keep your lead arm long, like you're pushing the club away").
- If something in improved_since_last, praise it first in a few words.
- Only comment on the metrics provided. Never mention grip, clubface, ball flight, or anything not measured.
- Don't repeat the same cue wording as last swing; vary it.

Target ranges: tempo ~3:1, head movement <5cm, lead arm >160 degrees, ...
```

### Tips
- **Few-shot examples:** put 3–4 example input→output pairs in the system prompt. This fixes tone and length better than instructions alone.
- **Structured output:** ask for `{"spoken": "...", "fault": "...", "drill": "..."}`. Speak `spoken`, show `drill` on screen.
- **Latency:** use a small, fast model, stream the response, and start TTS on the first complete sentence. The target is feedback within about 1.5 s of the swing finishing.
- **Memory/interactivity:** keep a rolling chat history (last ~5 swings as summaries) so it can say "better, that's two in a row." For voice Q&A ("why does my head matter?"), send the user transcript plus the latest metrics JSON; allow ~3 sentences there.
- **Push-to-talk** (spacebar) rather than always-on listening: avoids picking up its own TTS and crowd noise at the demo.
- **Fallback:** templated lines per fault (`"Keep your head still through the ball."`). Use them if the API is slow or the wifi dies.
- **Test the prompt early** with fake metrics JSON while pose is being built. No need to wait for the pipeline.

---

## Stretch (cut first)
- Club choice / draw-fade (down-the-line camera)
- Multiple reference swings (driver vs iron)
- Session summary at the end ("your 3 biggest improvements")

## Fallbacks
- Phone link fails → laptop webcam
- To show it off in the demo: MediaPipe in the phone browser → keypoints over WebSocket (needs HTTPS: `cloudflared tunnel` / ngrok)
- Avoid custom WebRTC video streaming

## Split (if team of 3)
- **A:** capture, phase detection, metrics
- **B:** overlay, reference comparison, 3D replay, UI
- **C:** coaching prompt, speech in/out, fallback lines, demo script

## Demo script (~2 min)
1. Bad swing on purpose → spoken fault + red path vs green ghost
2. Ask by voice "how do I fix that?" → answer
3. Better swing → praise + higher match score
4. Spin the 3D replay in slow-mo

