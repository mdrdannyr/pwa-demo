/*
 * Generic app-state sync backed by the user's own Google Drive.
 *
 * The document is app-agnostic JSON:
 *
 *   {
 *     "format": "app-state-v1",
 *     "clock": 12,
 *     "values":   { "theme": { "value": "dark", "rev": { "t": 4, "by": "actor" } } },
 *     "collections": {
 *       "tasks": {
 *         "task-id": {
 *           "text":    { "value": "Buy milk", "rev": { "t": 7, "by": "actor" } },
 *           "done":    { "value": false, "rev": { "t": 8, "by": "actor" } },
 *           "deleted": { "value": false, "rev": { "t": 2, "by": "actor" } }
 *         }
 *       }
 *     }
 *   }
 *
 * Every field is a last-write-wins register ordered by a Lamport clock plus a
 * random actor id. Merging two documents therefore never loses a whole file,
 * and any app can store its own collections without changing this module.
 *
 * Public API (window.AppSync):
 *   onChange(fn)             -> fn({ values, collections }) now and on every local/remote change
 *   onStatus(fn)             -> fn({ state, message, connected, fileId }) now and on status changes
 *   state()                  -> current plain state
 *   list(collection)         -> plain records (non-deleted), each with an `id`
 *   get(collection, id)      -> plain record or null
 *   upsert(collection, id, patch)
 *   remove(collection, id)
 *   set(key, value)          -> top-level value register
 *   syncNow()                -> pull + push immediately
 *   openPicker()             -> choose an existing (shared) state file in Drive
 *   share(email, role)       -> invite a collaborator; role: reader|commenter|writer
 *   status()
 */
