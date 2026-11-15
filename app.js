
/***************************************************************
 * KINTRACK — COMPLETE APPLICATION SCRIPT
 * Firebase SDK: 10.14.1
 * Firebase project: kintrack-app-38c0a
 * Functions region: africa-south1
 *
 * Includes:
 * - Firebase authentication
 * - Firestore connection recovery and server reads
 * - Session restoration
 * - Consent-based GPS location sharing
 * - Google Maps and live participant locations
 * - Sharing invitations and joining
 * - Asset management, export and deletion
 * - Subscription status
 * - M-Pesa checkout
 ***************************************************************/

import { initializeApp } from
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  updateProfile,
  signOut
} from
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

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
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import {
  getFunctions,
  httpsCallable
} from
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';


/* =============================================================
   1. CONFIGURATION AND STATE
============================================================= */

const cfg = window.KINTRACK_CONFIG || {};
const $ = id => document.getElementById(id);

const state = {
  user: null,
  mode: 'register',
  busy: false,

  shareId: sessionStorage.getItem('ktShareId') || '',
  inviteCode: '',

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
  locationStarting: false
};

let app;
let auth;
let db;
let functions;


/* =============================================================
   2. GENERAL UTILITIES
============================================================= */

function say(id, message) {
  const element = $(id);
  if (element) element.textContent = message;
}

function logActivity(title, detail = '') {
  const activity = $('activity');
  if (!activity) return;

  const row = document.createElement('div');
  row.className = 'person';

  const left = document.createElement('div');
  const strong = document.createElement('strong');
  const small = document.createElement('small');

  strong.textContent = title;
  small.textContent = detail || new Date().toLocaleString();

  left.append(strong, small);

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = 'Live';

  row.append(left, tag);
  activity.prepend(row);

  while (activity.children.length > 5) {
    activity.lastElementChild.remove();
  }
}

function setTab(name) {
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === name);
  });

  ['overview', 'consent', 'billing', 'privacy'].forEach(tab => {
    const element = $('tab-' + tab);
    if (element) {
      element.classList.toggle('hidden', tab !== name);
    }
  });
}

document.querySelectorAll('[data-tab]').forEach(button => {
  button.addEventListener('click', () => setTab(button.dataset.tab));
});


/* =============================================================
   3. ERROR HANDLING AND FIRESTORE RETRIES
============================================================= */

function friendlyError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '');

  const errors = {
    'auth/email-already-in-use':
      'This email already has an account. Sign in instead.',

    'auth/invalid-credential':
      'Email or password is incorrect.',

    'auth/weak-password':
      'Use a password with at least 12 characters.',

    'auth/too-many-requests':
      'Too many attempts. Wait and try again.',

    'auth/network-request-failed':
      'Authentication network error. Check your internet connection.',

    'permission-denied':
      'Access denied by Firestore security rules.',

    'functions/unauthenticated':
      'Please sign in first.',

    'unavailable':
      'Firebase is temporarily unavailable. Check your connection.',

    'deadline-exceeded':
      'The Firebase request timed out. Please try again.',

    'failed-precondition':
      'The requested operation cannot be completed in the current state.'
  };

  if (errors[code]) return errors[code];

  if (
    message.toLowerCase().includes('err_connection_closed') ||
    message.toLowerCase().includes('client is offline') ||
    message.toLowerCase().includes('network')
  ) {
    return 'Firestore connection lost. Check your internet and retry.';
  }

  if (message.includes('Missing or insufficient permissions')) {
    return 'Firebase denied this operation. Check your Firestore rules.';
  }

  return message || 'Something went wrong. Check your connection.';
}

function reportError(target, error, prefix = '') {
  console.error('KINTRACK_ERROR', {
    operation: prefix || 'Application',
    code: error?.code || 'unknown',
    name: error?.name || 'Error',
    message: error?.message || String(error),
    online: navigator.onLine,
    shareId: state.shareId || null,
    uid: state.user?.uid || null
  });

  say(
    target,
    (prefix ? prefix + ': ' : '') + friendlyError(error)
  );
}

function isRetryableFirestoreError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();

  return [
    'unavailable',
    'deadline-exceeded',
    'aborted',
    'cancelled'
  ].includes(code) ||
    message.includes('err_connection_closed') ||
    message.includes('client is offline') ||
    message.includes('network');
}

/*
 * Reads directly from the Firestore server.
 * Retries temporary connection failures.
 * Permission errors are NOT retried.
 */
