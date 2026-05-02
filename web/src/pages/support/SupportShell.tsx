import { Link, Route, Routes } from "react-router-dom";

function Placeholder({ title }: { title: string }) {
  return (
    <div>
      <h2>{title}</h2>
      <p style={{ color: "#555" }}>
        TODO: Auth for `support_staff` custom claim, search callables, read-only RTDB views where rules allow.
      </p>
    </div>
  );
}

export function SupportShell() {
  return (
    <div>
      <h1>Support</h1>
      <nav style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <Link to="/support">Home</Link>
        <Link to="/support/search-ride">Search ride</Link>
        <Link to="/support/search-user">Search rider/driver</Link>
        <Link to="/support/tickets">Open tickets</Link>
        <Link to="/support/refunds">Refunds / payment status</Link>
        <Link to="/support/escalations">Escalations</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Placeholder title="Support home" />} />
        <Route path="/search-ride" element={<Placeholder title="Search ride" />} />
        <Route path="/search-user" element={<Placeholder title="Search rider/driver" />} />
        <Route path="/tickets" element={<Placeholder title="Open tickets" />} />
        <Route path="/refunds" element={<Placeholder title="Refunds / payment status" />} />
        <Route path="/escalations" element={<Placeholder title="Escalations" />} />
      </Routes>
    </div>
  );
}
