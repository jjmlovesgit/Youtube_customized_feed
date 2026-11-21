import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadRules() {
  const source = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.YTCFFilterRules;
}

test('manifest loads the popup and only the self-contained feed scripts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'YT Custom Feed');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.deepEqual(manifest.permissions, ['storage', 'activeTab']);
  assert.deepEqual(manifest.content_scripts[0].js, ['filter-rules.js', 'content.js']);
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.deepEqual(manifest.background, { service_worker: 'split-player-worker.js' });
  assert.equal(manifest.side_panel, undefined);
  assert.equal(manifest.host_permissions, undefined);
});

test('feed rules recognize the reference feed categories', async () => {
  const rules = await loadRules();
  assert.equal(rules.DEFAULT_SETTINGS.hidePosts, false);
  assert.equal(rules.DEFAULT_SETTINGS.hidePodcasts, false);
  assert.equal(rules.DEFAULT_SETTINGS.hideExploreMore, false);
  assert.equal(rules.DEFAULT_SETTINGS.hideSponsored, false);
  assert.equal('hideBait' in rules.DEFAULT_SETTINGS, false);
  assert.equal('hideForeignScript' in rules.DEFAULT_SETTINGS, false);
  assert.equal('hideNewerThan1Yr' in rules.DEFAULT_SETTINGS, false);

  assert.equal(rules.isShort({ href: '/shorts/abc', tagName: 'yt-lockup-view-model' }), true);
  assert.equal(rules.isShort({ href: '', tagName: 'ytm-shorts-lockup-view-model-v2' }), true);
  assert.equal(rules.isShort({ href: '', tagName: 'ytd-reel-video-renderer' }), true);
  assert.equal(rules.isShort({ href: '/watch?v=abc', tagName: 'ytd-video-renderer' }), false);

  assert.equal(rules.isMusicOrPlaylist({ tagName: 'ytd-playlist-renderer' }), true);
  assert.equal(rules.isMusicOrPlaylist({ tagName: 'ytd-video-renderer', channel: 'Miles Davis - Topic' }), true);
  assert.equal(rules.isMusicOrPlaylist({ tagName: 'ytd-video-renderer', title: 'Dark Jazz & Smoky Trip-Hop // Atmospheric Music for Late Night Drives' }), true);
  assert.equal(rules.isMusicOrPlaylist({ tagName: 'ytd-video-renderer', hasMusicBadge: true }), true);
  assert.equal(rules.isMusicOrPlaylist({ tagName: 'ytd-video-renderer', title: 'Build a desk from plywood' }), false);

  assert.equal(rules.isPodcast({ tagName: 'ytd-podcast-renderer' }), true);
  assert.equal(rules.isPodcast({ tagName: 'ytd-video-renderer', hasPodcastMarkup: true }), true);
  assert.equal(rules.isPodcast({ tagName: 'ytd-video-renderer', title: 'The Web Platform Podcast' }), true);
  assert.equal(rules.isPodcast({ tagName: 'ytd-video-renderer', title: 'Build a desk from plywood' }), false);

  assert.equal(rules.isSponsored({ hasSponsoredBadge: true }), true);
  assert.equal(rules.isSponsored({ title: 'Sponsored results explained' }), false);

  assert.equal(rules.isBaitTitle("You WON'T BELIEVE what happens next"), true);
  assert.equal(rules.isBaitTitle('How to repair a bicycle wheel'), false);
  assert.equal(rules.isBaitTitle('THIS CHANGES EVERYTHING RIGHT NOW'), true);

  assert.equal(rules.ageCategory('847K views · 11 months ago'), 'newer');
  assert.equal(rules.ageCategory('2.1M views · 1 year ago'), 'newer');
  assert.equal(rules.ageCategory('2.1M views · 2 years ago'), 'older');
  assert.equal(rules.ageCategory('83K3y ago'), 'older');
  assert.equal(rules.ageCategory('8.7K1mo ago'), 'newer');
  assert.equal(rules.ageCategory('9.4K5mo ago'), 'newer');
  assert.equal(rules.ageCategory('Premiered yesterday'), null);
  assert.ok(rules.ageInDays('2 hours ago') < rules.ageInDays('3 days ago'));
  assert.ok(rules.ageInDays('11 months ago') < rules.ageInDays('1 year ago'));
  assert.ok(rules.ageInDays('8.7K1mo ago') < rules.ageInDays('83K3y ago'));
  assert.equal(rules.ageInDays('No publication date'), null);
});

test('popup exposes active filters while keeping the bait classifier code parked', async () => {
  const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  for (const setting of [
    'enabled',
    'hideMusic',
    'hidePodcasts',
    'hideShorts',
    'hidePosts',
    'hideTopics',
    'hideExploreMore',
    'hideSponsored',
    'hideOlderThan1Yr',
  ]) {
    assert.match(html, new RegExp(`data-setting="${setting}"`));
  }
  assert.doesNotMatch(html, /hideNewerThan1Yr|Hide newer videos|Published 1 year ago or more recently/);
  assert.doesNotMatch(html, /hideForeignScript|Non-Latin titles/);
  assert.doesNotMatch(html, /Bait-style titles|hideBait/);
  assert.match(html, /aria-live="polite"/);

  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(rulesSource, /function isBaitTitle/);
  assert.match(contentSource, /settings\.hideBait && rules\.isBaitTitle/);
});

