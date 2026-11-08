import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { Alert, Button, Field } from '../components/ui';
import { LEAD_CHIPS, LEAD_STATUS, when } from '../lib/leads';
import { navigate } from '../router';
import { STATES } from '../lib/steps';
import type { Lead, LeadCounts } from '../types';

const EMPTY = { businessName: '', contactName: '', phone: '', email: '', city: '', state: '', pincode: '', interest: '', estQuantity: '', notes: '' };

export function Leads() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Lead[] | null>(null);
  const [counts, setCounts] = useState<LeadCounts | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const timer = useRef<number>(0);

  const load = async (s = status, query = q) => {
    try { const r = await api.leads(s || undefined, query || undefined); setItems(r.items); setCounts(r.counts); setError(''); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); }
  };
  useEffect(() => { void load(); }, []);

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <>
      <div class="card">
        <div class="titlerow"><h1>Leads</h1><Button primary onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add a lead'}</Button></div>
        <p class="muted">Register businesses you meet. Each phone number can belong to one partner at a time, so register a lead as soon as you have spoken to them.</p>
        {error && <Alert kind="bad">{error}</Alert>}
        {adding && <AddLead onDone={async () => { setAdding(false); await load(); }} />}
      </div>
      {!adding && (
        <div class="card">
          <div class="field">
            <label for="lq">Search your leads</label>
            <input id="lq" type="search" placeholder="Business, contact, phone or city" value={q} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setQ(v); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void load(status, v), 300); }} />
          </div>
          <div class="chiprow" role="group" aria-label="Lead status">
            {LEAD_CHIPS.map(([k, l]) => <button key={k} class="chip" type="button" aria-pressed={status === k} onClick={() => { setStatus(k); void load(k, q); }}>{k ? `${l} (${counts ? counts[k as keyof LeadCounts] : 0})` : `${l} (${total})`}</button>)}
          </div>
          {items === null && !error && <p class="muted" role="status">Loading…</p>}
          {items && items.length === 0 && <p class="muted">{q || status ? 'No leads match this filter.' : 'No leads yet. Use "Add a lead" when you meet a business that could use Ntagz products.'}</p>}
          <ul class="leadlist">
            {items?.map((l) => (
              <li key={l.id}>
                <button class="leadcard" type="button" onClick={() => navigate('/leads/' + l.id)} aria-label={`Open lead ${l.businessName}`}>
                  <span class="leadtop"><strong>{l.businessName}</strong><span class={`pill ${LEAD_STATUS[l.status][1]}`}>{LEAD_STATUS[l.status][0]}</span></span>
                  <span class="muted small">{l.contactName} · {l.phone}{l.city ? ' · ' + l.city : ''}</span>
                  <span class="muted small">{l.estQuantity ? `${l.estQuantity.toLocaleString('en-IN')} pcs · ` : ''}Updated {when(l.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function AddLead({ onDone }: { onDone: () => void | Promise<void> }) {
  const [d, setD] = useState(EMPTY);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof EMPTY, v: string) => setD((p) => ({ ...p, [k]: v }));
  const inp = (k: keyof typeof EMPTY, extra: Record<string, string> = {}) => ({ value: d[k], onInput: (e: Event) => set(k, (e.target as HTMLInputElement).value), ...extra });

  const save = async (e: Event) => {
    e.preventDefault(); setBanner(''); setErrs({}); setBusy(true);
    const x: Record<string, string> = {};
    if (!d.businessName.trim()) x.businessName = 'Enter the business name.';
    if (!d.contactName.trim()) x.contactName = 'Enter who you spoke to.';
    if (!/^[6-9]\d{9}$/.test(d.phone.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))) x.phone = 'Enter a 10-digit mobile number.';
    if (Object.keys(x).length) { setErrs(x); setBanner('Please correct the highlighted fields.'); setBusy(false); setTimeout(() => document.getElementById(Object.keys(x)[0] ?? '')?.focus(), 0); return; }
    try {
      await api.createLead({ ...d, estQuantity: d.estQuantity === '' ? undefined : Number(d.estQuantity) });
      await onDone();
    } catch (err) {
      if (err instanceof ApiError) { setBanner(err.message); setErrs(err.fields); } else setBanner('Something went wrong. Please try again.');
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} noValidate>
      {banner && <Alert kind="bad">{banner}</Alert>}
      <Field id="businessName" label="Business name" error={errs.businessName}>{(a) => <input {...a} type="text" autoComplete="off" {...inp('businessName')} />}</Field>
      <Field id="contactName" label="Contact person" error={errs.contactName}>{(a) => <input {...a} type="text" autoComplete="off" {...inp('contactName')} />}</Field>
      <Field id="phone" label="Mobile number" hint="Used to make sure two partners do not chase the same business." error={errs.phone}>{(a) => <input {...a} type="tel" inputMode="tel" autoComplete="off" {...inp('phone')} />}</Field>
      <Field id="email" label="Email (optional)" error={errs.email}>{(a) => <input {...a} type="email" inputMode="email" autoComplete="off" {...inp('email')} />}</Field>
      <Field id="city" label="City (optional)" error={errs.city}>{(a) => <input {...a} type="text" autoComplete="off" {...inp('city')} />}</Field>
      <Field id="state" label="State (optional)" error={errs.state}>{(a) => <select {...a} value={d.state} onChange={(e) => set('state', (e.target as HTMLSelectElement).value)}><option value="">Choose…</option>{STATES.map((s) => <option key={s}>{s}</option>)}</select>}</Field>
      <Field id="pincode" label="PIN code (optional)" error={errs.pincode}>{(a) => <input {...a} type="text" inputMode="numeric" maxLength={6} autoComplete="off" value={d.pincode} onInput={(e) => set('pincode', (e.target as HTMLInputElement).value.replace(/\D/g, ''))} />}</Field>
      <Field id="interest" label="What do they need? (optional)" hint="For example: 100 NFC review stands for a restaurant." error={errs.interest}>{(a) => <textarea {...a} value={d.interest} onInput={(e) => set('interest', (e.target as HTMLTextAreaElement).value)} />}</Field>
      <Field id="estQuantity" label="Roughly how many pieces? (optional)" error={errs.estQuantity}>{(a) => <input {...a} type="number" inputMode="numeric" min={1} {...inp('estQuantity')} />}</Field>
      <Field id="notes" label="Notes (optional)" error={errs.notes}>{(a) => <textarea {...a} value={d.notes} onInput={(e) => set('notes', (e.target as HTMLTextAreaElement).value)} />}</Field>
      <div class="row"><Button primary type="submit" busy={busy}>Save lead</Button></div>
    </form>
  );
}
