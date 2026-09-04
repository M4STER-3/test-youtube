"use strict";

const BRIDGE_CHANNEL = "focus-hub-youtube";
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{6,120}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const params = new URLSearchParams(window.location.search);

function cleanVideoId(value) {
  const id = String(value || "");
  return VIDEO_ID_PATTERN.test(id) ? id : "";
}

function cleanPlaylistId(value) {
  const id = String(value || "");
  return PLAYLIST_ID_PATTERN.test(id) ? id : "";
}

function cleanPlaylistIds(value) {
  return Array.isArray(value)
    ? value.map(cleanVideoId).filter(Boolean).slice(0, 1000)
    : [];
}

const initialPlaylistId = cleanPlaylistId(params.get("playlist"));
const initialVideoId = cleanVideoId(params.get("video"));
const initialIndex = Math.max(0, Number.parseInt(params.get("index") || "0", 10) || 0);

let player = null;
let playerReady = false;
let playerGeneration = 0;
let mediaType = initialPlaylistId ? "playlist" : (initialVideoId ? "video" : "");
let playlistId = initialPlaylistId;
let videoId = initialVideoId;
let playlistIds = [];
let playlistIndex = initialIndex;
let managedPlaylist = false;
let awaitingPlaylistData = false;
let pendingResumeVideoId = initialVideoId;
let playbackIntent = false;
let loopEnabled = false;
let shuffleEnabled = false;
let shuffleOrder = [];
let shuffleCursor = -1;
let presentationMode = params.get("presentation") === "background" ? "background" : "mini";
let pendingPresentationMode = "";
let requestedViewport = null;
let currentQuality = "";
let lastVolumeSignature = "";
let lastHeartbeatSignature = "";
let lastLoadAt = 0;
let recoveryStartedAt = 0;
let endedTimer = 0;
let resizeFrame = 0;
let parentOrigin = "*";
const pendingCommands = [];

try {
  const origin = document.referrer ? new URL(document.referrer).origin : "";
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) parentOrigin = origin;
} catch {
  parentOrigin = "*";
}

function getCurrentVideoId() {
  const dataId = cleanVideoId(player?.getVideoData?.()?.video_id);
  if (dataId) return dataId;
  try {
    return cleanVideoId(new URL(String(player?.getVideoUrl?.() || "")).searchParams.get("v"));
  } catch {
    return "";
  }
}

function closestPlaylistIndex(id, fallback = -1, ids = playlistIds) {
  const targetId = cleanVideoId(id);
  if (!targetId || !ids.length) return -1;
  const matches = [];
  ids.forEach((candidate, index) => {
    if (candidate === targetId) matches.push(index);
  });
  if (!matches.length) return -1;
  const safeFallback = Number.isFinite(Number(fallback)) ? Math.max(0, Math.floor(Number(fallback))) : -1;
  if (safeFallback < 0 || matches.length === 1) return matches[0];
  return matches.reduce((best, index) => (
    Math.abs(index - safeFallback) < Math.abs(best - safeFallback) ? index : best
  ), matches[0]);
}

function secureRandomIndex(max) {
  if (!Number.isFinite(max) || max <= 1) return 0;
  const ceiling = 0x100000000;
  const limit = ceiling - (ceiling % max);
  const sample = new Uint32Array(1);
  do {
    crypto.getRandomValues(sample);
  } while (sample[0] >= limit);
  return sample[0] % max;
}

function createShuffleOrder(currentIndex = playlistIndex) {
  const current = Math.min(Math.max(0, Number(currentIndex) || 0), Math.max(0, playlistIds.length - 1));
  const remaining = playlistIds.map((_, index) => index).filter((index) => index !== current);
  for (let index = remaining.length - 1; index > 0; index -= 1) {
    const target = secureRandomIndex(index + 1);
    [remaining[index], remaining[target]] = [remaining[target], remaining[index]];
  }
  shuffleOrder = playlistIds.length ? [current, ...remaining] : [];
  shuffleCursor = shuffleOrder.length ? 0 : -1;
}

function ensureShuffleOrder() {
  const valid = shuffleOrder.length === playlistIds.length &&
    shuffleOrder.every((index) => Number.isInteger(index) && index >= 0 && index < playlistIds.length) &&
    new Set(shuffleOrder).size === playlistIds.length;
  if (!valid) createShuffleOrder(playlistIndex);
  const cursor = shuffleOrder.indexOf(playlistIndex);
  if (cursor >= 0) shuffleCursor = cursor;
  else createShuffleOrder(playlistIndex);
}