test('every popup toggle persists and sends its complete settings state', async () => {
  const popupSource = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const settingNames = [
    'enabled',
    'hideMusic',
    'hidePodcasts',
    'hideShorts',
    'hidePosts',
    'hideTopics',
    'hideExploreMore',
    'hideSponsored',
    'hideOlderThan1Yr',
  ];
  const inputs = settingNames.map((setting) => ({
    dataset: { setting },
    checked: false,
    disabled: false,
    listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
  }));
  const statusCopy = { textContent: '' };
  const status = { className: '', querySelector() { return statusCopy; } };
  const masterCopy = { textContent: '' };
  const resetButton = {
    listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
  };
  const bodyClasses = new Set();
  const savedStates = [];
  const sentStates = [];
  const document = {
    body: {
      classList: {
        toggle(name, force) { if (force) bodyClasses.add(name); else bodyClasses.delete(name); },
      },
    },
    querySelectorAll(selector) { return selector === '[data-setting]' ? inputs : []; },
    getElementById(id) {
      if (id === 'status') return status;
      if (id === 'master-copy') return masterCopy;
      if (id === 'reset') return resetButton;
      return null;
    },
  };
  const chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(_defaults, callback) { callback({ ytCustomFeedSettings: { enabled: true } }); },
        set(value, callback) {
          savedStates.push({ ...value.ytCustomFeedSettings });
          callback();
        },
      },
    },
    tabs: {
      query(_query, callback) { callback([{ id: 7, url: 'https://www.youtube.com/' }]); },
      sendMessage(_tabId, message, callback) {
        sentStates.push({ ...message.settings });
        callback({ ok: true, hiddenCount: 0 });
      },
    },
  };
  vm.runInContext(popupSource, vm.createContext({ chrome, document }));
  assert.equal(masterCopy.textContent, 'On · plain list · newest first');
  assert.equal(statusCopy.textContent, 'Plain list · newest first');

  for (const input of inputs.filter((item) => item.dataset.setting !== 'enabled')) {
    input.checked = true;
    input.listeners.change({ currentTarget: input });
    assert.equal(savedStates.at(-1)[input.dataset.setting], true);
    assert.equal(sentStates.at(-1)[input.dataset.setting], true);
    assert.equal(masterCopy.textContent, 'On · plain list · newest first');

    input.checked = false;
    input.listeners.change({ currentTarget: input });
    assert.equal(savedStates.at(-1)[input.dataset.setting], false);
    assert.equal(sentStates.at(-1)[input.dataset.setting], false);
    assert.equal(masterCopy.textContent, 'On · plain list · newest first');
  }

  const master = inputs.find((input) => input.dataset.setting === 'enabled');
  master.checked = false;
  master.listeners.change({ currentTarget: master });
  assert.equal(savedStates.at(-1).enabled, false);
  assert.equal(sentStates.at(-1).enabled, false);
  assert.equal(bodyClasses.has('filters-disabled'), true);
  assert.equal(masterCopy.textContent, 'Paused');
  assert.equal(inputs.filter((input) => input !== master).every((input) => input.disabled), true);

  master.checked = true;
  master.listeners.change({ currentTarget: master });
  assert.equal(savedStates.at(-1).enabled, true);
  assert.equal(inputs.filter((input) => input !== master).every((input) => !input.disabled), true);
});

test('extension routes feed clicks to a reusable native YouTube player window without Data API calls', async () => {
  const files = ['split-player-worker.js', 'content.js', 'filter-rules.js', 'popup.js'];
  const source = (await Promise.all(files.map((file) => readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /setInterval|yt-page-data-updated/);
  assert.doesNotMatch(source, /127\.0\.0\.1|localhost|window\.ai|languageModel/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /yt-navigate-finish/);
  assert.match(source, /YTCF_OPEN_SPLIT_PLAYER/);
  assert.match(source, /https:\/\/www\.youtube\.com\/watch\?v=/);
  assert.match(source, /chrome\.windows\.create/);
  assert.match(source, /chrome\.tabs\.update/);
  assert.match(source, /globalThis\.addEventListener\?\.\('click', onFeedVideoClick, true\)/);
  assert.match(source, /a\[href\*="\/watch"\]/);
  assert.match(source, /watch\|shorts\|live\|embed\|clip/);
  assert.doesNotMatch(source, /youtube-nocookie\.com\/embed|ytcf-player-backdrop/);

  const css = await readFile(new URL('../extension/content.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.ytcf-player-backdrop/);
});

test('split player opens a right-side window once and reuses it for later selections', async () => {
  const backgroundSource = await readFile(new URL('../extension/split-player-worker.js', import.meta.url), 'utf8');
  const session = new Map();
  const createdWindows = [];
  const windowUpdates = [];
  const tabUpdates = [];
  let messageListener;
  let nextWindowId = 40;

  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) { messageListener = listener; },
      },
    },
    storage: {
      session: {
        async get(key) { return { [key]: session.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) session.set(key, value); },
        async remove(key) { session.delete(key); },
      },
    },
    tabs: {
      async update(tabId, update) { tabUpdates.push({ tabId, update }); },
      async query(queryInfo) {
        return queryInfo.windowId === 40 ? [{ id: 80 }] : [];
      },
    },
    windows: {
      async create(options) {
        const result = { id: nextWindowId++ };
        createdWindows.push({ options, result });
        return result;
      },
      async update(windowId, update) { windowUpdates.push({ windowId, update }); },
    },
  };
  vm.runInContext(backgroundSource, vm.createContext({ chrome, console, Map, Promise, String, Number, Error }));

  const sendClick = (videoId) => new Promise((resolve) => {
    messageListener({
      type: 'YTCF_OPEN_SPLIT_PLAYER',
      videoId,
      layout: { left: 0, top: 0, width: 1600, height: 900 },
    }, { tab: { id: 12, windowId: 7 } }, resolve);
  });

  const firstResult = await sendClick('aaaaaaaaaaa');
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.reused, false);
  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].options.url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
  assert.equal('populate' in createdWindows[0].options, false);
  assert.equal(createdWindows[0].options.left, 800);
  assert.equal(createdWindows[0].options.width, 800);
  assert.ok(windowUpdates.some(({ windowId, update }) => windowId === 7 && update.width === 800));

  const secondResult = await sendClick('bbbbbbbbbbb');
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.reused, true);
  assert.equal(createdWindows.length, 1);
  assert.equal(tabUpdates.length, 1);
  assert.equal(tabUpdates[0].tabId, 80);
  assert.equal(tabUpdates[0].update.url, 'https://www.youtube.com/watch?v=bbbbbbbbbbb');
});

