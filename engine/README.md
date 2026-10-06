# Speaking review engine — integration guide

This is a drop-in scaffold, not a runnable project on its own — no
`package.json`/`tsconfig` here, because it's meant to be copied into your
existing Next.js/Prisma app. Paths under `engine/` mirror where each file
goes in your repo (e.g. `engine/src/lib/...` → `src/lib/...`).

## What this replaces

The original `speaking-chunks_2.html` was a fully static mock: three
hardcoded "chunks" (`CH`), a hardcoded mistake dictionary (`M`), a fake
sine-wave timeline, and `setInterval`-driven fake playback. This scaffold
makes all of that real, on top of your actual schema:

| Mock had | Now backed by |
|---|---|
| `CH[i].ans[j].segs` (hardcoded transcript + timestamps) | `SpeakingAttemptTranscriptSegment`, produced by re-running the existing Listening transcription provider chain against each `SpeakingAttempt.audioUrl` with `returnTimestamps: true` |
| `M` (hardcoded AI mistakes) | `SpeakingAttemptMark` (`source: "ai"`), seeded from `SpeakingAttempt.feedbackJson.corrections` today, swappable for a real grading model via one interface |
| Fake sine-wave `<svg class="tl">` | Real waveform, decoded client-side from the actual audio file via Web Audio (`useAudioWaveform`) |
| `setInterval` fake playhead | A real `<audio>` element per attempt |
| In-memory `bands`/`note`/`mine` flags, lost on refresh | `SpeakingAttemptReview`, `SpeakingMockSessionReview` (persisted, Prisma) |
| One student, one test, hardcoded | Any `SpeakingMockSession` by id — multi-student for free, since it was already relational |

## One real architecture change from the mock

The mock pretended each "chunk" (Part) has one continuous audio timeline
across all its questions. In your schema, **each `SpeakingAttempt` is its
own separate recording** (own `audioUrl`, own `durationSeconds`) — there's
no single file per part. So the player in `SpeakingReviewPanel` operates on
one attempt's audio at a time; switching questions within a part swaps the
`<audio src>` rather than scrubbing one stitched timeline. This is more
correct for your data, not a limitation — flag it if you actually do want
audio stitched across a part, which would need client-side concatenation via
`AudioBuffer`s (decode each clip, play through one `AudioContext`) and is a
meaningfully bigger lift.

## Files

```
prisma/speaking-review.additions.prisma   → paste into prisma/schema.prisma
src/types/speaking-review.ts              → shared DTO types
src/lib/speaking-review/provider.ts       → the AI plug point (see below)
src/lib/speaking-review/pipeline.ts       → transcription + analysis orchestration
src/lib/speaking-review/feedback-json.ts  → tiny feedbackJson parse helper
src/app/actions/speaking-grading-review.ts → server actions (CRUD)
src/app/api/speaking-grading/[sessionId]/analyze/route.ts → heavy job route
src/components/speaking-review/SpeakingReviewPanel.tsx    → the UI, React port of the mock
src/components/speaking-review/SpeakingReviewPanel.module.css
src/components/speaking-review/useAudioWaveform.ts
src/app/grading/speaking/[sessionId]/page.tsx → example page wiring it together
```

## Integration steps

1. **Schema**: append the models from `prisma/speaking-review.additions.prisma`
   into your `schema.prisma`, plus the three relation fields it calls out
   for the existing `SpeakingAttempt`/`SpeakingMockSession` models. Run
   `prisma migrate dev`.
2. **Fix the import paths marked with TODO comments** — I don't have your
   repo open, so these are named by convention rather than verified:
   - `@/lib/auth` (your NextAuth v5 instance/`auth()` helper)
   - `@/lib/speaking-grading` (for the `SpeakingFeedback` type)
   - `loadListeningAudio` / `transcribeAudioWithProvider`, currently private
     to `src/app/actions/admin.ts` — either export them from there, or (cleaner)
     move them to a neutral `src/lib/transcription.ts` module, since
     "transcribe this audio" isn't really an admin-only concern once Speaking
     uses it too.
3. **Wire real auth** into `requireReviewer()` in
   `speaking-grading-review.ts` and the route handler — both currently only
   check that *someone* is logged in. Follow the same shape as
   `canAccessWritingTask` (role check + org-scope check that the attempt's
   student is in the reviewer's org), not a bare admin-email allowlist.
4. **Rate limiting**: `route.ts`'s `checkRateLimit` is illustrative — swap
   in whatever Upstash wrapper you already use for `grade-writing`/audio
   upload, rather than constructing `Redis`/`Ratelimit` inline.
5. Drop `SpeakingReviewPanel` into a page (see the example), pointed at a
   real `sessionId`.

## The AI plug point

`SpeakingReviewGradingProvider.analyzeAttempt()` in `provider.ts` is where
your future grading AI goes:

```ts
export interface SpeakingReviewGradingProvider {
  analyzeAttempt(input: SpeakingReviewAnalyzeInput): Promise<SpeakingReviewAnalysis>;
}
```

It receives the transcript, the timestamped segments, the audio URL, and
whatever `gradeSpeakingAnswer()` already produced at submission time
(`existingFeedback`), and returns band suggestions + positioned mistake
marks. `DefaultSpeakingReviewGradingProvider` is a real, functioning
implementation (derives everything from `existingFeedback`, no new AI call)
so the review UI works end-to-end today. When your model is ready,
implement the interface and pass it as the third argument to
`ensureAttemptReviewData()` in `pipeline.ts` (and in the API route) instead
of the default.

Two things worth deciding when you build the real provider:
- **Category attribution**: `existingFeedback.corrections` isn't
  pre-categorized (Fluency/Lexical/Grammar/Pronunciation) — the default
  provider labels everything "Grammar" as a placeholder. Your provider
  should classify properly.
- **Pronunciation**: `SpeakingAttempt.pronunciation` is always written
  `null` today ("AI không chấm phát âm" per your notes) — a real audio-based
  provider is the natural place to finally fill that in, since it can
  listen to the recording rather than only reading the transcript.

## Known gaps / things to decide before shipping

- **First-open latency**: `getSpeakingMockSessionForReview` runs analysis
  synchronously for any un-analyzed attempt before returning. For a session
  with several un-graded attempts this could be slow (each hits the HF
  Whisper transcription leg). The API route
  (`/api/speaking-grading/[sessionId]/analyze`) exists so you can trigger
  analysis from the client on mount instead and poll, if that's a better
  fit than a slow first server-render — see the comment in `page.tsx`.
- **Fuzzy text matching**: positioning AI marks on the timeline
  (`locateInSegments` in `provider.ts`) works by substring-matching
  `correction.original` against transcript segments produced by a
  *different* transcription pass (server Whisper vs. the browser's Web
  Speech API that originally produced the graded transcript). A mismatch
  between the two transcriptions means a mark silently gets dropped rather
  than mis-positioned — reasonable default, but you may want visibility
  into how often that happens.
- **Re-analysis**: `ensureAttemptReviewData` is one-shot by design (won't
  overwrite teacher edits). If you need "re-run AI analysis" as a manual
  action, delete that attempt's `SpeakingAttemptMark` rows where
  `source = "ai"` first.
- Toasts/keyboard shortcuts/layout in `SpeakingReviewPanel` are a faithful
  port of the mock's interaction model, not audited against your existing
  design-system components — treat it as a strong first draft.
