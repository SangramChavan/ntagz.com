import type { Mine } from '../types';
import { stages } from '../lib/steps';
import { Alert, Button } from '../components/ui';

export function Status({ mine, onEdit, onNew, onRefresh }: { mine: Mine; onEdit: () => void; onNew: () => void; onRefresh: () => void }) {
  const a = mine.application;
  if (!a) return null;
  if (a.status === 'rejected') {
    return (
      <div class="card">
        <h1>Application not approved</h1>
        <Alert kind="bad">{a.decisionNote || 'Ntagz could not approve this application.'}</Alert>
        <p class="muted">You are welcome to apply again with updated details.</p>
        <div class="row"><Button primary onClick={onNew}>Start a new application</Button></div>
      </div>
    );
  }
  const list = stages(a.status, mine.partner ? mine.partner.status : null);
  const heading = mine.partner ? `Partner ID ${mine.partner.partnerCode}` : 'Your application';
  return (
    <div class="card">
      <h1>{heading}</h1>
      {a.status === 'documents_required' && (
        <Alert kind="warn"><strong>Ntagz needs more from you.</strong><br />{a.decisionNote}</Alert>
      )}
      {mine.partner && <p class="muted">You are approved. Your dashboard opens once the steps below are complete. Ntagz records the agreement and your joining fee, and will contact you with the details.</p>}
      {!mine.partner && a.status !== 'documents_required' && <p class="muted">Your application is with Ntagz. Check this page for updates.</p>}
      <ol class="timeline">
        {list.map((s, i) => (
          <li key={s.key} class={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
            <span class="dot" aria-hidden="true">{s.state === 'done' ? '✓' : i + 1}</span>
            <span><strong>{s.title}{s.state === 'current' ? ' (now)' : ''}</strong><span class="small">{s.text}</span></span>
          </li>
        ))}
      </ol>
      <div class="row">
        {a.status === 'documents_required' && <Button primary onClick={onEdit}>Update my application</Button>}
        <Button onClick={onRefresh}>Check for updates</Button>
      </div>
    </div>
  );
}
