import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, FilePlus2, FolderOpen, FolderSearch, History, MoreHorizontal, Trash2 } from 'lucide-react';
import { usePlatform, type RecentProject } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface HomePageProps {
  active: boolean;
  canOpen: boolean;
  canCreate: boolean;
  onOpen(): Promise<unknown>;
  onCreate(): Promise<unknown>;
  onOpenRecent(id: string): Promise<unknown>;
}

function RecentProjectThumbnail({ project, active }: { project: RecentProject; active: boolean }) {
  const { recentProjects } = usePlatform();
  const [image, setImage] = useState<{ id: string; modifiedAt: number | null; url: string | null } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!active || project.missing) return;
    let current = true;
    void recentProjects.thumbnail(project.id).then(url => {
      if (current) setImage({ id: project.id, modifiedAt: project.modifiedAt, url });
    }).catch(() => {
      if (current) setImage({ id: project.id, modifiedAt: project.modifiedAt, url: null });
    });
    return () => { current = false; };
  }, [active, project, recentProjects]);
  const url = !project.missing && image?.id === project.id && image.modifiedAt === project.modifiedAt ? image.url : null;
  return <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-t-xl bg-muted/40">
    {url && url !== failedUrl
      ? <img src={url} alt="" className="h-full w-full object-fill" onError={() => setFailedUrl(url)} />
      : <Box className="size-14 text-muted-foreground/50" />}
  </div>;
}

export function HomePage({ active, canOpen, canCreate, onOpen, onCreate, onOpenRecent }: HomePageProps) {
  const { recentProjects } = usePlatform();
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const next = await recentProjects.list();
      if (sequence === refreshSequence.current) { setProjects(next); setError(null); }
    } catch { if (sequence === refreshSequence.current) setError('Recent projects could not be loaded.'); }
    finally { if (sequence === refreshSequence.current) setLoading(false); }
  }, [recentProjects]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { ++refreshSequence.current; window.removeEventListener('focus', onFocus); };
  }, [active, refresh]);

  const run = async (action: () => Promise<unknown>, failure: string) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await action(); await refresh(); }
    catch { await refresh(); setError(failure); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const disabled = busy || !canOpen;
  return (
    <main data-testid="home-page" className="min-h-0 min-w-0 flex-1 overflow-auto rounded-lg bg-background p-8 text-foreground">
      <div className="mx-auto max-w-6xl space-y-10">
        <div className="flex flex-wrap gap-5" aria-label="Project actions">
          <Button data-testid="home-new-project" variant="outline" disabled={busy || !canCreate}
            className="h-28 min-w-64 flex-1 justify-start gap-5 rounded-xl px-7 text-left"
            onClick={() => void run(onCreate, 'The project could not be created.')}>
            <FilePlus2 className="size-10 text-primary" />
            <span><span className="block text-lg font-medium">New project</span><span className="block text-sm font-normal text-muted-foreground">Create a new project</span></span>
          </Button>
          <Button data-testid="home-open-project" variant="outline" disabled={disabled}
            className="h-28 min-w-64 flex-1 justify-start gap-5 rounded-xl px-7 text-left"
            onClick={() => void run(onOpen, 'The project could not be opened.')}>
            <FolderOpen className="size-10 text-primary" />
            <span><span className="block text-lg font-medium">Open project</span><span className="block text-sm font-normal text-muted-foreground">3MF</span></span>
          </Button>
        </div>
        <section aria-labelledby="recent-projects-title" aria-busy={loading || busy}>
          <div className="mb-5 flex items-center justify-between gap-4">
            <h1 id="recent-projects-title" className="text-lg font-medium">Recent projects</h1>
            {projects.length > 0 && <Button variant="outline" disabled={disabled} data-testid="home-clear-recent"
              onClick={() => void run(() => recentProjects.clear(), 'Recent projects could not be cleared.')}><Trash2 />Clear all</Button>}
          </div>
          {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
          {loading ? <p role="status" className="text-sm text-muted-foreground">Loading recent projects…</p>
            : projects.length === 0 ? <div data-testid="home-recent-empty" className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border text-muted-foreground">
              <History className="size-10 opacity-50" />
              <p className="text-sm">No recent projects</p>
            </div> : <ul data-testid="home-recent-list" className="grid grid-cols-[repeat(auto-fill,184px)] gap-5">
              {projects.map(project => <li key={project.id} className="relative h-[256px] w-[184px] rounded-xl bg-card ring-1 ring-border transition-shadow hover:ring-primary">
                <button type="button" disabled={disabled} aria-label={`Open ${project.displayName}`}
                  className="block h-full w-full rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  onClick={() => void run(() => onOpenRecent(project.id), 'This project is no longer available or could not be opened.')}>
                  <RecentProjectThumbnail project={project} active={active} />
                  <div className="h-[72px] space-y-1 p-4 pr-9">
                    <p className="truncate text-sm font-medium" title={project.displayName}>{project.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">{project.missing ? 'File is missing' : project.modifiedAt !== null ? new Date(project.modifiedAt).toLocaleString() : ''}</p>
                  </div>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="absolute right-2 bottom-7" disabled={disabled} aria-label={`Actions for ${project.displayName}`} />}><MoreHorizontal /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
                    <DropdownMenuItem disabled={disabled || project.missing} onClick={() => void run(() => recentProjects.reveal(project.id), 'The file could not be located.')}><FolderSearch />Show in folder</DropdownMenuItem>
                    <DropdownMenuItem disabled={disabled} onClick={() => void run(() => recentProjects.remove(project.id), 'The recent project could not be removed.')}><Trash2 />Remove from recent</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>)}
            </ul>}
        </section>
      </div>
    </main>
  );
}
