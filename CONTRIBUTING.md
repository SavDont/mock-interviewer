# Contributing

Thanks for helping. This is a small project, so the process is light.

## Setup

```bash
bun install
cp .env.example .env    # add one API key, or paste one in the app
bun run dev             # http://localhost:5173
```

Speech recognition works without extra setup in Chrome and Safari. For the better, private local
Whisper, see "Local speech recognition" in the README.

## Before you open a pull request

```bash
bun run check           # lint + typecheck + unit tests (what CI runs)
bun run format          # fix formatting
```

If you change a grading prompt or the rubric, also run the grader eval, which makes real API calls
(about $1 to $2 on Claude Opus 5.5 for the default 3 fixtures x 3 runs):

```bash
bun run eval
```

and say in the PR what it reported.

## Where things live

- `server/llm/`: one file per model provider behind a small interface (`types.ts`). To add a
  provider, implement `ModelProvider` and register it in `llm/index.ts`.
- `server/interview/`: the interview flow (`flow.ts`), its prompts, and session storage.
- `server/grading/`: the rubric as data (`rubric.ts`), the debrief prompts, and score parsing.
- `server/memory/`: drills on weak spots, and recurring weak spots across calls.
- `src/`: the browser app. `loop.ts` decides when to ask the model; `turn-taking.ts`, `scene.ts`,
  `whisper.ts` and `kokoro.ts` are its ears, eyes and voice.

## Ground rules

- Never commit keys, `.env`, or anything from `.sessions/` (real transcripts and resumes).
- Keep the system prompt byte-identical across a session, and keep the conversation append-only:
  that's what keeps prompt caching (and the cost) working. `tests/flow.test.ts` checks it.
- Prefer small, readable modules over abstractions. Comments explain why, not what.
