import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform, type AppTab, type RecentProject } from '@orca/platform-contract';

/** One metadata list for Home and File menus; thumbnail requests stay separate. */
export function useRecentProjects(activeTab: AppTab) {
  const { recentProjects } = usePlatform();
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await recentProjects.list();
      if (request === sequence.current) { setProjects(next); setError(null); }
    } catch {
      if (request === sequence.current) setError('Recent projects could not be loaded.');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [recentProjects]);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { ++sequence.current; window.removeEventListener('focus', onFocus); };
  }, [activeTab, refresh]);
  return { projects, loading, error, refresh };
}

export type RecentProjectsHistory = ReturnType<typeof useRecentProjects>;
