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

  let widget = null;
  let isPlaying = false;
  let animationFrameId = null;
  let volume = 80;
  let pendingRadioState = null;
  let hasSyncedToRadio = false;
  let widgetReadyInitialized = false;
  let trackDurationMs = null;
  let trackTimeIntervalId = null;
  let radioResyncIntervalId = null;
  let nowPlayingRefreshIntervalId = null;
  let adminRefreshIntervalId = null;
  let listenerHeartbeatIntervalId = null;
  let manualGodModeOverrideUntilMs = 0;

  let fallbackMode = false;
  let bootstrapSubmitted = false;
  let pendingFallbackSeekMs = null;
  let userStopped = false;

  let godModeEnabled = false;
  let listenerId = null;

  let latestRadioState = null;
  let latestAdminState = null;
  let liveTrackIndex = null;

  let soundCloudPlaylistTracks = [];
  let godPlaylistOrder = [];
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

  function applyUserVolume() {
    if (!widget) return;
    widget.setVolume(userStopped ? 0 : volume);
  }

  function getRandomFallbackTrackIndex() {
    const pool = godPlaylistOrder.length
      ? godPlaylistOrder
      : soundCloudPlaylistTracks.map((t) => t.index);

    if (pool.length > 0) {
      const randomPos = Math.floor(Math.random() * pool.length);
      return pool[randomPos];
    }

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
          trackTimeEl.textContent = `${formatTime(elapsed)} / ${formatTime(trackDurationMs)}`;
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
    }, NOW_PLAYING_REFRESH_MS);
  }

  function syncWithRadioState(radioState) {
    if (!widget || !radioState) return;
    if (godModeEnabled && Date.now() < manualGodModeOverrideUntilMs) return;

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
        adminPlaylistStatusEl.textContent = `playlist loaded (${soundCloudPlaylistTracks.length} tracks)`;
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

    try {
      const res = await fetch(ADMIN_JUMP_TRACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIndex, positionMs: 0 }),
      });

      if (!res.ok) throw new Error("jump failed");

      const data = await res.json();
      const jumpedTrackIndex = Number.isFinite(data?.jumpedToTrackIndex)
        ? data.jumpedToTrackIndex
        : trackIndex;

      manualGodModeOverrideUntilMs = Date.now() + MANUAL_GOD_MODE_OVERRIDE_MS;

      pendingRadioState = {
        trackIndex: jumpedTrackIndex,
        positionMs: 0,
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
      pendingRadioState = {
        trackIndex,
        positionMs: 0,
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
    adminPlaylistListEl.innerHTML = "";

    if (!tracks.length) {
      if (adminPlaylistStatusEl) {
        adminPlaylistStatusEl.textContent = "no playlist data";
      }
      return;
    }

    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      const item = document.createElement("li");
      if (track.index === liveTrackIndex) {
        item.classList.add("playlist-live");
      }

      const head = document.createElement("div");
      head.className = "playlist-head";

      const order = document.createElement("span");
      order.className = "playlist-order";
      order.textContent = `#${i + 1}`;

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
        const up = document.createElement("button");
        up.type = "button";
        up.textContent = "^";
        up.addEventListener("click", async () => {
          await moveGodPlaylistItem(i, -1);
        });

        const down = document.createElement("button");
        down.type = "button";
        down.textContent = "v";
        down.addEventListener("click", async () => {
          await moveGodPlaylistItem(i, 1);
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

  function toggleGodMode() {
    godModeEnabled = !godModeEnabled;
    document.body.classList.toggle("god-mode", godModeEnabled);

    if (godModeEnabled) {
      startAdminRefreshLoop();
      loadPlaylistFromWidget(false);
    } else {
      stopAdminRefreshLoop();
      manualGodModeOverrideUntilMs = 0;
    }
  }

  function setupGodModeToggle() {
    if (!roomLogo) return;

    roomLogo.addEventListener("click", () => {
      toggleGodMode();
    });

    roomLogo.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleGodMode();
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

  function setupSoundCloudWidget(initialState) {
    pendingRadioState = initialState || null;

    if (!window.SC || !scIframe) return;
    widget = window.SC.Widget(scIframe);

    widget.bind(window.SC.Widget.Events.READY, async () => {
      applyUserVolume();
      await loadPlaylistFromWidget(false);

      if (widgetReadyInitialized) {
        window.setTimeout(() => updateTrackTitle(true), 300);
        return;
      }
      widgetReadyInitialized = true;

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

  async function init() {
    if (!room || !scIframe) return;

    restorePlaylistOrder();
    ensureListenerId();
    setupGodModeToggle();
    setupGodModeControls();
    resetNowPlayingUi();

    const radioState = await fetchRadioState();
    setupSoundCloudWidget(radioState);

    startVisualizer();
    startRadioResyncLoop();
    startNowPlayingRefreshLoop();
    startListenerHeartbeatLoop();

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
  });
})();
























