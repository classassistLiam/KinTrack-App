
'use strict';

/**
 * KINTRACK — Firebase Cloud Functions
 * Region: africa-south1
 * Runtime: Node.js 20
 *
 * Preserves:
 * - createShare
 * - joinShare
 * - stopSharing
 * - startMpesaPayment
 * - darajaCallback
 * - cleanupExpiredShares
 *
 * Payment policy:
 * - Fixed subscription price: KES 100
 * - Subscription period: 24 hours per verified payment
 * - No client-side payment confirmation
 * - No subscription activation before verification
 */

const { onCall, onRequest, HttpsError } =
  require('firebase-functions/v2/https');

const { defineSecret } =
  require('firebase-functions/params');

const { setGlobalOptions } =
  require('firebase-functions/v2');

const { onSchedule } =
  require('firebase-functions/v2/scheduler');

const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

setGlobalOptions({
  region: 'africa-south1',
  maxInstances: 10,
  timeoutSeconds: 60
});


/* ============================================================
   1. DARАJA SECRETS
============================================================ */

const DARAJA_CONSUMER_KEY =
  defineSecret('DARAJA_CONSUMER_KEY');

const DARAJA_CONSUMER_SECRET =
  defineSecret('DARAJA_CONSUMER_SECRET');

const DARAJA_SHORTCODE =
  defineSecret('DARAJA_SHORTCODE');

const DARAJA_PASSKEY =
  defineSecret('DARAJA_PASSKEY');

const DARAJA_CALLBACK_TOKEN =
  defineSecret('DARAJA_CALLBACK_TOKEN');

const DARAJA_ENV =
  defineSecret('DARAJA_ENV');


const PAYMENT_SECRETS = [
  DARAJA_CONSUMER_KEY,
  DARAJA_CONSUMER_SECRET,
  DARAJA_SHORTCODE,
  DARAJA_PASSKEY,
  DARAJA_CALLBACK_TOKEN,
  DARAJA_ENV
];

const STK_SECRETS = [
  DARAJA_CONSUMER_KEY,
  DARAJA_CONSUMER_SECRET,
  DARAJA_SHORTCODE,
  DARAJA_PASSKEY,
  DARAJA_CALLBACK_TOKEN,
  DARAJA_ENV
];


/* ============================================================
   2. CONSTANTS AND HELPERS
============================================================ */

const SUBSCRIPTION_PRICE = 100;
const SUBSCRIPTION_DURATION_MS = 24 * 60 * 60 * 1000;

const SERVER_TIMESTAMP =
  () => admin.firestore.FieldValue.serverTimestamp();

function requireUser(request) {
  if (!request.auth) {
    throw new HttpsError(
      'unauthenticated',
      'Please sign in before continuing.'
    );
  }

  return request.auth.uid;
}

function cleanString(value, maxLength = 100) {
  return typeof value === 'string'
    ? value.trim().slice(0, maxLength)
    : '';
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');
}

function randomCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase();
}

function projectId() {
  return admin.app().options.projectId ||
    process.env.GCLOUD_PROJECT;
}

function darajaBase() {
  const environment = DARAJA_ENV.value()
    .trim()
    .toLowerCase();

  if (environment === 'production') {
    return 'https://api.safaricom.co.ke';
  }

  if (environment === 'sandbox') {
    return 'https://sandbox.safaricom.co.ke';
  }

  throw new Error(
    'DARAJA_ENV must be either sandbox or production.'
  );
}

function getNairobiTimestamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return (
    values.year +
    values.month +
    values.day +
    values.hour +
    values.minute +
    values.second
  );
}

function stkPassword(timestamp) {
  const shortcode = DARAJA_SHORTCODE.value();
  const passkey = DARAJA_PASSKEY.value();

  return Buffer.from(
    `${shortcode}${passkey}${timestamp}`
  ).toString('base64');
}

