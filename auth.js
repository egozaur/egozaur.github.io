/*
 * PL3Y – wspólna bramka hasła dla całej domeny pl3y.pl (lobby i gry).
 *
 * Hasło sprawdza SERWER (Worker pl3y-server, sekret PL3Y_PASSWORD) i oddaje token sesji podpisany HMAC.
 * Token jest potem wymagany przez Worker przy każdym zapytaniu i połączeniu (tryb AUTH_MODE="required").
 * Sama strona nadal jest statyczna, więc bramka na stronie to tylko wygoda (ukrywa interfejs); prawdziwą
 * ochroną jest odmowa serwera bez ważnego tokena.
 *
 * Kontrakt (opisany też w CLAUDE.md – nie zmieniaj bez aktualizacji gier):
 *   localStorage "pl3y_token"      = token sesji (tekst "dane.podpis"),
 *   localStorage "pl3y_token_exp"  = koniec ważności tokena (ms),
 *   localStorage "pl3y_token_kind" = rodzaj: "d" lobby/komputer (30 min), "p" telefon (12 h), "t" testowy (1 h),
 *   localStorage "pl3y_last"       = znacznik czasu (ms) ostatniej aktywności.
 *   Bramka wraca, gdy: brak tokena, token wygasł, albo (poza stronami telefonów) od pl3y_last minęło ponad 30 min.
 *   Aktywność (klik, dotyk, klawisz) odświeża pl3y_last maks. raz na 30 s i przedłuża token (POST /api/auth/refresh),
 *   gdy zostało mu mniej niż pół życia. Sprawdzenie także przy powrocie do karty (visibilitychange) i co minutę.
 *
 * Użycie w grze: <script src="/auth.js"></script> w <head> (bez defer).
 * Strony graczy (telefony z QR): <script src="/auth.js" data-no-idle></script>
 *   – token na 12 h (profil "p"), bez wygasania po bezczynności; token „d” z lobby awansuje do „p” sam.
 * Gry czytają token z localStorage (pl3y_token) albo przez PL3Y.token(); wysyłają go jako
 *   nagłówek "Authorization: Bearer …" (fetch) lub parametr ?tok=… (WebSocket).
 * Po wpisaniu hasła na document leci zdarzenie "pl3y:unlock".
 */
