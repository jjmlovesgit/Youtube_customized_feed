(() => {
  'use strict';

  if (globalThis.__ytCustomFeedInstalled) return;
  globalThis.__ytCustomFeedInstalled = true;

  const rules = globalThis.YTCFFilterRules;
  if (!rules) {
    console.error('[YT Custom Feed] Filter rules did not load.');
    return;
  }

  document.documentElement?.classList?.add('ytcf-layout-mounted');
  document.documentElement?.classList?.add('ytcf-booting');

  const STORAGE_KEY = 'ytCustomFeedSettings';
  const BLOCKED_CHANNELS_STORAGE_KEY = 'ytCustomFeedBlockedChannels';
  const FEED_ORDER_STORAGE_PREFIX = 'ytcfFeedOrder:v1:';
  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-playlist-renderer',
    'ytd-radio-renderer',
    'ytd-podcast-renderer',
    'ytd-podcast-show-renderer',
    'ytd-reel-item-renderer',
    'ytd-reel-video-renderer',
    'yt-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
    'yt-lockup-view-model',
  ].join(', ');
  const POST_SELECTOR = [
    'ytd-backstage-post-thread-renderer',
    'ytd-backstage-post-renderer',
    'ytd-post-renderer',
    'yt-post-lockup-view-model',
  ].join(', ');
  const AD_SELECTOR = [
    'ytd-ad-slot-renderer',
    'ytd-promoted-video-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-display-ad-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-search-pyv-renderer',
  ].join(', ');
  const SPECIAL_SECTION_SELECTOR = [
    'ytd-feed-filter-chip-bar-renderer',
    'ytd-related-chip-cloud-renderer',
    'yt-chip-cloud-renderer',
    'ytd-horizontal-card-list-renderer',
    'ytd-rich-section-renderer',
    'ytd-rich-shelf-renderer',
    'ytd-reel-shelf-renderer',
    'ytd-shorts-shelf-renderer',
    'ytd-podcast-shelf-renderer',
    POST_SELECTOR,
    AD_SELECTOR,
    '#chips-wrapper',
  ].join(', ');

  let settings = { ...rules.DEFAULT_SETTINGS };
  let settingsReady = false;
  let settingsRevision = 0;
  let hiddenCount = 0;
  let scanTimer = null;
  let scanNeedsFullPass = false;
  let repaintTimers = [];
  let channelFeedbackInProgress = false;
  let nextOriginalOrder = 0;
  let activeFeedOrderKey = '';
  let nextStableVideoRank = 0;
  let stableVideoRanks = new Map();
  let blockedChannelKeys = new Set();
  const originalOrder = new WeakMap();
  const styledSortTargets = new Set();
  const styledSortContainers = new Set();
  const compactLayoutParts = new Set();
  const activeReflowAnimations = new WeakMap();
  const ownedBlockButtons = new WeakSet();

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function firstText(root, selector) {
    const element = root.querySelector?.(selector);
    return cleanText(element?.getAttribute?.('title') || element?.getAttribute?.('aria-label') || element?.textContent);
  }

  function normalizeChannelKey(value) {
    return cleanText(value).toLowerCase();
  }

  function channelKey(card) {
    const channelLink = card.querySelector?.(
      'a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"]',
    );
    const channelHref = channelLink?.getAttribute?.('href') || '';
    if (channelHref) return `href:${normalizeChannelKey(channelHref.split(/[?#]/)[0])}`;
    const channelName = firstText(card, '#channel-name, .ytd-channel-name, [class*="channel-name"], [class*="metadata"] a');
    return channelName ? `name:${normalizeChannelKey(channelName)}` : '';
  }

  function feedOrderStorageKey() {
    const route = `${globalThis.location?.pathname || '/'}${globalThis.location?.search || ''}`;
    return `${FEED_ORDER_STORAGE_PREFIX}${encodeURIComponent(route)}`;
  }

  function loadStableVideoRanks() {
    const storageKey = feedOrderStorageKey();
    if (storageKey === activeFeedOrderKey) return;

    activeFeedOrderKey = storageKey;
    stableVideoRanks = new Map();
    nextStableVideoRank = 0;
    try {
      const savedRanks = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || '[]');
      if (!Array.isArray(savedRanks)) return;
      for (const entry of savedRanks) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [videoId, rank] = entry;
        if (typeof videoId !== 'string' || !Number.isFinite(rank)) continue;
        stableVideoRanks.set(videoId, rank);
        nextStableVideoRank = Math.max(nextStableVideoRank, rank + 1);
      }
    } catch (_) {
      // Session storage may be unavailable in restricted browser contexts.
    }
  }

  function videoIdFromHref(href) {
    const value = String(href || '');
    const match = value.match(/(?:[?&]v=|\/(?:shorts|live|embed)\/)([a-zA-Z0-9_-]{11})(?:[&#?]|$)/);
    return match?.[1] || '';
  }

  function preserveFeedOrder(cards) {
    loadStableVideoRanks();
    let changed = false;
    for (const metadata of cards.values()) {
      const videoId = videoIdFromHref(metadata.href);
      if (!videoId || stableVideoRanks.has(videoId)) continue;
      stableVideoRanks.set(videoId, nextStableVideoRank++);
      changed = true;
    }
    if (!changed) return;

    try {
      // Keep the current tab's sequence across YouTube's SPA watch/back
      // navigation. Store only loaded video IDs and their small integer ranks.
      const entries = Array.from(stableVideoRanks.entries());
      globalThis.sessionStorage?.setItem(activeFeedOrderKey, JSON.stringify(entries));
    } catch (_) {
      // Sorting remains available even when session storage is blocked.
    }
  }

  function stableVideoRank(metadata) {
    const videoId = videoIdFromHref(metadata?.href);
    return videoId ? stableVideoRanks.get(videoId) ?? null : null;
  }

  function findCardMenuButton(card) {
    return card.querySelector?.(
      '#menu ytd-menu-renderer yt-icon-button#button, #menu button, ' +
      'ytd-menu-renderer yt-icon-button#button, ytd-menu-renderer button[aria-label], ' +
      'button[aria-label*="Action menu" i], button[aria-label*="More actions" i]',
    ) || null;
  }

  function findDontRecommendMenuItem() {
    const menuItems = document.querySelectorAll?.(
      'ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model',
    ) || [];
    return Array.from(menuItems).find((item) => {
      const popup = item.closest?.('ytd-menu-popup-renderer, tp-yt-iron-dropdown, ytd-popup-container');
      if (popup?.getAttribute?.('aria-hidden') === 'true') return false;
      return /don['’]t recommend channel/i.test(cleanText(item.textContent));
    }) || null;
  }

  function waitForDontRecommendMenuItem(timeoutMs = 1200) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const poll = () => {
        const match = findDontRecommendMenuItem();
        if (match || Date.now() - startedAt >= timeoutMs) {
          resolve(match);
          return;
        }
        setTimeout(poll, 40);
      };
      poll();
    });
  }

  function setBlockButtonState(button, label, busy = false) {
    button.textContent = label;
    // Keep the overlay as a live control. YouTube may move or restyle the
    // surrounding lockup while its menu is open, and a native disabled button
    // then stops receiving the event needed to recover or retry.
    button.disabled = false;
    button.setAttribute?.('aria-busy', String(busy));
    if (button.dataset) button.dataset.ytcfBusy = String(busy);
  }

  function restoreBlockButton(button, label) {
    setBlockButtonState(button, label);
    setTimeout(() => setBlockButtonState(button, '🚫 Block Channel'), 1400);
  }

  function closeNativeMenu() {
    if (typeof KeyboardEvent !== 'function') return;
    document.dispatchEvent?.(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
    }));
  }

  async function executeDontRecommendSequence(card, button) {
    if (channelFeedbackInProgress) return;
    if ((globalThis.location?.pathname || '') === '/results') {
      const key = channelKey(card);
      if (!key) {
        restoreBlockButton(button, 'Unavailable');
        return;
      }
      blockedChannelKeys.add(key);
      chrome.storage.local.set({
        [BLOCKED_CHANNELS_STORAGE_KEY]: Array.from(blockedChannelKeys),
      });
      setBlockButtonState(button, 'Blocked');
      scan({ animateLayout: true, fullPass: true });
      return;
    }
    const menuButton = findCardMenuButton(card);
    if (!menuButton) {
      restoreBlockButton(button, 'Unavailable');
      return;
    }

    channelFeedbackInProgress = true;
    setBlockButtonState(button, 'Working…', true);
    document.body?.classList?.add('ytcf-suppress-popup');

    try {
      menuButton.click();
      const targetItem = await waitForDontRecommendMenuItem();
      if (!targetItem) {
        closeNativeMenu();
        restoreBlockButton(button, 'Unavailable');
        return;
      }

      targetItem.click();
      setBlockButtonState(button, 'Blocked', true);
      card.classList?.add('ytcf-card-banishing');
      setTimeout(() => {
        card.dataset.ytcfBanished = 'true';
        card.classList?.remove('ytcf-card-banishing');
      }, 300);
    } catch (error) {
      console.warn('[YT Custom Feed] Could not run Don\'t recommend channel.', error);
      closeNativeMenu();
      restoreBlockButton(button, 'Try again');
    } finally {
      setTimeout(() => document.body?.classList?.remove('ytcf-suppress-popup'), 180);
      channelFeedbackInProgress = false;
    }
  }

  function injectBlockChannelButton(card) {
    if (!document.createElement) return;
    const existingButton = card.querySelector?.('.ytcf-block-channel-btn');
    if (existingButton && ownedBlockButtons.has(existingButton)) {
      existingButton.disabled = false;
      return;
    }
    if (existingButton) {
      // Extension reloads can leave our old DOM behind after its isolated
      // JavaScript world (and therefore its event listeners) has been torn
      // down. Replace an unowned badge instead of trusting the stale node.
      const staleHost = existingButton.parentElement;
      existingButton.remove?.();
      if (!staleHost?.querySelector?.('.ytcf-block-channel-btn')) {
        staleHost?.classList?.remove('ytcf-block-button-host');
      }
    }
    if (!findCardMenuButton(card)) return;
    const thumbnail = card.querySelector?.(
      'ytd-thumbnail, yt-thumbnail-view-model, #thumbnail-container, a#thumbnail, #thumbnail',
    );
    if (!thumbnail) return;

    // Newer lockup cards wrap `yt-thumbnail-view-model` in the video link.
    // A button nested inside that anchor can still activate YouTube navigation,
    // even when its click handler stops propagation. Mount beside the anchor.
    const thumbnailAnchor = thumbnail.matches?.('a') ? thumbnail : thumbnail.closest?.('a');
    const buttonHost = thumbnailAnchor?.parentElement || thumbnail;
    buttonHost.classList?.add('ytcf-block-button-host');
    const button = document.createElement('button');
    button.className = 'ytcf-block-channel-btn';
    button.type = 'button';
    button.title = "Use YouTube's Don't recommend channel action";
    button.setAttribute('aria-label', "Don't recommend this channel");
    button.textContent = '🚫 Block Channel';
    ownedBlockButtons.add(button);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      void executeDontRecommendSequence(card, button);
    });
    buttonHost.append(button);
  }

  function blockButtonFromEvent(event) {
    const path = event.composedPath?.() || [];
    const pathButton = Array.from(path).find((element) =>
      element?.matches?.('.ytcf-block-channel-btn'),
    );
    if (pathButton) return pathButton;

    const clickTarget = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    return clickTarget?.closest?.('.ytcf-block-channel-btn') || null;
  }

  function onBlockChannelClick(event) {
    const button = blockButtonFromEvent(event);
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const card = button.closest?.(CARD_SELECTOR);
    if (card) void executeDontRecommendSequence(card, button);
  }

  function ageMetadataText(root) {
    const pieces = [root.innerText, root.textContent];
    const candidates = root.querySelectorAll?.(
      '#metadata-line, #metadata-line span, [id*="metadata"], [class*="metadata"], ' +
      '[aria-label*="ago"], [title*="ago"]',
    ) || [];
    for (const candidate of candidates) {
      pieces.push(
        candidate.getAttribute?.('aria-label'),
        candidate.getAttribute?.('title'),
        candidate.innerText,
        candidate.textContent,
      );
    }
    return cleanText(pieces.filter(Boolean).join(' '));
  }

  function hasSponsoredBadge(card) {
    const badges = card.querySelectorAll?.(
      '[aria-label="Sponsored" i], [title="Sponsored" i], ' +
      'ytd-badge-supported-renderer, badge-shape, ' +
      '[class*="metadata-line" i], [class*="metadata-text" i]',
    ) || [];
    return Array.from(badges).some((badge) => [
        badge.getAttribute?.('aria-label'),
        badge.getAttribute?.('title'),
        badge.innerText,
        badge.textContent,
      ].some((value) => /^sponsored(?:\s*[·•]|$)/i.test(cleanText(value))));
  }

  function cardMetadata(card) {
    const title = firstText(card, '#video-title, #video-title-link, .yt-lockup-metadata-view-model-wiz__title, h3, [role="heading"]');
    const channel = firstText(card, '#channel-name, .ytd-channel-name, [class*="channel-name"], [class*="metadata"] a');
    const href = card.querySelector?.('a[href*="/watch"], a[href*="/shorts/"]')?.getAttribute?.('href') || '';
    // YouTube marks music videos with a musical-note glyph inside the
    // duration badge. Inspect that badge's own text and semantic icon labels;
    // generic SVGs elsewhere in the card are common on ordinary videos.
    const durationBadges = card.querySelectorAll?.(
      'ytd-thumbnail-overlay-time-status-renderer, [overlay-style], badge-shape',
    ) || [];
    const hasMusicBadge = Array.from(durationBadges).some((badge) => {
      const badgeDuration = cleanText(badge.querySelector?.('.ytBadgeShapeText')?.textContent || '');
      const iconographicThumbnailBadge = badge.matches?.(
        'yt-thumbnail-badge-view-model badge-shape.ytBadgeShapeIconography[role="img"]',
      ) && /\d+:\d+/.test(badgeDuration) && Boolean(
        badge.querySelector?.('.ytBadgeShapeIcon svg') &&
        badge.querySelector?.('.ytBadgeShapeText'),
      );
      if (iconographicThumbnailBadge) return true;

      const icon = badge.querySelector?.(
        'yt-icon[icon*="music" i], yt-icon[icon*="note" i], ' +
        '[aria-label*="music" i], [title*="music" i], [class*="music-note" i]',
      );
      const badgeText = cleanText([
        badge.getAttribute?.('aria-label'),
        badge.getAttribute?.('title'),
        badge.getAttribute?.('overlay-style'),
        badge.innerText,
        badge.textContent,
        icon?.getAttribute?.('aria-label'),
        icon?.getAttribute?.('title'),
        icon?.getAttribute?.('icon'),
        icon?.getAttribute?.('class'),
        icon?.textContent,
      ].filter(Boolean).join(' '));
      return /\d+:\d+/.test(badgeText) && /music|musical|music_note|[♪♫]/i.test(badgeText);
    });
    return {
      title,
      channel,
      href,
      metadata: ageMetadataText(card),
      tagName: String(card.tagName || '').toLowerCase(),
      channelKey: channelKey(card),
      hasPlaylistMarkup: Boolean(card.querySelector?.('a[href*="list="], ytd-thumbnail-overlay-bottom-panel-renderer')),
      hasMusicBadge,
      hasPodcastMarkup: Boolean(card.querySelector?.(
        'a[href*="/podcast"], [aria-label*="podcast" i], [title*="podcast" i]',
      )),
      hasArtistBadge: Boolean(card.querySelector?.('[aria-label*="Official Artist Channel"], yt-icon[icon="official-artist"]')),
      hasSponsoredBadge: hasSponsoredBadge(card),
    };
  }

  function layoutTarget(card) {
    return card.closest?.(
      'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ' +
      'ytd-playlist-renderer, ytd-radio-renderer, ytd-podcast-renderer, ytd-podcast-show-renderer, ytd-reel-item-renderer',
    ) || card;
  }

  function isPostElement(element) {
    const tagName = String(element?.tagName || '').toLowerCase();
    return [
      'ytd-backstage-post-thread-renderer',
      'ytd-backstage-post-renderer',
      'ytd-post-renderer',
      'yt-post-lockup-view-model',
    ].includes(tagName);
  }

  function sectionLayoutTarget(element) {
    if (!isPostElement(element) && !element.matches?.(AD_SELECTOR)) return element;
    return element.closest?.('ytd-rich-item-renderer, ytd-video-renderer') || element;
  }

  function collectCardMetadata() {
    const cards = new Map();
    for (const card of document.querySelectorAll?.(CARD_SELECTOR) || []) {
      const outerCard = layoutTarget(card);
      if (outerCard !== card && cards.has(outerCard)) continue;
      if (isPostElement(outerCard) || outerCard.querySelector?.(POST_SELECTOR)) continue;
      if (settings.enabled) injectBlockChannelButton(outerCard);
      if (!originalOrder.has(outerCard)) originalOrder.set(outerCard, nextOriginalOrder++);
      cards.set(outerCard, cardMetadata(outerCard));
    }
    return cards;
  }

  function onFeedVideoClick(event) {
    const pathname = globalThis.location?.pathname || '/';
    if (!settings.enabled || /^\/(?:watch|shorts|live|embed|clip)(?:\/|$)/.test(pathname) || event.defaultPrevented ||
        (Number.isFinite(event.button) && event.button !== 0) || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey) return;
    const clickTarget = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const path = event.composedPath?.() || [];
    const cameFromControl = Array.from(path).some((element) =>
      element?.matches?.('button, input, .ytcf-block-channel-btn'),
    );
    if (!clickTarget || cameFromControl || clickTarget.closest?.('button, input, .ytcf-block-channel-btn')) return;
    // YouTube may place tracking parameters before `v` in some watch links.
    const anchor = clickTarget.closest?.('a[href*="/watch"]');
    if (!anchor || anchor.target === '_blank') return;
    const clickedVideoId = videoIdFromHref(anchor.href || anchor.getAttribute?.('href'));
    if (!clickedVideoId) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const layout = globalThis.screen ? {
      left: Number(globalThis.screen.availLeft) || 0,
      top: Number(globalThis.screen.availTop) || 0,
      width: Number(globalThis.screen.availWidth) || Number(globalThis.outerWidth) || 1280,
      height: Number(globalThis.screen.availHeight) || Number(globalThis.outerHeight) || 800,
    } : null;
    chrome.runtime.sendMessage({
      type: 'YTCF_OPEN_SPLIT_PLAYER',
      videoId: clickedVideoId,
      layout,
    });
  }

  function elementForMutationNode(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function isEvaluatedInViewport(element) {
    if (element?.dataset?.ytcfEvaluated !== 'true' || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    const viewportHeight = Number.isFinite(globalThis.innerHeight)
      ? globalThis.innerHeight
      : document.documentElement?.clientHeight;
    const viewportWidth = Number.isFinite(globalThis.innerWidth)
      ? globalThis.innerWidth
      : document.documentElement?.clientWidth;
    if (!Number.isFinite(viewportHeight) || !Number.isFinite(viewportWidth)) return false;
    return rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
  }

  function markElementPending(element) {
    if (!element || isEvaluatedInViewport(element)) return;
    delete element.dataset?.ytcfEvaluated;
  }

  function markCardPending(card) {
    if (!card) return;
    const target = layoutTarget(card);
    if (target !== card && isEvaluatedInViewport(target)) {
      // YouTube hydrates the nested lockup (including its thumbnail) after the
      // outer Home card is ready. Inherit the visible parent's state before
      // paint so the thumbnail is not left behind the pending-card guard.
      card.dataset.ytcfEvaluated = 'true';
      return;
    }
    markElementPending(target);
    if (target !== card) delete card.dataset?.ytcfEvaluated;
  }

  function isExtensionUiMutation(mutation) {
    const target = elementForMutationNode(mutation.target);
    if (target?.matches?.('.ytcf-block-channel-btn') || target?.closest?.('.ytcf-block-channel-btn')) return true;
    const addedNodes = Array.from(mutation.addedNodes || []);
    return addedNodes.length > 0 && addedNodes.every((node) => {
      const element = elementForMutationNode(node);
      return element?.matches?.('.ytcf-block-channel-btn');
    });
  }

  function markMutationCardsPending(mutations) {
    if (!settings.enabled) {
      scheduleScan();
      return;
    }

    for (const mutation of mutations || []) {
      if (isExtensionUiMutation(mutation)) continue;
      const target = elementForMutationNode(mutation.target);
      const targetCard = target?.matches?.(CARD_SELECTOR) ? target : target?.closest?.(CARD_SELECTOR);
      markCardPending(targetCard);
      const targetSection = target?.matches?.(SPECIAL_SECTION_SELECTOR)
        ? target
        : target?.closest?.(SPECIAL_SECTION_SELECTOR);
      markElementPending(targetSection);

      for (const node of mutation.addedNodes || []) {
        const element = elementForMutationNode(node);
        if (!element) continue;
        if (element.matches?.(CARD_SELECTOR)) markCardPending(element);
        for (const nestedCard of element.querySelectorAll?.(CARD_SELECTOR) || []) {
          markCardPending(nestedCard);
        }
        if (element.matches?.(SPECIAL_SECTION_SELECTOR)) markElementPending(element);
        for (const nestedSection of element.querySelectorAll?.(SPECIAL_SECTION_SELECTOR) || []) {
          markElementPending(nestedSection);
        }
      }
    }
    scheduleScan();
  }

  function clearSortPresentation() {
    for (const target of styledSortTargets) {
      target.style?.removeProperty?.('order');
      if (target.style && !target.style.removeProperty) target.style.order = '';
      delete target.dataset?.ytcfSortOrder;
    }
    for (const container of styledSortContainers) {
      delete container.dataset?.ytcfSortContainer;
    }
    styledSortTargets.clear();
    styledSortContainers.clear();
  }

  function clearCompactPresentation() {
    for (const element of compactLayoutParts) {
      delete element.dataset?.ytcfRowShell;
      delete element.dataset?.ytcfRowThumbnail;
      delete element.dataset?.ytcfRowDetails;
      delete element.dataset?.ytcfCompactCard;
      delete element.dataset?.ytcfCompactRow;
    }
    compactLayoutParts.clear();
  }

  function directChildContaining(parent, descendant) {
    return Array.from(parent?.children || []).find((child) =>
      child === descendant || child.contains?.(descendant),
    ) || null;
  }

  function markCompactRow(card) {
    if (String(card?.tagName || '').toLowerCase() !== 'ytd-rich-item-renderer') return;
    card.dataset.ytcfCompactCard = 'true';
    compactLayoutParts.add(card);

    const thumbnail = card.querySelector?.(
      'ytd-thumbnail, yt-thumbnail-view-model, #thumbnail-container, a#thumbnail, ' +
      '[class*="content-image"], [class*="thumbnail"]',
    );
    const title = card.querySelector?.(
      '#video-title, #video-title-link, h3, [role="heading"], ' +
      '.yt-lockup-metadata-view-model-wiz__title, [class*="metadata"] [class*="title"]',
    );
    if (!thumbnail || !title) return;

    // Find the lowest wrapper where the thumbnail and title occupy different
    // branches. This survives YouTube switching between rich-grid-media and
    // lockup view-model markup because it does not depend on either wrapper's
    // generated class names.
    let shell = thumbnail.parentElement;
    while (shell) {
      const thumbnailBranch = directChildContaining(shell, thumbnail);
      const detailsBranch = directChildContaining(shell, title);
      if (thumbnailBranch && detailsBranch && thumbnailBranch !== detailsBranch) {
        card.dataset.ytcfCompactRow = 'true';
        shell.dataset.ytcfRowShell = 'true';
        thumbnailBranch.dataset.ytcfRowThumbnail = 'true';
        detailsBranch.dataset.ytcfRowDetails = 'true';
        compactLayoutParts.add(shell);
        compactLayoutParts.add(thumbnailBranch);
        compactLayoutParts.add(detailsBranch);
        return;
      }
      if (shell === card) return;
      shell = shell.parentElement;
    }
  }

  function updateCompactPresentation(cards, enabled) {
    clearCompactPresentation();
    if (!enabled) return;
    for (const card of cards.keys()) markCompactRow(card);
  }

  function sortDisplayedVideos(cards, newestFirst) {
    clearSortPresentation();
    if (!newestFirst) return;

    const groups = new Map();
    for (const target of cards.keys()) {
      const containingSection = target.closest?.(
        'ytd-rich-section-renderer, ytd-rich-shelf-renderer, ytd-horizontal-card-list-renderer, ytd-shelf-renderer, ' +
        'ytd-reel-shelf-renderer, ytd-shorts-shelf-renderer, ytd-podcast-shelf-renderer',
      );
      // YouTube adds generic rich-section wrappers around the primary Home
      // feed after it repaints. That wrapper is not a horizontal shelf. If it
      // is treated as one, a later toggle changes the main feed to a single
      // row and leaves only one card visible in the viewport.
      const sectionTag = String(containingSection?.tagName || '').toLowerCase();
      const shelf = sectionTag === 'ytd-rich-section-renderer' ? null : containingSection;
      // Keep YouTube's section and row wrappers intact. Flattening them drops
      // their masthead spacing and can clip the first Home thumbnail.
      const scope = target.parentElement;
      if (!scope) continue;
      if (!groups.has(scope)) groups.set(scope, { shelf, slots: [] });
      groups.get(scope).slots.push(target);
    }

    for (const [scope, { shelf, slots }] of groups) {
      const sorted = [...slots].sort((left, right) => {
        const leftMetadata = cards.get(left);
        const rightMetadata = cards.get(right);
        const leftAge = rules.ageInDays(leftMetadata?.metadata);
        const rightAge = rules.ageInDays(rightMetadata?.metadata);
        const leftStableRank = stableVideoRank(leftMetadata);
        const rightStableRank = stableVideoRank(rightMetadata);
        const stableTieBreak = leftStableRank !== null && rightStableRank !== null
          ? leftStableRank - rightStableRank
          : originalOrder.get(left) - originalOrder.get(right);
        if (leftAge === null && rightAge === null) return stableTieBreak;
        if (leftAge === null) return 1;
        if (rightAge === null) return -1;
        return leftAge - rightAge || stableTieBreak;
      });

      if (slots.length < 2) continue;
      scope.dataset.ytcfSortContainer = shelf ? 'row' : 'column';
      styledSortContainers.add(scope);
      sorted.forEach((target, index) => {
        if (!target.style) return;
        // YouTube inserts ads, shelves, and continuation renderers beside the
        // video results. Their default flex order is 0, so positive video
        // orders push the entire result list below those containers. Keep all
        // sorted videos negative: newest remains first and non-video siblings
        // stay after the primary list.
        const cssOrder = index - sorted.length;
        target.style.order = String(cssOrder);
        target.dataset.ytcfSortOrder = String(cssOrder);
        styledSortTargets.add(target);
      });
    }
  }

  function shouldHideCard(meta) {
    if (!settings.enabled) return [];

    const reasons = [];
    if (meta.channelKey && blockedChannelKeys.has(meta.channelKey)) reasons.push('blocked-channel');
    if (settings.hideShorts && rules.isShort(meta)) reasons.push('shorts');
    if (settings.hideMusic && rules.isMusicOrPlaylist(meta)) reasons.push('music');
    if (settings.hidePodcasts && rules.isPodcast(meta)) reasons.push('podcasts');
    if (settings.hideSponsored && rules.isSponsored(meta)) reasons.push('sponsored');
    if (settings.hideBait && rules.isBaitTitle(meta.title)) reasons.push('bait');
    const age = rules.ageCategory(meta.metadata);
    if (settings.hideOlderThan1Yr && age === 'older') reasons.push('older-than-one-year');
    return reasons;
  }

  function captureCardLayout(cards) {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;
    const positions = new Map();
    const hidden = new Set();
    for (const target of cards.keys()) {
      if (target.dataset?.ytcfHidden === 'true') {
        hidden.add(target);
        continue;
      }
      if (!target.getBoundingClientRect) continue;
      const rect = target.getBoundingClientRect();
      if (Number.isFinite(globalThis.innerHeight) && (rect.bottom < 0 || rect.top > globalThis.innerHeight)) continue;
      positions.set(target, { left: rect.left, top: rect.top });
    }
    return { hidden, positions };
  }

  function animateCardReflow(before, cards) {
    if (!before) return;
    for (const target of cards.keys()) {
      if (target.dataset?.ytcfHidden === 'true' || !target.animate) continue;
      activeReflowAnimations.get(target)?.cancel?.();
      const prior = before.positions.get(target);
      if (!prior) {
        if (before.hidden.has(target)) {
          activeReflowAnimations.set(target, target.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: 160, easing: 'ease-out' },
          ));
        }
        continue;
      }
      const next = target.getBoundingClientRect?.();
      if (!next) continue;
      const deltaX = prior.left - next.left;
      const deltaY = prior.top - next.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
      activeReflowAnimations.set(target, target.animate(
        [
          { translate: `${deltaX}px ${deltaY}px` },
          { translate: '0 0' },
        ],
        { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      ));
    }
  }

  function setHidden(element, reasons) {
    const hidden = reasons.length > 0;
    if (hidden) {
      element.dataset.ytcfHidden = 'true';
      element.dataset.ytcfReasons = reasons.join(',');
    } else {
      delete element.dataset.ytcfHidden;
      delete element.dataset.ytcfReasons;
    }
    return hidden;
  }

  function ownedSectionTitle(element) {
    const heading = element.querySelector?.('#title, #header, h2');
    const headingOwner = heading?.closest?.(
      'ytd-rich-shelf-renderer, ytd-horizontal-card-list-renderer, ytd-shelf-renderer, ' +
      'ytd-reel-shelf-renderer, ytd-shorts-shelf-renderer, ytd-podcast-shelf-renderer, ' +
      'ytd-rich-section-renderer',
    );
    if (headingOwner && headingOwner !== element) return '';
    return cleanText(heading?.getAttribute?.('title') || heading?.textContent);
  }

  function isTopicElement(element) {
    const tagName = String(element.tagName || '').toLowerCase();
    if (tagName === 'ytd-feed-filter-chip-bar-renderer' ||
        tagName === 'ytd-related-chip-cloud-renderer' ||
        tagName === 'yt-chip-cloud-renderer' || element.id === 'chips-wrapper') return true;

    const title = ownedSectionTitle(element);
    return /related topics|trending topics|related to this video/i.test(title);
  }

  function isExploreMoreElement(element) {
    return /explore more topics/i.test(ownedSectionTitle(element));
  }

  function specialSectionReasons(element) {
    if (!settings.enabled) return [];
    const reasons = [];
    if (settings.hideTopics && isTopicElement(element)) reasons.push('topics');
    if (settings.hideExploreMore && isExploreMoreElement(element)) reasons.push('explore-more-topics');
    if (settings.hidePosts && isPostElement(element)) reasons.push('posts');
    if (settings.hideSponsored && element.matches?.(AD_SELECTOR)) reasons.push('sponsored');

    const tagName = String(element.tagName || '').toLowerCase();
    const isShortsShelf = tagName === 'ytd-reel-shelf-renderer' || tagName === 'ytd-shorts-shelf-renderer';
    const title = ownedSectionTitle(element);
    if (settings.hideShorts && (isShortsShelf || /\bshorts\b/i.test(title))) reasons.push('shorts');
    const isPodcastShelf = tagName === 'ytd-podcast-shelf-renderer' ||
      /\bpodcasts?\b/i.test(title);
    if (settings.hidePodcasts && isPodcastShelf) reasons.push('podcasts');
    return reasons;
  }

  function clearAll() {
    clearSortPresentation();
    clearCompactPresentation();
    for (const element of document.querySelectorAll?.('[data-ytcf-hidden="true"]') || []) {
      setHidden(element, []);
    }
    for (const button of document.querySelectorAll?.('.ytcf-block-channel-btn') || []) button.remove?.();
    for (const host of document.querySelectorAll?.('.ytcf-block-button-host') || []) {
      host.classList?.remove('ytcf-block-button-host');
    }
    for (const card of document.querySelectorAll?.(CARD_SELECTOR) || []) {
      delete card.dataset?.ytcfEvaluated;
      delete card.dataset?.ytcfBanished;
      card.classList?.remove('ytcf-card-banishing');
    }
    document.body?.classList?.remove('ytcf-suppress-popup');
    document.documentElement?.classList?.remove('ytcf-filter-active');
    document.documentElement?.classList?.remove('ytcf-sort-active');
    document.documentElement?.classList?.remove('ytcf-home-feed');
    document.documentElement?.classList?.remove('ytcf-booting');
    hiddenCount = 0;
  }

  function scan({ animateLayout = false, fullPass = false } = {}) {
    scanTimer = null;
    if (!settingsReady) return;
    if (!settings.enabled) {
      const cards = collectCardMetadata();
      const before = animateLayout ? captureCardLayout(cards) : null;
      clearAll();
      animateCardReflow(before, cards);
      return;
    }

    const allCards = collectCardMetadata();
    preserveFeedOrder(allCards);
    updateCompactPresentation(allCards, true);
    const before = animateLayout ? captureCardLayout(allCards) : null;
    const cards = fullPass
      ? allCards
      : new Map(Array.from(allCards).filter(([target]) => target.dataset?.ytcfEvaluated !== 'true'));
    const targets = new Map(Array.from(cards, ([target, metadata]) => [target, shouldHideCard(metadata)]));

    let nextHiddenCount = 0;
    let hiddenCardCount = 0;
    for (const [target, reasons] of targets) {
      if (setHidden(target, reasons)) {
        nextHiddenCount += 1;
        hiddenCardCount += 1;
      }
    }

    const specialTargets = new Map();
    const sections = Array.from(document.querySelectorAll?.(SPECIAL_SECTION_SELECTOR) || []);
    for (const section of sections) {
      const target = sectionLayoutTarget(section);
      if (!fullPass && section.dataset?.ytcfEvaluated === 'true' && target.dataset?.ytcfEvaluated === 'true') continue;
      const reasons = specialTargets.get(target) || [];
      for (const reason of specialSectionReasons(section)) {
        if (!reasons.includes(reason)) reasons.push(reason);
      }
      specialTargets.set(target, reasons);
    }
    for (const [target, reasons] of specialTargets) {
      if (setHidden(target, reasons)) {
        nextHiddenCount += 1;
        if (target.matches?.(CARD_SELECTOR) || target.closest?.('ytd-rich-grid-renderer')) hiddenCardCount += 1;
      }
    }

    const flatListActive = settings.enabled;
    if (fullPass) sortDisplayedVideos(allCards, flatListActive);

    for (const card of document.querySelectorAll?.(CARD_SELECTOR) || []) {
      const target = layoutTarget(card);
      if (fullPass || cards.has(target) || target.dataset?.ytcfEvaluated === 'true') {
        card.dataset.ytcfEvaluated = 'true';
      }
    }
    for (const section of sections) {
      const target = sectionLayoutTarget(section);
      if (fullPass || specialTargets.has(target)) {
        section.dataset.ytcfEvaluated = 'true';
        target.dataset.ytcfEvaluated = 'true';
      }
    }

    hiddenCount = (document.querySelectorAll?.('[data-ytcf-hidden="true"]') || []).length;
    document.documentElement?.classList?.toggle('ytcf-filter-active', hiddenCount > 0 || hiddenCardCount > 0);
    document.documentElement?.classList?.toggle('ytcf-sort-active', flatListActive);
    document.documentElement?.classList?.toggle('ytcf-home-feed', globalThis.location?.pathname === '/');
    document.documentElement?.classList?.remove('ytcf-booting');
    animateCardReflow(before, allCards);
  }

  function scheduleScan({ fullPass = false } = {}) {
    // Do not restart the timer for every mutation. YouTube can paint
    // continuously, which would otherwise postpone the scan indefinitely.
    scanNeedsFullPass ||= fullPass;
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      const nextFullPass = scanNeedsFullPass;
      scanNeedsFullPass = false;
      scan({ fullPass: nextFullPass });
    }, 120);
  }

  function scheduleRepaintPasses() {
    for (const timer of repaintTimers) clearTimeout(timer);
    repaintTimers = [];
    scheduleScan({ fullPass: true });
    for (const delay of [350, 1000]) {
      repaintTimers.push(setTimeout(scheduleScan, delay));
    }
  }

  function normalizeSettings(value) {
    const next = { ...rules.DEFAULT_SETTINGS };
    for (const key of Object.keys(next)) {
      if (key in (value || {})) next[key] = Boolean(value[key]);
    }
    return next;
  }

  function applySettings(value, animateChanges = true) {
    const nextSettings = normalizeSettings(value);
    const changed = Object.keys(rules.DEFAULT_SETTINGS).some((key) => settings[key] !== nextSettings[key]);
    const wasReady = settingsReady;
    settingsRevision += 1;
    settingsReady = true;
    settings = nextSettings;
    if (wasReady && !changed) return;
    if (scanTimer !== null) clearTimeout(scanTimer);
    scanTimer = null;
    scanNeedsFullPass = false;
    scan({ animateLayout: animateChanges && changed, fullPass: true });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'YTCF_APPLY_SETTINGS') {
      applySettings(message.settings);
      sendResponse({ ok: true, hiddenCount, settings });
      return;
    }
    if (message?.type === 'YTCF_GET_STATUS') {
      sendResponse({ ok: true, hiddenCount, settings });
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[BLOCKED_CHANNELS_STORAGE_KEY]) {
      const savedKeys = changes[BLOCKED_CHANNELS_STORAGE_KEY].newValue;
      blockedChannelKeys = new Set(Array.isArray(savedKeys) ? savedKeys.filter((key) => typeof key === 'string') : []);
      scheduleScan({ fullPass: true });
    }
    if (changes[STORAGE_KEY]) applySettings(changes[STORAGE_KEY].newValue);
  });

  const initialSettingsRevision = settingsRevision;
  chrome.storage.local.get({
    [STORAGE_KEY]: rules.DEFAULT_SETTINGS,
    [BLOCKED_CHANNELS_STORAGE_KEY]: [],
  }, (stored) => {
    const savedKeys = stored[BLOCKED_CHANNELS_STORAGE_KEY];
    blockedChannelKeys = new Set(Array.isArray(savedKeys) ? savedKeys.filter((key) => typeof key === 'string') : []);
    if (settingsRevision === initialSettingsRevision) applySettings(stored[STORAGE_KEY], false);
  });

  const observer = new MutationObserver(markMutationCardsPending);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  document.addEventListener('yt-navigate-finish', scheduleRepaintPasses);
  globalThis.addEventListener?.('click', onBlockChannelClick, true);
  globalThis.addEventListener?.('click', onFeedVideoClick, true);
  globalThis.addEventListener?.('pageshow', scheduleRepaintPasses);
  globalThis.addEventListener?.('popstate', scheduleRepaintPasses);
  scheduleRepaintPasses();
})();
