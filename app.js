
/***************************************************************
 * KINTRACK — UPDATED DASHBOARD APPLICATION
 * Firebase SDK: 10.14.1
 * Firebase project: kintrack-app-38c0a
 * Functions region: africa-south1
 *
 * Compatible with the redesigned KinTrack index.html.
 *
 * FEATURES
 * - Firebase email/password authentication
 * - Firestore connection recovery
 * - Consent-based location sharing
 * - Google Maps: roadmap, satellite, hybrid and terrain
 * - Live consenting participant markers
 * - Session restoration
 * - Invitation creation and joining
 * - Asset registration and management
 * - Asset export and deletion
 * - Subscription monitoring
 * - M-Pesa checkout through Firebase Functions
 *
 * IMPORTANT
 * - No covert tracking.
 * - No automatic contact uploads.
 * - No browser-only background tracking promises.
 * - Existing Firestore paths and callable function names retained.
 ***************************************************************/


/* =============================================================
   1. FIREBASE IMPORTS
============================================================= */

import { initializeApp } from
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  updateProfile,
  signOut
} from
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import {
  initializeFirestore,
  enableNetwork,
  doc,
  setDoc,
  getDocFromServer,
  addDoc,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  deleteDoc,
  getDocs
} from
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import {
  getFunctions,
  httpsCallable
} from
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";


/* =============================================================
   2. CONFIGURATION AND APPLICATION STATE
============================================================= */

const cfg = window.KINTRACK_CONFIG || {};
const $ = id => document.getElementById(id);

const state = {
  user: null,
  mode: "register",
  busy: false,

  shareId: sessionStorage.getItem("ktShareId") || "",
  inviteCode: "",

  watchId: null,
  expiryTimer: null,

  map: null,
  markers: new Map(),

  unsubscribers: [],
  shareUnsubscribers: [],
  locationUnsub: null,

  activeLocations: new Map(),
  currentPosition: null,

  networkOnline: navigator.onLine,
  authReady: false,
  locationStarting: false,

  mapReady: false,
  lastMapBoundsUpdate: 0
};

let app;
let auth;
let db;
let functions;


/* =============================================================
   3. GENERAL UTILITIES
============================================================= */

function say(id, message) {
  const element = $(id);
  if (element) element.textContent = message;
}

function setButtonBusy(id, busy, busyText = "Please wait…") {
  const button = $(id);
  if (!button) return;

  if (busy) {
    button.dataset.originalText ||= button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;

    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function logActivity(title, detail = "") {
  const activity = $("activity");
  if (!activity) return;

  const row = document.createElement("div");
  row.className = "person";

  const left = document.createElement("div");
  const strong = document.createElement("strong");
  const small = document.createElement("small");

  strong.textContent = title;
  small.textContent = detail || new Date().toLocaleString();

  left.append(strong, small);

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = "Activity";

  row.append(left, tag);
  activity.prepend(row);

  while (activity.children.length > 8) {
    activity.lastElementChild.remove();
  }
}

function showEmptyList(id, message) {
  const element = $(id);
  if (!element) return;

  element.replaceChildren();

  const paragraph = document.createElement("p");
  paragraph.textContent = message;

  element.append(paragraph);
}

function formatDate(value) {
  if (!value) return "Not specified";

  const date = value?.toDate
    ? value.toDate()
    : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not specified";
  }

  return date.toLocaleDateString();
}

function safeText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}


/* =============================================================
   4. DASHBOARD NAVIGATION
============================================================= */

const dashboardTabs = [
  "overview",
  "consent",
  "billing",
  "privacy"
];

const tabTitles = {
  overview: "Dashboard overview",
  consent: "Location & sharing",
  billing: "Subscription & billing",
  privacy: "Privacy centre"
};

function setTab(name) {
  if (!dashboardTabs.includes(name)) return;

  document.querySelectorAll("[data-tab]").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.tab === name
    );
  });

  dashboardTabs.forEach(tab => {
    const section = $("tab-" + tab);

    if (section) {
      section.classList.toggle("hidden", tab !== name);
    }
  });

  say("pageTitle", tabTitles[name]);

  $("sidebar")?.classList.remove("open");
  $("mobileMenu")?.setAttribute("aria-expanded", "false");
}

document.querySelectorAll("[data-tab]").forEach(button => {
  button.addEventListener("click", () => {
    setTab(button.dataset.tab);
  });
});

$("mobileMenu")?.addEventListener("click", () => {
  const sidebar = $("sidebar");
  if (!sidebar) return;

  const open = sidebar.classList.toggle("open");

  $("mobileMenu").setAttribute(
    "aria-expanded",
    String(open)
  );
});

$("topAccountBtn")?.addEventListener("click", () => {
  $("accountBtn")?.click();
});


/* =============================================================
   5. ERROR HANDLING
============================================================= */

function friendlyError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "");

  const errors = {
    "auth/email-already-in-use":
      "This email already has an account. Please sign in.",

    "auth/invalid-credential":
      "Email or password is incorrect.",

    "auth/weak-password":
      "Use a stronger password with at least 12 characters.",

    "auth/too-many-requests":
      "Too many attempts. Wait a moment and try again.",

    "auth/network-request-failed":
      "Authentication network error. Check your connection.",

    "permission-denied":
      "Access denied by Firebase security rules.",

    "functions/unauthenticated":
      "Please sign in first.",

    "functions/permission-denied":
      "You do not have permission to perform this action.",

    "functions/not-found":
      "The requested sharing session or record was not found.",

    "functions/failed-precondition":
      "This operation cannot be completed in the current state.",

    "unavailable":
      "Firebase is temporarily unavailable. Check your connection.",

    "deadline-exceeded":
      "The Firebase request timed out. Please retry.",

    "failed-precondition":
      "The requested operation cannot be completed in the current state."
  };

  if (errors[code]) return errors[code];

  const lower = message.toLowerCase();

  if (
    lower.includes("err_connection_closed") ||
    lower.includes("client is offline") ||
    lower.includes("network")
  ) {
    return "Connection interrupted. Check your internet and retry.";
  }

  if (lower.includes("missing or insufficient permissions")) {
    return "Firebase denied this operation. Check your Firestore rules.";
  }

  return message || "Something went wrong. Please try again.";
}

