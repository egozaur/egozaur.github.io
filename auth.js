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

  window.PL3Y = {
    isLocked: function () { return locked; },
    lock: lock,
    // Ważny token do wysłania na serwer ('' gdy brak/wygasł).
    token: function () { return tokenOk() ? get(K_TOKEN) : ''; },
    // Wymusza przedłużenie i oddaje token (do ponowienia zapytania po odpowiedzi 401).
    refresh: function () { return refreshToken().then(function () { return tokenOk() ? get(K_TOKEN) : ''; }); },
    // Serwer odrzucił token (401): usuń go i pokaż bramkę.
    expired: function () { drop(K_TOKEN); drop(K_EXP); drop(K_KIND); lock(); }
  };
})();
