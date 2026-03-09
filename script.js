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
  const ADMIN_STATE_URL = RADIO_STATE_URL.replace("/api/radio-state", "/api/admin-state");
  const ADMIN_PLAYLIST_ORDER_URL = RADIO_STATE_URL.replace("/api/radio-state", "/api/admin-playlist-order");
  const ADMIN_JUMP_TRACK_URL = RADIO_STATE_URL.replace("/api/radio-state", "/api/admin-jump-track");
  const LISTENER_HEARTBEAT_URL = RADIO_STATE_URL.replace(
    "/api/radio-state",
    "/api/listener-heartbeat"
  );

  const PLAYLIST_URL = "https://soundcloud.com/trommelmusic/sets/trommel-podcast";
  const FALLBACK_ADMIN_TRACKS = [
    { index: 0, title: "Trommel podcast 1", durationMs: 60 * 60 * 1000 },
    { index: 1, title: "Trommel podcast 2", durationMs: 60 * 60 * 1000 },
    { index: 2, title: "Trommel podcast 3", durationMs: 60 * 60 * 1000 },
  ];

  const RESYNC_INTERVAL_MS = 5 * 1000;
  const MAX_DRIFT_MS = 3 * 1000;
  const NOW_PLAYING_REFRESH_MS = 1500;
  const ADMIN_REFRESH_MS = 5000;
  const HEARTBEAT_INTERVAL_MS = 15000;
  const GOD_MODE_UNLOCKED = true;
  const MANUAL_GOD_MODE_OVERRIDE_MS = 2 * 60 * 1000;
  const INTRO_SKIP_DEFAULT_MS = 90 * 1000;
  const COLD_START_SKIP_FIRST_AFTER_SHUFFLE = true;
  const COLD_START_RANDOM_POSITION_MIN_MS = INTRO_SKIP_DEFAULT_MS;
  const COLD_START_RANDOM_POSITION_MAX_MS = 55 * 60 * 1000;
  const ADMIN_SEEK_SYNC_GRACE_MS = 8000;
  const ADMIN_SEEK_DEBOUNCE_MS = 900;

  const room = document.getElementById("room");
  const roomLogo = document.getElementById("room-logo");
  const transportButton = document.getElementById("transport-button");
  const trackTitleEl = document.getElementById("track-title");
  const trackTimeEl = document.getElementById("track-time");
  const visualizerEl = document.getElementById("visualizer");
  const bars = visualizerEl ? Array.from(visualizerEl.querySelectorAll(".bar")) : [];
  const scIframe = document.getElementById("sc-player");
  const radioStatusEl = document.getElementById("radio-status");

  const adminCurrentListenersEl = document.getElementById("admin-current-listeners");
  const adminMaxListenersEl = document.getElementById("admin-max-listeners");
  const adminTotalSessionsEl = document.getElementById("admin-total-sessions");
  const adminUptimeEl = document.getElementById("admin-uptime");
  const adminBootstrapEl = document.getElementById("admin-bootstrap");
  const adminLiveTrackEl = document.getElementById("admin-live-track");

  const adminPlaylistListEl = document.getElementById("admin-playlist-list");
  const adminPlaylistStatusEl = document.getElementById("admin-playlist-status");
  const adminLoadPlaylistBtn = document.getElementById("admin-load-playlist");
  const adminShufflePlaylistBtn = document.getElementById("admin-shuffle-playlist");
  const adminResetPlaylistBtn = document.getElementById("admin-reset-playlist");
  const adminScPluginIframe = document.getElementById("admin-sc-plugin");

  let widget = null;
  let isPlaying = false;
  let animationFrameId = null;
  let volume = 100;
  let pendingRadioState = null;
  let hasSyncedToRadio = false;
  let widgetReadyInitialized = false;
  let trackDurationMs = null;
  let trackTimeIntervalId = null;
  let radioResyncIntervalId = null;
  let nowPlayingRefreshIntervalId = null;
  let adminRefreshIntervalId = null;
  let adminWidgetSyncIntervalId = null;
  let listenerHeartbeatIntervalId = null;
  let manualGodModeOverrideUntilMs = 0;
  let adminSeekInFlight = false;
  let suppressAdminSyncUntilMs = 0;
  let lastGodSeekRequestMs = 0;
  let lastGodSeekPositionMs = -1;

  let fallbackMode = false;
  let bootstrapSubmitted = false;
  let pendingFallbackSeekMs = null;
  let userStopped = false;
  let radioStateResolved = false;
  let startupPlaybackChosen = false;

  let godModeEnabled = false;
  let godPlaylistAutoPrepared = false;
  let listenerId = null;

  let latestRadioState = null;
  let latestAdminState = null;
  let liveTrackIndex = null;

  let soundCloudPlaylistTracks = [];
  let godPlaylistOrder = [];
  let adminPluginWidget = null;
  let adminPluginReady = false;
  const trackSeenCounts = new Map();
  let lastObservedTrackIndex = null;

  function formatTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "--:--";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "--";
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
    }

    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  function getExpectedPositionMs(radioState) {
    if (!radioState || typeof radioState.positionMs !== "number") return null;
    const serverTimeMs =
      typeof radioState.serverTimeMs === "number" ? radioState.serverTimeMs : Date.now();
    const networkLagMs = Math.max(0, Date.now() - serverTimeMs);
    return radioState.positionMs + networkLagMs;
  }

  function getStartPositionMs(positionMs) {
    if (Number.isFinite(positionMs) && positionMs > 0) {
      return Math.max(0, Math.floor(positionMs));
    }

    return INTRO_SKIP_DEFAULT_MS;
  }

  function applyUserVolume() {
    if (!widget) return;
    widget.setVolume(userStopped ? 0 : volume);
  }

  function shuffleTrackIndexes(indexes) {
    const shuffled = [...indexes];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  function getStartupFallbackPool() {
    const sourcePool = godPlaylistOrder.length
      ? godPlaylistOrder
      : soundCloudPlaylistTracks.map((track) => track.index);

    if (!sourcePool.length) return [];

    const shuffled = shuffleTrackIndexes(sourcePool);
    if (shuffled.length <= 1) return shuffled;

    if (!COLD_START_SKIP_FIRST_AFTER_SHUFFLE) return shuffled;

    // Skip first item after shuffle to avoid repetitive cold starts.
    return shuffled.slice(1);
  }

  function getRandomFallbackTrackIndex() {
    const pool = getStartupFallbackPool();

    if (pool.length > 0) {
      const randomPos = Math.floor(Math.random() * pool.length);
      return pool[randomPos];
    }

    return Math.floor(Math.random() * 8);
  }

  function getRandomFallbackPositionMs() {
    const minMs = COLD_START_RANDOM_POSITION_MIN_MS;
    const maxMs = Math.max(minMs + 1000, COLD_START_RANDOM_POSITION_MAX_MS);
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
    if (!widget) return;

    if (trackTimeIntervalId != null) {
      window.clearInterval(trackTimeIntervalId);
      trackTimeIntervalId = null;
    }

    trackTimeIntervalId = window.setInterval(() => {
      if (!widget) return;
      widget.getPosition((positionMs) => {
        const elapsed = positionMs ?? 0;

        if (trackTimeEl) {
          if (trackDurationMs && trackDurationMs > 0) {
            trackTimeEl.textContent = `${formatTime(elapsed)} / ${formatTime(trackDurationMs)}`;
          } else {
            trackTimeEl.textContent = `${formatTime(elapsed)}`;
          }
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
    }, NOW_PLAYING_REFRESH_MS);
  }

  function syncWithRadioState(radioState) {
    if (!widget || !radioState) return;
    if (godModeEnabled && Date.now() < manualGodModeOverrideUntilMs) return;

    const expectedPositionMs = getExpectedPositionMs(radioState);
    if (!Number.isFinite(expectedPositionMs)) return;

    const normalizedExpectedPositionMs =
      Number.isFinite(radioState.positionMs) && radioState.positionMs > 0
        ? expectedPositionMs
        : Math.max(expectedPositionMs, INTRO_SKIP_DEFAULT_MS);

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
          const driftMs = Math.abs((currentPositionMs ?? 0) - normalizedExpectedPositionMs);
          if (driftMs > MAX_DRIFT_MS) {
            widget.seekTo(normalizedExpectedPositionMs);
          }
        });
      });
      return;
    }

    widget.getPosition((currentPositionMs) => {
      const driftMs = Math.abs((currentPositionMs ?? 0) - normalizedExpectedPositionMs);
      if (driftMs > MAX_DRIFT_MS) {
        widget.seekTo(normalizedExpectedPositionMs);
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
      if (godModeEnabled && Date.now() < manualGodModeOverrideUntilMs) return;

      const latestState = await fetchRadioState();
      if (!latestState) return;

      if (fallbackMode && !bootstrapSubmitted) {
        await submitBootstrapFromCurrentPlayback();
      }

      fallbackMode = false;
      syncWithRadioState(latestState);
    }, RESYNC_INTERVAL_MS);
  }

  function getArtistName(sound) {
    if (!sound || typeof sound !== "object") return "Unknown Artist";

    if (typeof sound.title === "string") {
      const title = sound.title;

      const dashParts = title
        .split(" - ")
        .map((part) => part.trim())
        .filter(Boolean);
      if (dashParts.length >= 3) return dashParts[dashParts.length - 1];
      if (dashParts.length === 2) return dashParts[1];

      const pipeParts = title
        .split(" | ")
        .map((part) => part.trim())
        .filter(Boolean);
      if (pipeParts.length >= 2) return pipeParts[pipeParts.length - 1];

      const colonParts = title
        .split(": ")
        .map((part) => part.trim())
        .filter(Boolean);
      if (colonParts.length >= 2) return colonParts[colonParts.length - 1];
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

  function updateLiveTrackFromWidget(countTransition = false) {
    if (!widget || typeof widget.getCurrentSoundIndex !== "function") return;

    widget.getCurrentSoundIndex((idx) => {
      if (!Number.isFinite(idx)) return;

      const previousTrackIndex = lastObservedTrackIndex;

      liveTrackIndex = idx;
      if (adminLiveTrackEl) {
        adminLiveTrackEl.textContent = String(liveTrackIndex);
      }

      if (countTransition && previousTrackIndex !== idx) {
        const current = trackSeenCounts.get(idx) ?? 0;
        trackSeenCounts.set(idx, current + 1);

        if (GOD_MODE_UNLOCKED && Number.isFinite(previousTrackIndex)) {
          rotateTrackToBottom(previousTrackIndex);
        }
      }
      lastObservedTrackIndex = idx;

      if (godModeEnabled) {
        renderPlaylistFromCurrentData();
      }
    });
  }

  function updateTrackTitle(refreshDuration = false) {
    if (!widget || !trackTitleEl) return;
    widget.getCurrentSound((sound) => {
      trackTitleEl.textContent = getArtistName(sound);
    });

    updateLiveTrackFromWidget(refreshDuration);

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

    // Start immediately in gesture context (mobile autoplay policy).
    widget.play();

    try {
      const latestState = await fetchRadioState();
      if (latestState) {
        fallbackMode = false;
        syncWithRadioState(latestState);
      }
    } catch (_err) {
      // Keep playback running if sync call fails.
    }
  }

  // Startup rule: follow server state when server is already live; use shuffled fallback only when server is not live.
  function applyStartupPlaybackStrategy() {
    if (!widget || !widgetReadyInitialized || startupPlaybackChosen || !radioStateResolved) {
      return;
    }

    const hasServerTrack =
      pendingRadioState &&
      typeof pendingRadioState.trackIndex === "number" &&
      Number.isFinite(pendingRadioState.trackIndex);

    if (!hasServerTrack) return;

    // Do not auto-play or auto-fallback on refresh; Play button controls audio start.
    startupPlaybackChosen = true;
  }

  function togglePlayback() {
    if (!widget) return;

    if (!userStopped && isPlaying) {
      userStopped = true;
      applyUserVolume();
      updateTransportLabel();
      return;
    }

    userStopped = false;
    applyUserVolume();
    updateTransportLabel();

    // Fire play immediately in click context so mobile autoplay policies allow audio.
    try {
      widget.play();
    } catch (_err) {
      // Ignore; load/sync path below will retry.
    }

    void (async () => {
      const latestState = await fetchRadioState();

      if (latestState && Number.isFinite(latestState.trackIndex)) {
        fallbackMode = false;
        pendingRadioState = latestState;
        hasSyncedToRadio = true;

        widget.load(latestState.playlistUrl || PLAYLIST_URL, {
          auto_play: true,
          hide_related: true,
          show_user: false,
          show_comments: false,
          show_reposts: false,
          show_teaser: false,
          start_track: Number.isFinite(latestState.trackIndex) ? latestState.trackIndex : 0,
        });
      } else {
        pendingRadioState = null;
        startFallbackPlayback();
      }

      applyUserVolume();
      updateTransportLabel();
    })();
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
      latestRadioState = data;
      liveTrackIndex = typeof data.trackIndex === "number" ? data.trackIndex : liveTrackIndex;
      setRadioStatus(true);
      return data;
    } catch (err) {
      console.error("Radio state error", err);
      setRadioStatus(false);
      return null;
    }
  }

  function ensureListenerId() {
    const storageKey = "black_room_rave_listener_id";
    const existing = window.localStorage.getItem(storageKey);
    if (existing) {
      listenerId = existing;
      return;
    }

    const randomPart =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

    listenerId = `listener-${randomPart}`;
    window.localStorage.setItem(storageKey, listenerId);
  }

  async function postListenerHeartbeat(isActive = true, keepalive = false) {
    if (!listenerId) return;

    try {
      await fetch(LISTENER_HEARTBEAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listenerId, isActive }),
        keepalive,
      });
    } catch (err) {
      console.error("Heartbeat error", err);
    }
  }

  function startListenerHeartbeatLoop() {
    if (listenerHeartbeatIntervalId != null) {
      window.clearInterval(listenerHeartbeatIntervalId);
      listenerHeartbeatIntervalId = null;
    }

    postListenerHeartbeat(true);
    listenerHeartbeatIntervalId = window.setInterval(() => {
      postListenerHeartbeat(true);
    }, HEARTBEAT_INTERVAL_MS);
  }

  function savePlaylistOrder() {
    window.localStorage.setItem("god_playlist_order", JSON.stringify(godPlaylistOrder));
  }

  function restorePlaylistOrder() {
    const raw = window.localStorage.getItem("god_playlist_order");
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        godPlaylistOrder = parsed.filter((idx) => Number.isFinite(idx));
      }
    } catch (_err) {
      godPlaylistOrder = [];
    }
  }

  function normalizePlaylistOrder() {
    if (!soundCloudPlaylistTracks.length) {
      godPlaylistOrder = [];
      return;
    }

    const available = new Set(soundCloudPlaylistTracks.map((t) => t.index));
    const filtered = godPlaylistOrder.filter((idx) => available.has(idx));
    const missing = soundCloudPlaylistTracks
      .map((t) => t.index)
      .filter((idx) => !filtered.includes(idx));

    godPlaylistOrder = [...filtered, ...missing];
  }

  function setupFallbackTracksFromWidgetSounds(sounds) {
    if (!Array.isArray(sounds) || !sounds.length) return;

    soundCloudPlaylistTracks = sounds.map((sound, index) => {
      const title = typeof sound?.title === "string" && sound.title.trim()
        ? sound.title.trim()
        : `Track ${index}`;
      const durationMs = Number.isFinite(sound?.duration) ? sound.duration : 0;

      return {
        index,
        title,
        durationMs,
      };
    });

    normalizePlaylistOrder();
    savePlaylistOrder();
  }

  async function loadPlaylistFromWidget(forceReload = false) {
    if (!widget) return false;
    if (!forceReload && soundCloudPlaylistTracks.length) {
      return true;
    }

    if (adminPlaylistStatusEl) {
      adminPlaylistStatusEl.textContent = "loading playlist from soundcloud...";
    }

    const sounds = await new Promise((resolve) => {
      if (typeof widget.getSounds !== "function") {
        resolve([]);
        return;
      }

      widget.getSounds((items) => {
        resolve(Array.isArray(items) ? items : []);
      });
    });

    setupFallbackTracksFromWidgetSounds(sounds);

    if (soundCloudPlaylistTracks.length) {
      if (adminPlaylistStatusEl) {
        adminPlaylistStatusEl.textContent = `playlist loaded (${soundCloudPlaylistTracks.length} tracks) / intro skip 1m30s`;
      }
      renderPlaylistFromCurrentData();
      return true;
    }

    if (adminPlaylistStatusEl) {
      adminPlaylistStatusEl.textContent = "playlist unavailable from soundcloud widget";
    }

    return false;
  }



  async function pushPlaylistOrderToServer() {
    if (!godPlaylistOrder.length) return false;

    try {
      const res = await fetch(ADMIN_PLAYLIST_ORDER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: godPlaylistOrder }),
      });

      if (!res.ok) throw new Error("playlist sync failed");

      const data = await res.json();
      if (Array.isArray(data?.playlistOrder) && data.playlistOrder.length) {
        godPlaylistOrder = [...data.playlistOrder];
        savePlaylistOrder();
      }

      return true;
    } catch (err) {
      console.error("Playlist order sync error", err);
      return false;
    }
  }
  function rotateTrackToBottom(trackIndex) {
    if (!Number.isFinite(trackIndex) || godPlaylistOrder.length < 2) return false;

    const currentPos = godPlaylistOrder.indexOf(trackIndex);
    if (currentPos < 0 || currentPos === godPlaylistOrder.length - 1) return false;

    godPlaylistOrder.splice(currentPos, 1);
    godPlaylistOrder.push(trackIndex);

    savePlaylistOrder();
    if (godModeEnabled) {
      renderPlaylistFromCurrentData();
    }
    void pushPlaylistOrderToServer();

    return true;
  }
  async function shuffleGodPlaylist() {
    if (godPlaylistOrder.length < 2) return;

    const shuffled = [...godPlaylistOrder];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    godPlaylistOrder = shuffled;
    savePlaylistOrder();
    renderPlaylistFromCurrentData();
    await pushPlaylistOrderToServer();
  }

  async function moveGodPlaylistItem(orderIndex, direction) {
    const target = orderIndex + direction;
    if (orderIndex < 0 || orderIndex >= godPlaylistOrder.length) return;
    if (target < 0 || target >= godPlaylistOrder.length) return;

    [godPlaylistOrder[orderIndex], godPlaylistOrder[target]] = [
      godPlaylistOrder[target],
      godPlaylistOrder[orderIndex],
    ];

    savePlaylistOrder();
    renderPlaylistFromCurrentData();
    await pushPlaylistOrderToServer();
  }

  async function resetGodPlaylistOrder() {
    godPlaylistOrder = soundCloudPlaylistTracks.map((track) => track.index);
    savePlaylistOrder();
    renderPlaylistFromCurrentData();
    await pushPlaylistOrderToServer();
  }


  async function playTrackFromPlaylistIndex(trackIndex) {
    if (!widget || !Number.isFinite(trackIndex) || !godModeEnabled) return;

    userStopped = false;
    fallbackMode = false;

    if (adminPlaylistStatusEl) {
      adminPlaylistStatusEl.textContent = `switching stream to track ${trackIndex}...`;
    }

    const requestedPositionMs = getStartPositionMs(0);

    try {
      const res = await fetch(ADMIN_JUMP_TRACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIndex, positionMs: requestedPositionMs }),
      });

      if (!res.ok) throw new Error("jump failed");

      const data = await res.json();
      const jumpedTrackIndex = Number.isFinite(data?.jumpedToTrackIndex)
        ? data.jumpedToTrackIndex
        : trackIndex;

      manualGodModeOverrideUntilMs = Date.now() + MANUAL_GOD_MODE_OVERRIDE_MS;
      suppressAdminSyncUntilMs = Date.now() + ADMIN_SEEK_SYNC_GRACE_MS;

      pendingRadioState = {
        trackIndex: jumpedTrackIndex,
        positionMs: requestedPositionMs,
        playlistUrl: PLAYLIST_URL,
        serverTimeMs: Date.now(),
      };

      widget.load(PLAYLIST_URL, {
        auto_play: true,
        hide_related: true,
        show_user: false,
        show_comments: false,
        show_reposts: false,
        show_teaser: false,
        start_track: jumpedTrackIndex,
      });

      rotateTrackToBottom(jumpedTrackIndex);

      if (adminPlaylistStatusEl) {
        adminPlaylistStatusEl.textContent = `live switched to track ${jumpedTrackIndex} (moved to bottom)`;
      }

      updateTransportLabel();
    } catch (err) {
      console.error("Admin jump error", err);

      manualGodModeOverrideUntilMs = Date.now() + 12 * 60 * 60 * 1000;
      suppressAdminSyncUntilMs = Date.now() + ADMIN_SEEK_SYNC_GRACE_MS;
      pendingRadioState = {
        trackIndex,
        positionMs: requestedPositionMs,
        playlistUrl: PLAYLIST_URL,
        serverTimeMs: Date.now(),
      };

      widget.load(PLAYLIST_URL, {
        auto_play: true,
        hide_related: true,
        show_user: false,
        show_comments: false,
        show_reposts: false,
        show_teaser: false,
        start_track: trackIndex,
      });

      rotateTrackToBottom(trackIndex);

      if (adminPlaylistStatusEl) {
        adminPlaylistStatusEl.textContent = "backend jump unavailable - local god jump active";
      }
    }
  }
  async function applyGodModeSeek(positionMs, source = "admin_seek") {
    if (!widget || !godModeEnabled) return false;
    if (!Number.isFinite(positionMs) || positionMs < 0) return false;
    if (adminSeekInFlight) return false;

    adminSeekInFlight = true;

    try {
      const trackIndex = await new Promise((resolve) => {
        if (typeof widget.getCurrentSoundIndex !== "function") {
          resolve(Number.isFinite(liveTrackIndex) ? liveTrackIndex : 0);
          return;
        }

        widget.getCurrentSoundIndex((idx) => {
          resolve(Number.isFinite(idx) ? idx : 0);
        });
      });

      const safePositionMs = Math.max(0, Math.floor(positionMs));

      const res = await fetch(ADMIN_JUMP_TRACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIndex, positionMs: safePositionMs }),
      });

      if (!res.ok) throw new Error("seek jump failed");

      const data = await res.json();
      const jumpedTrackIndex = Number.isFinite(data?.jumpedToTrackIndex)
        ? data.jumpedToTrackIndex
        : trackIndex;

      manualGodModeOverrideUntilMs = Date.now() + MANUAL_GOD_MODE_OVERRIDE_MS;
      suppressAdminSyncUntilMs = Date.now() + ADMIN_SEEK_SYNC_GRACE_MS;

      pendingRadioState = {
        trackIndex: jumpedTrackIndex,
        positionMs: safePositionMs,
        playlistUrl: PLAYLIST_URL,
        serverTimeMs: Date.now(),
      };

      widget.seekTo(safePositionMs);

      if (adminPlaylistStatusEl) {
        adminPlaylistStatusEl.textContent = `god seek ${formatTime(safePositionMs)} (${source})`;
      }

      return true;
    } catch (err) {
      console.error("God seek error", err);
      if (adminPlaylistStatusEl) {
        adminPlaylistStatusEl.textContent = "god seek failed";
      }
      return false;
    } finally {
      adminSeekInFlight = false;
    }
  }

  function requestGodModeSeek(positionMs, source = "admin_seek") {
    if (!godModeEnabled) return;
    if (Date.now() < suppressAdminSyncUntilMs) return;
    if (!Number.isFinite(positionMs) || positionMs < 0) return;

    const now = Date.now();
    const safePositionMs = Math.floor(positionMs);
    const nearSamePosition = Math.abs(safePositionMs - lastGodSeekPositionMs) < 1200;
    if (nearSamePosition && now - lastGodSeekRequestMs < ADMIN_SEEK_DEBOUNCE_MS) return;

    lastGodSeekRequestMs = now;
    lastGodSeekPositionMs = safePositionMs;
    void applyGodModeSeek(safePositionMs, source);
  }
  function getTracksForRender() {
    if (soundCloudPlaylistTracks.length) {
      const byIndex = new Map(soundCloudPlaylistTracks.map((track) => [track.index, track]));
      const ordered = (godPlaylistOrder.length ? godPlaylistOrder : soundCloudPlaylistTracks.map((t) => t.index))
        .map((idx) => byIndex.get(idx))
        .filter(Boolean);

      if (ordered.length) return ordered;
    }

    if (latestAdminState?.playlistStats?.tracks?.length) {
      return latestAdminState.playlistStats.tracks;
    }

    return FALLBACK_ADMIN_TRACKS;
  }

  function getVisibleUpcomingTracks(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return [];

    if (!Number.isFinite(liveTrackIndex)) {
      return [...tracks];
    }

    const livePos = tracks.findIndex((track) => track.index === liveTrackIndex);
    if (livePos < 0) {
      return [...tracks];
    }

    const visible = [];
    for (let step = 1; step <= tracks.length; step += 1) {
      const pos = (livePos + step) % tracks.length;
      visible.push(tracks[pos]);
    }

    return visible;
  }

  function getStartsForTrack(track) {
    if (Number.isFinite(track.approxStarts)) {
      return track.approxStarts;
    }

    const seen = trackSeenCounts.get(track.index);
    if (Number.isFinite(seen)) {
      return `seen ${seen}`;
    }

    return "n/a";
  }

  function renderPlaylistFromCurrentData() {
    if (!adminPlaylistListEl) return;

    const tracks = getTracksForRender();
    const visibleTracks = getVisibleUpcomingTracks(tracks);
    adminPlaylistListEl.innerHTML = "";

    if (!visibleTracks.length) {
      if (adminPlaylistStatusEl) {
        adminPlaylistStatusEl.textContent = "no playlist data";
      }
      return;
    }

    for (let i = 0; i < visibleTracks.length; i += 1) {
      const track = visibleTracks[i];
      const item = document.createElement("li");
      if (track.index === liveTrackIndex) {
        item.classList.add("playlist-live");
      }

      const head = document.createElement("div");
      head.className = "playlist-head";

      const order = document.createElement("span");
      order.className = "playlist-order";
      order.textContent = `next #${i + 1}`;

      const move = document.createElement("div");
      move.className = "playlist-move";

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.textContent = ">";
      playBtn.addEventListener("click", () => {
        playTrackFromPlaylistIndex(track.index);
      });
      move.appendChild(playBtn);

      if (soundCloudPlaylistTracks.length) {
        const orderIndex = godPlaylistOrder.indexOf(track.index);

        const up = document.createElement("button");
        up.type = "button";
        up.textContent = "^";
        up.addEventListener("click", async () => {
          await moveGodPlaylistItem(orderIndex, -1);
        });

        const down = document.createElement("button");
        down.type = "button";
        down.textContent = "v";
        down.addEventListener("click", async () => {
          await moveGodPlaylistItem(orderIndex, 1);
        });

        move.appendChild(up);
        move.appendChild(down);
      }

      head.appendChild(order);
      head.appendChild(move);

      const name = document.createElement("p");
      name.className = "playlist-track";
      name.textContent = track.title || `Track ${track.index}`;
      name.style.cursor = "pointer";
      name.addEventListener("click", () => {
        playTrackFromPlaylistIndex(track.index);
      });

      const meta = document.createElement("p");
      meta.className = "playlist-meta";
      meta.textContent = `index ${track.index} / starts ${getStartsForTrack(track)} / ${formatDuration(track.durationMs)}`;

      item.appendChild(head);
      item.appendChild(name);
      item.appendChild(meta);
      adminPlaylistListEl.appendChild(item);
    }
  }

  function renderAdminPanel(adminState) {
    if (!adminState) return;

    latestAdminState = adminState;
    if (Array.isArray(adminState.playlistOrder) && adminState.playlistOrder.length) {
      godPlaylistOrder = [...adminState.playlistOrder];
      savePlaylistOrder();
    }
    if (typeof adminState.radioState?.trackIndex === "number") {
      liveTrackIndex = adminState.radioState.trackIndex;
    }

    if (adminCurrentListenersEl) {
      adminCurrentListenersEl.textContent = String(adminState.currentListeners ?? "--");
    }
    if (adminMaxListenersEl) {
      adminMaxListenersEl.textContent = String(adminState.maxConcurrentListeners ?? "--");
    }
    if (adminTotalSessionsEl) {
      adminTotalSessionsEl.textContent = String(adminState.totalListenerSessions ?? "--");
    }
    if (adminUptimeEl) {
      adminUptimeEl.textContent = formatDuration(adminState.uptimeMs);
    }
    if (adminBootstrapEl) {
      adminBootstrapEl.textContent = adminState.bootstrapAccepted ? "locked" : "waiting";
    }
    if (adminLiveTrackEl) {
      adminLiveTrackEl.textContent = String(liveTrackIndex ?? "--");
    }
    if (adminPlaylistStatusEl) {
      adminPlaylistStatusEl.textContent = soundCloudPlaylistTracks.length
        ? `playlist loaded (${soundCloudPlaylistTracks.length} tracks)`
        : "admin data loaded";
    }

    renderPlaylistFromCurrentData();
  }

  function renderAdminFallbackPanel(radioState) {
    if (adminCurrentListenersEl) adminCurrentListenersEl.textContent = "n/a";
    if (adminMaxListenersEl) adminMaxListenersEl.textContent = "n/a";
    if (adminTotalSessionsEl) adminTotalSessionsEl.textContent = "n/a";
    if (adminUptimeEl) adminUptimeEl.textContent = "n/a";
    if (adminBootstrapEl) adminBootstrapEl.textContent = "admin api offline";

    if (typeof radioState?.trackIndex === "number") {
      liveTrackIndex = radioState.trackIndex;
    }
    if (adminLiveTrackEl) {
      adminLiveTrackEl.textContent = String(liveTrackIndex ?? "--");
    }
    if (adminPlaylistStatusEl && !soundCloudPlaylistTracks.length) {
      adminPlaylistStatusEl.textContent = "admin api offline - load sc playlist";
    }

    renderPlaylistFromCurrentData();
  }

  async function fetchAndRenderAdminState() {
    try {
      const res = await fetch(ADMIN_STATE_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to fetch admin state");
      const data = await res.json();
      renderAdminPanel(data);
    } catch (err) {
      console.error("Admin state error", err);
      const radioState = await fetchRadioState();
      renderAdminFallbackPanel(radioState);
    }
  }

  function startAdminRefreshLoop() {
    if (adminRefreshIntervalId != null) {
      window.clearInterval(adminRefreshIntervalId);
      adminRefreshIntervalId = null;
    }

    fetchAndRenderAdminState();
    adminRefreshIntervalId = window.setInterval(() => {
      fetchAndRenderAdminState();
    }, ADMIN_REFRESH_MS);
  }

  function stopAdminRefreshLoop() {
    if (adminRefreshIntervalId != null) {
      window.clearInterval(adminRefreshIntervalId);
      adminRefreshIntervalId = null;
    }
  }

  async function toggleGodMode() {
    godModeEnabled = !godModeEnabled;
    document.body.classList.toggle("god-mode", godModeEnabled);

    if (godModeEnabled) {
      startAdminRefreshLoop();
      await loadPlaylistFromWidget(true);

      if (!godPlaylistAutoPrepared) {
        await shuffleGodPlaylist();
        godPlaylistAutoPrepared = true;
      }

      if (adminPlaylistStatusEl && soundCloudPlaylistTracks.length) {
        adminPlaylistStatusEl.textContent = `playlist ready (${soundCloudPlaylistTracks.length}) / intro skip default 1m30s`;
      }
    } else {
      stopAdminRefreshLoop();
      manualGodModeOverrideUntilMs = 0;
    }
  }

  function setupGodModeToggle() {
    if (!roomLogo) return;

    roomLogo.addEventListener("click", async () => {
      await toggleGodMode();
    });

    roomLogo.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        await toggleGodMode();
      }
    });
  }

  function setupGodModeControls() {
    if (adminLoadPlaylistBtn) {
      adminLoadPlaylistBtn.addEventListener("click", async () => {
        await loadPlaylistFromWidget(true);
      });
    }

    if (adminShufflePlaylistBtn) {
      adminShufflePlaylistBtn.addEventListener("click", async () => {
        await shuffleGodPlaylist();
      });
    }

    if (adminResetPlaylistBtn) {
      adminResetPlaylistBtn.addEventListener("click", async () => {
        await resetGodPlaylistOrder();
      });
    }
  }


  function setupAdminPluginWidget() {
    if (!window.SC || !adminScPluginIframe) return;

    adminPluginWidget = window.SC.Widget(adminScPluginIframe);
    adminPluginWidget.bind(window.SC.Widget.Events.READY, () => {
      adminPluginReady = true;
      adminPluginWidget.setVolume(0);
    });

    if (window.SC.Widget.Events.SEEK) {
      adminPluginWidget.bind(window.SC.Widget.Events.SEEK, (event) => {
        const eventPos = Number.parseInt(event?.currentPosition ?? event, 10);
        requestGodModeSeek(eventPos, "plugin_seek");
      });
    }

    if (window.SC.Widget.Events.PLAY_PROGRESS) {
      adminPluginWidget.bind(window.SC.Widget.Events.PLAY_PROGRESS, (event) => {
        const eventPos = Number.parseInt(event?.currentPosition, 10);
        if (!Number.isFinite(eventPos)) return;

        const jumpDelta = Math.abs(eventPos - lastGodSeekPositionMs);
        if (jumpDelta > 5000) {
          requestGodModeSeek(eventPos, "plugin_progress_jump");
        }
      });
    }
  }

  function syncAdminWidgetToMain() {
    if (!widget || !adminPluginWidget || !adminPluginReady) return;
    if (adminSeekInFlight || Date.now() < suppressAdminSyncUntilMs) return;

    widget.getCurrentSoundIndex((mainIndex) => {
      if (!Number.isFinite(mainIndex)) return;

      adminPluginWidget.getCurrentSoundIndex((adminIndex) => {
        const alignPosition = () => {
          widget.getPosition((mainPosMs) => {
            if (!Number.isFinite(mainPosMs)) return;

            adminPluginWidget.getPosition((adminPosMs) => {
              if (!Number.isFinite(adminPosMs) || Math.abs(adminPosMs - mainPosMs) > 7000) {
                suppressAdminSyncUntilMs = Date.now() + 1200;
                adminPluginWidget.seekTo(mainPosMs);
              }
            });
          });
        };

        if (!Number.isFinite(adminIndex) || adminIndex !== mainIndex) {
          adminPluginWidget.load(PLAYLIST_URL, {
            auto_play: true,
            hide_related: false,
            show_user: true,
            show_comments: true,
            show_reposts: false,
            show_teaser: true,
            start_track: mainIndex,
          });
          window.setTimeout(alignPosition, 900);
          return;
        }

        alignPosition();
      });
    });
  }

  function startAdminWidgetSyncLoop() {
    if (adminWidgetSyncIntervalId != null) {
      window.clearInterval(adminWidgetSyncIntervalId);
      adminWidgetSyncIntervalId = null;
    }

    syncAdminWidgetToMain();
    adminWidgetSyncIntervalId = window.setInterval(() => {
      syncAdminWidgetToMain();
    }, 2500);
  }
  function setupSoundCloudWidget(initialState) {
    pendingRadioState = initialState || null;

    if (!window.SC || !scIframe) return;
    widget = window.SC.Widget(scIframe);

    widget.bind(window.SC.Widget.Events.READY, async () => {
      applyUserVolume();
      void loadPlaylistFromWidget(false);

      if (widgetReadyInitialized) {
        window.setTimeout(() => updateTrackTitle(true), 300);
        return;
      }
      widgetReadyInitialized = true;
      applyStartupPlaybackStrategy();
    });

    widget.bind(window.SC.Widget.Events.PLAY, () => {
      isPlaying = true;

      if (pendingRadioState) {
        const expectedPositionMs = getExpectedPositionMs(pendingRadioState);
        const targetPositionMs = Number.isFinite(expectedPositionMs)
          ? getStartPositionMs(expectedPositionMs)
          : getStartPositionMs(pendingRadioState.positionMs);
        widget.seekTo(targetPositionMs);
        pendingRadioState = null;
      } else if (fallbackMode && Number.isFinite(pendingFallbackSeekMs)) {
        widget.seekTo(pendingFallbackSeekMs);
        pendingFallbackSeekMs = null;
      }

      applyUserVolume();
      updateTrackTitle(true);
      updateTransportLabel();
      syncAdminWidgetToMain();
    });

    widget.bind(window.SC.Widget.Events.PAUSE, () => {
      isPlaying = false;
      updateTransportLabel();
      syncAdminWidgetToMain();
    });

    widget.bind(window.SC.Widget.Events.FINISH, () => {
      isPlaying = false;
      updateTransportLabel();
      syncAdminWidgetToMain();
    });
  }

  async function init() {
    if (!room || !scIframe) return;

    restorePlaylistOrder();
    ensureListenerId();
    setupGodModeToggle();
    setupGodModeControls();
    resetNowPlayingUi();
    updateTransportLabel();

    const radioStatePromise = fetchRadioState();
    setupAdminPluginWidget();
    setupSoundCloudWidget(null);

    startVisualizer();
    startRadioResyncLoop();
    startNowPlayingRefreshLoop();
    startListenerHeartbeatLoop();
    startAdminWidgetSyncLoop();

    radioStatePromise
      .then((radioState) => {
        radioStateResolved = true;
        pendingRadioState = radioState;
        applyStartupPlaybackStrategy();
      })
      .catch((_err) => {
        radioStateResolved = true;
        pendingRadioState = null;
        applyStartupPlaybackStrategy();
      });

    renderPlaylistFromCurrentData();

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

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        postListenerHeartbeat(true);
      }
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }

  window.addEventListener("beforeunload", () => {
    postListenerHeartbeat(false, true);

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
    if (adminRefreshIntervalId != null) {
      window.clearInterval(adminRefreshIntervalId);
    }
    if (listenerHeartbeatIntervalId != null) {
      window.clearInterval(listenerHeartbeatIntervalId);
    }
    if (adminWidgetSyncIntervalId != null) {
      window.clearInterval(adminWidgetSyncIntervalId);
    }
  });
})();
