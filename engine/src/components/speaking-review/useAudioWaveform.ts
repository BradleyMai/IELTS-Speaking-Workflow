"use client";

// Drop-in path: src/components/speaking-review/useAudioWaveform.ts
//
// Decodes the attempt's real audio (fetched from Vercel Blob / the local
// speaking-audio fallback route) into a peak array via Web Audio, so the
// timeline can draw a real waveform instead of the original mock's
// sine-wave placeholder bars. Falls back to `null` peaks (flat bars) on any
// failure — CORS, decode error, unsupported format — so the UI stays
// functional either way.

import { useEffect, useRef, useState } from "react";

const BUCKETS = 180;
const cache = new Map<string, number[]>();

export function useAudioWaveform(audioUrl: string | null): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(audioUrl ? cache.get(audioUrl) ?? null : null);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!audioUrl) {
      setPeaks(null);
      return;
    }
    const cached = cache.get(audioUrl);
    if (cached) {
      setPeaks(cached);
      return;
    }
    let cancelled = false;
    setPeaks(null);

    (async () => {
      try {
        const res = await fetch(audioUrl);
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const buf = await res.arrayBuffer();
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) throw new Error("no AudioContext");
        const ctx = ctxRef.current ?? new Ctx();
        ctxRef.current = ctx;
        const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
        if (cancelled) return;
        const data = audioBuffer.getChannelData(0);
        const bucketSize = Math.max(1, Math.floor(data.length / BUCKETS));
        const result: number[] = [];
        for (let i = 0; i < BUCKETS; i++) {
          const start = i * bucketSize;
          let max = 0;
          for (let j = start; j < start + bucketSize && j < data.length; j++) {
            const v = Math.abs(data[j]);
            if (v > max) max = v;
          }
          result.push(max);
        }
        cache.set(audioUrl, result);
        if (!cancelled) setPeaks(result);
      } catch {
        if (!cancelled) setPeaks(null); // caller renders flat placeholder bars
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [audioUrl]);

  useEffect(() => {
    return () => {
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  return peaks;
}
