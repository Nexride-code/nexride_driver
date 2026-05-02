/**
 * Rider-facing payment initiation + verification (Flutterwave).
 * Canonical charge rows: payments/{flutterwaveTransactionId|tx_ref}
 * Legacy mirror: payment_transactions/{tx_ref}
 */

const { verifyTransactionByReference, createHostedPaymentLink } = require("./flutterwave_api");
const { fanOutDriverOffersIfEligible } = require("./ride_callables");
const { syncRideTrackPublic } = require("./track_public");

function normUid(uid) {
  return String(uid ?? "").trim();
}

function nowMs() {
  return Date.now();
}

/**
 * Upsert `payments/{payKey}` and mirror legacy `payment_transactions/{txRef}`.
 * @param {string} payKey Flutterwave transaction id preferred, else tx_ref
 */
async function mirrorPaymentRecords(db, {
  payKey,
  txRef,
  rideId,
  riderId,
  verified,
  amount,
  providerStatus,
  payload,
  webhookEvent,
  webhookApplied,
}) {
  const key = String(payKey || "").trim();
  const ref = String(txRef || "").trim() || key;
  if (!key) {
    return;
  }
  const now = nowMs();
  const row = {
    transaction_id: key,
    tx_ref: ref || null,
    ride_id: rideId || null,
    rider_id: riderId || null,
    verified: !!verified,
    amount: Number(amount || 0) || 0,
    provider_status: providerStatus || "unknown",
    updated_at: now,
  };
  if (webhookEvent) {
    row.webhook_event = webhookEvent;
  }
  if (typeof webhookApplied === "boolean") {
    row.webhook_applied = webhookApplied;
  }
  if (payload && typeof payload === "object") {
    row.provider_payload = payload;
  }
  const updates = {
    [`payments/${key}`]: row,
  };
  if (ref) {
    updates[`payment_transactions/${ref}`] = {
      ...row,
      tx_ref: ref,
    };
  }
  await db.ref().update(updates);
}

async function initiateFlutterwavePayment(data, context, db) {
  if (!context.auth) {
    return { success: false, reason: "unauthorized" };
  }
  const riderId = normUid(context.auth.uid);
  const rideId = normUid(data?.rideId ?? data?.ride_id);
  const amount = Number(data?.amount ?? 0);
  const currency = String(data?.currency ?? "NGN").trim().toUpperCase() || "NGN";
  const email = String(
    data?.email ?? context.auth.token?.email ?? `${riderId}@nexride.local`,
  ).trim();
  if (!rideId || !Number.isFinite(amount) || amount <= 0) {
    return { success: false, reason: "invalid_input" };
  }
  const rideSnap = await db.ref(`ride_requests/${rideId}`).get();
  const ride = rideSnap.val();
  if (!ride || typeof ride !== "object" || normUid(ride.rider_id) !== riderId) {
    return { success: false, reason: "forbidden" };
  }
  const txRefKey = db.ref("payment_transactions").push().key;
  const tx_ref = `nexride_${rideId}_${txRefKey}`;
  const redirectUrl = String(
    data?.redirect_url ?? data?.redirectUrl ?? "https://nexride.app/pay/return",
  ).trim();
  const body = {
    tx_ref,
    amount,
    currency,
    redirect_url: redirectUrl,
    payment_options: "card",
    customer: {
      email: email || `${riderId}@nexride.local`,
      name: String(data?.customer_name ?? "NexRide rider").trim(),
    },
    meta: { ride_id: rideId, rider_id: riderId },
    customizations: { title: "NexRide trip" },
  };
  const r = await createHostedPaymentLink(body);
  if (!r.ok) {
    return {
      success: false,
      reason: r.reason || "payment_init_failed",
      provider: r.payload,
    };
  }
  const now = nowMs();
  await db.ref(`payment_transactions/${tx_ref}`).set({
    tx_ref,
    ride_id: rideId,
    rider_id: riderId,
    amount,
    currency,
    status: "pending",
    provider_link: r.link,
    verified: false,
    created_at: now,
    updated_at: now,
  });
  await db.ref(`ride_requests/${rideId}`).update({
    payment_reference: tx_ref,
    customer_transaction_reference: tx_ref,
    payment_status: "pending",
    updated_at: now,
  });
  await syncRideTrackPublic(db, rideId);
  return {
    success: true,
    tx_ref,
    authorization_url: r.link,
    reason: "initiated",
  };
}

