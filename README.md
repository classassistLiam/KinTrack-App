# KinTrack — GitHub Pages + Firebase + Google Maps + Daraja

This is a production-oriented starter that keeps the existing KinTrack sage/teal dashboard and police-officer registration illustration while replacing browser-only demo data with Firebase Authentication, Firestore and callable Cloud Functions.

## Included

- `index.html`, `app.js`, `firebase-config.js`: GitHub Pages frontend; Firebase email/password auth; Google Maps JavaScript API; consent-based location sharing; assets; checkout initiation.
- `firestore.rules`: default-deny rules. Sharing records and participant consent are written by Cloud Functions; only active participants may read session data; users may only create/read their own assets.
- `functions/index.js`: time-limited invite creation, invite acceptance, stop-sharing, Daraja STK Push, callback idempotency, server-to-server STK query before subscription entitlement.
- `firebase.json`, `firestore.indexes.json`, `functions/package.json`: Firebase CLI deployment files.

## Important truth-in-labeling

This code is not yet a launched/verified production service. You must add your own Firebase project values, Maps key, Daraja credentials, test on the Daraja sandbox, deploy rules/functions, and perform security/payment tests. The browser Firebase config and Maps browser key are public by design. The Maps key must be restricted by HTTP referrer and API; Daraja secrets must never be put in this repository.

The web app uses browser `watchPosition`; it updates while the KinTrack page is open and the browser allows it. It does not provide background tracking when the page is closed. A participant's location is stored in Firestore only after the user accepts the sharing session, checks the separate location-consent box, and grants browser location permission. Sharing expires after the selected duration; the page must remain open for live updates.

Daraja callbacks are not signed with a universal callback HMAC. This implementation checks a callback token and known checkout record, performs a server-to-server STK query, validates the callback amount/phone/receipt, and processes the checkout idempotently. Before production, verify current Daraja callback and query semantics with Safaricom, add reconciliation/alerts, and do end-to-end tests. Never treat a browser message as proof of payment.

## 1. Create Firebase project

1. Open https://console.firebase.google.com and create a project.
2. Add a **Web app** and copy its `apiKey`, `authDomain`, `projectId`, and `appId` into `firebase-config.js`.
3. In **Authentication → Sign-in method**, enable **Email/Password**. In **Settings → Authorized domains**, add your GitHub Pages domain (for example `samterrencekabatha.github.io`).
4. In **Firestore Database**, create a database in production mode. Choose a location near your users where available; changing location later requires migration.
5. Billing: deploying Cloud Functions requires the Firebase/Google Cloud Blaze billing plan. Set budget alerts before proceeding.

## 2. Configure Google Maps JavaScript API

1. Open https://console.cloud.google.com and select the same Google Cloud project linked to Firebase.
2. Enable **Maps JavaScript API** and attach a billing account. Google Maps requires a valid API key and billing.
3. Create a dedicated browser key. Under **Application restrictions**, choose **Websites (HTTP referrers)**. Add your exact GitHub Pages site pattern, e.g. `https://samterrencekabatha.github.io/*` (if your site is a project page, use the same account origin and test the referrer). Add localhost patterns only while developing, then remove them for production.
4. Under **API restrictions**, restrict the key to **Maps JavaScript API** only. Set quotas/budget alerts.
5. Paste the key into `mapsApiKey` in `firebase-config.js`.

A browser Maps key cannot be kept secret inside HTML. The correct protection is strict website + API restrictions and quota monitoring; do not put server-side Google web-service keys in the frontend.

## 3. Deploy Firebase rules and Cloud Functions

Install Node.js 20 LTS and Firebase CLI on your computer. In Git Bash / PowerShell:

```bash
npm install -g firebase-tools
firebase login
cd path/to/kintrack-production
firebase use --add
```

Select your Firebase project and save the alias. Before deploying, edit `functions/index.js` if you need a different region; the current region is `africa-south1`.

Set Daraja secrets interactively. Use the values from your Safaricom Daraja app; never commit them:

```bash
firebase functions:secrets:set DARAJA_CONSUMER_KEY
firebase functions:secrets:set DARAJA_CONSUMER_SECRET
firebase functions:secrets:set DARAJA_SHORTCODE
firebase functions:secrets:set DARAJA_PASSKEY
firebase functions:secrets:set DARAJA_CALLBACK_TOKEN
firebase functions:secrets:set DARAJA_ENV
```