function normalisePhone(phone) {
  let value = String(phone || '')
    .replace(/[\s+()-]/g, '');

  if (value.startsWith('0')) {
    value = '254' + value.slice(1);
  }

  if (value.startsWith('7') || value.startsWith('1')) {
    value = '254' + value;
  }

  if (!/^254[17]\d{8}$/.test(value)) {
    throw new HttpsError(
      'invalid-argument',
      'Enter a valid Kenyan mobile number, such as 2547XXXXXXXX.'
    );
  }

  return value;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return (
    left.length === right.length &&
    crypto.timingSafeEqual(left, right)
  );
}

async function readJsonResponse(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Daraja returned an invalid response. HTTP ${response.status}.`
    );
  }
}

function callbackUrl() {
  const id = projectId();

  if (!id) {
    throw new Error(
      'Firebase project ID is unavailable.'
    );
  }

  const token = DARAJA_CALLBACK_TOKEN.value();

  if (!token || token.length < 32) {
    throw new Error(
      'DARAJA_CALLBACK_TOKEN must contain at least 32 characters.'
    );
  }

  return (
    `https://africa-south1-${id}.cloudfunctions.net/darajaCallback` +
    `?token=${encodeURIComponent(token)}`
  );
}

function extractCallbackItem(items, name) {
  const entry = Array.isArray(items)
    ? items.find(item => item && item.Name === name)
    : null;

  return entry ? entry.Value : undefined;
}


/* ============================================================
   3. DARАJA OAUTH
============================================================ */

async function darajaToken() {
  const consumerKey = DARAJA_CONSUMER_KEY.value();
  const consumerSecret = DARAJA_CONSUMER_SECRET.value();

  if (!consumerKey || !consumerSecret) {
    throw new Error(
      'Daraja consumer credentials are not configured.'
    );
  }

  const credentials = Buffer.from(
    `${consumerKey}:${consumerSecret}`
  ).toString('base64');

  const response = await fetch(
    `${darajaBase()}/oauth/v1/generate?grant_type=client_credentials`,
    {
      method: 'GET',
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(20000)
    }
  );

  const result = await readJsonResponse(response);

  if (!response.ok || !result.access_token) {
    console.error('Daraja OAuth failed:', {
      status: response.status,
      error: result.error,
      errorDescription: result.error_description
    });

    throw new Error(
      'Unable to authenticate with Safaricom Daraja.'
    );
  }

  return result.access_token;
}


/* ============================================================
   4. CREATE LOCATION SHARING SESSION
============================================================ */

exports.createShare = onCall(async request => {
  const uid = requireUser(request);

  const minutes = Number(
    request.data?.durationMinutes
  );

  if (![15, 60, 480, 1440].includes(minutes)) {
    throw new HttpsError(
      'invalid-argument',
      'Choose a valid sharing duration.'
    );
  }

  const code = randomCode();

  const shareRef = db.collection('shares').doc();

  const expiresAt =
    admin.firestore.Timestamp.fromMillis(
      Date.now() + minutes * 60 * 1000
    );

  const batch = db.batch();

  batch.set(shareRef, {
    ownerUid: uid,
    inviteCodeHash: sha256(code),
    expiresAt,
    createdAt: SERVER_TIMESTAMP(),
    status: 'active',
    purpose: 'Voluntary real-time location sharing'
  });

  batch.set(
    shareRef.collection('members').doc(uid),
    {
      uid,
      displayName: cleanString(
        request.auth.token.name ||
        request.auth.token.email ||
        'Member'
      ),
      active: true,
      consentAt: SERVER_TIMESTAMP(),
      consentVersion: 'v1',
      role: 'owner'
    }
  );

  await batch.commit();

  await db.collection('audit').add({
    uid,
    action: 'share.created',
    shareId: shareRef.id,
    at: SERVER_TIMESTAMP()
  });

  return {
    shareId: shareRef.id,
    inviteCode: code,
    expiresAt: expiresAt.toDate().toISOString()
  };
});


/* ============================================================
   5. JOIN LOCATION SHARING SESSION
============================================================ */

