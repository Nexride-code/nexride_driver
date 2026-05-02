import { Link, Route, Routes } from "react-router-dom";

function Placeholder({ title }: { title: string }) {
  return (
    <div>
      <h2>{title}</h2>
      <p style={{ color: "#555" }}>
        TODO: Firebase Auth (custom claims admin), RTDB read via Admin SDK or privileged callable proxy, tables for
        rides/drivers/payments/withdrawals.
      </p>
    </div>
  );
}

export function AdminShell() {
  return (
    <div>
      <h1>Admin</h1>
      <nav style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <Link to="/admin">Overview</Link>
        <Link to="/admin/rides">Live rides</Link>
        <Link to="/admin/riders">Riders</Link>
        <Link to="/admin/drivers">Drivers</Link>
        <Link to="/admin/payments">Payments</Link>
        <Link to="/admin/withdrawals">Withdrawals</Link>
        <Link to="/admin/tickets">Support tickets</Link>
        <Link to="/admin/lookup">Ride lookup</Link>
        <Link to="/admin/verification">Driver verification</Link>
        <Link to="/admin/settings">Settings</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Placeholder title="Overview" />} />
        <Route path="/rides" element={<Placeholder title="Live rides" />} />
        <Route path="/riders" element={<Placeholder title="Riders" />} />
        <Route path="/drivers" element={<Placeholder title="Drivers" />} />
        <Route path="/payments" element={<Placeholder title="Payments" />} />
        <Route path="/withdrawals" element={<Placeholder title="Withdrawals" />} />
        <Route path="/tickets" element={<Placeholder title="Support tickets" />} />
        <Route path="/lookup" element={<Placeholder title="Manual ride lookup" />} />
        <Route path="/verification" element={<Placeholder title="Driver verification" />} />
        <Route path="/settings" element={<Placeholder title="Settings" />} />
      </Routes>
    </div>
  );
}
