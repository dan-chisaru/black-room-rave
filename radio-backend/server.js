import express from "express";
import cors from "cors";
import { PLAYLIST_URL, TRACKS } from "./radioConfig.js";

const app = express();
app.use(cors());
app.use(express.json());

const DEFAULT_RADIO_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");
const parsedEpochMs = Number.parseInt(process.env.RADIO_EPOCH_MS ?? "", 10);
const INITIAL_RADIO_EPOCH_MS = Number.isFinite(parsedEpochMs)
  ? parsedEpochMs
  : DEFAULT_RADIO_EPOCH_MS;

const DEFAULT_TRACK_DURATION_MS = 60 * 60 * 1000;
const trackCatalog = new Map(TRACKS.map((track) => [track.index, track]));

let radioEpochMs = INITIAL_RADIO_EPOCH_MS;
let bootstrapAccepted = false;
const serverBootMs = Date.now();

let playlistOrder = TRACKS.map((track) => track.index);
let playlistOrderUpdatedAtMs = Date.now();

const LISTENER_TTL_MS = 35 * 1000;
const listenerHeartbeats = new Map();
let maxConcurrentListeners = 0;
let totalListenerSessions = 0;

function pruneListeners(nowMs) {
  for (const [listenerId, lastSeenMs] of listenerHeartbeats.entries()) {
    if (nowMs - lastSeenMs > LISTENER_TTL_MS) {
      listenerHeartbeats.delete(listenerId);
    }
  }
}

function buildTrack(index) {
  const known = trackCatalog.get(index);
  if (known) return known;

  return {
    index,
    title: `Track ${index}`,
    durationMs: DEFAULT_TRACK_DURATION_MS,
  };
}

function getActiveTracks() {
  if (!Array.isArray(playlistOrder) || playlistOrder.length === 0) {
    return TRACKS;
  }

  return playlistOrder.map((index) => buildTrack(index));
}

function getLoopDurationMs(activeTracks) {
  return activeTracks.reduce((acc, track) => acc + track.durationMs, 0);
}

function getTrackOffsetMs(trackIndex, activeTracks) {
  let offsetMs = 0;

  for (const track of activeTracks) {
    if (track.index === trackIndex) {
      return { offsetMs, track };
    }
    offsetMs += track.durationMs;
  }

  return { offsetMs: 0, track: activeTracks[0] };
}

function clampPositionMs(positionMs, trackDurationMs) {
  if (!Number.isFinite(positionMs)) return 0;
  if (!Number.isFinite(trackDurationMs) || trackDurationMs <= 0) {
    return Math.max(0, positionMs);
  }
  return Math.min(Math.max(0, positionMs), Math.max(0, trackDurationMs - 1000));
}