test('home list preserves YouTube row and section wrappers', async () => {
  const css = await readFile(new URL('../extension/content.css', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /ytd-rich-grid-row[\s\S]*?display:\s*contents\s*!important/);
  assert.doesNotMatch(css, /ytd-rich-section-renderer\s*\{[\s\S]*?display:\s*contents\s*!important/);
  assert.match(css, /ytcf-booting/);
  assert.match(css, /data-ytcf-evaluated="true"/);
  assert.match(css, /ytcf-booting :is\([\s\S]*?ytd-podcast-shelf-renderer/);
  assert.match(css, /\[data-ytcf-hidden="true"\][\s\S]*?display:\s*none\s*!important/);
  assert.match(css, /ytd-rich-shelf-renderer[\s\S]*?display:\s*none\s*!important/);
  assert.match(css, /data-ytcf-row-shell="true"[\s\S]*?grid-template-columns:\s*320px minmax\(0, 1fr\)/);
  assert.match(css, /data-ytcf-row-thumbnail="true"[\s\S]*?width:\s*320px/);
  assert.match(css, /@media \(max-width:\s*800px\)[\s\S]*?data-ytcf-row-shell="true"[\s\S]*?grid-template-columns:\s*168px minmax\(0, 1fr\)/);
  assert.match(contentSource, /function markCompactRow\(card\)/);
  assert.doesNotMatch(contentSource, /createComment|ytcf-sort-slot|insertBefore|appendChild/);
});

test('late Home lockup hydration keeps thumbnails visible', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let mutationCallback;
  const grid = {};
  const nestedLockups = [];
  const thumbnail = { dataset: {} };
  const title = { dataset: {}, textContent: 'Normal Home video', getAttribute() { return ''; } };
  const thumbnailBranch = {
    dataset: {},
    children: [thumbnail],
    contains(element) { return element === thumbnail; },
  };
  const detailsBranch = {
    dataset: {},
    children: [title],
    contains(element) { return element === title; },
  };
  const rowShell = {
    dataset: {},
    children: [thumbnailBranch, detailsBranch],
    contains(element) { return element === thumbnail || element === title; },
  };
  thumbnail.parentElement = thumbnailBranch;
  title.parentElement = detailsBranch;
  thumbnailBranch.parentElement = rowShell;
  detailsBranch.parentElement = rowShell;
  const outerCard = {
    tagName: 'YTD-RICH-ITEM-RENDERER',
    dataset: {},
    style: {},
    textContent: 'Normal Home video 2 hours ago',
    innerText: 'Normal Home video 2 hours ago',
    matches(selector) { return selector.includes('ytd-rich-item-renderer'); },
    closest(selector) {
      if (selector.includes('ytd-rich-item-renderer')) return this;
      if (selector.includes('ytd-rich-grid-renderer')) return grid;
      return null;
    },
    querySelector(selector) {
      if (selector.includes('ytd-thumbnail')) return thumbnail;
      if (selector.startsWith('#video-title')) return title;
      if (selector.includes('a[href*="/watch"]')) return { getAttribute: () => '/watch?v=home-video' };
      return null;
    },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { bottom: 300, left: 0, right: 400, top: 100 }; },
  };
  rowShell.parentElement = outerCard;
  const nestedLockup = {
    nodeType: 1,
    tagName: 'YT-LOCKUP-VIEW-MODEL',
    dataset: {},
    parentElement: outerCard,
    matches(selector) { return selector.includes('yt-lockup-view-model'); },
    closest(selector) { return selector.includes('ytd-rich-item-renderer') ? outerCard : null; },
    querySelectorAll() { return []; },
  };
  const document = {
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') return [];
      if (selector.includes('ytd-rich-item-renderer')) return [outerCard, ...nestedLockups];
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      local: { get(_defaults, callback) { callback({ ytCustomFeedSettings: { enabled: true } }); } },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
  }
  const context = vm.createContext({
    chrome,
    clearTimeout,
    console,
    document,
    innerHeight: 800,
    innerWidth: 1200,
    MutationObserver,
    setTimeout,
  });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);
  assert.equal(outerCard.dataset.ytcfEvaluated, 'true');
  assert.equal(rowShell.dataset.ytcfRowShell, 'true');
  assert.equal(thumbnailBranch.dataset.ytcfRowThumbnail, 'true');
  assert.equal(detailsBranch.dataset.ytcfRowDetails, 'true');

  nestedLockups.push(nestedLockup);
  mutationCallback([{ type: 'childList', target: outerCard, addedNodes: [nestedLockup] }]);
  assert.equal(nestedLockup.dataset.ytcfEvaluated, 'true');
  assert.equal(outerCard.dataset.ytcfHidden, undefined);
});

test('startup guard waits for saved filters before revealing the feed', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let storageCallback;
  let nextTimerId = 0;
  const timers = new Map();
  const setTimeout = (callback, delay = 0) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  const rootClasses = new Set();
  const title = { textContent: 'The Browser Podcast', getAttribute() { return ''; } };
  const card = {
    tagName: 'YTD-VIDEO-RENDERER',
    dataset: {},
    style: {},
    textContent: title.textContent,
    innerText: title.textContent,
    closest(selector) { return selector.includes('ytd-video-renderer') ? this : null; },
    querySelector(selector) {
      if (selector.startsWith('#video-title')) return title;
      if (selector.includes('a[href*="/watch"]')) return { getAttribute: () => '/watch?v=podcast' };
      return null;
    },
    querySelectorAll() { return []; },
  };
  const document = {
    visibilityState: 'visible',
    documentElement: {
      classList: {
        add(name) { rootClasses.add(name); },
        remove(name) { rootClasses.delete(name); },
        toggle(name, force) { if (force) rootClasses.add(name); else rootClasses.delete(name); },
      },
    },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') return card.dataset.ytcfHidden ? [card] : [];
      if (selector.includes('ytd-rich-item-renderer')) return [card];
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      local: { get(_defaults, callback) { storageCallback = callback; } },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver { observe() {} }
  const context = vm.createContext({ chrome, clearTimeout, console, document, MutationObserver, setTimeout });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.equal(rootClasses.has('ytcf-booting'), true);
  const [initialTimerId, initialTimer] = [...timers].sort((left, right) => left[1].delay - right[1].delay)[0];
  timers.delete(initialTimerId);
  initialTimer.callback();
  assert.equal(rootClasses.has('ytcf-booting'), true, 'default settings must not reveal the feed early');
  assert.equal(card.dataset.ytcfEvaluated, undefined);

  storageCallback({ ytCustomFeedSettings: { enabled: true, hidePodcasts: true } });
  assert.equal(card.dataset.ytcfHidden, 'true');
  assert.equal(card.dataset.ytcfReasons, 'podcasts');
  assert.equal(card.dataset.ytcfEvaluated, 'true');
  assert.equal(rootClasses.has('ytcf-booting'), false);
});

test('Shorts toggle hides and restores the Search results shelf', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let messageListener;
  const shelfTitle = { textContent: 'Shorts', getAttribute() { return ''; } };
  const shelf = {
    tagName: 'YTD-REEL-SHELF-RENDERER',
    dataset: {},
    querySelector(selector) {
      if (selector.includes('#title')) return shelfTitle;
      if (selector.includes('/shorts/')) return { getAttribute: () => '/shorts/abc' };
      return null;
    },
  };
  const document = {
    visibilityState: 'visible',
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') return shelf.dataset.ytcfHidden ? [shelf] : [];
      if (selector.includes('ytd-reel-shelf-renderer')) return [shelf];
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      local: {
        get(_defaults, callback) {
          callback({ ytCustomFeedSettings: { enabled: true, hideShorts: true } });
        },
      },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver { observe() {} }
  const context = vm.createContext({ chrome, clearTimeout, console, document, MutationObserver, setTimeout });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.equal(shelf.dataset.ytcfHidden, 'true');
  assert.equal(shelf.dataset.ytcfReasons, 'shorts');

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideShorts: false } },
    null,
    () => {},
  );
  assert.equal(shelf.dataset.ytcfHidden, undefined);
  assert.equal(shelf.dataset.ytcfReasons, undefined);
});

