// Drop-in path: src/lib/speaking-review/pipeline.ts
//
// The two "make real data exist" steps, both idempotent (safe to call every
// time the review UI opens an attempt — they no-op once data is present).
//
// INTEGRATION TODO: loadListeningAudio and transcribeAudioWithProvider
// currently live in src/app/actions/admin.ts and are not exported for reuse
// outside that file (they were written for the Listening authoring flow).
// Either:
//   (a) export both from admin.ts and import them here, or
//   (b) move them to a neutral module (e.g. src/lib/transcription.ts) and
//       have admin.ts import from there instead.
// (b) is cleaner long-term since "transcription" isn't really an admin
// concern, but (a) is a one-line change if you want to ship this fast.

import { prisma } from "@/lib/prisma";
import { loadListeningAudio, transcribeAudioWithProvider } from "@/app/actions/admin"; // see TODO above
import { parseSpeakingFeedback } from "./feedback-json"; // small helper defined below in this file's sibling — see note
import {
  defaultSpeakingReviewGradingProvider,
  type SpeakingReviewGradingProvider,
} from "./provider";
import type { SpeakingReviewSegment } from "@/types/speaking-review";

const MAX_SPEAKING_AUDIO_BYTES = 30 * 1024 * 1024; // matches the existing speaking-audio upload cap

/**
 * Ensures SpeakingAttemptTranscriptSegment rows exist for this attempt.
 * No-ops if segments already exist. Returns them either way.
 *
 * Speaking has no server-side transcription today (transcript comes from
 * the browser's Web Speech API with no timing) — this reuses the same
 * transcribeAudioWithProvider() chain already built for Listening, with
 * preferHf so we actually get word/segment-level timing back (the OpenAI
 * leg of that chain returns plain text only, no timestamps).
 */
export async function ensureAttemptTranscriptSegments(
  attemptId: string,
): Promise<SpeakingReviewSegment[]> {
  const existing = await prisma.speakingAttemptTranscriptSegment.findMany({
    where: { attemptId },
    orderBy: { order: "asc" },
  });
  if (existing.length) return existing.map(toSegmentDTO);

  const attempt = await prisma.speakingAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: { audioUrl: true, transcript: true, durationSeconds: true },
  });

  if (!attempt.audioUrl) {
    // No recording to align against — fall back to one pseudo-segment
    // spanning the whole attempt so the UI still has something to render.
    // It just won't be seekable at sub-segment granularity.
    const created = await prisma.speakingAttemptTranscriptSegment.create({
      data: {
        attemptId,
        order: 0,
        startSeconds: 0,
        endSeconds: attempt.durationSeconds || null,
        text: attempt.transcript,
      },
    });
    return [toSegmentDTO(created)];
  }

  const bytes = await loadListeningAudio(attempt.audioUrl);
  if (bytes.byteLength > MAX_SPEAKING_AUDIO_BYTES) {
    throw new Error(`Speaking audio for attempt ${attemptId} exceeds ${MAX_SPEAKING_AUDIO_BYTES} bytes`);
  }

  const result = await transcribeAudioWithProvider(bytes, attempt.audioUrl, {
    returnTimestamps: true,
    preferHf: true, // OpenAI leg has no timing — force the Whisper/HF leg
  });

  const chunks = result.chunks.length
    ? result.chunks
    : [{ text: attempt.transcript, start: 0, end: attempt.durationSeconds || null }];

  const rows = await prisma.$transaction(
    chunks.map((c, i) =>
      prisma.speakingAttemptTranscriptSegment.create({
        data: {
          attemptId,
          order: i,
          startSeconds: c.start ?? 0,
          endSeconds: c.end,
          text: c.text,
        },
      }),
    ),
  );
  return rows.map(toSegmentDTO);
}

/**
 * Ensures the AI-side of the review exists: transcript segments (via the
 * function above), then AI marks (SpeakingAttemptMark, source="ai") and a
 * draft SpeakingAttemptReview seeded with the AI's suggested bands. No-ops
 * (aside from segment backfill) if AI marks already exist for this attempt —
 * re-running analysis on top of teacher edits would be destructive, so this
 * is intentionally a one-shot "first open" operation. To force a re-run,
 * delete the attempt's SpeakingAttemptMark rows where source="ai" first.
 */
export async function ensureAttemptReviewData(
  attemptId: string,
  reviewerId: string,
  provider: SpeakingReviewGradingProvider = defaultSpeakingReviewGradingProvider,
): Promise<void> {
  const segments = await ensureAttemptTranscriptSegments(attemptId);

  const alreadyAnalyzed = await prisma.speakingAttemptMark.findFirst({
    where: { attemptId, source: "ai" },
    select: { id: true },
  });
  const existingReview = await prisma.speakingAttemptReview.findUnique({ where: { attemptId } });
  if (alreadyAnalyzed && existingReview) return;

  const attempt = await prisma.speakingAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: {
      part: true,
      question: true,
      transcript: true,
      durationSeconds: true,
      audioUrl: true,
      feedbackJson: true,
    },
  });

  const analysis = await provider.analyzeAttempt({
    attemptId,
    part: attempt.part,
    question: attempt.question,
    transcript: attempt.transcript,
    durationSeconds: attempt.durationSeconds,
    audioUrl: attempt.audioUrl,
    transcriptSegments: segments,
    existingFeedback: parseSpeakingFeedback(attempt.feedbackJson),
  });

  if (!alreadyAnalyzed && analysis.marks.length) {
    await prisma.$transaction(
      analysis.marks.map((m) =>
        prisma.speakingAttemptMark.create({
          data: {
            attemptId,
            source: "ai",
            category: m.category,
            timeSeconds: m.timeSeconds,
            originalText: m.originalText,
            suggestedFix: m.suggestedFix,
            status: "pending",
          },
        }),
      ),
    );
  }

  if (!existingReview) {
    await prisma.speakingAttemptReview.create({
      data: {
        attemptId,
        reviewerId,
        fluency: analysis.bands.fluency,
        lexicalResource: analysis.bands.lexicalResource,
        grammar: analysis.bands.grammar,
        pronunciation: analysis.bands.pronunciation,
        overallBand: analysis.bands.overallBand,
        status: "draft",
      },
    });
  }
}

function toSegmentDTO(row: {
  id: string;
  startSeconds: number;
  endSeconds: number | null;
  text: string;
}): SpeakingReviewSegment {
  return { id: row.id, startSeconds: row.startSeconds, endSeconds: row.endSeconds, text: row.text };
}
