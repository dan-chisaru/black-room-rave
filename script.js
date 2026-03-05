(() => {
  const RADIO_STATE_URL = "http://localhost:4000/api/radio-state";
  const PLAYLIST_URL =
    "https://soundcloud.com/trommelmusic/sets/trommel-podcast";

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

  function formatTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "--:--";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

  function setupSoundCloudWidget(initialState) {
    pendingRadioState = initialState || null;

    if (!window.SC || !scIframe) return;
    widget = window.SC.Widget(scIframe);

    widget.bind(window.SC.Widget.Events.READY, () => {
      widget.setVolume(volume);

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
      } else {
        updateTrackTitle();
        updateTransportLabel();
      }
    });

    widget.bind(window.SC.Widget.Events.PLAY, () => {
      isPlaying = true;

      if (pendingRadioState && typeof pendingRadioState.positionMs === "number") {
        widget.seekTo(pendingRadioState.positionMs);
        pendingRadioState = null;
      }

      updateTrackTitle();
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

  function updateTrackTitle() {
    if (!widget || !trackTitleEl) return;
    widget.getCurrentSound((sound) => {
      if (sound && sound.title) {
        trackTitleEl.textContent = sound.title;
      }
    });

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
      if (isPlaying) {
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

  function togglePlayback() {
    if (!widget) return;

    widget.isPaused((paused) => {
      if (paused) {
        widget.play();
      } else {
        widget.pause();
      }
    });
  }

  function updateTransportLabel() {
    if (!transportButton) return;
    transportButton.textContent = isPlaying ? "pause" : "play";
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

    const radioState = await fetchRadioState();
    setupSoundCloudWidget(radioState);
    startVisualizer();

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
          widget.setVolume(volume);
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
  });
})();