test('Podcasts toggle hides and restores a podcast shelf', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let messageListener;
  const shelfTitle = { textContent: 'Podcasts', getAttribute() { return ''; } };
  const shelf = {
    tagName: 'YTD-PODCAST-SHELF-RENDERER',
    dataset: {},
    querySelector(selector) {
      if (selector.includes('#title')) return shelfTitle;
      if (selector.includes('/podcasts')) return { getAttribute: () => '/podcasts' };
      return null;
    },
  };
  const document = {
    visibilityState: 'visible',
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') return shelf.dataset.ytcfHidden ? [shelf] : [];
      if (selector.includes('ytd-podcast-shelf-renderer')) return [shelf];
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      local: {
        get(_defaults, callback) {
          callback({ ytCustomFeedSettings: { enabled: true, hidePodcasts: true } });
        },
      },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver { observe() {} }
  const context = vm.createContext({ chrome, clearTimeout, console, document, MutationObserver, setTimeout });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.equal(shelf.dataset.ytcfHidden, 'true');
  assert.equal(shelf.dataset.ytcfReasons, 'podcasts');

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hidePodcasts: false } },
    null,
    () => {},
  );
  assert.equal(shelf.dataset.ytcfHidden, undefined);
  assert.equal(shelf.dataset.ytcfReasons, undefined);
});

test('Topics toggle hides and restores the YouTube chip bar', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let messageListener;
  const chipBar = {
    id: '',
    tagName: 'YTD-FEED-FILTER-CHIP-BAR-RENDERER',
    dataset: {},
    querySelector() { return null; },
  };
  const document = {
    visibilityState: 'visible',
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') return chipBar.dataset.ytcfHidden ? [chipBar] : [];
      if (selector.includes('ytd-feed-filter-chip-bar-renderer')) return [chipBar];
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      local: { get(_defaults, callback) { callback({ ytCustomFeedSettings: { enabled: true, hideTopics: true } }); } },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver { observe() {} }
  const context = vm.createContext({ chrome, clearTimeout, console, document, MutationObserver, setTimeout });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.equal(chipBar.dataset.ytcfHidden, 'true');
  assert.equal(chipBar.dataset.ytcfReasons, 'topics');
  messageListener({ type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideTopics: false } }, null, () => {});
  assert.equal(chipBar.dataset.ytcfHidden, undefined);
  assert.equal(chipBar.dataset.ytcfReasons, undefined);
});

test('Explore more topics can remain hidden while other Home filters continue to toggle', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let messageListener;
  const container = { dataset: {} };
  const topicSection = {
    tagName: 'YTD-RICH-SHELF-RENDERER',
    dataset: {},
    closest() { return null; },
    querySelector(selector) {
      if (!selector.includes('#title')) return null;
      return {
        textContent: 'Explore more topics',
        getAttribute() { return ''; },
        closest() { return topicSection; },
      };
    },
  };
  const primarySection = {
    tagName: 'YTD-RICH-SECTION-RENDERER',
    dataset: {},
    closest() { return null; },
    querySelector(selector) {
      if (!selector.includes('#title')) return null;
      return {
        textContent: 'Explore more topics',
        getAttribute() { return ''; },
        closest() { return topicSection; },
      };
    },
  };
  const musicCard = {
    tagName: 'YTD-VIDEO-RENDERER',
    dataset: {},
    style: { removeProperty() {} },
    parentElement: container,
    textContent: 'Artist Official Music Video 2 hours ago',
    innerText: 'Artist Official Music Video 2 hours ago',
    matches(selector) { return selector.includes('ytd-video-renderer'); },
    closest(selector) { return selector.includes('ytd-video-renderer') ? this : null; },
    querySelector(selector) {
      if (selector.startsWith('#video-title')) {
        return { textContent: 'Artist Official Music Video', getAttribute() { return ''; } };
      }
      if (selector.includes('a[href*="/watch"]')) return { getAttribute: () => '/watch?v=music' };
      return null;
    },
    querySelectorAll(selector) {
      return selector.includes('#metadata-line')
        ? [{ textContent: '2 hours ago', getAttribute() { return ''; } }]
        : [];
    },
  };
  const document = {
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') {
        return [primarySection, topicSection, musicCard].filter((element) => element.dataset.ytcfHidden);
      }
      if (selector.includes('ytd-feed-filter-chip-bar-renderer')) return [primarySection, topicSection];
      if (selector.includes('ytd-rich-item-renderer')) return [musicCard];
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      local: { get(_defaults, callback) { callback({ ytCustomFeedSettings: { enabled: true, hideExploreMore: true } }); } },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver { observe() {} }
  const context = vm.createContext({ chrome, clearTimeout, console, document, MutationObserver, setTimeout });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.equal(primarySection.dataset.ytcfHidden, undefined);
  assert.equal(topicSection.dataset.ytcfReasons, 'explore-more-topics');
  assert.equal(musicCard.dataset.ytcfHidden, undefined);

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideExploreMore: true, hideMusic: true } },
    null,
    () => {},
  );
  assert.equal(primarySection.dataset.ytcfHidden, undefined);
  assert.equal(topicSection.dataset.ytcfReasons, 'explore-more-topics');
  assert.equal(musicCard.dataset.ytcfReasons, 'music');

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideExploreMore: true, hideMusic: false } },
    null,
    () => {},
  );
  assert.equal(primarySection.dataset.ytcfHidden, undefined);
  assert.equal(topicSection.dataset.ytcfReasons, 'explore-more-topics');
  assert.equal(musicCard.dataset.ytcfHidden, undefined);

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideExploreMore: false } },
    null,
    () => {},
  );
  assert.equal(topicSection.dataset.ytcfHidden, undefined);
  assert.equal(topicSection.dataset.ytcfReasons, undefined);
});