async function verifyFlutterwavePayment(data, context, db) {
  if (!context.auth) {
    return { success: false, reason: "unauthorized" };
  }
  const rideId = normUid(data?.rideId ?? data?.ride_id);
  const reference = String(data?.reference ?? data?.tx_ref ?? data?.transactionId ?? data?.transaction_id ?? "").trim();
  if (!rideId || !reference) {
    return { success: false, reason: "invalid_input" };
  }
  const rideSnap = await db.ref(`ride_requests/${rideId}`).get();
  const ride = rideSnap.val();
  if (!ride || typeof ride !== "object" || normUid(ride.rider_id) !== normUid(context.auth.uid)) {
    return { success: false, reason: "forbidden" };
  }
  const v = await verifyTransactionByReference(reference);
  const now = nowMs();
  const payKey = String(v.flwTransactionId || reference || "").trim();
  await mirrorPaymentRecords(db, {
    payKey,
    txRef: reference,
    rideId,
    riderId: normUid(ride.rider_id),
    verified: v.ok,
    amount: v.amount ?? 0,
    providerStatus: v.providerStatus || "unknown",
    payload: v.payload,
    webhookEvent: "callable_verify",
    webhookApplied: false,
  });
  if (!v.ok) {
    await db.ref(`ride_requests/${rideId}`).update({
      payment_status: "failed",
      updated_at: now,
    });
    await syncRideTrackPublic(db, rideId);
    return { success: false, reason: v.reason || "verification_failed" };
  }
  await db.ref(`ride_requests/${rideId}`).update({
    payment_status: "verified",
    payment_verified_at: now,
    updated_at: now,
  });
  const fresh = (await db.ref(`ride_requests/${rideId}`).get()).val();
  await fanOutDriverOffersIfEligible(db, rideId, fresh || ride);
  await syncRideTrackPublic(db, rideId);
  return { success: true, reason: "verified", amount: v.amount, transaction_id: payKey };
}

/**
 * Flutterwave charge webhook — verify `verif-hash` header.
 * Idempotent: repeated delivery must not re-apply ride updates / fan-out side effects.
 */
async function handleFlutterwaveWebhook(req, res, db) {
  const expected = String(process.env.FLUTTERWAVE_WEBHOOK_SECRET || "").trim();
  const got = String(req.headers["verif-hash"] || req.headers["verif_hash"] || "").trim();
  if (!expected || got !== expected) {
    res.status(401).send("invalid signature");
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  }

  const event = String(body?.event ?? "").trim().toLowerCase();
  const data = body?.data && typeof body.data === "object" ? body.data : {};
  const txRef = String(data?.tx_ref ?? data?.txRef ?? "").trim();
  const flwTxId = String(data?.id ?? "").trim();
  const payKey = flwTxId || txRef;

  if (!payKey) {
    res.status(200).send("ignored-no-id");
    return;
  }

  const paySnap = await db.ref(`payments/${payKey}`).get();
  const prev = paySnap.val() || {};
  if (prev.webhook_applied === true && prev.verified === true) {
    res.status(200).send("ok-idempotent");
    return;
  }

  const verifyKey = flwTxId || txRef;
  if (!verifyKey) {
    res.status(200).send("ignored");
    return;
  }

  const v = await verifyTransactionByReference(verifyKey);
  const now = nowMs();

  const meta = data?.meta && typeof data.meta === "object" ? data.meta : {};
  const metaRide = String(meta?.ride_id ?? meta?.rideId ?? "").trim();
  const rideId =
    metaRide ||
    String(prev.ride_id || (await db.ref(`payment_transactions/${txRef}/ride_id`).get()).val() || "").trim();

  const riderId =
    String(meta?.rider_id ?? meta?.riderId ?? prev.rider_id ?? "").trim() ||
    String((await db.ref(`payment_transactions/${txRef}/rider_id`).get()).val() ?? "").trim();

  await mirrorPaymentRecords(db, {
    payKey,
    txRef: txRef || verifyKey,
    rideId: rideId || null,
    riderId: riderId || null,
    verified: v.ok,
    amount: v.amount ?? 0,
    providerStatus: v.providerStatus || "unknown",
    payload: body,
    webhookEvent: event || "webhook",
    webhookApplied: !!(v.ok && (event === "charge.completed" || !event)),
  });

  if (v.ok && rideId) {
    await db.ref(`ride_requests/${rideId}`).update({
      payment_status: "verified",
      payment_verified_at: now,
      updated_at: now,
    });
    await db.ref(`payments/${payKey}`).update({
      webhook_applied: true,
      updated_at: now,
    });
    if (tx_ref && flwTxId && tx_ref !== flwTxId) {
      await db.ref(`payment_transactions/${tx_ref}`).update({
        flutterwave_transaction_id: flwTxId,
        updated_at: now,
      });
    }
    const fresh = (await db.ref(`ride_requests/${rideId}`).get()).val();
    await fanOutDriverOffersIfEligible(db, rideId, fresh || {});
    await syncRideTrackPublic(db, rideId);
  }

  res.status(200).send("ok");
}

module.exports = {
  initiateFlutterwavePayment,
  verifyFlutterwavePayment,
  handleFlutterwaveWebhook,
  mirrorPaymentRecords,
};
