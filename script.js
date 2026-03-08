(() => {
  const RADIO_STATE_URL =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
      ? "http://localhost:4000/api/radio-state"
      : "https://black-room-rave.onrender.com/api/radio-state";
  const RADIO_BOOTSTRAP_URL = RADIO_STATE_URL.replace(
    "/api/radio-state",
    "/api/radio-bootstrap"
  );
  const PLAYLIST_URL =
    "https://soundcloud.com/trommelmusic/sets/trommel-podcast";
  const RESYNC_INTERVAL_MS = 5 * 1000;
  const MAX_DRIFT_MS = 3 * 1000;

  const room = document.getElementById("room");
  const transportButton = document.getElementById("transport-button");
  const trackTitleEl = document.getElementById("track-title");
  const trackTimeEl = document.getElementById("track-time");
  const visualizerEl = document.getElementById("visualizer");
  const bars = visualizerEl ? Array.from(visualizerEl.querySelectorAll(".bar")) : [];
  const scIframe = document.getElementById("sc-player");
  const radioStatusEl = document.getElementById("radio-status");

  let widget = null;
  let isPlaying = false;
  let animationFrameId = null;
  let volume = 80;
  let pendingRadioState = null;
  let hasSyncedToRadio = false;
  let trackDurationMs = null;
  let trackTimeIntervalId = null;
  let radioResyncIntervalId = null;
  let nowPlayingRefreshIntervalId = null;
  let fallbackMode = false;
  let bootstrapSubmitted = false;
  let pendingFallbackSeekMs = null;
  let userStopped = false;

  function formatTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "--:--";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function getExpectedPositionMs(radioState) {
    if (!radioState || typeof radioState.positionMs !== "number") return null;
    const serverTimeMs =
      typeof radioState.serverTimeMs === "number" ? radioState.serverTimeMs : Date.now();
    const networkLagMs = Math.max(0, Date.now() - serverTimeMs);
    return radioState.positionMs + networkLagMs;
  }

  function applyUserVolume() {
    if (!widget) return;
    widget.setVolume(userStopped ? 0 : volume);
  }

  function getRandomFallbackTrackIndex() {
    return Math.floor(Math.random() * 8);
  }

  function getRandomFallbackPositionMs() {
    const minMs = 60 * 1000;
    const maxMs = 55 * 60 * 1000;
    return minMs + Math.floor(Math.random() * (maxMs - minMs));
  }

  function startFallbackPlayback() {
    fallbackMode = true;
    bootstrapSubmitted = false;
    pendingFallbackSeekMs = getRandomFallbackPositionMs();

    widget.load(PLAYLIST_URL, {
      auto_play: true,
      hide_related: true,
      show_user: false,
      show_comments: false,
      show_reposts: false,
      show_teaser: false,
      start_track: getRandomFallbackTrackIndex(),
    });
  }

  async function submitBootstrapFromCurrentPlayback() {
    if (!widget || bootstrapSubmitted) return false;

    const trackIndex = await new Promise((resolve) => {
      if (typeof widget.getCurrentSoundIndex !== "function") {
        resolve(0);
        return;
      }

      widget.getCurrentSoundIndex((idx) => {
        resolve(Number.isFinite(idx) ? idx : 0);
      });
    });

    const positionMs = await new Promise((resolve) => {
      widget.getPosition((pos) => {
        resolve(Number.isFinite(pos) ? Math.max(0, Math.floor(pos)) : 0);
      });
    });

    try {
      const res = await fetch(RADIO_BOOTSTRAP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIndex, positionMs }),
      });

      if (!res.ok) return false;

      const data = await res.json();
      if (data?.accepted) {
        bootstrapSubmitted = true;
        return true;
      }

      return false;
    } catch (err) {
      console.error("Bootstrap submit error", err);
      return false;
    }
  }

  function startTrackTimeLoop() {
    if (!widget || !trackTimeEl) return;

    if (trackTimeIntervalId != null) {
      window.clearInterval(trackTimeIntervalId);
      trackTimeIntervalId = null;
    }

    trackTimeIntervalId = window.setInterval(() => {
      if (!widget || !trackTimeEl) return;
      widget.getPosition((positionMs) => {
        const elapsed = positionMs ?? 0;
        if (trackDurationMs && trackDurationMs > 0) {
          trackTimeEl.textContent = `${formatTime(elapsed)} / ${formatTime(
            trackDurationMs
          )}`;
        } else {
          trackTimeEl.textContent = `${formatTime(elapsed)}`;
        }
      });
    }, 1000);
  }


  function resetNowPlayingUi() {
    if (trackTitleEl) trackTitleEl.textContent = "loading...";
    if (trackTimeEl) trackTimeEl.textContent = "--:-- / --:--";
  }

  function startNowPlayingRefreshLoop() {
    if (nowPlayingRefreshIntervalId != null) {
      window.clearInterval(nowPlayingRefreshIntervalId);
      nowPlayingRefreshIntervalId = null;
    }

    nowPlayingRefreshIntervalId = window.setInterval(() => {
      updateTrackTitle(false);
    }, 1500);
  }
  function syncWithRadioState(radioState) {
    if (!widget || !radioState) return;

    const expectedPositionMs = getExpectedPositionMs(radioState);
    if (!Number.isFinite(expectedPositionMs)) return;

    const playlistUrl = radioState.playlistUrl || PLAYLIST_URL;

    if (typeof widget.getCurrentSoundIndex === "function") {
      widget.getCurrentSoundIndex((currentIndex) => {
        if (typeof currentIndex === "number" && currentIndex !== radioState.trackIndex) {
          pendingRadioState = radioState;
          widget.load(playlistUrl, {
            auto_play: true,
            hide_related: true,
            show_user: false,
            show_comments: false,
            show_reposts: false,
            show_teaser: false,
            start_track: radioState.trackIndex,
          });
          return;
        }

        widget.getPosition((currentPositionMs) => {
          const driftMs = Math.abs((currentPositionMs ?? 0) - expectedPositionMs);
          if (driftMs > MAX_DRIFT_MS) {
            widget.seekTo(expectedPositionMs);
          }
        });
      });
      return;
    }

    widget.getPosition((currentPositionMs) => {
      const driftMs = Math.abs((currentPositionMs ?? 0) - expectedPositionMs);
      if (driftMs > MAX_DRIFT_MS) {
        widget.seekTo(expectedPositionMs);
      }
    });
  }

  function startRadioResyncLoop() {
    if (radioResyncIntervalId != null) {
      window.clearInterval(radioResyncIntervalId);
      radioResyncIntervalId = null;
    }

    radioResyncIntervalId = window.setInterval(async () => {
      if (!widget || !isPlaying) return;

      const latestState = await fetchRadioState();
      if (!latestState) return;

      if (fallbackMode && !bootstrapSubmitted) {
        await submitBootstrapFromCurrentPlayback();
      }

      fallbackMode = false;
      syncWithRadioState(latestState);
    }, RESYNC_INTERVAL_MS);
  }

  function setupSoundCloudWidget(initialState) {
    pendingRadioState = initialState || null;

    if (!window.SC || !scIframe) return;
    widget = window.SC.Widget(scIframe);

    widget.bind(window.SC.Widget.Events.READY, () => {
      applyUserVolume();

      if (pendingRadioState && !hasSyncedToRadio) {
        hasSyncedToRadio = true;
        const { playlistUrl, trackIndex } = pendingRadioState;
        widget.load(playlistUrl || PLAYLIST_URL, {
          auto_play: true,
          hide_related: true,
          show_user: false,
          show_comments: false,
          show_reposts: false,
          show_teaser: false,
          start_track: typeof trackIndex === "number" ? trackIndex : 0,
        });
        window.setTimeout(() => updateTrackTitle(true), 700);
      } else {
        startFallbackPlayback();
        window.setTimeout(() => updateTrackTitle(true), 700);
        updateTransportLabel();
      }
    });

    widget.bind(window.SC.Widget.Events.PLAY, () => {
      isPlaying = true;

      if (pendingRadioState) {
        const expectedPositionMs = getExpectedPositionMs(pendingRadioState);
        if (Number.isFinite(expectedPositionMs)) {
          widget.seekTo(expectedPositionMs);
        }
        pendingRadioState = null;
      } else if (fallbackMode && Number.isFinite(pendingFallbackSeekMs)) {
        widget.seekTo(pendingFallbackSeekMs);
        pendingFallbackSeekMs = null;
      }

      applyUserVolume();
      updateTrackTitle(true);
      updateTransportLabel();
    });

    widget.bind(window.SC.Widget.Events.PAUSE, () => {
      isPlaying = false;
      updateTransportLabel();
    });

    widget.bind(window.SC.Widget.Events.FINISH, () => {
      isPlaying = false;
      updateTransportLabel();
    });
  }

  function getArtistName(sound) {
    if (!sound || typeof sound !== "object") return "Unknown Artist";

    if (typeof sound.title === "string") {
      const title = sound.title;

      // Expected format example: "trommel - podcast nr - artist name"
      const dashParts = title
        .split(" - ")
        .map((part) => part.trim())
        .filter(Boolean);
      if (dashParts.length >= 3) {
        return dashParts[dashParts.length - 1];
      }
      if (dashParts.length === 2) {
        return dashParts[1];
      }

      const pipeParts = title
        .split(" | ")
        .map((part) => part.trim())
        .filter(Boolean);
      if (pipeParts.length >= 2) {
        return pipeParts[pipeParts.length - 1];
      }

      const colonParts = title
        .split(": ")
        .map((part) => part.trim())
        .filter(Boolean);
      if (colonParts.length >= 2) {
        return colonParts[colonParts.length - 1];
      }
    }

    const publisherArtist = sound.publisher_metadata?.artist;
    if (typeof publisherArtist === "string" && publisherArtist.trim()) {
      return publisherArtist.trim();
    }

    const userName = sound.user?.username;
    if (typeof userName === "string" && userName.trim()) {
      return userName.trim();
    }

    return "Unknown Artist";
  }

  function updateTrackTitle(refreshDuration = false) {
    if (!widget || !trackTitleEl) return;
    widget.getCurrentSound((sound) => {
      trackTitleEl.textContent = getArtistName(sound);
    });

    if (!refreshDuration) return;

    widget.getDuration((durationMs) => {
      trackDurationMs = Number.isFinite(durationMs) ? durationMs : null;
      if (trackTimeEl) {
        if (trackDurationMs && trackDurationMs > 0) {
          trackTimeEl.textContent = `0:00 / ${formatTime(trackDurationMs)}`;
        } else {
          trackTimeEl.textContent = "--:--";
        }
      }
      startTrackTimeLoop();
    });
  }

  function startVisualizer() {
    if (!bars.length) return;

    const barCount = bars.length;
    const levels = new Array(barCount).fill(0.1);
    const smoothedLevels = new Array(barCount).fill(0.1);

    function animate(timestamp) {
      if (isPlaying && !userStopped) {
        const t = timestamp / 1000;

        for (let i = 0; i < barCount; i += 1) {
          const normalized = i / (barCount - 1 || 1);
          const phase = normalized * Math.PI * 2;

          const bpm = 128;
          const beatPhase = (t * (bpm / 60)) % 1;

          let excitation = 0;
          if (normalized < 0.3) {
            const kick = Math.exp(-beatPhase * 8);
            excitation += kick * 1.2;
          } else if (normalized < 0.7) {
            const mid = 0.4 + 0.6 * Math.max(0, Math.sin(t * 3 + phase));
            excitation += mid * 0.5;
          } else {
            const hat = 0.3 + 0.7 * ((Math.sin(t * 10 + phase) + 1) / 2);
            excitation += hat * 0.4;
          }

          const hitChance = 0.12 + (volume / 100) * 0.2;
          if (Math.random() < hitChance) {
            levels[i] = Math.max(levels[i], excitation);
          }

          levels[i] *= 0.86;
          const noise = Math.random() * 0.06;
          const volumeFactor = Math.max(0.2, volume / 100);
          const rawLevel = Math.min(1, (levels[i] + noise) * volumeFactor);

          const left = i > 0 ? levels[i - 1] : levels[i];
          const right = i < barCount - 1 ? levels[i + 1] : levels[i];
          const neighborhood = (left + rawLevel + right) / 3;

          smoothedLevels[i] += (neighborhood - smoothedLevels[i]) * 0.4;

          const intensity = Math.max(0.05, Math.min(1, smoothedLevels[i]));
          const heightPercent = 6 + intensity * 84;
          bars[i].style.height = `${heightPercent}%`;
        }
      } else {
        for (let i = 0; i < barCount; i += 1) {
          const current = parseFloat(bars[i].style.height || "10");
          const next = current + (10 - current) * 0.1;
          bars[i].style.height = `${next}%`;
        }
      }

      animationFrameId = window.requestAnimationFrame(animate);
    }

    if (animationFrameId == null) {
      animationFrameId = window.requestAnimationFrame(animate);
    }
  }

  async function rejoinLivePlayback() {
    if (!widget) return;

    try {
      const latestState = await fetchRadioState();
      if (latestState) {
        fallbackMode = false;
        syncWithRadioState(latestState);
      }
    } finally {
      widget.play();
    }
  }

  function togglePlayback() {
    if (!widget) return;

    widget.isPaused(async (paused) => {
      if (userStopped || paused || !isPlaying) {
        userStopped = false;
        await rejoinLivePlayback();
        applyUserVolume();
      } else {
        userStopped = true;
        applyUserVolume();
        updateTransportLabel();
      }
    });
  }

  function updateTransportLabel() {
    if (!transportButton) return;
    transportButton.textContent = userStopped || !isPlaying ? "Play" : "Stop";
  }

  function setRadioStatus(online) {
    if (!radioStatusEl) return;
    radioStatusEl.classList.remove("radio-status--online", "radio-status--offline");
    radioStatusEl.classList.add(online ? "radio-status--online" : "radio-status--offline");
  }

  async function fetchRadioState() {
    try {
      const res = await fetch(RADIO_STATE_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to fetch radio state");
      const data = await res.json();
      setRadioStatus(true);
      return data;
    } catch (err) {
      console.error("Radio state error", err);
      setRadioStatus(false);
      return null;
    }
  }

  async function init() {
    if (!room || !scIframe) return;

    resetNowPlayingUi();
    const radioState = await fetchRadioState();
    setupSoundCloudWidget(radioState);
    startVisualizer();
    startRadioResyncLoop();
    startNowPlayingRefreshLoop();

    if (transportButton) {
      transportButton.addEventListener("click", () => {
        togglePlayback();
      });
    }

    const volumeSlider = document.getElementById("volume-slider");
    if (volumeSlider) {
      volume = parseInt(volumeSlider.value, 10) || volume;

      volumeSlider.addEventListener("input", (event) => {
        const target = event.target;
        const value = parseInt(target.value, 10);
        if (Number.isNaN(value)) return;
        volume = Math.min(100, Math.max(0, value));
        if (widget) {
          applyUserVolume();
        }
      });
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }

  window.addEventListener("beforeunload", () => {
    if (animationFrameId != null) {
      window.cancelAnimationFrame(animationFrameId);
    }
    if (trackTimeIntervalId != null) {
      window.clearInterval(trackTimeIntervalId);
    }
    if (radioResyncIntervalId != null) {
      window.clearInterval(radioResyncIntervalId);
    }
    if (nowPlayingRefreshIntervalId != null) {
      window.clearInterval(nowPlayingRefreshIntervalId);
    }
  });
})();








