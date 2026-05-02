/**
 * Rider-facing payment initiation + verification (Flutterwave).
 */

const { verifyTransactionByReference, createHostedPaymentLink } = require("./flutterwave_api");
const { fanOutDriverOffersIfEligible } = require("./ride_callables");

function normUid(uid) {
  return String(uid ?? "").trim();
}

function nowMs() {
  return Date.now();
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
    created_at: now,
    updated_at: now,
  });
  await db.ref(`ride_requests/${rideId}`).update({
    payment_reference: tx_ref,
    customer_transaction_reference: tx_ref,
    payment_status: "pending",
    updated_at: now,
  });
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
  const reference = String(data?.reference ?? data?.tx_ref ?? "").trim();
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
  await db.ref(`payment_transactions/${reference}`).update({
    verified: v.ok,
    provider_status: v.providerStatus || "unknown",
    amount: v.amount ?? 0,
    verified_at: now,
    updated_at: now,
    ride_id: rideId,
    rider_id: normUid(ride.rider_id),
  });
  if (!v.ok) {
    await db.ref(`ride_requests/${rideId}`).update({
      payment_status: "failed",
      updated_at: now,
    });
    return { success: false, reason: v.reason || "verification_failed" };
  }
  await db.ref(`ride_requests/${rideId}`).update({
    payment_status: "verified",
    payment_verified_at: now,
    updated_at: now,
  });
  const fresh = (await db.ref(`ride_requests/${rideId}`).get()).val();
  await fanOutDriverOffersIfEligible(db, rideId, fresh || ride);
  return { success: true, reason: "verified", amount: v.amount };
}

/**
 * Flutterwave charge webhook — verify `verif-hash` header.
 * @param {import("firebase-functions").https.Request} req
 * @param {import("firebase-functions").https.Response} res
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
  if (!txRef) {
    res.status(200).send("ignored");
    return;
  }
  const v = await verifyTransactionByReference(txRef);
  const now = nowMs();
  await db.ref(`payment_transactions/${txRef}`).update({
    verified: v.ok,
    provider_status: v.providerStatus || "unknown",
    amount: v.amount ?? 0,
    verified_at: now,
    updated_at: now,
    webhook_event: event,
    webhook_payload: body,
  });
  const metaRide = String(data?.meta?.ride_id ?? data?.meta?.rideId ?? "").trim();
  const rideId = metaRide || String((await db.ref(`payment_transactions/${txRef}/ride_id`).get()).val() ?? "").trim();
  if (rideId && v.ok) {
    await db.ref(`ride_requests/${rideId}`).update({
      payment_status: "verified",
      payment_verified_at: now,
      updated_at: now,
    });
    const fresh = (await db.ref(`ride_requests/${rideId}`).get()).val();
    await fanOutDriverOffersIfEligible(db, rideId, fresh || {});
  }
  res.status(200).send("ok");
}

module.exports = {
  initiateFlutterwavePayment,
  verifyFlutterwavePayment,
  handleFlutterwaveWebhook,
};