function postBridgeEvent(event, data = {}) {
  if (window.parent === window) return;
  window.parent.postMessage({
    channel: BRIDGE_CHANNEL,
    kind: "event",
    event,
    mediaType,
    videoId,
    playlistId,
    data,
  }, parentOrigin);
}

function getSnapshot() {
  if (!playerReady || !player) return {};
  const runtimePlaylist = managedPlaylist ? playlistIds : cleanPlaylistIds(player.getPlaylist?.());
  const runtimeIndex = Number(player.getPlaylistIndex?.());
  if (!managedPlaylist && mediaType === "playlist" && Number.isFinite(runtimeIndex) && runtimeIndex >= 0) {
    playlistIndex = Math.floor(runtimeIndex);
  }
  const currentVideoId = managedPlaylist
    ? cleanVideoId(videoId)
    : (getCurrentVideoId() || cleanVideoId(videoId));
  const canonicalIndex = managedPlaylist
    ? playlistIndex
    : closestPlaylistIndex(currentVideoId, playlistIndex, runtimePlaylist);
  const data = player.getVideoData?.() || {};
  return {
    state: Number(player.getPlayerState?.()),
    shouldPlay: playbackIntent,
    volume: Number(player.getVolume?.()),
    muted: !!player.isMuted?.(),
    playlistIndex,
    playlistLength: runtimePlaylist.length,
    playlist: [...runtimePlaylist],
    canonicalPlaylistIndex: canonicalIndex >= 0 ? canonicalIndex : playlistIndex,
    canonicalPlaylistLength: playlistIds.length,
    canonicalPlaylist: [...playlistIds],
    currentVideoId,
    currentTime: Math.max(0, Number(player.getCurrentTime?.()) || 0),
    title: String(data.title || ""),
    author: String(data.author || ""),
    thumbnail: currentVideoId ? `https://i.ytimg.com/vi/${currentVideoId}/maxresdefault.jpg` : "",
    loopEnabled,
    shuffleEnabled,
    managedPlaylist,
    awaitingPlaylistData,
    quality: currentQuality || String(player.getPlaybackQuality?.() || ""),
  };
}

function publishState(event = "snapshot") {
  postBridgeEvent(event, getSnapshot());
}

function clearEndedTimer() {
  window.clearTimeout(endedTimer);
  endedTimer = 0;
}

function isNearEnd() {
  const duration = Math.max(0, Number(player?.getDuration?.()) || 0);
  const currentTime = Math.max(0, Number(player?.getCurrentTime?.()) || 0);
  return duration > 0 && currentTime >= Math.max(0, duration - 1.5);
}

function loadManagedIndex(index, autoplay = true, startSeconds = 0) {
  if (!managedPlaylist || !playlistIds.length || !playerReady || !player) return false;
  const safeIndex = Math.min(Math.max(0, Math.floor(Number(index) || 0)), playlistIds.length - 1);
  const targetId = playlistIds[safeIndex];
  if (!targetId) return false;
  clearEndedTimer();
  playlistIndex = safeIndex;
  videoId = targetId;
  pendingResumeVideoId = targetId;
  awaitingPlaylistData = false;
  playbackIntent = !!autoplay;
  lastLoadAt = Date.now();
  recoveryStartedAt = 0;
  const command = { videoId: targetId, startSeconds: Math.max(0, Number(startSeconds) || 0) };
  const currentId = getCurrentVideoId();
  if (currentId === targetId) {
    if (command.startSeconds > 0) player.seekTo?.(command.startSeconds, true);
    if (autoplay) player.playVideo?.();
    else player.pauseVideo?.();
  } else if (autoplay) {
    player.loadVideoById?.(command);
  } else {
    player.cueVideoById?.(command);
  }
  window.setTimeout(() => publishState("snapshot"), 80);
  return true;
}

