// Drop-in path: src/lib/speaking-review/provider.ts
//
// This is the plug point. `SpeakingReviewGradingProvider` is the seam where
// your future AI goes — implement it and pass the implementation into
// ensureAttemptReviewData() (see pipeline.ts) instead of
// DefaultSpeakingReviewGradingProvider.
//
// DefaultSpeakingReviewGradingProvider is a real, working implementation
// that costs zero extra AI calls: it reads the SpeakingFeedback already
// produced by gradeSpeakingAnswer() at mock-submission time
// (src/lib/speaking-grading.ts) — its 4-item `rubric` becomes the AI band
// suggestion, and its `corrections[]` become positioned marks (positioned by
// locating each correction's original text inside the timestamped transcript
// segments). It exists so the review UI is fully functional today; swap it
// out when your dedicated grading AI is ready.

import type { SpeakingFeedback } from "@/lib/speaking-grading"; // adjust import path if different
import type {
  SpeakingBandSet,
  SpeakingReviewCriterionLabel,
  SpeakingReviewSegment,
} from "@/types/speaking-review";
import { emptyBandSet } from "@/types/speaking-review";

export type SpeakingReviewProposedMark = {
  category: SpeakingReviewCriterionLabel;
  timeSeconds: number;
  originalText: string;
  suggestedFix: string | null;
};

export type SpeakingReviewAnalysis = {
  bands: SpeakingBandSet;
  marks: SpeakingReviewProposedMark[];
};

export type SpeakingReviewAnalyzeInput = {
  attemptId: string;
  part: string;
  question: string;
  transcript: string;
  durationSeconds: number;
  audioUrl: string | null;
  /** Timestamped chunks from the transcription step — may be empty if
   *  transcription couldn't produce timing (e.g. OpenAI provider, which
   *  returns plain text only). */
  transcriptSegments: SpeakingReviewSegment[];
  /** Already-parsed feedbackJson from SpeakingAttempt, if any. */
  existingFeedback: SpeakingFeedback | null;
};

export interface SpeakingReviewGradingProvider {
  analyzeAttempt(input: SpeakingReviewAnalyzeInput): Promise<SpeakingReviewAnalysis>;
}

/**
 * Locates `needle` inside the timestamped segments and returns the start
 * time of the segment it falls in. Falls back to `null` when no segment
 * contains it (e.g. transcription had no timing, or the correction text
 * doesn't verbatim-match the transcript — gradeSpeakingAnswer's own
 * normalizer is supposed to guarantee a verbatim match, but segments come
 * from a *different* transcription pass than the browser transcript that was
 * graded, so a miss is expected sometimes).
 */
function locateInSegments(needle: string, segments: SpeakingReviewSegment[]): number | null {
  const target = needle.trim().toLowerCase();
  if (!target) return null;
  const hit = segments.find((seg) => seg.text.toLowerCase().includes(target));
  return hit ? hit.startSeconds : null;
}

const RUBRIC_ORDER: SpeakingReviewCriterionLabel[] = [
  "Fluency",
  "Lexical",
  "Grammar",
  "Pronunciation",
];

function bandsFromFeedback(feedback: SpeakingFeedback | null): SpeakingBandSet {
  const bands = emptyBandSet();
  if (!feedback?.rubric?.length) return bands;
  // rubric is documented as always 4 items in fixed order: Fluency&Coherence,
  // Lexical, Grammar, Pronunciation.
  const [f, l, g, p] = feedback.rubric;
  bands.fluency = f?.score ?? null;
  bands.lexicalResource = l?.score ?? null;
  bands.grammar = g?.score ?? null;
  bands.pronunciation = p?.score ?? null;
  const present = [bands.fluency, bands.lexicalResource, bands.grammar, bands.pronunciation].filter(
    (v): v is number => v !== null,
  );
  bands.overallBand = present.length
    ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 2) / 2
    : null;
  return bands;
}

function marksFromFeedback(
  feedback: SpeakingFeedback | null,
  segments: SpeakingReviewSegment[],
): SpeakingReviewProposedMark[] {
  if (!feedback?.corrections?.length) return [];
  return feedback.corrections
    .map((c): SpeakingReviewProposedMark | null => {
      const t = locateInSegments(c.original, segments);
      if (t === null) return null; // can't place it on the timeline — skip rather than guess
      // corrections aren't pre-categorized by gradeSpeakingAnswer; default to
      // Grammar since that's what the corrections field is overwhelmingly
      // used for today. Replace with real categorization once the pluggable
      // provider distinguishes grammar/lexical corrections itself.
      return {
        category: "Grammar",
        timeSeconds: t,
        originalText: c.original,
        suggestedFix: c.corrected,
      };
    })
    .filter((m): m is SpeakingReviewProposedMark => m !== null);
}

export class DefaultSpeakingReviewGradingProvider implements SpeakingReviewGradingProvider {
  async analyzeAttempt(input: SpeakingReviewAnalyzeInput): Promise<SpeakingReviewAnalysis> {
    return {
      bands: bandsFromFeedback(input.existingFeedback),
      marks: marksFromFeedback(input.existingFeedback, input.transcriptSegments),
    };
  }
}

export const defaultSpeakingReviewGradingProvider = new DefaultSpeakingReviewGradingProvider();
