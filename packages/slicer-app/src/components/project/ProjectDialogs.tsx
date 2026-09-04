import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ProjectInput,
  ProjectLoadBehaviour,
  UserPreferences,
} from '@orca/platform-contract';
import type { DirtyProjectDecision, ProjectLoadChoice } from '@orca/slicer-runtime';
import type { ProjectNotice, ProjectOperation } from '../../stores/useProjectStore';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

function Modal({
  title,
  testId,
  children,
}: { title: string; testId: string; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`} data-testid={testId}>
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border bg-card p-5 shadow-lg">
        <h2 id={`${testId}-title`} className="font-semibold">{title}</h2>
        {children}
      </div>
    </div>
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
      <div className="space-y-2">
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="radio" name="project-load-choice" value="geometry-only" checked={choice === 'geometry-only'} onChange={() => setChoice('geometry-only')} data-testid="project-load-geometry" />
          <span><span className="font-medium">Import geometry only</span><br /><span className="text-muted-foreground">Append models without replacing project settings.</span></span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="radio" name="project-load-choice" value="project" checked={choice === 'project'} onChange={() => setChoice('project')} data-testid="project-load-project" />
          <span><span className="font-medium">Open as project</span><br /><span className="text-muted-foreground">Replace the current project and restore its settings.</span></span>
        </label>
      </div>
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
  operation: 'new' | 'open';
  onDecision: (decision: DirtyProjectDecision) => void;
}) {
  if (!open) return null;
  const verb = operation === 'new' ? 'create a new project' : 'open another project';
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

export function ProjectPreferencesDialog({
  open,
  preferences,
  onSave,
  onClose,
}: {
  open: boolean;
  preferences: UserPreferences | null;
  onSave: (behaviour: ProjectLoadBehaviour) => Promise<void> | void;
  onClose: () => void;
}) {
  const [behaviour, setBehaviour] = useState<ProjectLoadBehaviour>('ask_when_relevant');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setBehaviour(preferences?.projectLoadBehaviour ?? 'ask_when_relevant');
  }, [open, preferences]);
  if (!open) return null;
  const save = async () => {
    setSaving(true);
    try { await onSave(behaviour); onClose(); } finally { setSaving(false); }
  };
  return (
    <Modal title="Preferences" testId="project-preferences-dialog">
      <div className="space-y-2">
        <Label htmlFor="project-load-behaviour">Project Load Behaviour</Label>
        <select id="project-load-behaviour" data-testid="project-load-behaviour" aria-label="Project Load Behaviour" value={behaviour} onChange={(event) => setBehaviour(event.target.value as ProjectLoadBehaviour)} disabled={saving} className="h-8 w-full rounded-md border bg-input/20 px-2 text-sm">
          {(Object.keys(LOAD_BEHAVIOUR_LABELS) as ProjectLoadBehaviour[]).map((value) => <option key={value} value={value}>{LOAD_BEHAVIOUR_LABELS[value]}</option>)}
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving} data-testid="project-preferences-cancel">Cancel</Button>
        <Button type="button" onClick={() => void save()} disabled={saving} data-testid="project-preferences-save">{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </Modal>
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
      <div className="space-y-2 text-sm" role="status" aria-live="polite">
        {notices.map((notice, index) => <p key={`${notice.kind}-${index}`} data-testid={`project-notice-${notice.kind}`}>{notice.message}</p>)}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} data-testid={`${testId}-close`}>{onContinue ? 'Cancel' : 'Close'}</Button>
        {onContinue && <Button type="button" onClick={onContinue} data-testid={`${testId}-continue`}>Continue</Button>}
      </div>
    </Modal>
  );
}

export function ProjectProgressDialog({ operation, onCancel }: { operation: ProjectOperation; onCancel: () => void }) {
  if (!['loading', 'saving'].includes(operation.phase)) return null;
  return (
    <Modal title={operation.phase === 'saving' ? 'Saving project' : 'Opening project'} testId="project-progress-dialog">
      <p className="text-sm text-muted-foreground" data-testid="project-progress-message">{operation.message ?? 'Working…'}</p>
      <progress className="w-full" max={100} value={operation.progress} aria-label="Project operation progress" data-testid="project-progress" />
      {operation.cancellable && <div className="flex justify-end"><Button type="button" variant="ghost" onClick={onCancel} data-testid="project-progress-cancel">Cancel</Button></div>}
    </Modal>
  );
}