async function readServerDocument(
  reference,
  operation = 'Firestore read',
  attempts = 3
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getDocFromServer(reference);

    } catch (error) {
      lastError = error;

      console.error('KINTRACK_FIRESTORE_READ', {
        operation,
        attempt,
        attempts,
        code: error?.code || 'unknown',
        message: error?.message || String(error),
        online: navigator.onLine,
        path: reference?.path || 'unknown'
      });

      if (
        !isRetryableFirestoreError(error) ||
        attempt === attempts
      ) {
        throw error;
      }

      await new Promise(resolve =>
        setTimeout(resolve, 700 * attempt)
      );

      if (!navigator.onLine) {
        throw error;
      }
    }
  }

  throw lastError;
}


/* =============================================================
   4. NETWORK MONITORING
============================================================= */

function updateNetworkStatus(online) {
  state.networkOnline = online;

  const message = online
    ? 'Internet connection available.'
    : 'You are offline. Live location updates are paused.';

  say('networkStatus', message);
  say('connectionStatus', message);

  if (!online) {
    say(
      'locationStatus',
      'Connection lost. KinTrack will attempt to reconnect.'
    );
  }
}

window.addEventListener('offline', () => {
  updateNetworkStatus(false);
});

window.addEventListener('online', async () => {
  updateNetworkStatus(true);

  if (!db) return;

  try {
    await enableNetwork(db);
    console.info('KinTrack: Firestore network restored.');

    if (state.user && state.shareId) {
      restoreSharingSession(state.user);
    }

  } catch (error) {
    console.error('Firestore reconnection failed:', error);
  }
});


/* =============================================================
   5. AUTHENTICATION
============================================================= */

function showAuth(mode = 'register') {
  state.mode = mode;

  if ($('termsConsent')) {
    $('termsConsent').required = mode === 'register';
  }

  $('authOverlay')?.classList.remove('hidden');

  say(
    'authTitle',
    mode === 'register' ? 'Join KinTrack' : 'Welcome back'
  );

  say(
    'authIntro',
    mode === 'register'
      ? 'Create an account to manage your assets and sharing preferences.'
      : 'Sign in to access your account.'
  );

  $('registerFields')?.classList.toggle(
    'hidden',
    mode !== 'register'
  );

  if ($('fullName')) {
    $('fullName').required = mode === 'register';
  }

  if ($('password')) {
    $('password').minLength = mode === 'register' ? 12 : 1;
    $('password').autocomplete =
      mode === 'register' ? 'new-password' : 'current-password';
  }

  if ($('authSubmit')) {
    $('authSubmit').textContent =
      mode === 'register' ? 'Create account' : 'Sign in';
  }

  if ($('switchAuth')) {
    $('switchAuth').textContent =
      mode === 'register' ? 'Sign in' : 'Create account';
  }

  say('authMessage', '');
}

$('switchAuth')?.addEventListener('click', () => {
  showAuth(state.mode === 'register' ? 'login' : 'register');
});

