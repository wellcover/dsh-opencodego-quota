/**
 * dsh-opencodego-quota — CLIENT half (browser).
 *
 * A self-contained left-sidebar card for the DSH Web GUI: OpenCode Go quota
 * usage with rolling(~5h)/weekly/monthly progress bars, dollar readout, reset
 * times, and an explicit refresh-time line. Plain DOM + fetch + setInterval —
 * no React, no build step — served by the harness at
 * /plugins/dsh-opencodego-quota/client.js and applied by the client kernel.
 *
 * Mounting follows the proven dsh-ssh pattern: the card is a plain DOM sibling
 * of the shell (never React-managed), re-inserted by a MutationObserver when a
 * shell re-render displaces it. All styles are injected once, scoped under the
 * card's data attribute and themed through the shell's --dsw-alias-* variables.
 */
window.__ModuleLoader__.load({
  id: "dsh-opencodego-quota",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── config ─────────────────────────────────────────────────────────────
    var API_PATH = "/opencodego-quota/api";
    var DEFAULT_REFRESH_SEC = 60;   // 默认自动刷新间隔（秒）
    var MIN_REFRESH_SEC = 5;        // 下限保护：至少 5 秒，避免刷爆接口
    var MAX_REFRESH_SEC = 3600;     // 上限：1 小时
    var REFRESH_KEY = "dsh.ocg.refreshSec"; // localStorage 持久化键

    /** 读取用户自定义的刷新间隔（秒），非法/越界时回退默认值。 */
    function refreshSec() {
      var v = parseInt(localStorage.getItem(REFRESH_KEY) || "", 10);
      if (isNaN(v) || v < MIN_REFRESH_SEC) v = DEFAULT_REFRESH_SEC;
      if (v > MAX_REFRESH_SEC) v = MAX_REFRESH_SEC;
      return v;
    }
    function saveRefreshSec(sec) {
      try { localStorage.setItem(REFRESH_KEY, String(sec)); } catch (e) { /* noop */ }
    }

    var WINDOW_DEFS = [
      { key: "rolling", label: "日", sub: "近5小时", color: "#5b9bff" },
      { key: "weekly",  label: "周", sub: "本周",    color: "#34d399" },
      { key: "monthly", label: "月", sub: "本月",    color: "#f59e0b" }
    ];

    // ── DS 峰谷（DeepSeek 按北京时间划分的计费时段） ──
    // 高峰：09:00–12:00、14:00–18:00；其余为低谷（分钟制，一天 1440 分钟）。
    var DS_SEGMENTS = [
      { start: 0,    end: 540,  label: "低谷", cls: "valley" },  // 00:00–09:00
      { start: 540,  end: 720,  label: "高峰", cls: "peak" },    // 09:00–12:00
      { start: 720,  end: 840,  label: "低谷", cls: "valley" },  // 12:00–14:00
      { start: 840,  end: 1080, label: "高峰", cls: "peak" },    // 14:00–18:00
      { start: 1080, end: 1440, label: "低谷", cls: "valley" }   // 18:00–24:00
    ];
    var DS_COLORS = { peak: "#f59e0b", valley: "#34d399" };

    /** 当前北京时间距当日 0 点的分钟数（0–1439）。 */
    function beijingDayMin() {
      var d = new Date(Date.now() + 8 * 3600 * 1000);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    }
    function fmtHm(min) {
      return pad2(Math.floor(min / 60)) + ":" + pad2(Math.round(min % 60));
    }

    var state = { loading: false, data: null, error: null, lastFetch: 0 };

    // ── tiny helpers ───────────────────────────────────────────────────────
    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    function clock(ts) {
      var d = new Date(ts);
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    }
    function fmtReset(iso) {
      if (!iso) return "";
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }
    function percentColor(percent) {
      var remaining = 100 - (percent == null ? 0 : percent);
      if (remaining > 50) return "var(--dsw-alias-state-success-primary, #22c55e)"; // green
      if (remaining >= 20) return "var(--dsw-alias-state-warn-primary, #f59e0b)";  // amber
      return "var(--dsw-alias-state-error-primary, #ef4444)";                      // red
    }

    // ── styles (injected once, scoped under the card data attribute) ────────
    function ensureStyle() {
      if (document.getElementById("dsh-ocg-style")) return;
      var style = document.createElement("style");
      style.id = "dsh-ocg-style";
      style.textContent = [
        "[data-dsh-ocg-card]{box-sizing:border-box;display:block;flex-shrink:0;",
        "position:sticky;bottom:8px;z-index:5;margin:auto 8px 8px;padding:10px 12px;",
        "min-width:0;max-width:240px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));",
        "border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.12));",
        "color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:1.45;}",
        "[data-dsh-ocg-card][data-hidden]{display:none;}",
        "[data-dsh-ocg-card] .ocg-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}",
        "[data-dsh-ocg-card] .ocg-title{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        "[data-dsh-ocg-card] .ocg-title svg{flex:none;}",
        "[data-dsh-ocg-card] .ocg-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;",
        "width:22px;height:22px;padding:0;border:0;border-radius:6px;cursor:pointer;",
        "background:transparent;color:var(--dsw-alias-label-secondary,inherit);}",
        "[data-dsh-ocg-card] .ocg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));}",
        "[data-dsh-ocg-card] .ocg-btn:disabled{opacity:.5;cursor:default;}",
        "[data-dsh-ocg-card] .ocg-row{margin:7px 0;}",
        "[data-dsh-ocg-card] .ocg-row-top{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:3px;}",
        "[data-dsh-ocg-card] .ocg-row-label{font-size:11px;display:flex;align-items:baseline;gap:5px;min-width:0;}",
        "[data-dsh-ocg-card] .ocg-dot{flex:none;width:7px;height:7px;border-radius:50%;align-self:center;}",
        "[data-dsh-ocg-card] .ocg-row-sub{font-size:10px;opacity:.55;}",
        "[data-dsh-ocg-card] .ocg-percent{font-size:11px;font-weight:600;white-space:nowrap;}",
        "[data-dsh-ocg-card] .ocg-bar{height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));overflow:hidden;}",
        "[data-dsh-ocg-card] .ocg-fill{height:100%;border-radius:3px;transition:width .35s ease;}",
        "[data-dsh-ocg-card] .ocg-meta{font-size:10px;opacity:.6;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        "[data-dsh-ocg-card] .ocg-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:8px;padding-top:6px;",
        "border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15));font-size:10px;opacity:.8;}",
        "[data-dsh-ocg-card] .ocg-foot-fresh{white-space:nowrap;}",
        "[data-dsh-ocg-card] .ocg-interval-text{font-variant-numeric:tabular-nums;font-weight:600;cursor:pointer;}",
        "[data-dsh-ocg-card] .ocg-interval-text:hover{opacity:1;color:var(--dsw-alias-state-success-primary,#22c55e);}",
        "[data-dsh-ocg-card] .ocg-settings{position:absolute;right:8px;bottom:34px;z-index:20;display:none;width:calc(100% - 24px);",
        "padding:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:10px;",
        "background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.85));box-shadow:0 6px 24px rgba(0,0,0,.35);}",
        "[data-dsh-ocg-card] .ocg-settings[data-open]{display:block;}",
        "[data-dsh-ocg-card] .ocg-settings-title{display:flex;align-items:center;gap:5px;font-weight:600;font-size:11px;margin-bottom:8px;}",
        "[data-dsh-ocg-card] .ocg-settings-label{display:block;font-size:10px;opacity:.6;margin-bottom:4px;}",
        "[data-dsh-ocg-card] .ocg-settings-input{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));",
        "border-radius:6px;background:transparent;color:inherit;font-size:12px;text-align:center;}",
        "[data-dsh-ocg-card] .ocg-settings-input:focus{outline:none;border-color:var(--dsw-alias-state-success-primary,#22c55e);}",
        "[data-dsh-ocg-card] .ocg-settings-actions{display:flex;gap:6px;margin-top:8px;}",
        "[data-dsh-ocg-card] .ocg-settings-btn{flex:1;padding:4px 0;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;",
        "background:transparent;color:inherit;font-size:11px;cursor:pointer;}",
        "[data-dsh-ocg-card] .ocg-settings-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));}",
        "[data-dsh-ocg-card] .ocg-settings-btn.save{background:var(--dsw-alias-state-success-primary,#22c55e);border-color:transparent;",
        "color:var(--dsw-alias-bg-layer-1,#000);font-weight:600;}",
        "[data-dsh-ocg-card] .ocg-settings-hint{font-size:9px;opacity:.5;margin-top:6px;}",
        "[data-dsh-ocg-card] .ocg-err{margin-top:6px;font-size:10px;line-height:1.4;overflow-wrap:anywhere;",
        "color:var(--dsw-alias-state-error-primary,#ef4444);}",
        "[data-dsh-ocg-card] .ocg-empty{font-size:10px;opacity:.6;}",
        "[data-dsh-ocg-card] .ocg-ds{margin-top:9px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15));}",
        "[data-dsh-ocg-card] .ocg-ds-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px;}",
        "[data-dsh-ocg-card] .ocg-ds-title{display:flex;align-items:center;gap:5px;font-weight:600;font-size:11px;white-space:nowrap;}",
        "[data-dsh-ocg-card] .ocg-ds-status{font-size:10px;white-space:nowrap;}",
        "[data-dsh-ocg-card] .ocg-ds-strip{position:relative;display:flex;height:8px;border-radius:4px;overflow:hidden;",
        "background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));}",
        "[data-dsh-ocg-card] .ocg-ds-seg{height:100%;}",
        "[data-dsh-ocg-card] .ocg-ds-seg.peak{background:rgba(245,158,11,.55);}",
        "[data-dsh-ocg-card] .ocg-ds-seg.valley{background:rgba(52,211,153,.35);}",
        "[data-dsh-ocg-card] .ocg-ds-marker{position:absolute;top:-2px;bottom:-2px;width:2px;border-radius:1px;",
        "background:var(--dsw-alias-label-primary,currentColor);opacity:.9;pointer-events:none;}",
        "[data-dsh-ocg-card] .ocg-ds-meta{font-size:10px;opacity:.6;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}"
      ].join(" ");
      (document.head || document.documentElement).appendChild(style);
    }

    // ── card DOM ───────────────────────────────────────────────────────────
    var ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2.5 3.5 9h3L6.5 13.5l4.5-7h-3L9.5 2.5H7Z"/></svg>';

    function buildCard() {
      var card = document.createElement("div");
      card.dataset.dshOcgCard = "";
      card.setAttribute("aria-label", "OpenCode Go 额度用量");

      var head = document.createElement("div");
      head.className = "ocg-head";
      var title = document.createElement("div");
      title.className = "ocg-title";
      title.innerHTML = ICON + "<span>OpenCode Go 额度</span>";
      var refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "ocg-btn";
      refresh.title = "立即刷新";
      refresh.setAttribute("aria-label", "立即刷新");
      refresh.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 1.8v2.8h-2.8"/></svg>';
      refresh.addEventListener("click", function () { fetchQuota(); });
      // 设置按钮：弹出刷新间隔设置浮层
      var settingsBtn = document.createElement("button");
      settingsBtn.type = "button";
      settingsBtn.className = "ocg-btn ocg-btn-settings";
      settingsBtn.title = "刷新间隔设置";
      settingsBtn.setAttribute("aria-label", "刷新间隔设置");
      settingsBtn.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.6"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.7 3.7l1.3 1.3M11 11l1.3 1.3M12.3 3.7 11 5M5 11l-1.3 1.3"/></svg>';
      // 设置浮层 DOM
      var settings = document.createElement("div");
      settings.className = "ocg-settings";
      settings.setAttribute("role", "dialog");
      settings.setAttribute("aria-label", "刷新间隔设置");
      var settingsTitle = document.createElement("div");
      settingsTitle.className = "ocg-settings-title";
      settingsTitle.textContent = "⚙ 自动刷新";
      var settingsLabel = document.createElement("label");
      settingsLabel.className = "ocg-settings-label";
      settingsLabel.textContent = "刷新间隔（秒，5–3600）";
      var settingsInput = document.createElement("input");
      settingsInput.type = "number";
      settingsInput.min = String(MIN_REFRESH_SEC);
      settingsInput.max = String(MAX_REFRESH_SEC);
      settingsInput.step = "1";
      settingsInput.className = "ocg-settings-input";
      var settingsActions = document.createElement("div");
      settingsActions.className = "ocg-settings-actions";
      var settingsSave = document.createElement("button");
      settingsSave.type = "button";
      settingsSave.className = "ocg-settings-btn save";
      settingsSave.textContent = "保存";
      var settingsCancel = document.createElement("button");
      settingsCancel.type = "button";
      settingsCancel.className = "ocg-settings-btn";
      settingsCancel.textContent = "取消";
      settingsActions.appendChild(settingsSave);
      settingsActions.appendChild(settingsCancel);
      var settingsHint = document.createElement("div");
      settingsHint.className = "ocg-settings-hint";
      settingsHint.textContent = "回车保存；设置持久保存在本机浏览器";
      settings.appendChild(settingsTitle);
      settings.appendChild(settingsLabel);
      settings.appendChild(settingsInput);
      settings.appendChild(settingsActions);
      settings.appendChild(settingsHint);
      head.appendChild(title);
      head.appendChild(refresh);
      head.appendChild(settingsBtn);

      var body = document.createElement("div");
      body.className = "ocg-body";

      var foot = document.createElement("div");
      foot.className = "ocg-foot";
      var fresh = document.createElement("span");
      fresh.className = "ocg-foot-fresh";
      fresh.textContent = "加载中…";
      // 底部只显示当前刷新间隔秒数（点击可打开设置弹层）
      var intervalText = document.createElement("span");
      intervalText.className = "ocg-interval-text";
      intervalText.textContent = refreshSec() + "s";
      intervalText.title = "自动刷新间隔：" + refreshSec() + " 秒（点击修改）";
      foot.appendChild(fresh);
      foot.appendChild(intervalText);

      card.appendChild(head);
      card.appendChild(body);
      card.appendChild(settings);
      card.appendChild(foot);

      card.dataset.body = "";
      card.dataset.fresh = "";
      return card;
    }

    function refreshButton(card) {
      return card.querySelector(".ocg-btn");
    }

    function render(card) {
      var body = card.querySelector(".ocg-body");
      var fresh = card.querySelector(".ocg-foot-fresh");
      var refreshBtn = refreshButton(card);

      if (refreshBtn) refreshBtn.disabled = state.loading;

      // ── header / refresh time ──
      if (state.loading) {
        fresh.textContent = "刷新中…";
      } else if (state.error !== null) {
        fresh.textContent = state.lastFetch > 0 ? "刷新于 " + clock(state.lastFetch) : "获取失败";
      } else {
        fresh.textContent = state.lastFetch > 0 ? "刷新于 " + clock(state.lastFetch) : "尚未刷新";
      }
      fresh.title = state.lastFetch > 0 ? "上次成功刷新：" + new Date(state.lastFetch).toLocaleString() : "";

      // ── quota windows + DS 峰谷 ──
      body.textContent = "";
      if (state.error !== null && state.data === null) {
        var err = document.createElement("div");
        err.className = "ocg-err";
        err.textContent = "额度获取失败：" + state.error;
        body.appendChild(err);
      } else if (state.data === null) {
        var empty = document.createElement("div");
        empty.className = "ocg-empty";
        empty.textContent = "正在获取额度数据…";
        body.appendChild(empty);
      } else {
        var windows = state.data.windows || {};
        for (var i = 0; i < WINDOW_DEFS.length; i++) {
          var def = WINDOW_DEFS[i];
          var w = windows[def.key];
          var row = document.createElement("div");
          row.className = "ocg-row";

          var top = document.createElement("div");
          top.className = "ocg-row-top";

          var label = document.createElement("div");
          label.className = "ocg-row-label";
          var dot = document.createElement("span");
          dot.className = "ocg-dot";
          var name = document.createElement("span");
          name.textContent = def.label + " · " + def.sub;
          label.appendChild(dot);
          label.appendChild(name);
          top.appendChild(label);

          var pct = document.createElement("span");
          pct.className = "ocg-percent";
          var color = percentColor(w && w.percent != null ? w.percent : 0);
          var pctText = (w && w.percent != null) ? Math.round(w.percent) + "%" : "—";
          pct.textContent = pctText;
          pct.style.color = color;
          dot.style.background = color;
          top.appendChild(pct);

          var bar = document.createElement("div");
          bar.className = "ocg-bar";
          var fill = document.createElement("div");
          fill.className = "ocg-fill";
          fill.style.width = "0%";
          fill.style.background = (w && w.available) ? def.color : "rgba(128,128,128,.35)";
          bar.appendChild(fill);
          if (w && w.percent != null) {
            // animate on next frame so the transition shows.
            // NOTE: `fill`/`w` are function-scoped `var` inside this loop, so a
            // bare closure would capture the LAST iteration for every row and
            // only the final bar would ever fill. Capture per-row values via IIFE.
            (function (fillEl, pct) {
              requestAnimationFrame(function () { fillEl.style.width = Math.max(0, Math.min(100, pct)) + "%"; });
            })(fill, w.percent);
          }

          var meta = document.createElement("div");
          meta.className = "ocg-meta";
          if (w && w.available && w.percent != null) {
            var used = (w.usedDollars != null ? "$" + w.usedDollars.toFixed(2) : Math.round(w.percent) + "%");
            meta.textContent = used + " / $" + (w.limit != null ? w.limit : "?") + (w.resetsAt ? " · 重置 " + fmtReset(w.resetsAt) : "");
          } else if (w && w.available) {
            meta.textContent = "窗口状态：" + (w.status || "unknown");
          } else {
            meta.textContent = "窗口不可用（" + def.key + "）";
          }

          row.appendChild(top);
          row.appendChild(bar);
          row.appendChild(meta);
          body.appendChild(row);
        }

        var src = state.data.keySource ? " · 密钥来源 " + state.data.keySource : "";
        body.title = "OpenCode Go 官方用量接口 /zen/go/v1/usage" + src;
      }
      body.appendChild(buildDsSection());
    }

    /**
     * DS 峰谷进度条：按北京时间把一天切成 高峰(09–12, 14–18) / 低谷 五段，
     * 用一条 24 小时色带 + 当前时刻标记显示所处时段，并给出当前时段的已过/剩余进度。
     */
    function buildDsSection() {
      var now = beijingDayMin();
      var seg = null;
      var next = null;
      for (var i = 0; i < DS_SEGMENTS.length; i++) {
        if (now >= DS_SEGMENTS[i].start && now < DS_SEGMENTS[i].end) {
          seg = DS_SEGMENTS[i];
          next = DS_SEGMENTS[(i + 1) % DS_SEGMENTS.length];
          break;
        }
      }
      var root = document.createElement("div");
      root.className = "ocg-ds";
      if (!seg) return root; // defensive: 时间计算异常时留空

      var isPeak = seg.cls === "peak";
      var color = DS_COLORS[seg.cls];
      var spanMin = Math.max(1, seg.end - seg.start);
      var elapsed = Math.max(0, Math.min(1, (now - seg.start) / spanMin));
      var pct = Math.round(elapsed * 100);
      // 夜间低谷（00:00–09:00 与 18:00–24:00）合并显示为 18:00-次日9:00，不带百分比
      var isNightValley = seg.cls === "valley" && (seg.start === 0 || seg.start === 1080);

      var top = document.createElement("div");
      top.className = "ocg-ds-top";
      var title = document.createElement("div");
      title.className = "ocg-ds-title";
      var dot = document.createElement("span");
      dot.className = "ocg-dot";
      dot.style.background = color;
      var tspan = document.createElement("span");
      tspan.textContent = "DS 峰谷";
      title.appendChild(dot);
      title.appendChild(tspan);
      var status = document.createElement("span");
      status.className = "ocg-ds-status";
      status.style.color = color;
      // 只显示时段名称与区间，不附带当前已过百分比
      status.textContent = isNightValley
        ? "低谷 18:00-次日9:00"
        : (isPeak ? "高峰" : "低谷") + " " + fmtHm(seg.start) + "–" + fmtHm(seg.end);
      top.appendChild(title);
      top.appendChild(status);

      var strip = document.createElement("div");
      strip.className = "ocg-ds-strip";
      for (var j = 0; j < DS_SEGMENTS.length; j++) {
        var s = DS_SEGMENTS[j];
        var segEl = document.createElement("div");
        segEl.className = "ocg-ds-seg " + s.cls;
        segEl.style.width = ((s.end - s.start) / 1440 * 100) + "%";
        segEl.style.opacity = (s === seg) ? "1" : "0.5";
        strip.appendChild(segEl);
      }
      var marker = document.createElement("div");
      marker.className = "ocg-ds-marker";
      marker.style.left = "calc(" + (now / 1440 * 100) + "% - 1px)";
      strip.appendChild(marker);

      root.appendChild(top);
      root.appendChild(strip);
      return root;
    }

    // ── data fetch ─────────────────────────────────────────────────────────
    async function fetchQuota() {
      if (state.loading) return;
      state.loading = true;
      render(cardView());
      try {
        var res = await fetch(API_PATH, { cache: "no-store" });
        var data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (!data || !data.ok) {
          throw new Error((data && data.error) || "HTTP " + res.status + " 请求失败");
        }
        state.data = data;
        state.error = null;
        state.lastFetch = Date.now();
      } catch (e) {
        state.error = String((e && e.message) || e);
      } finally {
        state.loading = false;
        render(cardView());
      }
    }

    var currentCard = null;
    function cardView() {
      if (currentCard === null) throw new Error("card not mounted");
      return currentCard;
    }

    // ── sidebar mounting (dsh-ssh-proven pattern, self-healing) ────────────
    function sidebarRoot() {
      var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (column === null) return undefined;
      var logoOwner = column.querySelector('[class*="logoRow"]') && column.querySelector('[class*="logoRow"]').parentElement;
      return logoOwner || (column.firstElementChild) || undefined;
    }

    function mountCard() {
      ensureStyle();
      var card = buildCard();
      currentCard = card;

      var root = undefined;
      var placed = false;
      var rootObserver = undefined;
      var bodyObserver = undefined;

      function tryPlace() {
        if (root !== undefined && !root.isConnected) {
          if (rootObserver) { rootObserver.disconnect(); rootObserver = undefined; }
          root = undefined;
          placed = false;
        }
        if (placed) {
          if (document.body.contains(card)) return;
          if (rootObserver) { rootObserver.disconnect(); rootObserver = undefined; }
          root = undefined;
          placed = false;
        }
        root = root || sidebarRoot();
        if (root === undefined) return;
        if (!root.contains(card)) {
          root.appendChild(card);
          placed = true;
        }
        if (placed && rootObserver === undefined) {
          rootObserver = new MutationObserver(function () {
            if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return; }
            if (!root.contains(card)) { root.appendChild(card); } // self-heal re-render displacement
          });
          rootObserver.observe(root, { childList: true, subtree: true });
        }
        // Rail/collapsed sidebar: hide the wide card instead of overflowing.
        var w = root.getBoundingClientRect ? root.getBoundingClientRect().width : 0;
        if (card && w > 0 && w < 110) card.dataset.hidden = "true";
        else if (card) delete card.dataset.hidden;
      }

      bodyObserver = new MutationObserver(function () { tryPlace(); });
      bodyObserver.observe(document.body, { childList: true, subtree: true });

      tryPlace();

      // ── 自定义刷新间隔：⚙ 设置弹层（输入秒数，回车/保存生效） ──
      var refreshTimer = null;
      function refreshIntervalMs() { return refreshSec() * 1000; }
      function scheduleRefresh() {
        if (refreshTimer !== null) clearInterval(refreshTimer);
        refreshTimer = setInterval(fetchQuota, refreshIntervalMs());
      }
      var settingsBtn = card.querySelector(".ocg-btn-settings");
      var settings = card.querySelector(".ocg-settings");
      var settingsInput = card.querySelector(".ocg-settings-input");
      var intervalText = card.querySelector(".ocg-interval-text");

      function updateIntervalText() {
        intervalText.textContent = refreshSec() + "s";
        intervalText.title = "自动刷新间隔：" + refreshSec() + " 秒（点击修改）";
      }
      function openSettings() {
        if (!settings) return;
        settingsInput.value = String(refreshSec());
        settings.dataset.open = "1";
        setTimeout(function () { settingsInput.focus(); settingsInput.select(); }, 0);
      }
      function closeSettings() {
        if (settings) delete settings.dataset.open;
      }
      function applySettings() {
        var v = parseInt(settingsInput.value, 10);
        if (isNaN(v) || v < MIN_REFRESH_SEC) v = MIN_REFRESH_SEC;
        if (v > MAX_REFRESH_SEC) v = MAX_REFRESH_SEC;
        settingsInput.value = String(v);
        saveRefreshSec(v);
        updateIntervalText();
        scheduleRefresh();
        closeSettings();
      }
      if (settingsBtn) settingsBtn.addEventListener("click", function (e) { e.stopPropagation(); openSettings(); });
      if (intervalText) intervalText.addEventListener("click", function (e) { e.stopPropagation(); openSettings(); });
      if (settings) {
        var saveBtn = card.querySelector(".ocg-settings-btn.save");
        var cancelBtn = settings.querySelector(".ocg-settings-btn:not(.save)");
        if (saveBtn) saveBtn.addEventListener("click", applySettings);
        if (cancelBtn) cancelBtn.addEventListener("click", closeSettings);
        settingsInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter") applySettings();
          if (e.key === "Escape") closeSettings();
        });
        // 点击弹层内部不关闭
        settings.addEventListener("click", function (e) { e.stopPropagation(); });
      }
      // 点击卡片外部任意处关闭设置弹层
      var outsideClose = function (e) {
        if (card.contains(e.target)) return;
        closeSettings();
      };
      document.addEventListener("mousedown", outsideClose);

      scheduleRefresh();

      // 本地时钟 tick：仅重绘（峰谷进度条随分钟走，不必重新拉取额度）。
      var tickTimer = setInterval(function () {
        try { render(card); } catch (e) { /* noop */ }
      }, 30000);
      fetchQuota();

      return function dispose() {
        if (bodyObserver) bodyObserver.disconnect();
        if (rootObserver) rootObserver.disconnect();
        document.removeEventListener("mousedown", outsideClose);
        if (refreshTimer !== null) clearInterval(refreshTimer);
        if (tickTimer) clearInterval(tickTimer);
        if (card && card.parentNode) card.parentNode.removeChild(card);
        if (currentCard === card) currentCard = null;
      };
    }

    // ── plugin contract (client kernel) ────────────────────────────────────
    var inject = [];
    function apply(ctx) {
      var disposer = null;
      try {
        disposer = mountCard();
      } catch (e) {
        console.warn("[dsh-opencodego-quota] mount failed:", e);
      }
      if (disposer && ctx && typeof ctx.effect === "function") {
        try {
          ctx.effect(function () { return disposer; }, "dsh-opencodego-quota: sidebar quota card");
        } catch (e) { /* effect registration best-effort */ }
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});