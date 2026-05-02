# NexRide production deployment

## Prerequisites

- Firebase CLI (`npm i -g firebase-tools`), logged in: `firebase login`
- Node 20 for Cloud Functions (`functions/package.json` engines)
- Flutterwave dashboard access for **Secret Hash** and **Webhook URL**

## Secrets (required before first deploy of payment + webhook)

```bash
cd functions
firebase functions:secrets:set FLUTTERWAVE_SECRET_KEY
firebase functions:secrets:set FLUTTERWAVE_WEBHOOK_SECRET
```

Use the **same value** for Flutterwave dashboard **Secret Hash** as for `FLUTTERWAVE_WEBHOOK_SECRET`.

Local emulators: copy `functions/.env.example` → `functions/.env` and fill values.

## Deploy Realtime Database rules

```bash
firebase deploy --only database
```

## Deploy Cloud Functions (all)

```bash
firebase deploy --only functions
```

Deploy only HTTP webhook + dependencies:

```bash
firebase deploy --only functions:flutterwaveWebhook
```

## Flutterwave webhook URL (after deploy)

Format (Gen2 HTTPS, region `us-central1`):

`https://us-central1-<YOUR_PROJECT_ID>.cloudfunctions.net/flutterwaveWebhook`

Set in Flutterwave dashboard:

- **URL:** the URL above (verify in [Google Cloud Console](https://console.cloud.google.com) → Cloud Functions → `flutterwaveWebhook` → Trigger URL if needed).
- **Secret hash:** value of `FLUTTERWAVE_WEBHOOK_SECRET` (must match header `verif-hash` verification in code).

## List deployed functions

```bash
firebase functions:list
```

You should see:

- **Callable:** `createRideRequest`, `acceptRide`, `cancelRide`, `startTrip`, `completeTrip`, `verifyPayment`, `verifyFlutterwavePayment`, `initiateFlutterwavePayment`, `createWalletTransaction`, `requestWithdrawal`, `approveWithdrawal`, …
- **HTTPS:** `flutterwaveWebhook` (HTTP endpoint, not callable).

If `flutterwaveWebhook` is missing, the deploy likely failed (check logs); ensure **both** secrets exist and redeploy.

## Hosting (public site + admin/support/track SPA)

Build the Vite app once:

```bash
cd web
npm install
npm run build
cd ..
firebase deploy --only hosting
```

## GitHub (typical flow)

```bash
git status
git add -A
git commit -m "chore: production payments webhook, withdrawals, web scaffold"
git push origin HEAD
```

## Admin custom claims

`approveWithdrawal`, `createWalletTransaction`, and admin **cancel ride** expect `auth.token.admin === true`. Set via Admin SDK / your user-provisioning flow (not included in this repo).

## Test checklist (live)

1. Rider: `createRideRequest` → receive `rideId`; RTDB `ride_requests/{rideId}` readable only as rider (rules).
2. Driver: offers under `driver_offer_queue/{driverId}`; single popup discipline handled in driver app.
3. Driver: `acceptRide` → `trip_state` / `status` `accepted`; `active_trips` + `*_active_ride` created.
4. Rider: listener shows matched state (app responsibility).
5. Rider: pay card flow → `initiateFlutterwavePayment` → after checkout, `verifyPayment` or webhook → `payment_status` `verified` + `payments/{flutterwaveId}` row.
6. Driver: `completeTrip` allowed only if payment OK (cash/bank_transfer or `payment_status` verified).
7. Driver: `requestWithdrawal` → admin `approveWithdrawal` with `status: paid` debits wallet once (idempotent key).
8. Admin/support: use Flutter admin app or TODO web dashboards with proper Auth + claims.

## Wallet double-credit

Webhook marks `payments/{id}.webhook_applied` after a successful charge handling path; `recordTripCompletion` / wallet ledger use **idempotent** `idempotencyKey` fields. Do not add client-triggered wallet credits.