$('authForm')?.addEventListener('submit', async event => {
  event.preventDefault();

  if (state.busy) return;

  if (!cfg.firebase || cfg.firebase.apiKey?.startsWith('REPLACE_')) {
    say('authMessage', 'Configure firebase-config.js first.');
    return;
  }

  state.busy = true;

  if ($('authSubmit')) $('authSubmit').disabled = true;

  say('authMessage', 'Connecting securely…');

  try {
    if (state.mode === 'register') {
      if (!$('termsConsent')?.checked) {
        throw new Error(
          'Please accept the account terms and privacy notice.'
        );
      }

      const name = $('fullName')?.value.trim();

      if (!name) {
        throw new Error('Enter your full name.');
      }

      const credential = await createUserWithEmailAndPassword(
        auth,
        $('email').value.trim(),
        $('password').value
      );

      await updateProfile(credential.user, {
        displayName: name
      });

      await setDoc(
        doc(db, 'users', credential.user.uid),
        {
          displayName: name,
          email: credential.user.email,
          phone: $('authPhone')?.value.trim() || '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      );

      say('authMessage', 'Account created successfully.');

    } else {
      await signInWithEmailAndPassword(
        auth,
        $('email').value.trim(),
        $('password').value
      );

      say('authMessage', 'Signed in successfully.');
    }

  } catch (error) {
    reportError('authMessage', error);

  } finally {
    state.busy = false;

    if ($('authSubmit')) $('authSubmit').disabled = false;
  }
});

$('accountBtn')?.addEventListener('click', () => {
  if (!state.user) showAuth('login');
  else setTab('privacy');
});

$('signOutBtn')?.addEventListener('click', async () => {
  try {
    await stopLocationWatch(false);
    await signOut(auth);
  } catch (error) {
    reportError('authMessage', error, 'Sign out failed');
  }
});


/* =============================================================
   6. GOOGLE MAPS
============================================================= */

async function initMap() {
  const key = cfg.mapsApiKey;

  if (!key || key.startsWith('REPLACE_')) {
    say(
      'mapStatus',
      'Google Maps is not configured. Add your restricted browser key.'
    );
    return;
  }

  try {
    await new Promise((resolve, reject) => {
      if (window.google?.maps) {
        resolve();
        return;
      }

      const script = document.createElement('script');

      script.src =
        `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&callback=__kinTrackMapReady`;

      script.async = true;
      window.__kinTrackMapReady = resolve;

      script.onerror = () => reject(
        new Error('Google Maps failed to load. Check API key restrictions and billing.')
      );

      document.head.appendChild(script);

      setTimeout(() => reject(
        new Error('Google Maps loading timed out.')
      ), 20000);
    });

    const mapElement = $('map');

    if (!mapElement) {
      console.warn('KinTrack: Map element #map was not found.');
      return;
    }

    state.map = new google.maps.Map(mapElement, {
      center: { lat: -1.286389, lng: 36.817223 },
      zoom: 11,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: true,
      clickableIcons: false
    });

    say(
      'mapStatus',
      'Map ready. Locations appear only after participants consent.'
    );

    drawLocations(state.activeLocations);

  } catch (error) {
    reportError('mapStatus', error);
  }
}

function drawLocations(locations) {
  state.activeLocations = locations;

  for (const [uid, marker] of state.markers) {
    if (!locations.has(uid)) {
      marker.setMap(null);
      state.markers.delete(uid);
    }
  }

  for (const [uid, position] of locations) {
    if (!state.map || !window.google?.maps) continue;

    const coordinates = {
      lat: position.lat,
      lng: position.lng
    };

    let marker = state.markers.get(uid);

    if (!marker) {
      marker = new google.maps.Marker({
        map: state.map,
        position: coordinates,
        title: position.displayName || 'Consenting participant'
      });

      state.markers.set(uid, marker);

    } else {
      marker.setPosition(coordinates);
    }

    if (uid === state.user?.uid) {
      state.map.panTo(coordinates);
    }
  }

  if (state.map && locations.size === 1) {
    const position = [...locations.values()][0];

    state.map.setCenter({
      lat: position.lat,
      lng: position.lng
    });
  }

  const list = $('peopleList');

  if (list) {
    list.replaceChildren();

    if (!locations.size) {
      const paragraph = document.createElement('p');
      paragraph.textContent =
        'No active location is being shared in this session.';
      list.append(paragraph);

    } else {
      for (const [uid, position] of locations) {
        const row = document.createElement('div');
        row.className = 'person';

        const left = document.createElement('div');
        const name = document.createElement('strong');
        const meta = document.createElement('small');

        name.textContent =
          position.displayName ||
          (uid === state.user?.uid ? 'You' : 'Participant');

        meta.textContent =
          `Location shared · accuracy ±${Math.round(position.accuracy || 0)} m · updated ${
            position.updatedAt?.toDate
              ? position.updatedAt.toDate().toLocaleTimeString()
              : 'just now'
          }`;

        left.append(name, meta);

        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent =
          uid === state.user?.uid ? 'You' : 'Consented';

        row.append(left, tag);
        list.append(row);
      }
    }
  }

  say('peopleCount', String(locations.size));
  say('consentCount', String(locations.size));

  say(
    'mapBadge',
    locations.size ? 'Live consenting members' : 'Waiting for consent'
  );
}


/* =============================================================
   7. FIRESTORE SUBSCRIPTIONS
============================================================= */

function clearSubscriptions() {
  state.unsubscribers.forEach(unsubscribe => unsubscribe());
  state.unsubscribers = [];

  state.shareUnsubscribers.forEach(unsubscribe => unsubscribe());
  state.shareUnsubscribers = [];

  if (state.locationUnsub) {
    state.locationUnsub();
    state.locationUnsub = null;
  }
}

function watchShare(shareId) {
  state.shareUnsubscribers.forEach(unsubscribe => unsubscribe());
  state.shareUnsubscribers = [];

  if (state.locationUnsub) {
    state.locationUnsub();
    state.locationUnsub = null;
  }

  state.shareId = shareId;
  sessionStorage.setItem('ktShareId', shareId);

  const membersRef = collection(
    db,
    'shares',
    shareId,
    'members'
  );

  const unsubscribeMembers = onSnapshot(
    membersRef,

    snapshot => {
      const active = snapshot.docs
        .filter(document => document.data().active === true)
        .map(document => document.id);

      const names = new Map(
        snapshot.docs.map(document => [
          document.id,
          document.data().displayName || 'Participant'
        ])
      );

      if (state.locationUnsub) {
        state.locationUnsub();
      }

      const locationsRef = collection(
        db,
        'shares',
        shareId,
        'locations'
      );

      state.locationUnsub = onSnapshot(
        locationsRef,

        locationSnapshot => {
          const result = new Map();

          locationSnapshot.docs.forEach(document => {
            const data = document.data();

            if (
              active.includes(document.id) &&
              Number.isFinite(data.lat) &&
              Number.isFinite(data.lng)
            ) {
              result.set(document.id, {
                ...data,
                displayName: names.get(document.id) || 'Participant'
              });
            }
          });

          drawLocations(result);
        },

        error => {
          reportError('mapStatus', error, 'Location listener failed');
        }
      );
    },

    error => {
      reportError('mapStatus', error, 'Member listener failed');
    }
  );

  state.shareUnsubscribers.push(unsubscribeMembers);

  state.shareUnsubscribers.push(() => {
    if (state.locationUnsub) {
      state.locationUnsub();
      state.locationUnsub = null;
    }
  });

  say('mapStatus', 'Connected to the consent-controlled sharing session.');
}


/* =============================================================
   8. SESSION RESTORATION
============================================================= */

async function restoreSharingSession(user) {
  if (!user || !state.shareId || !navigator.onLine) return;

  const savedShareId = state.shareId;

  try {
    say('mapStatus', 'Restoring your sharing session…');

    const member = await readServerDocument(
      doc(db, 'shares', savedShareId, 'members', user.uid),
      'session restoration membership verification'
    );

    if (
      member.exists() &&
      member.data().active === true
    ) {
      watchShare(savedShareId);

      say('mapStatus', 'Your sharing session has been restored.');
      return;
    }

    state.shareId = '';
    sessionStorage.removeItem('ktShareId');

    say(
      'mapStatus',
      'Your previous sharing membership is no longer active. Create or join another session.'
    );

  } catch (error) {
    console.error('KINTRACK_SESSION_RESTORE_FAILED', {
      shareId: savedShareId,
      uid: user.uid,
      code: error?.code || 'unknown',
      message: error?.message || String(error),
      online: navigator.onLine
    });

    // Preserve the ID when the network fails.
    // Never discard a potentially valid session because of a timeout.
    state.shareId = savedShareId;

    say(
      'mapStatus',
      'Could not restore your session connection. Your session ID is saved. Check your connection and retry.'
    );
  }
}


/* =============================================================
   9. LOCATION SHARING
============================================================= */

async function startLocation() {
  if (state.locationStarting) return;

  if (!state.user) {
    showAuth('login');
    return;
  }

  if (!state.shareId) {
    say(
      'locationStatus',
      'Create a sharing invite or join an existing session first.'
    );

    setTab('consent');
    return;
  }

  if (!$('locConsent')?.checked) {
    say(
      'locationStatus',
      'Please read and accept the location consent first.'
    );

    setTab('consent');
    return;
  }

  if (!navigator.geolocation) {
    say(
      'locationStatus',
      'This browser does not support location services.'
    );
    return;
  }

  if (!navigator.onLine) {
    say(
      'locationStatus',
      'You are offline. Reconnect before starting location sharing.'
    );
    return;
  }

  const duration = Number($('duration')?.value || 30);

  if (!Number.isFinite(duration) || duration <= 0) {
    say('locationStatus', 'Select a valid sharing duration.');
    return;
  }

  state.locationStarting = true;
  say('locationStatus', 'Checking your sharing session…');

  try {
    const member = await readServerDocument(
      doc(db, 'shares', state.shareId, 'members', state.user.uid),
      'startLocation membership verification'
    );

    if (!member.exists() || member.data().active !== true) {
      say(
        'locationStatus',
        'Your session membership is not active. Create a new invite or join an active session.'
      );
      return;
    }

    say('locationStatus', 'Requesting browser location permission…');

    navigator.geolocation.getCurrentPosition(
      async position => {
        try {
          await writePosition(position);

          if (state.watchId !== null) {
            navigator.geolocation.clearWatch(state.watchId);
          }

          state.watchId = navigator.geolocation.watchPosition(
            position => {
              writePosition(position).catch(error => {
                console.error('Location update failed:', error);

                say(
                  'locationStatus',
                  'Location update failed: ' + friendlyError(error)
                );
              });
            },

            error => {
              say(
                'locationStatus',
                'Location update error: ' + error.message
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
            'locationStatus',
            `Sharing is on until ${expiry.toLocaleTimeString()}. Keep this page open for live updates.`
          );

          logActivity(
            'Location sharing started',
            `Consent recorded for ${duration} minutes.`
          );

        } catch (error) {
          reportError(
            'locationStatus',
            error,
            'Could not save location'
          );

        } finally {
          state.locationStarting = false;
        }
      },

      error => {
        let message = error.message;

        if (error.code === error.PERMISSION_DENIED) {
          message =
            'Location permission denied. Enable location permission in your browser.';

        } else if (error.code === error.POSITION_UNAVAILABLE) {
          message =
            'Your device could not determine its current location.';

        } else if (error.code === error.TIMEOUT) {
          message =
            'Location request timed out. Try again with better GPS reception.';
        }

        say('locationStatus', 'Location was not shared: ' + message);
        state.locationStarting = false;
      },

      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20000
      }
    );

  } catch (error) {
    reportError(
      'locationStatus',
      error,
      'Could not verify session'
    );

    state.locationStarting = false;
  }
}

async function writePosition(position) {
  if (!state.user || !state.shareId) {
    throw new Error(
      'You are not connected to a sharing session.'
    );
  }

  if (!navigator.onLine) {
    throw new Error(
      'The device is offline. Location was not uploaded.'
    );
  }

  const member = await readServerDocument(
    doc(db, 'shares', state.shareId, 'members', state.user.uid),
    'location update membership verification'
  );

  if (!member.exists() || member.data().active !== true) {
    throw new Error(
      'Your consent is no longer active. Create or join a new session.'
    );
  }

  const latitude = position.coords.latitude;
  const longitude = position.coords.longitude;

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error('Invalid GPS coordinates received.');
  }

  const locationData = {
    uid: state.user.uid,
    lat: latitude,
    lng: longitude,
    accuracy: Math.max(0, position.coords.accuracy || 0),
    updatedAt: serverTimestamp()
  };

  await setDoc(
    doc(
      db,
      'shares',
      state.shareId,
      'locations',
      state.user.uid
    ),
    locationData
  );

  state.currentPosition = locationData;
}


/* =============================================================
   10. STOP LOCATION SHARING
============================================================= */

async function stopLocationWatch(callBackend = true) {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  clearTimeout(state.expiryTimer);
  state.expiryTimer = null;

  if (callBackend && state.user && state.shareId) {
    try {
      await httpsCallable(functions, 'stopSharing')({
        shareId: state.shareId
      });

    } catch (error) {
      console.error('Backend stop-sharing request failed:', error);

      say(
        'locationStatus',
        'Local tracking stopped. Server confirmation failed: ' +
        friendlyError(error)
      );
    }
  }

  if (state.user && state.shareId) {
    try {
      await deleteDoc(
        doc(
          db,
          'shares',
          state.shareId,
          'locations',
          state.user.uid
        )
      );

    } catch (error) {
      console.error('Location deletion failed:', error);
    }
  }

  if ($('locConsent')) {
    $('locConsent').checked = false;
  }

  say('locationStatus', 'Location sharing is off.');

  logActivity(
    'Location sharing stopped',
    'Location updates disabled.'
  );
}

$('locBtn')?.addEventListener('click', startLocation);
$('consentShareBtn')?.addEventListener('click', startLocation);

$('stopLocBtn')?.addEventListener('click', () => {
  stopLocationWatch(true);
});

$('stopAllBtn')?.addEventListener('click', () => {
  stopLocationWatch(true);
});


/* =============================================================
   11. INVITATION LINKS AND SHARING
============================================================= */

function currentInviteUrl() {
  const code =
    state.inviteCode ||
    $('inviteLink')?.value?.trim() ||
    '';

  const url = new URL(window.location.href);

  if (code) {
    url.searchParams.set('invite', code);
  }

  return {
    code,
    url: url.toString()
  };
}

function shareText() {
  const invitation = currentInviteUrl();

  return `Join my KinTrack sharing session with invite code ${invitation.code}. Open the link, sign in, and review the invitation: ${invitation.url}
Only share if you trust the sender. Location remains off until you separately consent.`;
}

function openShareTarget(target) {
  const invitation = currentInviteUrl();

  if (!invitation.code) {
    say('pairStatus', 'Create an invite first.');
    return;
  }

  const text = shareText();
  const encoded = encodeURIComponent(text);

  const urls = {
    whatsapp: `https://wa.me/?text=${encoded}`,

    facebook:
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(invitation.url)}`,

    x:
      `https://twitter.com/intent/tweet?text=${encodeURIComponent('KinTrack invite code: ' + invitation.code)}&url=${encodeURIComponent(invitation.url)}`,

    telegram:
      `https://t.me/share/url?url=${encodeURIComponent(invitation.url)}&text=${encodeURIComponent('KinTrack invite code: ' + invitation.code)}`,

    email:
      `mailto:?subject=${encodeURIComponent('KinTrack invitation')}&body=${encoded}`,

    sms:
      `sms:?&body=${encoded}`,

    linkedin:
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(invitation.url)}`,

    reddit:
      `https://www.reddit.com/submit?url=${encodeURIComponent(invitation.url)}&title=${encodeURIComponent('KinTrack invitation')}`
  };

  if (target === 'copy') {
    navigator.clipboard.writeText(text)
      .then(() => say('contactStatus', 'Invite link and code copied.'))
      .catch(() => say('contactStatus', 'Copy was blocked by your browser.'));

    return;
  }

  if (target === 'native' && navigator.share) {
    navigator.share({
      title: 'KinTrack invitation',
      text,
      url: invitation.url
    }).catch(() => {});

    return;
  }

  if (urls[target]) {
    window.open(urls[target], '_blank', 'noopener,noreferrer');
  }
}

