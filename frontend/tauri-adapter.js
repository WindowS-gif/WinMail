(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  const windowApi = window.__TAURI__?.window;

  function normalizeError(error) {
    if (!error) return "Erreur inconnue";
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    if (error.kind && error.message) return `${error.kind}: ${error.message}`;
    try {
      return JSON.stringify(error);
    } catch (_) {
      return String(error);
    }
  }

  function getCurrentWindow() {
    if (!windowApi) return null;
    if (typeof windowApi.getCurrentWindow === "function") {
      return windowApi.getCurrentWindow();
    }
    if (typeof windowApi.getCurrent === "function") {
      return windowApi.getCurrent();
    }
    return null;
  }

  function bindTitlebar() {
    const titlebar = document.getElementById("appTitlebar");
    const minBtn = document.getElementById("titlebarMinimize");
    const maxBtn = document.getElementById("titlebarMaximize");
    const closeBtn = document.getElementById("titlebarClose");
    if (!titlebar) return;

    const appWindow = getCurrentWindow();
    if (!appWindow) {
      // not running in Tauri: hide the titlebar to avoid a dead bar
      titlebar.classList.add("hidden");
      document.documentElement.style.setProperty("--titlebar-height", "0px");
      return;
    }

    const safeCall = async (fn) => {
      try {
        await fn();
      } catch (err) {
        console.error("Titlebar action failed", err);
      }
    };

    if (minBtn)
      minBtn.addEventListener("click", () =>
        safeCall(() => appWindow.minimize()),
      );
    if (maxBtn)
      maxBtn.addEventListener("click", () =>
        safeCall(() => appWindow.toggleMaximize()),
      );
    if (closeBtn)
      closeBtn.addEventListener("click", () =>
        safeCall(() => appWindow.close()),
      );

    async function refreshMaximizedState() {
      try {
        const maximized = await appWindow.isMaximized();
        titlebar.classList.toggle("is-maximized", !!maximized);
        if (maxBtn) {
          maxBtn.title = maximized ? "Restore" : "Maximize";
          maxBtn.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
        }
      } catch (err) {
        /* ignore */
      }
    }

    refreshMaximizedState();

    if (typeof appWindow.onResized === "function") {
      appWindow.onResized(refreshMaximizedState);
    }
  }

  window.winmailNative = {
    available: typeof invoke === "function",

    async healthCheck() {
      if (!invoke) return { status: "missing-tauri" };
      return invoke("health_check");
    },

    async api(action, method = "GET", data = null) {
      if (!invoke) {
        return { success: false, error: "Backend Tauri indisponible." };
      }
      try {
        return await invoke("legacy_api", {
          request: {
            action,
            method,
            data,
          },
        });
      } catch (error) {
        console.error("Native API error", action, error);
        return { success: false, error: normalizeError(error) };
      }
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindTitlebar);
  } else {
    bindTitlebar();
  }

  // Real-time campaign events from the Rust engine.
  // We expose a small bus that the legacy app subscribes to.
  const eventApi = window.__TAURI__?.event;
  const listeners = {
    progress: new Set(),
    log: new Set(),
    started: new Set(),
    completed: new Set(),
    stopped: new Set(),
    failed: new Set(),
  };

  function fire(kind, payload) {
    for (const cb of listeners[kind] || []) {
      try {
        cb(payload);
      } catch (err) {
        console.error("campaign listener error", kind, err);
      }
    }
  }

  if (eventApi && typeof eventApi.listen === "function") {
    eventApi.listen("campaign://progress", (e) => fire("progress", e.payload));
    eventApi.listen("campaign://log", (e) => fire("log", e.payload));
    eventApi.listen("campaign://started", (e) => fire("started", e.payload));
    eventApi.listen("campaign://completed", (e) =>
      fire("completed", e.payload),
    );
    eventApi.listen("campaign://stopped", (e) => fire("stopped", e.payload));
    eventApi.listen("campaign://failed", (e) => fire("failed", e.payload));
  }

  window.winmailEvents = {
    onProgress(cb) {
      listeners.progress.add(cb);
      return () => listeners.progress.delete(cb);
    },
    onLog(cb) {
      listeners.log.add(cb);
      return () => listeners.log.delete(cb);
    },
    onStarted(cb) {
      listeners.started.add(cb);
      return () => listeners.started.delete(cb);
    },
    onCompleted(cb) {
      listeners.completed.add(cb);
      return () => listeners.completed.delete(cb);
    },
    onStopped(cb) {
      listeners.stopped.add(cb);
      return () => listeners.stopped.delete(cb);
    },
    onFailed(cb) {
      listeners.failed.add(cb);
      return () => listeners.failed.delete(cb);
    },
  };
})();
