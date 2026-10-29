// Armada preview agent. The desktop app's local reverse proxy injects this script into the HTML of the
// dev server shown in the Preview pane. It runs inside the *page* and talks to the app only through
// window.parent.postMessage; it never evaluates anything it is sent. See src/lib/previewBridge.ts for
// the parent side and the message shapes.
//
// Build: `npm run build:preview-agent` (bundles html-to-image into src-tauri/assets/preview-agent.js).
import { toJpeg, toPng } from "html-to-image";

(function () {
  "use strict";
  var W = window;
  // Only the page directly inside the Preview iframe (not nested frames, not a standalone tab).
  if (W.__armadaPreview || W.parent === W || W.top !== W.parent) return;
  W.__armadaPreview = true;

  var VERSION = 1;
  var OVERLAY_ID = "__armada_preview_overlay__";
  var token = null; // handed over by the app after the hello handshake; never baked into this file
  var parentOrigin = null;
  var queue = []; // events produced before the app answered
  var MAX_QUEUE = 100;

  function clip(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function post(msg) {
    msg.armada = "preview";
    msg.v = VERSION;
    if (token === null || parentOrigin === null) {
      if (msg.type !== "hello" && queue.length < MAX_QUEUE) queue.push(msg);
      if (msg.type !== "hello") return;
      // The handshake carries no secret, so it may go to any embedder.
      try {
        W.parent.postMessage(msg, "*");
      } catch (_) {}
      return;
    }
    msg.token = token;
    try {
      W.parent.postMessage(msg, parentOrigin);
    } catch (_) {}
  }

  // ---- console and errors ------------------------------------------------------------------------
  var seen = Object.create(null);

  function fmtArg(a) {
    if (a instanceof Error) return (a.name || "Error") + ": " + a.message;
    if (typeof a === "string") return a;
    if (a === undefined) return "undefined";
    try {
      var s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch (_) {
      return Object.prototype.toString.call(a);
    }
  }

  // Frames from this script itself (the console wrapper) are noise.
  var ownSrc = "";
  try {
    ownSrc = document.currentScript && document.currentScript.src ? document.currentScript.src : "";
  } catch (_) {}

  function topFrames(stack) {
    if (!stack) return "";
    return String(stack)
      .split("\n")
      .map(function (l) {
        return l.trim();
      })
      .filter(function (l) {
        return /^at |@|:\d+:\d+/.test(l) && !(ownSrc && l.indexOf(ownSrc) >= 0) && l.indexOf("preview-agent") < 0;
      })
      .slice(0, 4)
      .join("\n");
  }

  function report(level, kind, message, stack, source) {
    var key = level + "|" + kind + "|" + clip(message, 200);
    var n = (seen[key] = (seen[key] || 0) + 1);
    // Report the first few occurrences, then only powers of two: a render loop can't flood the app.
    if (n > 3 && (n & (n - 1)) !== 0) return;
    post({
      type: "console",
      level: level,
      kind: kind,
      message: clip(message, 1500),
      stack: clip(topFrames(stack), 800),
      source: clip(source || "", 300),
      count: n,
    });
  }

  ["error", "warn"].forEach(function (lvl) {
    var orig = console[lvl];
    if (typeof orig !== "function") return;
    console[lvl] = function () {
      try {
        var args = Array.prototype.slice.call(arguments);
        var err = args.filter(function (a) {
          return a instanceof Error;
        })[0];
        var msg = args.map(fmtArg).join(" ");
        report(lvl === "warn" ? "warn" : "error", "console", msg, err ? err.stack : new Error().stack, "");
      } catch (_) {}
      return orig.apply(this, arguments);
    };
  });

  W.addEventListener(
    "error",
    function (e) {
      try {
        var t = e.target;
        if (t && t !== W && t.nodeType === 1) {
          var src = t.currentSrc || t.src || t.href || "";
          report("error", "resource", "Failed to load <" + t.tagName.toLowerCase() + "> " + src, "", src);
          return;
        }
        var err = e.error;
        report(
          "error",
          "exception",
          err instanceof Error ? (err.name || "Error") + ": " + err.message : e.message || "Script error",
          err && err.stack ? err.stack : e.filename ? "at " + e.filename + ":" + e.lineno + ":" + e.colno : "",
          e.filename || "",
        );
      } catch (_) {}
    },
    true,
  );

  W.addEventListener("unhandledrejection", function (e) {
    try {
      var r = e.reason;
      report(
        "error",
        "rejection",
        "Unhandled rejection: " + (r instanceof Error ? (r.name || "Error") + ": " + r.message : fmtArg(r)),
        r && r.stack ? r.stack : "",
        "",
      );
    } catch (_) {}
  });

  // ---- selector / element description -------------------------------------------------------------
  function cssEsc(s) {
    return W.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&");
  }

  function goodClass(c) {
    return c && c.length <= 32 && !/\d{3,}/.test(c) && !/^(css|sc|jsx|svelte|astro)-/.test(c);
  }

  function selectorPath(el) {
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var tag = cur.tagName.toLowerCase();
      var part;
      if (cur.id && document.querySelectorAll("#" + cssEsc(cur.id)).length === 1 && !/\d{4,}/.test(cur.id)) {
        parts.unshift("#" + cssEsc(cur.id));
        break;
      }
      part = tag;
      var tid = cur.getAttribute("data-testid");
      if (tid) {
        part += '[data-testid="' + tid.replace(/"/g, '\\"') + '"]';
      } else {
        var classes = Array.prototype.filter.call(cur.classList || [], goodClass).slice(0, 2);
        if (classes.length) part += "." + classes.map(cssEsc).join(".");
        var p = cur.parentElement;
        if (p) {
          var same = Array.prototype.filter.call(p.children, function (c) {
            return c.tagName === cur.tagName;
          });
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
        }
      }
      parts.unshift(part);
      var sel = parts.join(" > ");
      try {
        if (document.querySelectorAll(sel).length === 1 && cur.tagName !== "BODY") {
          // unique already; keep it short
          if (parts.length >= 1 && document.querySelector(sel) === el) break;
        }
      } catch (_) {}
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function describe(el) {
    var r = el.getBoundingClientRect();
    var attrs = {};
    ["role", "aria-label", "href", "type", "name", "alt", "placeholder", "data-testid"].forEach(function (a) {
      var v = el.getAttribute && el.getAttribute(a);
      if (v) attrs[a] = clip(v, 120);
    });
    return {
      selector: clip(selectorPath(el), 400),
      tag: el.tagName.toLowerCase(),
      id: el.id ? clip(el.id, 80) : "",
      classes: Array.prototype.slice.call(el.classList || [], 0, 8).map(function (c) {
        return clip(c, 60);
      }),
      text: clip((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(), 120),
      attrs: attrs,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      viewport: { width: W.innerWidth, height: W.innerHeight },
    };
  }

  // ---- screenshots --------------------------------------------------------------------------------
  var MAX_DIM = 2400;
  var MAX_CHARS = 6.5 * 1024 * 1024; // ~5 MB of binary once base64-decoded

  function withTimeout(p, ms) {
    return Promise.race([
      p,
      new Promise(function (_, rej) {
        setTimeout(function () {
          rej(new Error("Timed out capturing the page"));
        }, ms);
      }),
    ]);
  }

  function bgOf() {
    var c = getComputedStyle(document.body || document.documentElement).backgroundColor;
    var h = getComputedStyle(document.documentElement).backgroundColor;
    var pick = function (x) {
      return x && x !== "rgba(0, 0, 0, 0)" && x !== "transparent" ? x : null;
    };
    return pick(h) || pick(c) || "#ffffff";
  }

  function capture(node, width, height, style) {
    var opts = {
      width: width,
      height: height,
      pixelRatio: Math.max(0.25, Math.min(1, MAX_DIM / Math.max(width, height))),
      backgroundColor: bgOf(),
      cacheBust: false,
      style: style,
      imagePlaceholder:
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      filter: function (n) {
        return n.id !== OVERLAY_ID;
      },
    };
    return withTimeout(toPng(node, opts), 20000).then(function (png) {
      if (png.length <= MAX_CHARS) return { url: png, mime: "image/png" };
      return toJpeg(node, Object.assign({}, opts, { quality: 0.85 })).then(function (jpg) {
        return { url: jpg, mime: "image/jpeg" };
      });
    });
  }

  function shotViewport() {
    var sx = W.scrollX,
      sy = W.scrollY;
    var style = sx || sy ? { transform: "translate(" + -sx + "px," + -sy + "px)", transformOrigin: "0 0" } : undefined;
    return capture(document.documentElement, W.innerWidth, W.innerHeight, style).then(function (r) {
      r.width = W.innerWidth;
      r.height = W.innerHeight;
      return r;
    });
  }

  function shotElement(el) {
    var r = el.getBoundingClientRect();
    var w = Math.max(1, Math.ceil(r.width)),
      h = Math.max(1, Math.ceil(r.height));
    return capture(el, w, h).then(function (res) {
      res.width = w;
      res.height = h;
      return res;
    });
  }

  function replyShot(id, p) {
    p.then(
      function (r) {
        post({ type: "shot", id: id, ok: true, dataUrl: r.url, mime: r.mime, width: r.width, height: r.height });
      },
      function (e) {
        post({ type: "shot", id: id, ok: false, error: clip(e && e.message ? e.message : e, 200) });
      },
    );
  }

  // ---- element picker -----------------------------------------------------------------------------
  var inspecting = false;
  var wantShot = false;
  var box = null;
  var label = null;
  var hovered = null;

  function ensureOverlay() {
    if (box && box.isConnected) return;
    box = document.createElement("div");
    box.id = OVERLAY_ID;
    box.setAttribute("aria-hidden", "true");
    box.style.cssText =
      "position:fixed;z-index:2147483647;pointer-events:none;margin:0;padding:0;box-sizing:border-box;" +
      "border:1.5px solid #4f8cff;background:rgba(79,140,255,.16);border-radius:2px;display:none;" +
      "transition:left .05s,top .05s,width .05s,height .05s";
    label = document.createElement("div");
    label.style.cssText =
      "position:absolute;left:-1.5px;top:100%;margin-top:3px;white-space:nowrap;max-width:60vw;overflow:hidden;" +
      "text-overflow:ellipsis;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;" +
      "background:#1d2433;padding:2px 6px;border-radius:4px";
    box.appendChild(label);
    document.documentElement.appendChild(box);
  }

  function place(el) {
    ensureOverlay();
    if (!el || el === document.documentElement) {
      box.style.display = "none";
      return;
    }
    var r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    var id = el.id ? "#" + el.id : "";
    var cls = Array.prototype.slice.call(el.classList || [], 0, 2).join(".");
    label.textContent =
      el.tagName.toLowerCase() + id + (cls ? "." + cls : "") + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    // Keep the label inside the viewport when the element hugs the bottom edge.
    label.style.top = r.bottom > W.innerHeight - 28 ? "auto" : "100%";
    label.style.bottom = r.bottom > W.innerHeight - 28 ? "100%" : "auto";
    label.style.marginTop = r.bottom > W.innerHeight - 28 ? "0" : "3px";
    label.style.marginBottom = r.bottom > W.innerHeight - 28 ? "3px" : "0";
  }

  function target(e) {
    var t = e.composedPath ? e.composedPath()[0] : e.target;
    return t && t.nodeType === 1 && t.id !== OVERLAY_ID ? t : null;
  }

  function onMove(e) {
    var t = target(e);
    if (t === hovered) return;
    hovered = t;
    place(t);
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    swallow(e);
    var t = target(e);
    if (!t) return;
    var info = describe(t);
    var shot = wantShot;
    setInspect(false);
    post({ type: "picked", info: info });
    if (shot) {
      withTimeout(shotElement(t), 20000).then(
        function (r) {
          post({ type: "pick-shot", ok: true, dataUrl: r.url, mime: r.mime, width: r.width, height: r.height, selector: info.selector });
        },
        function (err) {
          post({ type: "pick-shot", ok: false, error: clip(err && err.message ? err.message : err, 200), selector: info.selector });
        },
      );
    }
  }

  function onKey(e) {
    if (e.key === "Escape") {
      swallow(e);
      setInspect(false);
    }
  }

  var EVENTS = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu", "auxclick", "touchstart"];

  function setInspect(on) {
    if (on === inspecting) return;
    inspecting = on;
    if (on) {
      W.addEventListener("mousemove", onMove, true);
      W.addEventListener("click", onClick, true);
      W.addEventListener("keydown", onKey, true);
      EVENTS.forEach(function (n) {
        W.addEventListener(n, swallow, true);
      });
      document.documentElement.style.cursor = "crosshair";
    } else {
      W.removeEventListener("mousemove", onMove, true);
      W.removeEventListener("click", onClick, true);
      W.removeEventListener("keydown", onKey, true);
      EVENTS.forEach(function (n) {
        W.removeEventListener(n, swallow, true);
      });
      document.documentElement.style.cursor = "";
      hovered = null;
      if (box) box.style.display = "none";
    }
    post({ type: "inspect-state", on: on });
  }

  // ---- parent link --------------------------------------------------------------------------------
  W.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== W.parent || !d || d.armada !== "preview-parent" || typeof d.token !== "string") return;
    if (token === null) {
      token = d.token;
      parentOrigin = e.origin;
      post({ type: "ready", url: location.href, title: clip(document.title, 200) });
      var q = queue;
      queue = [];
      q.forEach(post);
      return;
    }
    if (d.token !== token) return;
    switch (d.cmd) {
      case "screenshot":
        replyShot(String(d.id || ""), shotViewport());
        break;
      case "inspect":
        wantShot = !!d.shot;
        setInspect(!!d.on);
        break;
      case "ping":
        post({ type: "ready", url: location.href, title: clip(document.title, 200) });
        break;
    }
  });

  function hello() {
    if (token === null) post({ type: "hello", url: location.href });
  }
  hello();
  document.addEventListener("DOMContentLoaded", hello);
  W.addEventListener("load", hello);
  W.addEventListener("pagehide", function () {
    if (inspecting) setInspect(false);
  });
})();
