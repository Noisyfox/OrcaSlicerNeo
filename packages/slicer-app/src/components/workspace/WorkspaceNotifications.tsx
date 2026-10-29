import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { Toast, ToastClose, ToastContent, ToastDescription, ToastProvider, ToastTitle,
  ToastViewport, createToastManager, useToastManager } from '@/components/ui/toast';
import { useNotificationStore, visibleNotifications, type WorkspaceNotification } from '@/stores/useNotificationStore';
import { useArrangementStore } from '@/stores/useArrangementStore';
import { cancelArrangement } from './actions/arrangementActions';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';

export function WorkspaceNotifications({ visible = true }: { visible?: boolean }) {
  const [manager] = useState(() => createToastManager<WorkspaceNotification>());
  return <ToastProvider toastManager={manager} timeout={0} limit={Infinity}><NotificationList visible={visible} /></ToastProvider>;
}

function NotificationList({ visible }: { visible: boolean }) {
  const platform = usePlatform();
  const { active, cancellable, cancelling } = useArrangementStore();
  const notifications = useNotificationStore(s => s.notifications);
  const plateId = usePlateSessionStore(s => s.snapshot?.currentPlateId);
  const cards = useMemo(() => visibleNotifications(notifications, plateId ?? ''), [notifications, plateId]);
  const { toasts, add, close } = useToastManager<WorkspaceNotification>();
  const rendered = useRef(new Map<string, WorkspaceNotification>());
  const programmaticClosures = useRef(new Set<string>());
  const viewport = useRef<HTMLDivElement>(null);
  const front = useRef<HTMLDivElement>(null);
  const [frontHeight, setFrontHeight] = useState(0);
  const [bounds, setBounds] = useState({ left: 0, top: 0, width: 320, height: 400 });

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
      id: card.id, title: card.source === 'arrangement' ? card.title : card.stale ? 'Awaiting revalidation' : card.severity === 'error' ? 'Error' : 'Warning',
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
    const anchor = document.querySelector('[data-notification-anchor]');
    const container = anchor?.closest('[data-testid="viewport-actions"]')?.parentElement;
    if (!anchor || !container) return;
    const measure = () => {
      const a = anchor.getBoundingClientRect(), c = container.getBoundingClientRect();
      const next = { left: a.left, top: a.bottom + 4,
        width: Math.max(0, c.right - a.left - 4), height: Math.max(0, c.bottom - a.bottom - 8) };
      setBounds(old => Object.keys(next).every(key => old[key as keyof typeof old] === next[key as keyof typeof next]) ? old : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(anchor); observer.observe(container); measure();
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [visible]);

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
  return <ToastViewport ref={viewport} data-testid="workspace-notifications" aria-label="Workspace notifications" data-arrangement-allowed="true"
    style={{ '--notification-width': `${bounds.width}px`, left: bounds.left, top: bounds.top, maxHeight: bounds.height } as CSSProperties}
    className="pointer-events-none fixed grid w-[min(320px,var(--notification-width))] items-start gap-2 overflow-hidden pb-3 data-[expanded]:pointer-events-auto data-[expanded]:overflow-y-auto"
    hidden={!visible || !cards.length}>
    {cards.map((card, index) => {
      const toast = byId.get(card.id);
      if (!toast) return null;
      const running = card.source === 'arrangement' && card.progress !== null;
      return <Toast key={card.id} toast={toast} ref={index === 0 ? front : undefined} swipeDirection={[]}
        data-testid={card.source === 'arrangement' ? 'arrangement-status' : 'slice-notification'}
        data-severity={card.severity} data-stale={card.stale || undefined}
        style={state => ({ gridArea: state.expanded ? undefined : '1 / 1', zIndex: cards.length - index,
          height: !state.expanded && index > 0 ? frontHeight : undefined, overflow: 'hidden',
          transform: state.expanded ? undefined : `translateY(${Math.min(index, 3) * 4}px) scale(${1 - Math.min(index, 3) * 0.025})`,
          opacity: !state.expanded && index > 3 ? 0 : card.stale ? 0.65 : 1,
          pointerEvents: !state.expanded && index > 0 ? 'none' : 'auto',
        })}>
        <ToastContent>
          {card.severity === 'error' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
            : card.severity === 'warning' ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            : <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <div className="flex min-w-0 flex-1 flex-col gap-2"><ToastTitle />
            <ToastDescription className="line-clamp-2 group-data-[expanded]/toast:line-clamp-none" />
            {running && <>
              <Progress value={card.progress}><ProgressLabel className="sr-only">Arrangement progress</ProgressLabel><ProgressValue /></Progress>
              {active && cancellable && <Button variant="outline" size="sm" data-testid="arrange-cancel" disabled={cancelling}
                onClick={() => { void cancelArrangement(platform); }}>{cancelling ? 'Cancelling…' : 'Cancel'}</Button>}
            </>}
          </div>
          {!running && <ToastClose />}
        </ToastContent>
      </Toast>;
    })}
    {toasts.filter(toast => !cards.some(card => card.id === toast.id) && toast.transitionStatus === 'ending')
      .map(toast => <Toast key={toast.id} toast={toast} hidden />)}
  </ToastViewport>;
}
