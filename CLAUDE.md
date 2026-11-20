# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

Always respond to the user in Polish (zawsze odpowiadaj po polsku). UI text and code comments are in Polish.

## Project

PL3Y is the game lobby at `https://pl3y.pl` (repo `egozaur/egozaur.github.io`, a GitHub Pages user site, custom domain set by `CNAME`). It is plain static HTML/CSS/JS: no framework, no build step, no dependencies, no tests.

Project repos of the same GitHub account are served under the domain automatically, e.g. the `egozaur/tajniacy` repo appears at `https://pl3y.pl/tajniacy/`. Don't edit game repos from here.

- `index.html`: the lobby. A 3D carousel of game cards. The `GAMES` array at the top of the script is the whole game list (`title`, `label`, `href` or `null` for "coming soon", `preview`: `'board'`, `'dossier'`, `'ladder'`, `'letter'` or `'seal'`). Adding a game means adding one line. Optional `img` (e.g. `/img/mafia.webp`) is a thumbnail file replaced directly on GitHub; if the file is missing, `onerror` removes the `<img>` and the CSS `preview` shows instead. Carousel controls: click a side card, the ‹ › arrows, ←/→ keys, swipe, and Enter or "GRAJ →" to launch the centre game.
- `auth.js`: the shared password gate for the whole domain (see below). It is loaded synchronously in `<head>` as `/auth.js`.
- `favicon.svg`, `CNAME` (`pl3y.pl`).
- **App mode**: `site.webmanifest` has `display: standalone` (scope `/`), and every PL3Y page (lobby and game pages) carries `<link rel="manifest">`, `apple-mobile-web-app-capable`, `mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style`. Added to the home screen, PL3Y opens full screen with no browser Back button, so phone pages of games need their own way back to `/` (shown only when `display-mode: standalone` / `navigator.standalone`). On iOS the home-screen app has storage separate from Safari.
- **QR scanner** (bottom of `index.html`, button `#scan`, overlay `#scanov`): the system camera always opens QR links in the browser, so the lobby has its own scanner that opens PL3Y links inside the app. Shown only on touch devices (`pointer: coarse`; `?scan` forces it for tests). Decodes with `BarcodeDetector` when available, otherwise lazily loads `vendor/jsQR.js` (jsQR 1.4.0, Apache-2.0, the only vendored dependency). `PL3Y_SCAN.target(text)` accepts only `pl3y.pl`, `www.pl3y.pl`, `egozaur.github.io` (or the current host) and rewrites the URL onto `location.origin`.

There is no Python or Node on this machine. To serve locally, use a PowerShell `HttpListener` script, and open the page via `http://localhost:…` rather than `file://`, because `crypto.subtle` needs a secure context.

## Password gate: a lock for friends, NOT security

The site is static, so anyone who reads the source can bypass the gate, for example by setting localStorage by hand. It only keeps casual visitors out. Never put real secrets behind it.

The contract is shared by the lobby and every game. Change it only together with all games.

- `localStorage.pl3y_auth` holds the SHA-256 (lowercase hex) of the correct password. It is written after a successful entry.
- `localStorage.pl3y_last` holds the timestamp (ms, `Date.now()`) of the last activity.
- The gate is shown when `pl3y_auth` is missing, when it differs from `PASS_HASH` in `auth.js` (that is, the password was changed), or when more than 30 minutes have passed since `pl3y_last`.
- Activity (click, touch, key) refreshes `pl3y_last`, at most once every 30 s. Opening a page with a valid session also counts as activity.
- The gate also checks on `visibilitychange` (tab shown again), on `pageshow`, and every 60 s, so after 30 minutes of inactivity it comes back by itself.
- Only the SHA-256 hash of the password is stored in code (`PASS_HASH` in `auth.js`), never the plain text. The hash is plain SHA-256 of the UTF-8 password, with no salt or prefix.
- To change the password, put the new hash into `PASS_HASH`. Everyone gets the gate again because `pl3y_auth` no longer matches.
- Games include `<script src="/auth.js"></script>` early in `<head>`. Player pages opened from a QR code or room link (`mafia/play.html`, `milion/play.html`, `tajniacy/captain.html`; `rozejrzyj/` has only a host page with the normal gate) are gated too, with `<script src="/auth.js" data-no-idle></script>`: there only `pl3y_auth` is checked (no 30-minute idle expiry, so the gate never pops up mid-game; a password change still locks them). On success `auth.js` dispatches `pl3y:unlock` on `document`. It exposes `window.PL3Y.isLocked()` and `window.PL3Y.lock()`.
- While locked, page content is blurred and made `inert`, and clicks and keys outside the gate are swallowed in the capture phase.
