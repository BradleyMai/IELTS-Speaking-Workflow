# IELTS Speaking Workflow

Design work for the Speaking half of the IELTS practice product: how a student sits a mock
speaking test, how the recordings get graded, and what the student sees afterwards.

Everything here is **design material and a code scaffold**, not a running application.

## What is in here

### `mockups/` — clickable screens

Thirteen HTML prototypes. Start with `speaking-workflow.html`: the whole flow as a clickable
chart, where each step opens its screen. Open any file in a browser; they work offline and need no server.

| File | What it shows |
|---|---|
| `interview-choose-part.html` | Student picks one part to practise, or starts the full test |
| `interview-all-parts.html` | The full test as one unbroken conversation, AI feedback only at the end |
| `interview-teacher-graded.html` | The same test, but the student sees their teacher's grading instead |
| `interview-part-1.html` | Part 1 alone — ten interview questions |
| `interview-part-2.html` | Part 2 alone — task card, one minute of preparation, the long turn |
| `interview-part-3.html` | Part 3 alone — five discussion questions |
| `speaking-grading-screen.html` | Teacher side: grading a submitted attempt |
| `interview-send-full.html` | Full test where Finish asks who grades it: Ed (instant AI grading) or the teacher (submitted, returned later) |
| `interview-send-part-1/2/3.html` | The same choice for a single part |
| `teacher-queue.html` | Teacher side: speaking tests waiting to be graded, and the review-Ed's-draft or grade-from-scratch choice |
| `speaking-workflow.html` | The workflow map: click a step to see its screen at that moment |
| `speaking-workflow-all-in-one.html` | The same workflow map as one self-contained file, with every screen built in. Download it and open it offline |

`INDEX.md` in that folder maps each file to its published link and explains what it does.

**Two versions of each file exist.** The ones committed here are written for the artifact
platform, which supplies its own HTML skeleton. To open them from disk you need the standalone
build, which adds a DOCTYPE and the `[hidden]` rule those files rely on:

```
cd mockups
node build-standalone.js ../dist
```

Without that step the pages open in quirks mode and the layout collapses.

### `architecture/` — diagrams

draw.io files. Open at [app.diagrams.net](https://app.diagrams.net) (File → Open From → Device)
or in the desktop app.

- `speaking-test-taking-flow.drawio` — what the student does, start to finish
- `speaking-grading-workflow.drawio` — the AI-vs-teacher grading decision, as used for Writing
- `speaking-review-engine.drawio` — the full review engine
- `speaking-review-engine-simple.drawio` — the same thing, simplified for sharing

### `engine/` — code scaffold

TypeScript and Prisma for the speaking review pipeline: the grading screen components, the
analyze route, the provider interface and the schema additions. Reference material for the
build, not wired into an app. See `engine/README.md`.

## How the pieces fit

A student sits the test (`interview-*`). Each part is recorded and transcribed. Mistakes are
detected per question, but **bands are given per part, not per question** — that constraint
shapes both the student screens and the grading screen.

Grading goes one of two ways, matching how Writing already works: the AI grades it, or it goes
to a teacher who either reviews the AI's grading or grades from scratch. The student makes that
choice when they press Finish (`interview-send-*`): **Ed**, the LearnED mascot, is the name the
student sees for AI grading. They then see either Ed's grading straight away, or a
"your teacher has received your submission" state followed later by their teacher's marks.

## Caveats

- The microphone is **simulated**. These pages cannot record audio, so a timer plus a typed
  transcript stands in for speech-to-text. Playback is a progress bar, not real audio.
- All students, answers, scores and teacher comments are **demo content**, not real data.
- The band figures are illustrative and not calibrated against real IELTS marking.
