'use strict';
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const crypto = require('crypto');
admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: 'africa-south1', maxInstances: 10, timeoutSeconds: 60 });

const DARAJA_CONSUMER_KEY = defineSecret('DARAJA_CONSUMER_KEY');
const DARAJA_CONSUMER_SECRET = defineSecret('DARAJA_CONSUMER_SECRET');
const DARAJA_SHORTCODE = defineSecret('DARAJA_SHORTCODE');
const DARAJA_PASSKEY = defineSecret('DARAJA_PASSKEY');
const DARAJA_CALLBACK_TOKEN = defineSecret('DARAJA_CALLBACK_TOKEN');
const DARAJA_ENV = defineSecret('DARAJA_ENV'); // sandbox or production

const now = () => admin.firestore.FieldValue.serverTimestamp();
function requireUser(req) { if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in first.'); return req.auth.uid; }
function cleanString(v, max=100) { return typeof v === 'string' ? v.trim().slice(0,max) : ''; }
function hash(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function randomCode() { return crypto.randomBytes(5).toString('hex').toUpperCase(); }
function darajaBase() { return DARAJA_ENV.value() === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'; }
async function darajaToken() {
  const basic = Buffer.from(`${DARAJA_CONSUMER_KEY.value()}:${DARAJA_CONSUMER_SECRET.value()}`).toString('base64');
  const r = await fetch(`${darajaBase()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` } });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Daraja OAuth failed: ' + JSON.stringify(j));
  return j.access_token;
}
function timestamp() { const d = new Date(); return d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0')+String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0')+String(d.getSeconds()).padStart(2,'0'); }
function stkPassword(ts) { return Buffer.from(`${DARAJA_SHORTCODE.value()}${DARAJA_PASSKEY.value()}${ts}`).toString('base64'); }
function normalisePhone(phone) {
  let p = String(phone || '').replace(/[\s+()-]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  if (!/^254[17]\d{8}$/.test(p)) throw new HttpsError('invalid-argument', 'Use a Kenyan Safaricom number such as 2547XXXXXXXX.');
  return p;
}

exports.createShare = onCall(async (req) => {
  const uid = requireUser(req);
  const minutes = Number(req.data?.durationMinutes);
  if (![15,60,480,1440].includes(minutes)) throw new HttpsError('invalid-argument', 'Choose a valid sharing duration.');
  const code = randomCode();
  const ref = db.collection('shares').doc();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + minutes*60*1000);
  const batch = db.batch();
  batch.set(ref, { ownerUid: uid, inviteCodeHash: hash(code), expiresAt, createdAt: now(), status: 'active', purpose: 'Voluntary real-time location sharing' });
  batch.set(ref.collection('members').doc(uid), { uid, displayName: cleanString(req.auth.token.name || req.auth.token.email || 'Member'), active: true, consentAt: now(), consentVersion: 'v1', role: 'owner' });
  await batch.commit();
  await db.collection('audit').add({ uid, action: 'share.created', shareId: ref.id, at: now() });
  return { shareId: ref.id, inviteCode: code, expiresAt: expiresAt.toDate().toISOString() };
});

exports.joinShare = onCall(async (req) => {
  const uid = requireUser(req);
  const code = cleanString(req.data?.inviteCode, 32).toUpperCase();
  if (!/^[A-F0-9]{10}$/.test(code)) throw new HttpsError('invalid-argument', 'Invite code is invalid.');
  const snap = await db.collection('shares').where('inviteCodeHash', '==', hash(code)).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'Invite code was not found or has expired.');
  const share = snap.docs[0]; const data = share.data();
  if (data.status !== 'active' || !data.expiresAt || data.expiresAt.toMillis() <= Date.now()) throw new HttpsError('failed-precondition', 'This sharing session has expired.');
  if (data.ownerUid === uid) throw new HttpsError('failed-precondition', 'You are already the owner of this session.');
  await share.ref.collection('members').doc(uid).set({ uid, displayName: cleanString(req.auth.token.name || req.auth.token.email || 'Participant'), active: true, consentAt: now(), consentVersion: 'v1', role: 'participant' });
  await db.collection('audit').add({ uid, action: 'share.joined', shareId: share.id, at: now() });
  return { shareId: share.id, expiresAt: data.expiresAt.toDate().toISOString() };
});