function getManagedTarget(direction, reason = "manual") {
  if (!playlistIds.length) return -1;
  const step = direction < 0 ? -1 : 1;
  if (!shuffleEnabled) {
    const target = playlistIndex + step;
    if (target >= 0 && target < playlistIds.length) return target;
    if (loopEnabled || reason === "manual") return (target + playlistIds.length) % playlistIds.length;
    return -1;
  }

  ensureShuffleOrder();
  const targetCursor = shuffleCursor + step;
  if (targetCursor >= 0 && targetCursor < shuffleOrder.length) {
    shuffleCursor = targetCursor;
    return shuffleOrder[targetCursor];
  }
  if (!loopEnabled && reason !== "manual") return -1;
  if (step < 0) return playlistIndex;
  createShuffleOrder(playlistIndex);
  if (shuffleOrder.length <= 1) return playlistIndex;
  shuffleCursor = 1;
  return shuffleOrder[1];
}

function navigateManaged(direction, reason = "manual") {
  const target = getManagedTarget(direction, reason);
  if (target < 0) {
    playbackIntent = false;
    publishState("state");
    return false;
  }
  return loadManagedIndex(target, true, 0);
}

function scheduleManagedAdvance(generation, expectedIndex, expectedId) {
  if (endedTimer || !managedPlaylist || !playbackIntent) return;
  endedTimer = window.setTimeout(() => {
    endedTimer = 0;
    if (
      generation !== playerGeneration ||
      !playerReady ||
      !player ||
      !managedPlaylist ||
      !playbackIntent ||
      playlistIndex !== expectedIndex ||
      videoId !== expectedId
    ) return;
    const state = Number(player.getPlayerState?.());
    if (state !== 0 && !(state === 2 && isNearEnd())) return;
    if (!isNearEnd()) {
      publishState("state");
      return;
    }
    navigateManaged(1, "ended");
  }, 450);
}

function updateCanonicalPlaylist(nextIds) {
  const ids = cleanPlaylistIds(nextIds);
  if (!ids.length) return false;
  const oldIds = playlistIds;
  const loadedId = getCurrentVideoId();
  const currentId = pendingResumeVideoId || videoId || loadedId;
  const sameList = oldIds.length === ids.length && oldIds.every((id, index) => id === ids[index]);
  const matchedIndex = closestPlaylistIndex(currentId, playlistIndex, ids);
  playlistIds = ids;
  managedPlaylist = true;
  awaitingPlaylistData = false;
  playlistIndex = matchedIndex >= 0
    ? matchedIndex
    : Math.min(Math.max(0, playlistIndex), playlistIds.length - 1);
  videoId = playlistIds[playlistIndex];
  pendingResumeVideoId = videoId;
  if (shuffleEnabled && !sameList) createShuffleOrder(playlistIndex);
  if (!shuffleEnabled) {
    shuffleOrder = [];
    shuffleCursor = -1;
  }
  if (!loadedId || matchedIndex < 0) loadManagedIndex(playlistIndex, playbackIntent, 0);
  else publishState("snapshot");
  return true;
}

function requestPlaylistData() {
  awaitingPlaylistData = true;
  postBridgeEvent("playlistDataRequired", {
    ...getSnapshot(),
    playlistId,
    requestedIndex: playlistIndex,
    resumeVideoId: pendingResumeVideoId,
  });
}

