(() => {
  const PROFILE_KEY = "pwa-demo-profile";
  const CONSENT_KEY = "pwa-demo-drive-consent";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
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

  // ---------- Saved profile (display name + picture only) ----------
  function loadProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
      return p && typeof p.name === "string" ? p : null;
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

  // Decode the payload of a Google ID token (a JWT).
  // This app has no backend, so the result is used for display only, never for access control.
  // The `sub` claim is a stable account id, used only to key local Drive file references.
  function decodeJwt(token) {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)); // TextDecoder keeps non-Latin names intact
  }

  function state() {
    const profile = loadProfile();
    return {
      configured,
      googleReady,
      signedIn: !!profile,
      needsReauth: !!profile && !profile.sub,
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
      const holder = document.createElement("div");
      authEl.append(holder);
      google.accounts.id.renderButton(holder, {
        type: "standard",
        theme: "outline",
        size: "medium",
        text: "signin",
        shape: "pill"
      });
    }
  }

  function refresh() {
    const profile = loadProfile();
    if (profile) showSignedIn(profile);
    else showSignedOut();
  }

  // ---------- Google Identity Services ----------
  function onCredential(response) {
    try {
      const claims = decodeJwt(response.credential);
      if (claims.aud !== clientId || claims.exp * 1000 < Date.now()) {
        throw new Error("Unexpected ID token");
      }
      saveProfile({
        sub: claims.sub || "",
        name: claims.name || claims.given_name || claims.email || "Signed in",
        picture: claims.picture || ""
      });
      refresh();
      notify();
    } catch (err) {
      console.error("Google sign-in failed:", err);
      showSignedOut();
      authEl.append(note("Sign-in failed"));
    }
  }

  function initGoogle() {
    if (!window.google || !google.accounts || !google.accounts.id) {
      throw new Error("Google sign-in library did not load");
    }
    google.accounts.id.initialize({
      client_id: clientId,
      callback: onCredential,
      itp_support: true
    });
    googleReady = true;
    refresh();
    notify();
  }

  // Loaded from JS (not a static tag) so it can be retried after the device comes back online.
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
        try {
          initGoogle();
          resolve();
        } catch (err) {
          googlePromise = null;
          reject(err);
        }
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
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response && response.access_token) {
          accessToken = response.access_token;
          tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
          consentGranted = true;
          saveConsent(true);
          // Do not notify auth listeners here: a token refresh is not a sign-in change.
          if (pendingToken) {
            const pending = pendingToken;
            pendingToken = null;
            pending.resolve(accessToken);
          }
        } else {
          const pending = pendingToken;
          if (pending && !pending.retried && !pending.silentOnly && consentGranted) {
            pending.retried = true;
            requestToken("consent");
            return;
          }
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
          ? "Google's permission popup was blocked. Click Connect Drive again and allow popups for this site."
          : (type || "Google permission request failed");
        pending.reject(new Error(text));
      }
    });
  }

  // Access tokens are short-lived. Interactive requests must start in a user gesture,
  // otherwise the browser blocks Google's popup (popup_failed_to_open).
  // Background calls use silentOnly and simply fail if a fresh token cannot be obtained.
  async function getAccessToken(options = {}) {
    const silentOnly = options.silentOnly === true;
    const profile = loadProfile();
    if (!profile || !profile.sub) throw new Error("Sign in with Google to use Drive");
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;

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
      pendingToken = { resolve, reject, retried: false, silentOnly };
      try {
        requestToken(silentOnly ? "" : "consent");
      } catch (err) {
        pendingToken = null;
        reject(err);
      }
    });
  }

  function signOut() {
    if (googleReady) {
      google.accounts.id.disableAutoSelect();
      if (accessToken && google.accounts.oauth2 && google.accounts.oauth2.revoke) {
        google.accounts.oauth2.revoke(accessToken, () => {});
      }
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
    signOut
  };

  refresh();
  loadGoogle().catch(() => {});
})();
