(() => {
  const LEGACY_KEY = "pwa-demo-tasks";

  const form = document.getElementById("task-form");
  const input = document.getElementById("task-input");
  const list = document.getElementById("task-list");
  const empty = document.getElementById("empty");
  const statusEl = document.getElementById("status");
  const sidebarUser = document.getElementById("sidebar-user");
  const sidebarAvatar = document.getElementById("sidebar-avatar");
  const sidebarName = document.getElementById("sidebar-name");
  const sidebarDrive = document.getElementById("sidebar-drive");
  const swState = document.getElementById("sw-state");
  const syncStateEl = document.getElementById("sync-state");
  const syncDetailEl = document.getElementById("sync-detail");
  const lastSyncEl = document.getElementById("last-sync");
  const connectBtn = document.getElementById("connect-drive");
  const settingsSignoutBtn = document.getElementById("settings-signout");
  const openSharedBtn = document.getElementById("open-shared");
  const shareForm = document.getElementById("share-form");
  const shareEmail = document.getElementById("share-email");
  const inviteNote = document.getElementById("invite-note");
  const openNote = document.getElementById("open-note");
  const pageTitle = document.getElementById("page-title");
  const navButtons = document.querySelectorAll(".nav-item");
  const pages = {
    login: document.getElementById("page-login"),
    tasks: document.getElementById("page-tasks"),
    settings: document.getElementById("page-settings")
  };

  let auth = null;
  let lastSyncValue = null;

  // ---------- Pages ----------
  function isSignedIn() {
    return !!(auth && auth.signedIn && auth.profile && auth.profile.sub);
  }

  function showPage(name) {
    const signedIn = isSignedIn();
    let page = pages[name] ? name : "tasks";
    if (!signedIn) page = "login";
    else if (page === "login") page = "tasks";

    Object.entries(pages).forEach(([key, el]) => {
      el.hidden = key !== page;
    });
    navButtons.forEach((button) => {
      const active = button.dataset.page === page;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    pageTitle.textContent = page === "login" ? "Sign in" : (page === "settings" ? "Settings" : "Tasks");
    document.title = page === "login" ? "Sign in · PWA Demo" : (page === "settings" ? "Settings · PWA Demo" : "PWA Demo");
    document.body.classList.toggle("logged-out", !signedIn);
    if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
  }

  navButtons.forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.page));
  });
  window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));

  function newId() {
    return (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // ---------- Tasks (a collection inside the generic app state) ----------
  function render() {
    const tasks = AppSync.list("tasks")
      .slice()
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

    list.replaceChildren();
    empty.hidden = tasks.length > 0;

    tasks.forEach((task) => {
      const li = document.createElement("li");
      if (task.done) li.classList.add("done");

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = !!task.done;
      check.setAttribute("aria-label", "Mark done");
      check.addEventListener("change", () => {
        AppSync.upsert("tasks", task.id, { done: check.checked });
      });

      const text = document.createElement("span");
      text.textContent = task.text;

      const del = document.createElement("button");
      del.className = "delete";
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        AppSync.remove("tasks", task.id);
      });

      li.append(check, text, del);
      list.append(li);
    });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    AppSync.upsert("tasks", newId(), { text: value, done: false, createdAt: Date.now() });
    input.value = "";
  });

  // Move tasks from the old localStorage-only version into the shared document.
  function migrateLegacyTasks() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return;
      const oldTasks = JSON.parse(raw);
      if (!Array.isArray(oldTasks)) return;
      oldTasks.forEach((task) => {
        const id = String(task.id || newId());
        if (!AppSync.get("tasks", id)) {
          AppSync.upsert("tasks", id, {
            text: String(task.text || ""),
            done: !!task.done,
            createdAt: Number(task.id) || Date.now()
          });
        }
      });
      localStorage.removeItem(LEGACY_KEY);
    } catch (err) {
      console.warn("Could not migrate existing tasks:", err);
    }
  }

  // ---------- Last sync display ----------
  function formatLastSync(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function renderLastSync(timestamp) {
    lastSyncEl.hidden = !timestamp;
    if (!timestamp) return;
    const label = formatLastSync(timestamp);
    lastSyncEl.textContent = `Last synced: ${label}`;
    lastSyncEl.title = label;
  }

  setInterval(() => renderLastSync(lastSyncValue), 60000);

  // ---------- Drive UI ----------
  AppSync.onChange(render);

  AppSync.onStatus((info) => {
    syncStateEl.textContent = info.message;
    syncStateEl.className = `sync-state ${info.state}`;
    syncDetailEl.textContent = info.fileLabel || "";
    sidebarDrive.hidden = !info.source;
    sidebarDrive.textContent = info.source === "shared" ? "Shared file" : (info.source === "own" ? "My Drive" : "");
    sidebarDrive.title = info.fileLabel || "";
    lastSyncValue = info.lastSyncAt || null;
    renderLastSync(lastSyncValue);
    connectBtn.hidden = !info.needsConnect;
    shareForm.hidden = !info.connected;
  });

  AppAuth.onAuthChange((info) => {
    auth = info;
    const profile = info.signedIn && info.profile && info.profile.sub ? info.profile : null;
    const canUseDrive = !!profile;
    sidebarUser.hidden = !profile;
    if (profile) {
      sidebarName.textContent = profile.name || "Signed in";
      if (profile.picture) {
        sidebarAvatar.src = profile.picture;
        sidebarAvatar.hidden = false;
      } else {
        sidebarAvatar.removeAttribute("src");
        sidebarAvatar.hidden = true;
      }
    }
    openSharedBtn.hidden = !canUseDrive;
    if (!canUseDrive) {
      connectBtn.hidden = true;
      shareForm.hidden = true;
    }
    showPage(location.hash.slice(1));
  });

  settingsSignoutBtn.addEventListener("click", () => AppAuth.signOut());

  connectBtn.addEventListener("click", async () => {
    inviteNote.textContent = "";
    openNote.textContent = "";
    try {
      await AppSync.connect();
    } catch (err) {
      inviteNote.textContent = err.message;
    }
  });

  openSharedBtn.addEventListener("click", async () => {
    openNote.textContent = "";
    try {
      const id = await AppSync.openPicker();
      if (id) openNote.textContent = "Opened the shared data file. Changes are now synced.";
    } catch (err) {
      openNote.textContent = err.message;
    }
  });

  shareForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = shareEmail.value.trim();
    if (!email) return;
    inviteNote.textContent = "Inviting…";
    try {
      await AppSync.share(email, "writer");
      shareEmail.value = "";
      inviteNote.textContent = `Invited ${email} as an editor.`;
    } catch (err) {
      inviteNote.textContent = err.message;
    }
  });

  // ---------- Online / offline indicator ----------
  function updateStatus() {
    const online = navigator.onLine;
    statusEl.textContent = online ? "Online" : "Offline";
    statusEl.classList.toggle("online", online);
    statusEl.classList.toggle("offline", !online);
  }
  window.addEventListener("online", updateStatus);
  window.addEventListener("offline", updateStatus);

  // ---------- Service worker ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const reg = await navigator.serviceWorker.register("sw.js");
        swState.textContent = "Offline-ready.";
        reg.addEventListener("updatefound", () => {
          swState.textContent = "Updating…";
        });
      } catch (err) {
        swState.textContent = "Offline mode unavailable.";
        console.error("Service worker registration failed:", err);
      }
    });
  } else {
    swState.textContent = "Service workers not supported.";
  }

  migrateLegacyTasks();
  updateStatus();
  showPage(location.hash.slice(1));
})();