function loadMedia(value = {}) {
  clearEndedTimer();
  const nextType = value.type === "playlist" ? "playlist" : "video";
  const autoplay = value.autoplay !== false;
  loopEnabled = !!value.loop;
  playbackIntent = autoplay;
  if (nextType === "playlist") {
    const nextPlaylistId = cleanPlaylistId(value.playlistId);
    if (!nextPlaylistId) {
      postBridgeEvent("error", { code: 2, message: "Identifiant de playlist invalide" });
      return;
    }
    mediaType = "playlist";
    playlistId = nextPlaylistId;
    playlistIndex = Math.max(0, Math.floor(Number(value.index) || 0));
    pendingResumeVideoId = cleanVideoId(value.resumeVideoId);
    const suppliedIds = cleanPlaylistIds(value.canonicalPlaylistIds || value.playlistIds);
    managedPlaylist = value.managedPlaylist === true || suppliedIds.length > 0;
    shuffleEnabled = !!value.shuffle;
    playlistIds = suppliedIds;
    if (playlistIds.length) {
      const resumeIndex = closestPlaylistIndex(pendingResumeVideoId, playlistIndex);
      if (resumeIndex >= 0) playlistIndex = resumeIndex;
      playlistIndex = Math.min(playlistIndex, playlistIds.length - 1);
      videoId = playlistIds[playlistIndex];
      pendingResumeVideoId = videoId;
      if (shuffleEnabled) createShuffleOrder(playlistIndex);
      else {
        shuffleOrder = [];
        shuffleCursor = -1;
      }
      loadManagedIndex(playlistIndex, autoplay, Math.max(0, Number(value.startSeconds) || 0));
      return;
    }
    if (managedPlaylist) {
      videoId = pendingResumeVideoId;
      if (videoId) {
        player[autoplay ? "loadVideoById" : "cueVideoById"]?.({
          videoId,
          startSeconds: Math.max(0, Number(value.startSeconds) || 0),
        });
      }
      requestPlaylistData();
      return;
    }
    player[autoplay ? "loadPlaylist" : "cuePlaylist"]?.({
      listType: "playlist",
      list: playlistId,
      index: playlistIndex,
      startSeconds: Math.max(0, Number(value.startSeconds) || 0),
    });
    return;
  }

  const nextVideoId = cleanVideoId(value.videoId);
  if (!nextVideoId) {
    postBridgeEvent("error", { code: 2, message: "Identifiant YouTube invalide" });
    return;
  }
  mediaType = "video";
  playlistId = "";
  playlistIds = [];
  playlistIndex = 0;
  managedPlaylist = false;
  awaitingPlaylistData = false;
  shuffleEnabled = false;
  shuffleOrder = [];
  shuffleCursor = -1;
  videoId = nextVideoId;
  pendingResumeVideoId = videoId;
  lastLoadAt = Date.now();
  player[autoplay ? "loadVideoById" : "cueVideoById"]?.({
    videoId,
    startSeconds: Math.max(0, Number(value.startSeconds) || 0),
  });
}

function recoverPlayback() {
  if (!playerReady || !player || !playbackIntent || document.hidden) return false;
  const state = Number(player.getPlayerState?.());
  if (state === 1 || state === 3) {
    recoveryStartedAt = 0;
    return false;
  }
  if (managedPlaylist && awaitingPlaylistData) {
    requestPlaylistData();
    return false;
  }
  if (managedPlaylist && state === 0 && isNearEnd()) return navigateManaged(1, "ended");
  if (state === 2 && !isNearEnd()) {
    player.playVideo?.();
    return true;
  }
  const currentId = getCurrentVideoId();
  if (videoId && currentId !== videoId) {
    if (managedPlaylist) return loadManagedIndex(playlistIndex, true, 0);
    player.loadVideoById?.(videoId);
    return true;
  }
  player.playVideo?.();
  return true;
}

function executeCommand(message) {
  if (!playerReady || !player) {
    pendingCommands.push(message);
    return;
  }
  const command = String(message.command || "");
  const value = message.value;
  switch (command) {
    case "loadMedia":
      loadMedia(value);
      break;
    case "play":
      playbackIntent = true;
      player.playVideo?.();
      break;
    case "pause":
      playbackIntent = false;
      clearEndedTimer();
      player.pauseVideo?.();
      break;
    case "toggle":
      playbackIntent = Number(player.getPlayerState?.()) !== 1;
      if (playbackIntent) player.playVideo?.();
      else player.pauseVideo?.();
      break;
    case "next":
      playbackIntent = true;
      if (managedPlaylist) navigateManaged(1, "manual");
      else player.nextVideo?.();
      break;
    case "previous":
      playbackIntent = true;
      if (managedPlaylist) navigateManaged(-1, "manual");
      else player.previousVideo?.();
      break;
    case "first":
      playbackIntent = true;
      if (managedPlaylist && playlistIds.length) {
        if (shuffleEnabled) createShuffleOrder(0);
        loadManagedIndex(0, true, 0);
      } else if (mediaType === "playlist") {
        player.playVideoAt?.(0);
      }
      break;
    case "restart":
      playbackIntent = true;
      player.seekTo?.(0, true);
      player.playVideo?.();
      break;
    case "setVolume":
      player.setVolume?.(Math.max(0, Math.min(100, Number(value) || 0)));
      break;
    case "setMuted":
      if (value) player.mute?.();
      else player.unMute?.();
      break;
    case "setLoop":
      loopEnabled = !!value;
      if (!managedPlaylist && mediaType === "playlist") player.setLoop?.(loopEnabled);
      break;
    case "setShuffle": {
      const nextShuffle = !!value;
      if (shuffleEnabled === nextShuffle) break;
      shuffleEnabled = nextShuffle;
      if (managedPlaylist) {
        if (shuffleEnabled) {
          createShuffleOrder(playlistIndex);
          if (shuffleOrder.length > 1) {
            shuffleCursor = 1;
            loadManagedIndex(shuffleOrder[1], true, 0);
          }
        } else {
          shuffleOrder = [];
          shuffleCursor = -1;
        }
      } else if (mediaType === "playlist") {
        player.setShuffle?.(shuffleEnabled);
      }
      break;
    }
    case "setCanonicalPlaylist":
      updateCanonicalPlaylist(value?.playlistIds);
      return;
    case "setPresentationMode":
      recreatePlayer(value === "background" ? "background" : "mini");
      return;
    case "setViewportSize":
      requestedViewport = value && typeof value === "object" ? value : null;
      scheduleResize();
      return;
    case "getState":
      publishState("snapshot");
      return;
    case "recover":
      recoverPlayback();
      window.setTimeout(() => publishState("snapshot"), 120);
      return;
    default:
      return;
  }
  window.setTimeout(() => publishState("snapshot"), 80);
}

