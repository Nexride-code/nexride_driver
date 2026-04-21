/// Canonical Realtime Database field names for `ride_requests/{rideId}`.
/// Rider and driver apps should use **snake_case** here for new writes.
/// Rules also accept legacy `riderId` / `matchedDriverId` for reads and creates.
abstract final class RtdbRideRequestFields {
  static const riderId = 'rider_id';
  static const driverId = 'driver_id';
  static const matchedDriverId = 'matched_driver_id';
  static const market = 'market';
  static const status = 'status';
  static const tripState = 'trip_state';
}
