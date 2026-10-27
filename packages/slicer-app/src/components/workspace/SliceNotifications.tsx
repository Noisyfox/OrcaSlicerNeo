import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { Toast, ToastClose, ToastContent, ToastDescription, ToastProvider, ToastTitle,
  ToastViewport, createToastManager, useToastManager } from '@/components/ui/toast';
import { useNotificationStore, visibleNotifications, type SliceNotification } from '@/stores/useNotificationStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';

export function SliceNotifications() {
  const [manager] = useState(() => createToastManager<SliceNotification>());
  return <ToastProvider toastManager={manager} timeout={0} limit={Infinity}><NotificationList /></ToastProvider>;
}

function NotificationList() {
  const notifications = useNotificationStore(s => s.notifications);
  const plateId = usePlateSessionStore(s => s.snapshot?.currentPlateId);
  const cards = useMemo(() => visibleNotifications(notifications, plateId ?? ''), [notifications, plateId]);
  const { toasts, add, close } = useToastManager<SliceNotification>();
  const rendered = useRef(new Map<string, SliceNotification>());
  const programmaticClosures = useRef(new Set<string>());
  const viewport = useRef<HTMLDivElement>(null);
  const front = useRef<HTMLDivElement>(null);
  const [frontHeight, setFrontHeight] = useState(0);
  const [bounds, setBounds] = useState({ width: 320, height: 400 });

  useLayoutEffect(() => {
    const next = new Set(cards.map(card => card.id));
    for (const id of rendered.current.keys()) if (!next.has(id)) {
      const toast = toasts.find(item => item.id === id);
      if (toast && toast.transitionStatus !== 'ending') {
        programmaticClosures.current.add(id); close(id);
      }
    }
    for (const card of cards) if (rendered.current.get(card.id) !== card) {
      programmaticClosures.current.delete(card.id);
      add({
      id: card.id, title: card.stale ? 'Awaiting revalidation' : card.severity === 'error' ? 'Error' : 'Warning',
      description: card.message, type: card.severity, data: card, timeout: 0,
      priority: !card.stale && card.severity === 'error' ? 'high' : 'low',
      onClose: () => {
        if (!programmaticClosures.current.delete(card.id)) useNotificationStore.getState().dismiss(card.id);
      },
      });
    }
    rendered.current = new Map(cards.map(card => [card.id, card]));
  }, [cards, add, close]);

  useLayoutEffect(() => {
    const anchor = viewport.current?.parentElement;
    const container = anchor?.closest('[data-testid="viewport-actions"]')?.parentElement;
    if (!anchor || !container) return;
    const measure = () => {
      const a = anchor.getBoundingClientRect(), c = container.getBoundingClientRect();
      const next = { width: Math.max(0, c.right - a.left - 4), height: Math.max(0, c.bottom - a.bottom - 8) };
      setBounds(old => old.width === next.width && old.height === next.height ? old : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(anchor); observer.observe(container); measure();
    return () => observer.disconnect();
  }, []);

  const byId = new Map(toasts.map(toast => [toast.id, toast]));
  const frontId = cards[0]?.id;
  const frontMounted = frontId !== undefined && byId.has(frontId);
  useLayoutEffect(() => {
    if (!front.current) return;
    const measure = () => setFrontHeight(front.current?.offsetHeight ?? 0);
    const observer = new ResizeObserver(measure);
    observer.observe(front.current); measure();
    return () => observer.disconnect();
  }, [frontId, frontMounted]);
  return <ToastViewport ref={viewport} data-testid="slice-notifications" aria-label="Slice notifications"
    style={{ '--notification-width': `${bounds.width}px`, maxHeight: bounds.height } as CSSProperties}
    className="pointer-events-none absolute top-full left-0 mt-1 grid w-[min(320px,var(--notification-width))] items-start gap-2 overflow-hidden pb-3 data-[expanded]:pointer-events-auto data-[expanded]:overflow-y-auto"
    hidden={!cards.length}>
    {cards.map((card, index) => {
      const toast = byId.get(card.id);
      if (!toast) return null;
      return <Toast key={card.id} toast={toast} ref={index === 0 ? front : undefined} swipeDirection={[]} data-testid="slice-notification"
        data-severity={card.severity} data-stale={card.stale || undefined}
        style={state => ({ gridArea: state.expanded ? undefined : '1 / 1', zIndex: cards.length - index,
          height: !state.expanded && index > 0 ? frontHeight : undefined, overflow: 'hidden',
          transform: state.expanded ? undefined : `translateY(${Math.min(index, 3) * 4}px) scale(${1 - Math.min(index, 3) * 0.025})`,
          opacity: !state.expanded && index > 3 ? 0 : card.stale ? 0.65 : 1,
          pointerEvents: !state.expanded && index > 0 ? 'none' : 'auto',
        })}>
        <ToastContent>
          {card.severity === 'error' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
            : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden="true" />}
          <div className="min-w-0 flex-1"><ToastTitle /><ToastDescription className="line-clamp-2 group-data-[expanded]/toast:line-clamp-none" /></div>
          <ToastClose />
        </ToastContent>
      </Toast>;
    })}
    {toasts.filter(toast => !cards.some(card => card.id === toast.id) && toast.transitionStatus === 'ending')
      .map(toast => <Toast key={toast.id} toast={toast} hidden />)}
  </ToastViewport>;
}