function resizePlayer() {
  if (!playerReady || !player?.setSize) return;
  const width = Math.max(1, Math.round(Number(requestedViewport?.width) || window.innerWidth || 1));
  const height = Math.max(1, Math.round(Number(requestedViewport?.height) || window.innerHeight || 1));
  player.setSize(width, height);
}

function scheduleResize() {
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    resizePlayer();
  });
}

function buildPlayerConfig(generation, restore) {
  const config = {
    width: "100%",
    height: "100%",
    playerVars: {
      playsinline: 1,
      rel: 0,
      controls: presentationMode === "background" ? 0 : 1,
      disablekb: presentationMode === "background" ? 1 : 0,
      enablejsapi: 1,
    },
    events: {
      onReady: (event) => onPlayerReady(event, generation, restore),
      onStateChange: (event) => onPlayerStateChange(event, generation),
      onError: (event) => onPlayerError(event, generation),
      onPlaybackQualityChange: (event) => {
        if (generation !== playerGeneration || event.target !== player) return;
        currentQuality = String(event.data || "");
        publishState("quality");
      },
      onAutoplayBlocked: () => {
        if (generation !== playerGeneration) return;
        playbackIntent = false;
        recoveryStartedAt = 0;
        postBridgeEvent("autoplayBlocked", getSnapshot());
      },
    },
  };
  if (videoId) config.videoId = videoId;
  else if (window.parent === window && mediaType === "playlist" && playlistId && !managedPlaylist) {
    config.playerVars.listType = "playlist";
    config.playerVars.list = playlistId;
    config.playerVars.index = playlistIndex;
  }
  return config;
}

function ensurePlayerTarget() {
  if (document.getElementById("player")) return;
  const target = document.createElement("div");
  target.id = "player";
  document.body.prepend(target);
}

function createPlayer(restore = null) {
  ensurePlayerTarget();
  const generation = ++playerGeneration;
  playerReady = false;
  player = new YT.Player("player", buildPlayerConfig(generation, restore));
}

function onPlayerReady(event, generation, restore = null) {
  if (generation !== playerGeneration || event.target !== player) return;
  playerReady = true;
  const iframe = player.getIframe?.();
  if (iframe) {
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
  }
  resizePlayer();
  if (restore) {
    player.setVolume?.(restore.volume);
    if (restore.muted) player.mute?.();
    else player.unMute?.();
    if (restore.currentTime > 0) player.seekTo?.(restore.currentTime, true);
    playbackIntent = !!restore.shouldPlay;
    if (playbackIntent) player.playVideo?.();
    else player.pauseVideo?.();
  }
  postBridgeEvent("ready", getSnapshot());
  const queuedCommands = pendingCommands.splice(0);
  queuedCommands.forEach((command) => executeCommand(command));
  if (pendingPresentationMode && pendingPresentationMode !== presentationMode) {
    const nextMode = pendingPresentationMode;
    pendingPresentationMode = "";
    window.setTimeout(() => recreatePlayer(nextMode), 0);
    return;
  }
  pendingPresentationMode = "";
  if (window.parent === window && mediaType && !restore) {
    loadMedia({
      type: mediaType,
      playlistId,
      videoId,
      index: playlistIndex,
      autoplay: true,
      loop: loopEnabled,
      shuffle: shuffleEnabled,
    });
  }
}

