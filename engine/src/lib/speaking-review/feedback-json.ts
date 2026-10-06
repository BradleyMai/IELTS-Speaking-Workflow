// Drop-in path: src/lib/speaking-review/feedback-json.ts
//
// SpeakingAttempt.feedbackJson is stored as a raw string (Prisma has no JSON
// column for it). This is the one-line parse used everywhere in the review
// engine so it isn't repeated inline. If speaking-grading.ts already exports
// an equivalent (e.g. it re-parses feedbackJson elsewhere), prefer that
// instead of this duplicate.

import type { SpeakingFeedback } from "@/lib/speaking-grading"; // adjust import path if different

export function parseSpeakingFeedback(raw: string | null | undefined): SpeakingFeedback | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SpeakingFeedback;
  } catch {
    return null;
  }
}
