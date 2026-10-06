// Drop-in path: src/app/api/speaking-grading/[sessionId]/analyze/route.ts
//
// Heavy job route (transcription + AI marks/bands), following your existing
// split: cheap CRUD via server actions, expensive AI work via api/* with a
// longer maxDuration and rate limiting. Call this once when the review UI
// opens a session; getSpeakingMockSessionForReview then just reads whatever
// this produced.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth"; // adjust import path if different
import { prisma } from "@/lib/prisma";
import { ensureAttemptReviewData } from "@/lib/speaking-review/pipeline";
import { Ratelimit } from "@upstash/ratelimit"; // adjust to your actual Upstash wrapper/import
import { Redis } from "@upstash/redis";

export const runtime = "nodejs";
export const maxDuration = 60;

// Mirror whatever helper you already use to build a limiter elsewhere
// (grade-writing, audio upload, transcription routes) rather than
// constructing Redis/Ratelimit inline here — this is just illustrative of
// the fail-open pattern you described.
async function checkRateLimit(key: string): Promise<{ ok: boolean }> {
  if (!process.env.RATE_LIMIT_URL || !process.env.RATE_LIMIT_TOKEN) return { ok: true };
  try {
    const redis = new Redis({ url: process.env.RATE_LIMIT_URL, token: process.env.RATE_LIMIT_TOKEN });
    const limiter = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, "60 s") });
    const { success } = await limiter.limit(key);
    return { ok: success };
  } catch {
    return { ok: true }; // fail-open, matching your existing convention
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Not authenticated", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  // TODO: real role/org guard here (see requireReviewer TODO in
  // speaking-grading-review.ts) — this route currently only checks login.

  const rate = await checkRateLimit(`speaking-review-analyze:${email}`);
  if (!rate.ok) {
    return NextResponse.json({ error: "Too many requests", code: "RATE_LIMITED" }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }

  const attempts = await prisma.speakingAttempt.findMany({
    where: { mockSessionId: sessionId },
    select: { id: true },
  });
  if (!attempts.length) {
    return NextResponse.json({ error: "Session not found or has no attempts", code: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const results = { analyzed: 0, failed: [] as string[] };
  // Sequential: each call may hit the HF Whisper transcription leg, and
  // running these concurrently risks tripping provider-side rate limits.
  for (const a of attempts) {
    try {
      await ensureAttemptReviewData(a.id, session!.user!.id as string);
      results.analyzed += 1;
    } catch (err) {
      results.failed.push(a.id);
      console.error(`[speaking-grading/analyze] attempt ${a.id} failed`, err);
    }
  }

  return NextResponse.json(
    { sessionId, ...results },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
