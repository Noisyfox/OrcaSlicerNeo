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
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
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
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-load-behaviour">Project Load Behaviour</Label>
        <Select
          value={behaviour}
          items={LOAD_BEHAVIOUR_OPTIONS}
          onValueChange={(value) => setBehaviour(value as ProjectLoadBehaviour)}
          disabled={saving}
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
