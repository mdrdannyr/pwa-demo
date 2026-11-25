(() => {
  const PROFILE_KEY = "pwa-demo-profile";
  const CONSENT_KEY = "pwa-demo-drive-consent";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const SCOPES = `openid email profile ${DRIVE_SCOPE}`;
  const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
  const clientId = (window.APP_CONFIG && window.APP_CONFIG.googleClientId) || "";
  const configured = clientId !== "" && !clientId.startsWith("YOUR_");
  const authEl = document.getElementById("auth");

  let googleReady = false;
  let googlePromise = null;
  let tokenClient = null;
  let accessToken = "";
  let tokenExpiresAt = 0;
  let consentGranted = loadConsent();
  let pendingToken = null;
  const listeners = new Set();

  function loadConsent() {
    try {
      return localStorage.getItem(CONSENT_KEY) === "1";
    } catch {
      return false;
    }
  }

  function saveConsent(granted) {
    try {
      if (granted) localStorage.setItem(CONSENT_KEY, "1");
      else localStorage.removeItem(CONSENT_KEY);
    } catch {
      /* ignore */
    }
  }

  // Only a local display name/avatar and a stable account id are kept.
  function loadProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
      return p && typeof p.name === "string" && typeof p.sub === "string" ? p : null;
    } catch {
      return null;
    }
  }

  function saveProfile(profile) {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch {
      /* storage unavailable; the name just won't persist across reloads */
    }
  }

  function clearProfile() {
    try {
      localStorage.removeItem(PROFILE_KEY);
    } catch {
      /* ignore */
    }
  }

  function state() {
    const profile = loadProfile();
    return {
      configured,
      googleReady,
      signedIn: !!profile,
      profile
    };
  }

  function notify() {
    const snapshot = state();
    listeners.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (err) {
        console.error("Auth listener failed:", err);
      }
    });
  }

  // ---------- Rendering ----------
  function note(text) {
    const el = document.createElement("span");
    el.className = "auth-note";
    el.textContent = text;
    return el;
  }

  function showSignedIn(profile) {
    authEl.replaceChildren();

    if (profile.picture) {
      const img = document.createElement("img");
      img.className = "avatar";
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.src = profile.picture;
      img.addEventListener("error", () => img.remove());
      authEl.append(img);
    }

    const name = document.createElement("span");
    name.className = "user-name";
    name.textContent = profile.name;
    name.title = profile.name;

    const out = document.createElement("button");
    out.type = "button";
    out.className = "signout";
    out.textContent = "Sign out";
    out.addEventListener("click", signOut);

    authEl.append(name, out);
  }

  function showSignedOut() {
    authEl.replaceChildren();

    if (!configured) {
      authEl.append(note("Google sign-in not configured"));
    } else if (!googleReady) {
      authEl.append(note(navigator.onLine ? "Loading sign-in…" : "Sign-in needs a connection"));
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "google-connect";
      button.textContent = "Sign in & connect Drive";
      button.addEventListener("click", () => {
        connect().catch((err) => {
          authEl.append(note(err.message));
        });
      });
      authEl.append(button);
    }
  }

  function refresh() {
    const profile = loadProfile();
    if (profile) showSignedIn(profile);
    else showSignedOut();
  }

  // ---------- Google Identity Services (token model) ----------
  function requestToken(prompt) {
    if (!tokenClient) throw new Error("Google token client is unavailable");
    tokenClient.requestAccessToken({ prompt });
  }

  function initTokenClient() {
    if (!googleReady) throw new Error("Google sign-in is not ready");
    if (!google.accounts.oauth2 || !google.accounts.oauth2.initTokenClient) {
      throw new Error("Google token client is unavailable");
    }
    if (tokenClient) return;

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (response) => {
        const pending = pendingToken;
        if (response && response.access_token) {
          accessToken = response.access_token;
          tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
          consentGranted = true;
          saveConsent(true);
          if (pending) {
            pendingToken = null;
            pending.resolve(accessToken);
          }
        } else {
          const err = new Error(
            (response && (response.error_description || response.error)) || "Google did not return an access token"
          );
          if (pending) {
            pendingToken = null;
            pending.reject(err);
          }
        }
      },
      error_callback: (err) => {
        const pending = pendingToken;
        if (!pending) return;
        pendingToken = null;
        const type = err && err.type;
        const text = type === "popup_failed_to_open"
          ? "Google's permission popup was blocked. Allow popups for this site and try again."
          : (type || "Google permission request failed");
        pending.reject(new Error(text));
      }
    });
  }

  // Loaded from JS so it can be retried after the device comes back online.
  function loadGoogle() {
    if (googleReady) return Promise.resolve();
    if (googlePromise) return googlePromise;
    if (!configured) return Promise.reject(new Error("Google sign-in is not configured"));
    if (!navigator.onLine) return Promise.reject(new Error("Sign-in needs a connection"));

    googlePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = () => {
        if (!window.google || !google.accounts || !google.accounts.oauth2) {
          googlePromise = null;
          reject(new Error("Google sign-in library did not load"));
          return;
        }
        googleReady = true;
        refresh();
        notify();
        resolve();
      };
      script.onerror = () => {
        script.remove();
        googlePromise = null;
        refresh();
        reject(new Error("Could not load Google sign-in"));
      };
      document.head.append(script);
    });
    return googlePromise;
  }

  // Interactive requests must start in a user gesture, otherwise the popup is blocked.
  // Background calls use silentOnly and simply fail if a fresh token cannot be obtained.
  async function getAccessToken(options = {}) {
    const silentOnly = options.silentOnly === true;
    const prompt = typeof options.prompt === "string" ? options.prompt : (silentOnly ? "" : "consent");
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;
    if (silentOnly && !consentGranted) throw new Error("Drive permission has not been granted");

    if (!googleReady) {
      if (silentOnly) throw new Error("Google sign-in is not ready");
      await loadGoogle();
    }
    initTokenClient();

    return new Promise((resolve, reject) => {
      if (pendingToken) {
        reject(new Error("A Google permission request is already in progress"));
        return;
      }
      pendingToken = { resolve, reject };
      try {
        requestToken(prompt);
      } catch (err) {
        pendingToken = null;
        reject(err);
      }
    });
  }

  async function fetchUserInfo(token) {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error("Could not read your Google profile");
    const info = await res.json();
    if (!info || typeof info.sub !== "string") throw new Error("Google did not return an account id");
    return info;
  }

  // Try a silent renewal first. Only fall back to the consent popup when
  // Google no longer has a usable session, so reconnecting is normally quiet.
  async function connect() {
    if (!configured) throw new Error("Google sign-in is not configured");
    let token;
    try {
      token = await getAccessToken({ silentOnly: true });
    } catch {
      token = await getAccessToken({ prompt: "consent" });
    }
    const info = await fetchUserInfo(token);
    saveProfile({
      sub: info.sub,
      name: info.name || info.given_name || info.email || "Signed in",
      picture: info.picture || ""
    });
    refresh();
    notify();
    return token;
  }

  function signOut() {
    if (accessToken && google.accounts.oauth2 && google.accounts.oauth2.revoke) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = "";
    tokenExpiresAt = 0;
    consentGranted = false;
    saveConsent(false);
    tokenClient = null;
    clearProfile();
    refresh();
    notify();
  }

  window.addEventListener("online", () => {
    loadGoogle().catch(() => {});
    refresh();
  });
  window.addEventListener("offline", refresh);

  window.AppAuth = {
    onAuthChange(fn) {
      listeners.add(fn);
      fn(state());
      return () => listeners.delete(fn);
    },
    getState: state,
    getAccessToken,
    connect,
    signOut
  };

  refresh();
  loadGoogle().catch(() => {});
})();