(() => {
  const config = window.APP_CONFIG || {};
  const FORMAT = "app-state-v1";
  const DOC_KEY = "pwa-demo-sync-doc";
  const ACTOR_KEY = "pwa-demo-sync-actor";
  const FILE_KEY = "pwa-demo-drive-file:";
  const ETAG_KEY = "pwa-demo-drive-etag:";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
  const POLL_MS = 15000;
  const fileName = config.driveFileName || "PWA Demo state.json";
  const apiKey = config.googleDriveApiKey || "";
  const appId = (config.googleClientId || "").split("-")[0] || "";

  let doc = loadDoc();
  let actor = loadActor();
  let profile = null;
  let fileId = null;
  let etag = null;
  let dirty = true;
  let syncing = false;
  let queued = false;
  let authGeneration = 0;
  let pushTimer = null;
  let pollTimer = null;
  let syncState = "local";
  let message = "Local only — sign in to back up in Drive.";
  let needsConnect = false;

  const stateListeners = new Set();
  const statusListeners = new Set();

  // ---------- Local document helpers ----------
  function emptyDoc() {
    return { format: FORMAT, clock: 0, values: {}, collections: {} };
  }

  function clone(value) {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  }

  function loadActor() {
    try {
      let id = localStorage.getItem(ACTOR_KEY);
      if (!id) {
        id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random());
        localStorage.setItem(ACTOR_KEY, id);
      }
      return id;
    } catch {
      return String(Date.now() + Math.random());
    }
  }

  function normalizeRegister(raw) {
    if (!raw || typeof raw !== "object" || !raw.rev || typeof raw.rev !== "object") return null;
    const t = Number(raw.rev.t);
    if (!Number.isFinite(t)) return null;
    return {
      value: clone(raw.value),
      rev: { t, by: typeof raw.rev.by === "string" ? raw.rev.by : "unknown" }
    };
  }

  function normalizeDoc(raw) {
    const out = emptyDoc();
    if (!raw || typeof raw !== "object") return out;
    out.clock = Number.isFinite(Number(raw.clock)) ? Number(raw.clock) : 0;

    if (raw.values && typeof raw.values === "object") {
      Object.entries(raw.values).forEach(([key, value]) => {
        const reg = normalizeRegister(value);
        if (reg) out.values[key] = reg;
      });
    }
    if (raw.collections && typeof raw.collections === "object") {
      Object.entries(raw.collections).forEach(([name, records]) => {
        if (!records || typeof records !== "object") return;
        out.collections[name] = {};
        Object.entries(records).forEach(([id, fields]) => {
          if (!fields || typeof fields !== "object") return;
          const clean = {};
          Object.entries(fields).forEach(([field, value]) => {
            const reg = normalizeRegister(value);
            if (reg) clean[field] = reg;
          });
          out.collections[name][id] = clean;
        });
      });
    }
    return out;
  }

  function parseDoc(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("The Drive file does not contain valid JSON");
    }
    if (!raw || raw.format !== FORMAT) {
      throw new Error("That file is not a PWA Demo app-state file");
    }
    return normalizeDoc(raw);
  }

  function loadDoc() {
    try {
      const raw = localStorage.getItem(DOC_KEY);
      return raw ? normalizeDoc(JSON.parse(raw)) : emptyDoc();
    } catch {
      return emptyDoc();
    }
  }

  function saveLocal() {
    try {
      localStorage.setItem(DOC_KEY, JSON.stringify(doc));
    } catch (err) {
      console.warn("Could not save app state locally:", err);
    }
  }

  function nextRev() {
    doc.clock = (Number(doc.clock) || 0) + 1;
    return { t: doc.clock, by: actor };
  }

  function observeRev(rev) {
    if (!rev) return;
    doc.clock = Math.max(Number(doc.clock) || 0, Number(rev.t) || 0);
  }

  function wins(a, b) {
    if (!a) return false;
    if (!b) return true;
    return a.rev.t > b.rev.t || (a.rev.t === b.rev.t && a.rev.by > b.rev.by);
  }

  // Merge `incoming` into `doc`, keeping the winning register for every field.
  function mergeInto(incoming) {
    let changed = false;

    Object.entries(incoming.values).forEach(([key, reg]) => {
      observeRev(reg.rev);
      if (wins(reg, doc.values[key])) {
        doc.values[key] = reg;
        changed = true;
      }
    });

    Object.entries(incoming.collections).forEach(([name, records]) => {
      const target = doc.collections[name] || (doc.collections[name] = {});
      Object.entries(records).forEach(([id, fields]) => {
        const current = target[id] || (target[id] = {});
        Object.entries(fields).forEach(([field, reg]) => {
          observeRev(reg.rev);
          if (wins(reg, current[field])) {
            current[field] = reg;
            changed = true;
          }
        });
      });
    });

    if (changed) saveLocal();
    return changed;
  }

  function isDeleted(fields) {
    return !!(fields.deleted && fields.deleted.value === true);
  }

  function plainRecord(fields, id) {
    const out = { id };
    Object.entries(fields).forEach(([field, reg]) => {
      if (field !== "id") out[field] = clone(reg.value);
    });
    return out;
  }

  function state() {
    const values = {};
    Object.entries(doc.values).forEach(([key, reg]) => {
      values[key] = clone(reg.value);
    });

    const collections = {};
    Object.entries(doc.collections).forEach(([name, records]) => {
      collections[name] = Object.entries(records)
        .filter(([, fields]) => !isDeleted(fields))
        .map(([id, fields]) => plainRecord(fields, id));
    });
    return { values, collections };
  }

  function getAnyRaw(collection, id) {
    return (doc.collections[collection] && doc.collections[collection][id]) || null;
  }

  function getRaw(collection, id) {
    const record = getAnyRaw(collection, id);
    if (!record || isDeleted(record)) return null;
    return record;
  }

  function emitState() {
    const snapshot = state();
    stateListeners.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (err) {
        console.error("Sync state listener failed:", err);
      }
    });
  }

  function status() {
    return {
      state: syncState,
      message,
      connected: !!fileId,
      needsConnect,
      fileId,
      fileName: fileId ? fileName : ""
    };
  }

  function emitStatus() {
    const snapshot = status();
    statusListeners.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (err) {
        console.error("Sync status listener failed:", err);
      }
    });
  }

  function setStatus(nextState, nextMessage) {
    syncState = nextState;
    message = nextMessage;
    needsConnect = !!profile && (nextState === "ready" || nextState === "error");
    emitStatus();
  }

  function changed() {
    dirty = true;
    saveLocal();
    emitState();
    schedulePush();
  }

  // ---------- Drive helpers ----------
  function etagFor(id) {
    if (!id) return "";
    try {
      return localStorage.getItem(ETAG_KEY + id) || "";
    } catch {
      return "";
    }
  }

  function rememberEtag(value, id = fileId) {
    if (!id) return;
    try {
      if (value) localStorage.setItem(ETAG_KEY + id, value);
      else localStorage.removeItem(ETAG_KEY + id);
    } catch {
      /* ignore */
    }
  }

  async function api(path, options = {}, tokenOptions = { silentOnly: true }) {
    const token = await window.AppAuth.getAccessToken(tokenOptions);
    return fetch(`${DRIVE_API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
    });
  }

  async function check(res, action) {
    if (res.ok) return res;
    let detail = "";
    try {
      const body = await res.json();
      const error = body.error || {};
      detail = error.message || (error.errors && error.errors[0] && error.errors[0].reason) || "";
    } catch {
      /* ignore */
    }
    const err = new Error(`${action} failed (${res.status})${detail ? ": " + detail : ""}`);
    err.status = res.status;
    throw err;
  }

  async function findOrCreateFile() {
    const escapedName = fileName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = encodeURIComponent(`name = '${escapedName}' and trashed = false`);
    const res = await api(`/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime)&pageSize=20`);
    await check(res, "Searching Drive");
    const json = await res.json();
    const files = json.files || [];
    if (files.length) {
      files.sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0));
      return files[0].id;
    }

    const token = await window.AppAuth.getAccessToken({ silentOnly: true });
    const boundary = `----pwa-state-${Date.now().toString(36)}`;
    const metadata = {
      name: fileName,
      mimeType: "application/json",
      parents: ["root"],
      description: "Generic app-state document (app-state-v1) for this PWA"
    };
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      "Content-Type: application/json",
      "",
      JSON.stringify(doc),
      `--${boundary}--`,
      ""
    ].join("\r\n");

    const created = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,modifiedTime`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body
    });
    await check(created, "Creating Drive file");
    const jsonCreated = await created.json();
    rememberEtag(created.headers.get("ETag"), jsonCreated.id);
    return jsonCreated.id;
  }

  // Returns null when the file is unchanged (HTTP 304), otherwise a document.
  async function fetchFile(id, conditionalEtag) {
    const token = await window.AppAuth.getAccessToken({ silentOnly: true });
    const headers = { Authorization: `Bearer ${token}` };
    if (conditionalEtag) headers["If-None-Match"] = conditionalEtag;
    const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`, { headers });
    if (res.status === 304) return null;
    if (res.status === 404) {
      const err = new Error("The Drive file no longer exists");
      err.status = 404;
      throw err;
    }
    await check(res, "Reading Drive file");
    const remote = parseDoc(await res.text());
    rememberEtag(res.headers.get("ETag") || conditionalEtag, id);
    return remote;
  }

  function applyRemote(remote) {
    if (mergeInto(remote)) emitState();
  }

  async function upload() {
    let attempts = 0;
    while (attempts++ < 4) {
      const token = await window.AppAuth.getAccessToken({ silentOnly: true });
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      };
      const currentEtag = etagFor(fileId);
      if (currentEtag) headers["If-Match"] = currentEtag;

      const res = await fetch(
        `${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,modifiedTime`,
        { method: "PATCH", headers, body: JSON.stringify(doc) }
      );

      if (res.status === 412) {
        const remote = await fetchFile(fileId, "");
        if (remote) applyRemote(remote);
        continue;
      }
      await check(res, "Saving to Drive");
      rememberEtag(res.headers.get("ETag") || currentEtag);
      dirty = false;
      return;
    }
    throw new Error("Could not save after repeated conflicting edits");
  }

  async function runSync(mode) {
    if (!profile || !fileId) return;
    if (syncing) {
      queued = true;
      return;
    }
    if (!navigator.onLine) {
      setStatus("offline", "Offline — changes are saved locally.");
      return;
    }

    syncing = true;
    setStatus("syncing", mode === "pull" ? "Checking Drive for changes…" : "Saving to Drive…");
    try {
      if (mode === "pull") {
        const remote = await fetchFile(fileId, etagFor(fileId));
        if (remote) applyRemote(remote);
      }
      if (dirty || mode === "push") await upload();
      setStatus("synced", `Synced to your Google Drive · ${fileName}`);
    } catch (err) {
      if (err.status === 404) {
        fileId = null;
        rememberEtag("", fileId);
        try {
          localStorage.removeItem(FILE_KEY + profile.sub);
        } catch {
          /* ignore */
        }
        setStatus("error", "The Drive file was removed. Reconnect to create a new one.");
      } else {
        setStatus(navigator.onLine ? "error" : "offline", readableError(err));
      }
    } finally {
      syncing = false;
      if (queued) {
        queued = false;
        schedulePush();
      }
    }
  }

  function readableError(err) {
    const text = String((err && err.message) || err);
    if (text.includes("serviceDisabled")) {
      return "The Google Drive API is not enabled for this Cloud project. Enable it in Google Cloud Console, then reconnect.";
    }
    if (text.includes("insufficientPermissions") || text.includes("forbidden")) {
      return `Google denied access to the Drive file: ${text}`;
    }
    return text;
  }

  function schedulePush() {
    if (!profile || !fileId || !navigator.onLine) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => runSync("push"), 400);
  }

  function startPoll() {
    clearInterval(pollTimer);
    if (!profile || !fileId) return;
    pollTimer = setInterval(() => {
      if (navigator.onLine) runSync("pull");
    }, POLL_MS);
  }

  function stopPoll() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---------- Auth lifecycle ----------
  async function finishConnect(generation) {
    if (!fileId) {
      fileId = await findOrCreateFile();
      try {
        localStorage.setItem(FILE_KEY + profile.sub, fileId);
      } catch {
        /* ignore */
      }
    }
    if (generation !== authGeneration || !fileId) return;

    const remote = await fetchFile(fileId, etagFor(fileId));
    if (generation !== authGeneration) return;
    if (remote) applyRemote(remote);

    await upload();
    if (generation !== authGeneration) return;
    setStatus("synced", `Synced to your Google Drive · ${fileName}`);
    startPoll();
  }

  // Must be called directly from a click handler: Google's OAuth popup needs a user gesture.
  function connect() {
    if (!profile) return Promise.reject(new Error("Sign in with Google first"));
    const generation = ++authGeneration;
    setStatus("connecting", "Opening Google permission…");
    return window.AppAuth.getAccessToken()
      .then(() => finishConnect(generation))
      .catch((err) => {
        if (generation === authGeneration) setStatus("error", readableError(err));
      });
  }

  function handleAuth(auth) {
    const next = auth.signedIn && auth.profile && auth.profile.sub ? auth.profile : null;
    profile = next;
    stopPoll();
    dirty = true;

    if (!profile) {
      fileId = null;
      etag = null;
      setStatus("local", auth.signedIn ? "Sign in again to enable Drive sync." : "Local only — sign in to back up in Drive.");
      return;
    }

    try {
      fileId = localStorage.getItem(FILE_KEY + profile.sub) || null;
    } catch {
      fileId = null;
    }
    etag = etagFor(fileId);
    setStatus("connecting", "Checking saved Drive access…");

    const generation = ++authGeneration;
    // Silent renewal only here: no popup outside a user gesture.
    window.AppAuth.getAccessToken({ silentOnly: true })
      .then(() => finishConnect(generation))
      .catch(() => {
        if (generation !== authGeneration) return;
        setStatus("ready", fileId
          ? "Click Connect Drive to resume syncing."
          : "Click Connect Drive to back up in Drive.");
      });
  }

  // ---------- Picker (needed by drive.file to access a file shared by someone else) ----------
  function loadPicker() {
    if (window.google && window.google.picker) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://apis.google.com/js/api.js";
      script.onload = () => {
        if (!window.gapi) {
          reject(new Error("Google Picker library did not load"));
          return;
        }
        gapi.load("picker", resolve);
      };
      script.onerror = () => reject(new Error("Could not load Google Picker"));
      document.head.append(script);
    });
  }

  async function openPicker() {
    if (!profile) throw new Error("Sign in with Google first");
    if (!apiKey || apiKey.startsWith("YOUR_")) {
      throw new Error("Add a Google API key as googleDriveApiKey in config.js to open shared files");
    }
    const token = await window.AppAuth.getAccessToken();
    await loadPicker();

    return new Promise((resolve, reject) => {
      const myDrive = new google.picker.DocsView(google.picker.ViewId.DOCS);
      myDrive.setMimeTypes("application/json");

      const shared = new google.picker.DocsView();
      shared.setMimeTypes("application/json");
      if (typeof shared.setOwnedByMe === "function") shared.setOwnedByMe(false);
      if (typeof shared.setMode === "function") shared.setMode(google.picker.DocsViewMode.LIST);

      const picker = new google.picker.PickerBuilder()
        .setAppId(appId)
        .setDeveloperKey(apiKey)
        .setOAuthToken(token)
        .addView(myDrive)
        .addView(shared)
        .setTitle("Choose a shared PWA Demo state file")
        .setCallback(async (data) => {
          if (data.action === google.picker.Action.CANCEL) {
            resolve(null);
            return;
          }
          if (data.action !== google.picker.Action.PICKED) return;
          try {
            const id = data.docs[0].id;
            const remote = await fetchFile(id, "");
            if (!remote) throw new Error("That file is empty");
            applyRemote(remote);
            fileId = id;
            try {
              localStorage.setItem(FILE_KEY + profile.sub, id);
            } catch {
              /* ignore */
            }
            setStatus("syncing", "Merging with the shared file…");
            await upload();
            setStatus("synced", `Synced to the shared file · ${fileName}`);
            startPoll();
            resolve(id);
          } catch (err) {
            reject(readableError(err));
          }
        })
        .build();
      picker.setVisible(true);
    });
  }

  async function share(email, role = "writer") {
    if (!profile || !fileId) throw new Error("Connect Drive before inviting collaborators");
    const allowed = ["reader", "commenter", "writer"];
    const chosenRole = allowed.includes(role) ? role : "writer";
    const res = await api(`/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user", role: chosenRole, emailAddress: email })
    }, { silentOnly: false });
    await check(res, "Sharing Drive file");
    return res.json();
  }

  // ---------- Public API ----------
  window.AppSync = {
    onChange(fn) {
      stateListeners.add(fn);
      fn(state());
      return () => stateListeners.delete(fn);
    },
    onStatus(fn) {
      statusListeners.add(fn);
      fn(status());
      return () => statusListeners.delete(fn);
    },
    state,
    status,
    list(collection) {
      return state().collections[collection] || [];
    },
    get(collection, id) {
      const raw = getRaw(collection, id);
      return raw ? plainRecord(raw, id) : null;
    },
    upsert(collection, id, patch) {
      if (!collection || !id) throw new Error("A collection and id are required");
      const record = getAnyRaw(collection, id) || {};
      if (isDeleted(record)) record.deleted = { value: false, rev: nextRev() };
      Object.entries(patch || {}).forEach(([field, value]) => {
        if (field === "id") return;
        record[field] = { value: clone(value), rev: nextRev() };
      });
      doc.collections[collection] = doc.collections[collection] || {};
      doc.collections[collection][id] = record;
      changed();
    },
    remove(collection, id) {
      const record = getRaw(collection, id);
      if (!record) return;
      record.deleted = { value: true, rev: nextRev() };
      changed();
    },
    set(key, value) {
      if (!key) throw new Error("A key is required");
      doc.values[key] = { value: clone(value), rev: nextRev() };
      changed();
    },
    syncNow() {
      return runSync("pull");
    },
    connect,
    openPicker,
    share
  };

  window.AppAuth.onAuthChange(handleAuth);
  window.addEventListener("online", () => {
    if (profile && fileId) runSync("pull");
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== DOC_KEY || !event.newValue) return;
    try {
      const incoming = normalizeDoc(JSON.parse(event.newValue));
      if (mergeInto(incoming)) emitState();
    } catch {
      /* ignore malformed cross-tab data */
    }
  });
})();