function getRadioState(nowMs, activeTracks) {
  const loopDurationMs = getLoopDurationMs(activeTracks);

  if (!Number.isFinite(loopDurationMs) || loopDurationMs <= 0) {
    return {
      trackIndex: activeTracks[0]?.index ?? 0,
      positionMs: 0,
      trackTitle: activeTracks[0]?.title ?? "Unknown",
    };
  }

  const elapsed =
    ((nowMs - radioEpochMs) % loopDurationMs + loopDurationMs) % loopDurationMs;
  let acc = 0;

  for (const track of activeTracks) {
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

  const last = activeTracks[activeTracks.length - 1] || {
    index: 0,
    title: "Unknown",
    durationMs: DEFAULT_TRACK_DURATION_MS,
  };

  return {
    trackIndex: last.index,
    positionMs: Math.max(0, last.durationMs - 1000),
    trackTitle: last.title,
  };
}

function getPlaylistStats(nowMs, activeTracks) {
  const loopDurationMs = getLoopDurationMs(activeTracks);
  const elapsedSinceEpochMs = Math.max(0, nowMs - radioEpochMs);

  const fullLoops =
    Number.isFinite(loopDurationMs) && loopDurationMs > 0
      ? Math.floor(elapsedSinceEpochMs / loopDurationMs)
      : 0;
  const remainderMs =
    Number.isFinite(loopDurationMs) && loopDurationMs > 0
      ? elapsedSinceEpochMs % loopDurationMs
      : 0;

  let cumulativeStartMs = 0;
  const tracks = activeTracks.map((track) => {
    const startedInCurrentLoop = remainderMs >= cumulativeStartMs ? 1 : 0;
    const approxStarts = fullLoops + startedInCurrentLoop;
    const orderPos = playlistOrder.findIndex((idx) => idx === track.index);

    cumulativeStartMs += track.durationMs;

    return {
      index: track.index,
      title: track.title,
      durationMs: track.durationMs,
      approxStarts,
      orderPos: orderPos >= 0 ? orderPos : null,
    };
  });

  return {
    loopDurationMs,
    fullLoops,
    elapsedSinceEpochMs,
    tracks,
  };
}

function sanitizeIncomingOrder(rawOrder) {
  if (!Array.isArray(rawOrder)) return [];

  const seen = new Set();
  const sanitized = [];

  for (const value of rawOrder) {
    const idx = Number.parseInt(value, 10);
    if (!Number.isFinite(idx) || idx < 0) continue;
    if (seen.has(idx)) continue;

    seen.add(idx);
    sanitized.push(idx);
  }

  return sanitized;
}

app.get("/api/radio-state", (req, res) => {
  const nowMs = Date.now();
  const activeTracks = getActiveTracks();
  const state = getRadioState(nowMs, activeTracks);

  res.json({
    ...state,
    playlistUrl: PLAYLIST_URL,
    serverTimeMs: nowMs,
    epochMs: radioEpochMs,
    bootstrapAccepted,
    playlistOrder,
  });
});

app.post("/api/radio-bootstrap", (req, res) => {
  const nowMs = Date.now();

  if (bootstrapAccepted) {
    return res.json({
      accepted: false,
      reason: "already_bootstrapped",
      epochMs: radioEpochMs,
      playlistOrder,
    });
  }

  const activeTracks = getActiveTracks();
  const requestedTrackIndex = Number.parseInt(req.body?.trackIndex, 10);
  const requestedPositionMs = Number.parseInt(req.body?.positionMs, 10);

  const { offsetMs, track } = getTrackOffsetMs(requestedTrackIndex, activeTracks);
  const safePositionMs = clampPositionMs(requestedPositionMs, track?.durationMs ?? 0);

  const elapsedAtNowMs = offsetMs + safePositionMs;
  radioEpochMs = nowMs - elapsedAtNowMs;
  bootstrapAccepted = true;

  return res.json({
    accepted: true,
    epochMs: radioEpochMs,
    trackIndex: track?.index ?? 0,
    positionMs: safePositionMs,
    playlistOrder,
  });
});

app.post("/api/listener-heartbeat", (req, res) => {
  const listenerId =
    typeof req.body?.listenerId === "string" ? req.body.listenerId.trim() : "";

  if (!listenerId) {
    return res.status(400).json({ ok: false, error: "missing_listener_id" });
  }

  const nowMs = Date.now();
  pruneListeners(nowMs);

  if (req.body?.isActive === false) {
    listenerHeartbeats.delete(listenerId);
  } else {
    const isNew = !listenerHeartbeats.has(listenerId);
    listenerHeartbeats.set(listenerId, nowMs);
    if (isNew) {
      totalListenerSessions += 1;
    }
  }

  const currentListeners = listenerHeartbeats.size;
  if (currentListeners > maxConcurrentListeners) {
    maxConcurrentListeners = currentListeners;
  }

  return res.json({
    ok: true,
    currentListeners,
    maxConcurrentListeners,
    totalListenerSessions,
  });
});

app.get("/api/admin-playlist-order", (req, res) => {
  const activeTracks = getActiveTracks();

  res.json({
    playlistOrder,
    updatedAtMs: playlistOrderUpdatedAtMs,
    tracks: activeTracks.map((track) => ({
      index: track.index,
      title: track.title,
      durationMs: track.durationMs,
    })),
  });
});

app.post("/api/admin-playlist-order", (req, res) => {
  const incomingOrder = sanitizeIncomingOrder(req.body?.order);

  if (!incomingOrder.length) {
    return res.status(400).json({ ok: false, error: "invalid_order" });
  }

  const nowMs = Date.now();
  const oldTracks = getActiveTracks();
  const currentState = getRadioState(nowMs, oldTracks);

  playlistOrder = incomingOrder;
  playlistOrderUpdatedAtMs = nowMs;

  const newTracks = getActiveTracks();
  const playingTrack =
    newTracks.find((track) => track.index === currentState.trackIndex) || newTracks[0];
  const { offsetMs } = getTrackOffsetMs(playingTrack.index, newTracks);
  const safePositionMs = clampPositionMs(currentState.positionMs, playingTrack.durationMs);

  radioEpochMs = nowMs - (offsetMs + safePositionMs);

  return res.json({
    ok: true,
    playlistOrder,
    updatedAtMs: playlistOrderUpdatedAtMs,
    activeTrackCount: newTracks.length,
    radioEpochMs,
    state: getRadioState(nowMs, newTracks),
  });
});

app.post("/api/admin-jump-track", (req, res) => {
  const nowMs = Date.now();
  const activeTracks = getActiveTracks();

  const requestedTrackIndex = Number.parseInt(req.body?.trackIndex, 10);
  const requestedPositionMs = Number.parseInt(req.body?.positionMs, 10);

  const { offsetMs, track } = getTrackOffsetMs(requestedTrackIndex, activeTracks);
  const safePositionMs = clampPositionMs(requestedPositionMs, track?.durationMs ?? 0);

  radioEpochMs = nowMs - (offsetMs + safePositionMs);

  return res.json({
    ok: true,
    jumpedToTrackIndex: track?.index ?? 0,
    positionMs: safePositionMs,
    epochMs: radioEpochMs,
    state: getRadioState(nowMs, activeTracks),
    playlistOrder,
  });
});
app.get("/api/admin-state", (req, res) => {
  const nowMs = Date.now();
  pruneListeners(nowMs);

  const activeTracks = getActiveTracks();
  const radioState = getRadioState(nowMs, activeTracks);
  const playlistStats = getPlaylistStats(nowMs, activeTracks);

  const currentListeners = listenerHeartbeats.size;
  if (currentListeners > maxConcurrentListeners) {
    maxConcurrentListeners = currentListeners;
  }

  res.json({
    serverTimeMs: nowMs,
    uptimeMs: nowMs - serverBootMs,
    bootstrapAccepted,
    radioEpochMs,
    currentListeners,
    maxConcurrentListeners,
    totalListenerSessions,
    playlistOrder,
    playlistOrderUpdatedAtMs,
    radioState,
    playlistStats,
  });
});


app.get("/health", (_req, res) => {
  const nowMs = Date.now();
  res.json({
    ok: true,
    service: "black-room-rave",
    serverTimeMs: nowMs,
    uptimeMs: nowMs - serverBootMs,
  });
});

app.get("/api/state", (_req, res) => {
  const nowMs = Date.now();
  const activeTracks = getActiveTracks();
  const radioState = getRadioState(nowMs, activeTracks);

  res.json({
    ok: true,
    serverTimeMs: nowMs,
    uptimeMs: nowMs - serverBootMs,
    bootstrapAccepted,
    radioEpochMs,
    playlistOrder,
    radioState,
  });
});
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Radio state server listening on http://localhost:${PORT}`);
});