test('Posts toggle hides and restores a Home community post card', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let messageListener;
  const outerCard = {
    tagName: 'YTD-RICH-ITEM-RENDERER',
    dataset: {},
    matches(selector) { return selector.includes('ytd-rich-item-renderer'); },
    closest(selector) { return selector.includes('ytd-rich-grid-renderer') ? {} : this; },
    querySelector(selector) { return selector.includes('ytd-backstage-post-thread-renderer') ? post : null; },
  };
  const post = {
    tagName: 'YTD-BACKSTAGE-POST-THREAD-RENDERER',
    dataset: {},
    closest(selector) { return selector.includes('ytd-rich-item-renderer') ? outerCard : null; },
    querySelector() { return null; },
  };
  const document = {
    visibilityState: 'visible',
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') return outerCard.dataset.ytcfHidden ? [outerCard] : [];
      if (selector.includes('ytd-rich-item-renderer')) return [outerCard];
      if (selector.includes('ytd-backstage-post-thread-renderer')) return [post];
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      local: {
        get(_defaults, callback) {
          callback({ ytCustomFeedSettings: { enabled: true, hidePosts: true, hideBait: true } });
        },
      },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver { observe() {} }
  const context = vm.createContext({ chrome, clearTimeout, console, document, MutationObserver, setTimeout });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.equal(outerCard.dataset.ytcfHidden, 'true');
  assert.equal(outerCard.dataset.ytcfReasons, 'posts');

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hidePosts: false, hideBait: true } },
    null,
    () => {},
  );
  assert.equal(outerCard.dataset.ytcfHidden, undefined);
  assert.equal(outerCard.dataset.ytcfReasons, undefined);
});

test('Sponsored toggle hides ad wrappers and labeled cards without hiding ordinary titles', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let messageListener;
  const adGridItem = { dataset: {} };
  const adSlot = {
    tagName: 'YTD-AD-SLOT-RENDERER',
    dataset: {},
    matches(selector) { return selector.includes('ytd-ad-slot-renderer'); },
    closest(selector) { return selector.includes('ytd-rich-item-renderer') ? adGridItem : null; },
    querySelector() { return null; },
  };
  function makeCard(title, badgeText) {
    return {
      tagName: 'YTD-VIDEO-RENDERER',
      dataset: {},
      style: { removeProperty() {} },
      parentElement: {},
      textContent: title,
      innerText: title,
      closest(selector) { return selector.includes('ytd-video-renderer') ? this : null; },
      querySelector(selector) {
        if (selector.startsWith('#video-title')) return { textContent: title, getAttribute() { return ''; } };
        if (selector.includes('a[href*="/watch"]')) return { getAttribute() { return '/watch?v=abcdefghijk'; } };
        return null;
      },
      querySelectorAll(selector) {
        if (selector.includes('[aria-label="Sponsored"')) {
          return badgeText ? [{ textContent: badgeText, getAttribute() { return ''; } }] : [];
        }
        return [];
      },
    };
  }
  const sponsoredCard = makeCard('Launch your website', 'Sponsored · Base44');
  const ordinaryCard = makeCard('Sponsored results explained', '');
  const document = {
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') {
        return [adGridItem, adSlot, sponsoredCard, ordinaryCard].filter((item) => item.dataset.ytcfHidden);
      }
      if (selector.includes('ytd-feed-filter-chip-bar-renderer')) return [adSlot];
      if (selector.includes('ytd-rich-item-renderer')) return [sponsoredCard, ordinaryCard];
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      local: { get(_defaults, callback) { callback({ ytCustomFeedSettings: { enabled: true, hideSponsored: true } }); } },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver { observe() {} }
  const context = vm.createContext({ chrome, clearTimeout, console, document, MutationObserver, setTimeout });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.equal(adGridItem.dataset.ytcfReasons, 'sponsored');
  assert.equal(sponsoredCard.dataset.ytcfReasons, 'sponsored');
  assert.equal(ordinaryCard.dataset.ytcfHidden, undefined);

  messageListener({ type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideSponsored: false } }, null, () => {});
  assert.equal(adGridItem.dataset.ytcfHidden, undefined);
  assert.equal(sponsoredCard.dataset.ytcfHidden, undefined);
});

