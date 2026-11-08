import type { Me } from '../types';

const COVERS: Array<[string, string]> = [
  ['catalog.wholesale.read', 'View the wholesale catalogue and your partner prices'],
  ['orders.place.own', 'Place wholesale orders'],
  ['orders.read.own', 'Track your orders'],
  ['leads.manage.own', 'Create and manage customer leads'],
  ['quotes.create', 'Prepare quotations for bulk and corporate customers'],
  ['inventory.manage', 'Manage your outlet inventory'],
  ['service_jobs.manage.own', 'Handle NFC programming, QR setup and installation jobs'],
  ['commissions.read.own', 'View your earnings and commission statements'],
  ['reports.read', 'View your sales reports'],
  ['tickets.create', 'Raise support tickets with Ntagz'],
];
const TYPE_LABEL: Record<string, string> = { '360': 'Ntagz360', enterprise: 'Enterprise', flex: 'Flex', smile: 'Smile', smile_plus: 'Smile+' };

export function Dashboard({ me }: { me: Me }) {
  const p = me.partner;
  if (!p) return null;
  const mine = COVERS.filter(([k]) => me.permissions.includes(k));
  return (
    <>
      <div class="card">
        <h1>Welcome, {p.business_name}</h1>
        <p class="muted">Your partnership is active.</p>
        <dl class="kv">
          <div><dt>Partner ID</dt><dd>{p.partner_code}</dd></div>
          <div><dt>Category</dt><dd>{TYPE_LABEL[p.type_key] ?? p.type_key}</dd></div>
          <div><dt>Status</dt><dd><span class="badge">Active</span></dd></div>
        </dl>
      </div>
      <div class="card">
        <h2 class="mt0">What your partnership covers</h2>
        <ul class="plain">{mine.map(([k, t]) => <li key={k}>{t}</li>)}</ul>
        <p class="small muted mt4">Ntagz is opening these tools in stages. Each one will appear here as soon as it is ready. Earnings depend on your own sales; Ntagz does not guarantee any income.</p>
      </div>
      <div class="card">
        <h2 class="mt0">Your territory and support</h2>
        <p class="small muted">Territory assignment and support tickets will be available here. Until then, contact your Ntagz account manager.</p>
      </div>
    </>
  );
}
