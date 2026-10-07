# Mockups — file to artifact

Each file below is published as an artifact with the same name. Double-click a file to open it
in your browser, or use the link to open the published version.

**Start here:** `speaking-workflow.html` is the whole workflow as a clickable flow chart. Click a
step and the matching screen opens beside it, already at that moment of the flow.

| File | Artifact name | Link |
|---|---|---|
| `speaking-workflow.html` | IELTS Speaking Workflow | https://claude.ai/artifact/V3bvfpysgGReKte12caVaX |
| `interview-choose-part.html` | IELTS mock interview choose part | https://claude.ai/artifact/C7M1Lc5A9wGJd8kweCk7Ky |
| `interview-all-parts.html` | IELTS mock interview all parts | https://claude.ai/artifact/6m5chP54aXanng9FDUXtDc |
| `interview-teacher-graded.html` | IELTS mock interview teacher graded | https://claude.ai/artifact/T7M9cmk2q7i8gM3hn1wYKG |
| `interview-part-1.html` | IELTS mock interview part 1 | https://claude.ai/artifact/Mi9kqnq8qSzoN78XQpXYDB |
| `interview-part-2.html` | IELTS mock interview part 2 | https://claude.ai/artifact/HPwhMvsFrDozUbejFgqF73 |
| `interview-part-3.html` | IELTS mock interview part 3 | https://claude.ai/artifact/12Uhqhs3BsHmsjXJ4a8c6N |
| `speaking-grading-screen.html` | Speaking Grading Screen | https://claude.ai/artifact/Rr7JkfZ7GXajpbhxd9nULV |
| `interview-send-full.html` | IELTS mock interview send full | https://claude.ai/artifact/MscrZe7trbc3gtwPjhJTp8 |
| `interview-send-part-1.html` | IELTS mock interview send part 1 | https://claude.ai/artifact/4Qapd35du2z4gxhtvSMSah |
| `interview-send-part-2.html` | IELTS mock interview send part 2 | https://claude.ai/artifact/Nti53pYqWLwPZ8rZ6NfwkR |
| `interview-send-part-3.html` | IELTS mock interview send part 3 | https://claude.ai/artifact/2vERLV4udHLphrqrriVzE9 |
| `teacher-queue.html` | Speaking Submissions Queue | bundled inside the workflow artifact |

## What each one is

**interview-choose-part** — student picks what to practise: any single part, or the full test.
The full-test route is gated (Part 2 locked until Part 1 is finished).

**interview-all-parts** — the full test with no chooser. Drops straight into Part 1 and runs
Part 1 → 2 → 3 in order, as one unbroken conversation: the examiner introduces each new part
and carries straight on, and nothing from the AI appears during the test. Pressing Finish at
the end reveals the AI coach feedback and playback of every answer.

**interview-teacher-graded** — the same test, but the block at the end is the teacher's work
instead of the AI's: bands and comments on all four criteria, colour-coded, plus every error
the teacher marked on the grading screen with its correction and note. This is the student
side of `speaking-grading-screen`.

**interview-part-1 / 2 / 3** — one part on its own, openable without the others. Part 1 is ten
questions, Part 2 is the cue card with one minute of preparation, Part 3 is five discussion
questions. All three are generated from the same template, so a change to the question content
or the feedback logic should be made once and regenerated.

**speaking-grading-screen** — teacher side. Grading a submitted speaking attempt: audio with a
transcript, flagged errors, and bands per part.

**interview-send-full / interview-send-part-1 / 2 / 3** — the grading choice. Same test as
above, but pressing Finish opens a popup asking who grades it:

- **Send to Ed** — Ed, the LearnED mascot, is the AI grader. The grading appears right away:
  bands on all four criteria per part (plus an overall band on the full test), Ed's comments,
  the errors in every answer with corrections, and Ed's rewritten version of each answer. A
  button then lets the student also send the same test to their teacher.
- **Send to your teacher** — the student sees "Ms. Hạnh has received your submission" with a
  Submitted → Being graded → Returned tracker, and can leave. A dashed **Demo** button stands in
  for the teacher pressing "Send to student" on `speaking-grading-screen`: a "your test has been
  graded" notification appears, and opening it shows the full teacher grading, exactly as in
  `interview-teacher-graded`.

**speaking-workflow** — the workflow map. Steps 1–4 are the test itself (choose, answer, Finish,
who grades it), then it forks: A1–A2 is the Ed path, B1–B7 the teacher path (received → teacher's
queue → review Ed's draft or grade from scratch → grade → send → student notified → student
reads the grading). Each step loads a mockup with a preset moment, passed as `window.__AT`
(or `#at=...` in the URL when opened from disk). Presets:

- `interview-send-*`: `finished`, `picker`, `ed-grading`, `ed`, `sent`, `returned`, `teacher`
  (the test is fast-forwarded with the sample answers first)
- `speaking-grading-screen`: `scratch` (no AI bands, flags or rewrites), `sent`
- `teacher-queue`: `choose` (the review-or-scratch dialog is open)

The workflow page fetches the other mockups, so open it from the standalone build
(`node build-standalone.js ../dist`, then open `dist/speaking-workflow.html`), or use the
published link, which bundles every screen it needs.

**teacher-queue** — new. The teacher's list of speaking tests sent to them, oldest first, with
Ed's draft status and the 48-hour deadline. Pressing Grade asks whether to review Ed's draft or
grade from scratch.

The part files are the full file with `var ONLY` set to 0, 1 or 2. Edit
`interview-send-full.html` and run `node make-send-parts.js` to regenerate them.

## Notes

- These are mockups. No backend, no database, and the microphone is simulated — a published
  artifact cannot access a real microphone. The timer plus a typed transcript stands in for
  speech-to-text.
- Student answers, scores and the examiner's questions are demo content, not real data.
- Ed's rewritten answers are written for the sample answers, so they show only when an answer
  was filled with **Load sample answer**. Ed's Pronunciation band is labelled as an estimate,
  since the pipeline does not analyse audio for pronunciation yet.
- The artifacts are private. Nobody else can open the links until they are shared from the
  Share menu on the page itself.
