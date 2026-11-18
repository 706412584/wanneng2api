// w2a-bridge.js — 安卓壳专用桥接（桌面/浏览器中该文件无副作用，直接返回）。
//
// 背景：Android WebView 会把 http://127.0.0.1:17800 也交给系统 HTTP 代理，
// 设备开着代理时管理台会 ERR_CONNECTION_REFUSED。壳里通过 @JavascriptInterface
// 暴露 W2ABridge，这里把同源 fetch 改走原生 HTTP（强制 NO_PROXY），
// 并关闭 SSE（日志走管理台已有的去重轮询回退）。
(function () {
  var bridge = window.W2ABridge;
  if (!bridge || typeof bridge.fetch !== 'function') return;

  window.__W2A_ANDROID__ = true;

  // WebView 默认不处理 window.open / target=_blank，统一交给系统浏览器。
  if (typeof bridge.openExternal === 'function') {
    window.open = function (url) {
      if (url) {
        try { bridge.openExternal(String(url)); } catch (e) { /* ignore */ }
      }
      return null;
    };
  }

  var ORIGIN = 'http://127.0.0.1:17800';
  var seq = 0;
  var pending = {};
  var origFetch = window.fetch ? window.fetch.bind(window) : null;

  // 原生完成后回调：把结果包装成 fetch 的 Response 形状。
  window.__w2aFetchDone = function (id, r) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (r && r.error) {
      p.reject(new TypeError('Failed to fetch: ' + r.error));
      return;
    }
    var status = (r && r.status) || 0;
    var text = (r && typeof r.body === 'string') ? r.body : '';
    var ct = (r && r.contentType) || '';
    p.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      statusText: '',
      url: p.url,
      headers: {
        get: function (k) {
          return String(k).toLowerCase() === 'content-type' ? (ct || null) : null;
        }
      },
      text: function () { return Promise.resolve(text); },
      json: function () {
        return Promise.resolve().then(function () { return JSON.parse(text); });
      }
    });
  };

  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var path = null;
    if (url.indexOf(ORIGIN) === 0) path = url.slice(ORIGIN.length) || '/';
    else if (url.charAt(0) === '/') path = url;
    // 只接管本机管理台；其它请求（正常情况没有）交回原生 fetch。
    if (path === null || path.charAt(1) === '/') {
      return origFetch ? origFetch(input, init) : Promise.reject(new Error('fetch unsupported'));
    }

    var id = 'r' + (++seq);
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject, url: url };
      var headers = {};
      var h = init.headers || {};
      try {
        if (typeof h.forEach === 'function' && !Array.isArray(h)) {
          h.forEach(function (v, k) { headers[k] = v; });
        } else {
          for (var k in h) {
            if (Object.prototype.hasOwnProperty.call(h, k)) headers[k] = h[k];
          }
        }
      } catch (e) { /* ignore */ }
      var body = (init.body === undefined || init.body === null) ? null : String(init.body);
      try {
        bridge.fetch(id, String(init.method || 'GET').toUpperCase(), path,
          JSON.stringify(headers), body);
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  };
})();