function reportError(target, error, prefix = "") {
  console.error("KINTRACK_ERROR", {
    operation: prefix || "Application",
    code: error?.code || "unknown",
    name: error?.name || "Error",
    message: error?.message || String(error),
    online: navigator.onLine,
    shareId: state.shareId || null,
    uid: state.user?.uid || null
  });

  say(
    target,
    (prefix ? prefix + ": " : "") + friendlyError(error)
  );
}

function isRetryableFirestoreError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();

  return [
    "unavailable",
    "deadline-exceeded",
    "aborted",
    "cancelled"
  ].includes(code) ||
    message.includes("err_connection_closed") ||
    message.includes("client is offline") ||
    message.includes("network");
}


/* =============================================================
   6. FIRESTORE SERVER READ WITH RETRIES
============================================================= */

async function readServerDocument(
  reference,
  operation = "Firestore read",
  attempts = 3
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getDocFromServer(reference);

    } catch (error) {
      lastError = error;

      console.error("KINTRACK_FIRESTORE_READ", {
        operation,
        attempt,
        attempts,
        code: error?.code || "unknown",
        message: error?.message || String(error),
        online: navigator.onLine,
        path: reference?.path || "unknown"
      });

      if (
        !isRetryableFirestoreError(error) ||
        attempt === attempts
      ) {
        throw error;
      }

      if (!navigator.onLine) {
        throw error;
      }

      await new Promise(resolve =>
        setTimeout(resolve, 700 * attempt)
      );
    }
  }

  throw lastError;
}


/* =============================================================
   7. NETWORK MONITORING
============================================================= */

function updateNetworkStatus(online) {
  state.networkOnline = online;

  const message = online
    ? "Internet connection available."
    : "You are offline. Live location updates are paused.";

  say("networkStatus", message);
  say("connectionStatus", message);

  if (!online) {
    say(
      "locationStatus",
      "Connection lost. Reconnect before continuing live sharing."
    );
  }
}

window.addEventListener("offline", () => {
  updateNetworkStatus(false);
});

window.addEventListener("online", async () => {
  updateNetworkStatus(true);

  if (!db) return;

  try {
    await enableNetwork(db);

    console.info("KinTrack: Firestore network restored.");

    if (state.user && state.shareId) {
      await restoreSharingSession(state.user);
    }

  } catch (error) {
    console.error("Firestore reconnection failed:", error);
  }
});


/* =============================================================
   8. AUTHENTICATION
============================================================= */

function showAuth(mode = "register") {
  state.mode = mode;

  if ($("termsConsent")) {
    $("termsConsent").required = mode === "register";
  }

  $("authOverlay")?.classList.remove("hidden");

  say(
    "authTitle",
    mode === "register" ? "Join KinTrack" : "Welcome back"
  );

  say(
    "authIntro",
    mode === "register"
      ? "Create an account to manage your assets and sharing preferences."
      : "Sign in to access your account."
  );

  $("registerFields")?.classList.toggle(
    "hidden",
    mode !== "register"
  );

  if ($("fullName")) {
    $("fullName").required = mode === "register";
  }

  if ($("password")) {
    $("password").minLength = mode === "register" ? 12 : 1;

    $("password").autocomplete =
      mode === "register"
        ? "new-password"
        : "current-password";
  }

  if ($("authSubmit")) {
    $("authSubmit").textContent =
      mode === "register" ? "Create account" : "Sign in";
  }

  if ($("switchAuth")) {
    $("switchAuth").textContent =
      mode === "register" ? "Sign in" : "Create account";
  }

  say("authMessage", "");
}

$("switchAuth")?.addEventListener("click", () => {
  showAuth(
    state.mode === "register" ? "login" : "register"
  );
});

$("authForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  if (state.busy) return;

  if (!cfg.firebase?.apiKey) {
    say(
      "authMessage",
      "Firebase configuration is missing. Check firebase-config.js."
    );
    return;
  }

  state.busy = true;
  setButtonBusy("authSubmit", true, "Connecting…");

  say("authMessage", "Connecting securely…");

  try {
    const email = $("email")?.value.trim();
    const password = $("password")?.value || "";

    if (!email || !password) {
      throw new Error("Enter your email and password.");
    }

    if (state.mode === "register") {
      if (!$("termsConsent")?.checked) {
        throw new Error(
          "Please accept the account terms and privacy notice."
        );
      }

      const name = $("fullName")?.value.trim();

      if (!name) {
        throw new Error("Enter your full name.");
      }

      const credential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      await updateProfile(credential.user, {
        displayName: name
      });

      await setDoc(
        doc(db, "users", credential.user.uid),
        {
          displayName: name,
          email: credential.user.email,
          phone: $("authPhone")?.value.trim() || "",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      );

      say("authMessage", "Account created successfully.");

    } else {
      await signInWithEmailAndPassword(
        auth,
        email,
        password
      );

      say("authMessage", "Signed in successfully.");
    }

  } catch (error) {
    reportError("authMessage", error);

  } finally {
    state.busy = false;
    setButtonBusy("authSubmit", false);
  }
});

$("accountBtn")?.addEventListener("click", () => {
  if (!state.user) {
    showAuth("login");
  } else {
    setTab("privacy");
  }
});

$("signOutBtn")?.addEventListener("click", async () => {
  try {
    await stopLocationWatch(true);
    await signOut(auth);

  } catch (error) {
    reportError("authMessage", error, "Sign out failed");
  }
});


/* =============================================================
   9. GOOGLE MAPS INITIALIZATION
============================================================= */