function renderShareButtons() {
  const box = $('inviteShareActions');
  if (!box) return;

  box.replaceChildren();

  const targets = [
    ['WhatsApp', 'whatsapp'],
    ['Facebook', 'facebook'],
    ['X', 'x'],
    ['Telegram', 'telegram'],
    ['Email', 'email'],
    ['SMS', 'sms'],
    ['LinkedIn', 'linkedin'],
    ['Reddit', 'reddit'],
    ['Copy invite link', 'copy'],
    ['More…', 'native']
  ];

  for (const [label, target] of targets) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'secondary';
    button.textContent = label;

    button.addEventListener('click', () => {
      openShareTarget(target);
    });

    box.append(button);
  }
}

renderShareButtons();

$('shareInviteBtn')?.addEventListener('click', () => {
  openShareTarget('native');
});


/* =============================================================
   12. CONTACT PICKER
============================================================= */

$('contactPickerBtn')?.addEventListener('click', async () => {
  const status = $('contactPickerStatus');

  if (!state.inviteCode) {
    if (status) status.textContent = 'Create an invite first.';
    return;
  }

  if (!navigator.contacts?.select) {
    if (status) {
      status.textContent =
        'This browser does not support Contact Picker. Use the invitation sharing buttons.';
    }
    return;
  }

  try {
    const contacts = await navigator.contacts.select(
      ['name', 'tel', 'email'],
      { multiple: true }
    );

    if (!contacts.length) {
      status.textContent = 'No contacts selected.';
      return;
    }

    const summary = contacts.map(contact => [
      ...(contact.name || []),
      ...(contact.tel || []),
      ...(contact.email || [])
    ].join(' · ')).filter(Boolean).join('\n');

    status.textContent =
      `Selected ${contacts.length} contact(s). KinTrack has not uploaded or messaged them automatically.`;

    say('contactStatus', summary.slice(0, 500));

  } catch (error) {
    status.textContent =
      error.name === 'AbortError'
        ? 'Contact selection cancelled.'
        : 'Contact picker unavailable. Use a sharing option instead.';
  }
});


