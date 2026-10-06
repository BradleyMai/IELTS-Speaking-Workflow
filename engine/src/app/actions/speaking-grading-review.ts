"use server";

// Drop-in path: src/app/actions/speaking-grading-review.ts
//
// Server actions for the teacher-facing speaking review UI. Naming follows
// the existing convention (save*/get*/list*). Mirrors speaking-mock.ts's
// return shape: { success: true, ... } | { success: false; error: string }.
//
// AUTH TODO: `assertCanReviewSpeaking` below is a stub. Wire it to whatever
// your real per-skill/per-resource guard is — you described
// getAdminRoleByEmail / getViewerOrganizationId / canAccessWritingTask as
// the existing patterns; this should follow canAccessWritingTask's shape
// (role check + org-scope check that the attempt's student is in the
// reviewer's org) rather than a bare admin-email allowlist.

import { auth } from "@/lib/auth"; // adjust import path if different (your NextAuth v5 instance)
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import {
  averageBandSet,
  CRITERION_LABEL,
  emptyBandSet,
  isBandSetComplete,
  PART_LABELS,
  type SpeakingBandSet,
  type SpeakingMockSessionReviewDTO,
  type SpeakingReviewAttempt,
  type SpeakingReviewChunk,
  type SpeakingReviewCriterion,
  type SpeakingReviewMark,
  type SpeakingReviewPart,
} from "@/types/speaking-review";
import { ensureAttemptReviewData } from "@/lib/speaking-review/pipeline";
import { parseSpeakingFeedback } from "@/lib/speaking-review/feedback-json";

type ActionResult<T> = { success: true } & T | { success: false; error: string };

