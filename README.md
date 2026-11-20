# YT Custom Feed

Version 0.1.0 — a Chrome extension for a simpler YouTube feed.

YT Custom Feed is a small Manifest V3 Chrome extension that lets you choose what appears in YouTube feeds from a toolbar popup. Settings apply immediately and persist locally in Chrome.

Video cards receive a **🚫 Block Channel** quick action. On Home and other recommendation surfaces it invokes YouTube's own **Don't recommend channel** command. Search pages do not expose that command, so the extension stores the channel locally and removes its results itself. **Reset all** clears the local blocked-channel list.

The first version carries forward the feed categories exposed by the reference SlopFirewall project:

- music and playlists
- podcasts, podcast shows, and podcast shelves
- YouTube Shorts cards and shelves
- community text, image, and poll posts
- topic shelves and the chip bar
- the **Explore more topics** shelf and its **Not interested** control
- videos older than one year
- every loaded video feed sorted from newest to oldest

While the main switch is on, the extension removes YouTube's supplemental shelves and chip bars, presents the primary videos as a plain list, and sorts them using the relative publication age shown by YouTube. Undated items are kept at the bottom. Category toggles remove matching videos from that list. Clicking a video opens YouTube's normal watch page in a right-side player pane while keeping the original feed in the left pane. Chrome's built-in Split View is used when available; otherwise the extension tiles two Chrome windows side by side. Later clicks reuse the player pane and load the newly selected video there. The extension does not fetch search data or call the YouTube Data API. No local model or server is required.

## Install from the shared ZIP

1. Download `YT_Custom_Feed-0.1.0.zip` and extract it to a folder you will keep. Chrome needs the extracted files to remain in place.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the extracted **extension** folder (the folder containing `manifest.json`). Do not select the ZIP or its parent folder.
4. Pin **YT Custom Feed** from Chrome's Extensions (puzzle-piece) menu so its button is easy to find.
5. Open or refresh `youtube.com`, then click the extension button.

For development in this repository, load `C:\Projects\YT_Custom_Feed\extension` directly. After replacing files with a new version, click **Reload** for the extension on `chrome://extensions` and refresh YouTube.

## Use it

- **Feed filters** is the master switch. With it on, loaded video feeds appear as a plain list, newest first. Turn it off to temporarily restore YouTube's layout and order. Your individual choices are retained.
- Turn a category switch **on** to hide that category: music and playlists, podcasts, Shorts, community posts, the topic chip bar, or the **Explore more topics** shelf.
- **Hide older videos** removes videos whose displayed publication age is more than one year. Items without a usable date remain at the bottom of the sorted list.
- Click a video in the feed to open its normal YouTube watch page beside the feed. Further clicks reuse the player pane. On Chrome versions without Split View support, the extension arranges two windows side by side.
- Hover over a video card and click **🚫 Block Channel** to stop seeing that channel. On recommendation pages this uses YouTube's **Don't recommend channel** action; on Search it uses a local block list.
- **Reset all** restores the default switches and clears the local Search block list. It cannot undo a **Don't recommend channel** choice already saved by YouTube.

Settings are stored in Chrome on your computer. The extension does not require a server, YouTube API key, or account with the developer. Filtering applies to video cards as YouTube loads them, so additional cards can change the list while you scroll. The newest-first order uses YouTube's displayed relative ages, not an exact publication timestamp.

## Troubleshooting

- If the popup says **Refresh YouTube once to connect**, refresh the YouTube tab after loading or reloading the extension.
- If a category is still visible, make sure **Feed filters** is on and the category switch is on. YouTube changes its page markup, so some newly introduced card designs may need an extension update.
- If a video opens in a separate window, that is the fallback on Chrome versions without compatible Split View support.
- To remove the extension, open `chrome://extensions` and choose **Remove** for YT Custom Feed.

## How it works

The extension runs `filter-rules.js` and `content.js` inside YouTube pages. It does not replace YouTube or fetch a separate feed. Instead, it reads the video cards and shelves that YouTube has already put in the page's DOM. For each card it gathers the title, channel, link, badges, renderer type, and displayed age. Local rules classify music, playlists, podcasts, Shorts, and older videos. It also inspects shelf and post elements separately.

When a filter matches, the content script marks the card or section with a `data-ytcf-hidden` attribute. `content.css` hides marked elements with `display: none`. The enabled view also uses CSS to hide supplemental shelves and chips and to turn Home's video grid into a single-column list with thumbnail-and-details rows. YouTube's main card and section nodes stay in place, which lets YouTube continue updating its own page.

For newest-first order, the script parses the relative ages YouTube shows (such as “3 hours ago” or “2 weeks ago”) and assigns CSS `order` values to video cards within their existing containers. Undated cards go last. This is an approximate sort of the cards already loaded, not a request for a complete chronological YouTube feed. The content script uses a `MutationObserver` and YouTube navigation events to recheck cards as YouTube adds, replaces, or repaints them. It briefly keeps unevaluated cards out of view to avoid showing an unfiltered card before the next pass.

The popup saves switches in `chrome.storage.local` and sends changes to the active YouTube tab. Pausing clears the extension's hide markers and sort/layout styling so YouTube's presentation returns. The Block Channel button is inserted on cards: it triggers YouTube's own recommendation command where available, or saves a local channel key for Search results. Video clicks are sent to the background service worker, which opens or reuses a YouTube watch tab in Chrome Split View when supported, with tiled windows as a fallback.

## Project files

- `extension/manifest.json` defines the popup, YouTube content scripts, and background service worker.
- `extension/split-player-worker.js` opens and reuses the side-by-side YouTube player pane.
- `extension/popup.html`, `popup.css`, and `popup.js` provide the toolbar UI.
- `extension/content.js` scans YouTube's dynamically loaded feed, applies the selected filters, and routes video clicks to the player window.
- `extension/filter-rules.js` contains the local classification rules.
- `extension/content.css` removes matched elements and closes grid gaps.

## Test

```powershell
npm test
```