test('Block Channel badge invokes YouTube native recommendation feedback', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../extension/content.css', import.meta.url), 'utf8');
  let injectedButton;
  let messageListener;
  let menuOpened = false;
  let feedbackClicks = 0;
  const storageWrites = [];
  const cardClasses = new Set();
  const bodyClasses = new Set();
  const buttonListeners = new Map();
  const capturedClickListeners = [];
  const title = { textContent: 'Useful browser tutorial', getAttribute() { return ''; } };
  const channelLink = { textContent: 'Example Channel', getAttribute(name) { return name === 'href' ? '/@example-channel' : ''; } };
  const menuButton = { click() { menuOpened = true; } };
  const menuItem = {
    textContent: "Don't recommend channel",
    click() { feedbackClicks += 1; },
    closest() { return { getAttribute() { return null; } }; },
  };
  const staleHostClasses = new Set(['ytcf-block-button-host']);
  const staleHost = {
    classList: { remove(name) { staleHostClasses.delete(name); } },
    querySelector() { return null; },
  };
  const staleButton = {
    disabled: true,
    parentElement: staleHost,
    remove() { if (injectedButton === this) injectedButton = undefined; },
  };
  injectedButton = staleButton;
  const thumbnailAnchor = { parentElement: null };
  const buttonHost = {
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); },
    },
    append(element) { injectedButton = element; },
  };
  thumbnailAnchor.parentElement = buttonHost;
  const thumbnail = {
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); },
    },
    matches() { return false; },
    closest(selector) { return selector === 'a' ? thumbnailAnchor : null; },
    append() { throw new Error('Block Channel must not be mounted inside the thumbnail link.'); },
  };
  const card = {
    tagName: 'YTD-RICH-ITEM-RENDERER',
    dataset: {},
    style: {},
    textContent: title.textContent,
    innerText: title.textContent,
    classList: {
      add(name) { cardClasses.add(name); },
      remove(name) { cardClasses.delete(name); },
    },
    closest(selector) { return selector.includes('ytd-rich-item-renderer') ? this : null; },
    querySelector(selector) {
      if (selector === '.ytcf-block-channel-btn') return injectedButton || null;
      if (selector.includes('#menu ytd-menu-renderer')) return menuButton;
      if (selector.includes('ytd-thumbnail')) return thumbnail;
      if (selector.startsWith('#video-title')) return title;
      if (selector.includes('a[href*="/watch"]')) return { getAttribute: () => '/watch?v=feedback' };
      if (selector.includes('a[href^="/@"]')) return channelLink;
      if (selector.includes('#channel-name')) return channelLink;
      return null;
    },
    querySelectorAll() { return []; },
  };
  const document = {
    visibilityState: 'visible',
    body: {
      classList: {
        add(name) { bodyClasses.add(name); },
        remove(name) { bodyClasses.delete(name); },
      },
    },
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    createElement() {
      const element = {
        disabled: false,
        dataset: {},
        textContent: '',
        attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, value); },
        matches(selector) { return selector === '.ytcf-block-channel-btn' && this.className === 'ytcf-block-channel-btn'; },
        closest(selector) { return selector.includes('ytd-rich-item-renderer') ? card : null; },
        addEventListener(name, listener) { buttonListeners.set(name, listener); },
        remove() { if (injectedButton === element) injectedButton = undefined; },
      };
      return element;
    },
    querySelectorAll(selector) {
      if (selector.includes('ytd-menu-service-item-renderer')) return menuOpened ? [menuItem] : [];
      if (selector === '.ytcf-block-channel-btn') return injectedButton ? [injectedButton] : [];
      if (selector === '.ytcf-block-button-host') return buttonHost.classList.values.has('ytcf-block-button-host') ? [buttonHost] : [];
      if (selector === '[data-ytcf-hidden="true"]') return [];
      if (selector.includes('ytd-rich-item-renderer')) return [card];
      return [];
    },
    addEventListener() {},
  };
  const addEventListener = (name, listener, capture) => {
    if (name === 'click' && capture === true) capturedClickListeners.push(listener);
  };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      local: {
        get(_defaults, callback) { callback({ ytCustomFeedSettings: { enabled: true } }); },
        set(value) { storageWrites.push(value); },
      },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver { observe() {} }
  const location = { pathname: '/', search: '' };
  const context = vm.createContext({ addEventListener, chrome, clearTimeout, console, Date, document, location, MutationObserver, setTimeout });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.notEqual(injectedButton, staleButton);
  assert.equal(staleHostClasses.has('ytcf-block-button-host'), false);
  assert.equal(injectedButton.textContent, '🚫 Block Channel');
  assert.equal(buttonHost.classList.values.has('ytcf-block-button-host'), true);
  assert.equal(thumbnail.classList.values.has('ytcf-block-button-host'), false);
  assert.match(css, /\.ytcf-block-channel-btn/);
  assert.match(css, /body\.ytcf-suppress-popup/);

  const videoAnchor = {
    nodeType: 1,
    href: 'https://www.youtube.com/watch?v=feedback',
    getAttribute() { return '/watch?v=feedback'; },
    closest(selector) { return selector.includes('a[href*="/watch"]') ? this : null; },
  };
  let immediatePropagationStopped = false;
  const capturedEvent = {
    target: videoAnchor,
    composedPath() { return [injectedButton, buttonHost, card]; },
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() { immediatePropagationStopped = true; },
  };
  for (const listener of capturedClickListeners) {
    listener(capturedEvent);
    if (immediatePropagationStopped) break;
  }
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(immediatePropagationStopped, true);
  assert.equal(menuOpened, true);
  assert.equal(feedbackClicks, 1);
  assert.equal(injectedButton.textContent, 'Blocked');
  assert.equal(injectedButton.disabled, false);
  assert.equal(injectedButton.dataset.ytcfBusy, 'true');
  assert.equal(cardClasses.has('ytcf-card-banishing'), true);
  assert.equal(bodyClasses.has('ytcf-suppress-popup'), true);

  location.pathname = '/results';
  immediatePropagationStopped = false;
  for (const listener of capturedClickListeners) {
    listener(capturedEvent);
    if (immediatePropagationStopped) break;
  }
  await Promise.resolve();

  assert.equal(feedbackClicks, 1);
  assert.deepEqual(Array.from(storageWrites.at(-1).ytCustomFeedBlockedChannels), ['href:/@example-channel']);
  assert.equal(card.dataset.ytcfHidden, 'true');
  assert.equal(card.dataset.ytcfReasons, 'blocked-channel');

  messageListener({ type: 'YTCF_APPLY_SETTINGS', settings: { enabled: false } }, null, () => {});
  assert.equal(injectedButton, undefined);
  assert.equal(buttonHost.classList.values.has('ytcf-block-button-host'), false);
  assert.equal(cardClasses.has('ytcf-card-banishing'), false);
  assert.equal(card.dataset.ytcfEvaluated, undefined);
  assert.equal(bodyClasses.has('ytcf-suppress-popup'), false);
});

test('content scanner hides a matching card and restores it when filters are paused', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let messageListener;
  const rootClasses = new Set();
  const title = {
    textContent: 'An older web development tutorial',
    getAttribute() { return ''; },
  };
  const card = {
    tagName: 'YTD-RICH-ITEM-RENDERER',
    dataset: {},
    textContent: title.textContent,
    innerText: title.textContent,
    closest() { return this; },
    querySelector(selector) {
      if (selector.startsWith('#video-title')) return title;
      if (selector.includes('a[href*="/watch"]')) return { getAttribute: () => '/watch?v=abc' };
      return null;
    },
    querySelectorAll(selector) {
      if (!selector.includes('#metadata-line')) return [];
      return [
        { textContent: '12K views', getAttribute() { return ''; } },
        { textContent: '2 years ago', getAttribute() { return ''; } },
      ];
    },
  };
  const document = {
    documentElement: {
      classList: {
        add(name) { rootClasses.add(name); },
        remove(name) { rootClasses.delete(name); },
        toggle(name, force) { if (force) rootClasses.add(name); else rootClasses.delete(name); },
      },
    },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') return card.dataset.ytcfHidden ? [card] : [];
      if (selector.includes('ytd-rich-item-renderer')) return [card];
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      local: {
        get(_defaults, callback) {
          callback({ ytCustomFeedSettings: { hideOlderThan1Yr: true, hideNewerThan1Yr: true } });
        },
      },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver { observe() {} }
  const context = vm.createContext({ chrome, console, document, MutationObserver, setTimeout, clearTimeout });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.equal(card.dataset.ytcfHidden, 'true');
  assert.equal(card.dataset.ytcfReasons, 'older-than-one-year');
  assert.equal(rootClasses.has('ytcf-filter-active'), true);
  assert.equal(rootClasses.has('ytcf-layout-mounted'), true);

  let response;
  messageListener({ type: 'YTCF_APPLY_SETTINGS', settings: { enabled: false } }, null, (value) => { response = value; });
  assert.equal(card.dataset.ytcfHidden, undefined);
  assert.equal(rootClasses.has('ytcf-filter-active'), false);
  assert.equal(rootClasses.has('ytcf-sort-active'), false);
  assert.equal(rootClasses.has('ytcf-layout-mounted'), true, 'pausing must not rebuild the YouTube grid');
  assert.equal(response.hiddenCount, 0);

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideOlderThan1Yr: true } },
    null,
    (value) => { response = value; },
  );
  assert.equal(card.dataset.ytcfHidden, 'true');
  assert.equal(card.dataset.ytcfReasons, 'older-than-one-year');
  assert.equal(response.hiddenCount, 1);

  title.textContent = 'The Web Platform Podcast';
  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hidePodcasts: true } },
    null,
    (value) => { response = value; },
  );
  assert.equal(card.dataset.ytcfReasons, 'podcasts');
  assert.equal(response.hiddenCount, 1);

  title.textContent = 'Artist — Official Music Video';
  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideMusic: true } },
    null,
    (value) => { response = value; },
  );
  assert.equal(card.dataset.ytcfReasons, 'music');
  assert.equal(response.hiddenCount, 1);

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideMusic: false } },
    null,
    (value) => { response = value; },
  );
  assert.equal(card.dataset.ytcfHidden, undefined);
  assert.equal(rootClasses.has('ytcf-filter-active'), false);
  assert.equal(response.hiddenCount, 0);
});

