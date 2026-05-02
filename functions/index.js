require("./params");
const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  flutterwaveSecretKey,
  REGION,
  flutterwaveSecretForVerify,
  platformFeeNgn,
} = require("./params");

admin.initializeApp();
const db = admin.database();

function callableContext(request) {
  return { auth: request.auth };
}

function isAdminContext(context) {
  return context?.auth?.token?.admin === true;
}

async function verifyPaymentInternal(reference) {
  const txRef = db.ref(`payment_transactions/${reference}`);
  const existingSnap = await txRef.get();
  const existing = existingSnap.val() || {};
  if (existing.verified === true) {
    return {
      success: true,
      reason: "already_verified",
      amount: Number(existing.amount || 0),
      providerStatus: String(existing.provider_status || "successful"),
    };
  }

  const now = Date.now();
  const secret = flutterwaveSecretForVerify();
  if (!secret) {
    await txRef.update({
      verified: false,
      provider_status: "config_missing",
      verification_error: "flutterwave_secret_missing",
      verified_at: now,
      updated_at: now,
    });
    return { success: false, reason: "flutterwave_secret_missing" };
  }

  let response;
  try {
    response = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    await txRef.update({
      verified: false,
      provider_status: "network_error",
      verification_error: String(error),
      verified_at: now,
      updated_at: now,
    });
    return { success: false, reason: "network_error" };
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = {};
  }
  const providerStatus = String(payload?.status || "").toLowerCase();
  const dataStatus = String(payload?.data?.status || "").toLowerCase();
  const amount = Number(payload?.data?.amount || 0);
  const verified = response.ok && providerStatus === "success" && dataStatus === "successful";

  await txRef.update({
    verified,
    provider_status: dataStatus || providerStatus || "unknown",
    amount,
    provider_payload: payload,
    verified_at: now,
    updated_at: now,
  });

  if (!verified) {
    return { success: false, reason: "verification_failed" };
  }
  return {
    success: true,
    reason: "verified",
    amount,
    providerStatus: dataStatus,
  };
}

async function createWalletTransactionInternal({
  userId,
  amount,
  type,
  idempotencyKey,
}) {
  const normalizedUserId = String(userId || "").trim();
  const numericAmount = Number(amount || 0);
  const normalizedType = String(type || "").trim();
  const idem = String(idempotencyKey || "").trim();
  if (!normalizedUserId || !normalizedType || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    return { success: false, reason: "invalid_input" };
  }

  const walletRef = db.ref(`wallets/${normalizedUserId}`);
  const transactionId = idem || db.ref("wallet_transactions").push().key;
  let failureReason = "unknown";

  const tx = await walletRef.transaction((current) => {
    const wallet = current && typeof current === "object" ? current : {};
    const balance = Number(wallet.balance || 0);
    const transactions =
      wallet.transactions && typeof wallet.transactions === "object"
        ? wallet.transactions
        : {};
    if (transactionId && transactions[transactionId]) {
      return wallet;
    }

    const isDebit = normalizedType === "rider_payment_debit" || normalizedType === "platform_fee_debit";
    const nextBalance = isDebit ? balance - numericAmount : balance + numericAmount;
    if (isDebit && nextBalance < 0) {
      failureReason = "insufficient_balance";
      return;
    }

    return {
      ...wallet,
      user_id: normalizedUserId,
      balance: nextBalance,
      updated_at: Date.now(),
      transactions: {
        ...transactions,
        [transactionId]: {
          transactionId,
          type: normalizedType,
          amount: numericAmount,
          direction: isDebit ? "debit" : "credit",
          created_at: Date.now(),
        },
      },
    };
  });

  if (!tx.committed) {
    return { success: false, reason: failureReason === "unknown" ? "wallet_update_failed" : failureReason };
  }
  return { success: true, reason: "wallet_updated", transactionId };
}

const ride = require("./ride_callables");

const rideCallOpts = { region: REGION };

exports.createRideRequest = onCall(rideCallOpts, async (request) =>
  ride.createRideRequest(request.data, callableContext(request), db),
);

exports.acceptRideRequest = onCall(rideCallOpts, async (request) =>
  ride.acceptRideRequest(request.data, callableContext(request), db),
);

/** @deprecated Use acceptRideRequest — kept for older client builds */
exports.acceptRide = exports.acceptRideRequest;

exports.driverEnroute = onCall(rideCallOpts, async (request) =>
  ride.driverEnroute(request.data, callableContext(request), db),
);

exports.driverArrived = onCall(rideCallOpts, async (request) =>
  ride.driverArrived(request.data, callableContext(request), db),
);

exports.startTrip = onCall(rideCallOpts, async (request) =>
  ride.startTrip(request.data, callableContext(request), db),
);

exports.completeTrip = onCall(rideCallOpts, async (request) =>
  ride.completeTrip(request.data, callableContext(request), db),
);

exports.cancelRideRequest = onCall(rideCallOpts, async (request) =>
  ride.cancelRideRequest(request.data, callableContext(request), db),
);