function loadGoogleMaps() {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) {
      resolve();
      return;
    }

    if (window.__kinTrackMapsLoading) {
      window.__kinTrackMapsLoading.then(resolve).catch(reject);
      return;
    }

    const key = cfg.mapsApiKey;

    if (!key || key.startsWith("REPLACE_")) {
      reject(new Error(
        "Google Maps key is missing from firebase-config.js."
      ));
      return;
    }

    window.__kinTrackMapsLoading = new Promise(
      (innerResolve, innerReject) => {
        const script = document.createElement("script");

        script.src =
          "https://maps.googleapis.com/maps/api/js" +
          `?key=${encodeURIComponent(key)}` +
          "&loading=async&callback=__kinTrackMapReady";

        script.async = true;

        window.__kinTrackMapReady = innerResolve;

        script.onerror = () => {
          innerReject(
            new Error(
              "Google Maps failed to load. Check API key restrictions and billing."
            )
          );
        };

        document.head.appendChild(script);

        setTimeout(() => {
          if (!window.google?.maps) {
            innerReject(
              new Error("Google Maps loading timed out.")
            );
          }
        }, 20000);
      }
    );

    window.__kinTrackMapsLoading.then(resolve).catch(reject);
  });
}

async function initMap() {
  try {
    await loadGoogleMaps();

    const mapElement = $("map");

    if (!mapElement) {
      console.warn("KinTrack: Map element #map was not found.");
      return;
    }

    state.map = new google.maps.Map(mapElement, {
      center: {
        lat: -1.286389,
        lng: 36.817223
      },

      zoom: 11,

      mapTypeId: "hybrid",

      mapTypeControl: true,

      mapTypeControlOptions: {
        style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
        position: google.maps.ControlPosition.TOP_RIGHT,

        mapTypeIds: [
          "roadmap",
          "satellite",
          "hybrid",
          "terrain"
        ]
      },

      streetViewControl: false,
      fullscreenControl: true,
      clickableIcons: false,
      gestureHandling: "greedy"
    });

    state.mapReady = true;

    say(
      "mapStatus",
      "Map ready. Locations appear only after participants consent."
    );

    drawLocations(state.activeLocations);

  } catch (error) {
    reportError("mapStatus", error);
  }
}


/* =============================================================
   10. MAP MARKERS AND PARTICIPANT DISPLAY
============================================================= */

function validCoordinates(data) {
  return (
    Number.isFinite(data?.lat) &&
    Number.isFinite(data?.lng) &&
    data.lat >= -90 &&
    data.lat <= 90 &&
    data.lng >= -180 &&
    data.lng <= 180
  );
}

function createParticipantRow(uid, position) {
  const row = document.createElement("div");
  row.className = "person";

  const info = document.createElement("div");
  const name = document.createElement("strong");
  const meta = document.createElement("small");

  name.textContent =
    position.displayName ||
    (uid === state.user?.uid ? "You" : "Participant");

  const accuracy = Number.isFinite(position.accuracy)
    ? Math.round(position.accuracy)
    : null;

  const timestamp = position.updatedAt?.toDate
    ? position.updatedAt.toDate()
    : null;

  meta.textContent =
    `Location shared · accuracy ${
      accuracy === null ? "unknown" : "±" + accuracy + " m"
    } · updated ${
      timestamp ? timestamp.toLocaleTimeString() : "recently"
    }`;

  info.append(name, meta);

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent =
    uid === state.user?.uid ? "You" : "Consented";

  row.append(info, tag);

  return row;
}

function drawLocations(locations) {
  state.activeLocations = locations;

  // Remove markers for participants who are no longer active.
  for (const [uid, marker] of state.markers) {
    if (!locations.has(uid)) {
      marker.setMap(null);
      state.markers.delete(uid);
    }
  }

  const bounds = state.mapReady
    ? new google.maps.LatLngBounds()
    : null;

  for (const [uid, position] of locations) {
    if (!validCoordinates(position)) continue;

    if (!state.mapReady || !state.map) continue;

    const coordinates = {
      lat: position.lat,
      lng: position.lng
    };

    let marker = state.markers.get(uid);

    if (!marker) {
      marker = new google.maps.Marker({
        map: state.map,
        position: coordinates,
        title:
          position.displayName ||
          "Consenting participant"
      });

      state.markers.set(uid, marker);

    } else {
      marker.setPosition(coordinates);
    }

    if (bounds) bounds.extend(coordinates);
  }

  // Fit the map to participants without constantly zooming
  // or moving it on every small GPS update.
  const now = Date.now();

  if (
    bounds &&
    !bounds.isEmpty() &&
    now - state.lastMapBoundsUpdate > 15000
  ) {
    if (locations.size > 1) {
      state.map.fitBounds(bounds, 65);
    } else if (locations.size === 1) {
      state.map.setCenter(bounds.getCenter());
      state.map.setZoom(15);
    }

    state.lastMapBoundsUpdate = now;
  }

  const list = $("peopleList");

  if (list) {
    list.replaceChildren();

    if (!locations.size) {
      const paragraph = document.createElement("p");
      paragraph.textContent =
        "No active location is being shared in this session.";

      list.append(paragraph);

    } else {
      for (const [uid, position] of locations) {
        list.append(
          createParticipantRow(uid, position)
        );
      }
    }
  }

  say("peopleCount", String(locations.size));
  say("consentCount", String(locations.size));

  say(
    "mapBadge",
    locations.size
      ? "Live consenting members"
      : "Waiting for consent"
  );

  if (!locations.size) {
    say(
      "mapStatus",
      state.shareId
        ? "Connected to the session. Waiting for active location sharing."
        : "Create or join a session to view consenting participants."
    );
  }
}


/* =============================================================
   11. FIRESTORE SUBSCRIPTIONS
============================================================= */

function clearSubscriptions() {
  state.unsubscribers.forEach(unsubscribe => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Subscription cleanup:", error);
    }
  });

  state.unsubscribers = [];

  state.shareUnsubscribers.forEach(unsubscribe => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Share subscription cleanup:", error);
    }
  });

  state.shareUnsubscribers = [];

  if (state.locationUnsub) {
    state.locationUnsub();
    state.locationUnsub = null;
  }
}

function stopShareListeners() {
  state.shareUnsubscribers.forEach(unsubscribe => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn(error);
    }
  });

  state.shareUnsubscribers = [];

  if (state.locationUnsub) {
    state.locationUnsub();
    state.locationUnsub = null;
  }
}

