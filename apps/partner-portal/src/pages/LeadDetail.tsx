import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { Alert, Button, Field } from '../components/ui';
import { ACTIVITY_LABEL, LEAD_STATUS, NEXT, when } from '../lib/leads';
import { navigate } from '../router';
import { rupeesExact } from '../lib/format';
import { QUOTE_STATUS } from '../lib/quotes';
import type { Lead, LeadActivity, LeadStatus, Quote } from '../types';

export function LeadDetail({ id, canQuote }: { id: string; canQuote?: boolean }) {
  const [data, setData] = useState<{ lead: Lead; activities: LeadActivity[] } | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'note' | 'call' | 'visit'>('note');
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  const [losing, setLosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bodyErr, setBodyErr] = useState('');
  const [quotes, setQuotes] = useState<Quote[]>([]);

  useEffect(() => { if (canQuote) api.quotes(undefined, id).then((r) => setQuotes(r.items)).catch(() => setQuotes([])); }, [id, canQuote]);
  useEffect(() => { api.lead(id).then(setData).catch((e) => setError(e instanceof ApiError && e.status === 404 ? 'This lead was not found.' : 'Could not load this lead.')); }, [id]);
  const run = async (fn: () => Promise<{ lead: Lead; activities: LeadActivity[] }>) => {
    setBusy(true); setError('');
    try { setData(await fn()); return true; } catch (e) { setError(e instanceof ApiError ? e.message + (Object.values(e.fields).length ? ': ' + Object.values(e.fields).join(', ') : '') : 'Something went wrong.'); return false; } finally { setBusy(false); }
  };

  if (error && !data) return <div class="card"><h1>Lead</h1><Alert kind="bad">{error}</Alert><div class="row"><Button onClick={() => navigate('/leads')}>Back to leads</Button></div></div>;
  if (!data) return <p class="center" role="status">Loading…</p>;
  const { lead, activities } = data;
  const next = NEXT[lead.status] ?? [];
  const open = ['new', 'contacted', 'qualified', 'quotation'].includes(lead.status);
  const label = (s: LeadStatus) => ({ contacted: 'Mark contacted', qualified: 'Mark qualified', lost: 'Mark lost' } as Record<string, string>)[s] ?? s;

  return (
    <>
      <div class="card">
        <button class="backlink" type="button" onClick={() => navigate('/leads')}>← All leads</button>
        <div class="titlerow"><h1>{lead.businessName}</h1><span class={`pill ${LEAD_STATUS[lead.status][1]}`}>{LEAD_STATUS[lead.status][0]}</span></div>
        {error && <Alert kind="bad">{error}</Alert>}
        <dl class="summary">
          <div><dt>Contact</dt><dd>{lead.contactName}</dd></div>
          <div><dt>Mobile</dt><dd><a href={`tel:${lead.phone}`}>{lead.phone}</a></dd></div>
          {lead.email && <div><dt>Email</dt><dd>{lead.email}</dd></div>}
          {(lead.city || lead.state || lead.pincode) && <div><dt>Location</dt><dd>{[lead.city, lead.state, lead.pincode].filter(Boolean).join(', ')}</dd></div>}
          {lead.interest && <div><dt>Needs</dt><dd>{lead.interest}</dd></div>}
          {lead.estQuantity && <div><dt>Quantity</dt><dd>{lead.estQuantity.toLocaleString('en-IN')} pcs</dd></div>}
          {lead.notes && <div><dt>Notes</dt><dd>{lead.notes}</dd></div>}
          {lead.lostReason && <div><dt>Why lost</dt><dd>{lead.lostReason}</dd></div>}
        </dl>
        {lead.status === 'quotation' && <p class="small muted">Ntagz is preparing a quotation for this lead.</p>}
        {lead.status === 'won' && <p class="small muted">Ntagz recorded an order from this lead.</p>}
        {next.length > 0 && !losing && (
          <div class="row">
            {next.map((s) => s === 'lost' ? <Button key={s} onClick={() => setLosing(true)}>{label(s)}</Button> : <Button key={s} primary={s === 'contacted'} busy={busy} onClick={() => void run(() => api.leadStatus(id, s))}>{label(s)}</Button>)}
          </div>
        )}
        {losing && (
          <div class="field mt4">
            <label for="why">Why was this lead lost?</label>
            <textarea id="why" value={reason} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
            <div class="row"><Button primary busy={busy} onClick={async () => { if (await run(() => api.leadStatus(id, 'lost', reason))) setLosing(false); }}>Mark lost</Button><Button onClick={() => setLosing(false)}>Cancel</Button></div>
          </div>
        )}
      </div>

      {canQuote && (open || quotes.length > 0) && (
        <div class="card">
          <h2 class="mt0">Quotations</h2>
          {quotes.length === 0 && <p class="muted">No quotation yet for this lead.</p>}
          <ul class="leadlist">
            {quotes.map((x) => <li key={x.id}><button class="leadcard" type="button" onClick={() => navigate('/quotes/' + x.id)}><span class="leadtop"><strong>{x.number}</strong><span class={`pill ${QUOTE_STATUS[x.status][1]}`}>{QUOTE_STATUS[x.status][0]}</span></span><span class="muted small">{rupeesExact(x.totalPaise)}</span></button></li>)}
          </ul>
          {open && <div class="row"><Button primary onClick={() => navigate('/quotes/new/' + id)}>Prepare quotation</Button></div>}
        </div>
      )}

      {open && (
        <div class="card">
          <h2 class="mt0">Log a note, call or visit</h2>
          <div class="chiprow" role="group" aria-label="Type">
            {(['note', 'call', 'visit'] as const).map((k) => <button key={k} class="chip" type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{ACTIVITY_LABEL[k]}</button>)}
          </div>
          <Field id="actbody" label="What happened?" error={bodyErr}>{(a) => <textarea {...a} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />}</Field>
          <Button primary busy={busy} onClick={async () => { setBodyErr(''); if (!body.trim()) { setBodyErr('Write something first.'); return; } if (await run(() => api.leadNote(id, kind, body))) setBody(''); }}>Save</Button>
        </div>
      )}

      <div class="card">
        <h2 class="mt0">History</h2>
        <ol class="timeline">
          {activities.map((a, i) => (
            <li key={i} class="done"><span class="dot" aria-hidden="true">•</span><span><strong>{ACTIVITY_LABEL[a.kind] ?? a.kind} · {a.by}</strong><span class="small muted">{when(a.at)}</span>{a.body && <span class="small">{a.body}</span>}</span></li>
          ))}
        </ol>
      </div>
    </>
  );
}
