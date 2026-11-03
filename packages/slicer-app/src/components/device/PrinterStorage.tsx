import { StorageThumbnail } from './StorageThumbnail';
import { RemoteFilePrintDialog } from './RemoteFilePrintDialog';
import { StoredVideoDialog } from './StoredVideoDialog';
import { PrinterDiscovery } from './PrinterDiscovery';
import { DeleteStorageFiles } from './DeleteStorageFiles';
import { PrinterDownloadTasks } from './PrinterDownloadTasks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { File, Film, RefreshCw } from 'lucide-react';
import { usePlatform } from '@orca/platform-contract';
import type { PrinterRoute, PrinterStorage as Storage, RemoteFile, SavedPrinter, StorageCollection } from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const bytes = (value: number | null) => value === null ? 'Size unknown' : value < 1024 ? `${value} B`
  : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;

/** Shared collection browser. All storage/category meanings come from the agent. */
export function PrinterStorage({ printer, route }: { printer: SavedPrinter; route: PrinterRoute }) {
  const { service, downloads } = usePlatform().printers;
  const [queuing, setQueuing] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<readonly RemoteFile[] | null>(null);
  const [printing, setPrinting] = useState<RemoteFile | null>(null);
  const [playing, setPlaying] = useState<RemoteFile | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<ReadonlySet<string>>(new Set());
  const target = useMemo(() => ({ printerId: printer.identity.id, routeId: route.id }), [printer.identity.id, route.id]);
  const [storages, setStorages] = useState<readonly Storage[]>([]);
  const [storageId, setStorageId] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [files, setFiles] = useState<readonly RemoteFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useState<'none' | 'year' | 'month'>('none');
  const [error, setError] = useState<string | null>(null);
  const [needsAuthorization, setNeedsAuthorization] = useState(false);
  const [discovering, setDiscovering] = useState(true);
  const [loading, setLoading] = useState(false);
  const discovery = useRef<AbortController | null>(null), listing = useRef<AbortController | null>(null);
  const [discoveryRevision, setDiscoveryRevision] = useState(0);
  const collectionsOf = (storage: Storage): readonly StorageCollection[] => storage.browsing.kind === 'supported' && storage.browsing.constraints.kind === 'collections'
    ? storage.browsing.constraints.collections : [];
  const categories = [...new Map(storages.flatMap(collectionsOf).map(item => [item.id, item])).values()];
  const categoryId = categories.some(item => item.id === collectionId) ? collectionId : categories[0]?.id;
  const availableStorages = storages.filter(storage => collectionsOf(storage).some(item => item.id === categoryId));
  const storage = availableStorages.find(storage => storage.id === storageId) ?? availableStorages[0] ?? storages[0];
  const category = storage && collectionsOf(storage).find(item => item.id === categoryId);
  const scope = `${storage?.id ?? ''}:${category?.id ?? ''}`;
  useEffect(() => { setStorageId(storage?.id ?? ''); }, [storage?.id]);
  const filtered = useMemo(() => files.filter(file => file.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [files, search]);
  const groups = useMemo(() => {
    const result = new Map<string, RemoteFile[]>();
    for (const file of filtered) {
      const date = file.modifiedAtMs ?? file.createdAtMs;
      const key = groupBy === 'none' ? '' : date === null ? 'Date unknown' : new Date(date).toISOString().slice(0, groupBy === 'year' ? 4 : 7);
      const group = result.get(key) ?? []; group.push(file); result.set(key, group);
    }
    return [...result];
  }, [filtered, groupBy]);

  const discover = async (refresh = false) => {
    discovery.current?.abort(); listing.current?.abort();
    const controller = new AbortController(); discovery.current = controller;
    setDiscovering(true); setLoading(false); setError(null); setNeedsAuthorization(false);
    if (!refresh) { setFiles([]); setCursor(null); setSelected(new Set()); }
    try {
      const result = await service.files.listStorages(target, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result.ok) { setError(result.error.message); setNeedsAuthorization(['authentication-required', 'permission-denied'].includes(result.error.code)); setStorages([]); return; }
      setStorages(result.value);
      const first = result.value.find(storage => storage.availability.kind === 'available' && storage.browsing.kind === 'supported') ?? result.value[0];
      setStorageId(previous => refresh && result.value.some(storage => storage.id === previous) ? previous : first?.id ?? '');
      setDiscoveryRevision(value => value + 1);
    } catch { if (!controller.signal.aborted) setError('Printer storage could not be loaded.'); }
    finally { if (!controller.signal.aborted) setDiscovering(false); }
  };
  const load = async (next: string | null = null) => {
    if (!storage || !category || storage.availability.kind !== 'available') return;
    listing.current?.abort(); const controller = new AbortController(); listing.current = controller;
    setLoading(true); setError(null); setNeedsAuthorization(false);
    try {
      const result = await service.files.list({ target, storageId: storage.id, location: { kind: 'collection', collectionId: category.id },
        pageSize: 100, ...(next ? { cursor: next } : {}) }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result.ok) { setError(result.error.message); setNeedsAuthorization(['authentication-required', 'permission-denied'].includes(result.error.code)); return; }
      const page = result.value.files;
      if (!next) setUnconfirmed(new Set());
      setFiles(previous => next ? [...new Map([...previous, ...page].map(file => [file.ref.fileId, file])).values()] : page);
      setCursor(result.value.nextCursor);
      if (!next) setSelected(previous => new Set([...previous].filter(id => page.some(file => file.ref.fileId === id))));
    } catch { if (!controller.signal.aborted) setError('Files could not be loaded.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    void discover();
    return () => { discovery.current?.abort(); listing.current?.abort(); };
  }, [service, target, route.configurationRevision]);
  useEffect(() => {
    setFiles([]); setCursor(null); setSelected(new Set()); setSearch(''); setUnconfirmed(new Set()); setDeleting(null); setPrinting(null); setPlaying(null);
  }, [scope, service, target]);
  useEffect(() => { void load(); return () => listing.current?.abort(); }, [scope, service, target, discoveryRevision]);

  const download = async (destination: 'default' | 'choose') => {
    setQueuing(true); setDownloadError(null);
    try {
      const result = await downloads.start({ destination, files: files.filter(file => selected.has(file.ref.fileId)).map(file => ({ file: file.ref, name: file.name, printerName: printer.identity.displayName })) });
      if (!result.ok) setDownloadError(result.error.message);
    } catch { setDownloadError('The download could not be queued.'); }
    finally { setQueuing(false); }
  };
  const allLoadedSelected = filtered.length > 0 && filtered.every(file => selected.has(file.ref.fileId));
  const toggle = (id: string) => setSelected(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  return <section className="flex h-full flex-col gap-3 p-4" aria-label="Printer storage" data-testid="printer-storage">
    <header className="flex flex-wrap items-center gap-3">
      <h2 className="mr-auto font-semibold">Storage</h2>
      <div className="flex items-center gap-2 text-xs text-muted-foreground" hidden={availableStorages.length < 2}>
        <span>Storage</span>
        <Select value={storage?.id ?? ''} onValueChange={value => { if (value !== null) setStorageId(value); }}
          items={availableStorages.map(storage => ({ value: storage.id, label: storage.name }))} disabled={discovering || !storages.length}>
          <SelectTrigger aria-label="Storage" className="min-w-36"><SelectValue /></SelectTrigger>
          <SelectContent>{availableStorages.map(storage => <SelectItem key={storage.id} value={storage.id}>{storage.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Button variant="outline" size="sm" disabled={discovering || loading} onClick={() => void discover(true)}><RefreshCw className="size-4" />Refresh</Button>
    </header>
    {!!categories.length && <Tabs value={category?.id ?? ''} onValueChange={value => setCollectionId(String(value))}>
      <TabsList variant="segmented" aria-label="File collections">
        {categories.map(item => <TabsTrigger key={item.id} value={item.id}>{item.name}</TabsTrigger>)}
      </TabsList>
    </Tabs>}
    {error && <div role="alert" className="rounded border border-destructive/40 p-3 text-sm text-destructive">{error}
      <Button variant="ghost" size="sm" className="ml-2" disabled={loading || discovering} onClick={() => void discover(true)}>Retry</Button>
    </div>}
    {needsAuthorization && <PrinterDiscovery saved={[printer]} target={printer} onAuthorized={() => void discover()} />}
    {discovering ? <p role="status" className="text-sm text-muted-foreground">Loading available storage…</p>
      : !storages.length && !error ? <p className="text-sm text-muted-foreground">The printer reports no available storage.</p>
      : storage?.availability.kind === 'blocked' ? <p role="status">{storage.availability.reasons.map(reason => reason.message).join(' ')}</p>
      : storage?.availability.kind === 'unknown' ? <p role="status">{storage.availability.reason}</p>
      : storage?.browsing.kind === 'unsupported' || storage?.browsing.kind === 'unknown' ? <p role="status">{storage.browsing.reason}</p>
      : storage?.browsing.kind === 'supported' && storage.browsing.constraints.kind === 'directories' ? <p role="status">Directory browsing is not available in this view.</p> : null}
    {downloadError && <p role="alert" className="text-sm text-destructive">{downloadError}</p>}
    {category && <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-40 max-w-xs flex-1"><SearchInput aria-label="Filter loaded files" placeholder="Filter loaded files…" value={search} onValueChange={setSearch} /></div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Group</span>
          <Select value={groupBy} onValueChange={value => { if (value !== null) setGroupBy(value); }}
            items={[{ value: 'none', label: 'None' }, { value: 'year', label: 'Year' }, { value: 'month', label: 'Month' }]}>
            <SelectTrigger aria-label="Group files" className="min-w-24"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="none">None</SelectItem><SelectItem value="year">Year</SelectItem><SelectItem value="month">Month</SelectItem></SelectContent>
          </Select>
        </div>
        <Button size="sm" variant="ghost" disabled={!filtered.length} onClick={() => setSelected(previous => {
          const next = new Set(previous); for (const file of filtered) { if (allLoadedSelected) next.delete(file.ref.fileId); else next.add(file.ref.fileId); } return next;
        })}>{allLoadedSelected ? 'Deselect loaded results' : 'Select loaded results'}</Button>
        <span role="status" className="text-xs text-muted-foreground">{selected.size} selected · {filtered.length} matching of {files.length} loaded</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {category.actions.includes('download') && downloads.capability.kind === 'supported' && <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!selected.size || queuing || loading} onClick={() => void download('default')}>Download selected</Button>
          <Button size="sm" variant="outline" disabled={!selected.size || queuing || loading} onClick={() => void download('choose')}>Save as…</Button>
        </div>}
        {category.actions.includes('delete') && <Button size="sm" variant="destructive" disabled={!selected.size || loading || queuing}
          onClick={() => setDeleting(files.filter(file => selected.has(file.ref.fileId)))}>Delete selected</Button>}
        {category.actions.includes('inspect-print') && <Button size="sm" variant="outline" disabled={selected.size !== 1 || loading}
          onClick={() => setPrinting(files.find(file => selected.has(file.ref.fileId)) ?? null)}>Print selected file</Button>}
        {category.actions.includes('preview') && <Button size="sm" variant="outline" disabled={selected.size !== 1 || loading}
          onClick={() => setPlaying(files.find(file => selected.has(file.ref.fileId)) ?? null)}>Play selected video</Button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {groups.map(([label, items]) => <div key={label} className="mb-4">
          {label && <h3 className="mb-2 text-sm font-medium">{label}</h3>}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {items.map(file => <div onClick={() => toggle(file.ref.fileId)} key={file.ref.fileId} className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-3 ${selected.has(file.ref.fileId) ? 'border-primary bg-accent/20' : 'hover:bg-muted/40'}`}>
              <div className="flex items-start justify-between"><Checkbox onClick={event => event.stopPropagation()} aria-label={`Select ${file.name}`} checked={selected.has(file.ref.fileId)} onCheckedChange={() => toggle(file.ref.fileId)} />
              </div>
              <StorageThumbnail file={file} fallback={file.metadata.kind === 'recording' || file.metadata.kind === 'timelapse' ? <Film className="size-10 text-muted-foreground" /> : <File className="size-10 text-muted-foreground" />} />
              <span className="break-all text-sm font-medium">{file.name}</span>
              {unconfirmed.has(file.ref.fileId) && <span className="text-xs text-amber-500">Deletion unconfirmed · Refresh manually</span>}
              <span className="text-xs text-muted-foreground">{bytes(file.sizeBytes)}{file.modifiedAtMs !== null && ` · ${new Date(file.modifiedAtMs).toLocaleDateString()}`}</span>
            </div>)}
          </div>
        </div>)}
        {!loading && !error && !filtered.length && <p className="py-10 text-center text-sm text-muted-foreground">{files.length ? 'No loaded files match this filter.' : 'This collection is empty.'}</p>}
        {loading && <p role="status" className="py-3 text-center text-sm text-muted-foreground">Loading files…</p>}
        {cursor && <Button variant="outline" className="mx-auto flex" disabled={loading} onClick={() => void load(cursor)}>Load more files</Button>}
      </div>
    </>}
    {deleting && <DeleteStorageFiles files={deleting} printerName={printer.identity.displayName} storageName={storage?.name ?? 'Storage'} onClose={() => setDeleting(null)}
      onOutcome={(ref, result) => {
        if (result.state === 'deleted') {
          listing.current?.abort(); setLoading(false); setFiles(previous => previous.filter(file => file.ref.fileId !== ref.fileId)); setCursor(null);
          setSelected(previous => new Set([...previous].filter(id => id !== ref.fileId)));
        } else if (result.state === 'unconfirmed') setUnconfirmed(previous => new Set([...previous, ref.fileId]));
      }} />}
    {playing && <StoredVideoDialog file={playing} printerName={printer.identity.displayName} onClose={() => setPlaying(null)} />}
    {printing && <RemoteFilePrintDialog file={printing} printer={printer} onClose={() => setPrinting(null)} />}
    <PrinterDownloadTasks />
  </section>;
}
