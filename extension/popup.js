(() => {
  'use strict';

  const STORAGE_KEY = 'ytCustomFeedSettings';
  const BLOCKED_CHANNELS_STORAGE_KEY = 'ytCustomFeedBlockedChannels';
  const DEFAULT_SETTINGS = {
    enabled: true,
    hideMusic: false,
    hidePodcasts: false,
    hideShorts: false,
    hidePosts: false,
    hideTopics: false,
    hideExploreMore: false,
    hideSponsored: false,
    hideOlderThan1Yr: false,
  };

  const inputs = Array.from(document.querySelectorAll('[data-setting]'));
  const status = document.getElementById('status');
  const statusCopy = status.querySelector('span:last-child');
  const masterCopy = document.getElementById('master-copy');
  const resetButton = document.getElementById('reset');
  let settings = { ...DEFAULT_SETTINGS };
  let userChangedSettings = false;

  function hasActiveFilters() {
    return Object.entries(settings).some(([key, value]) => key !== 'enabled' && value);
  }

  function render() {
    for (const input of inputs) input.checked = Boolean(settings[input.dataset.setting]);
    const enabled = settings.enabled;
    document.body.classList.toggle('filters-disabled', !enabled);
    masterCopy.textContent = !enabled
      ? 'Paused'
      : 'On · plain list · newest first';
    for (const input of inputs) {
      if (input.dataset.setting !== 'enabled') input.disabled = !enabled;
    }
  }

  function setStatus(copy, state = '') {
    statusCopy.textContent = copy;
    status.className = `status ${state}`.trim();
  }

  function activeTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => callback(tabs?.[0] || null));
  }

  function notifyActiveTab() {
    activeTab((tab) => {
      if (!tab?.id || !/^https:\/\/(?:www\.)?youtube\.com\//.test(tab.url || '')) {
        setStatus('Open YouTube to apply filters', settings.enabled ? '' : 'off');
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'YTCF_APPLY_SETTINGS', settings }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          setStatus('Refresh YouTube once to connect');
          return;
        }
        if (!settings.enabled) setStatus('Filters paused', 'off');
        else if (!hasActiveFilters()) setStatus('Plain list · newest first', 'ready');
        else if (response.hiddenCount) setStatus(`${response.hiddenCount} feed item${response.hiddenCount === 1 ? '' : 's'} hidden`, 'ready');
        else setStatus('Active on this tab', 'ready');
      });
    });
  }

  function save() {
    chrome.storage.local.set({ [STORAGE_KEY]: settings }, notifyActiveTab);
  }

  function handleChange(event) {
    userChangedSettings = true;
    const key = event.currentTarget.dataset.setting;
    settings[key] = event.currentTarget.checked;

    render();
    save();
  }

  for (const input of inputs) input.addEventListener('change', handleChange);
  resetButton.addEventListener('click', () => {
    userChangedSettings = true;
    settings = { ...DEFAULT_SETTINGS };
    render();
    chrome.storage.local.set({
      [STORAGE_KEY]: settings,
      [BLOCKED_CHANNELS_STORAGE_KEY]: [],
    }, notifyActiveTab);
  });

  chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_SETTINGS }, (stored) => {
    if (userChangedSettings) return;
    const saved = stored[STORAGE_KEY] || {};
    settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in saved) settings[key] = Boolean(saved[key]);
    }
    render();
    notifyActiveTab();
  });
})();
