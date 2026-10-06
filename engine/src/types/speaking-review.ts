// Drop-in path: src/types/speaking-review.ts
//
// Shared shape between the server (actions, API routes, pipeline) and the
// client (SpeakingReviewPanel). Deliberately flat/plain so it can cross the
// server/client boundary as a server-component prop without extra
// serialization work.

export type SpeakingReviewPart = "part-1" | "part-2" | "part-3";

export type SpeakingReviewCriterion =
  | "fluency"
  | "lexicalResource"
  | "grammar"
  | "pronunciation";

export const REVIEW_CRITERIA: SpeakingReviewCriterion[] = [
  "fluency",
  "lexicalResource",
  "grammar",
  "pronunciation",
];

export type SpeakingReviewCriterionLabel = "Fluency" | "Lexical" | "Grammar" | "Pronunciation";

export const CRITERION_LABEL: Record<SpeakingReviewCriterion, SpeakingReviewCriterionLabel> = {
  fluency: "Fluency",
  lexicalResource: "Lexical",
  grammar: "Grammar",
  pronunciation: "Pronunciation",
};

export type SpeakingBandSet = Record<SpeakingReviewCriterion, number | null> & {
  overallBand: number | null;
};

export type SpeakingReviewMarkStatus = "pending" | "kept" | "dismissed";
export type SpeakingReviewMarkSource = "ai" | "teacher";

export type SpeakingReviewMark = {
  id: string;
  attemptId: string;
  source: SpeakingReviewMarkSource;
  category: SpeakingReviewCriterionLabel;
  timeSeconds: number;
  originalText: string;
  suggestedFix: string | null;
  status: SpeakingReviewMarkStatus;
};

export type SpeakingReviewSegment = {
  id: string;
  startSeconds: number;
  endSeconds: number | null;
  text: string;
};

export type SpeakingReviewAttempt = {
  id: string;
  part: SpeakingReviewPart;
  question: string;
  transcript: string;
  audioUrl: string | null;
  durationSeconds: number;
  aiBands: SpeakingBandSet;
  reviewBands: SpeakingBandSet;
  note: string;
  reviewStatus: "draft" | "final";
  segments: SpeakingReviewSegment[];
  marks: SpeakingReviewMark[];
  analyzed: boolean; // false until pipeline has produced segments/marks at least once
};

export type SpeakingReviewChunk = {
  part: SpeakingReviewPart;
  label: string;
  attempts: SpeakingReviewAttempt[];
};

export type SpeakingMockSessionReviewDTO = {
  sessionId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  status: "in_progress" | "returned";
  overallBand: number | null;
  chunks: SpeakingReviewChunk[];
};

export const PART_LABELS: Record<SpeakingReviewPart, string> = {
  "part-1": "Part 1 · Introduction & interview",
  "part-2": "Part 2 · Long turn",
  "part-3": "Part 3 · Discussion",
};

export function emptyBandSet(): SpeakingBandSet {
  return { fluency: null, lexicalResource: null, grammar: null, pronunciation: null, overallBand: null };
}

export function isBandSetComplete(bands: SpeakingBandSet): boolean {
  return REVIEW_CRITERIA.every((k) => bands[k] !== null && bands[k] !== undefined);
}

export function averageBandSet(bands: SpeakingBandSet): number | null {
  const values = REVIEW_CRITERIA.map((k) => bands[k]).filter(
    (v): v is number => v !== null && v !== undefined,
  );
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(mean * 2) / 2;
}
