import express from "express";
import cors from "cors";
import { PLAYLIST_URL, TRACKS } from "./radioConfig.js";

const app = express();
app.use(cors());

const loopDurationMs = TRACKS.reduce((acc, t) => acc + t.durationMs, 0);
const radioStart = Date.now();
const radioOffsetMs =
  loopDurationMs > 0 ? Math.floor(Math.random() * loopDurationMs) : 0;
const INTRO_SKIP_MS = 60 * 1000;

function getRadioState(nowMs) {
  if (!Number.isFinite(loopDurationMs) || loopDurationMs <= 0) {
    return {
      trackIndex: 0,
      positionMs: 0,
      trackTitle: TRACKS[0]?.title ?? "Unknown",
    };
  }

  const elapsed =
    (nowMs - radioStart + radioOffsetMs + loopDurationMs) % loopDurationMs;
  let acc = 0;

  for (const track of TRACKS) {
    const nextAcc = acc + track.durationMs;
    if (elapsed < nextAcc) {
      let positionMs = elapsed - acc;

      if (positionMs < INTRO_SKIP_MS && track.durationMs > INTRO_SKIP_MS * 2) {
        const maxJoin =
          track.durationMs - INTRO_SKIP_MS > INTRO_SKIP_MS
            ? track.durationMs - INTRO_SKIP_MS
            : track.durationMs - INTRO_SKIP_MS / 2;
        const span = Math.max(0, maxJoin - INTRO_SKIP_MS);
        const extra = span > 0 ? Math.floor(Math.random() * span) : 0;
        positionMs = INTRO_SKIP_MS + extra;
      }

      return {
        trackIndex: track.index,
        positionMs,
        trackTitle: track.title,
      };
    }
    acc = nextAcc;
  }

  const last = TRACKS[TRACKS.length - 1];
  return {
    trackIndex: last.index,
    positionMs: last.durationMs - 1000,
    trackTitle: last.title,
  };
}

app.get("/api/radio-state", (req, res) => {
  const nowMs = Date.now();
  const state = getRadioState(nowMs);
  res.json({
    ...state,
    playlistUrl: PLAYLIST_URL,
    serverTimeMs: nowMs,
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Radio state server listening on http://localhost:${PORT}`);
});

