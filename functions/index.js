const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.database();

const NEXRIDE_PLATFORM_FEE_NGN = 350;

function flutterwaveSecretKey() {
  return (
    process.env.FLUTTERWAVE_SECRET_KEY ||
    functions.config()?.flutterwave?.secret_key ||
    ""
  ).trim();
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
  const secret = flutterwaveSecretKey();
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

/** Matches driver open-pool + matchmaking tokens (see rtdb_ride_request_contract.dart). */
const ACCEPT_FROM_OPEN_POOL_STATUSES = new Set([
  "requested",
  "requesting",
  "searching_driver",
  "searching",
  "awaiting_match",
  "matching",
  "offered",
  "offer_pending",
  // Rider lifecycle labels observed while rider_id is assigned but driver slot is empty.
  "assigned",
  "driver_assigned",
  "matched",
  "driver_found",
  "driver_matched",
  "driver_found_pending",
]);

const RESERVED_FOR_DRIVER_STATUSES = new Set([
  "pending_driver_acceptance",
  "pending_driver_action",
  "driver_reviewing_request",
]);

function normUid(uid) {
  return String(uid ?? "").trim();
}

exports.acceptRide = functions.https.onCall(async (data, context) => {
  const rideId = String(data?.rideId ?? "").trim();
  const driverId = normUid(data?.driverId);
  const authUid = normUid(context.auth?.uid);

  if (!rideId || !driverId) {
    return { success: false, reason: "invalid_input" };
  }

  if (!context.auth || authUid !== driverId) {
    return { success: false, reason: "unauthorized" };
  }

  const ridePath = `ride_requests/${rideId}`;
  const rideRef = admin.database().ref(ridePath);
  const now = Date.now();
  let failureReason = "unknown";
  let idempotent = false;

  const preSnap = await rideRef.get();
  const preVal = preSnap.val();
  const preOk = preVal != null && typeof preVal === "object";
  console.log("ACCEPT_RIDE_PREFLIGHT", {
    rideId,
    path: ridePath,
    exists: preOk,
    status: preOk ? preVal.status : null,
    driver_id: preOk ? preVal.driver_id : null,
    trip_state: preOk ? preVal.trip_state : null,
  });

  if (!preOk) {
    console.log("ACCEPT_RIDE_FAIL", { rideId, path: ridePath, stage: "preflight", reason: "ride_missing" });
    return { success: false, reason: "ride_missing" };
  }

  const tx = await rideRef.transaction((current) => {
    if (!current || typeof current !== "object") {
      failureReason = "ride_missing";
      return;
    }

    const status = String(current.status ?? "").trim().toLowerCase();
    const rawDriverId = current.driver_id;
    const rawAcceptedDriverId = current.accepted_driver_id;
    const assignedDriverId = normUid(rawDriverId);
    const acceptedDriverId = normUid(rawAcceptedDriverId);
    const expiresAtRaw = current.request_expires_at ?? current.expires_at ?? 0;
    const expiresAt = Number(expiresAtRaw) || 0;

    const assignmentExpiresRaw =
      current.assignment_expires_at ?? current.driver_response_timeout_at ?? 0;
    const assignmentExpiresAt = Number(assignmentExpiresRaw) || 0;

    const isPlaceholderUnassigned = (value) =>
      value === null ||
      value === undefined ||
      String(value).trim() === "" ||
      String(value).trim().toLowerCase() === "waiting" ||
      String(value).trim().toLowerCase() === "pending";
    const isUnassigned =
      isPlaceholderUnassigned(rawDriverId) &&
      isPlaceholderUnassigned(rawAcceptedDriverId);
    console.log("ACCEPT_RIDE_DRIVER_FIELD", {
      rideId,
      path: ridePath,
      rawDriverId,
      rawAcceptedDriverId,
      isUnassigned,
      status,
      authUid,
    });

    const alreadyAcceptedBySelf =
      (assignedDriverId === authUid || acceptedDriverId === authUid) &&
      status === "accepted";
    if (alreadyAcceptedBySelf) {
      idempotent = true;
      return current;
    }

    const reservedForThisDriver =
      assignedDriverId.length > 0 &&
      assignedDriverId === authUid &&
      RESERVED_FOR_DRIVER_STATUSES.has(status);
    if (reservedForThisDriver) {
      if (assignmentExpiresAt > 0 && now >= assignmentExpiresAt) {
        failureReason = "assignment_expired";
        return;
      }
      if (expiresAt > 0 && now >= expiresAt) {
        failureReason = "expired";
        return;
      }
      console.log("ACCEPT_RIDE_COMMIT", {
        rideId,
        path: ridePath,
        mode: "reserved_popup_confirm",
        statusBefore: status,
      });
      return {
        ...current,
        driver_id: driverId,
        accepted_driver_id: driverId,
        matched_driver_id: driverId,
        status: "accepted",
        trip_state: "driver_accepted",
        accepted_at: now,
        updated_at: now,
      };
    }

    if (!isUnassigned) {
      failureReason = "driver_already_set";
      return;
    }

    if (!ACCEPT_FROM_OPEN_POOL_STATUSES.has(status)) {
      failureReason = "status_not_requesting";
      return;
    }

    if (expiresAt > 0 && now >= expiresAt) {
      failureReason = "expired";
      return;
    }

    console.log("ACCEPT_RIDE_COMMIT", {
      rideId,
      path: ridePath,
      mode: "open_pool",
      statusBefore: status,
    });
    return {
      ...current,
      driver_id: driverId,
      accepted_driver_id: driverId,
      matched_driver_id: driverId,
      status: "accepted",
      trip_state: "driver_accepted",
      accepted_at: now,
      updated_at: now,
    };
  });

  console.log("ACCEPT_RIDE_TX_RESULT", {
    rideId,
    path: ridePath,
    committed: tx.committed,
    idempotent,
    failureReason: idempotent ? "none" : failureReason,
  });

  if (!tx.committed && !idempotent) {
    return {
      success: false,
      reason: failureReason === "unknown" ? "not_available" : failureReason,
    };
  }

  return {
    success: true,
    idempotent,
    reason: idempotent ? "already_accepted" : "accepted",
  };
});

exports.verifyPayment = functions.https.onCall(async (data, context) => {
  const reference = String(data?.reference ?? "").trim();
  if (!context.auth) {
    return { success: false, reason: "unauthorized" };
  }
  if (!reference) {
    return { success: false, reason: "invalid_reference" };
  }
  return verifyPaymentInternal(reference);
});

exports.createWalletTransaction = functions.https.onCall(async (data, context) => {
  if (!context.auth || !isAdminContext(context)) {
    return { success: false, reason: "unauthorized" };
  }
  return createWalletTransactionInternal({
    userId: data?.userId,
    amount: data?.amount,
    type: data?.type,
    idempotencyKey: data?.idempotencyKey,
  });
});

exports.recordTripCompletion = functions.https.onCall(async (data, context) => {
  if (!context.auth || !isAdminContext(context)) {
    return { success: false, reason: "unauthorized" };
  }

  const rideId = String(data?.rideId ?? "").trim();
  if (!rideId) {
    return { success: false, reason: "invalid_ride_id" };
  }

  const rideRef = db.ref(`ride_requests/${rideId}`);
  const rideSnap = await rideRef.get();
  const ride = rideSnap.val();
  if (!ride || typeof ride !== "object") {
    return { success: false, reason: "ride_missing" };
  }

  const status = String(ride.status || "").toLowerCase();
  const tripState = String(ride.trip_state || "").toLowerCase();
  if (
    status !== "completed" &&
    status !== "trip_completed" &&
    tripState !== "trip_completed"
  ) {
    return { success: false, reason: "trip_not_completed" };
  }

  const paymentReference = String(
    ride.customer_transaction_reference || ride.payment_reference || ""
  ).trim();
  if (!paymentReference) {
    return { success: false, reason: "missing_payment_reference" };
  }

  const verification = await verifyPaymentInternal(paymentReference);
  if (!verification.success) {
    return { success: false, reason: verification.reason || "verification_failed" };
  }

  const riderId = String(ride.rider_id || "").trim();
  const driverId = String(ride.driver_id || "").trim();
  if (!riderId || !driverId) {
    return { success: false, reason: "missing_trip_participants" };
  }

  const totalDeliveryFee = Number(
    ride.total_delivery_fee_paid || ride.total_delivery_fee || verification.amount || 0
  );
  if (!Number.isFinite(totalDeliveryFee) || totalDeliveryFee <= NEXRIDE_PLATFORM_FEE_NGN) {
    return { success: false, reason: "invalid_trip_amount" };
  }
  const driverEarning = totalDeliveryFee - NEXRIDE_PLATFORM_FEE_NGN;
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

  const platformFee = await createWalletTransactionInternal({
    userId: "nexride_platform",
    amount: NEXRIDE_PLATFORM_FEE_NGN,
    type: "platform_fee_credit",
    idempotencyKey: `${completionIdem}_platform_fee`,
  });
  if (!platformFee.success) {
    return { success: false, reason: platformFee.reason || "platform_fee_failed" };
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
    platform_fee_ngn: NEXRIDE_PLATFORM_FEE_NGN,
    rider_earning_credited: driverEarning,
    updated_at: Date.now(),
  });

  await db.ref(`driver_earnings/${driverId}/${rideId}`).update({
    rideId,
    amount: driverEarning,
    platformFee: NEXRIDE_PLATFORM_FEE_NGN,
    grossAmount: totalDeliveryFee,
    status: "credited",
    created_at: Date.now(),
    updated_at: Date.now(),
  });

  return {
    success: true,
    reason: "trip_completion_recorded",
    driverEarning,
    platformFee: NEXRIDE_PLATFORM_FEE_NGN,
  };
});