function watchShare(shareId) {
  stopShareListeners();

  if (!shareId || !state.user) return;

  state.shareId = shareId;

  sessionStorage.setItem("ktShareId", shareId);

  const membersRef = collection(
    db,
    "shares",
    shareId,
    "members"
  );

  const unsubscribeMembers = onSnapshot(
    membersRef,

    snapshot => {
      const active = new Set();
      const names = new Map();

      snapshot.docs.forEach(document => {
        const data = document.data();

        if (data.active === true) {
          active.add(document.id);
        }

        names.set(
          document.id,
          data.displayName || "Participant"
        );
      });

      if (state.locationUnsub) {
        state.locationUnsub();
        state.locationUnsub = null;
      }

      const locationsRef = collection(
        db,
        "shares",
        shareId,
        "locations"
      );

      state.locationUnsub = onSnapshot(
        locationsRef,

        locationSnapshot => {
          const result = new Map();

          locationSnapshot.docs.forEach(document => {
            const data = document.data();

            if (
              active.has(document.id) &&
              validCoordinates(data)
            ) {
              result.set(document.id, {
                ...data,
                displayName:
                  names.get(document.id) || "Participant"
              });
            }
          });

          drawLocations(result);
        },

        error => {
          reportError(
            "mapStatus",
            error,
            "Location listener failed"
          );
        }
      );
    },

    error => {
      reportError(
        "mapStatus",
        error,
        "Member listener failed"
      );
    }
  );

  state.shareUnsubscribers.push(unsubscribeMembers);

  say(
    "mapStatus",
    "Connected to the consent-controlled sharing session."
  );
}


/* =============================================================
   12. SESSION RESTORATION
============================================================= */

async function restoreSharingSession(user) {
  if (!user || !state.shareId || !navigator.onLine) return;

  const savedShareId = state.shareId;

  try {
    say("mapStatus", "Restoring your sharing session…");

    const member = await readServerDocument(
      doc(
        db,
        "shares",
        savedShareId,
        "members",
        user.uid
      ),
      "session restoration membership verification"
    );

    if (
      member.exists() &&
      member.data().active === true
    ) {
      watchShare(savedShareId);

      say(
        "mapStatus",
        "Your sharing session has been restored."
      );

      return;
    }

    state.shareId = "";
    sessionStorage.removeItem("ktShareId");

    stopShareListeners();
    drawLocations(new Map());

    say(
      "mapStatus",
      "Your previous sharing membership is no longer active. Create or join another session."
    );

  } catch (error) {
    console.error("KINTRACK_SESSION_RESTORE_FAILED", {
      shareId: savedShareId,
      uid: user.uid,
      code: error?.code || "unknown",
      message: error?.message || String(error),
      online: navigator.onLine
    });

    // Keep the session ID if the connection failed.
    // Do not incorrectly delete a potentially valid session.
    state.shareId = savedShareId;

    say(
      "mapStatus",
      "Could not restore the session connection. Your session ID is saved. Check your connection and retry."
    );
  }
}


/* =============================================================
   13. LOCATION SHARING
============================================================= */

async function startLocation() {
  if (state.locationStarting) return;

  if (!state.user) {
    showAuth("login");
    return;
  }

  if (!state.shareId) {
    say(
      "locationStatus",
      "Create a sharing invite or join an existing session first."
    );

    setTab("consent");
    return;
  }

  if (!$("locConsent")?.checked) {
    say(
      "locationStatus",
      "Please read and accept the location consent first."
    );

    setTab("consent");
    return;
  }

  if (!navigator.geolocation) {
    say(
      "locationStatus",
      "This browser does not support location services."
    );
    return;
  }

  if (!window.isSecureContext) {
    say(
      "locationStatus",
      "Location sharing requires HTTPS. Open the secure KinTrack website."
    );
    return;
  }

  if (!navigator.onLine) {
    say(
      "locationStatus",
      "You are offline. Reconnect before starting location sharing."
    );
    return;
  }

  const duration = Number(
    $("duration")?.value || 60
  );

  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 1440
  ) {
    say("locationStatus", "Select a valid sharing duration.");
    return;
  }

  state.locationStarting = true;

  setButtonBusy(
    "consentShareBtn",
    true,
    "Starting sharing…"
  );

  say(
    "locationStatus",
    "Checking your sharing session…"
  );

  try {
    const member = await readServerDocument(
      doc(
        db,
        "shares",
        state.shareId,
        "members",
        state.user.uid
      ),
      "location sharing membership verification"
    );

    if (!member.exists() || member.data().active !== true) {
      throw new Error(
        "Your session membership is not active. Create a new invite or join an active session."
      );
    }

    say(
      "locationStatus",
      "Requesting browser location permission…"
    );

    navigator.geolocation.getCurrentPosition(
      async position => {
        try {
          await writePosition(position);

          if (state.watchId !== null) {
            navigator.geolocation.clearWatch(
              state.watchId
            );
          }

          state.watchId = navigator.geolocation.watchPosition(
            position => {
              writePosition(position).catch(error => {
                console.error(
                  "Location update failed:",
                  error
                );

                say(
                  "locationStatus",
                  "Location update failed: " +
                  friendlyError(error)
                );
              });
            },

            error => {
              let message = error.message;

              if (error.code === error.PERMISSION_DENIED) {
                message = "Location permission was denied.";
              } else if (
                error.code === error.POSITION_UNAVAILABLE
              ) {
                message = "Your device could not determine its location.";
              } else if (error.code === error.TIMEOUT) {
                message = "GPS request timed out. Try again outdoors.";
              }

              say(
                "locationStatus",
                "Location update stopped: " + message
              );
            },

            {
              enableHighAccuracy: true,
              maximumAge: 5000,
              timeout: 20000
            }
          );

          clearTimeout(state.expiryTimer);

          state.expiryTimer = setTimeout(
            () => stopLocationWatch(true),
            duration * 60000
          );

          const expiry = new Date(
            Date.now() + duration * 60000
          );

          say(
            "locationStatus",
            `Sharing is on until ${expiry.toLocaleTimeString()}. Keep this page open for live updates.`
          );

          logActivity(
            "Location sharing started",
            `Consent recorded for ${duration} minutes.`
          );

        } catch (error) {
          reportError(
            "locationStatus",
            error,
            "Could not save location"
          );

        } finally {
          state.locationStarting = false;

          setButtonBusy(
            "consentShareBtn",
            false
          );
        }
      },

      error => {
        let message = error.message;

        if (error.code === error.PERMISSION_DENIED) {
          message =
            "Location permission denied. Enable location permission in your browser.";

        } else if (
          error.code === error.POSITION_UNAVAILABLE
        ) {
          message =
            "Your device could not determine its current location.";

        } else if (error.code === error.TIMEOUT) {
          message =
            "Location request timed out. Try again with better GPS reception.";
        }

        say(
          "locationStatus",
          "Location was not shared: " + message
        );

        state.locationStarting = false;

        setButtonBusy(
          "consentShareBtn",
          false
        );
      },

      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20000
      }
    );

  } catch (error) {
    reportError(
      "locationStatus",
      error,
      "Could not verify session"
    );

    state.locationStarting = false;

    setButtonBusy(
      "consentShareBtn",
      false
    );
  }
}