exports.joinShare = onCall(async request => {
  const uid = requireUser(request);

  const code = cleanString(
    request.data?.inviteCode,
    32
  ).toUpperCase();

  if (!/^[A-F0-9]{10}$/.test(code)) {
    throw new HttpsError(
      'invalid-argument',
      'Invite code is invalid.'
    );
  }

  const snapshot = await db
    .collection('shares')
    .where('inviteCodeHash', '==', sha256(code))
    .limit(1)
    .get();

  if (snapshot.empty) {
    throw new HttpsError(
      'not-found',
      'Invite code was not found.'
    );
  }

  const shareDocument = snapshot.docs[0];
  const share = shareDocument.data();

  if (
    share.status !== 'active' ||
    !share.expiresAt ||
    share.expiresAt.toMillis() <= Date.now()
  ) {
    throw new HttpsError(
      'failed-precondition',
      'This sharing session has expired.'
    );
  }

  if (share.ownerUid === uid) {
    throw new HttpsError(
      'failed-precondition',
      'You are already the owner of this session.'
    );
  }

  await shareDocument.ref
    .collection('members')
    .doc(uid)
    .set({
      uid,
      displayName: cleanString(
        request.auth.token.name ||
        request.auth.token.email ||
        'Participant'
      ),
      active: true,
      consentAt: SERVER_TIMESTAMP(),
      consentVersion: 'v1',
      role: 'participant'
    });

  await db.collection('audit').add({
    uid,
    action: 'share.joined',
    shareId: shareDocument.id,
    at: SERVER_TIMESTAMP()
  });

  return {
    shareId: shareDocument.id,
    expiresAt: share.expiresAt.toDate().toISOString()
  };
});


/* ============================================================
   6. STOP LOCATION SHARING
============================================================ */

exports.stopSharing = onCall(async request => {
  const uid = requireUser(request);

  const shareId = cleanString(
    request.data?.shareId,
    100
  );

  if (!shareId) {
    throw new HttpsError(
      'invalid-argument',
      'Missing sharing session ID.'
    );
  }

  const shareRef = db.collection('shares').doc(shareId);
  const memberRef = shareRef.collection('members').doc(uid);

  const member = await memberRef.get();

  if (!member.exists || !member.data().active) {
    return { stopped: true };
  }

  await memberRef.update({
    active: false,
    stoppedAt: SERVER_TIMESTAMP()
  });

  await shareRef
    .collection('locations')
    .doc(uid)
    .delete()
    .catch(() => {});

  const share = await shareRef.get();

  if (share.exists && share.data().ownerUid === uid) {
    await shareRef.update({
      status: 'stopped',
      stoppedAt: SERVER_TIMESTAMP()
    });
  }

  await db.collection('audit').add({
    uid,
    action: 'share.stopped',
    shareId,
    at: SERVER_TIMESTAMP()
  });

  return { stopped: true };
});


/* ============================================================
   7. START M-PESA STK PUSH
============================================================ */

