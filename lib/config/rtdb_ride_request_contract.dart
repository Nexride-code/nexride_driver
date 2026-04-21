/// Canonical Realtime Database field names for `ride_requests/{rideId}`.
/// Rider and driver apps should use **snake_case** here for new writes.
/// Rules also accept legacy `riderId` / `matchedDriverId` for reads and creates.
///
/// **Discovery contract (driver `orderByChild('market').equalTo(city)`):**
/// - Path: `ride_requests/{rideId}` (indexed field `market` on parent).
/// - Required for visibility: non-empty string `market` matching driver launch city
///   (e.g. `lagos`, `abuja`) — same slug as `DriverLaunchScope` / rider service area.
/// - Open pool: `driver_id` must be absent, null, empty string, or `'waiting'`.
/// - `status` / `trip_state` must be in the open-search allowlist used in
///   `database.rules.json` (includes `searching`, `requested`, `matching`, `offered`,
///   `pending_driver_acceptance`, etc.). Prefer `status: 'searching'` and
///   `trip_state: 'searching_driver'` for new code.
/// - Do **not** rely on camelCase `driverId` / `tripState` for security rules; use
///   snake_case fields above so drivers can read the node in market queries.
abstract final class RtdbRideRequestFields {
  static const riderId = 'rider_id';
  static const driverId = 'driver_id';
  static const matchedDriverId = 'matched_driver_id';
  static const market = 'market';
  static const status = 'status';
  static const tripState = 'trip_state';
}
