import { useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { Alert, Button, Field } from '../components/ui';
import * as v from '../lib/validate';

export function SignIn({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async (e: Event) => {
    e.preventDefault(); setError('');
    if (!v.email(email)) { setError('Enter a valid email address.'); return; }
    setBusy(true);
    try { await api.sendCode(email.trim()); setStage('code'); setCode(''); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  };
  const verify = async (e: Event) => {
    e.preventDefault(); setError('');
    if (!v.code(code)) { setError('Enter the 6-digit code from your email.'); return; }
    setBusy(true);
    try { await api.verifyCode(email.trim(), code.trim()); onDone(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Something went wrong.'); setBusy(false); }
  };

  return (
    <div class="card">
      <h1>Sign in to the partner portal</h1>
      <p class="muted">Apply to become an Ntagz partner, or follow your application. We sign you in with a code sent to your email, so there is no password to remember.</p>
      {error && <Alert kind="bad">{error}</Alert>}
      {stage === 'email' ? (
        <form onSubmit={send} noValidate>
          <Field id="email" label="Email address">{(a) => <input {...a} type="email" inputMode="email" autoComplete="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required />}</Field>
          <Button primary type="submit" busy={busy}>Send me a code</Button>
        </form>
      ) : (
        <form onSubmit={verify} noValidate>
          <Alert kind="info">We sent a 6-digit code to <strong>{email}</strong>. It is valid for 10 minutes.</Alert>
          <Field id="code" label="6-digit code">{(a) => <input {...a} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} required />}</Field>
          <div class="row">
            <Button primary type="submit" busy={busy}>Sign in</Button>
            <Button onClick={() => { setStage('email'); setError(''); }}>Use a different email</Button>
          </div>
        </form>
      )}
    </div>
  );
}