exports.startMpesaPayment = onCall(
  {
    secrets: STK_SECRETS,
    timeoutSeconds: 60
  },

  async request => {
    const uid = requireUser(request);

    // The server, not the browser, controls the subscription price.
    if (Number(request.data?.confirmedPrice) !== SUBSCRIPTION_PRICE) {
      throw new HttpsError(
        'failed-precondition',
        'The subscription price is KSh 100.'
      );
    }

    const phone = normalisePhone(
      request.data?.phone
    );

    let token;
    let timestamp;
    let payload;

    try {
      timestamp = getNairobiTimestamp();
      token = await darajaToken();

      payload = {
        BusinessShortCode: DARAJA_SHORTCODE.value(),
        Password: stkPassword(timestamp),
        Timestamp: timestamp,

        TransactionType: 'CustomerPayBillOnline',

        Amount: SUBSCRIPTION_PRICE,

        PartyA: phone,
        PartyB: DARAJA_SHORTCODE.value(),
        PhoneNumber: phone,

        CallBackURL: callbackUrl(),

        AccountReference: `KT-${uid.slice(0, 8)}`,

        TransactionDesc: 'KinTrack subscription day'
      };

    } catch (error) {
      console.error(
        'Payment configuration error:',
        error.message
      );

      throw new HttpsError(
        'failed-precondition',
        'M-Pesa is not configured correctly. Please contact support.'
      );
    }

    let response;
    let result;

    try {
      response = await fetch(
        `${darajaBase()}/mpesa/stkpush/v1/processrequest`,
        {
          method: 'POST',

          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },

          body: JSON.stringify(payload),

          signal: AbortSignal.timeout(25000)
        }
      );

      result = await readJsonResponse(response);

    } catch (error) {
      console.error(
        'STK request transport error:',
        error.message
      );

      throw new HttpsError(
        'unavailable',
        'Could not reach Safaricom. Please try again.'
      );
    }

    if (
      !response.ok ||
      String(result.ResponseCode) !== '0' ||
      !result.CheckoutRequestID
    ) {
      console.error('STK Push rejected:', {
        httpStatus: response.status,
        responseCode: result.ResponseCode,
        responseDescription: result.ResponseDescription,
        errorCode: result.errorCode
      });

      throw new HttpsError(
        'failed-precondition',
        result.CustomerMessage ||
        result.ResponseDescription ||
        'Safaricom rejected the payment request.'
      );
    }

    const paymentId = String(result.CheckoutRequestID);

    const paymentRef = db
      .collection('payments')
      .doc(paymentId);

    try {
      await paymentRef.create({
        uid,
        phone,
        amount: SUBSCRIPTION_PRICE,
        currency: 'KES',

        status: 'pending',

        merchantRequestId:
          result.MerchantRequestID || null,

        checkoutRequestId: paymentId,

        accountReference: payload.AccountReference,

        createdAt: SERVER_TIMESTAMP(),

        environment: DARAJA_ENV.value(),

        resultDescription:
          result.ResponseDescription || 'STK request accepted'
      });

    } catch (error) {
      console.error(
        'Could not save payment record:',
        error.message
      );

      // Do not pretend the transaction was safely recorded.
      // The callback will be ignored unless a matching payment
      // document exists. Investigate before retrying this payment.
      throw new HttpsError(
        'internal',
        'The payment request was sent but could not be recorded. Contact support before retrying.'
      );
    }

    await db.collection('audit').add({
      uid,
      action: 'payment.initiated',
      paymentId,
      at: SERVER_TIMESTAMP()
    });

    return {
      success: true,
      paymentId,
      message:
        result.CustomerMessage ||
        'STK Push accepted. Check your phone and enter your M-Pesa PIN if you wish to pay.'
    };
  }
);


/* ============================================================
   8. QUERY DARАJA TRANSACTION STATUS
============================================================ */

async function queryDaraja(checkoutRequestId) {
  const token = await darajaToken();
  const timestamp = getNairobiTimestamp();

  const payload = {
    BusinessShortCode: DARAJA_SHORTCODE.value(),
    Password: stkPassword(timestamp),
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId
  };

  const response = await fetch(
    `${darajaBase()}/mpesa/stkpushquery/v1/query`,
    {
      method: 'POST',

      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },

      body: JSON.stringify(payload),

      signal: AbortSignal.timeout(20000)
    }
  );

  const data = await readJsonResponse(response);

  return {
    httpOk: response.ok,
    data
  };
}


/* ============================================================
   9. SAFARICOM CALLBACK
============================================================ */

