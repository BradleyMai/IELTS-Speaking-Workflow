"use client";

// Drop-in path: src/components/speaking-review/SpeakingReviewPanel.tsx
//
// React port of the static speaking-chunks mock, wired to real data:
//  - real <audio> playback per attempt (each SpeakingAttempt is its own
//    recording — there's no single continuous file per part, so unlike the
//    mock, the timeline/playhead operate on ONE attempt's audio at a time;
//    switching questions within a part swaps the <audio> src)
//  - a real decoded waveform (useAudioWaveform) instead of the mock's fake
//    sine-wave bars
//  - AI marks/bands come from the server (already seeded by the pipeline
//    before this component ever mounts — see the page example at the
//    bottom of this file's sibling route)
//  - every mutation (band edits, keep/dismiss, teacher marks, notes,
//    finalize) calls the server actions in
//    src/app/actions/speaking-grading-review.ts, optimistically updated
//    locally first
//
// This is close to production-ready but written without your exact
// toast/keyboard-shortcut/dashboard-layout conventions in view — treat it as
// a strong first draft to adjust to house style rather than a final PR.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./SpeakingReviewPanel.module.css";
import { useAudioWaveform } from "./useAudioWaveform";
import {
  addSpeakingTeacherMark,
  copyPreviousAttemptReviewBands,
  finalizeSpeakingMockSessionReview,
  saveSpeakingAttemptReviewBands,
  saveSpeakingAttemptReviewNote,
  setSpeakingMarkStatus,
} from "@/app/actions/speaking-grading-review";
import {
  averageBandSet,
  CRITERION_LABEL,
  isBandSetComplete,
  REVIEW_CRITERIA,
  type SpeakingBandSet,
  type SpeakingMockSessionReviewDTO,
  type SpeakingReviewAttempt,
  type SpeakingReviewChunk,
  type SpeakingReviewCriterion,
  type SpeakingReviewMark,
} from "@/types/speaking-review";

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
}

function chunkAverage(chunk: SpeakingReviewChunk): number | null {
  const vals = chunk.attempts.map((a) => a.reviewBands.overallBand).filter((v): v is number => v !== null);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 2) / 2;
}
function chunkGraded(chunk: SpeakingReviewChunk): boolean {
  return chunk.attempts.every((a) => isBandSetComplete(a.reviewBands));
}

type SegmentPart = { text: string; mark: SpeakingReviewMark | null };

function splitSegmentByMarks(segmentText: string, marks: SpeakingReviewMark[]): SegmentPart[] {
  const candidates = marks
    .filter((m) => m.source === "ai" && m.status !== "dismissed")
    .map((m) => {
      const idx = segmentText.toLowerCase().indexOf(m.originalText.toLowerCase());
      return idx === -1 ? null : { mark: m, start: idx, end: idx + m.originalText.length };
    })
    .filter((x): x is { mark: SpeakingReviewMark; start: number; end: number } => x !== null)
    .sort((a, b) => a.start - b.start);

  const parts: SegmentPart[] = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.start < cursor) continue; // overlap — skip, keep first match
    if (c.start > cursor) parts.push({ text: segmentText.slice(cursor, c.start), mark: null });
    parts.push({ text: segmentText.slice(c.start, c.end), mark: c.mark });
    cursor = c.end;
  }
  if (cursor < segmentText.length) parts.push({ text: segmentText.slice(cursor), mark: null });
  return parts.length ? parts : [{ text: segmentText, mark: null }];
}

