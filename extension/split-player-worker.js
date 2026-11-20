(() => {
  'use strict';

  const PLAYER_WINDOW_KEY_PREFIX = 'ytcfSplitPlayer:';
  const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;
  const pendingBySourceTab = new Map();

  function screenBounds(layout) {
    const requested = layout && typeof layout === 'object' ? layout : {};
    const left = Number.isFinite(requested.left) ? requested.left : 0;
    const top = Number.isFinite(requested.top) ? requested.top : 0;
    const width = Number.isFinite(requested.width) ? requested.width : 1280;
    const height = Number.isFinite(requested.height) ? requested.height : 800;
    const halfWidth = Math.max(400, Math.floor(width / 2));
    return {
      source: { left, top, width: halfWidth, height },
      player: { left: left + halfWidth, top, width: Math.max(400, width - halfWidth), height },
    };
  }

  async function reusePlayerWindow(record, videoUrl) {
    if (!record?.windowId || !record?.tabId) return false;
    try {
      await chrome.tabs.update(record.tabId, { url: videoUrl, active: true });
      await chrome.windows.update(record.windowId, { focused: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function createPlayerPane(sourceTab, videoUrl) {
    // Chrome 155+ can pair the native YouTube tab with a second tab in one
    // built-in Split View. Earlier Chrome releases use two tiled windows.
    if (typeof chrome.tabs.createSplit === 'function') {
      try {
        const playerTab = await chrome.tabs.create({
          url: videoUrl,
          windowId: sourceTab.windowId,
          index: sourceTab.index + 1,
          active: true,
          splitWithTabId: sourceTab.id,
        });
        if (Number.isInteger(playerTab.splitViewId) && playerTab.splitViewId >= 0) {
          await chrome.windows.update(sourceTab.windowId, { focused: true });
          return { windowId: sourceTab.windowId, tabId: playerTab.id };
        }
        await chrome.tabs.remove(playerTab.id);
      } catch (_) {
        // If the source tab is already split or Chrome rejects the pairing,
        // use the side-by-side window layout below.
      }
    }

    return null;
  }

  async function openSplitPlayer(message, sender) {
    const sourceTab = sender?.tab;
    const videoId = String(message.videoId || '');
    if (!sourceTab?.id || !sourceTab.windowId || !VIDEO_ID_PATTERN.test(videoId)) {
      throw new Error('The clicked YouTube video or source tab is unavailable.');
    }

    const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const storageKey = `${PLAYER_WINDOW_KEY_PREFIX}${sourceTab.id}`;
    const saved = await chrome.storage.session.get(storageKey);
    if (await reusePlayerWindow(saved[storageKey], videoUrl)) return { ok: true, reused: true };
    await chrome.storage.session.remove(storageKey);

    const splitTab = await createPlayerPane(sourceTab, videoUrl);
    if (splitTab) {
      await chrome.storage.session.set({
        [storageKey]: {
          sourceTabId: sourceTab.id,
          windowId: splitTab.windowId,
          tabId: splitTab.tabId,
        },
      });
      return { ok: true, reused: false, layout: 'split-view' };
    }

    const bounds = screenBounds(message.layout);
    const playerWindow = await chrome.windows.create({
      url: videoUrl,
      type: 'normal',
      focused: false,
      left: bounds.player.left,
      top: bounds.player.top,
      width: bounds.player.width,
      height: bounds.player.height,
    });
    const playerTabs = playerWindow.id
      ? await chrome.tabs.query({ windowId: playerWindow.id })
      : [];
    const playerTabId = playerTabs[0]?.id;
    if (!playerWindow.id || !playerTabId) throw new Error('Chrome did not return the new player tab.');

    await chrome.storage.session.set({
      [storageKey]: {
        sourceTabId: sourceTab.id,
        windowId: playerWindow.id,
        tabId: playerTabId,
      },
    });
    await chrome.windows.update(sourceTab.windowId, {
      state: 'normal',
      ...bounds.source,
    });
    await chrome.windows.update(playerWindow.id, { focused: true });
    return { ok: true, reused: false };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'YTCF_OPEN_SPLIT_PLAYER') return false;
    const sourceTabId = sender?.tab?.id;
    const previous = pendingBySourceTab.get(sourceTabId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => openSplitPlayer(message, sender));
    pendingBySourceTab.set(sourceTabId, pending);
    pending
      .then(sendResponse)
      .catch((error) => {
        console.error('[YT Custom Feed] Could not open split player.', error);
        sendResponse({ ok: false, error: String(error?.message || error) });
      })
      .finally(() => {
        if (pendingBySourceTab.get(sourceTabId) === pending) pendingBySourceTab.delete(sourceTabId);
      });
    return true;
  });
})();
