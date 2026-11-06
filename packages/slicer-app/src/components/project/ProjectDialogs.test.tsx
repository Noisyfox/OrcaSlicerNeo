// @vitest-environment jsdom
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { unavailablePrinterDownloads } from '@orca/printer-control';
import type { PrinterConfigurationDocument } from '@orca/printer-control';
import type { DownloadDirectorySelectionId, PrinterDownloads } from '@orca/printer-control/domain';
import type { AccountProvider, ProviderId } from '@orca/service-provider';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirtyProjectDialog, ProjectLoadChoiceDialog, ProjectNoticeDialog, ProjectPreferencesDialog, ProjectProgressDialog } from './ProjectDialogs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });

describe('project dialogs', () => {
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = '';
  });

  async function renderDialog(element: ReactElement, configuration = { load: vi.fn(async (): Promise<PrinterConfigurationDocument> => ({ version: 1, printers: [] })), save: vi.fn(async (_document: PrinterConfigurationDocument): Promise<void> => undefined) }, sources: { downloads?: PrinterDownloads; accounts?: AccountProvider[] } = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const platform = { accounts: sources.accounts ?? [], printers: { configuration, downloads: sources.downloads ?? unavailablePrinterDownloads() } } as unknown as PlatformCapabilities;
    const render = (element: ReactElement) => act(async () => { root?.render(<PlatformProvider value={platform}>{element}</PlatformProvider>); });
    await render(element);
    return { container, render };
  }

  async function selectPreferencesTab(name: string) {
    const tab = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find(tab => tab.textContent === name)!;
    await act(async () => { tab.focus(); tab.click(); });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    return document.querySelector<HTMLElement>(`[id="${tab.getAttribute('aria-controls')}"]`)!;
  }

  async function clickPreferencesButton(action: 'save' | 'cancel') {
    await act(async () => document.querySelector<HTMLElement>(`[data-testid="project-preferences-${action}"]`)!.click());
  }

  async function chooseOption(selector: string, label: string) {
    await act(async () => document.querySelector<HTMLElement>(selector)!.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(item => item.textContent === label)!;
    await act(async () => {
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      option.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
  }

  async function chooseDownloadFolder() {
    await act(async () => Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Change…')!.click());
  }

  function downloadFixture(): PrinterDownloads {
    return { ...unavailablePrinterDownloads(), capability: { kind: 'supported', constraints: {} },
      directory: vi.fn(async () => ({ ok: true as const, value: { label: 'Downloads' } })),
      chooseDirectory: vi.fn(async () => ({ ok: true as const, value: { status: 'selected' as const, label: 'Shared files', id: 'directory-choice' as DownloadDirectorySelectionId } })),
      saveDirectory: vi.fn(async () => ({ ok: true as const, value: null })),
    };
  }

  function accountFixture(id = 'bambu'): AccountProvider {
    return { id: id as ProviderId, name: id === 'bambu' ? 'Bambu Lab' : 'Other', account: {
      getState: vi.fn(async () => ({ status: 'signed-out' as const, error: null })),
      onStateChanged: () => () => {}, login: vi.fn(), logout: vi.fn(),
      getSettings: vi.fn(async () => [{ key: 'region', label: 'Region', value: 'Others', choices: [{ value: 'Others', label: 'Others' }, { value: 'China', label: 'China' }] as const }]),
      setSetting: vi.fn(async () => ({ ok: true as const, value: undefined })),
    } };
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

  it('shows staged filament compatibility slot changes before acceptance', async () => {
    await renderDialog(<ProjectNoticeDialog
      title="Review project compatibility"
      testId="project-load-confirmation-dialog"
      notices={[{
        kind: 'embedded-presets',
        message: 'Embedded project presets require review.',
        details: { filamentSlotChanges: [{ slot: 2, before: 'Project PETG', after: 'Generic PLA', reason: 'native-compatibility' }] },
      }]}
      onClose={vi.fn()}
      onContinue={vi.fn()}
    />);
    expect(document.body.textContent).toContain('Slot 2: Project PETG → Generic PLA');
    expect(document.querySelector('[data-testid="project-load-confirmation-dialog-continue"]')).not.toBeNull();
  });

  it('renders the four persisted load behaviour choices in the shadcn select', async () => {
    const onSave = vi.fn();
    await renderDialog(<ProjectPreferencesDialog open preferences={{ version: 1, rememberedBedTypes: {}, projectLoadBehaviour: 'always_ask', selectedProfiles: {}, ui: { switchToDeviceAfterSend: true } }} onSave={onSave} onClose={vi.fn()} />);
    expect(document.body.textContent).toContain('Project Load Behaviour');
    expect(Array.from(document.querySelectorAll('[role="tab"]')).map(tab => tab.textContent)).toEqual(['General', 'Control', 'Developer']);
    const trigger = document.querySelector('[data-testid="project-load-behaviour"]');
    expect(trigger?.getAttribute('role')).toBe('combobox');
    expect(trigger?.textContent).toContain('Always Ask');
    await act(async () => { (trigger as HTMLElement).click(); });
    expect(document.body.textContent).toContain('Load All');
    expect(document.body.textContent).toContain('Ask When Relevant');
    expect(document.body.textContent).toContain('Always Ask');
    expect(document.body.textContent).toContain('Load Geometry Only');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(4);
    await act(async () => { (document.querySelector('[role="option"][aria-selected="true"]') as HTMLElement).click(); });
    const developer = await selectPreferencesTab('Developer');
    expect(developer.hidden).toBe(false);
    expect(trigger?.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
    const keepPainting = document.querySelector('[role="checkbox"][aria-describedby="mesh-boolean-keep-painting-description"]') as HTMLElement;
    expect(keepPainting.hasAttribute('data-checked')).toBe(false);
    await act(async () => keepPainting.click());
    await selectPreferencesTab('Control');
    await act(async () => (document.querySelector('#auto-flush-policy') as HTMLElement).click());
    const none = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(option => option.textContent === 'None')!;
    await act(async () => {
      none.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      none.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    await selectPreferencesTab('General');
    expect(trigger?.textContent).toContain('Always Ask');
    await selectPreferencesTab('Developer');
    expect(keepPainting.hasAttribute('data-checked')).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => { (document.querySelector('[data-testid="project-preferences-save"]') as HTMLElement).click(); });
    expect(onSave).toHaveBeenCalledWith('always_ask', 'disabled', true);
  });

  it('discards storage edits on Cancel and merges them into the latest configuration only on Save', async () => {
    let saved: PrinterConfigurationDocument = { version: 1, printers: [], printPreferences: { printer: { timelapse: true } }, allowAbnormalStorage: true };
    const configuration = { load: vi.fn(async () => structuredClone(saved)), save: vi.fn(async (next: PrinterConfigurationDocument) => { saved = next; }) };
    const onSave = vi.fn(), onClose = vi.fn();
    const dialog = (open = true) => <ProjectPreferencesDialog open={open} preferences={null} onSave={onSave} onClose={onClose} />;
    const f = await renderDialog(dialog(), configuration);
    await selectPreferencesTab('Developer');
    const checkbox = () => document.querySelector<HTMLElement>('section[aria-label="Storage"] [role="checkbox"]')!;
    expect(checkbox().getAttribute('aria-checked')).toBe('true');
    await act(async () => checkbox().click());
    await selectPreferencesTab('General');
    await selectPreferencesTab('Developer');
    expect(checkbox().getAttribute('aria-checked')).toBe('false');
    await clickPreferencesButton('cancel');
    expect(configuration.save).not.toHaveBeenCalled();
    expect(saved.allowAbnormalStorage).toBe(true);
    await f.render(dialog(false));
    await f.render(dialog());
    await selectPreferencesTab('Developer');
    expect(checkbox().getAttribute('aria-checked')).toBe('true');
    await act(async () => checkbox().click());
    saved.printPreferences!.printer.bedLeveling = 'off';
    await clickPreferencesButton('save');
    expect(saved).toEqual({ version: 1, printers: [], printPreferences: { printer: { timelapse: true, bedLeveling: 'off' } }, allowAbnormalStorage: false });
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('retains the storage draft after a failed Save and retries without closing or exposing private errors', async () => {
    const configuration = { load: vi.fn(async (): Promise<PrinterConfigurationDocument> => ({ version: 1, printers: [] })), save: vi.fn(async (_next: PrinterConfigurationDocument): Promise<void> => { throw new Error('private storage details'); }) };
    const onClose = vi.fn();
    await renderDialog(<ProjectPreferencesDialog open preferences={null} onSave={vi.fn()} onClose={onClose} />, configuration);
    await selectPreferencesTab('Developer');
    const checkbox = document.querySelector<HTMLElement>('section[aria-label="Storage"] [role="checkbox"]')!;
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    await act(async () => checkbox.click());
    expect(configuration.save).not.toHaveBeenCalled();
    await clickPreferencesButton('save');
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).toContain('Could not save the storage preference');
    expect(document.body.textContent).not.toContain('private storage details');
    expect(onClose).not.toHaveBeenCalled();
    configuration.save.mockResolvedValueOnce(undefined);
    await clickPreferencesButton('save');
    expect(configuration.save).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('blocks saving unread preferences and offers a load retry instead of overwriting defaults', async () => {
    const configuration = { load: vi.fn(async (): Promise<PrinterConfigurationDocument> => { throw new Error('private path'); }), save: vi.fn(async (_document: PrinterConfigurationDocument) => {}) };
    await renderDialog(<ProjectPreferencesDialog open preferences={null} onSave={vi.fn()} onClose={vi.fn()} />, configuration);
    expect(document.querySelector<HTMLButtonElement>('[data-testid="project-preferences-save"]')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Could not load preferences');
    configuration.load.mockResolvedValueOnce({ version: 1, printers: [], allowAbnormalStorage: true });
    await act(async () => Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Retry')!.click());
    expect(document.querySelector<HTMLButtonElement>('[data-testid="project-preferences-save"]')?.disabled).toBe(false);
    expect(configuration.save).not.toHaveBeenCalled();
  });

  it('stages download and account choices across tabs, discards them on Cancel, and commits them only on Save', async () => {
    const downloads = downloadFixture(), provider = accountFixture(), onSave = vi.fn(), onClose = vi.fn();
    const dialog = (open = true) => <ProjectPreferencesDialog open={open} preferences={null} onSave={onSave} onClose={onClose} />;
    const f = await renderDialog(dialog(), undefined, { downloads, accounts: [provider] });
    await chooseDownloadFolder();
    expect(document.querySelector('output')?.textContent).toBe('Shared files');
    await selectPreferencesTab('Online');
    await chooseOption('#account-bambu-region', 'China');
    expect(provider.account.setSetting).not.toHaveBeenCalled();
    expect(downloads.saveDirectory).not.toHaveBeenCalled();
    expect(provider.account.login).not.toHaveBeenCalled();
    await clickPreferencesButton('cancel');
    await f.render(dialog(false));
    await f.render(dialog());
    expect(document.querySelector('output')?.textContent).toBe('Downloads');
    await selectPreferencesTab('Online');
    expect(document.querySelector('#account-bambu-region')?.textContent).toContain('Others');
    await chooseOption('#account-bambu-region', 'China');
    await selectPreferencesTab('General');
    await chooseDownloadFolder();
    await clickPreferencesButton('save');
    expect(downloads.saveDirectory).toHaveBeenCalledExactlyOnceWith('directory-choice');
    expect(provider.account.setSetting).toHaveBeenCalledExactlyOnceWith('region', 'China');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('preserves the previous download draft after picker cancellation or failure', async () => {
    const downloads = downloadFixture();
    await renderDialog(<ProjectPreferencesDialog open preferences={null} onSave={vi.fn()} onClose={vi.fn()} />, undefined, { downloads });
    await chooseDownloadFolder();
    vi.mocked(downloads.chooseDirectory).mockResolvedValueOnce({ ok: true, value: { status: 'cancelled' } });
    await chooseDownloadFolder();
    expect(document.querySelector('output')?.textContent).toBe('Shared files');
    vi.mocked(downloads.chooseDirectory).mockRejectedValueOnce(new Error('private path'));
    await chooseDownloadFolder();
    expect(document.querySelector('output')?.textContent).toBe('Shared files');
    expect(document.body.textContent).toContain('The download folder could not be selected');
    expect(document.body.textContent).not.toContain('private path');
    expect(downloads.saveDirectory).not.toHaveBeenCalled();
  });

  it('retries only unsaved changes after a partial failure and applies account changes last', async () => {
    const downloads = downloadFixture(), first = accountFixture(), second = accountFixture('other');
    const onSave = vi.fn(), onClose = vi.fn();
    vi.mocked(downloads.saveDirectory).mockResolvedValueOnce({ ok: false, error: { code: 'storage-unavailable', message: 'Unavailable' } });
    vi.mocked(second.account.setSetting).mockResolvedValueOnce({ ok: false, error: { code: 'network', message: 'Unavailable' } });
    await renderDialog(<ProjectPreferencesDialog open preferences={null} onSave={onSave} onClose={onClose} />, undefined, { downloads, accounts: [first, second] });
    await chooseDownloadFolder();
    await selectPreferencesTab('Developer');
    await act(async () => document.querySelector<HTMLElement>('[role="checkbox"][aria-describedby="mesh-boolean-keep-painting-description"]')!.click());
    await selectPreferencesTab('Online');
    await chooseOption('#account-bambu-region', 'China');
    await chooseOption('#account-other-region', 'China');
    await clickPreferencesButton('save');
    expect(onSave).toHaveBeenCalledOnce();
    expect(first.account.setSetting).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Some changes were saved');
    await clickPreferencesButton('save');
    expect(first.account.setSetting).toHaveBeenCalledOnce();
    expect(second.account.setSetting).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await clickPreferencesButton('save');
    expect(onSave).toHaveBeenCalledOnce();
    expect(downloads.saveDirectory).toHaveBeenCalledTimes(2);
    expect(first.account.setSetting).toHaveBeenCalledOnce();
    expect(second.account.setSetting).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders cancellable progress through the shadcn progress primitive', async () => {
    const onCancel = vi.fn();
    await renderDialog(<ProjectProgressDialog operation={{ phase: 'loading', progress: 42, message: 'Opening project', cancellable: true }} onCancel={onCancel} />);
    const progress = document.querySelector('[data-testid="project-progress"]');
    expect(progress?.getAttribute('role')).toBe('progressbar');
    expect(progress?.getAttribute('aria-valuenow')).toBe('42');
    expect(document.querySelector('[data-testid="project-progress-cancel"]')).not.toBeNull();
    await act(async () => { (document.querySelector('[data-testid="project-progress-cancel"]') as HTMLElement).click(); });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([
    { phase: 'model-import' as const, title: 'Importing model(s)', message: 'Imported 1 of 2 model(s)', label: 'Model import progress' },
    { phase: 'saving' as const, title: 'Saving project', message: 'Rendering plate thumbnails', label: 'Project operation progress' },
  ])('renders $phase progress as the shared global modal without cancellation', async ({ phase, title, message, label }) => {
    await renderDialog(<ProjectProgressDialog operation={{ phase, progress: 50, message, cancellable: false }} onCancel={vi.fn()} />);
    expect(document.body.textContent).toContain(title);
    expect(document.body.textContent).toContain(message);
    expect(document.querySelector('[data-testid="project-progress-dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="project-progress"]')?.getAttribute('aria-label')).toBe(label);
    expect(document.querySelector('[data-testid="project-progress-cancel"]')).toBeNull();
  });

  it('keeps the existing project-loading title for 3MF operations', async () => {
    await renderDialog(<ProjectProgressDialog operation={{ phase: 'loading', progress: 20, message: 'Opening project', cancellable: true }} onCancel={vi.fn()} />);
    expect(document.body.textContent).toContain('Opening project');
    expect(document.body.textContent).not.toContain('Importing model(s)');
  });
});