/* =============================================================
   14. WRITE LOCATION TO FIRESTORE
============================================================= */

async function writePosition(position) {
  if (!state.user || !state.shareId) {
    throw new Error(
      "You are not connected to a sharing session."
    );
  }

  if (!navigator.onLine) {
    throw new Error(
      "The device is offline. Location was not uploaded."
    );
  }

  const member = await readServerDocument(
    doc(
      db,
      "shares",
      state.shareId,
      "members",
      state.user.uid
    ),
    "location update membership verification"
  );

  if (!member.exists() || member.data().active !== true) {
    throw new Error(
      "Your consent is no longer active. Create or join a new session."
    );
  }

  const latitude = position.coords.latitude;
  const longitude = position.coords.longitude;
  const accuracy = position.coords.accuracy || 0;

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error("Invalid GPS coordinates received.");
  }

  const locationData = {
    uid: state.user.uid,
    lat: latitude,
    lng: longitude,
    accuracy: Math.max(0, accuracy),
    updatedAt: serverTimestamp()
  };

  await setDoc(
    doc(
      db,
      "shares",
      state.shareId,
      "locations",
      state.user.uid
    ),
    locationData
  );

  state.currentPosition = {
    lat: latitude,
    lng: longitude,
    accuracy
  };
}


/* =============================================================
   15. STOP LOCATION SHARING
============================================================= */

async function stopLocationWatch(callBackend = true) {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  clearTimeout(state.expiryTimer);
  state.expiryTimer = null;

  const user = state.user;
  const shareId = state.shareId;

  // Stop local GPS immediately, even if the network is unavailable.
  state.currentPosition = null;

  if (callBackend && user && shareId && functions) {
    try {
      await httpsCallable(
        functions,
        "stopSharing"
      )({
        shareId
      });

    } catch (error) {
      console.error(
        "Backend stop-sharing request failed:",
        error
      );

      say(
        "locationStatus",
        "Local GPS stopped. Server confirmation failed: " +
        friendlyError(error)
      );
    }
  }

  if (user && shareId && db) {
    try {
      await deleteDoc(
        doc(
          db,
          "shares",
          shareId,
          "locations",
          user.uid
        )
      );

    } catch (error) {
      console.error(
        "Location deletion failed:",
        error
      );
    }
  }

  if ($("locConsent")) {
    $("locConsent").checked = false;
  }

  say(
    "locationStatus",
    "Location sharing is off. Local GPS updates have stopped."
  );

  logActivity(
    "Location sharing stopped",
    "Location updates disabled."
  );
}

$("locBtn")?.addEventListener("click", startLocation);
$("consentShareBtn")?.addEventListener("click", startLocation);

$("stopLocBtn")?.addEventListener("click", () => {
  stopLocationWatch(true);
});

$("stopAllBtn")?.addEventListener("click", () => {
  stopLocationWatch(true);
});


/* =============================================================
   16. INVITATION LINKS AND SHARING
============================================================= */

function currentInviteUrl() {
  const code =
    state.inviteCode ||
    $("inviteLink")?.value?.trim() ||
    "";

  const url = new URL(window.location.href);

  if (code) {
    url.searchParams.set("invite", code);
  }

  return {
    code,
    url: url.toString()
  };
}

function shareText() {
  const invitation = currentInviteUrl();

  return (
    `Join my KinTrack sharing session with invite code ${invitation.code}. ` +
    `Open the link, sign in, and review the invitation: ${invitation.url}\n` +
    "Only share if you trust the sender. Location remains off until you separately consent."
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;

  } catch (error) {
    const input = document.createElement("textarea");

    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";

    document.body.append(input);
    input.select();

    const copied = document.execCommand("copy");
    input.remove();

    return copied;
  }
}