(function () {
  'use strict';

  // Adres wspólnego serwera PL3Y. Hasła tu nie ma: sprawdza je Worker.
  var API = 'https://pl3y-server.pl3y.workers.dev';
  // Testy lokalne (tylko http://localhost): localStorage.pl3y_dev_api = adres lokalnego Workera (wrangler dev).
  try { if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && localStorage.getItem('pl3y_dev_api')) API = localStorage.getItem('pl3y_dev_api'); } catch (e) {}

  var K_TOKEN = 'pl3y_token';
  var K_EXP = 'pl3y_token_exp';
  var K_KIND = 'pl3y_token_kind';
  var K_LAST = 'pl3y_last';
  var LIFE = { d: 30 * 60 * 1000, p: 12 * 60 * 60 * 1000, t: 60 * 60 * 1000 };   // czas życia tokena wg rodzaju
  var IDLE_MS = 30 * 60 * 1000;   // po tylu ms bezczynności bramka wraca
  var TOUCH_MS = 30 * 1000;       // pl3y_last odświeżamy najwyżej tak często
  var TICK_MS = 60 * 1000;        // okresowe sprawdzanie
  // <script src="/auth.js" data-no-idle> – strony graczy: bez wygasania po bezczynności,
  // żeby bramka nie wyskoczyła w trakcie partii (zmiana hasła nadal wylogowuje).
  var NO_IDLE = !!(document.currentScript && document.currentScript.hasAttribute('data-no-idle'));

  // localStorage bywa niedostępny (tryb prywatny) – wtedy pamięć tylko na tę stronę.
  var mem = {};
  function get(k) {
    try { return localStorage.getItem(k); } catch (e) { return k in mem ? mem[k] : null; }
  }
  function put(k, v) {
    mem[k] = String(v);
    try { localStorage.setItem(k, String(v)); } catch (e) { /* trudno */ }
  }

  function drop(k) {
    delete mem[k];
    try { localStorage.removeItem(k); } catch (e) { /* trudno */ }
  }

  // Ważny token: jest i nie wygasł. Szczegółów (podpis) pilnuje serwer.
  function tokenOk() {
    return !!get(K_TOKEN) && Number(get(K_EXP)) > Date.now();
  }

  function valid() {
    if (!tokenOk()) return false;
    if (NO_IDLE) return true;
    var last = Number(get(K_LAST));
    var age = Date.now() - last;
    return last > 0 && age >= -TICK_MS && age <= IDLE_MS;
  }

  var root = document.documentElement;
  var locked = false;
  var gate = null;

  // ---------- style (wszystko pod #pl3y-gate, żeby nie gryzło się z grami) ----------
  var CSS =
    'html.pl3y-locked body{overflow:hidden}' +
    'html.pl3y-locked body>:not(#pl3y-gate){filter:blur(14px) brightness(.55);pointer-events:none;user-select:none}' +
    '#pl3y-gate{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:24px;' +
      'background:radial-gradient(ellipse at 50% 45%,rgba(28,24,19,.72),rgba(12,11,9,.94) 70%);' +
      'color:#EFE8D8;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;animation:pl3y-in .45s ease both;' +
      '-webkit-font-smoothing:antialiased}' +
    '#pl3y-gate *{box-sizing:border-box}' +
    '#pl3y-gate .pg-box{width:min(340px,100%);margin:0;display:flex;flex-direction:column;align-items:center;gap:14px}' +
    '#pl3y-gate .pg-mark{display:block;width:84px;height:84px;filter:drop-shadow(0 0 18px rgba(233,196,106,.35))}' +
    '#pl3y-gate .pg-title{margin:6px 0 22px;padding-left:.42em;font:500 13px/1 "JetBrains Mono",ui-monospace,monospace;' +
      'letter-spacing:.42em;color:#EFE8D8}' +
    '#pl3y-gate .pg-label{align-self:stretch;text-align:center;font:500 11px/1 "JetBrains Mono",ui-monospace,monospace;' +
      'letter-spacing:.3em;text-transform:uppercase;color:#A39C8C}' +
    '#pl3y-gate .pg-input{width:100%;height:54px;margin:0;padding:0 18px;background:rgba(12,11,9,.75);' +
      'border:1px solid rgba(201,168,92,.35);border-radius:12px;color:#EFE8D8;font:500 18px/1 Inter,system-ui,sans-serif;' +
      'letter-spacing:.14em;text-align:center;outline:none;transition:border-color .2s,box-shadow .2s}' +
    '#pl3y-gate .pg-input:focus{border-color:#C9A85C;box-shadow:0 0 0 3px rgba(201,168,92,.2)}' +
    '#pl3y-gate .pg-input[aria-invalid=true]{border-color:#B9463B}' +
    '#pl3y-gate .pg-btn{width:100%;height:54px;margin:0;border:0;border-radius:999px;background:#C9A85C;color:#0C0B09;' +
      'padding:0 0 0 .32em;font:600 13px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.32em;text-transform:uppercase;' +
      'cursor:pointer;transition:background .2s,box-shadow .2s}' +
    '#pl3y-gate .pg-btn:hover{background:#E3C77F;box-shadow:0 0 28px rgba(227,199,127,.25)}' +
    '#pl3y-gate .pg-btn:focus-visible{outline:2px solid #E3C77F;outline-offset:4px}' +
    '#pl3y-gate .pg-err{min-height:1.3em;margin:2px 0 0;text-align:center;font:500 11px/1.3 "JetBrains Mono",ui-monospace,monospace;' +
      'letter-spacing:.22em;text-transform:uppercase;color:#D9786C}' +
    '#pl3y-gate .pg-shake{animation:pl3y-shake .42s cubic-bezier(.36,.07,.19,.97) both}' +
    '@keyframes pl3y-shake{15%,85%{transform:translateX(-2px)}30%,70%{transform:translateX(4px)}45%,55%{transform:translateX(-5px)}50%{transform:translateX(5px)}}' +
    '@keyframes pl3y-in{from{opacity:0}}' +
    '@media (prefers-reduced-motion:reduce){#pl3y-gate,#pl3y-gate .pg-shake{animation:none}}';

  var style = document.createElement('style');
  style.id = 'pl3y-gate-style';
  style.textContent = CSS;
  (document.head || root).appendChild(style);

  function loadFonts() {
    if (document.querySelector('link[href*="fonts.googleapis.com"][href*="Cormorant"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,600&family=Inter:wght@500&family=JetBrains+Mono:wght@500;600&display=swap';
    document.head.appendChild(l);
  }

  function whenBody(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  // Reszta strony nieaktywna (klawiatura, czytniki ekranu), dopóki bramka stoi.
  function setInert(on) {
    var kids = document.body ? document.body.children : [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el === gate) continue;
      if (on && !el.hasAttribute('inert')) {
        el.setAttribute('inert', '');
        el.setAttribute('data-pl3y-inert', '');
      } else if (!on && el.hasAttribute('data-pl3y-inert')) {
        el.removeAttribute('inert');
        el.removeAttribute('data-pl3y-inert');
      }
    }
  }

  function save(r) {
    put(K_TOKEN, r.token);
    put(K_EXP, r.exp);
    put(K_KIND, r.kind);
  }

  // Wymiana hasła na token. Zwraca obietnicę: { ok } albo { err } (komunikat po polsku).
  function signIn(password) {
    return fetch(API + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password, profile: NO_IDLE ? 'p' : 'd' })
    }).then(function (res) {
      if (res.status === 429) return { err: 'Za dużo prób. Poczekaj chwilę' };
      return res.json().then(function (j) {
        if (res.ok && j && j.token) { save(j); return { ok: true }; }
        if (res.status === 401) return { err: 'Złe hasło' };
        return { err: 'Serwer niedostępny' };
      }, function () { return { err: 'Serwer niedostępny' }; });
    }, function () { return { err: 'Brak połączenia z serwerem' }; });
  }

  // Przedłużenie tokena (okno przesuwne). Telefony (data-no-idle) przy okazji awansują token „d” do „p”.
  var refreshing = null;
  function refreshToken() {
    if (refreshing || !tokenOk()) return refreshing || Promise.resolve(false);
    refreshing = fetch(API + '/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + get(K_TOKEN) },
      body: JSON.stringify({ profile: NO_IDLE ? 'p' : 'd' })
    }).then(function (res) {
      if (res.status === 401) { drop(K_TOKEN); drop(K_EXP); drop(K_KIND); lock(); return false; }   // serwer nie uznaje sesji
      return res.json().then(function (j) { if (res.ok && j && j.token) { save(j); return true; } return false; });
    }, function () { return false; }).then(function (ok) { refreshing = null; return ok; });
    return refreshing;
  }

  // Czy token wymaga przedłużenia: została mniej niż połowa życia, albo telefon trzyma krótki token „d”.
  function wantsRefresh() {
    if (!tokenOk()) return false;
    var kind = get(K_KIND) || 'd';
    if (NO_IDLE && kind === 'd') return true;
    return Number(get(K_EXP)) - Date.now() < (LIFE[kind] || LIFE.d) / 2;
  }

  function build() {
    if (!locked || gate) return;
    loadFonts();
    gate = document.createElement('div');
    gate.id = 'pl3y-gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-labelledby', 'pl3y-gate-title');
    gate.innerHTML =
      '<form class="pg-box" novalidate>' +
        '<img class="pg-mark" src="/mark.svg" alt="" aria-hidden="true">' +
        '<h2 class="pg-title" id="pl3y-gate-title">PL3Y</h2>' +
        '<label class="pg-label" for="pl3y-pass">Hasło</label>' +
        '<input class="pg-input" id="pl3y-pass" name="password" type="password" autocomplete="current-password"' +
          ' autocapitalize="off" autocorrect="off" spellcheck="false">' +
        '<button class="pg-btn" type="submit">Wejdź</button>' +
        '<p class="pg-err" role="alert"></p>' +
      '</form>';
    document.body.appendChild(gate);
    setInert(true);

    var form = gate.querySelector('form');
    var input = gate.querySelector('input');
    var err = gate.querySelector('.pg-err');
    var btn = gate.querySelector('.pg-btn');

    function fail(msg) {
      err.textContent = msg;
      input.setAttribute('aria-invalid', 'true');
      input.classList.remove('pg-shake');
      void input.offsetWidth; // restart animacji
      input.classList.add('pg-shake');
      input.focus();
      input.select();
    }
    input.addEventListener('input', function () {
      input.removeAttribute('aria-invalid');
      err.textContent = '';
    });
    input.addEventListener('animationend', function () { input.classList.remove('pg-shake'); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value;
      if (!v) { fail(''); return; }
      btn.disabled = true;
      signIn(v).then(function (r) {
        btn.disabled = false;
        if (r.ok) unlock();
        else fail(r.err);
      });
    });

    try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
  }

  function lock() {
    if (locked) return;
    locked = true;
    root.classList.add('pl3y-locked');
    whenBody(build);
  }

  function unlock() {
    put(K_LAST, Date.now());
    locked = false;
    setInert(false);
    if (gate) { gate.remove(); gate = null; }
    root.classList.remove('pl3y-locked');
    document.dispatchEvent(new CustomEvent('pl3y:unlock'));
  }

  function check() {
    if (!locked && !valid()) lock();
  }

  // Każdy klik/dotyk/klawisz: przy zablokowanej stronie nie przepuszczamy go dalej,
  // przy wygasłej sesji blokujemy, a przy ważnej odświeżamy pl3y_last (maks. co 30 s).
  function guard(e) {
    if (!locked) {
      if (!valid()) lock();
      else {
        if (Date.now() - Number(get(K_LAST)) >= TOUCH_MS) put(K_LAST, Date.now());
        if (wantsRefresh()) refreshToken();
      }
    }
    if (locked && !(gate && gate.contains(e.target))) {
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  ['pointerdown', 'touchstart', 'click', 'keydown'].forEach(function (t) {
    window.addEventListener(t, guard, { capture: true, passive: false });
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    check();
    if (!locked && NO_IDLE && wantsRefresh()) refreshToken();
  });
  window.addEventListener('pageshow', check);            // powrót przyciskiem „Wstecz”
  window.addEventListener('storage', function () {       // hasło wpisane w innej karcie
    if (locked && valid()) unlock();
  });
  // Co minutę: sprawdzenie sesji; telefony (bez bezczynności) przedłużają token same, bo mogą nie dotykać ekranu godzinami.
  setInterval(function () {
    check();
    if (!locked && NO_IDLE && wantsRefresh()) refreshToken();
  }, TICK_MS);

  // Start: wejście na stronę z ważną sesją liczy się jako aktywność.
  if (valid()) { put(K_LAST, Date.now()); if (wantsRefresh()) refreshToken(); }
  else lock();

  /* =====================================================================================================
   * GRACZ: nick + 4-cyfrowy PIN + awatar (bez kont i e-maili). Ekran pojawia się po haśle, raz na urządzenie.
   * localStorage "pl3y_player" = {"n","nick","avatar","pt"} (pt = token gracza z serwera, wysyłany przez gry
   * w treści zapytań jako pole pt albo w ?pt= przy WebSocket); "pl3y_player_skip" = "1" po „Graj bez nicka”.
   * Serwer: POST /api/pl/check|claim|login|me|avatar|reset-request (Worker pl3y-server, players.js).
   * Po zalogowaniu na document leci zdarzenie "pl3y:player" (detail = gracz).
   * ===================================================================================================== */
  var K_PLAYER = 'pl3y_player';
  var K_SKIP = 'pl3y_player_skip';
  var AVATARS = 10;
  function avatarUrl(i) { return '/img/avatars/' + i + '.svg'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function getPlayer() {
    try { var p = JSON.parse(get(K_PLAYER) || 'null'); return p && p.pt && p.nick ? p : null; } catch (e) { return null; }
  }
  function setPlayer(p) {
    put(K_PLAYER, JSON.stringify({ n: p.n, nick: p.nick, avatar: p.avatar || 0, pt: p.pt }));
    drop(K_SKIP);
    document.dispatchEvent(new CustomEvent('pl3y:player', { detail: getPlayer() }));
  }

  // POST do serwera z tokenem sesji. Zwraca obiekt odpowiedzi z polem _status (0 = brak sieci).
  function plApi(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (get(K_TOKEN) || '') },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        j = j || {}; j._status = r.status;
        if (r.status === 401 && j.code === 'auth') { drop(K_TOKEN); drop(K_EXP); drop(K_KIND); lock(); }
        return j;
      });
    }, function () { return { _status: 0, err: 'Brak połączenia z serwerem' }; });
  }

  var PCSS =
    'html.pl3y-pl-open body{overflow:hidden}' +
    'html.pl3y-pl-open body>:not(#pl3y-pl):not(#pl3y-gate){filter:blur(10px) brightness(.5);pointer-events:none;user-select:none}' +
    '#pl3y-pl{position:fixed;inset:0;z-index:2147482990;display:grid;place-items:center;padding:20px;overflow:auto;' +
      'background:radial-gradient(ellipse at 50% 45%,rgba(28,24,19,.78),rgba(12,11,9,.95) 70%);color:#EFE8D8;' +
      'font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;animation:pl3y-in .35s ease both}' +
    '#pl3y-pl *{box-sizing:border-box}' +
    '#pl3y-pl .pp-box{width:min(340px,100%);display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}' +
    '#pl3y-pl .pp-mark{width:56px;height:56px;filter:drop-shadow(0 0 14px rgba(233,196,106,.3))}' +
    '#pl3y-pl .pp-k{font:500 11px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.3em;text-transform:uppercase;color:#A39C8C}' +
    '#pl3y-pl h2{margin:0;font:600 30px/1.15 "Cormorant Garamond",Georgia,serif;color:#EFE8D8}' +
    '#pl3y-pl h2 b{color:#E3C77F;font-weight:600}' +
    '#pl3y-pl .pp-sub{margin:-4px 0 0;font-size:14px;line-height:1.45;color:#A39C8C}' +
    '#pl3y-pl .pp-input{width:100%;height:54px;padding:0 18px;background:rgba(12,11,9,.75);border:1px solid rgba(201,168,92,.35);border-radius:12px;' +
      'color:#EFE8D8;font:600 19px/1 Inter,system-ui,sans-serif;text-align:center;outline:none}' +
    '#pl3y-pl .pp-input:focus{border-color:#C9A85C;box-shadow:0 0 0 3px rgba(201,168,92,.2)}' +
    '#pl3y-pl .pp-btn{width:100%;height:52px;border:0;border-radius:999px;background:#C9A85C;color:#0C0B09;cursor:pointer;' +
      'font:600 13px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.28em;text-transform:uppercase;padding-left:.28em}' +
    '#pl3y-pl .pp-btn:disabled{opacity:.5;cursor:default}' +
    '#pl3y-pl .pp-link{border:0;background:none;color:#A39C8C;font:500 13px/1.4 Inter,system-ui,sans-serif;text-decoration:underline;text-underline-offset:3px;cursor:pointer;padding:4px}' +
    '#pl3y-pl .pp-err{min-height:1.3em;margin:0;font:500 12px/1.35 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.08em;color:#D9786C}' +
    '#pl3y-pl .pp-dots{display:flex;gap:16px;margin:4px 0}' +
    '#pl3y-pl .pp-dots i{width:16px;height:16px;border-radius:50%;border:2px solid #C9A85C;transition:background .12s,transform .12s}' +
    '#pl3y-pl .pp-dots i.on{background:#C9A85C;transform:scale(1.1)}' +
    '#pl3y-pl .pp-pad{display:grid;grid-template-columns:repeat(3,72px);gap:12px;justify-content:center}' +
    '#pl3y-pl .pp-pad button{height:64px;border-radius:50%;border:1px solid rgba(201,168,92,.35);background:rgba(23,20,15,.85);color:#EFE8D8;' +
      'font:600 24px/1 Inter,system-ui,sans-serif;cursor:pointer;touch-action:manipulation;transition:background .1s,transform .08s}' +
    '#pl3y-pl .pp-pad button:active{background:rgba(201,168,92,.3);transform:scale(.94)}' +
    '#pl3y-pl .pp-pad button.pp-x{border-color:transparent;background:none;font-size:20px;color:#A39C8C}' +
    '#pl3y-pl .pp-pad .pp-blank{visibility:hidden}' +
    '#pl3y-pl .pp-note{margin:0;padding:10px 12px;border-radius:10px;border:1px dashed rgba(201,168,92,.35);font-size:12px;line-height:1.45;color:#A39C8C}' +
    '#pl3y-pl .pp-check{display:flex;align-items:center;gap:10px;font-size:15px;cursor:pointer;user-select:none}' +
    '#pl3y-pl .pp-check input{width:20px;height:20px;accent-color:#C9A85C}' +
    '#pl3y-pl .pp-car{display:flex;align-items:center;gap:14px}' +
    '#pl3y-pl .pp-car button{width:44px;height:44px;border-radius:50%;border:1px solid rgba(201,168,92,.35);background:rgba(23,20,15,.85);color:#E3C77F;font-size:22px;cursor:pointer}' +
    '#pl3y-pl .pp-av{width:132px;height:132px;border-radius:50%;overflow:hidden;border:2px solid #C9A85C;box-shadow:0 0 30px rgba(201,168,92,.25);background:#221D15;' +
      'display:grid;place-items:center;font:600 44px/1 "JetBrains Mono",monospace;color:#C9A85C;touch-action:pan-y}' +
    '#pl3y-pl .pp-av img{width:100%;height:100%;object-fit:cover;display:block}' +
    '#pl3y-pl .pp-strip{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}' +
    '#pl3y-pl .pp-strip button{width:12px;height:12px;padding:0;border-radius:50%;border:0;background:rgba(201,168,92,.3);cursor:pointer}' +
    '#pl3y-pl .pp-strip button.on{background:#E3C77F}' +
    '#pl3y-pl .pp-shake{animation:pl3y-shake .42s cubic-bezier(.36,.07,.19,.97) both}' +
    '@media (prefers-reduced-motion:reduce){#pl3y-pl,#pl3y-pl .pp-shake{animation:none}}';
  var pstyle = document.createElement('style');
  pstyle.textContent = PCSS;
  (document.head || root).appendChild(pstyle);

  var pl = null;          // stan otwartego ekranu gracza
  var plEl = null;
  var waiters = [];       // obietnice z PL3Y.player.ask()

  function plOpen(opts) {
    opts = opts || {};
    if (plEl) { if (opts.msg) { pl.msg = opts.msg; plRender(); } return; }
    pl = { step: 'nick', nick: opts.nick || '', n: '', exists: false, needPin: false, pin: '', first: '', avatarOn: true, avatar: 1,
      err: '', msg: opts.msg || '', busy: false, left: null };
    loadFonts();
    plEl = document.createElement('div');
    plEl.id = 'pl3y-pl';
    plEl.setAttribute('role', 'dialog');
    plEl.setAttribute('aria-modal', 'true');
    document.body.appendChild(plEl);
    root.classList.add('pl3y-pl-open');
    plInert(true);
    plEl.addEventListener('click', plClick);
    plEl.addEventListener('submit', function (e) { e.preventDefault(); plAct('nick'); });
    document.addEventListener('keydown', plKey, true);
    plRender();
  }
  function plClose(player) {
    if (!plEl) return;
    plEl.remove(); plEl = null; pl = null;
    root.classList.remove('pl3y-pl-open');
    plInert(false);
    document.removeEventListener('keydown', plKey, true);
    var w = waiters; waiters = [];
    w.forEach(function (f) { f(player || null); });
  }
  function plInert(on) {
    var kids = document.body ? document.body.children : [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el === plEl || el === gate) continue;
      if (on && !el.hasAttribute('inert')) { el.setAttribute('inert', ''); el.setAttribute('data-pl3y-pinert', ''); }
      else if (!on && el.hasAttribute('data-pl3y-pinert')) { el.removeAttribute('inert'); el.removeAttribute('data-pl3y-pinert'); }
    }
  }

  function avatarHtml(i) {
    return i ? '<img src="' + avatarUrl(i) + '" alt="Awatar ' + i + '" onerror="this.replaceWith(document.createTextNode(\'' + i + '\'))">' : '?';
  }
  function padHtml() {
    var h = '<div class="pp-dots" aria-hidden="true">';
    for (var i = 0; i < 4; i++) h += '<i class="' + (i < pl.pin.length ? 'on' : '') + '"></i>';
    h += '</div><div class="pp-pad">';
    [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(function (d) { h += '<button type="button" data-d="' + d + '">' + d + '</button>'; });
    h += '<button type="button" class="pp-blank" tabindex="-1" aria-hidden="true"></button><button type="button" data-d="0">0</button>' +
      '<button type="button" class="pp-x" data-a="del" aria-label="Usuń cyfrę">⌫</button></div>';
    return h;
  }

  function plRender() {
    if (!plEl) return;
    var s = pl, h = '<div class="pp-box">';
    var top = '<img class="pp-mark" src="/mark.svg" alt="" aria-hidden="true">';
    if (s.step === 'nick') {
      h += top + '<div class="pp-k">Gracz</div><h2>Kim jesteś?</h2>' +
        (s.msg ? '<p class="pp-sub">' + esc(s.msg) + '</p>' : '<p class="pp-sub">Nick zapisuje Twoje wyniki w rankingach PL3Y.</p>') +
        '<form style="display:contents" novalidate><input class="pp-input" id="pp-nick" maxlength="16" placeholder="Twój nick" autocomplete="nickname"' +
        ' autocapitalize="words" spellcheck="false" enterkeyhint="go" value="' + esc(s.nick) + '">' +
        '<button class="pp-btn" type="submit" ' + (s.busy ? 'disabled' : '') + '>Dalej</button></form>' +
        '<p class="pp-err" role="alert">' + esc(s.err) + '</p>' +
        '<button type="button" class="pp-link" data-a="skip">Graj bez nicka (bez rankingu)</button>';
    } else if (s.step === 'newpin' || s.step === 'confirm') {
      h += '<div class="pp-k">' + (s.needPin ? 'Nowy PIN' : 'Nowy gracz') + '</div>' +
        '<h2>' + (s.step === 'newpin' ? 'Ustaw PIN dla <b>' + esc(s.nick) + '</b>' : 'Powtórz PIN') + '</h2>' +
        (s.step === 'newpin' ? '<p class="pp-note">To tylko gra: nie wpisuj PIN-u do karty ani telefonu. Chroni Twój nick, żeby nikt nie podpisał się nim w rankingu.</p>' : '') +
        padHtml() + '<p class="pp-err" role="alert">' + esc(s.err) + '</p>' +
        '<button type="button" class="pp-link" data-a="back">← Inny nick</button>';
    } else if (s.step === 'pin') {
      h += '<div class="pp-k">Witaj ponownie</div><h2>Siema <b>' + esc(s.nick) + '</b>!</h2><p class="pp-sub">Podaj swój PIN.</p>' +
        padHtml() + '<p class="pp-err" role="alert">' + esc(s.err) + '</p>' +
        '<button type="button" class="pp-link" data-a="forgot">Nie pamiętam PIN-u</button>' +
        '<button type="button" class="pp-link" data-a="back">← To nie ja, inny nick</button>';
    } else if (s.step === 'avatar') {
      h += '<div class="pp-k">Ostatni krok</div><h2>Awatar</h2>' +
        '<label class="pp-check"><input type="checkbox" id="pp-avon" ' + (s.avatarOn ? 'checked' : '') + '> Chcę ustawić awatar</label>';
      if (s.avatarOn) {
        h += '<div class="pp-car"><button type="button" data-a="prev" aria-label="Poprzedni">‹</button>' +
          '<div class="pp-av" id="pp-av">' + avatarHtml(s.avatar) + '</div>' +
          '<button type="button" data-a="next" aria-label="Następny">›</button></div><div class="pp-strip">';
        for (var i = 1; i <= AVATARS; i++) h += '<button type="button" class="' + (i === s.avatar ? 'on' : '') + '" data-av="' + i + '" aria-label="Awatar ' + i + '"></button>';
        h += '</div>';
      }
      h += '<button type="button" class="pp-btn" data-a="done" ' + (s.busy ? 'disabled' : '') + '>Gotowe</button><p class="pp-err" role="alert">' + esc(s.err) + '</p>';
    } else if (s.step === 'sent') {
      h += top + '<div class="pp-k">Reset PIN-u</div><h2>Prośba wysłana</h2>' +
        '<p class="pp-sub">Admin dostał wiadomość. Gdy zresetuje PIN, przy następnym wejściu ustawisz nowy.</p>' +
        '<button type="button" class="pp-btn" data-a="back">Inny nick</button>' +
        '<button type="button" class="pp-link" data-a="skip">Na razie graj bez nicka</button>';
    }
    plEl.innerHTML = h + '</div>';
    var inp = plEl.querySelector('#pp-nick');
    if (inp) { try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); } }
    var av = plEl.querySelector('#pp-av');
    if (av) swipe(av);
    var cb = plEl.querySelector('#pp-avon');
    if (cb) cb.addEventListener('change', function () { pl.avatarOn = cb.checked; plRender(); });
  }

  // przesuwanie palcem po awatarze = karuzela
  function swipe(elm) {
    var x0 = null;
    elm.addEventListener('pointerdown', function (e) { x0 = e.clientX; });
    elm.addEventListener('pointerup', function (e) {
      if (x0 == null) return;
      var dx = e.clientX - x0; x0 = null;
      if (Math.abs(dx) > 30) plAct(dx < 0 ? 'next' : 'prev');
    });
  }

  function plShake() {
    var d = plEl && plEl.querySelector('.pp-dots, .pp-input');
    if (!d) return;
    d.classList.remove('pp-shake'); void d.offsetWidth; d.classList.add('pp-shake');
  }
  function plFail(msg) { pl.err = msg || ''; pl.busy = false; pl.pin = ''; plRender(); plShake(); }

  function plClick(e) {
    var b = e.target.closest('button');
    if (!b || !pl) return;
    if (b.hasAttribute('data-d')) return plDigit(b.getAttribute('data-d'));
    if (b.hasAttribute('data-av')) { pl.avatar = Number(b.getAttribute('data-av')); return plRender(); }
    if (b.getAttribute('data-a')) plAct(b.getAttribute('data-a'));
  }
  function plKey(e) {
    if (!pl || locked) return;
    if (/^(pin|newpin|confirm)$/.test(pl.step)) {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); plDigit(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); plAct('del'); }
    } else if (pl.step === 'avatar' && pl.avatarOn) {
      if (e.key === 'ArrowRight') plAct('next'); else if (e.key === 'ArrowLeft') plAct('prev');
    }
  }
  function plDigit(d) {
    if (pl.busy || pl.pin.length >= 4) return;
    pl.pin += d; pl.err = '';
    plRender();
    if (pl.pin.length === 4) setTimeout(plPinDone, 120);
  }

  function plPinDone() {
    var s = pl;
    if (!s) return;
    if (s.step === 'newpin') { s.first = s.pin; s.pin = ''; s.step = 'confirm'; return plRender(); }
    if (s.step === 'confirm') {
      if (s.pin !== s.first) { s.step = 'newpin'; s.first = ''; return plFail('PIN-y się różnią. Ustaw jeszcze raz.'); }
      s.step = 'avatar'; s.avatarOn = !s.needPin || !!s.avatar; return plRender();
    }
    if (s.step === 'pin') {
      s.busy = true;
      plApi('/api/pl/login', { nick: s.nick, pin: s.pin }).then(function (j) {
        if (!pl) return;
        if (j._status === 200 && j.pt) { setPlayer(j); return plClose(getPlayer()); }
        if (j.code === 'needpin') { pl.needPin = true; pl.step = 'newpin'; return plFail('Admin zresetował PIN. Ustaw nowy.'); }
        if (j.code === 'badpin') return plFail('Zły PIN' + (j.left ? ' (zostało prób: ' + j.left + ')' : ''));
        plFail(j.err || 'Nie udało się. Spróbuj jeszcze raz.');
      });
    }
  }

  function plAct(a) {
    var s = pl;
    if (!s) return;
    if (a === 'nick') {
      var inp = plEl.querySelector('#pp-nick');
      s.nick = (inp ? inp.value : s.nick).replace(/\s+/g, ' ').trim();
      if (s.nick.length < 2) return plFail('Nick musi mieć co najmniej 2 znaki.');
      s.busy = true; s.err = ''; plRender();
      plApi('/api/pl/check', { nick: s.nick }).then(function (j) {
        if (!pl) return;
        pl.busy = false;
        if (j._status !== 200) return plFail(j.err || 'Serwer niedostępny.');
        pl.n = j.n; pl.exists = !!j.exists; pl.needPin = !!j.needPin; pl.pin = ''; pl.first = '';
        if (j.exists) { pl.nick = j.nick; pl.avatar = j.avatar || 1; }
        pl.step = !j.exists || j.needPin ? 'newpin' : 'pin';
        pl.err = j.needPin ? 'Admin zresetował Twój PIN. Ustaw nowy.' : '';
        plRender();
      });
    } else if (a === 'del') { s.pin = s.pin.slice(0, -1); plRender(); }
    else if (a === 'back') { s.step = 'nick'; s.pin = ''; s.err = ''; s.msg = ''; plRender(); }
    else if (a === 'skip') { put(K_SKIP, '1'); plClose(null); }
    else if (a === 'prev' || a === 'next') { s.avatar = ((s.avatar - 1 + (a === 'next' ? 1 : AVATARS - 1)) % AVATARS) + 1; plRender(); }
    else if (a === 'forgot') {
      s.busy = true;
      plApi('/api/pl/reset-request', { nick: s.nick }).then(function (j) {
        if (!pl) return;
        pl.busy = false;
        if (j._status !== 200) return plFail(j.err || 'Nie udało się wysłać prośby.');
        pl.step = 'sent'; plRender();
      });
    } else if (a === 'done') {
      s.busy = true; plRender();
      plApi('/api/pl/claim', { nick: s.nick, pin: s.first, avatar: s.avatarOn ? s.avatar : 0 }).then(function (j) {
        if (!pl) return;
        if (j._status === 200 && j.pt) { setPlayer(j); return plClose(getPlayer()); }
        if (j.code === 'taken') { pl.step = 'nick'; return plFail('Ktoś właśnie zajął ten nick. Wybierz inny.'); }
        plFail(j.err || 'Nie udało się zapisać. Spróbuj jeszcze raz.');
      });
    }
  }

  // Kiedy pokazać ekran gracza: po haśle, gdy urządzenie nie ma gracza i nie wybrano „bez nicka”.
  function plMaybe() {
    if (locked || plEl || getPlayer() || get(K_SKIP)) return;
    whenBody(function () { plOpen(); });
  }
  document.addEventListener('pl3y:unlock', plMaybe);
  // Raz na sesję karty: sprawdź token gracza (PIN mógł zostać zresetowany) i odśwież nick/awatar.
  function plVerify() {
    var p = getPlayer();
    if (!p || locked) return;
    try { if (sessionStorage.getItem('pl3y_pchk') === p.pt) return; } catch (e) {}
    plApi('/api/pl/me', { pt: p.pt }).then(function (j) {
      if (j._status === 200 && j.nick) {
        try { sessionStorage.setItem('pl3y_pchk', p.pt); } catch (e) {}
        if (j.nick !== p.nick || (j.avatar || 0) !== (p.avatar || 0)) setPlayer({ n: j.n, nick: j.nick, avatar: j.avatar, pt: p.pt });
      } else if (j._status === 401 && j.code === 'player') {
        drop(K_PLAYER);
        whenBody(function () { plOpen({ nick: p.nick, msg: 'Twój PIN został zresetowany albo zmieniony. Zaloguj się jeszcze raz.' }); });
      }
    });
  }
  if (!locked) { whenBody(function () { plMaybe(); plVerify(); }); }
  document.addEventListener('pl3y:unlock', plVerify);

  window.PL3Y = {
    isLocked: function () { return locked; },
    lock: lock,
    // Adres serwera PL3Y (dla gier, które pytają serwer same).
    api: API,
    // Ważny token do wysłania na serwer ('' gdy brak/wygasł).
    token: function () { return tokenOk() ? get(K_TOKEN) : ''; },
    // Wymusza przedłużenie i oddaje token (do ponowienia zapytania po odpowiedzi 401).
    refresh: function () { return refreshToken().then(function () { return tokenOk() ? get(K_TOKEN) : ''; }); },
    // Serwer odrzucił token (401): usuń go i pokaż bramkę.
    expired: function () { drop(K_TOKEN); drop(K_EXP); drop(K_KIND); lock(); },
    avatarUrl: avatarUrl,
    player: {
      // { n, nick, avatar, pt } albo null
      get: getPlayer,
      // Otwiera ekran gracza (np. przed rankingiem). Obietnica: gracz albo null (pominięte).
      ask: function (opts) {
        var p = getPlayer();
        if (p) return Promise.resolve(p);
        return new Promise(function (res) { waiters.push(res); whenBody(function () { plOpen(opts); }); });
      },
      // „Zmień gracza”: wylogowanie nicka na tym urządzeniu i ekran od nowa.
      change: function () { drop(K_PLAYER); drop(K_SKIP); return window.PL3Y.player.ask(); },
      // Serwer odrzucił token gracza (401, code "player"): ekran od nowa z komunikatem.
      expired: function () {
        var p = getPlayer(); drop(K_PLAYER);
        return window.PL3Y.player.ask({ nick: p ? p.nick : '', msg: 'Zaloguj się jeszcze raz swoim PIN-em.' });
      },
      setAvatar: function (i) {
        var p = getPlayer();
        if (!p) return Promise.resolve(null);
        return plApi('/api/pl/avatar', { pt: p.pt, avatar: i }).then(function (j) {
          if (j._status === 200) { p.avatar = j.avatar; setPlayer(p); return p; }
          return null;
        });
      }
    }
  };
})();
