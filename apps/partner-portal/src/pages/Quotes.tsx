import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { Alert } from '../components/ui';
import { rupeesExact } from '../lib/format';
import { QUOTE_CHIPS, QUOTE_STATUS, day } from '../lib/quotes';
import { navigate } from '../router';
import type { Quote, QuoteStatus } from '../types';

export function Quotes() {
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<Quote[] | null>(null);
  const [counts, setCounts] = useState<Record<QuoteStatus, number> | null>(null);
  const [error, setError] = useState('');
  const load = async (s = status) => { try { const r = await api.quotes(s || undefined); setItems(r.items); setCounts(r.counts); setError(''); } catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); } };
  useEffect(() => { void load(); }, []);
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div class="card">
      <h1>Quotations</h1>
      <p class="muted">Prices come from the same system that checkout uses, so a quotation always matches what your customer would pay. Ntagz approves each quotation before you send it. To start one, open a lead and choose "Prepare quotation".</p>
      {error && <Alert kind="bad">{error}</Alert>}
      <div class="chiprow" role="group" aria-label="Quotation status">
        {QUOTE_CHIPS.map(([k, l]) => <button key={k} class="chip" type="button" aria-pressed={status === k} onClick={() => { setStatus(k); void load(k); }}>{k ? `${l} (${counts ? counts[k as QuoteStatus] : 0})` : `${l} (${total})`}</button>)}
      </div>
      {items === null && !error && <p class="muted" role="status">Loading…</p>}
      {items && items.length === 0 && <p class="muted">{status ? 'No quotations in this status.' : 'No quotations yet.'}</p>}
      <ul class="leadlist">
        {items?.map((q) => (
          <li key={q.id}>
            <button class="leadcard" type="button" onClick={() => navigate('/quotes/' + q.id)} aria-label={`Open quotation ${q.number}`}>
              <span class="leadtop"><strong>{q.number} · {q.leadBusiness ?? q.customerName}</strong><span class={`pill ${QUOTE_STATUS[q.status][1]}`}>{QUOTE_STATUS[q.status][0]}</span></span>
              <span class="muted small">{rupeesExact(q.totalPaise)} · {q.pieces.toLocaleString('en-IN')} pcs · valid until {day(q.validUntil)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
