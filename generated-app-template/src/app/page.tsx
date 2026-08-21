import Link from 'next/link';

export default function HomePage() {
  return (
    <section>
      <h1>AI Services Marketplace</h1>
      <p className="lede">
        A marketplace for AI delivery work. Customers post what they need, the platform drafts an AI
        brief instantly, providers respond with proposals, and the customer accepts the best one —
        every step persisted and visible.
      </p>

      <div className="role-grid">
        <Link href="/customer" className="role-card">
          <h3>Customer</h3>
          <p className="muted">Submit a request and review the AI brief, proposals, and status.</p>
        </Link>
        <Link href="/provider" className="role-card">
          <h3>Provider</h3>
          <p className="muted">Browse open requests and submit a proposal with your price.</p>
        </Link>
        <Link href="/admin" className="role-card">
          <h3>Admin</h3>
          <p className="muted">See recent requests, proposal state, and platform health.</p>
        </Link>
      </div>

      <h2>How it works</h2>
      <ol className="flow">
        <li>Customer submits a service request.</li>
        <li>An AI brief is generated (deterministic fallback when no model is configured).</li>
        <li>A status event records the request and brief.</li>
        <li>Providers submit proposals against the request.</li>
        <li>The customer accepts or rejects; status updates persist.</li>
        <li>Customer, provider, and admin dashboards reflect the current state from the database.</li>
      </ol>
    </section>
  );
}
