// Drop-in path (adjust to wherever your grading routes actually live —
// e.g. inside an existing (dashboard)/teacher route group):
//   src/app/grading/speaking/[sessionId]/page.tsx
//
// Server component: triggers analysis (if needed) then renders the client
// panel with the fully-resolved DTO as its initial prop, so first paint has
// real data and no client-side loading spinner for the common case.

import { notFound } from "next/navigation";
import { getSpeakingMockSessionForReview } from "@/app/actions/speaking-grading-review";
import { SpeakingReviewPanel } from "@/components/speaking-review/SpeakingReviewPanel";

export default async function SpeakingGradingPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  // getSpeakingMockSessionForReview lazily runs ensureAttemptReviewData for
  // any un-analyzed attempt before returning, so this can be slow on first
  // open (transcription + provider call per attempt). If that's too slow
  // for a page load in practice, switch to:
  //   1. render an initial "Analyzing…" state with segments/marks empty,
  //   2. client-side POST /api/speaking-grading/[sessionId]/analyze on
  //      mount, then re-fetch via a thin GET wrapper around the same
  //      action.
  const result = await getSpeakingMockSessionForReview(sessionId);
  if (!result.success) notFound();

  return (
    <div style={{ height: "100vh" }}>
      <SpeakingReviewPanel initial={result.data} />
    </div>
  );
}
