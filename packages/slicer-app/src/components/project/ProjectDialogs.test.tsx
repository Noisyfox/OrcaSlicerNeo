// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirtyProjectDialog, ProjectLoadChoiceDialog, ProjectNoticeDialog, ProjectPreferencesDialog, ProjectProgressDialog } from './ProjectDialogs';

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });

describe('project dialogs', () => {
  let root: Root | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    document.body.innerHTML = '';
  });

  async function renderDialog(element: ReactElement) {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(element); });
    return container;
  }

  it('defaults load choice to geometry-only and exposes the replacement option', async () => {
    const onChoice = vi.fn();
    await renderDialog(<ProjectLoadChoiceDialog open input={{ displayName: 'sample.3mf', bytes: new Uint8Array() }} onChoice={onChoice} onCancel={vi.fn()} />);
    expect(document.body.textContent).toContain('Import geometry only');
    expect(document.body.textContent).toContain('Open as project');
    expect(document.querySelector('[data-testid="project-load-geometry"]')?.hasAttribute('data-checked')).toBe(true);
    expect(document.querySelectorAll('[data-slot="radio-group-item"]')).toHaveLength(2);
    await act(async () => { (document.querySelector('[data-testid="project-load-project"]') as HTMLElement).click(); });
    expect(document.querySelector('[data-testid="project-load-project"]')?.hasAttribute('data-checked')).toBe(true);
    await act(async () => { (document.querySelector('[data-testid="project-load-confirm"]') as HTMLElement).click(); });
    expect(onChoice).toHaveBeenCalledWith('project');
  });

  it('offers the Orca three-way dirty-session decision', async () => {
    await renderDialog(<DirtyProjectDialog open operation="open" onDecision={vi.fn()} />);
    expect(document.body.textContent).toContain('Save changes?');
    expect(document.body.textContent).toContain("Don't Save");
    expect(document.body.textContent).toContain('Cancel');
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBe('project-dirty-dialog-title');
  });

  it('renders compatibility and flatten warnings without exposing host paths', async () => {
    await renderDialog(<ProjectNoticeDialog notices={[{ kind: 'multi-plate', message: 'This project will be flattened.' }]} onClose={vi.fn()} />);
    expect(document.body.textContent).toContain('This project will be flattened.');
    expect(document.body.textContent).not.toContain('C:\\');
  });

  it('renders the four persisted load behaviour choices in the shadcn select', async () => {
    await renderDialog(<ProjectPreferencesDialog open preferences={{ version: 1, projectLoadBehaviour: 'always_ask', selectedProfiles: {}, ui: {} }} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(document.body.textContent).toContain('Project Load Behaviour');
    const trigger = document.querySelector('[data-testid="project-load-behaviour"]');
    expect(trigger?.getAttribute('role')).toBe('combobox');
    await act(async () => { (trigger as HTMLElement).click(); });
    expect(document.body.textContent).toContain('Load All');
    expect(document.body.textContent).toContain('Ask When Relevant');
    expect(document.body.textContent).toContain('Always Ask');
    expect(document.body.textContent).toContain('Load Geometry Only');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(4);
  });

  it('renders cancellable progress through the shadcn progress primitive', async () => {
    const onCancel = vi.fn();
    await renderDialog(<ProjectProgressDialog operation={{ phase: 'saving', progress: 42, message: 'Saving…', cancellable: true }} onCancel={onCancel} />);
    const progress = document.querySelector('[data-testid="project-progress"]');
    expect(progress?.getAttribute('role')).toBe('progressbar');
    expect(progress?.getAttribute('aria-valuenow')).toBe('42');
    expect(document.querySelector('[data-testid="project-progress-cancel"]')).not.toBeNull();
    await act(async () => { (document.querySelector('[data-testid="project-progress-cancel"]') as HTMLElement).click(); });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
