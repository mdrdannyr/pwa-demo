(() => {
  const PROFILE_KEY = "pwa-demo-profile";
  const clientId = (window.APP_CONFIG && window.APP_CONFIG.googleClientId) || "";
  const configured = clientId !== "" && !clientId.startsWith("YOUR_");
  const authEl = document.getElementById("auth");

  let googleReady = false;
  let loading = false;

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
  function decodeJwt(token) {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)); // TextDecoder keeps non-Latin names intact
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
        name: claims.name || claims.given_name || claims.email || "Signed in",
        picture: claims.picture || ""
      });
      refresh();
    } catch (err) {
      console.error("Google sign-in failed:", err);
      showSignedOut();
      authEl.append(note("Sign-in failed"));
    }
  }

  function initGoogle() {
    if (!window.google || !google.accounts || !google.accounts.id) return;
    google.accounts.id.initialize({
      client_id: clientId,
      callback: onCredential,
      itp_support: true
    });
    googleReady = true;
    refresh();
  }

  // Loaded from JS (not a static tag) so it can be retried after the device comes back online.
  function loadGoogle() {
    if (googleReady || loading || !configured || !navigator.onLine) return;
    loading = true;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      loading = false;
      initGoogle();
    };
    script.onerror = () => {
      loading = false;
      script.remove();
      refresh();
    };
    document.head.append(script);
  }

  function signOut() {
    if (googleReady) google.accounts.id.disableAutoSelect();
    clearProfile();
    refresh();
  }

  window.addEventListener("online", () => {
    loadGoogle();
    refresh();
  });
  window.addEventListener("offline", refresh);

  refresh();
  loadGoogle();
})();
