import express from "express";
import cors from "cors";
import { PLAYLIST_URL, TRACKS } from "./radioConfig.js";

const app = express();
app.use(cors());
app.use(express.json());

const loopDurationMs = TRACKS.reduce((acc, t) => acc + t.durationMs, 0);
const DEFAULT_RADIO_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");
const parsedEpochMs = Number.parseInt(process.env.RADIO_EPOCH_MS ?? "", 10);
const INITIAL_RADIO_EPOCH_MS = Number.isFinite(parsedEpochMs)
  ? parsedEpochMs
  : DEFAULT_RADIO_EPOCH_MS;

let radioEpochMs = INITIAL_RADIO_EPOCH_MS;
let bootstrapAccepted = false;
const serverBootMs = Date.now();
const BOOTSTRAP_WINDOW_MS = 5 * 60 * 1000;

function getTrackOffsetMs(trackIndex) {
  let offsetMs = 0;

  for (const track of TRACKS) {
    if (track.index === trackIndex) {
      return { offsetMs, track };
    }
    offsetMs += track.durationMs;
  }

  return { offsetMs: 0, track: TRACKS[0] };
}

function clampPositionMs(positionMs, trackDurationMs) {
  if (!Number.isFinite(positionMs)) return 0;
  if (!Number.isFinite(trackDurationMs) || trackDurationMs <= 0) {
    return Math.max(0, positionMs);
  }
  return Math.min(Math.max(0, positionMs), Math.max(0, trackDurationMs - 1000));
}

function getRadioState(nowMs) {
  if (!Number.isFinite(loopDurationMs) || loopDurationMs <= 0) {
    return {
      trackIndex: 0,
      positionMs: 0,
      trackTitle: TRACKS[0]?.title ?? "Unknown",
    };
  }

  const elapsed =
    ((nowMs - radioEpochMs) % loopDurationMs + loopDurationMs) % loopDurationMs;
  let acc = 0;

  for (const track of TRACKS) {
    const nextAcc = acc + track.durationMs;
    if (elapsed < nextAcc) {
      return {
        trackIndex: track.index,
        positionMs: elapsed - acc,
        trackTitle: track.title,
      };
    }
    acc = nextAcc;
  }

  const last = TRACKS[TRACKS.length - 1];
  return {
    trackIndex: last.index,
    positionMs: Math.max(0, last.durationMs - 1000),
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
    epochMs: radioEpochMs,
    bootstrapAccepted,
  });
});

app.post("/api/radio-bootstrap", (req, res) => {
  const nowMs = Date.now();
  const withinBootstrapWindow = nowMs - serverBootMs <= BOOTSTRAP_WINDOW_MS;

  if (bootstrapAccepted || !withinBootstrapWindow) {
    return res.json({
      accepted: false,
      reason: bootstrapAccepted ? "already_bootstrapped" : "window_closed",
      epochMs: radioEpochMs,
    });
  }

  const requestedTrackIndex = Number.parseInt(req.body?.trackIndex, 10);
  const requestedPositionMs = Number.parseInt(req.body?.positionMs, 10);

  const { offsetMs, track } = getTrackOffsetMs(requestedTrackIndex);
  const safePositionMs = clampPositionMs(requestedPositionMs, track?.durationMs ?? 0);

  const elapsedAtNowMs = offsetMs + safePositionMs;
  radioEpochMs = nowMs - elapsedAtNowMs;
  bootstrapAccepted = true;

  return res.json({
    accepted: true,
    epochMs: radioEpochMs,
    trackIndex: track?.index ?? 0,
    positionMs: safePositionMs,
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Radio state server listening on http://localhost:${PORT}`);
});