/* =============================================================
   13. CREATE SHARING SESSION
============================================================= */

$('createShareBtn')?.addEventListener('click', async () => {
  if (!state.user) {
    showAuth('login');
    return;
  }

  try {
    say('pairStatus', 'Creating secure sharing invitation…');

    const result = await httpsCallable(
      functions,
      'createShare'
    )({
      durationMinutes: Number($('duration')?.value || 30)
    });

    state.shareId = result.data.shareId;
    state.inviteCode = result.data.inviteCode;

    watchShare(state.shareId);

    if ($('shareCodeBox')) {
      $('shareCodeBox').classList.remove('hidden');

      $('shareCodeBox').textContent =
        `Invite code: ${state.inviteCode} · expires ${new Date(result.data.expiresAt).toLocaleString()}. Give this code only to your intended participant.`;
    }

    if ($('inviteLink')) {
      $('inviteLink').value = state.inviteCode;
    }

    renderShareButtons();

    $('modalBack')?.classList.remove('hidden');

    say(
      'pairStatus',
      'Invite created. The recipient must sign in and accept it on their own device.'
    );

    logActivity(
      'Sharing invite created',
      'Secure invitation generated by the backend.'
    );

  } catch (error) {
    reportError(
      'pairStatus',
      error,
      'Could not create invitation'
    );
  }
});