function openShareTarget(target) {
  const invitation = currentInviteUrl();

  if (!invitation.code) {
    say("pairStatus", "Create an invite first.");
    return;
  }

  const text = shareText();
  const encoded = encodeURIComponent(text);

  const urls = {
    whatsapp: `https://wa.me/?text=${encoded}`,

    facebook:
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(invitation.url)}`,

    x:
      `https://twitter.com/intent/tweet?text=${encodeURIComponent("KinTrack invite code: " + invitation.code)}&url=${encodeURIComponent(invitation.url)}`,

    telegram:
      `https://t.me/share/url?url=${encodeURIComponent(invitation.url)}&text=${encodeURIComponent("KinTrack invitation")}`,

    email:
      `mailto:?subject=${encodeURIComponent("KinTrack invitation")}&body=${encoded}`,

    sms:
      `sms:?&body=${encoded}`,

    linkedin:
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(invitation.url)}`
  };

  if (target === "copy") {
    copyText(text).then(copied => {
      say(
        "contactStatus",
        copied
          ? "Invite link and code copied."
          : "Copy was blocked by your browser."
      );
    });

    return;
  }

  if (target === "native" && navigator.share) {
    navigator.share({
      title: "KinTrack invitation",
      text,
      url: invitation.url
    }).catch(error => {
      if (error.name !== "AbortError") {
        console.warn("Native sharing failed:", error);
      }
    });

    return;
  }

  if (urls[target]) {
    window.open(
      urls[target],
      "_blank",
      "noopener,noreferrer"
    );
  }
}

function renderShareButtons() {
  const box = $("inviteShareActions");
  if (!box) return;

  box.replaceChildren();

  const targets = [
    ["WhatsApp", "whatsapp"],
    ["Facebook", "facebook"],
    ["X", "x"],
    ["Telegram", "telegram"],
    ["Email", "email"],
    ["SMS", "sms"],
    ["LinkedIn", "linkedin"],
    ["Copy invite link", "copy"],
    ["More…", "native"]
  ];

  for (const [label, target] of targets) {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "secondary";
    button.textContent = label;

    button.addEventListener("click", () => {
      openShareTarget(target);
    });

    box.append(button);
  }
}

renderShareButtons();

$("shareInviteBtn")?.addEventListener("click", () => {
  openShareTarget("native");
});


/* =============================================================
   17. CONTACT PICKER
============================================================= */

$("contactPickerBtn")?.addEventListener("click", async () => {
  const status = $("contactPickerStatus");

  if (!state.inviteCode) {
    say("contactPickerStatus", "Create an invite first.");
    return;
  }

  if (!navigator.contacts?.select) {
    say(
      "contactPickerStatus",
      "This browser does not support Contact Picker. Use the invitation sharing buttons."
    );
    return;
  }

  try {
    const contacts = await navigator.contacts.select(
      ["name", "tel", "email"],
      { multiple: true }
    );

    if (!contacts.length) {
      say("contactPickerStatus", "No contacts selected.");
      return;
    }

    say(
      "contactPickerStatus",
      `Selected ${contacts.length} contact(s). KinTrack has not uploaded or messaged them automatically.`
    );

    const summary = contacts.map(contact => [
      ...(contact.name || []),
      ...(contact.tel || []),
      ...(contact.email || [])
    ].join(" · ")).filter(Boolean).join("\n");

    say("contactStatus", summary.slice(0, 500));

  } catch (error) {
    status.textContent =
      error.name === "AbortError"
        ? "Contact selection cancelled."
        : "Contact picker unavailable. Use a sharing option instead.";
  }
});


/* =============================================================
   18. CREATE SHARING SESSION
============================================================= */

$("createShareBtn")?.addEventListener("click", async () => {
  if (!state.user) {
    showAuth("login");
    return;
  }

  setButtonBusy(
    "createShareBtn",
    true,
    "Creating invite…"
  );

  try {
    say(
      "pairStatus",
      "Creating secure sharing invitation…"
    );

    const durationMinutes = Number(
      $("duration")?.value || 60
    );

    const result = await httpsCallable(
      functions,
      "createShare"
    )({
      durationMinutes
    });

    if (
      !result.data?.shareId ||
      !result.data?.inviteCode
    ) {
      throw new Error(
        "The server returned an incomplete invitation."
      );
    }

    state.shareId = result.data.shareId;
    state.inviteCode = result.data.inviteCode;

    watchShare(state.shareId);

    if ($("shareCodeBox")) {
      $("shareCodeBox").classList.remove("hidden");

      $("shareCodeBox").textContent =
        `Invite code: ${state.inviteCode} · expires ${
          new Date(result.data.expiresAt).toLocaleString()
        }. Give this code only to your intended participant.`;
    }

    if ($("inviteLink")) {
      $("inviteLink").value = state.inviteCode;
    }

    renderShareButtons();

    $("modalBack")?.classList.remove("hidden");

    say(
      "pairStatus",
      "Invite created. The recipient must sign in and accept it on their own device."
    );

    logActivity(
      "Sharing invite created",
      "Secure invitation generated by the backend."
    );

  } catch (error) {
    reportError(
      "pairStatus",
      error,
      "Could not create invitation"
    );

  } finally {
    setButtonBusy("createShareBtn", false);
  }
});

$("inviteBtn")?.addEventListener("click", () => {
  setTab("consent");
  $("createShareBtn")?.focus();
});


/* =============================================================
   19. JOIN SHARING SESSION
============================================================= */

$("joinBtn")?.addEventListener("click", async () => {
  if (!state.user) {
    showAuth("login");
    return;
  }

  const code =
    $("joinCode")?.value.trim().toUpperCase() || "";

  if (!/^[A-F0-9]{10}$/.test(code)) {
    say(
      "joinStatus",
      "Enter the 10-character invitation code."
    );
    return;
  }

  const accepted = confirm(
    "By joining, you agree to participate in this time-limited sharing session. Your location will NOT be shared until you separately enable it. Continue?"
  );

  if (!accepted) return;

  setButtonBusy(
    "joinBtn",
    true,
    "Joining…"
  );

  try {
    say("joinStatus", "Validating invitation…");

    const result = await httpsCallable(
      functions,
      "joinShare"
    )({
      inviteCode: code
    });

    if (!result.data?.shareId) {
      throw new Error(
        "The server did not return a valid sharing session."
      );
    }

    state.shareId = result.data.shareId;

    watchShare(state.shareId);

    say(
      "joinStatus",
      `Joined successfully. Session expires ${
        new Date(result.data.expiresAt).toLocaleString()
      }. Location sharing remains off until you enable it.`
    );

    logActivity(
      "Joined a sharing session",
      "Participant consent was recorded."
    );

    setTab("overview");

  } catch (error) {
    reportError(
      "joinStatus",
      error,
      "Could not join session"
    );

  } finally {
    setButtonBusy("joinBtn", false);
  }
});


/* =============================================================
   20. INVITATION MODAL
============================================================= */

function closeModal() {
  $("modalBack")?.classList.add("hidden");
}

$("copyInviteBtn")?.addEventListener("click", async () => {
  const code = $("inviteLink")?.value || "";

  const copied = await copyText(code);

  say(
    "contactStatus",
    copied ? "Invitation code copied." : "Copy failed."
  );

  if (copied) {
    $("copyInviteBtn").textContent = "Copied";
  }
});

$("closeModal")?.addEventListener("click", closeModal);
$("doneModal")?.addEventListener("click", closeModal);

$("modalBack")?.addEventListener("click", event => {
  if (event.target === $("modalBack")) {
    closeModal();
  }
});


/* =============================================================
   21. ASSET MANAGEMENT
============================================================= */

$("addAssetBtn")?.addEventListener("click", async () => {
  if (!state.user) {
    showAuth("login");
    return;
  }

  const name = safeText($("assetName")?.value);
  const identifier = safeText($("assetId")?.value);
  const type = safeText($("assetType")?.value, "other");
  const model = safeText($("assetModel")?.value);
  const serviceDate = safeText(
    $("assetServiceDate")?.value
  );

  if (!name || !identifier) {
    say(
      "assetList",
      "Enter an asset name and identifier."
    );
    return;
  }

  setButtonBusy(
    "addAssetBtn",
    true,
    "Saving asset…"
  );

  try {
    await addDoc(
      collection(db, "assets"),
      {
        ownerUid: state.user.uid,

        name,
        identifier,

        // Additional fields for the redesigned asset form.
        // Existing fields remain unchanged.
        type,
        model,
        serviceDate,

        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );

    $("assetName").value = "";
    $("assetId").value = "";

    if ($("assetModel")) {
      $("assetModel").value = "";
    }

    if ($("assetServiceDate")) {
      $("assetServiceDate").value = "";
    }

    logActivity("Asset added", name);

  } catch (error) {
    reportError(
      "assetList",
      error,
      "Asset creation failed"
    );

  } finally {
    setButtonBusy("addAssetBtn", false);
  }
});


/* =============================================================
   22. LOAD AND DISPLAY ASSETS
============================================================= */

function watchAssets(uid) {
  const assetsQuery = query(
    collection(db, "assets"),
    where("ownerUid", "==", uid)
  );

  const unsubscribe = onSnapshot(
    assetsQuery,

    snapshot => {
      const list = $("assetList");
      if (!list) return;

      list.replaceChildren();

      say("assetCount", String(snapshot.size));

      if (snapshot.empty) {
        showEmptyList(
          "assetList",
          "No assets registered yet."
        );
        return;
      }

      snapshot.docs.forEach(document => {
        const asset = document.data();

        const row = document.createElement("div");
        row.className = "person";

        const info = document.createElement("div");

        const name = document.createElement("strong");
        name.textContent = asset.name || "Unnamed asset";

        const details = document.createElement("small");

        const parts = [
          asset.identifier || "No identifier",
          asset.type || "",
          asset.model || "",
          asset.serviceDate
            ? "Next service: " + formatDate(asset.serviceDate)
            : ""
        ].filter(Boolean);

        details.textContent = parts.join(" · ");

        info.append(name, details);

        const removeButton = document.createElement("button");

        removeButton.type = "button";
        removeButton.className = "danger";
        removeButton.textContent = "Delete";

        removeButton.addEventListener("click", async () => {
          if (!confirm(
            `Delete the asset "${asset.name || "Unnamed asset"}"?`
          )) {
            return;
          }

          removeButton.disabled = true;

          try {
            await deleteDoc(
              doc(db, "assets", document.id)
            );

            logActivity(
              "Asset deleted",
              asset.name || "Unnamed asset"
            );

          } catch (error) {
            alert(friendlyError(error));
            removeButton.disabled = false;
          }
        });

        row.append(info, removeButton);
        list.append(row);
      });
    },

    error => {
      reportError(
        "assetList",
        error,
        "Could not load assets"
      );
    }
  );

  state.unsubscribers.push(unsubscribe);
}


/* =============================================================
   23. EXPORT ASSETS
============================================================= */

$("exportBtn")?.addEventListener("click", async () => {
  if (!state.user) {
    showAuth("login");
    return;
  }

  try {
    const snapshot = await getDocs(
      query(
        collection(db, "assets"),
        where("ownerUid", "==", state.user.uid)
      )
    );

    const data = snapshot.docs.map(document => {
      const asset = document.data();

      return {
        id: document.id,
        name: asset.name || "",
        identifier: asset.identifier || "",
        type: asset.type || "",
        model: asset.model || "",
        serviceDate: asset.serviceDate || "",
        createdAt:
          asset.createdAt?.toDate?.().toISOString() || null
      };
    });

    const blob = new Blob(
      [JSON.stringify(data, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = "kintrack-assets.json";

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    logActivity(
      "Asset export completed",
      `${data.length} asset record(s) exported.`
    );

  } catch (error) {
    reportError(
      "auditList",
      error,
      "Asset export failed"
    );
  }
});


/* =============================================================
   24. DELETE ALL ASSETS
============================================================= */

$("deleteBtn")?.addEventListener("click", async () => {
  if (!state.user) {
    showAuth("login");
    return;
  }

  if (!confirm(
    "Delete all your registered assets? This does not delete your account or payment history."
  )) {
    return;
  }

  try {
    const snapshot = await getDocs(
      query(
        collection(db, "assets"),
        where("ownerUid", "==", state.user.uid)
      )
    );

    // Delete in manageable batches to avoid oversized requests.
    for (let i = 0; i < snapshot.docs.length; i += 10) {
      const batch = snapshot.docs.slice(i, i + 10);

      await Promise.all(
        batch.map(document =>
          deleteDoc(doc(db, "assets", document.id))
        )
      );
    }

    logActivity(
      "Assets deleted",
      "All registered assets removed."
    );

  } catch (error) {
    reportError(
      "auditList",
      error,
      "Asset deletion failed"
    );
  }
});


/* =============================================================
   25. SUBSCRIPTION MONITORING
============================================================= */

function watchSubscription(uid) {
  const unsubscribe = onSnapshot(
    doc(db, "subscriptions", uid),

    snapshot => {
      if (snapshot.exists() && snapshot.data().active) {
        const data = snapshot.data();

        const paidThrough =
          data.paidThrough?.toDate?.().toLocaleString() ||
          "pending update";

        say(
          "trialState",
          `Active. Paid through ${paidThrough}.`
        );

      } else {
        say(
          "trialState",
          "No verified active subscription."
        );
      }
    },

    error => {
      reportError(
        "trialState",
        error,
        "Subscription status unavailable"
      );
    }
  );

  state.unsubscribers.push(unsubscribe);
}


/* =============================================================
   26. M-PESA CHECKOUT
============================================================= */

$("payBtn")?.addEventListener("click", async () => {
  if (!state.user) {
    showAuth("login");
    return;
  }

  if (!$("payConfirm")?.checked) {
    say(
      "payStatus",
      "Confirm the price before starting checkout."
    );
    return;
  }

  const phone = $("phone")?.value.trim() || "";

  if (!/^((254[17]\d{8})|(0[17]\d{8})|([17]\d{8}))$/.test(phone)) {
    say(
      "payStatus",
      "Enter a valid Kenyan mobile number, e.g. 2547XXXXXXXX."
    );
    return;
  }

  setButtonBusy(
    "payBtn",
    true,
    "Requesting STK Push…"
  );

  say(
    "payStatus",
    "Requesting secure M-Pesa STK Push…"
  );

  try {
    const result = await httpsCallable(
      functions,
      "startMpesaPayment"
    )({
      phone,
      confirmedPrice: 100
    });

    say(
      "payStatus",
      `${result.data.message || "STK Push request accepted by the server."} Check your phone for the M-Pesa prompt. Reference: ${result.data.paymentId || "pending"}. Access will update only after server verification.`
    );

    logActivity(
      "M-Pesa checkout initiated",
      result.data.paymentId || "Payment request submitted."
    );

  } catch (error) {
    reportError(
      "payStatus",
      error,
      "Payment request failed"
    );

  } finally {
    setButtonBusy("payBtn", false);
  }
});


/* =============================================================
   27. SESSION AND ACCOUNT INITIALIZATION
============================================================= */

function showSignedOutState() {
  $("authOverlay")?.classList.remove("hidden");

  $("signOutBtn")?.classList.add("hidden");

  if ($("accountBtn")) {
    $("accountBtn").textContent = "Account";
  }

  say("trialBadge", "Sign in to continue");

  showEmptyList(
    "assetList",
    "Sign in to load your assets."
  );

  showEmptyList(
    "peopleList",
    "Sign in and join a session to view participants."
  );

  say("assetCount", "0");
  say("peopleCount", "0");
  say("consentCount", "0");

  say(
    "trialState",
    "Sign in to load subscription status."
  );

  say(
    "auditList",
    "Sign in to view available account information."
  );

  drawLocations(new Map());
}

function showSignedInState(user) {
  $("authOverlay")?.classList.add("hidden");

  $("signOutBtn")?.classList.remove("hidden");

  if ($("accountBtn")) {
    $("accountBtn").textContent =
      user.displayName || user.email || "Account";
  }

  say("trialBadge", "Secure account connected");
}

function startApp() {
  const urlInvite = new URLSearchParams(
    window.location.search
  ).get("invite");

  if (urlInvite && /^[A-F0-9]{10}$/i.test(urlInvite)) {
    if ($("joinCode")) {
      $("joinCode").value = urlInvite.toUpperCase();
    }

    say(
      "joinStatus",
      "Invitation link detected. Sign in, then review and join this session."
    );
  }

  if (
    !cfg.firebase ||
    !cfg.firebase.apiKey ||
    cfg.firebase.apiKey.startsWith("REPLACE_")
  ) {
    say(
      "authMessage",
      "Configure firebase-config.js to connect KinTrack to Firebase."
    );

    return;
  }

  try {
    app = initializeApp(cfg.firebase);

    auth = getAuth(app);

    /*
     * Preserve the existing Firestore connection settings.
     * Do not initialize Firestore more than once.
     */
    db = initializeFirestore(app, {
      experimentalAutoDetectLongPolling: true,
      useFetchStreams: false
    });

    functions = getFunctions(
      app,
      cfg.functionsRegion || "africa-south1"
    );

    updateNetworkStatus(navigator.onLine);

    initMap();

    onAuthStateChanged(auth, async user => {
      state.user = user;
      state.authReady = true;

      clearSubscriptions();

      if (user) {
        showSignedInState(user);

        watchAssets(user.uid);
        watchSubscription(user.uid);

        say(
          "auditList",
          "Security audit events are managed by the server."
        );

        if (state.shareId) {
          await restoreSharingSession(user);
        } else {
          drawLocations(new Map());
        }

      } else {
        // Local tracking must stop when the account signs out.
        if (state.watchId !== null) {
          navigator.geolocation.clearWatch(state.watchId);
          state.watchId = null;
        }

        clearTimeout(state.expiryTimer);
        state.expiryTimer = null;

        state.shareId = "";
        state.currentPosition = null;

        sessionStorage.removeItem("ktShareId");

        stopShareListeners();

        showSignedOutState();
      }
    });

  } catch (error) {
    console.error(
      "KinTrack initialization failed:",
      error
    );

    say(
      "authMessage",
      "Firebase initialization failed: " + friendlyError(error)
    );
  }
}


/* =============================================================
   28. PAGE LIFECYCLE SAFETY
============================================================= */

// Browser-only tracking is not guaranteed to continue when the
// page is closed, suspended or the operating system kills it.
// Do not falsely represent it as Android background tracking.

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state.watchId !== null) {
    console.info(
      "KinTrack: Page is hidden. Browser GPS execution may be suspended."
    );
  }
});

window.addEventListener("pagehide", () => {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  clearTimeout(state.expiryTimer);
  state.expiryTimer = null;
});


/* =============================================================
   29. START APPLICATION
============================================================= */

startApp();