exports.stopSharing = onCall(async (req) => {
  const uid = requireUser(req); const shareId = cleanString(req.data?.shareId, 100);
  if (!shareId) throw new HttpsError('invalid-argument', 'Missing share ID.');
  const ref = db.collection('shares').doc(shareId); const memberRef = ref.collection('members').doc(uid);
  const member = await memberRef.get(); if (!member.exists || !member.data().active) return { stopped: true };
  await memberRef.update({ active: false, stoppedAt: now() });
  await ref.collection('locations').doc(uid).delete().catch(()=>{});
  const share = await ref.get();
  if (share.exists && share.data().ownerUid === uid) await ref.update({ status: 'stopped', stoppedAt: now() });
  await db.collection('audit').add({ uid, action: 'share.stopped', shareId, at: now() });
  return { stopped: true };
});

exports.startMpesaPayment = onCall({ secrets: [DARAJA_CONSUMER_KEY,DARAJA_CONSUMER_SECRET,DARAJA_SHORTCODE,DARAJA_PASSKEY,DARAJA_ENV] }, async (req) => {
  const uid = requireUser(req);
  if (req.app == null) { /* App Check is recommended; enable enforcement after configuring the client. */ }
  if (req.data?.confirmedPrice !== 100) throw new HttpsError('failed-precondition', 'Confirm the displayed KSh 100 price.');
  const phone = normalisePhone(req.data?.phone);
  const amount = 100;
  const ts = timestamp(); const base = darajaBase(); const token = await darajaToken();
  const callbackUrl = `https://africa-south1-${process.env.GCLOUD_PROJECT || 'YOUR_PROJECT_ID'}.cloudfunctions.net/darajaCallback?token=${encodeURIComponent(DARAJA_CALLBACK_TOKEN.value())}`;
  const payload = {
    BusinessShortCode: DARAJA_SHORTCODE.value(), Password: stkPassword(ts), Timestamp: ts,
    TransactionType: 'CustomerPayBillOnline', Amount: amount, PartyA: phone,
    PartyB: DARAJA_SHORTCODE.value(), PhoneNumber: phone,
    CallBackURL: callbackUrl, AccountReference: `KT-${uid.slice(0,8)}`,
    TransactionDesc: 'KinTrack subscription day'
  };
  const response = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok || result.ResponseCode !== '0' || !result.CheckoutRequestID) {
    console.error('STK push rejected', result);
    throw new HttpsError('internal', result.CustomerMessage || 'Daraja could not start the payment. Check server configuration.');
  }
  const paymentId = result.CheckoutRequestID;
  await db.collection('payments').doc(paymentId).create({ uid, phone, amount, currency: 'KES', status: 'pending', merchantRequestId: result.MerchantRequestID || null, checkoutRequestId: paymentId, createdAt: now(), environment: DARAJA_ENV.value() });
  await db.collection('audit').add({ uid, action: 'payment.initiated', paymentId, at: now() });
  return { success: true, paymentId, message: result.CustomerMessage || 'Check your phone and enter your M-Pesa PIN if you wish to pay.' };
});