$('inviteBtn')?.addEventListener('click', () => {
  setTab('consent');
  $('createShareBtn')?.focus();
});


/* =============================================================
   14. JOIN SHARING SESSION
============================================================= */

$('joinBtn')?.addEventListener('click', async () => {
  if (!state.user) {
    showAuth('login');
    return;
  }

  const code = $('joinCode')?.value.trim().toUpperCase() || '';

  if (!/^[A-F0-9]{10}$/.test(code)) {
    say('joinStatus', 'Enter the 10-character invitation code.');
    return;
  }

  const accepted = confirm(
    'By joining, you consent to participate in this time-limited sharing session. Your location will NOT be shared until you separately enable it. Continue?'
  );

  if (!accepted) return;

  try {
    say('joinStatus', 'Validating invitation…');

    const result = await httpsCallable(
      functions,
      'joinShare'
    )({
      inviteCode: code
    });

    watchShare(result.data.shareId);

    say(
      'joinStatus',
      `Joined successfully. Session expires ${new Date(result.data.expiresAt).toLocaleString()}. Location sharing remains off until you enable it.`
    );

    logActivity(
      'Joined a sharing session',
      'Participant consent was recorded.'
    );

    setTab('overview');

  } catch (error) {
    reportError('joinStatus', error, 'Could not join session');
  }
});