async function requireReviewer() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error("AUTH_REQUIRED");
  // TODO: replace with real role/org guard, e.g.:
  //   const role = await getAdminRoleByEmail(email);
  //   if (!role) throw new Error("FORBIDDEN");
  return { id: session!.user!.id as string, email };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getSpeakingMockSessionForReview(
  sessionId: string,
): Promise<ActionResult<{ data: SpeakingMockSessionReviewDTO }>> {
  try {
    const reviewer = await requireReviewer();

    const session = await prisma.speakingMockSession.findUnique({
      where: { id: sessionId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        attempts: { orderBy: [{ part: "asc" }, { createdAt: "asc" }] },
        review: true,
      },
    });
    if (!session) return { success: false, error: "Session not found" };

    // Lazily analyze any attempt that hasn't been touched yet. Sequential on
    // purpose — these calls hit the transcription provider chain, and
    // running 8-10 of them concurrently against HF/OpenAI is a good way to
    // get rate-limited. For a snappier first-open, trigger
    // POST /api/speaking-grading/[sessionId]/analyze from the client instead
    // and have this action just read whatever's there (see route.ts).
    for (const attempt of session.attempts) {
      await ensureAttemptReviewData(attempt.id, reviewer.id);
    }

    const attemptsFull = await prisma.speakingAttempt.findMany({
      where: { mockSessionId: sessionId },
      orderBy: [{ part: "asc" }, { createdAt: "asc" }],
      include: {
        transcriptSegments: { orderBy: { order: "asc" } },
        marks: true,
        review: true,
      },
    });

    const chunkMap = new Map<SpeakingReviewPart, SpeakingReviewAttempt[]>();
    for (const a of attemptsFull) {
      const part = normalizePart(a.part);
      const feedback = parseSpeakingFeedback(a.feedbackJson);
      const aiBands: SpeakingBandSet = feedback
        ? bandsFromRubric(feedback)
        : { ...emptyBandSet(), overallBand: a.overallBand ?? null };

      const reviewBands: SpeakingBandSet = a.review
        ? {
            fluency: a.review.fluency,
            lexicalResource: a.review.lexicalResource,
            grammar: a.review.grammar,
            pronunciation: a.review.pronunciation,
            overallBand: a.review.overallBand,
          }
        : emptyBandSet();

      const dto: SpeakingReviewAttempt = {
        id: a.id,
        part,
        question: a.question,
        transcript: a.transcript,
        audioUrl: a.audioUrl,
        durationSeconds: a.durationSeconds,
        aiBands,
        reviewBands,
        note: a.review?.note ?? "",
        reviewStatus: (a.review?.status as "draft" | "final") ?? "draft",
        segments: a.transcriptSegments.map((s) => ({
          id: s.id,
          startSeconds: s.startSeconds,
          endSeconds: s.endSeconds,
          text: s.text,
        })),
        marks: a.marks.map(toMarkDTO),
        analyzed: a.transcriptSegments.length > 0,
      };
      const list = chunkMap.get(part) ?? [];
      list.push(dto);
      chunkMap.set(part, list);
    }

    const chunks: SpeakingReviewChunk[] = (["part-1", "part-2", "part-3"] as const)
      .filter((p) => chunkMap.has(p))
      .map((p) => ({ part: p, label: PART_LABELS[p], attempts: chunkMap.get(p)! }));

    const chunkAverages = chunks
      .map((c) => averageAcrossAttempts(c.attempts))
      .filter((v): v is number => v !== null);
    const overallBand = chunkAverages.length
      ? Math.round((chunkAverages.reduce((a, b) => a + b, 0) / chunkAverages.length) * 2) / 2
      : null;

    return {
      success: true,
      data: {
        sessionId: session.id,
        studentId: session.user.id,
        studentName: session.user.name ?? session.user.email ?? "Student",
        studentEmail: session.user.email ?? "",
        status: (session.review?.status as "in_progress" | "returned") ?? "in_progress",
        overallBand,
        chunks,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function saveSpeakingAttemptReviewBands(input: {
  attemptId: string;
  bands: Partial<Record<SpeakingReviewCriterion, number | null>>;
}): Promise<ActionResult<{}>> {
  try {
    const reviewer = await requireReviewer();
    const existing = await prisma.speakingAttemptReview.findUnique({ where: { attemptId: input.attemptId } });
    const merged: SpeakingBandSet = {
      fluency: input.bands.fluency ?? existing?.fluency ?? null,
      lexicalResource: input.bands.lexicalResource ?? existing?.lexicalResource ?? null,
      grammar: input.bands.grammar ?? existing?.grammar ?? null,
      pronunciation: input.bands.pronunciation ?? existing?.pronunciation ?? null,
      overallBand: null,
    };
    merged.overallBand = averageBandSet(merged);

    await prisma.speakingAttemptReview.upsert({
      where: { attemptId: input.attemptId },
      create: { attemptId: input.attemptId, reviewerId: reviewer.id, ...merged },
      update: { ...merged },
    });
    revalidatePath(`/grading/speaking`); // adjust to your actual review route
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function saveSpeakingAttemptReviewNote(input: {
  attemptId: string;
  note: string;
}): Promise<ActionResult<{}>> {
  try {
    const reviewer = await requireReviewer();
    await prisma.speakingAttemptReview.upsert({
      where: { attemptId: input.attemptId },
      create: { attemptId: input.attemptId, reviewerId: reviewer.id, note: input.note },
      update: { note: input.note },
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function setSpeakingMarkStatus(input: {
  markId: string;
  status: "kept" | "dismissed";
}): Promise<ActionResult<{}>> {
  try {
    await requireReviewer();
    await prisma.speakingAttemptMark.update({
      where: { id: input.markId },
      data: { status: input.status },
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function addSpeakingTeacherMark(input: {
  attemptId: string;
  category: (typeof CRITERION_LABEL)[SpeakingReviewCriterion];
  timeSeconds: number;
}): Promise<ActionResult<{ mark: SpeakingReviewMark }>> {
  try {
    await requireReviewer();
    const row = await prisma.speakingAttemptMark.create({
      data: {
        attemptId: input.attemptId,
        source: "teacher",
        category: input.category,
        timeSeconds: Math.max(0, input.timeSeconds),
        originalText: `marked at ${Math.round(input.timeSeconds)}s`,
        suggestedFix: null,
        status: "kept",
      },
    });
    return { success: true, mark: toMarkDTO(row) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function copyPreviousAttemptReviewBands(input: {
  fromAttemptId: string;
  toAttemptId: string;
}): Promise<ActionResult<{ bands: SpeakingBandSet }>> {
  try {
    const reviewer = await requireReviewer();
    const from = await prisma.speakingAttemptReview.findUnique({ where: { attemptId: input.fromAttemptId } });
    if (!from || !isBandSetComplete(from)) {
      return { success: false, error: "Previous attempt is not fully graded yet" };
    }
    const bands: SpeakingBandSet = {
      fluency: from.fluency,
      lexicalResource: from.lexicalResource,
      grammar: from.grammar,
      pronunciation: from.pronunciation,
      overallBand: from.overallBand,
    };
    await prisma.speakingAttemptReview.upsert({
      where: { attemptId: input.toAttemptId },
      create: { attemptId: input.toAttemptId, reviewerId: reviewer.id, ...bands },
      update: { ...bands },
    });
    return { success: true, bands };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function finalizeSpeakingMockSessionReview(
  sessionId: string,
): Promise<ActionResult<{ overallBand: number | null; ungraded: string[] }>> {
  try {
    const reviewer = await requireReviewer();

    const attempts = await prisma.speakingAttempt.findMany({
      where: { mockSessionId: sessionId },
      include: { review: true },
    });

    const ungraded = attempts
      .filter((a) => {
        const b: SpeakingBandSet = {
          fluency: a.review?.fluency ?? null,
          lexicalResource: a.review?.lexicalResource ?? null,
          grammar: a.review?.grammar ?? null,
          pronunciation: a.review?.pronunciation ?? null,
          overallBand: a.review?.overallBand ?? null,
        };
        return !isBandSetComplete(b);
      })
      .map((a) => a.id);

    if (ungraded.length) {
      return { success: true, overallBand: null, ungraded };
    }

    const chunkAverages = attempts
      .map((a) => a.review?.overallBand ?? null)
      .filter((v): v is number => v !== null);
    const overallBand = chunkAverages.length
      ? Math.round((chunkAverages.reduce((a, b) => a + b, 0) / chunkAverages.length) * 2) / 2
      : null;

    await prisma.$transaction([
      ...attempts.map((a) =>
        prisma.speakingAttemptReview.update({
          where: { attemptId: a.id },
          data: { status: "final", finalizedAt: new Date() },
        }),
      ),
      // Sync the teacher's finalized bands back onto SpeakingAttempt itself,
      // since that's the field the rest of the app (student dashboard,
      // aggregateSpeakingMockScores, etc.) already reads. This intentionally
      // overwrites the AI's original draft score — it's still recoverable
      // from feedbackJson and from SpeakingAttemptReview's own history.
      ...attempts.map((a) =>
        prisma.speakingAttempt.update({
          where: { id: a.id },
          data: {
            fluency: a.review!.fluency,
            lexicalResource: a.review!.lexicalResource,
            grammar: a.review!.grammar,
            pronunciation: a.review!.pronunciation,
            overallBand: a.review!.overallBand,
          },
        }),
      ),
      prisma.speakingMockSessionReview.upsert({
        where: { sessionId },
        create: { sessionId, reviewerId: reviewer.id, status: "returned", overallBand, returnedAt: new Date() },
        update: { status: "returned", overallBand, returnedAt: new Date() },
      }),
      prisma.speakingMockSession.update({
        where: { id: sessionId },
        data: { overallBand },
      }),
    ]);

    revalidatePath(`/grading/speaking`); // adjust to your actual review route
    return { success: true, overallBand, ungraded: [] };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizePart(raw: string): SpeakingReviewPart {
  const m = /^part(\d)$/.exec(raw.replace("-", ""));
  const n = m ? m[1] : raw.replace(/[^0-9]/g, "") || "1";
  return (`part-${n}` as SpeakingReviewPart) in PART_LABELS ? (`part-${n}` as SpeakingReviewPart) : "part-1";
}

function bandsFromRubric(feedback: { rubric: { score: number | null }[] }): SpeakingBandSet {
  const [f, l, g, p] = feedback.rubric ?? [];
  const bands: SpeakingBandSet = {
    fluency: f?.score ?? null,
    lexicalResource: l?.score ?? null,
    grammar: g?.score ?? null,
    pronunciation: p?.score ?? null,
    overallBand: null,
  };
  bands.overallBand = averageBandSet(bands);
  return bands;
}

function averageAcrossAttempts(attempts: SpeakingReviewAttempt[]): number | null {
  const values = attempts.map((a) => a.reviewBands.overallBand).filter((v): v is number => v !== null);
  if (!values.length) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 2) / 2;
}

function toMarkDTO(row: {
  id: string;
  attemptId: string;
  source: string;
  category: string;
  timeSeconds: number;
  originalText: string;
  suggestedFix: string | null;
  status: string;
}): SpeakingReviewMark {
  return {
    id: row.id,
    attemptId: row.attemptId,
    source: row.source as "ai" | "teacher",
    category: row.category as SpeakingReviewMark["category"],
    timeSeconds: row.timeSeconds,
    originalText: row.originalText,
    suggestedFix: row.suggestedFix,
    status: row.status as SpeakingReviewMark["status"],
  };
}
