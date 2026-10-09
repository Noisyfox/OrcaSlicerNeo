import { useEffect, useRef, useState } from 'react';
import { Printer } from 'lucide-react';
import type { WizardImageSession } from './setupWizardImages';

export function WizardPrinterCover({ path, root, session }: {
  path: string; root: HTMLDivElement | null; session: WizardImageSession | null;
}) {
  const target = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState('unrequested');
  useEffect(() => {
    let disposed = false;
    setUrl(null); setState('unrequested');
    if (!root || !session || !path || !target.current) return;
    const observer = new IntersectionObserver(entries => {
      if (disposed || !entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      setState('loading');
      void session.load(path).then(result => {
        if (!disposed) { setUrl(result); setState(result ? 'loaded' : 'failed'); }
      });
    }, { root });
    observer.observe(target.current.closest('[data-slot="card"]') ?? target.current);
    return () => { disposed = true; observer.disconnect(); };
  }, [path, root, session]);
  return <div ref={target} data-setup-cover={path ? state : 'missing'}>
    {url ? <img src={url} alt="" className="mx-auto h-24 max-w-full object-contain" />
      : <Printer className="mx-auto size-24 text-muted-foreground" />}
  </div>;
}
