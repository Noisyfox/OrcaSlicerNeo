import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { Toast, ToastClose, ToastContent, ToastDescription, ToastProvider, ToastTitle,
  ToastViewport, createToastManager, useToastManager } from '@/components/ui/toast';
import { useNotificationStore, visibleNotifications, type WorkspaceNotification } from '@/stores/useNotificationStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';

function progressValue(value: number | null): number | null {
  return value === null ? null : Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function WorkspaceNotifications({ visible = true }: { visible?: boolean }) {
  const [manager] = useState(() => createToastManager<WorkspaceNotification>());
  return <ToastProvider toastManager={manager} timeout={0} limit={Infinity}><NotificationList visible={visible} /></ToastProvider>;
}

function NotificationList({ visible }: { visible: boolean }) {
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
      id: card.id, title: card.stale ? 'Awaiting revalidation' : card.title,
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
  return <ToastViewport ref={viewport} data-testid="workspace-notifications" aria-label="Workspace notifications" data-notification-surface="true"
    style={{ '--notification-width': `${bounds.width}px`, left: bounds.left, top: bounds.top, maxHeight: bounds.height } as CSSProperties}
    className="pointer-events-none fixed grid w-[min(320px,var(--notification-width))] items-start gap-2 overflow-hidden pb-3 data-[expanded]:pointer-events-auto data-[expanded]:overflow-y-auto"
    hidden={!visible || !cards.length}>
    {cards.map((card, index) => {
      const toast = byId.get(card.id);
      if (!toast) return null;
      return <Toast key={card.id} toast={toast} ref={index === 0 ? front : undefined} swipeDirection={[]}
        data-testid={card.testId ?? 'workspace-notification'}
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
          <div className="flex min-w-0 flex-1 flex-col gap-1"><ToastTitle />
            <ToastDescription className="line-clamp-2 group-data-[expanded]/toast:line-clamp-none" />
            {(card.progress || card.actions.length > 0) && <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {card.progress && <Progress value={progressValue(card.progress.value)}
                className="min-w-24 flex-1 flex-nowrap items-center gap-2 [&>[data-slot=progress-track]]:order-first [&>[data-slot=progress-track]]:w-auto [&>[data-slot=progress-track]]:flex-1">
                <ProgressLabel className="sr-only">{card.progress.label}</ProgressLabel><ProgressValue className="shrink-0" />
              </Progress>}
              {card.actions.length > 0 && <div className="ml-auto flex max-w-full flex-wrap items-center gap-1">
                {card.actions.map(action => <Button key={action.id} variant="ghost" size="xs" data-testid={action.testId}
                  disabled={action.disabled} onClick={() => { void action.onClick(); }}>{action.label}</Button>)}
              </div>}
            </div>}
          </div>
          {card.dismissible && <ToastClose />}
        </ToastContent>
      </Toast>;
    })}
    {toasts.filter(toast => !cards.some(card => card.id === toast.id) && toast.transitionStatus === 'ending')
      .map(toast => <Toast key={toast.id} toast={toast} hidden />)}
  </ToastViewport>;
}
