import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ProjectInput,
  ProjectLoadBehaviour,
  UserPreferences,
} from '@orca/platform-contract';
import { usePlatform } from '@orca/platform-contract';
import type { AccountProvider, AccountSetting } from '@orca/service-provider';
import type { DownloadDirectorySelectionId } from '@orca/printer-control/domain';
import type { DirtyProjectDecision, ProjectLoadChoice } from '@orca/slicer-runtime';
import type { ProjectNotice, ProjectOperation } from '@/stores/useProjectStore';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldContent } from '@/components/ui/field';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  RadioGroup,
  RadioGroupItem,
} from '@/components/ui/radio-group';
import {
  Progress,
} from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

function Modal({
  title,
  testId,
  children,
}: { title: string; testId: string; children: ReactNode }) {
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        data-testid={testId}
      >
        <DialogTitle id={`${testId}-title`}>{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function ProjectLoadChoiceDialog({
  open,
  input,
  onChoice,
  onCancel,
}: {
  open: boolean;
  input: ProjectInput | null;
  onChoice: (choice: Exclude<ProjectLoadChoice, 'cancel'>) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<Exclude<ProjectLoadChoice, 'cancel'>>('geometry-only');
  useEffect(() => { if (open) setChoice('geometry-only'); }, [open]);
  if (!open) return null;
  return (
    <Modal title="Open 3MF project" testId="project-load-choice-dialog">
      <p className="text-sm text-muted-foreground">Choose how to open {input?.displayName ?? 'this 3MF file'}.</p>
      <RadioGroup
        value={choice}
        onValueChange={(value) => setChoice(value as Exclude<ProjectLoadChoice, 'cancel'>)}
        aria-label="Project load choice"
        className="gap-2"
      >
        <label className="flex cursor-pointer items-start gap-2 text-sm" htmlFor="project-load-geometry">
          <RadioGroupItem value="geometry-only" id="project-load-geometry" data-testid="project-load-geometry" />
          <span><span className="font-medium">Import geometry only</span><br /><span className="text-muted-foreground">Append models without replacing project settings.</span></span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm" htmlFor="project-load-project">
          <RadioGroupItem value="project" id="project-load-project" data-testid="project-load-project" />
          <span><span className="font-medium">Open as project</span><br /><span className="text-muted-foreground">Replace the current project and restore its settings.</span></span>
        </label>
      </RadioGroup>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} data-testid="project-load-cancel">Cancel</Button>
        <Button type="button" onClick={() => onChoice(choice)} data-testid="project-load-confirm">Continue</Button>
      </div>
    </Modal>
  );
}

export function DirtyProjectDialog({
  open,
  operation,
  onDecision,
}: {
  open: boolean;
  operation: 'new' | 'open' | 'close';
  onDecision: (decision: DirtyProjectDecision) => void;
}) {
  if (!open) return null;
  const verb = operation === 'new' ? 'create a new project' : operation === 'close' ? 'close OrcaSlicerNeo' : 'open another project';
  return (
    <Modal title="Save changes?" testId="project-dirty-dialog">
      <p className="text-sm text-muted-foreground">This project has unsaved changes. Save them before you {verb}?</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onDecision('cancel')} data-testid="project-dirty-cancel">Cancel</Button>
        <Button type="button" variant="secondary" onClick={() => onDecision('dont-save')} data-testid="project-dirty-dont-save">Don&apos;t Save</Button>
        <Button type="button" onClick={() => onDecision('save')} data-testid="project-dirty-save">Save</Button>
      </div>
    </Modal>
  );
}

const LOAD_BEHAVIOUR_LABELS: Record<ProjectLoadBehaviour, string> = {
  load_all: 'Load All',
  ask_when_relevant: 'Ask When Relevant',
  always_ask: 'Always Ask',
  load_geometry_only: 'Load Geometry Only',
};

const LOAD_BEHAVIOUR_OPTIONS = (Object.keys(LOAD_BEHAVIOUR_LABELS) as ProjectLoadBehaviour[]).map((value) => ({
  value,
  label: LOAD_BEHAVIOUR_LABELS[value],
}));

type PreferencesDialogProps = {
  open: boolean;
  preferences: UserPreferences | null;
  onSave: (behaviour: ProjectLoadBehaviour, autoFlushPolicy: NonNullable<UserPreferences['autoFlushPolicy']>, keepPainting: boolean) => Promise<void> | void;
  onClose: () => void;
};

type AdditionalPreferences = {
  storage: { value: boolean; savedValue: boolean };
  directory: { label: string; selectionId: DownloadDirectorySelectionId | null } | null;
  accounts: { provider: AccountProvider; settings: (AccountSetting & { savedValue: string })[] }[];
};

export function ProjectPreferencesDialog(props: PreferencesDialogProps) {
  // Each opening owns a fresh draft. Updates published while saving cannot reset it.
  return props.open ? <PreferencesForm {...props} /> : null;
}

function PreferencesForm({ preferences, onSave, onClose }: PreferencesDialogProps) {
  const { accounts, printers: { configuration, downloads } } = usePlatform();
  const [behaviour, setBehaviour] = useState<ProjectLoadBehaviour>(preferences?.projectLoadBehaviour ?? 'ask_when_relevant');
  const [autoFlushPolicy, setAutoFlushPolicy] = useState<NonNullable<UserPreferences['autoFlushPolicy']>>(preferences?.autoFlushPolicy ?? 'all');
  const [keepPainting, setKeepPainting] = useState(preferences?.meshBooleanKeepPainting ?? false);
  const savedGeneral = useRef({ behaviour, autoFlushPolicy, keepPainting });
  const [additional, setAdditional] = useState<AdditionalPreferences | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const mounted = useRef(false);
  const hasSavedChanges = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setLoadError(false);
    setAdditional(null);
    void Promise.all([
      configuration.load(),
      downloads.capability.kind === 'supported' ? downloads.directory().then(result => {
        if (!result.ok) throw new Error('Directory unavailable');
        return { label: result.value.label, selectionId: null };
      }) : null,
      Promise.all(accounts.map(async provider => ({ provider,
        settings: (await provider.account.getSettings()).map(setting => ({ ...setting, savedValue: setting.value })),
      }))),
    ]).then(([document, directory, providerSettings]) => {
      if (active) setAdditional({ storage: { value: document.allowAbnormalStorage ?? false, savedValue: document.allowAbnormalStorage ?? false }, directory, accounts: providerSettings });
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; mounted.current = false; };
  }, [configuration, downloads, accounts, loadAttempt]);

  const busy = saving || choosing || additional === null;
  const chooseDirectory = async () => {
    if (busy) return;
    setChoosing(true); setSaveError(null);
    try {
      const result = await downloads.chooseDirectory();
      if (!mounted.current) return;
      if (!result.ok) throw new Error('Directory unavailable');
      const selection = result.value;
      if (selection.status === 'selected') setAdditional(current => current && ({ ...current, directory: { label: selection.label, selectionId: selection.id } }));
    } catch { if (mounted.current) setSaveError('The download folder could not be selected. Try again.'); }
    finally { if (mounted.current) setChoosing(false); }
  };

  const save = async () => {
    if (busy || !additional) return;
    setSaving(true); setSaveError(null);
    let failure = 'Could not save general preferences.';
    try {
      const previous = savedGeneral.current;
      if (behaviour !== previous.behaviour || autoFlushPolicy !== previous.autoFlushPolicy || keepPainting !== previous.keepPainting) {
        await onSave(behaviour, autoFlushPolicy, keepPainting);
        savedGeneral.current = { behaviour, autoFlushPolicy, keepPainting };
        hasSavedChanges.current = true;
      }
      failure = 'Could not save the storage preference.';
      if (additional.storage.value !== additional.storage.savedValue) {
        // Merge the changed field into the latest document, preserving unrelated edits.
        const document = await configuration.load();
        await configuration.save({ ...document, allowAbnormalStorage: additional.storage.value });
        setAdditional(current => current && ({ ...current, storage: { ...current.storage, savedValue: additional.storage.value } }));
        hasSavedChanges.current = true;
      }
      failure = 'Could not save the download folder.';
      if (additional.directory?.selectionId) {
        const result = await downloads.saveDirectory(additional.directory.selectionId);
        if (!result.ok) throw new Error('Directory save failed');
        setAdditional(current => current && ({ ...current, directory: current.directory && { ...current.directory, selectionId: null } }));
        hasSavedChanges.current = true;
      }
      // Account changes may sign out the current account, so apply them last.
      for (const { provider, settings } of additional.accounts) {
        failure = `Could not save ${provider.name} account settings.`;
        for (const setting of settings) {
          if (setting.value === setting.savedValue) continue;
          const result = await provider.account.setSetting(setting.key, setting.value);
          if (!result.ok) throw new Error('Account setting save failed');
          setAdditional(current => current && ({ ...current, accounts: current.accounts.map(account => account.provider === provider
            ? { ...account, settings: account.settings.map(value => value.key === setting.key ? { ...value, savedValue: setting.value } : value) } : account) }));
          hasSavedChanges.current = true;
        }
      }
      onClose();
    } catch {
      setSaveError(`${failure} ${hasSavedChanges.current ? 'Some changes were saved. Retry to save the remaining changes.' : 'Please try again.'}`);
    } finally { setSaving(false); }
  };
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent data-testid="project-preferences-dialog" className="flex h-[min(600px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogTitle id="project-preferences-dialog-title" className="shrink-0 px-5 py-4">Preferences</DialogTitle>
        <Tabs defaultValue="general" className="min-h-0 flex-1 flex-col gap-0">
          <TabsList aria-label="Preferences categories" activateOnFocus variant="line" className="h-9 w-full shrink-0 justify-start overflow-x-auto border-b px-5">
            <TabsTrigger value="general" className="h-full flex-none px-3 after:inset-x-0 after:bottom-0 after:h-0.5">General</TabsTrigger>
            <TabsTrigger value="control" className="h-full flex-none px-3 after:inset-x-0 after:bottom-0 after:h-0.5">Control</TabsTrigger>
            {accounts.length > 0 && <TabsTrigger value="online" className="h-full flex-none px-3 after:inset-x-0 after:bottom-0 after:h-0.5">Online</TabsTrigger>}
            <TabsTrigger value="developer" className="h-full flex-none px-3 after:inset-x-0 after:bottom-0 after:h-0.5">Developer</TabsTrigger>
          </TabsList>
          <TabsContent value="general" keepMounted className="min-h-0 space-y-6 overflow-y-auto p-5 hidden:hidden">
            <section aria-label="Project" className="space-y-3">
              <h3 className="font-medium">Project</h3>
              <div className="flex flex-col gap-2">
                <Label htmlFor="project-load-behaviour">Project Load Behaviour</Label>
                <Select
                  value={behaviour}
                  items={LOAD_BEHAVIOUR_OPTIONS}
                  onValueChange={(value) => setBehaviour(value as ProjectLoadBehaviour)}
                  disabled={busy}
                >
                  <SelectTrigger id="project-load-behaviour" data-testid="project-load-behaviour" aria-label="Project Load Behaviour" className="h-8 w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {LOAD_BEHAVIOUR_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </section>
            <section aria-label="Downloads" className="flex flex-col gap-2 border-t pt-3">
              <h3 className="font-medium">Downloads</h3>
              {downloads.capability.kind === 'supported' ? <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">Default download folder</span>
                  <output aria-label="Default download folder" className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={additional?.directory?.label}>
                    {additional?.directory?.label ?? (loadError ? 'Unavailable' : 'Loading…')}
                  </output>
                  <Button variant="outline" disabled={busy} onClick={() => void chooseDirectory()}>Change…</Button>
                </div>
                <p className="text-sm text-muted-foreground">Used for downloads from all printer agents.</p>
              </> : <p className="text-sm text-muted-foreground">The download location is managed by your browser.</p>}
            </section>
          </TabsContent>
          <TabsContent value="control" keepMounted className="min-h-0 space-y-6 overflow-y-auto p-5 hidden:hidden">
            <section aria-label="Behaviour" className="space-y-3">
              <h3 className="font-medium">Behaviour</h3>
              <FieldGroup><Field>
                <FieldLabel htmlFor="auto-flush-policy">Auto flush after changing…</FieldLabel>
                <Select value={autoFlushPolicy} items={[{ value: 'all', label: 'All' }, { value: 'color change', label: 'Color' }, { value: 'disabled', label: 'None' }]}
                  onValueChange={value => setAutoFlushPolicy(value as NonNullable<UserPreferences['autoFlushPolicy']>)} disabled={busy}>
                  <SelectTrigger id="auto-flush-policy" aria-label="Auto flush after changing"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup><SelectItem value="all">All</SelectItem><SelectItem value="color change">Color</SelectItem><SelectItem value="disabled">None</SelectItem></SelectGroup></SelectContent>
                </Select>
                <FieldDescription>All recalculates after colour or material changes; Color recalculates after colour changes; None preserves manual values. Adding a material initializes its new pairs in every mode.</FieldDescription>
              </Field></FieldGroup>
            </section>
          </TabsContent>
          {accounts.length > 0 && <TabsContent value="online" keepMounted className="min-h-0 space-y-6 overflow-y-auto p-5 hidden:hidden">
            {additional?.accounts.map(({ provider, settings }) => <section key={provider.id} aria-label={`${provider.name} settings`} className="space-y-3">
              <h3 className="font-medium">{provider.name}</h3>
              {settings.map(setting => <div key={setting.key} className="space-y-1">
                <Label htmlFor={`account-${provider.id}-${setting.key}`}>{setting.label}</Label>
                <Select value={setting.value} items={setting.choices} disabled={busy} onValueChange={value => {
                  if (value !== null) setAdditional(current => current && ({ ...current, accounts: current.accounts.map(account => account.provider === provider
                    ? { ...account, settings: account.settings.map(item => item.key === setting.key ? { ...item, value } : item) } : account) }));
                }}>
                  <SelectTrigger id={`account-${provider.id}-${setting.key}`} aria-label={`${provider.name} ${setting.label}`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{setting.choices.map(choice => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </div>)}
              <p className="text-xs text-muted-foreground">Saving a region change signs out the current account.</p>
            </section>)}
          </TabsContent>}
          <TabsContent value="developer" keepMounted className="min-h-0 space-y-6 overflow-y-auto p-5 hidden:hidden">
            <section aria-label="Experimental Features" className="space-y-3">
              <h3 className="font-medium">Experimental Features</h3>
              <Field orientation="horizontal">
                <Checkbox id="mesh-boolean-keep-painting" checked={keepPainting} disabled={busy}
                  onCheckedChange={checked => setKeepPainting(checked === true)} aria-describedby="mesh-boolean-keep-painting-description" />
                <FieldContent>
                  <FieldLabel htmlFor="mesh-boolean-keep-painting">Keep painting</FieldLabel>
                  <FieldDescription id="mesh-boolean-keep-painting-description">Preserve support, seam, color and fuzzy-skin painting when applying Mesh Boolean.</FieldDescription>
                </FieldContent>
              </Field>
            </section>
            <section aria-label="Storage" className="flex flex-col gap-2 border-t pt-3">
              <h3 className="font-medium">Storage</h3>
              <div className="flex items-center gap-2">
                <Checkbox id="allow-abnormal-storage" checked={additional?.storage.value ?? false} disabled={busy}
                  onCheckedChange={checked => setAdditional(current => current && ({ ...current, storage: { ...current.storage, value: checked === true } }))}
                  aria-describedby="allow-abnormal-storage-description" />
                <Label htmlFor="allow-abnormal-storage">Allow Abnormal Storage</Label>
              </div>
              <p id="allow-abnormal-storage-description" className="text-sm text-muted-foreground">Allow printing with storage marked abnormal by the printer. This can cause printing problems.</p>
            </section>
          </TabsContent>
        </Tabs>
        {additional === null && <div className="mx-5 mb-3 flex shrink-0 items-center gap-2 text-sm">
          {loadError ? <><p role="alert" className="text-destructive">Could not load preferences. Retry before saving.</p>
            <Button variant="ghost" onClick={() => setLoadAttempt(value => value + 1)}>Retry</Button></>
            : <p role="status" className="text-muted-foreground">Loading preferences…</p>}
        </div>}
        {saveError && <Alert variant="destructive" className="mx-5 mb-3 w-auto shrink-0"><AlertDescription>{saveError}</AlertDescription></Alert>}
        <div className="flex shrink-0 justify-end gap-2 border-t px-5 py-3">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving || choosing} data-testid="project-preferences-cancel">Cancel</Button>
          <Button type="button" onClick={() => void save()} disabled={busy} data-testid="project-preferences-save">{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectNoticeDialog({
  open = true,
  notices,
  onClose,
  onContinue,
  title = 'Project notice',
  testId = 'project-notice-dialog',
}: {
  notices: readonly ProjectNotice[];
  open?: boolean;
  onClose: () => void;
  onContinue?: () => void;
  title?: string;
  testId?: string;
}) {
  if (notices.length === 0 || open === false) return null;
  return (
    <Modal title={title} testId={testId}>
      <div className="flex flex-col gap-2 text-sm" role="status" aria-live="polite">
        {notices.map((notice, index) => {
          const details = notice.details as { filamentSlotChanges?: readonly { slot: number; before: string; after: string; reason: string }[] } | undefined;
          return <div key={`${notice.kind}-${index}`} data-testid={`project-notice-${notice.kind}`}>
            <p>{notice.message}</p>
            {details?.filamentSlotChanges?.length ? <ul className="ml-4 list-disc text-muted-foreground">
              {details.filamentSlotChanges.map((change) => <li key={`${change.slot}-${change.before}-${change.after}`}>Slot {change.slot}: {change.before || '(empty)'} → {change.after || '(empty)'} ({change.reason})</li>)}
            </ul> : null}
          </div>;
        })}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} data-testid={`${testId}-close`}>{onContinue ? 'Cancel' : 'Close'}</Button>
        {onContinue && <Button type="button" onClick={onContinue} data-testid={`${testId}-continue`}>Continue</Button>}
      </div>
    </Modal>
  );
}

export function ProjectProgressDialog({ operation, onCancel }: { operation: ProjectOperation; onCancel: () => void }) {
  if (!['loading', 'saving', 'model-import'].includes(operation.phase)) return null;
  const title = operation.phase === 'saving'
    ? 'Saving project'
    : operation.phase === 'model-import' ? 'Importing model(s)' : 'Opening project';
  return (
    <Modal title={title} testId="project-progress-dialog">
      <p className="text-sm text-muted-foreground" data-testid="project-progress-message" role="status" aria-live="polite">{operation.message ?? 'Working…'}</p>
      <Progress max={100} value={operation.progress} aria-label={operation.phase === 'model-import' ? 'Model import progress' : 'Project operation progress'} data-testid="project-progress" />
      {operation.cancellable && <div className="flex justify-end"><Button type="button" variant="ghost" onClick={onCancel} data-testid="project-progress-cancel">Cancel</Button></div>}
    </Modal>
  );
}