test('master-on feeds are always newest-first and master-off restores YouTube order', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let messageListener;
  const grid = {};
  const broadHomeSection = { tagName: 'YTD-RICH-SECTION-RENDERER' };
  let homeWrapped = false;

  const makeCard = (name, age) => {
    const title = { textContent: name, getAttribute() { return ''; } };
    return {
      name,
      tagName: 'YTD-VIDEO-RENDERER',
      dataset: {},
      style: {
        order: '',
        removeProperty(property) { if (property === 'order') this.order = ''; },
      },
      textContent: `${name} ${age}`,
      innerText: `${name} ${age}`,
      closest(selector) {
        if (selector.includes('ytd-video-renderer')) return this;
        if (homeWrapped && selector.includes('ytd-rich-section-renderer')) return broadHomeSection;
        if (selector.includes('ytd-rich-grid-renderer')) return grid;
        return null;
      },
      querySelector(selector) {
        if (selector.startsWith('#video-title')) return title;
        if (selector.includes('a[href*="/watch"]')) return { getAttribute: () => `/watch?v=${name}` };
        return null;
      },
      querySelectorAll(selector) {
        return selector.includes('#metadata-line') && age
          ? [{ textContent: age, getAttribute() { return ''; } }]
          : [];
      },
    };
  };

  const older = makeCard('older', '2 years ago');
  const undated = makeCard('undated', '');
  const newer = makeCard('newer', '3 hours ago');
  const container = { children: [older, undated, newer], dataset: {} };
  for (const card of container.children) {
    card.parentElement = container;
    card.parentNode = container;
  }

  const document = {
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') return [];
      if (selector.includes('ytd-rich-item-renderer')) return container.children;
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      local: {
        get(_defaults, callback) {
          callback({ ytCustomFeedSettings: { enabled: true } });
        },
      },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver { observe() {} }
  const context = vm.createContext({
    chrome,
    console,
    document,
    MutationObserver,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.deepEqual(container.children.map((card) => card.name), ['older', 'undated', 'newer']);
  assert.equal(newer.style.order, '-3');
  assert.equal(older.style.order, '-2');
  assert.equal(undated.style.order, '-1');

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideTopics: true } },
    null,
    () => {},
  );
  assert.equal(newer.style.order, '-3');
  assert.equal(older.style.order, '-2');
  assert.equal(undated.style.order, '-1');

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideTopics: false } },
    null,
    () => {},
  );
  assert.equal(newer.style.order, '-3');
  assert.equal(older.style.order, '-2');
  assert.equal(undated.style.order, '-1');

  // YouTube commonly adds this generic wrapper after the first settings pass.
  // A second on/off cycle must still sort the primary grid, never as a shelf.
  homeWrapped = true;
  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: true, hideTopics: true } },
    null,
    () => {},
  );
  assert.equal(newer.style.order, '-3');
  assert.equal(older.style.order, '-2');
  assert.equal(undated.style.order, '-1');
  assert.equal(container.dataset.ytcfSortContainer, 'column');

  messageListener(
    { type: 'YTCF_APPLY_SETTINGS', settings: { enabled: false } },
    null,
    () => {},
  );
  assert.deepEqual(container.children.map((card) => card.name), ['older', 'undated', 'newer']);
  assert.equal(newer.style.order, '');
  assert.equal(older.style.order, '');
  assert.equal(undated.style.order, '');
});

test('feed tie order survives YouTube replacing cards on watch/back navigation', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  const savedSession = new Map();

  const makeCard = (videoId) => ({
    tagName: 'YTD-VIDEO-RENDERER',
    dataset: {},
    style: { order: '', removeProperty(property) { if (property === 'order') this.order = ''; } },
    parentElement: null,
    textContent: 'Example video 1 month ago',
    innerText: 'Example video 1 month ago',
    closest(selector) { return selector.includes('ytd-video-renderer') ? this : null; },
    querySelector(selector) {
      if (selector.startsWith('#video-title')) return { textContent: 'Example video', getAttribute() { return ''; } };
      if (selector.includes('a[href*="/watch"]')) return { getAttribute: () => `/watch?v=${videoId}` };
      return null;
    },
    querySelectorAll(selector) {
      return selector.includes('#metadata-line')
        ? [{ textContent: '1 month ago', getAttribute() { return ''; } }]
        : [];
    },
  });

  const createContentContext = (cards, route = { pathname: '/', search: '' }) => {
    const container = { children: cards, dataset: {} };
    for (const card of cards) {
      card.parentElement = container;
      card.parentNode = container;
    }
    let messageListener;
    const document = {
      documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
      querySelectorAll(selector) {
        if (selector === '[data-ytcf-hidden="true"]') return [];
        return selector.includes('ytd-video-renderer') ? container.children : [];
      },
      addEventListener() {},
    };
    const chrome = {
      runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
      storage: {
        local: { get(_defaults, callback) { callback({ ytCustomFeedSettings: { enabled: true } }); } },
        onChanged: { addListener() {} },
      },
    };
    class MutationObserver { observe() {} }
    const sessionStorage = {
      getItem(key) { return savedSession.get(key) || null; },
      setItem(key, value) { savedSession.set(key, value); },
    };
    const context = vm.createContext({
      chrome,
      console,
      document,
      MutationObserver,
      setTimeout,
      clearTimeout,
      location: route,
      sessionStorage,
    });
    vm.runInContext(rulesSource, context);
    vm.runInContext(contentSource, context);
    return { container, messageListener };
  };

  const originalFirst = makeCard('aaaaaaaaaaa');
  const originalSecond = makeCard('bbbbbbbbbbb');
  createContentContext([originalFirst, originalSecond]);
  assert.equal(originalFirst.style.order, '-2');
  assert.equal(originalSecond.style.order, '-1');

  // The watch page gets its own order snapshot and must not replace Home's.
  createContentContext([makeCard('ccccccccccc')], { pathname: '/watch', search: '?v=ccccccccccc' });

  // YouTube has replaced the cards and supplied them in the reverse DOM order.
  const returnedSecond = makeCard('bbbbbbbbbbb');
  const returnedFirst = makeCard('aaaaaaaaaaa');
  createContentContext([returnedSecond, returnedFirst]);
  assert.equal(returnedFirst.style.order, '-2');
  assert.equal(returnedSecond.style.order, '-1');
});

