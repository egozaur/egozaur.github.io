# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

Always respond to the user in Polish (zawsze odpowiadaj po polsku). UI text and code comments are in Polish.

## Project

PL3Y is the game lobby at `https://pl3y.pl` (repo `egozaur/egozaur.github.io`, a GitHub Pages user site, custom domain set by `CNAME`). It is plain static HTML/CSS/JS: no framework, no build step, no dependencies, no tests.

Project repos of the same GitHub account are served under the domain automatically, e.g. the `egozaur/tajniacy` repo appears at `https://pl3y.pl/tajniacy/`. Don't edit game repos from here.

- `index.html`: the lobby. A 3D carousel of game cards. The `GAMES` array at the top of the script is the whole game list (`title`, `label`, `href` or `null` for "coming soon", `preview`: `'board'`, `'dossier'`, `'ladder'`, `'letter'`, `'pyramid'` or `'seal'`). Adding a game means adding one entry (plus `desc` and `accent`, see Lobby features below). Optional `img` (e.g. `/img/mafia.webp`) is a thumbnail file replaced directly on GitHub; if the file is missing, `onerror` removes the `<img>` and the CSS `preview` shows instead. Carousel controls: click a side card, the ‹ › arrows, ←/→ keys, swipe, and Enter or "GRAJ →" to launch the centre game.
- **Lobby features** (all in `index.html`): a toggle button (top right) switches the carousel to a grid of all games (`localStorage.pl3y_view`; arrows/Home/End/Enter work in the grid). Each `GAMES` entry also needs `desc` (one-sentence description, shown under the carousel and on grid cards) and `accent` (hex colour; the page background glow fades to it). The mute button (`localStorage.pl3y_mute`) controls Web Audio sounds and vibration. The "Kod pokoju" field asks which game the 5-character code belongs to (every game has its own code space and link format) and opens it via the `JOIN` array (`{ game, name, url }`; `game` must match the `GAMES` title). Currently: Mafia `/mafia/play.html?r=CODE`, Milionerzy `/milion/play.html#CODE`, Tajniacy duet `/tajniacy/duo.html#CODE`, Kurczacze `/kurczacze/#CODE`. Tajniacy with captains join by token link, not by code, and Rozejrzyj się is single-computer, so neither is in `JOIN`. Adding a game with join-by-code means one more `JOIN` entry.
- `auth.js`: the shared password gate for the whole domain (see below). It is loaded synchronously in `<head>` as `/auth.js`.
- `favicon.svg`, `CNAME` (`pl3y.pl`).
- **App mode**: `site.webmanifest` has `display: standalone` (scope `/`), and every PL3Y page (lobby and game pages) carries `<link rel="manifest">`, `apple-mobile-web-app-capable`, `mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style`. Added to the home screen, PL3Y opens full screen with no browser Back button, so phone pages of games need their own way back to `/` (shown only when `display-mode: standalone` / `navigator.standalone`). On iOS the home-screen app has storage separate from Safari.
- **QR scanner** (bottom of `index.html`, button `#scan`, overlay `#scanov`): the system camera always opens QR links in the browser, so the lobby has its own scanner that opens PL3Y links inside the app. Shown only on touch devices (`pointer: coarse`; `?scan` forces it for tests). Decodes with `BarcodeDetector` when available, otherwise lazily loads `vendor/jsQR.js` (jsQR 1.4.0, Apache-2.0, the only vendored dependency). `PL3Y_SCAN.target(text)` accepts only `pl3y.pl`, `www.pl3y.pl`, `egozaur.github.io` (or the current host) and rewrites the URL onto `location.origin`.

Work happens on two machines: **macOS** (Python 3, Node, Chrome; no PowerShell) and **Windows** (no Node or Python; PowerShell 5.1, Edge). Check which one you are on and use the matching command below. To serve locally, run `python3 -m http.server 8088` in this folder on macOS, or a PowerShell `HttpListener` script (like the games' `dev/serve.ps1`) on Windows, and open the page via `http://localhost:…` rather than `file://`, because `crypto.subtle` needs a secure context.

## Password gate: hasło sprawdza serwer, sesja to token

Od tej zmiany hasło NIE jest już w kodzie strony. Sprawdza je Worker `pl3y-server` (sekret Cloudflare `PL3Y_PASSWORD`) i oddaje token sesji podpisany HMAC-SHA256 (sekret `PL3Y_TOKEN_SECRET`). Worker wymaga tokena przy każdym zapytaniu `/api/*` i połączeniu WebSocket (zmienna `AUTH_MODE` w `mafia/worker/wrangler.toml`: `off` / `optional` / `required`). Sama strona nadal jest statyczna, więc bramka w przeglądarce ukrywa interfejs, a prawdziwą ochroną jest odmowa serwera bez tokena. Stary hash z historii repozytorium uznajemy za jawny: nowe hasło ma być długie i ustawione tylko w sekrecie.

Kontrakt jest wspólny dla lobby i wszystkich gier. Zmieniaj go tylko razem z grami.

- `localStorage.pl3y_token` – token sesji (`dane.podpis`), `pl3y_token_exp` – koniec ważności (ms), `pl3y_token_kind` – rodzaj: `d` lobby/komputer (30 min), `p` telefon (12 h), `t` testowy (1 h).
- `localStorage.pl3y_last` – znacznik czasu (ms) ostatniej aktywności.
- Bramka wraca, gdy brak tokena, token wygasł, albo (poza stronami telefonów) minęło ponad 30 min od `pl3y_last`.
- Logowanie: `POST {API}/api/auth/login` `{password, profile:'d'|'p'}` → `{token, exp, kind}`. Przedłużenie: `POST /api/auth/refresh` z `Authorization: Bearer …` (okno przesuwne; strona telefonu wysyła `profile:'p'` i awansuje token `d` do `p`). 429 = za dużo prób (8 na minutę z IP).
- Aktywność (klik, dotyk, klawisz) odświeża `pl3y_last` (maks. co 30 s) i przedłuża token, gdy zostało mu mniej niż pół życia. Sprawdzenie także na `visibilitychange`, `pageshow` i co 60 s; strony telefonów przedłużają token same co minutę.
- Gry czytają token z `localStorage.pl3y_token` (albo `window.PL3Y.token()`), wysyłają go nagłówkiem `Authorization: Bearer …` (fetch) lub `?tok=…` (WebSocket). Odpowiedź 401 → `window.PL3Y.expired()` pokazuje bramkę.
- Strony graczy z QR (`mafia/play.html`, `milion/play.html`, `tajniacy/captain.html`) ładują `<script src="/auth.js" data-no-idle></script>`: token 12 h, bez wygasania po bezczynności. `rozejrzyj/` i `kurczacze/` mają jedną stronę ze zwykłą bramką.
- Po sukcesie `auth.js` wysyła `pl3y:unlock` na `document`. Udostępnia `window.PL3Y` (`isLocked`, `lock`, `token`, `refresh`, `expired`).
- Zmiana hasła: `wrangler secret put PL3Y_PASSWORD` (istniejące tokeny dalej działają do wygaśnięcia). Natychmiastowe wylogowanie wszystkich: zmień `PL3Y_TOKEN_SECRET`.
- Testy E2E na prawdziwym serwerze z localhost (`?server=prod&testkey=<PL3Y_TEST_SECRET>`): sekret testowy wymieniany jest na token `t`, z którym Worker przepuszcza Origin `http://localhost`. `ALLOW_LOCALHOST` na produkcji jest `"false"`.
- `robots.txt` (`Disallow: /`) i `<meta name="robots" content="noindex, nofollow">` na stronach gier i lobby.