function onPlayerStateChange(event, generation) {
  if (generation !== playerGeneration || event.target !== player) return;
  const state = Number(event.data);
  const currentId = getCurrentVideoId();
  if (currentId && (!managedPlaylist || !videoId || currentId === videoId)) {
    videoId = currentId;
    if (managedPlaylist) {
      const matched = closestPlaylistIndex(currentId, playlistIndex);
      if (matched >= 0) playlistIndex = matched;
    }
  }
  if (state === 1) {
    playbackIntent = true;
    recoveryStartedAt = 0;
    clearEndedTimer();
  } else if (state === 2) {
    if (managedPlaylist && playbackIntent && isNearEnd()) {
      scheduleManagedAdvance(generation, playlistIndex, videoId);
    } else if (Date.now() - lastLoadAt > 2000) {
      playbackIntent = false;
    }
  } else if (state === 0) {
    if (managedPlaylist && playbackIntent) {
      scheduleManagedAdvance(generation, playlistIndex, videoId);
    } else if (mediaType === "video" && loopEnabled && playbackIntent) {
      player.seekTo?.(0, true);
      player.playVideo?.();
    }
  } else if (state === 3) {
    recoveryStartedAt = 0;
  }
  publishState("state");
}

function onPlayerError(event, generation) {
  if (generation !== playerGeneration || event.target !== player) return;
  clearEndedTimer();
  postBridgeEvent("error", { ...getSnapshot(), code: Number(event.data) || 0 });
}

function recreatePlayer(nextMode) {
  if (!playerReady || !player) {
    pendingPresentationMode = nextMode;
    return;
  }
  if (nextMode === presentationMode) {
    pendingPresentationMode = "";
    return;
  }
  clearEndedTimer();
  const snapshot = getSnapshot();
  const restore = {
    currentTime: snapshot.currentTime,
    shouldPlay: snapshot.shouldPlay,
    volume: Math.max(0, Math.min(100, Number(snapshot.volume) || 0)),
    muted: !!snapshot.muted,
  };
  pendingPresentationMode = "";
  presentationMode = nextMode;
  const previous = player;
  player = null;
  playerReady = false;
  playerGeneration += 1;
  try {
    previous?.destroy?.();
  } catch {
    // La nouvelle cible remplace toute iframe deja retiree par YouTube.
  }
  ensurePlayerTarget();
  createPlayer(restore);
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.channel !== BRIDGE_CHANNEL || message.kind !== "command") return;
  if (parentOrigin !== "*" && event.origin !== parentOrigin) return;
  if (parentOrigin === "*" && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(event.origin)) {
    parentOrigin = event.origin;
  }
  executeCommand(message);
});

window.addEventListener("resize", scheduleResize);
window.visualViewport?.addEventListener("resize", scheduleResize);
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !playbackIntent) return;
  window.setTimeout(recoverPlayback, 250);
  window.setTimeout(recoverPlayback, 1800);
});

window.setInterval(() => {
  if (!playerReady || !player) return;
  const volumeSignature = `${player.getVolume?.()}-${!!player.isMuted?.()}`;
  if (volumeSignature !== lastVolumeSignature) {
    lastVolumeSignature = volumeSignature;
    publishState("volume");
  }
  const state = Number(player.getPlayerState?.());
  const heartbeatSignature = `${state}-${playlistIndex}-${getCurrentVideoId()}-${playlistIds.length}-${shuffleEnabled}`;
  if (heartbeatSignature !== lastHeartbeatSignature) {
    lastHeartbeatSignature = heartbeatSignature;
    publishState("snapshot");
  }
  if (!playbackIntent || document.hidden || state === 1 || state === 3 || awaitingPlaylistData) {
    recoveryStartedAt = 0;
    return;
  }
  if (!recoveryStartedAt) recoveryStartedAt = Date.now();
  if (Date.now() - recoveryStartedAt < 12000) return;
  recoveryStartedAt = Date.now();
  if (state === 0 && managedPlaylist && isNearEnd()) navigateManaged(1, "ended");
  else recoverPlayback();
}, 500);

window.onYouTubeIframeAPIReady = () => createPlayer();
const apiScript = document.createElement("script");
apiScript.src = "https://www.youtube.com/iframe_api";
apiScript.referrerPolicy = "strict-origin-when-cross-origin";
apiScript.onerror = () => postBridgeEvent("error", { code: 5, message: "API YouTube inaccessible" });
document.head.appendChild(apiScript);