test('standard result lists sort with CSS order without moving YouTube nodes', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let messageListener;
  let mutationCallback;
  const reflowAnimations = [];
  const container = {
    dataset: {},
    matches() { return false; },
    closest() { return null; },
    querySelectorAll() { return this.children; },
    appendChild() { throw new Error('sorting must not move YouTube nodes'); },
  };

  const makeCard = (name, age) => {
    const title = { textContent: name, getAttribute() { return ''; } };
    return {
      name,
      tagName: 'YTD-VIDEO-RENDERER',
      dataset: {},
      style: {
        order: '',
        removeProperty(property) { if (property === 'order') this.order = ''; },
      },
      originalTop: 0,
      parentElement: container,
      textContent: `${name} ${age}`,
      innerText: `${name} ${age}`,
      closest(selector) { return selector.includes('ytd-video-renderer') ? this : null; },
      querySelector(selector) {
        if (selector.startsWith('#video-title')) return title;
        if (selector.includes('a[href*="/watch"]')) return { getAttribute: () => `/watch?v=${name}` };
        return null;
      },
      querySelectorAll(selector) {
        return selector.includes('#metadata-line')
          ? [{ textContent: age, getAttribute() { return ''; } }]
          : [];
      },
      getBoundingClientRect() {
        const top = this.style.order === '' ? this.originalTop : (Number(this.style.order) + 2) * 100;
        return { bottom: top + 80, left: 0, right: 320, top };
      },
      animate(keyframes, options) {
        reflowAnimations.push({ keyframes, name, options });
        return { cancel() {} };
      },
    };
  };

  const older = makeCard('older', '3 years ago');
  const newer = makeCard('newer', '2 hours ago');
  older.originalTop = 0;
  newer.originalTop = 100;
  container.children = [older, newer];
  const document = {
    visibilityState: 'visible',
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') return [];
      if (selector.includes('ytd-rich-item-renderer')) return container.children;
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      local: { get(_defaults, callback) { callback({ ytCustomFeedSettings: { enabled: true, hideMusic: true } }); } },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
  }
  const context = vm.createContext({
    chrome,
    clearTimeout,
    console,
    document,
    innerHeight: 800,
    innerWidth: 1200,
    MutationObserver,
    setTimeout,
  });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);

  assert.equal(newer.style.order, '-2');
  assert.equal(older.style.order, '-1');
  assert.equal(container.dataset.ytcfSortContainer, 'column');
  assert.equal(older.dataset.ytcfEvaluated, 'true');
  assert.equal(newer.dataset.ytcfEvaluated, 'true');

  mutationCallback([{ type: 'childList', target: container, addedNodes: [] }]);
  assert.equal(older.dataset.ytcfEvaluated, 'true', 'container mutations must not blank existing cards');
  assert.equal(newer.dataset.ytcfEvaluated, 'true', 'container mutations must not blank existing cards');
  mutationCallback([{ type: 'childList', target: newer, addedNodes: [] }]);
  assert.equal(newer.dataset.ytcfEvaluated, 'true', 'visible cards stay frozen during background hydration');

  messageListener({ type: 'YTCF_APPLY_SETTINGS', settings: { enabled: false } }, null, () => {});
  assert.equal(newer.style.order, '');
  assert.equal(older.style.order, '');
  assert.equal(container.dataset.ytcfSortContainer, undefined);
  assert.equal(reflowAnimations.length, 2);
  assert.ok(reflowAnimations.every(({ keyframes }) => 'translate' in keyframes[0]));
});

test('continuous YouTube repaint mutations cannot starve a settings reapply', async () => {
  const rulesSource = await readFile(new URL('../extension/filter-rules.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  let mutationCallback;
  let nextTimerId = 0;
  const timers = new Map();
  const setTimeout = (callback, delay = 0) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  const title = { textContent: 'How to repair a bicycle wheel', getAttribute() { return ''; } };
  const card = {
    tagName: 'YTD-VIDEO-RENDERER',
    dataset: {},
    get textContent() { return title.textContent; },
    get innerText() { return title.textContent; },
    closest(selector) { return selector.includes('ytd-video-renderer') ? this : null; },
    querySelector(selector) {
      if (selector.startsWith('#video-title')) return title;
      if (selector.includes('a[href*="/watch"]')) return { getAttribute: () => '/watch?v=repaint' };
      return null;
    },
    querySelectorAll() { return []; },
  };
  const document = {
    visibilityState: 'visible',
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) {
      if (selector === '[data-ytcf-hidden="true"]') return card.dataset.ytcfHidden ? [card] : [];
      if (selector.includes('ytd-rich-item-renderer')) return [card];
      return [];
    },
    addEventListener() {},
  };
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      local: {
        get(_defaults, callback) {
          callback({ ytCustomFeedSettings: { enabled: true, hideMusic: true } });
        },
      },
      onChanged: { addListener() {} },
    },
  };
  class MutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
  }
  const context = vm.createContext({ chrome, clearTimeout, console, document, MutationObserver, setTimeout });
  vm.runInContext(rulesSource, context);
  vm.runInContext(contentSource, context);
  assert.equal(card.dataset.ytcfHidden, undefined);
  assert.equal(card.dataset.ytcfEvaluated, 'true');

  title.textContent = 'Artist — Official Music Video';
  mutationCallback([{ type: 'characterData', target: { nodeType: 3, parentElement: card }, addedNodes: [] }]);
  assert.equal(card.dataset.ytcfEvaluated, undefined, 'a recycled card stays hidden until it is rescanned');
  for (let index = 0; index < 24; index += 1) mutationCallback([]);
  assert.equal(timers.size, 3, 'repeated paints should share the pending scan instead of postponing it');

  const [scanTimerId, scanTimer] = [...timers].sort((left, right) => left[1].delay - right[1].delay)[0];
  timers.delete(scanTimerId);
  scanTimer.callback();
  assert.equal(card.dataset.ytcfHidden, 'true');
  assert.equal(card.dataset.ytcfReasons, 'music');
  assert.equal(card.dataset.ytcfEvaluated, 'true');
});