exports.expireRideRequest = onCall(rideCallOpts, async (request) =>
  ride.expireRideRequest(request.data, callableContext(request), db),
);

exports.patchRideRequestMetadata = onCall(rideCallOpts, async (request) =>
  ride.patchRideRequestMetadata(request.data, callableContext(request), db),
);

exports.verifyPayment = onCall(
  { region: REGION, secrets: [flutterwaveSecretKey] },
  async (request) => {
    const reference = String(request.data?.reference ?? "").trim();
    if (!request.auth) {
      return { success: false, reason: "unauthorized" };
    }
    if (!reference) {
      return { success: false, reason: "invalid_reference" };
    }
    return verifyPaymentInternal(reference);
  },
);

exports.createWalletTransaction = onCall(rideCallOpts, async (request) => {
  const ctx = callableContext(request);
  if (!ctx.auth || !isAdminContext(ctx)) {
    return { success: false, reason: "unauthorized" };
  }
  return createWalletTransactionInternal({
    userId: request.data?.userId,
    amount: request.data?.amount,
    type: request.data?.type,
    idempotencyKey: request.data?.idempotencyKey,
  });
});

exports.recordTripCompletion = onCall(
  { region: REGION, secrets: [flutterwaveSecretKey] },
  async (request) => {
    const ctx = callableContext(request);
    if (!ctx.auth || !isAdminContext(ctx)) {
      return { success: false, reason: "unauthorized" };
    }

    const rideId = String(request.data?.rideId ?? "").trim();
    if (!rideId) {
      return { success: false, reason: "invalid_ride_id" };
    }

    const feeNgn = platformFeeNgn();

    const rideRef = db.ref(`ride_requests/${rideId}`);
    const rideSnap = await rideRef.get();
    const rideVal = rideSnap.val();
    if (!rideVal || typeof rideVal !== "object") {
      return { success: false, reason: "ride_missing" };
    }

    const status = String(rideVal.status || "").toLowerCase();
    const tripState = String(rideVal.trip_state || "").toLowerCase();
    if (
      status !== "completed" &&
      status !== "trip_completed" &&
      tripState !== "trip_completed" &&
      tripState !== "completed"
    ) {
      return { success: false, reason: "trip_not_completed" };
    }

    const paymentReference = String(
      rideVal.customer_transaction_reference || rideVal.payment_reference || ""
    ).trim();
    if (!paymentReference) {
      return { success: false, reason: "missing_payment_reference" };
    }

    const verification = await verifyPaymentInternal(paymentReference);
    if (!verification.success) {
      return { success: false, reason: verification.reason || "verification_failed" };
    }

    const riderId = String(rideVal.rider_id || "").trim();
    const driverId = String(rideVal.driver_id || "").trim();
    if (!riderId || !driverId) {
      return { success: false, reason: "missing_trip_participants" };
    }

    const totalDeliveryFee = Number(
      rideVal.total_delivery_fee_paid || rideVal.total_delivery_fee || verification.amount || 0
    );
    if (!Number.isFinite(totalDeliveryFee) || totalDeliveryFee <= feeNgn) {
      return { success: false, reason: "invalid_trip_amount" };
    }
    const driverEarning = totalDeliveryFee - feeNgn;
    const completionIdem = `trip_completion_${rideId}`;

    const riderDebit = await createWalletTransactionInternal({
      userId: riderId,
      amount: totalDeliveryFee,
      type: "rider_payment_debit",
      idempotencyKey: `${completionIdem}_rider_debit`,
    });
    if (!riderDebit.success) {
      return { success: false, reason: riderDebit.reason || "rider_debit_failed" };
    }

    const platformFeeTx = await createWalletTransactionInternal({
      userId: "nexride_platform",
      amount: feeNgn,
      type: "platform_fee_credit",
      idempotencyKey: `${completionIdem}_platform_fee`,
    });
    if (!platformFeeTx.success) {
      return { success: false, reason: platformFeeTx.reason || "platform_fee_failed" };
    }

    const driverCredit = await createWalletTransactionInternal({
      userId: driverId,
      amount: driverEarning,
      type: "driver_earning_credit",
      idempotencyKey: `${completionIdem}_driver_credit`,
    });
    if (!driverCredit.success) {
      return { success: false, reason: driverCredit.reason || "driver_credit_failed" };
    }

    await rideRef.update({
      payment_verified: true,
      payment_verified_at: Date.now(),
      payment_status: "verified",
      wallet_credit_status: "credited",
      platform_fee_ngn: feeNgn,
      rider_earning_credited: driverEarning,
      updated_at: Date.now(),
    });

    await db.ref(`driver_earnings/${driverId}/${rideId}`).update({
      rideId,
      amount: driverEarning,
      platformFee: feeNgn,
      grossAmount: totalDeliveryFee,
      status: "credited",
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    return {
      success: true,
      reason: "trip_completion_recorded",
      driverEarning,
      platformFee: feeNgn,
    };
  },
);
