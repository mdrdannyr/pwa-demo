(() => {
  const STORAGE_KEY = "pwa-demo-tasks";

  const form = document.getElementById("task-form");
  const input = document.getElementById("task-input");
  const list = document.getElementById("task-list");
  const empty = document.getElementById("empty");
  const statusEl = document.getElementById("status");
  const swState = document.getElementById("sw-state");
  const installBtn = document.getElementById("install-btn");

  // ---------- Tasks (saved in localStorage) ----------
  let tasks = [];

  function load() {
    try {
      tasks = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
      tasks = [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      /* storage unavailable; keep working in memory */
    }
  }

  function render() {
    list.replaceChildren();
    empty.hidden = tasks.length > 0;

    tasks.forEach((task) => {
      const li = document.createElement("li");
      if (task.done) li.classList.add("done");

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = task.done;
      check.setAttribute("aria-label", "Mark done");
      check.addEventListener("change", () => {
        task.done = check.checked;
        save();
        render();
      });

      const text = document.createElement("span");
      text.textContent = task.text;

      const del = document.createElement("button");
      del.className = "delete";
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        tasks = tasks.filter((t) => t.id !== task.id);
        save();
        render();
      });

      li.append(check, text, del);
      list.append(li);
    });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    tasks.unshift({ id: Date.now(), text: value, done: false });
    input.value = "";
    save();
    render();
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

  // ---------- Install prompt ----------
  let deferredPrompt = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });

  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    installBtn.hidden = true;
  });

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

  load();
  render();
  updateStatus();
})();
