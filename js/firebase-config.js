// Firebase web config for Google sign-in + cloud sync.
// Paste the values from Firebase console → Project settings → Your apps → Web app.
// These values are public by design; your data is protected by firestore.rules
// (each Google account can only read and write its own stack).
// Leave apiKey empty to keep cloud sync switched off.
export default {
  apiKey: '',
  authDomain: '',
  projectId: '',
  appId: '',
};
