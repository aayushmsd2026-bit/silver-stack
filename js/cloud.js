// Google sign-in + Firestore sync. Exposes window.StackCloud and fires "stackcloud" when ready.
// Loaded as a module so a failure here (offline, not configured) never breaks the app itself.
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

function ready(api) {
  window.StackCloud = api;
  window.dispatchEvent(new Event('stackcloud'));
}

(async () => {
  let config;
  try { config = (await import('./firebase-config.js')).default; } catch (_) { config = {}; }
  if (!config || !config.apiKey) return ready({ enabled: false, reason: 'not-configured' });

  let fb;
  try {
    const [app, auth, fs] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    fb = { ...app, ...auth, ...fs };
  } catch (e) {
    return ready({ enabled: false, reason: 'offline' });
  }

  const app = fb.initializeApp(config);
  const auth = fb.getAuth(app);
  const db = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache() });
  const provider = new fb.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  // Completes a redirect sign-in (used when popups are blocked).
  fb.getRedirectResult(auth).catch(() => {});

  const ref = uid => fb.doc(db, 'stacks', uid);
  const decode = snap => {
    if (!snap.exists()) return null;
    try { return JSON.parse(snap.data().payload); } catch (_) { return null; }
  };

  ready({
    enabled: true,
    get user() { return auth.currentUser; },
    onUser(cb) { return fb.onAuthStateChanged(auth, cb); },
    async signIn() {
      try {
        await fb.signInWithPopup(auth, provider);
      } catch (e) {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
          await fb.signInWithRedirect(auth, provider);
        } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
          throw e;
        }
      }
    },
    signOut() { return fb.signOut(auth); },
    async load() {
      const u = auth.currentUser;
      return u ? decode(await fb.getDoc(ref(u.uid))) : null;
    },
    async save(data) {
      const u = auth.currentUser;
      if (!u) return;
      // Stored as a JSON string so the shape of the app's data never trips Firestore's field rules.
      await fb.setDoc(ref(u.uid), { updatedAt: data.updatedAt, payload: JSON.stringify(data) });
    },
    watch(cb) {
      const u = auth.currentUser;
      if (!u) return () => {};
      return fb.onSnapshot(ref(u.uid), snap => {
        if (snap.metadata.hasPendingWrites) return; // our own write echoing back
        cb(decode(snap));
      });
    },
  });
})();
