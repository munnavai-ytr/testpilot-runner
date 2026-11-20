/*! TestPilot SDK v1.0.0
 *  Lets TestPilot Studio drive this page while it runs inside the Studio iframe.
 *  The SDK is inert unless the page is embedded AND opened with the Studio pairing token
 *  AND the messages come from an allowed Studio origin.
 *  Add it as early as possible in <head>:
 *  <script src="https://cdn.jsdelivr.net/gh/munnavai-ytr/testpilot-runner@main/sdk/testpilot-sdk.js"
 *          data-tp-origin="https://testpilot-ts.vercel.app"></script>
 */
(function () {
  'use strict';
  if (window.__TESTPILOT_SDK__) return;

  var VERSION = '1.0.0';
  var script = document.currentScript;
  var originAttr = (script && script.getAttribute('data-tp-origin')) || 'https://testpilot-ts.vercel.app';
  var ALLOWED = originAttr.split(',').map(function (s) { return s.trim().replace(/\/+$/, ''); }).filter(Boolean);

  // ---------- pairing (inert unless embedded with a token) ----------
  var SID_KEY = '__tp_sid';
  var sid = null;
  try {
    var m = /^#__tp=([A-Za-z0-9_-]{16,128})$/.exec(window.location.hash);
    if (m) {
      sid = m[1];
      sessionStorage.setItem(SID_KEY, sid);
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } else {
      sid = sessionStorage.getItem(SID_KEY);
    }
  } catch (e) { sid = null; }
  if (!sid || window.parent === window) return;
  window.__TESTPILOT_SDK__ = { version: VERSION };

  // ---------- helpers ----------
  function now() { return Date.now(); }
  function short(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > (n || 200) ? s.slice(0, n || 200) + '...' : s; }
  function push(arr, item) { arr.push(item); if (arr.length > 100) arr.shift(); }
  function fmt(v) {
    try {
      if (v instanceof Error) return short(v.message + (v.stack ? ' | ' + v.stack.split('\n')[1] : ''), 300);
      if (typeof v === 'object') return short(JSON.stringify(v), 300);
      return short(v, 300);
    } catch (e) { return '[unprintable]'; }
  }
  function fmtArgs(args) { var out = []; for (var i = 0; i < args.length; i++) out.push(fmt(args[i])); return short(out.join(' '), 400); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------- evidence ----------
  var ev = { consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], brokenResources: [], longTasks: 0, cls: 0, lcp: null, fcp: null };
  var pending = 0, lastNet = now(), lastMutation = now();

  ['error', 'warn'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      try { push(level === 'error' ? ev.consoleErrors : ev.consoleWarnings, fmtArgs(arguments)); } catch (e) {}
      return orig.apply(this, arguments);
    };
  });
  window.addEventListener('error', function (e) {
    try {
      var t = e.target;
      if (t && t !== window && t.tagName) {
        push(ev.brokenResources, t.tagName.toLowerCase() + ' ' + short(t.currentSrc || t.src || t.href || '', 200));
      } else {
        push(ev.pageErrors, short((e.message || 'error') + (e.filename ? ' at ' + e.filename.split('/').pop() + ':' + e.lineno : ''), 300));
      }
    } catch (x) {}
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    try { push(ev.pageErrors, 'Unhandled promise rejection: ' + fmt(e.reason)); } catch (x) {}
  });

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      pending++; lastNet = now();
      return origFetch.apply(this, arguments).then(function (res) {
        pending--; lastNet = now();
        if (res && res.status >= 400) push(ev.failedRequests, method + ' ' + short(url, 160) + ' -> ' + res.status);
        return res;
      }, function (err) {
        pending--; lastNet = now();
        push(ev.failedRequests, method + ' ' + short(url, 160) + ' -> network error');
        throw err;
      });
    };
  }
  var XO = window.XMLHttpRequest && XMLHttpRequest.prototype.open;
  var XS = window.XMLHttpRequest && XMLHttpRequest.prototype.send;
  if (XO && XS) {
    XMLHttpRequest.prototype.open = function (method, url) { this.__tp = { method: method, url: url }; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this; pending++; lastNet = now();
      xhr.addEventListener('loadend', function () {
        pending--; lastNet = now();
        var info = xhr.__tp || {};
        if (xhr.status === 0) push(ev.failedRequests, (info.method || 'GET') + ' ' + short(info.url, 160) + ' -> network error');
        else if (xhr.status >= 400) push(ev.failedRequests, (info.method || 'GET') + ' ' + short(info.url, 160) + ' -> ' + xhr.status);
      });
      return XS.apply(this, arguments);
    };
  }

  function observe(type, cb) {
    try { new PerformanceObserver(function (list) { list.getEntries().forEach(cb); }).observe({ type: type, buffered: true }); } catch (e) {}
  }
  observe('largest-contentful-paint', function (e) { ev.lcp = Math.round(e.startTime); });
  observe('layout-shift', function (e) { if (!e.hadRecentInput) ev.cls = Math.round((ev.cls + e.value) * 1000) / 1000; });
  observe('longtask', function () { ev.longTasks++; });
  observe('paint', function (e) { if (e.name === 'first-contentful-paint') ev.fcp = Math.round(e.startTime); });

  try {
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var t = list[i].target;
        if (t && t.nodeType === 1 && t.closest && t.closest('#__tp_overlay')) continue;
        lastMutation = now(); return;
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  } catch (e) {}

  // ---------- element helpers ----------
  var INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio],[role=option],[role=combobox],[onclick],[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  var DANGER = /(\bdelete\b|\bremove\b|\bdestroy\b|\berase\b|\breset\b|clear all|\bpay\b|\bbuy\b|purchase|checkout|place order|\bsubscribe\b|unsubscribe|cancel (my )?(subscription|plan|account)|deactivate|log ?out|sign ?out|\bconfirm\b|মুছ|ডিলিট|কিনু|পেমেন্ট|লগ ?আউট)/i;
  var lastIndex = [];

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.01) return false;
    return true;
  }
  function textOf(el) { return short(el.innerText || el.textContent || '', 80); }
  function nameOf(el) {
    var v;
    var lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      var parts = lb.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ''; });
      v = short(parts.join(' '), 80); if (v) return v;
    }
    v = el.getAttribute && el.getAttribute('aria-label'); if (v) return short(v, 80);
    if (el.id) {
      var lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (lab) { v = short(lab.textContent, 80); if (v) return v; }
    }
    var wrap = el.closest && el.closest('label');
    if (wrap) { v = short(wrap.textContent, 80); if (v) return v; }
    v = el.getAttribute && el.getAttribute('title'); if (v) return short(v, 80);
    v = el.getAttribute && el.getAttribute('alt'); if (v) return short(v, 80);
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) return short(el.value, 80);
    v = textOf(el); if (v) return v;
    v = el.getAttribute && el.getAttribute('placeholder'); if (v) return short(v, 80);
    var img = el.querySelector && el.querySelector('img[alt]'); if (img) return short(img.getAttribute('alt'), 80);
    return '';
  }
  function roleOf(el) {
    var r = el.getAttribute && el.getAttribute('role'); if (r) return r;
    var t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      var ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (/^(button|submit|reset|image)$/.test(ty)) return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }
  function describe(el) {
    if (!el || !el.tagName) return '';
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    var tx = textOf(el);
    return tx ? s + ' "' + short(tx, 40) + '"' : s;
  }

  function collect(max) {
    var seen = new Set(), list = [];
    var nodes = document.querySelectorAll(INTERACTIVE);
    for (var i = 0; i < nodes.length; i++) { if (!seen.has(nodes[i])) { seen.add(nodes[i]); list.push(nodes[i]); } }
    var cand = document.querySelectorAll('div,span,li,img,svg,p');
    var scanned = 0;
    for (var j = 0; j < cand.length && scanned < 1500; j++) {
      var c = cand[j]; scanned++;
      if (seen.has(c)) continue;
      try {
        if (window.getComputedStyle(c).cursor === 'pointer' && (c.parentElement && window.getComputedStyle(c.parentElement).cursor !== 'pointer' || !c.parentElement)) {
          seen.add(c); list.push(c);
        }
      } catch (e) {}
    }
    var out = [];
    for (var k = 0; k < list.length; k++) { if (isVisible(list[k])) out.push(list[k]); }
    var vh = window.innerHeight;
    var inView = [], outView = [];
    out.forEach(function (el) { var r = el.getBoundingClientRect(); (r.bottom > 0 && r.top < vh ? inView : outView).push(el); });
    return { all: inView.concat(outView), total: out.length, inViewCount: inView.length };
  }

  function snapshot(args) {
    var max = (args && args.maxElements) || 80;
    var c = collect(max);
    lastIndex = c.all.slice(0, max);
    var vh = window.innerHeight;
    var elements = lastIndex.map(function (el, i) {
      var r = el.getBoundingClientRect();
      var nm = nameOf(el);
      var type = el.tagName === 'INPUT' ? (el.type || 'text') : undefined;
      var val;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        val = type === 'password' ? (el.value ? '********' : '') : short(el.value, 80);
        if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) val = short(el.selectedOptions[0].text, 60);
      }
      var o = {
        i: i, tag: el.tagName.toLowerCase(), role: roleOf(el), name: nm,
        inView: r.bottom > 0 && r.top < vh,
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)
      };
      if (type) o.type = type;
      if (val !== undefined && val !== '') o.value = val;
      if (el.tagName === 'A' && el.getAttribute('href')) o.href = short(el.getAttribute('href'), 120);
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') o.disabled = true;
      if (el.checked === true) o.checked = true;
      if (el.getAttribute && el.getAttribute('aria-invalid') === 'true') o.invalid = true;
      if (el.required) o.required = true;
      if (el.tagName === 'SELECT') o.options = Array.prototype.slice.call(el.options, 0, 12).map(function (op) { return short(op.text, 40); });
      if (DANGER.test(nm + ' ' + (el.getAttribute('title') || ''))) o.danger = true;
      return o;
    });
    var headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3'))
      .filter(isVisible).slice(0, 12).map(function (h) { return h.tagName.toLowerCase() + ': ' + short(h.textContent, 80); });
    var alerts = Array.prototype.slice.call(document.querySelectorAll('[role=alert],[aria-live=assertive],.error,.errors,[class*="error"],[class*="toast"],[aria-invalid="true"]'))
      .filter(isVisible).slice(0, 6).map(function (a) { return short(a.textContent || a.getAttribute('aria-label') || '', 120); }).filter(Boolean);
    var dialogs = Array.prototype.slice.call(document.querySelectorAll('[role=dialog],[aria-modal="true"],dialog[open]'))
      .filter(isVisible).slice(0, 3).map(function (d) { return short(d.textContent, 160); });
    var text = '';
    try { text = short(document.body.innerText, 1800); } catch (e) {}
    var ae = document.activeElement;
    return {
      url: location.href, title: document.title, lang: document.documentElement.lang || '',
      viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY), scrollH: document.documentElement.scrollHeight, dpr: window.devicePixelRatio || 1 },
      elements: elements, totalInteractive: c.total, shown: elements.length,
      headings: headings, visibleAlerts: alerts, dialogs: dialogs, forms: document.forms.length,
      focused: ae && ae !== document.body ? describe(ae) : '', text: text
    };
  }

  function getEl(index) {
    var el = lastIndex[index];
    if (!el) throw new Error('unknown_index: take a new snapshot first');
    if (!document.documentElement.contains(el)) throw new Error('stale_element: the page changed, take a new snapshot');
    return el;
  }
  function center(el) { var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function scrollTo(el) { try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { el.scrollIntoView(); } }
  function fire(el, type, init, kind) {
    var Ctor = kind === 'pointer' && window.PointerEvent ? PointerEvent : MouseEvent;
    var base = { bubbles: true, cancelable: true, composed: true, view: window };
    var e = new Ctor(type, Object.assign(base, init || {}));
    el.dispatchEvent(e);
  }

  function highlight(el, label) {
    try {
      var old = document.getElementById('__tp_overlay'); if (old) old.remove();
      var r = el.getBoundingClientRect();
      var o = document.createElement('div');
      o.id = '__tp_overlay';
      o.setAttribute('aria-hidden', 'true');
      o.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #3B5BDB;border-radius:6px;background:rgba(59,91,219,.12);box-shadow:0 0 0 3px rgba(59,91,219,.25);transition:all .12s;' +
        'left:' + (r.left - 3) + 'px;top:' + (r.top - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px;';
      if (label) {
        var t = document.createElement('div');
        t.textContent = short(label, 40);
        t.style.cssText = 'position:absolute;left:0;top:-22px;background:#3B5BDB;color:#fff;font:600 11px system-ui,sans-serif;padding:2px 6px;border-radius:4px;white-space:nowrap;';
        o.appendChild(t);
      }
      document.documentElement.appendChild(o);
      setTimeout(function () { var x = document.getElementById('__tp_overlay'); if (x === o) o.remove(); }, 1400);
    } catch (e) {}
  }

  // ---------- actions ----------
  function doClick(args) {
    var el = getEl(args.index);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled', target: describe(el) };
    scrollTo(el);
    var c = center(el);
    var top = document.elementFromPoint(c.x, c.y);
    if (top && top !== el && !el.contains(top) && !top.contains(el) && !args.force) {
      return { ok: false, reason: 'covered', blockedBy: describe(top), target: describe(el) };
    }
    highlight(el, args.label || 'click');
    var init = { clientX: c.x, clientY: c.y, button: 0 };
    fire(el, 'pointerover', init, 'pointer'); fire(el, 'mouseover', init);
    fire(el, 'pointermove', init, 'pointer'); fire(el, 'mousemove', init);
    fire(el, 'pointerdown', init, 'pointer'); fire(el, 'mousedown', init);
    try { el.focus({ preventScroll: true }); } catch (e) {}
    fire(el, 'pointerup', init, 'pointer'); fire(el, 'mouseup', init);
    var before = location.href;
    if (typeof el.click === 'function') el.click(); else fire(el, 'click', init);
    return { ok: true, target: describe(el), urlBefore: before };
  }

  function setNativeValue(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  function inputEvt(el, data) {
    var e;
    try { e = new InputEvent('input', { bubbles: true, cancelable: false, composed: true, inputType: 'insertText', data: data || null }); }
    catch (x) { e = new Event('input', { bubbles: true }); }
    el.dispatchEvent(e);
  }
  function submitFrom(el) {
    var form = el.form || (el.closest && el.closest('form'));
    if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); return true; }
    return false;
  }
  function doType(args) {
    var el = getEl(args.index);
    var text = String(args.text == null ? '' : args.text);
    var tag = el.tagName;
    if (el.disabled || el.readOnly) return { ok: false, reason: 'not_editable', target: describe(el) };
    scrollTo(el);
    highlight(el, args.label || 'type');
    try { el.focus({ preventScroll: true }); } catch (e) {}
    if (el.isContentEditable && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      if (args.clear !== false) { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
      document.execCommand('insertText', false, text);
    } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
      var base = args.clear === false ? el.value : '';
      if (args.slow) {
        var cur = base;
        setNativeValue(el, cur);
        for (var i = 0; i < text.length; i++) {
          var ch = text[i];
          el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
          cur += ch; setNativeValue(el, cur); inputEvt(el, ch);
          el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        }
      } else {
        setNativeValue(el, base + text); inputEvt(el, text);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      return { ok: false, reason: 'not_a_text_field', target: describe(el) };
    }
    var submitted = false;
    if (args.submit) submitted = submitFrom(el);
    return { ok: true, target: describe(el), submitted: submitted, valueLength: (el.value || '').length };
  }
  function doSelect(args) {
    var el = getEl(args.index);
    if (el.tagName !== 'SELECT') return { ok: false, reason: 'not_a_select', target: describe(el) };
    scrollTo(el); highlight(el, args.label || 'select');
    var want = String(args.value == null ? '' : args.value).trim().toLowerCase();
    var found = null;
    for (var i = 0; i < el.options.length; i++) {
      var o = el.options[i];
      if (o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want) { found = o; break; }
    }
    if (!found) return { ok: false, reason: 'option_not_found', options: Array.prototype.slice.call(el.options, 0, 12).map(function (o) { return o.text; }) };
    setNativeValue(el, found.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: found.text };
  }
  function doCheck(args) {
    var el = getEl(args.index);
    if (!(el.type === 'checkbox' || el.type === 'radio')) return { ok: false, reason: 'not_a_checkbox', target: describe(el) };
    var want = args.checked !== false;
    if (el.checked === want) return { ok: true, unchanged: true };
    return doClick({ index: args.index, label: want ? 'check' : 'uncheck' });
  }
  function doHover(args) {
    var el = getEl(args.index); scrollTo(el); var c = center(el); highlight(el, 'hover');
    var init = { clientX: c.x, clientY: c.y };
    fire(el, 'pointerover', init, 'pointer'); fire(el, 'mouseover', init); fire(el, 'pointerenter', init, 'pointer'); fire(el, 'mouseenter', init);
    fire(el, 'pointermove', init, 'pointer'); fire(el, 'mousemove', init);
    return { ok: true, target: describe(el) };
  }
  function focusables() {
    return Array.prototype.slice.call(document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])'))
      .filter(function (e) { return !e.disabled && isVisible(e); });
  }
  function doPress(args) {
    var key = String(args.key || '');
    var target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    var codeMap = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Backspace: 'Backspace', Space: 'Space', ' ': 'Space' };
    var k = key === 'Space' ? ' ' : key;
    var init = { key: k, code: codeMap[key] || key, bubbles: true, cancelable: true, composed: true };
    var down = new KeyboardEvent('keydown', init);
    var proceed = target.dispatchEvent(down);
    if (key === 'Enter') target.dispatchEvent(new KeyboardEvent('keypress', init));
    if (proceed) {
      if (key === 'Enter') {
        var t = target.tagName;
        if (t === 'INPUT' || t === 'SELECT') submitFrom(target);
        else if (t === 'BUTTON' || t === 'A' || target.getAttribute('role') === 'button') target.click();
      } else if (key === 'Tab') {
        var list = focusables(); var idx = list.indexOf(target);
        var next = list[(idx + (args.shift ? list.length - 1 : 1)) % list.length];
        if (next) { next.focus(); highlight(next, 'focus'); }
      } else if (key === 'Escape') {
        var dlg = document.querySelector('dialog[open]'); if (dlg && dlg.close) dlg.close();
      } else if (key === ' ' || key === 'Space') {
        if (target.tagName === 'BUTTON' || (target.tagName === 'INPUT' && /^(checkbox|radio|button|submit)$/.test(target.type))) target.click();
      }
    }
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    var ae = document.activeElement;
    return { ok: true, focused: ae && ae !== document.body ? describe(ae) : '' };
  }
  function doScroll(args) {
    if (args.to === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
    else if (args.to === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    else window.scrollBy({ top: Number(args.dy) || Math.round(window.innerHeight * 0.8), behavior: 'instant' });
    return { ok: true, scrollY: Math.round(window.scrollY), scrollH: document.documentElement.scrollHeight };
  }
  function waitSettled(args) {
    var timeout = Math.min((args && args.timeout) || 4000, 15000), quiet = (args && args.quiet) || 400, t0 = now();
    return new Promise(function (resolve) {
      (function tick() {
        var t = now();
        if ((pending <= 0 && t - lastMutation >= quiet && t - lastNet >= quiet) || t - t0 >= timeout) {
          resolve({ settled: t - t0 < timeout, waitedMs: t - t0, pendingRequests: Math.max(pending, 0) });
        } else setTimeout(tick, 60);
      })();
    });
  }

  // ---------- audits ----------
  function layoutAudit() {
    var vw = window.innerWidth, issues = [];
    var docW = document.documentElement.scrollWidth;
    if (docW > vw + 1) issues.push({ rule: 'horizontal-overflow', severity: 'high', detail: 'The page is ' + docW + 'px wide but the screen is ' + vw + 'px, so users must scroll sideways.' });
    var all = document.body ? document.body.querySelectorAll('*') : [];
    var off = [], n = 0;
    for (var i = 0; i < all.length && n < 4000; i++, n++) {
      var el = all[i];
      if (!isVisible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.right > vw + 2 && r.left < vw && el.tagName !== 'HTML' && el.tagName !== 'BODY') {
        off.push(describe(el) + ' (extends ' + Math.round(r.right - vw) + 'px past the screen)');
        if (off.length >= 6) break;
      }
    }
    if (off.length) issues.push({ rule: 'elements-off-screen', severity: 'medium', detail: 'Some elements stick out past the right edge.', examples: off });
    if (vw <= 820) {
      var small = [];
      Array.prototype.slice.call(document.querySelectorAll(INTERACTIVE)).forEach(function (el) {
        if (!isVisible(el)) return; var r = el.getBoundingClientRect();
        if ((r.width < 40 || r.height < 40) && small.length < 40) small.push(describe(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      });
      if (small.length) issues.push({ rule: 'small-tap-targets', severity: 'medium', detail: small.length + ' tappable elements are smaller than about 44x44px.', examples: small.slice(0, 6) });
    }
    var tiny = [], seen = 0;
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode()) && seen < 2500) {
      seen++;
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      var p = node.parentElement; if (!p || !isVisible(p)) continue;
      var fs = parseFloat(window.getComputedStyle(p).fontSize);
      if (fs && fs < 12 && tiny.length < 40) tiny.push(describe(p) + ' ' + fs + 'px');
    }
    if (tiny.length) issues.push({ rule: 'small-text', severity: 'low', detail: tiny.length + ' text blocks are smaller than 12px.', examples: tiny.slice(0, 5) });
    return { viewport: { w: vw, h: window.innerHeight }, docWidth: docW, issues: issues };
  }
  function a11yAudit() {
    var out = [];
    function add(rule, severity, nodes, detail) { if (nodes.length) out.push({ rule: rule, severity: severity, count: nodes.length, detail: detail, examples: nodes.slice(0, 4).map(describe) }); }
    var vis = function (e) { return isVisible(e); };
    add('image-missing-alt', 'medium', Array.prototype.slice.call(document.querySelectorAll('img:not([alt])')).filter(vis), 'Images need an alt attribute (empty alt for decorative images).');
    var fields = Array.prototype.slice.call(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea')).filter(vis)
      .filter(function (e) { return !nameOf(e); });
    add('field-missing-label', 'high', fields, 'Form fields need a label or aria-label.');
    var btns = Array.prototype.slice.call(document.querySelectorAll('button,a[href],[role=button]')).filter(vis).filter(function (e) { return !nameOf(e); });
    add('control-missing-name', 'high', btns, 'Buttons and links need visible text or an aria-label.');
    var ids = {}, dups = [];
    Array.prototype.slice.call(document.querySelectorAll('[id]')).forEach(function (e) { if (ids[e.id]) dups.push(e); else ids[e.id] = 1; });
    add('duplicate-id', 'low', dups, 'The same id is used more than once.');
    if (!document.documentElement.lang) out.push({ rule: 'missing-lang', severity: 'low', count: 1, detail: 'The <html> tag has no lang attribute.', examples: [] });
    var h = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(vis);
    var h1 = h.filter(function (e) { return e.tagName === 'H1'; }).length;
    if (h1 !== 1) out.push({ rule: 'h1-count', severity: 'low', count: h1, detail: 'A page should have exactly one h1 (found ' + h1 + ').', examples: [] });
    var skip = [], prev = 0;
    h.forEach(function (e) { var lv = Number(e.tagName[1]); if (prev && lv > prev + 1) skip.push(e); prev = lv; });
    add('heading-order', 'low', skip, 'Heading levels skip (for example h1 to h3).');
    var vp = document.querySelector('meta[name=viewport]');
    if (vp && /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(vp.getAttribute('content') || '')) out.push({ rule: 'zoom-disabled', severity: 'medium', count: 1, detail: 'Pinch zoom is disabled, which hurts low-vision users.', examples: [] });
    return { issues: out };
  }
  function seoAudit() {
    var q = function (s, a) { var e = document.querySelector(s); return e ? (a ? e.getAttribute(a) : e.textContent) : ''; };
    var title = document.title || '', desc = q('meta[name=description]', 'content');
    var issues = [];
    if (!title) issues.push('Missing <title>.'); else if (title.length > 65) issues.push('Title is long (' + title.length + ' characters).');
    if (!desc) issues.push('Missing meta description.');
    if (!q('meta[name=viewport]', 'content')) issues.push('Missing viewport meta tag (bad for phones).');
    if (!q('link[rel=canonical]', 'href')) issues.push('No canonical link.');
    if (!q('meta[property="og:title"]', 'content')) issues.push('No Open Graph title (link previews will look plain).');
    if (/noindex/i.test(q('meta[name=robots]', 'content'))) issues.push('Page is set to noindex.');
    return { title: title, description: desc, issues: issues };
  }
  function perfAudit() {
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    var res = (performance.getEntriesByType && performance.getEntriesByType('resource')) || [];
    var bytes = 0; res.forEach(function (r) { bytes += r.transferSize || 0; });
    var big = [];
    Array.prototype.slice.call(document.images).forEach(function (im) {
      if (!isVisible(im) || !im.naturalWidth) return;
      var r = im.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (im.naturalWidth > r.width * dpr * 2 && im.naturalWidth > 600 && big.length < 6) big.push(short(im.currentSrc || im.src, 100) + ' is ' + im.naturalWidth + 'px wide but shown at ' + Math.round(r.width) + 'px');
    });
    return {
      ttfbMs: nav ? Math.round(nav.responseStart) : null,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadMs: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
      fcpMs: ev.fcp, lcpMs: ev.lcp, cls: ev.cls, longTasks: ev.longTasks,
      requests: res.length, transferKB: Math.round(bytes / 1024), oversizedImages: big
    };
  }

  // ---------- screenshot (lazy html2canvas) ----------
  var h2cPromise = null;
  function loadH2C() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (!h2cPromise) h2cPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload = function () { window.html2canvas ? resolve(window.html2canvas) : reject(new Error('html2canvas missing')); };
      s.onerror = function () { reject(new Error('screenshot_unavailable: could not load the screenshot helper')); };
      document.head.appendChild(s);
    });
    return h2cPromise;
  }
  function screenshot(args) {
    return loadH2C().then(function (h2c) {
      var ov = document.getElementById('__tp_overlay'); if (ov) ov.style.display = 'none';
      return h2c(document.documentElement, {
        scale: (args && args.scale) || 0.5, useCORS: true, logging: false, backgroundColor: null,
        x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight,
        windowWidth: window.innerWidth, windowHeight: window.innerHeight
      }).then(function (canvas) {
        if (ov) ov.style.display = '';
        return { dataUrl: canvas.toDataURL('image/jpeg', (args && args.quality) || 0.6), w: canvas.width, h: canvas.height };
      });
    });
  }

  function resetApp(args) {
    var keep = sessionStorage.getItem(SID_KEY);
    try { localStorage.clear(); } catch (e) {}
    try { sessionStorage.clear(); sessionStorage.setItem(SID_KEY, keep); } catch (e) {}
    try {
      document.cookie.split(';').forEach(function (c) {
        var n = c.split('=')[0].trim(); if (!n) return;
        document.cookie = n + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
      });
    } catch (e) {}
    var p = Promise.resolve();
    try {
      if (indexedDB && indexedDB.databases) p = indexedDB.databases().then(function (dbs) { dbs.forEach(function (d) { if (d.name) indexedDB.deleteDatabase(d.name); }); });
    } catch (e) {}
    return p.catch(function () {}).then(function () { return { ok: true, willReload: !args || args.reload !== false }; });
  }

  // ---------- messaging ----------
  function originAllowed(o) { return ALLOWED.indexOf(o) !== -1; }
  function send(origin, msg) { try { window.parent.postMessage(Object.assign({ tp: 1, sid: sid }, msg), origin); } catch (e) {} }
  function broadcast(msg) { ALLOWED.forEach(function (o) { send(o, msg); }); }

  var COMMANDS = {
    ping: function () { return { version: VERSION, url: location.href, title: document.title }; },
    snapshot: snapshot, click: doClick, type: doType, select: doSelect, check: doCheck, hover: doHover,
    press: doPress, scroll: doScroll, waitSettled: waitSettled,
    evidence: function (a) {
      var copy = JSON.parse(JSON.stringify(ev)); copy.pendingRequests = Math.max(pending, 0);
      if (a && a.clear) { ev.consoleErrors = []; ev.consoleWarnings = []; ev.pageErrors = []; ev.failedRequests = []; ev.brokenResources = []; }
      return copy;
    },
    audit: function (a) {
      var kind = (a && a.kind) || 'all', out = {};
      if (kind === 'layout' || kind === 'all') out.layout = layoutAudit();
      if (kind === 'a11y' || kind === 'all') out.a11y = a11yAudit();
      if (kind === 'seo' || kind === 'all') out.seo = seoAudit();
      if (kind === 'perf' || kind === 'all') out.perf = perfAudit();
      return out;
    },
    screenshot: screenshot,
    highlight: function (a) { var el = getEl(a.index); scrollTo(el); highlight(el, a.label); return { ok: true }; },
    reset: resetApp,
    navigate: function (a) {
      var u; try { u = new URL(String(a.path || '/'), location.href); } catch (e) { throw new Error('bad_url'); }
      if (u.origin !== location.origin) return { ok: false, reason: 'cross_origin_blocked' };
      setTimeout(function () { location.assign(u.href); }, 40);
      return { ok: true, navigating: u.href };
    },
    back: function () { setTimeout(function () { history.back(); }, 40); return { ok: true }; },
    forward: function () { setTimeout(function () { history.forward(); }, 40); return { ok: true }; },
    reload: function () { setTimeout(function () { location.reload(); }, 40); return { ok: true }; }
  };

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    if (!originAllowed(event.origin)) return;
    var d = event.data;
    if (!d || d.tp !== 1 || d.sid !== sid || typeof d.cmd !== 'string') return;
    var fn = COMMANDS[d.cmd];
    if (!fn) { send(event.origin, { type: 'reply', id: d.id, ok: false, error: 'unknown_command: ' + d.cmd }); return; }
    var out;
    try { out = fn(d.args || {}); }
    catch (e) { send(event.origin, { type: 'reply', id: d.id, ok: false, error: short(e && e.message || e, 200) }); return; }
    Promise.resolve(out).then(
      function (result) { send(event.origin, { type: 'reply', id: d.id, ok: true, result: result }); },
      function (e) { send(event.origin, { type: 'reply', id: d.id, ok: false, error: short(e && e.message || e, 200) }); }
    );
  });

  // navigation events (single page apps and full loads)
  function navEvent() { broadcast({ type: 'navigated', url: location.href, title: document.title }); }
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function () { var r = orig.apply(this, arguments); setTimeout(navEvent, 0); return r; };
  });
  window.addEventListener('popstate', navEvent);
  window.addEventListener('hashchange', navEvent);

  broadcast({ type: 'hello', version: VERSION, url: location.href, title: document.title });
  window.addEventListener('DOMContentLoaded', function () { broadcast({ type: 'hello', version: VERSION, url: location.href, title: document.title }); });
})();
