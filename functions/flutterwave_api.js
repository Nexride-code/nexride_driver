/**
 * Server-side Flutterwave API helpers (never trust client payment success).
 */

const { flutterwaveSecretForVerify } = require("./params");

function flutterwaveVerifyUrl(refOrNumericId) {
  const s = String(refOrNumericId || "").trim();
  if (/^\d+$/.test(s)) {
    return `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(s)}/verify`;
  }
  return `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(s)}`;
}

/**
 * @param {string} reference tx_ref or Flutterwave numeric transaction id
 * @returns {Promise<{ ok: boolean, reason?: string, amount?: number, providerStatus?: string, payload?: object, flwTransactionId?: string }>}
 */
async function verifyTransactionByReference(reference) {
  const ref = String(reference || "").trim();
  if (!ref) {
    return { ok: false, reason: "invalid_reference" };
  }
  const secret = flutterwaveSecretForVerify();
  if (!secret) {
    return { ok: false, reason: "flutterwave_secret_missing" };
  }
  let response;
  try {
    response = await fetch(flutterwaveVerifyUrl(ref), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return { ok: false, reason: "network_error", payload: { error: String(error) } };
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
  const ok = response.ok && providerStatus === "success" && dataStatus === "successful";
  const flwTransactionId = String(payload?.data?.id ?? "").trim() || null;
  return {
    ok,
    reason: ok ? undefined : "verification_failed",
    amount,
    providerStatus: dataStatus || providerStatus,
    payload,
    flwTransactionId,
  };
}

/**
 * @param {object} body Flutterwave /v3/payments payload
 */
async function createHostedPaymentLink(body) {
  const secret = flutterwaveSecretForVerify();
  if (!secret) {
    return { ok: false, reason: "flutterwave_secret_missing" };
  }
  let response;
  try {
    response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, reason: "network_error", error: String(error) };
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = {};
  }
  const link = String(payload?.data?.link || "").trim();
  const ok = response.ok && !!link;
  return { ok, reason: ok ? undefined : "initiate_failed", link, payload };
}

module.exports = {
  verifyTransactionByReference,
  createHostedPaymentLink,
};
