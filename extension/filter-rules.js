(() => {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    hideMusic: false,
    hidePodcasts: false,
    hideShorts: false,
    hidePosts: false,
    hideTopics: false,
    hideExploreMore: false,
    hideOlderThan1Yr: false,
  });

  const MUSIC_TITLE_PATTERN = /\b(?:music|dark jazz|trip[- ]hop|official audio|lyrics?|full album|soundtrack|ost|lo[- ]?fi|ambient mix|chillhop|synthwave|beats to|sleep music|study music|concert|live at|music mix)\b/i;
  const BAIT_PHRASE_PATTERN = /\b(?:you won'?t believe|what happens next|the truth about|they don'?t want you to know|before it'?s too late|this changes everything|game over|the end of|is dead|destroyed|destroys|ruined|shocking|mind[- ]?blowing|insane|secret revealed|never do this)\b/i;
  // Search results often collapse adjacent metadata into strings such as
  // "83K3y ago" or "8.7K1mo ago", so the age token cannot require a word
  // boundary before its number.
  const AGE_PATTERN = /(\d+)\s*(seconds?|secs?|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d|weeks?|wks?|wk|w|months?|mos?|mo|years?|yrs?|yr|y)\s*ago\b/i;

  function normalizeAgeUnit(value) {
    const unit = String(value || '').toLowerCase();
    if (unit === 'mo' || unit === 'mos' || unit.startsWith('month')) return 'month';
    if (unit === 'm' || unit === 'min' || unit === 'mins' || unit.startsWith('minute')) return 'minute';
    if (unit === 's' || unit === 'sec' || unit === 'secs' || unit.startsWith('second')) return 'second';
    if (unit === 'h' || unit === 'hr' || unit === 'hrs' || unit.startsWith('hour')) return 'hour';
    if (unit === 'd' || unit.startsWith('day')) return 'day';
    if (unit === 'w' || unit === 'wk' || unit === 'wks' || unit.startsWith('week')) return 'week';
    if (unit === 'y' || unit === 'yr' || unit === 'yrs' || unit.startsWith('year')) return 'year';
    return '';
  }

  function isShort(meta = {}) {
    return [
      'ytd-reel-item-renderer',
      'ytd-reel-video-renderer',
      'yt-shorts-lockup-view-model',
      'ytm-shorts-lockup-view-model',
      'ytm-shorts-lockup-view-model-v2',
    ].includes(meta.tagName) || String(meta.href || '').includes('/shorts/');
  }

  function isMusicOrPlaylist(meta = {}) {
    return meta.tagName === 'ytd-playlist-renderer' ||
      meta.tagName === 'ytd-radio-renderer' ||
      Boolean(meta.hasPlaylistMarkup) ||
      Boolean(meta.hasMusicBadge) ||
      Boolean(meta.hasArtistBadge) ||
      /\s-\sTopic$/i.test(String(meta.channel || '').trim()) ||
      MUSIC_TITLE_PATTERN.test(String(meta.title || ''));
  }

  function isPodcast(meta = {}) {
    return [
      'ytd-podcast-renderer',
      'ytd-podcast-show-renderer',
    ].includes(meta.tagName) ||
      Boolean(meta.hasPodcastMarkup) ||
      /\bpodcasts?\b/i.test(`${meta.title || ''} ${meta.channel || ''} ${meta.metadata || ''}`);
  }

  function isBaitTitle(title) {
    const value = String(title || '').trim();
    if (!value) return false;
    const uppercaseWords = value.match(/\b[A-Z]{3,}\b/g) || [];
    const excessiveCaps = uppercaseWords.length >= 3;
    const sensationalPunctuation = /!!+|\?!|!\?/.test(value);
    return BAIT_PHRASE_PATTERN.test(value) || excessiveCaps || sensationalPunctuation;
  }

  function ageCategory(text) {
    const match = String(text || '').replace(/\s+/g, ' ').match(AGE_PATTERN);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = normalizeAgeUnit(match[2]);
    if (unit === 'year') return amount > 1 ? 'older' : 'newer';
    return 'newer';
  }

  function ageInDays(text) {
    const match = String(text || '').replace(/\s+/g, ' ').match(AGE_PATTERN);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = normalizeAgeUnit(match[2]);
    const daysPerUnit = {
      second: 1 / 86400,
      minute: 1 / 1440,
      hour: 1 / 24,
      day: 1,
      week: 7,
      month: 30,
      year: 365,
      yr: 365,
    };
    return amount * daysPerUnit[unit];
  }

  globalThis.YTCFFilterRules = Object.freeze({
    DEFAULT_SETTINGS,
    ageCategory,
    ageInDays,
    isBaitTitle,
    isMusicOrPlaylist,
    isPodcast,
    isShort,
  });
})();
