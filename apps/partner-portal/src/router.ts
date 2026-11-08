import { useEffect, useState } from 'preact/hooks';

export function navigate(path: string, replace = false): void {
  if (location.pathname === path) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
export function usePath(): string {
  const [p, setP] = useState(location.pathname);
  useEffect(() => { const f = () => setP(location.pathname); window.addEventListener('popstate', f); return () => window.removeEventListener('popstate', f); }, []);
  return p;
}
