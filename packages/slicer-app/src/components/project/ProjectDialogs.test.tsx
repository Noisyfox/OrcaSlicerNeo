import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DirtyProjectDialog, ProjectLoadChoiceDialog, ProjectNoticeDialog, ProjectPreferencesDialog } from './ProjectDialogs';

describe('project dialogs', () => {
  it('defaults load choice to geometry-only and exposes the replacement option', () => {
    const html = renderToStaticMarkup(<ProjectLoadChoiceDialog open input={{ displayName: 'sample.3mf', bytes: new Uint8Array() }} onChoice={vi.fn()} onCancel={vi.fn()} />);
    expect(html).toContain('Import geometry only');
    expect(html).toContain('Open as project');
    expect(html).toContain('checked="" value="geometry-only"');
  });

  it('offers the Orca three-way dirty-session decision', () => {
    const html = renderToStaticMarkup(<DirtyProjectDialog open operation="open" onDecision={vi.fn()} />);
    expect(html).toContain('Save changes?');
    expect(html).toContain('Don&#x27;t Save');
    expect(html).toContain('Cancel');
  });

  it('renders compatibility and flatten warnings without exposing host paths', () => {
    const html = renderToStaticMarkup(<ProjectNoticeDialog notices={[{ kind: 'multi-plate', message: 'This project will be flattened.' }]} onClose={vi.fn()} />);
    expect(html).toContain('This project will be flattened.');
    expect(html).not.toContain('C:\\');
  });

  it('renders the four persisted load behaviour choices', () => {
    const html = renderToStaticMarkup(<ProjectPreferencesDialog open preferences={{ version: 1, projectLoadBehaviour: 'always_ask', selectedProfiles: {}, ui: {} }} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain('Project Load Behaviour');
    expect(html).toContain('Load All');
    expect(html).toContain('Ask When Relevant');
    expect(html).toContain('Always Ask');
    expect(html).toContain('Load Geometry Only');
  });
});