exports.darajaCallback = onRequest(
  {
    secrets: PAYMENT_SECRETS,
    cors: false,
    timeoutSeconds: 60
  },

  async (request, response) => {

    if (request.method !== 'POST') {
      return response
        .status(405)
        .json({
          ResultCode: 1,
          ResultDesc: 'POST required'
        });
    }

    // Authenticate the callback using a high-entropy token.
    const expectedToken = DARAJA_CALLBACK_TOKEN.value();

    const receivedToken =
      typeof request.query.token === 'string'
        ? request.query.token
        : '';

    if (
      !expectedToken ||
      !safeEqual(receivedToken, expectedToken)
    ) {
      return response
        .status(401)
        .json({
          ResultCode: 1,
          ResultDesc: 'Unauthorized callback'
        });
    }

    const callback = request.body?.Body?.stkCallback;

    if (
      !callback ||
      !callback.CheckoutRequestID ||
      callback.ResultCode === undefined ||
      callback.ResultCode === null
    ) {
      return response
        .status(400)
        .json({
          ResultCode: 1,
          ResultDesc: 'Malformed callback'
        });
    }

    const checkoutRequestId =
      String(callback.CheckoutRequestID);

    const paymentRef = db
      .collection('payments')
      .doc(checkoutRequestId);

    try {
      const existing = await paymentRef.get();

      if (!existing.exists) {
        console.warn(
          'Callback received for unknown payment:',
          checkoutRequestId
        );

        // Acknowledge unknown callbacks, but never grant access.
        return response.status(200).json({
          ResultCode: 0,
          ResultDesc: 'Unknown payment ignored'
        });
      }

      const payment = existing.data();

      // Idempotency: never process the same completed payment twice.
      if (
        payment.status === 'paid' ||
        payment.status === 'failed'
      ) {
        return response.status(200).json({
          ResultCode: 0,
          ResultDesc: 'Payment already processed'
        });
      }

      const callbackResultCode =
        Number(callback.ResultCode);

      // Safaricom has reported cancellation or failure.
      if (callbackResultCode !== 0) {
        await paymentRef.update({
          status: 'failed',
          resultCode: callbackResultCode,

          resultDescription: cleanString(
            callback.ResultDesc,
            300
          ),

          failedAt: SERVER_TIMESTAMP(),
          callbackReceivedAt: SERVER_TIMESTAMP()
        });

        await db.collection('audit').add({
          uid: payment.uid,
          action: 'payment.failed',
          paymentId: checkoutRequestId,
          resultCode: callbackResultCode,
          at: SERVER_TIMESTAMP()
        });

        return response.status(200).json({
          ResultCode: 0,
          ResultDesc: 'Failed payment recorded'
        });
      }

      /*
       * A successful callback alone is not enough.
       * Query Daraja server-to-server before activating access.
       */

      const verification = await queryDaraja(
        checkoutRequestId
      );

      const queryResult = verification.data || {};

      const queryResultCode =
        Number(queryResult.ResultCode);

      const callbackItems =
        callback.CallbackMetadata?.Item || [];

      const callbackAmount = Number(
        extractCallbackItem(callbackItems, 'Amount')
      );

      const callbackPhoneValue =
        extractCallbackItem(callbackItems, 'PhoneNumber');

      const callbackReceipt = String(
        extractCallbackItem(
          callbackItems,
          'MpesaReceiptNumber'
        ) || ''
      ).trim();

      let callbackPhone = '';

      try {
        callbackPhone = normalisePhone(
          String(callbackPhoneValue || '')
        );
      } catch {
        callbackPhone = '';
      }

      const amountMatches =
        callbackAmount === Number(payment.amount);

      const phoneMatches =
        callbackPhone === payment.phone;

      const receiptValid =
        /^[A-Z0-9]{8,16}$/.test(callbackReceipt);

      const verificationPassed =
        verification.httpOk &&
        queryResultCode === 0 &&
        amountMatches &&
        phoneMatches &&
        receiptValid;

      if (!verificationPassed) {
        await paymentRef.update({
          status: 'review',

          callbackResultCode,
          queryResultCode:
            Number.isFinite(queryResultCode)
              ? queryResultCode
              : null,

          callbackAmount:
            Number.isFinite(callbackAmount)
              ? callbackAmount
              : null,

          callbackPhone:
            callbackPhone || null,

          reviewReason:
            'Daraja query and callback metadata did not satisfy payment verification.',

          reviewAt: SERVER_TIMESTAMP()
        });

        console.error(
          'Payment placed under review:',
          checkoutRequestId,
          {
            queryResultCode,
            amountMatches,
            phoneMatches,
            receiptValid
          }
        );

        return response.status(200).json({
          ResultCode: 0,
          ResultDesc: 'Payment received and placed under review'
        });
      }

      /*
       * Atomic payment + subscription update.
       * The payment status is checked again inside the transaction.
       */

      const transactionResult =
        await db.runTransaction(async transaction => {

          const freshPayment =
            await transaction.get(paymentRef);

          if (!freshPayment.exists) {
            return false;
          }

          const freshData = freshPayment.data();

          if (freshData.status === 'paid') {
            return false;
          }

          if (freshData.status !== 'pending') {
            return false;
          }

          const subscriptionRef = db
            .collection('subscriptions')
            .doc(freshData.uid);

          const subscriptionSnapshot =
            await transaction.get(subscriptionRef);

          let existingPaidThrough = 0;

          if (
            subscriptionSnapshot.exists &&
            subscriptionSnapshot.data().paidThrough
          ) {
            existingPaidThrough =
              subscriptionSnapshot
                .data()
                .paidThrough
                .toMillis();
          }

          // Extend from the later of now or current expiry.
          const baseTime = Math.max(
            Date.now(),
            existingPaidThrough
          );

          const newPaidThrough =
            admin.firestore.Timestamp.fromMillis(
              baseTime + SUBSCRIPTION_DURATION_MS
            );

          transaction.update(paymentRef, {
            status: 'paid',
            receipt: callbackReceipt,

            callbackResultCode,
            queryResultCode,

            verifiedAt: SERVER_TIMESTAMP(),
            callbackReceivedAt: SERVER_TIMESTAMP()
          });

          transaction.set(
            subscriptionRef,
            {
              uid: freshData.uid,
              active: true,

              paidThrough: newPaidThrough,

              lastPaymentId: checkoutRequestId,
              lastReceipt: callbackReceipt,

              updatedAt: SERVER_TIMESTAMP()
            },
            { merge: true }
          );

          return true;
        });

      if (transactionResult) {
        await db.collection('audit').add({
          uid: payment.uid,
          action: 'payment.verified',
          paymentId: checkoutRequestId,
          receipt: callbackReceipt,
          at: SERVER_TIMESTAMP()
        });
      }

      return response.status(200).json({
        ResultCode: 0,
        ResultDesc: 'Callback processed'
      });

    } catch (error) {
      console.error(
        'Daraja callback processing error:',
        error.message
      );

      // Do not activate access if verification fails.
      // A reconciliation process should investigate pending/review records.
      return response.status(500).json({
        ResultCode: 1,
        ResultDesc: 'Temporary verification error'
      });
    }
  }
);