/* =============================================================
   15. INVITATION MODAL
============================================================= */

$('copyInviteBtn')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(
      $('inviteLink').value
    );

    $('copyInviteBtn').textContent = 'Copied';

  } catch (error) {
    $('inviteLink')?.select();
    document.execCommand('copy');
  }
});

function closeModal() {
  $('modalBack')?.classList.add('hidden');
}

$('closeModal')?.addEventListener('click', closeModal);
$('doneModal')?.addEventListener('click', closeModal);


/* =============================================================
   16. ASSET MANAGEMENT
============================================================= */

$('addAssetBtn')?.addEventListener('click', async () => {
  if (!state.user) {
    showAuth('login');
    return;
  }

  const name = $('assetName')?.value.trim() || '';
  const identifier = $('assetId')?.value.trim() || '';

  if (!name || !identifier) {
    alert('Enter an asset name and identifier.');
    return;
  }

  try {
    await addDoc(collection(db, 'assets'), {
      ownerUid: state.user.uid,
      name,
      identifier,
      createdAt: serverTimestamp()
    });

    $('assetName').value = '';
    $('assetId').value = '';

    if ($('assetModel')) $('assetModel').value = '';
    if ($('assetServiceDate')) $('assetServiceDate').value = '';

    logActivity('Asset added', name);

  } catch (error) {
    console.error('Asset creation failed:', error);
    alert(friendlyError(error));
  }
});


/* =============================================================
   17. LOAD AND DISPLAY ASSETS
============================================================= */

function watchAssets(uid) {
  const assetsQuery = query(
    collection(db, 'assets'),
    where('ownerUid', '==', uid)
  );

  const unsubscribe = onSnapshot(
    assetsQuery,

    snapshot => {
      const list = $('assetList');
      if (!list) return;

      list.replaceChildren();

      say('assetCount', String(snapshot.size));

      if (snapshot.empty) {
        const paragraph = document.createElement('p');
        paragraph.textContent = 'No assets registered yet.';
        list.append(paragraph);
      }

      snapshot.docs.forEach(document => {
        const asset = document.data();

        const row = document.createElement('div');
        row.className = 'person';

        const info = document.createElement('div');
        const name = document.createElement('strong');
        const identifier = document.createElement('small');

        name.textContent = asset.name || 'Unnamed asset';
        identifier.textContent =
          asset.identifier || 'No identifier';

        info.append(name, identifier);

        const removeButton = document.createElement('button');
        removeButton.className = 'danger';
        removeButton.textContent = 'Delete';

        removeButton.addEventListener('click', async () => {
          if (!confirm('Delete this asset?')) return;

          try {
            await deleteDoc(doc(db, 'assets', document.id));
            logActivity('Asset deleted', asset.name);

          } catch (error) {
            alert(friendlyError(error));
          }
        });

        row.append(info, removeButton);
        list.append(row);
      });
    },

    error => {
      reportError('assetList', error, 'Could not load assets');
    }
  );

  state.unsubscribers.push(unsubscribe);
}


/* =============================================================
   18. EXPORT ASSETS
============================================================= */

