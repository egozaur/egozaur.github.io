/*
 * PL3Y – wspólna bramka hasła dla całej domeny pl3y.pl (lobby i gry).
 *
 * UWAGA: to zamek dla znajomych, NIE prawdziwe zabezpieczenie. Strona jest
 * statyczna, więc każdy, kto zajrzy w kod, może bramkę obejść.
 *
 * Kontrakt (opisany też w CLAUDE.md – nie zmieniaj bez aktualizacji gier):
 *   localStorage "pl3y_auth" = SHA-256 (hex) poprawnego hasła,
 *   localStorage "pl3y_last" = znacznik czasu (ms) ostatniej aktywności.
 *   Bramka wraca, gdy: brak pl3y_auth, pl3y_auth ≠ PASS_HASH (zmiana hasła)
 *   albo od pl3y_last minęło ponad 30 min.
 *   Aktywność (klik, dotyk, klawisz) odświeża pl3y_last maks. raz na 30 s.
 *   Sprawdzenie także przy powrocie do karty (visibilitychange) i co minutę.
 *
 * Użycie w grze: <script src="/auth.js"></script> w <head> (bez defer).
 * Strony graczy (telefony z QR): <script src="/auth.js" data-no-idle></script>
 *   – liczy się tylko pl3y_auth, bez 30-min wygasania.
 * Po wpisaniu hasła na document leci zdarzenie "pl3y:unlock".
 */
(function () {
  'use strict';

  // Skrót SHA-256 (hex) hasła – NIGDY nie wpisuj tu jawnego hasła.
  var PASS_HASH = '378fb5e997833a16bb5ded5e2cef2b6646cb7c88a3dbe1a4956c4b02b40deb8c';

  var K_AUTH = 'pl3y_auth';
  var K_LAST = 'pl3y_last';
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

  function valid() {
    if (get(K_AUTH) !== PASS_HASH) return false;
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

  function sha256(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
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
      if (!(window.crypto && crypto.subtle && window.TextEncoder)) {
        fail('Wymagane połączenie HTTPS');
        return;
      }
      sha256(v).then(function (h) {
        if (h === PASS_HASH) unlock();
        else fail('Złe hasło');
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
    put(K_AUTH, PASS_HASH);
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
      else if (Date.now() - Number(get(K_LAST)) >= TOUCH_MS) put(K_LAST, Date.now());
    }
    if (locked && !(gate && gate.contains(e.target))) {
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  ['pointerdown', 'touchstart', 'click', 'keydown'].forEach(function (t) {
    window.addEventListener(t, guard, { capture: true, passive: false });
  });

  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  window.addEventListener('pageshow', check);            // powrót przyciskiem „Wstecz”
  window.addEventListener('storage', function () {       // hasło wpisane w innej karcie
    if (locked && valid()) unlock();
  });
  setInterval(check, TICK_MS);

  // Start: wejście na stronę z ważną sesją liczy się jako aktywność.
  if (valid()) put(K_LAST, Date.now());
  else lock();

  window.PL3Y = {
    isLocked: function () { return locked; },
    lock: lock
  };
})();