For `DARAJA_ENV`, enter `sandbox` first. `DARAJA_CALLBACK_TOKEN` should be a long random string (at least 32 random bytes represented as hex). The function creates a callback URL using the Firebase project ID and `africa-south1` region. After the first deployment, confirm the exact deployed `darajaCallback` URL in the Firebase console and with Safaricom; if Safaricom requires a callback URL to be registered/allowlisted in the Daraja portal, register the exact URL. Do not switch to production until Safaricom has approved production credentials and callback configuration.

Then deploy:

```bash
cd functions
npm install
npm run lint
cd ..
firebase deploy --only firestore:rules,functions
```

If the Firebase CLI prompts for API enablement or billing, follow the console instructions. Do not continue to live payments until all secrets are set and sandbox verification passes.

## 4. Publish on GitHub Pages

1. Put `index.html`, `app.js`, and `firebase-config.js` in the root of your GitHub repository. Keep `firebase.json`, `firestore.rules`, and `functions/` in the same repository so you can deploy backend changes from your computer.
2. Commit and push the files. In GitHub → repository **Settings → Pages**, select the `main` branch and `/ (root)` (or your chosen folder).
3. Open the HTTPS Pages URL. Do not test geolocation from `file://`; browser geolocation requires a secure context (HTTPS or localhost).
4. Ensure your GitHub Pages domain is listed under Firebase Authentication authorized domains and the Maps HTTP referrer restriction.

## 5. Test the consent-first location flow

1. Register two separate test accounts in two browsers/devices.
2. Account A clicks **Create sharing invite** and sends the 10-character code to Account B through a channel you choose.
3. Account B enters the code and confirms the join prompt. Joining alone does not share coordinates.
4. On each device, open **Consent & devices**, tick the explicit location consent, choose the duration, click **Confirm consent & start sharing**, and grant browser permission.
5. Confirm that only active participants' markers are shown. Click **Stop my sharing** and confirm that updates stop and the location document is deleted. Test expiry and a revoked/expired session.
6. In Firestore Rules Playground or emulator tests, verify a non-member cannot read session documents and a user cannot write another user's location/assets.

## 6. Test Daraja payments safely

1. Use Daraja sandbox credentials, shortcode and passkey from your sandbox app. Use a test Safaricom number accepted by the sandbox.
2. Verify the deployed callback URL is publicly reachable over HTTPS and is registered with Safaricom if required.
3. Initiate a checkout from the signed-in app. The phone should receive the STK prompt in the sandbox flow. Check Cloud Functions logs and the `payments` document.
4. Test success, cancellation, timeout, duplicate callback, callback retry, wrong amount, wrong phone, unknown checkout ID, and delayed callback. A duplicate callback must not extend access twice.
5. Reconcile successful receipts against Daraja/M-Pesa records before granting real users access. Add monitoring and support processes.

## Working after configuration

- Firebase email/password registration and sign-in.
- Firestore-backed asset CRUD with owner-only rules.
- Google Maps map loading (after key and billing setup).
- Time-limited share invitations; a recipient must accept; separate explicit location consent; browser real-time updates; stop/revoke flow.
- Daraja STK Push initiation and backend callback processing structure.

## Not finished / production prerequisites

- No actual Firebase project credentials, Maps key, Daraja secrets, or production shortcode are included.
- No independent penetration test, Firebase Emulator Suite test suite, formal privacy-policy/legal review, data protection impact assessment, support/refund workflow, or operational monitoring is included.
- The starter does not yet include account deletion, automated Firestore TTL cleanup, SMS/email invite delivery, push notifications, native/background location, admin portal, comprehensive subscription gating across every feature, or automated payment reconciliation.
- Daraja callback/query fields can vary by integration state; confirm current official docs and perform sandbox tests before trusting a callback for entitlement. The callback endpoint is internet-facing by design.
- Consider enabling Firebase App Check and enforcing it for callable functions after you add the App Check client provider and verify legitimate traffic. Add rate limiting/abuse detection and budget alerts.

## Official references

- Firebase web SDK: https://firebase.google.com/docs/web/learn-more
- Firestore security rules: https://firebase.google.com/docs/firestore/security/get-started
- Firebase Functions secrets: https://firebase.google.com/docs/functions/config-env
- Maps API key security: https://developers.google.com/maps/api-security-best-practices
- Maps JavaScript API troubleshooting/billing: https://developers.google.com/maps/documentation/javascript/troubleshooting
- Safaricom Daraja portal: https://developer.safaricom.co.ke/
# KinTrack-App