$('exportBtn')?.addEventListener('click', async () => {
  if (!state.user) return;

  try {
    const snapshot = await getDocs(
      query(
        collection(db, 'assets'),
        where('ownerUid', '==', state.user.uid)
      )
    );

    const data = snapshot.docs.map(document => {
      const asset = document.data();

      return {
        name: asset.name || '',
        identifier: asset.identifier || '',
        createdAt:
          asset.createdAt?.toDate?.().toISOString() || null
      };
    });

    const blob = new Blob(
      [JSON.stringify(data, null, 2)],
      { type: 'application/json' }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = 'kintrack-assets.json';

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Export failed:', error);
    alert(friendlyError(error));
  }
});


/* =============================================================
   19. DELETE ALL ASSETS
============================================================= */

$('deleteBtn')?.addEventListener('click', async () => {
  if (!state.user) return;

  if (!confirm(
    'Delete all your registered assets? This does not delete your account or payment history.'
  )) {
    return;
  }

  try {
    const snapshot = await getDocs(
      query(
        collection(db, 'assets'),
        where('ownerUid', '==', state.user.uid)
      )
    );

    await Promise.all(
      snapshot.docs.map(document =>
        deleteDoc(doc(db, 'assets', document.id))
      )
    );

    logActivity(
      'Assets deleted',
      'All registered assets removed.'
    );

  } catch (error) {
    console.error('Asset deletion failed:', error);
    alert(friendlyError(error));
  }
});


/* =============================================================
   20. SUBSCRIPTION STATUS
============================================================= */

function watchSubscription(uid) {
  const unsubscribe = onSnapshot(
    doc(db, 'subscriptions', uid),

    snapshot => {
      if (snapshot.exists() && snapshot.data().active) {
        const paidThrough =
          snapshot.data().paidThrough?.toDate?.().toLocaleString() ||
          'pending update';

        say(
          'trialState',
          `Active. Paid through ${paidThrough}.`
        );

      } else {
        say(
          'trialState',
          'No verified active subscription.'
        );
      }
    },

    error => {
      reportError('trialState', error);
    }
  );

  state.unsubscribers.push(unsubscribe);
}


/* =============================================================
   21. M-PESA CHECKOUT
============================================================= */

$('payBtn')?.addEventListener('click', async () => {
  if (!state.user) {
    showAuth('login');
    return;
  }

  if (!$('payConfirm')?.checked) {
    say(
      'payStatus',
      'Confirm the price before starting checkout.'
    );
    return;
  }

  const phone = $('phone')?.value.trim() || '';

  if (!/^((254[17]\d{8})|(0[17]\d{8})|([17]\d{8}))$/.test(phone)) {
    say(
      'payStatus',
      'Enter a valid Kenyan mobile number, e.g. 2547XXXXXXXX.'
    );
    return;
  }

  const button = $('payBtn');
  if (button) button.disabled = true;

  say('payStatus', 'Requesting secure M-Pesa STK Push…');

  try {
    const result = await httpsCallable(
      functions,
      'startMpesaPayment'
    )({
      phone,
      confirmedPrice: 100
    });

    say(
      'payStatus',
      `${result.data.message || 'STK Push request accepted by the server.'} Check your phone for the M-Pesa prompt. Reference: ${result.data.paymentId}. Access will update only after server verification.`
    );

    logActivity(
      'M-Pesa checkout initiated',
      result.data.paymentId
    );

  } catch (error) {
    reportError(
      'payStatus',
      error,
      'Payment request failed'
    );

  } finally {
    if (button) button.disabled = false;
  }
});


/* =============================================================
   22. APPLICATION INITIALIZATION
============================================================= */

function startApp() {
  const urlInvite = new URLSearchParams(
    window.location.search
  ).get('invite');

  if (urlInvite && /^[A-F0-9]{10}$/i.test(urlInvite)) {
    if ($('joinCode')) {
      $('joinCode').value = urlInvite.toUpperCase();
    }

    say(
      'joinStatus',
      'Invitation link detected. Sign in, then review and join this session.'
    );
  }

  if (
    !cfg.firebase ||
    cfg.firebase.apiKey?.startsWith('REPLACE_')
  ) {
    say(
      'authMessage',
      'Configure firebase-config.js to connect KinTrack to Firebase.'
    );
    return;
  }

  try {
    app = initializeApp(cfg.firebase);
    auth = getAuth(app);

    /*
     * Firebase SDK 10.14.1:
     * Auto-detect long polling where required.
     * Disable fetch streams to improve compatibility
     * with networks that interrupt Firestore streams.
     *
     * Initialize Firestore only once.
     */
    db = initializeFirestore(app, {
      experimentalAutoDetectLongPolling: true,
      useFetchStreams: false
    });

    functions = getFunctions(
      app,
      cfg.functionsRegion || 'africa-south1'
    );

    updateNetworkStatus(navigator.onLine);
    initMap();

    onAuthStateChanged(auth, async user => {
      state.user = user;
      state.authReady = true;

      clearSubscriptions();

      if (user) {
        $('authOverlay')?.classList.add('hidden');

        if ($('accountBtn')) {
          $('accountBtn').textContent =
            user.displayName || user.email || 'Account';
        }

        $('signOutBtn')?.classList.remove('hidden');

        say('trialBadge', 'Secure account connected');

        watchAssets(user.uid);
        watchSubscription(user.uid);

        say(
          'auditList',
          'Security audit events are server-managed and are not exposed to this account.'
        );

        if (state.shareId) {
          await restoreSharingSession(user);
        }

      } else {
        $('authOverlay')?.classList.remove('hidden');
        $('signOutBtn')?.classList.add('hidden');

        if ($('accountBtn')) {
          $('accountBtn').textContent = 'Account';
        }

        say('trialBadge', 'Sign in to continue');

        if ($('assetList')) {
          $('assetList').innerHTML =
            '<p>Sign in to load your assets.</p>';
        }

        drawLocations(new Map());
      }
    });

  } catch (error) {
    console.error('KinTrack initialization failed:', error);

    say(
      'authMessage',
      'Firebase initialization failed: ' + friendlyError(error)
    );
  }
}


/* =============================================================
   23. START APPLICATION
============================================================= */

startApp();
