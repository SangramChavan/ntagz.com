import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import './styles.css';
import { api, ApiError } from './api';
import { navigate, usePath } from './router';
import { SignIn } from './pages/SignIn';
import { Apply } from './pages/Apply';
import { Status } from './pages/Status';
import { Dashboard } from './pages/Dashboard';
import { Leads } from './pages/Leads';
import { LeadDetail } from './pages/LeadDetail';
import { Quotes } from './pages/Quotes';
import { QuoteEditor } from './pages/QuoteEditor';
import { QuoteView } from './pages/QuoteView';
import { Earnings } from './pages/Earnings';
import type { Me, Mine } from './types';

type Boot = { s: 'loading' } | { s: 'out' } | { s: 'in'; me: Me; mine: Mine | null } | { s: 'error'; msg: string };

// Where a signed-in person belongs, from server state only.
function home(me: Me, mine: Mine | null): string {
  if (me.partner && me.partner.status === 'active') return '/dashboard';
  const st = mine?.application?.status;
  if (!st || st === 'draft') return '/apply';
  return '/status';
}

function App() {
  const path = usePath();
  const [b, setB] = useState<Boot>({ s: 'loading' });

  const load = useCallback(async () => {
    try {
      const me = await api.me();
      const mine = await api.mine().catch(() => null);
      setB({ s: 'in', me, mine });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setB({ s: 'out' });
      else setB({ s: 'error', msg: e instanceof ApiError ? e.message : 'Something went wrong.' });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const signOut = async () => { try { await api.logout(); } catch { /* cookie may already be gone */ } setB({ s: 'out' }); navigate('/signin', true); };

  useEffect(() => {
    if (b.s === 'out' && path !== '/signin') navigate('/signin', true);
    if (b.s === 'in') {
      const h = home(b.me, b.mine); const active = b.me.partner?.status === 'active';
      const st = b.mine?.application?.status;
      const editable = !st || st === 'draft' || st === 'documents_required';
      if (path === '/' || path === '/signin') navigate(h, true);
      else if (path === '/dashboard' && !active) navigate(h, true);
      else if (path === '/apply' && (active || !editable)) navigate(h, true);
      else if (path === '/status' && (active || !b.mine?.application)) navigate(h, true);
      else if (path.startsWith('/leads') && !(active && b.me.permissions.includes('leads.manage.own'))) navigate(h, true);
      else if (path === '/earnings' && !(active && b.me.permissions.includes('commissions.read.own'))) navigate(h, true);
      else if (path.startsWith('/quotes') && !(active && b.me.permissions.includes('quotes.create'))) navigate(h, true);
    }
  }, [b, path]);

  return (
    <>
      <header class="top"><div class="top-in">
        <span class="brand">ntagz <b>Partner</b></span>
        {b.s === 'in' && b.me.partner?.status === 'active' && (
          <nav class="subnav" aria-label="Partner sections">
            <a href="/dashboard" aria-current={path === '/dashboard' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate('/dashboard'); }}>Overview</a>
            {b.me.permissions.includes('quotes.create') && <a href="/quotes" aria-current={path.startsWith('/quotes') ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate('/quotes'); }}>Quotes</a>}
            {b.me.permissions.includes('leads.manage.own') && <a href="/leads" aria-current={path.startsWith('/leads') ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate('/leads'); }}>Leads</a>}
            {b.me.permissions.includes('commissions.read.own') && <a href="/earnings" aria-current={path === '/earnings' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate('/earnings'); }}>Earnings</a>}
          </nav>
        )}
        {b.s === 'in' && <span class="who"><span>{b.me.email}</span><button class="link-btn" onClick={() => void signOut()}>Sign out</button></span>}
      </div></header>
      <main>
        {b.s === 'loading' && <p class="center" role="status">Loading…</p>}
        {b.s === 'error' && <div class="card"><h1>Something went wrong</h1><p class="muted">{b.msg}</p><button class="btn primary" onClick={() => { setB({ s: 'loading' }); void load(); }}>Try again</button></div>}
        {b.s === 'out' && <SignIn onDone={() => { setB({ s: 'loading' }); void load(); }} />}
        {b.s === 'in' && path === '/apply' && <Apply initial={b.mine} onSubmitted={async () => { await load(); navigate('/status'); }} />}
        {b.s === 'in' && path === '/status' && b.mine && <Status mine={b.mine} onRefresh={() => void load()} onEdit={() => navigate('/apply')} onNew={async () => { await api.save({}).catch(() => null); navigate('/apply'); }} />}
        {b.s === 'in' && path === '/dashboard' && <Dashboard me={b.me} />}
        {b.s === 'in' && path === '/leads' && <Leads />}
        {b.s === 'in' && /^\/leads\/[0-9a-f-]{36}$/.test(path) && <LeadDetail id={path.slice(7)} key={path} canQuote={b.me.permissions.includes('quotes.create')} />}
        {b.s === 'in' && path === '/earnings' && <Earnings />}
        {b.s === 'in' && path === '/quotes' && <Quotes />}
        {b.s === 'in' && /^\/quotes\/new\/[0-9a-f-]{36}$/.test(path) && <QuoteEditor leadId={path.slice(12)} key={path} />}
        {b.s === 'in' && /^\/quotes\/[0-9a-f-]{36}\/edit$/.test(path) && <QuoteEditor quoteId={path.slice(8, 44)} key={path} />}
        {b.s === 'in' && /^\/quotes\/[0-9a-f-]{36}$/.test(path) && <QuoteView id={path.slice(8)} key={path} />}
      </main>
    </>
  );
}
render(<App />, document.getElementById('app')!);