/* ============================================================
   10. CLEANUP EXPIRED LOCATION SHARING SESSIONS
============================================================ */

exports.cleanupExpiredShares = onSchedule(
  'every 15 minutes',

  async () => {
    const currentTime =
      admin.firestore.Timestamp.now();

    const [expired, stopped] = await Promise.all([
      db.collection('shares')
        .where('expiresAt', '<=', currentTime)
        .limit(100)
        .get(),

      db.collection('shares')
        .where('status', '==', 'stopped')
        .limit(100)
        .get()
    ]);

    const references = new Map();

    expired.docs.forEach(document => {
      references.set(document.id, document.ref);
    });

    stopped.docs.forEach(document => {
      references.set(document.id, document.ref);
    });

    for (const [shareId, shareRef] of references) {
      const [members, locations] = await Promise.all([
        shareRef.collection('members').limit(200).get(),
        shareRef.collection('locations').limit(200).get()
      ]);

      const batch = db.batch();

      locations.docs.forEach(document => {
        batch.delete(document.ref);
      });

      members.docs.forEach(document => {
        batch.delete(document.ref);
      });

      batch.update(shareRef, {
        status: 'expired',

        inviteCodeHash:
          admin.firestore.FieldValue.delete(),

        cleanedAt: SERVER_TIMESTAMP()
      });

      await batch.commit();

      console.log(
        'Cleaned expired sharing session:',
        shareId
      );
    }
  }
);