async function queryDaraja(checkoutRequestId) {
  const token = await darajaToken(); const ts = timestamp();
  const payload = { BusinessShortCode: DARAJA_SHORTCODE.value(), Password: stkPassword(ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId };
  const r = await fetch(`${darajaBase()}/mpesa/stkpushquery/v1/query`, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
  return { httpOk:r.ok, data:await r.json() };
}

exports.darajaCallback = onRequest({ secrets: [DARAJA_CONSUMER_KEY,DARAJA_CONSUMER_SECRET,DARAJA_SHORTCODE,DARAJA_PASSKEY,DARAJA_CALLBACK_TOKEN,DARAJA_ENV], cors: false }, async (req,res) => {
  if (req.method !== 'POST') return res.status(405).json({ ResultCode: 1, ResultDesc: 'POST required' });
  const expected = DARAJA_CALLBACK_TOKEN.value();
  if (!expected || !req.query.token || Buffer.byteLength(String(req.query.token)) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(String(req.query.token)), Buffer.from(expected))) return res.status(401).json({ ResultCode: 1, ResultDesc: 'Unauthorized callback' });
  const cb = req.body?.Body?.stkCallback;
  if (!cb?.CheckoutRequestID || !cb?.ResultCode && cb?.ResultCode !== 0) return res.status(400).json({ ResultCode: 1, ResultDesc: 'Malformed callback' });
  const paymentRef = db.collection('payments').doc(String(cb.CheckoutRequestID));
  try {
    const existing = await paymentRef.get();
    if (!existing.exists) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Unknown checkout ignored' });
    if (existing.data().status === 'paid' || existing.data().status === 'failed') return res.status(200).json({ ResultCode: 0, ResultDesc: 'Already processed' });
    // Daraja callbacks are not signed. Verify by querying Daraja server-to-server before granting entitlement.
    const verification = await queryDaraja(String(cb.CheckoutRequestID));
    const q = verification.data || {};
    const callbackResultCode = Number(cb.ResultCode);
    const queryCode = Number(q.ResultCode);
    const callbackItems = cb.CallbackMetadata?.Item || [];
    const item = key => callbackItems.find(x=>x.Name===key)?.Value;
    const callbackAmount = Number(item('Amount'));
    const callbackPhone = item('PhoneNumber') ? String(item('PhoneNumber')) : '';
    const callbackReceipt = item('MpesaReceiptNumber') ? String(item('MpesaReceiptNumber')) : '';
    const tx = existing.data();
    const successful = verification.httpOk && queryCode === 0 && callbackResultCode === 0 && callbackAmount === tx.amount && callbackPhone === tx.phone && /^[A-Z0-9]{8,16}$/.test(callbackReceipt);
    if (successful) {
      await db.runTransaction(async t => {
        const fresh = await t.get(paymentRef); if (!fresh.exists || fresh.data().status !== 'pending') return;
        t.update(paymentRef, { status:'paid', receipt:callbackReceipt, verifiedAt:now(), callbackResultCode, queryResultCode:queryCode });
        const subRef = db.collection('subscriptions').doc(tx.uid);
        const subSnap = await t.get(subRef);
        const existingThrough = subSnap.exists && subSnap.data().paidThrough ? subSnap.data().paidThrough.toMillis() : 0;
        const baseTime = Math.max(Date.now(), existingThrough);
        t.set(subRef, { uid:tx.uid, active:true, paidThrough:admin.firestore.Timestamp.fromMillis(baseTime+86400000), lastPaymentId:cb.CheckoutRequestID, updatedAt:now() }, { merge:true });
      });
    } else if (callbackResultCode !== 0) {
      await paymentRef.update({ status:'failed', resultCode:callbackResultCode, resultDescription:cleanString(cb.ResultDesc,300), verifiedAt:now() });
    } else {
      await paymentRef.update({ status:'review', callbackResultCode, queryResultCode:Number.isFinite(queryCode)?queryCode:null, reviewReason:'Daraja query/callback metadata did not match expected amount, phone or receipt.', verifiedAt:now() });
    }
    return res.status(200).json({ ResultCode:0, ResultDesc:'Callback received' });
  } catch (e) {
    console.error('Daraja callback processing error', e);
    // A non-200 response may cause retries; idempotency keeps retries safe.
    return res.status(500).json({ ResultCode:1, ResultDesc:'Temporary verification error' });
  }
});


// Delete expired/stopped sessions and their precise location documents. Requires Scheduler billing.
exports.cleanupExpiredShares = onSchedule('every 15 minutes', async () => {
  const nowTs = admin.firestore.Timestamp.now();
  const expired = await db.collection('shares').where('expiresAt', '<=', nowTs).limit(100).get();
  const stopped = await db.collection('shares').where('status', '==', 'stopped').limit(100).get();
  const refs = new Map();
  expired.docs.forEach(d => refs.set(d.id, d.ref));
  stopped.docs.forEach(d => refs.set(d.id, d.ref));
  for (const [shareId, ref] of refs) {
    const [members, locations] = await Promise.all([
      ref.collection('members').limit(200).get(),
      ref.collection('locations').limit(200).get()
    ]);
    const batch = db.batch();
    locations.docs.forEach(d => batch.delete(d.ref));
    members.docs.forEach(d => batch.delete(d.ref));
    batch.update(ref, { status: 'expired', inviteCodeHash: admin.firestore.FieldValue.delete(), cleanedAt: now() });
    await batch.commit();
  }
});
