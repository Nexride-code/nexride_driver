import { useParams } from "react-router-dom";

/**
 * TODO (production): Public tracking must not read `ride_requests` directly (rules block anonymous users).
 * Options:
 * - Callable `getPublicRideTrack` (signed share token in body), or
 * - RTDB mirror `ride_public_summary/{rideId}` written only by Cloud Functions with public `.read`.
 */
export function TrackRidePage() {
  const { rideId } = useParams();
  return (
    <section>
      <h1>Ride tracking</h1>
      <p>
        <strong>Ride ID:</strong> {rideId ?? "(none)"}
      </p>
      <p style={{ color: "#555" }}>
        TODO: Load public-safe fields (status, trip_state, ETA, pickup/dropoff labels) via secured backend or
        `ride_public_summary` mirror. Do not expose rider/driver phone or email here.
      </p>
    </section>
  );
}