export function SpeakingReviewPanel({ initial }: { initial: SpeakingMockSessionReviewDTO }) {
  const [data, setData] = useState(initial);
  const [ci, setCi] = useState(0);
  const [ai, setAi] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [rate, setRate] = useState(1);
  const [nowMarkId, setNowMarkId] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [footerStatus, setFooterStatus] = useState<{ text: string; warn: boolean }>({
    text: "Grade each chunk. The test band rolls up from all three.",
    warn: false,
  });

  const audioRef = useRef<HTMLAudioElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bandSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `pos` updates on every <audio> timeupdate tick (several times a second
  // during playback) — mirror it into a ref so the keydown effect below
  // doesn't have to re-subscribe its listener that often. Read
  // `posRef.current` (not `pos`) anywhere inside that handler's call graph.
  const posRef = useRef(0);

  const chunk = data.chunks[ci];
  const attempt: SpeakingReviewAttempt | undefined = chunk?.attempts[ai];
  const peaks = useAudioWaveform(attempt?.audioUrl ?? null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 1400);
  }, []);

  // ---- attempt switching / audio wiring -----------------------------------

  useEffect(() => {
    setPos(0);
    setPlaying(false);
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
  }, [attempt?.id]);

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.play().catch(() => toast("Couldn't play this recording"));
    }
  }

  function seekTo(t: number, autoplay = false) {
    const el = audioRef.current;
    if (!el || !attempt) return;
    el.currentTime = Math.max(0, Math.min(attempt.durationSeconds, t));
    setPos(el.currentTime);
    if (autoplay && !playing) el.play().catch(() => {});
  }

  // ---- "now" panel: nearest pending AI mark the playhead just passed -----

  const pendingAiMarks = useMemo(
    () => (attempt?.marks ?? []).filter((m) => m.source === "ai" && m.status === "pending"),
    [attempt],
  );

  useEffect(() => {
    if (!playing) return;
    const near = pendingAiMarks
      .filter((m) => m.timeSeconds <= pos + 2 && m.timeSeconds >= pos - 7)
      .sort((a, b) => a.timeSeconds - b.timeSeconds)[0];
    setNowMarkId(near ? near.id : null);
  }, [pos, playing, pendingAiMarks]);

  const nowMark = pendingAiMarks.find((m) => m.id === nowMarkId) ?? null;

  // ---- mutations (optimistic) ---------------------------------------------

  // `patch` may be a plain object or a function of the attempt's *current*
  // state (from inside the setData updater) — always use the function form
  // when the new value depends on the old one (e.g. appending to `marks`),
  // since `attempt`/`chunk` in this closure can be stale by the time an
  // async call (like addSpeakingTeacherMark below) resolves.
  function updateAttempt(
    attemptId: string,
    patch: Partial<SpeakingReviewAttempt> | ((prev: SpeakingReviewAttempt) => Partial<SpeakingReviewAttempt>),
  ) {
    setData((d) => ({
      ...d,
      chunks: d.chunks.map((c) => ({
        ...c,
        attempts: c.attempts.map((a) => {
          if (a.id !== attemptId) return a;
          const resolved = typeof patch === "function" ? patch(a) : patch;
          return { ...a, ...resolved };
        }),
      })),
    }));
  }

  function updateMark(attemptId: string, markId: string, patch: Partial<SpeakingReviewMark>) {
    updateAttempt(attemptId, (prev) => ({
      marks: prev.marks.map((m) => (m.id === markId ? { ...m, ...patch } : m)),
    }));
  }

  function keepMark() {
    if (!nowMark || !attempt) return;
    updateMark(attempt.id, nowMark.id, { status: "kept" });
    setNowMarkId(null);
    void setSpeakingMarkStatus({ markId: nowMark.id, status: "kept" });
    toast("Kept");
  }
  function dismissMark() {
    if (!nowMark || !attempt) return;
    updateMark(attempt.id, nowMark.id, { status: "dismissed" });
    setNowMarkId(null);
    void setSpeakingMarkStatus({ markId: nowMark.id, status: "dismissed" });
    toast("Deleted");
  }

  function dropMark(category: (typeof CRITERION_LABEL)[SpeakingReviewCriterion]) {
    if (!attempt) return;
    const t = posRef.current;
    const tempId = `pending-${Date.now()}`;
    const optimistic: SpeakingReviewMark = {
      id: tempId,
      attemptId: attempt.id,
      source: "teacher",
      category,
      timeSeconds: t,
      originalText: `marked at ${fmt(t)}`,
      suggestedFix: null,
      status: "kept",
    };
    updateAttempt(attempt.id, (prev) => ({ marks: [...prev.marks, optimistic] }));
    toast(`${category} at ${fmt(t)}`);
    addSpeakingTeacherMark({ attemptId: attempt.id, category, timeSeconds: t }).then((res) => {
      if (res.success) {
        updateAttempt(attempt.id, (prev) => ({
          marks: prev.marks.map((m) => (m.id === tempId ? res.mark : m)),
        }));
      }
    });
  }

  function setBand(key: SpeakingReviewCriterion, raw: string) {
    if (!attempt) return;
    const v = raw === "" ? null : Math.max(1, Math.min(9, parseFloat(raw)));
    const bands: SpeakingBandSet = { ...attempt.reviewBands, [key]: v };
    bands.overallBand = averageBandSet(bands);
    updateAttempt(attempt.id, { reviewBands: bands });

    if (bandSaveTimer.current) clearTimeout(bandSaveTimer.current);
    bandSaveTimer.current = setTimeout(() => {
      void saveSpeakingAttemptReviewBands({ attemptId: attempt.id, bands: { [key]: v } });
    }, 300);
  }

  function bump(key: SpeakingReviewCriterion, delta: number) {
    if (!attempt) return;
    const current = attempt.reviewBands[key] ?? attempt.aiBands[key] ?? 6;
    setBand(key, (Math.max(1, Math.min(9, current + delta))).toFixed(1));
  }

  function saveNote(attemptId: string, note: string) {
    updateAttempt(attemptId, { note });
    if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = setTimeout(() => {
      void saveSpeakingAttemptReviewNote({ attemptId, note });
    }, 500);
  }

  function draftNote() {
    if (!attempt) return;
    const kept = attempt.marks.filter((m) => m.status === "kept");
    const g = kept.filter((m) => m.category === "Grammar").length;
    const l = kept.filter((m) => m.category === "Lexical").length;
    const note = `On ${chunk.label.split("·")[1]?.trim() ?? chunk.label}: ideas came through clearly. ${g} grammar and ${l} word-choice marks. Fix that habit and this part moves up half a band.`;
    saveNote(attempt.id, note);
    toast("Drafted from your marks");
  }

  async function copyPrev() {
    const flat = data.chunks.flatMap((c) => c.attempts);
    const idx = flat.findIndex((a) => a.id === attempt?.id);
    const prev = idx > 0 ? flat[idx - 1] : null;
    if (!prev || !attempt) return;
    if (!isBandSetComplete(prev.reviewBands)) {
      toast("Previous answer is not graded yet");
      return;
    }
    updateAttempt(attempt.id, { reviewBands: prev.reviewBands });
    const res = await copyPreviousAttemptReviewBands({ fromAttemptId: prev.id, toAttemptId: attempt.id });
    if (res.success) toast("Copied from previous answer");
  }

  async function finish() {
    const ungraded = data.chunks.filter((c) => !chunkGraded(c));
    if (ungraded.length) {
      setFooterStatus({
        text: `${ungraded.length} chunk${ungraded.length > 1 ? "s" : ""} still ungraded: ${ungraded
          .map((c) => c.label.split("·")[0]?.trim())
          .join(", ")}.`,
        warn: true,
      });
      setCi(data.chunks.indexOf(ungraded[0]));
      setAi(0);
      return;
    }
    const res = await finalizeSpeakingMockSessionReview(data.sessionId);
    if (res.success && res.ungraded.length === 0) {
      setData((d) => ({ ...d, status: "returned", overallBand: res.overallBand }));
      setFooterStatus({
        text: `Returned to ${data.studentName} · test band ${res.overallBand?.toFixed(1) ?? "—"}`,
        warn: false,
      });
      toast("Returned to student");
    } else if (!res.success) {
      toast(res.error);
    }
  }

  // ---- keyboard shortcuts ---------------------------------------------

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (tag === "TEXTAREA") {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void finish();
        }
        return;
      }
      if (tag === "INPUT" && !["Tab", "Escape"].includes(e.key)) return;

      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void finish();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setCi((c) => (c + 1) % data.chunks.length);
        setAi(0);
        return;
      }
      if (k === " ") {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setAi((v) => Math.max(0, v - 1));
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setAi((v) => Math.min((chunk?.attempts.length ?? 1) - 1, v + 1));
        return;
      }
      if ("flgp".includes(k)) {
        e.preventDefault();
        dropMark(({ f: "Fluency", l: "Lexical", g: "Grammar", p: "Pronunciation" } as const)[k as "f" | "l" | "g" | "p"]);
        return;
      }
      if (k === "y" && nowMark) {
        e.preventDefault();
        keepMark();
        return;
      }
      if (k === "x" && nowMark) {
        e.preventDefault();
        dismissMark();
        return;
      }
      if (k >= "1" && k <= "3") {
        e.preventDefault();
        setCi(Number(k) - 1);
        setAi(0);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk, nowMark]);

  if (!chunk || !attempt) {
    return <div className={styles.wrap}>No speaking attempts on this session yet.</div>;
  }

  const overallLive = (() => {
    const vals = data.chunks.map(chunkAverage).filter((v): v is number => v !== null);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 2) / 2 : null;
  })();

  return (
    <div className={styles.wrap}>
      <div className={`${styles.hbar} ${styles.panel} ${styles.row}`}>
        <div className={styles.av}>
          {data.studentName.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
        </div>
        <div className={styles.who}>
          <strong>{data.studentName}</strong>
          <span className={styles.eb}>{data.studentEmail} · Full speaking test</span>
        </div>
        <div className={styles.sp} />
        <span className={`${styles.tag} ${styles.tagB}`}>{data.status === "returned" ? "Returned" : "In review"}</span>
        <span className={`${styles.tag} ${styles.tagY}`}>
          {pendingAiMarks.length ? `${pendingAiMarks.length} AI marks` : "all reviewed"}
        </span>
      </div>

      <div className={styles.chunks}>
        {data.chunks.map((c, i) => (
          <button
            key={c.part}
            className={`${styles.ch} ${i === ci ? styles.chCurrent : ""}`}
            onClick={() => {
              setCi(i);
              setAi(0);
            }}
          >
            <span className={styles.chTitle}>{c.label}</span>
            <span className={styles.chMeta}>
              <span>{c.attempts.length} question{c.attempts.length === 1 ? "" : "s"}</span>
              <span className={`${styles.pip} ${chunkGraded(c) ? styles.pipDone : ""}`} />
              <span>{chunkGraded(c) ? `band ${chunkAverage(c)?.toFixed(1)}` : "not graded"}</span>
            </span>
          </button>
        ))}
      </div>

      <div className={styles.main}>
        <div className={styles.left}>
          <div className={`${styles.tlpanel} ${styles.panel}`}>
            <div className={styles.row}>
              <span className={styles.eb}>{chunk.label}</span>
              <div className={styles.sp} />
              <span className={`${styles.eb} ${styles.mono}`}>
                {fmt(pos)} / {fmt(attempt.durationSeconds)}
              </span>
            </div>

            <Waveform
              peaks={peaks}
              marks={attempt.marks.filter((m) => m.status !== "dismissed")}
              duration={attempt.durationSeconds || 1}
              pos={pos}
              onSeek={(t) => seekTo(t)}
            />

            {chunk.attempts.length > 1 && (
              <div className={styles.qlab}>
                {chunk.attempts.map((a, i) => (
                  <span key={a.id} style={{ flex: 1 }} className={i === ai ? styles.qlabLive : ""}>
                    Q{i + 1}
                  </span>
                ))}
              </div>
            )}

            <div className={styles.ctl}>
              <button className={styles.play} onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                <svg viewBox="0 0 24 24">
                  {playing ? (
                    <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" />
                  ) : (
                    <path d="M8 5v14l11-7z" fill="currentColor" />
                  )}
                </svg>
              </button>
              <div className={styles.tspd} role="group" aria-label="Speed">
                {[1, 1.25, 1.5, 2].map((r) => (
                  <button key={r} className={rate === r ? styles.tspdActive : ""} onClick={() => setRate(r)}>
                    {r}×
                  </button>
                ))}
              </div>
              <div className={styles.sp} />
              <div className={styles.keys}>
                <button className={`${styles.kbtn} ${styles.kbtnF}`} onClick={() => dropMark("Fluency")}>F</button>
                <button className={`${styles.kbtn} ${styles.kbtnL}`} onClick={() => dropMark("Lexical")}>L</button>
                <button className={`${styles.kbtn} ${styles.kbtnG}`} onClick={() => dropMark("Grammar")}>G</button>
                <button className={`${styles.kbtn} ${styles.kbtnP}`} onClick={() => dropMark("Pronunciation")}>P</button>
              </div>
            </div>

            <audio
              ref={audioRef}
              src={attempt.audioUrl ?? undefined}
              onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              preload="metadata"
              style={{ display: "none" }}
            />
          </div>

          <div className={`${styles.deck} ${styles.panel}`}>
            <div className={styles.dhead}>
              <div className={styles.dots}>
                {chunk.attempts.map((a, i) => (
                  <button
                    key={a.id}
                    className={`${styles.dot} ${i === ai ? styles.dotCurrent : ""} ${
                      isBandSetComplete(a.reviewBands) ? styles.dotMarked : ""
                    }`}
                    onClick={() => setAi(i)}
                  >
                    {chunk.attempts.length > 1 ? i + 1 : "▸"}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <span className={styles.eb}>
                  {chunk.attempts.length > 1 ? `Answer ${ai + 1} of ${chunk.attempts.length}` : "Long turn"}
                </span>
                <h2>{attempt.question}</h2>
              </div>
            </div>

            <div className={styles.dbody}>
              {attempt.segments.map((seg) => {
                const isLive =
                  playing && pos >= seg.startSeconds && (seg.endSeconds === null || pos < seg.endSeconds);
                const parts = splitSegmentByMarks(seg.text, attempt.marks);
                return (
                  <span
                    key={seg.id}
                    className={`${styles.seg} ${isLive ? styles.segLive : ""}`}
                    onClick={() => seekTo(seg.startSeconds)}
                  >
                    <span className={`${styles.ts} ${styles.mono}`}>{fmt(seg.startSeconds)}</span>
                    {parts.map((p, i) =>
                      p.mark ? (
                        <mark
                          key={i}
                          className={p.mark.source === "ai" ? styles.markAi : styles.markMe}
                          onClick={(e) => {
                            e.stopPropagation();
                            seekTo(Math.max(0, p.mark!.timeSeconds - 2));
                          }}
                        >
                          {p.text}
                        </mark>
                      ) : (
                        <span key={i}>{p.text}</span>
                      ),
                    )}
                  </span>
                );
              })}
              {!attempt.analyzed && (
                <p className={styles.eb} style={{ marginTop: 8 }}>
                  Not analyzed yet — transcript timing and AI marks will appear once the analysis job finishes.
                </p>
              )}
            </div>

            <div className={styles.dfoot}>
              <span className={styles.chip}>{fmt(attempt.durationSeconds)}</span>
              <span className={styles.chip}>{attempt.transcript.split(/\s+/).filter(Boolean).length} words</span>
              <span className={styles.chip}>
                {attempt.durationSeconds
                  ? Math.round((attempt.transcript.split(/\s+/).filter(Boolean).length / attempt.durationSeconds) * 60)
                  : 0}{" "}
                wpm
              </span>
              <div className={styles.sp} />
              <button className={`${styles.btn} ${styles.btnSm}`} onClick={() => setAi((v) => Math.max(0, v - 1))}>
                ‹
              </button>
              <button
                className={`${styles.btn} ${styles.btnSm}`}
                onClick={() => setAi((v) => Math.min(chunk.attempts.length - 1, v + 1))}
              >
                ›
              </button>
            </div>
          </div>
        </div>

        <aside className={styles.rail}>
          <div className={`${styles.bands} ${styles.panel}`}>
            <div className={styles.row}>
              <span className={styles.eb}>Bands for this answer</span>
            </div>
            {REVIEW_CRITERIA.map((key) => {
              const cls = { fluency: "F", lexicalResource: "L", grammar: "G", pronunciation: "P" }[key];
              const slotClass = { F: styles.slotF, L: styles.slotL, G: styles.slotG, P: styles.slotP }[cls];
              const v = attempt.reviewBands[key];
              const a = attempt.aiBands[key];
              let hint: string;
              if (a === null || a === undefined) hint = v === null ? "no AI" : "yours";
              else if (v === a) hint = `AI ${a.toFixed(1)}`;
              else if (v === null) hint = `AI ${a.toFixed(1)}`;
              else hint = `was ${a.toFixed(1)}`;
              const edited = v !== null && a !== null && a !== undefined && v !== a;
              return (
                <div className={`${styles.slot} ${slotClass}`} key={key}>
                  <div className={styles.slotL1}>
                    <span className={styles.slotNm}>{CRITERION_LABEL[key]}</span>
                    <div className={styles.stepper}>
                      <button onClick={() => bump(key, -0.5)} aria-label={`Lower ${key}`}>
                        −
                      </button>
                      <input
                        inputMode="decimal"
                        value={v === null ? "" : v.toFixed(1)}
                        placeholder="—"
                        onChange={(e) => setBand(key, e.target.value)}
                        aria-label={`${key} band`}
                      />
                      <button onClick={() => bump(key, 0.5)} aria-label={`Raise ${key}`}>
                        +
                      </button>
                    </div>
                  </div>
                  <span className={`${styles.aisaid} ${edited ? styles.aisaidEd : ""}`}>{hint}</span>
                </div>
              );
            })}
            <div className={styles.chunkband}>
              <div className={styles.cbbox}>
                <span className={styles.cbboxValue}>{attempt.reviewBands.overallBand?.toFixed(1) ?? "—"}</span>
              </div>
              <div style={{ flex: 1, minWidth: 90 }}>
                <span className={styles.eb}>This answer</span>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ink2)" }}>Averaged from the four.</div>
              </div>
              <button className={`${styles.btn} ${styles.btnSm}`} onClick={copyPrev}>
                Copy last
              </button>
            </div>
          </div>

          {nowMark && (
            <div className={`${styles.now} ${styles.panel}`}>
              <div className={styles.row}>
                <span className={styles.tag} style={{ background: "var(--ros)", color: "var(--rosi)" }}>
                  AI · {nowMark.category}
                </span>
                <span className={styles.mono} style={{ fontSize: 10.5, fontWeight: 700 }}>
                  {fmt(nowMark.timeSeconds)}
                </span>
              </div>
              <div className={styles.q}>&ldquo;{nowMark.originalText}&rdquo;</div>
              {nowMark.suggestedFix && (
                <div className={styles.fx}>
                  <b>Say it as</b>
                  {nowMark.suggestedFix}
                </div>
              )}
              <div className={styles.row} style={{ marginTop: 8 }}>
                <button className={`${styles.btn} ${styles.btnSm} ${styles.btnG}`} onClick={keepMark}>
                  Keep
                </button>
                <button className={`${styles.btn} ${styles.btnSm} ${styles.btnR}`} onClick={dismissMark}>
                  Delete
                </button>
                <button
                  className={`${styles.btn} ${styles.btnSm}`}
                  onClick={() => seekTo(Math.max(0, nowMark.timeSeconds - 2), true)}
                >
                  Replay
                </button>
              </div>
            </div>
          )}

          <div className={`${styles.notes} ${styles.panel}`}>
            <div className={styles.row}>
              <span className={styles.eb}>Note on this answer</span>
              <div className={styles.sp} />
              <button className={`${styles.btn} ${styles.btnSm}`} onClick={draftNote}>
                Draft
              </button>
            </div>
            <textarea
              value={attempt.note}
              onChange={(e) => saveNote(attempt.id, e.target.value)}
              placeholder="One or two sentences the student reads for this answer."
            />
          </div>
        </aside>
      </div>

      <div className={`${styles.foot} ${styles.panel}`}>
        <div className={styles.roll}>
          <span className={styles.eb}>Test overall</span>
          <span className={styles.mono} style={{ fontSize: 17, fontWeight: 800 }}>
            {overallLive?.toFixed(1) ?? "—"}
          </span>
        </div>
        <span className={styles.st} style={footerStatus.warn ? { color: "var(--rosi)" } : undefined}>
          {footerStatus.text}
        </span>
        <button
          className={styles.btn}
          onClick={() => {
            setCi((c) => (c + 1) % data.chunks.length);
            setAi(0);
          }}
        >
          Next chunk
        </button>
        <button className={`${styles.btn} ${styles.btnK}`} onClick={finish}>
          Return
        </button>
      </div>

      {toastMsg && <div className={`${styles.toast} ${styles.toastOn}`}>{toastMsg}</div>}
    </div>
  );
}

function Waveform({
  peaks,
  marks,
  duration,
  pos,
  onSeek,
}: {
  peaks: number[] | null;
  marks: SpeakingReviewMark[];
  duration: number;
  pos: number;
  onSeek: (t: number) => void;
}) {
  const width = 800;
  const height = 44;
  const bars = peaks ?? new Array(120).fill(0.25);
  const barW = width / bars.length;
  const playedX = (pos / duration) * width;

  return (
    <svg
      className={styles.tl}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Answer timeline"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - r.left) / r.width) * duration);
      }}
    >
      {bars.map((amp, i) => {
        const h = Math.max(2, amp * (height - 8));
        const x = i * barW + 1;
        return (
          <rect
            key={i}
            x={x}
            y={(height - h) / 2}
            width={Math.max(1, barW - 1.5)}
            height={h}
            rx={1.4}
            fill="#191509"
            opacity={0.5}
          />
        );
      })}
      {marks.map((m) => (
        <circle
          key={m.id}
          cx={(m.timeSeconds / duration) * width}
          cy={5}
          r={4.2}
          fill={m.source === "teacher" || m.status === "kept" ? "#DDEDDA" : "#F3D6D2"}
          stroke="#191509"
          strokeWidth={2}
        />
      ))}
      <rect x={0} y={1} width={playedX} height={height - 2} fill="#F3DA5F" opacity={0.38} />
      <line x1={playedX} y1={0} x2={playedX} y2={height} stroke="#191509" strokeWidth={2.5} />
    </svg>
  );
}
