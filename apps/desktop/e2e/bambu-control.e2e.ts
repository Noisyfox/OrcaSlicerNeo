import { _electron, desktopLaunchOptions } from './electron-fixture';
import { isBambuControlRequest } from '../src/shared/bambuControl';
import { expect, test } from '@playwright/test';
import { installControlFixture, publishControlSnapshot } from './bambu-control-fixture';
import { Ipc } from '../src/shared/ipc';
import type * as D from '@orca/printer-control/domain';
test('Bambu control cards retain selection, bind edits and cancellation, and disable stale controls', async () => {
  const app = await _electron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1' } });
  try {
    const page = await app.firstWindow();
    // Hosted desktop work areas may clamp the native window below the layout breakpoint.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await installControlFixture(app);
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Workshop A', exact: true }).click();
    const panel = page.locator('#device-content');
    await expect(panel.getByText('External task', { exact: true })).toBeVisible();
    const validateRequests = async () => {
      const requests = await app.evaluate(() => globalThis.bambuControlFixture.requests);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) expect(isBambuControlRequest(request), JSON.stringify(request)).toBe(true);
    };
    await validateRequests();
    await panel.getByText('Fans · 4', { exact: true }).click();
    const lighting = panel.getByRole('heading', { name: 'Fans and lighting', exact: true }).locator('..');
    const lightsSummary = lighting.locator('summary').filter({ hasText: /^Lights ·/ });
    await expect(lighting.getByRole('checkbox').first()).toBeHidden();
    await lightsSummary.click();
    await expect(lighting.getByRole('checkbox').first()).toBeVisible();
    await expect(lighting.getByRole('combobox', { name: 'Parts speed', exact: true })).toBeVisible();
    await lightsSummary.click();
    for (const name of ['Parts', 'Aux', 'Exhaust', 'Heat']) {
      await expect(panel.getByRole('combobox', { name: `${name} speed`, exact: true })).toBeVisible();
    }
    await expect(panel.getByRole('combobox', { name: 'Heat speed', exact: true })).toHaveValue('0');
    await expect(panel.getByRole('combobox', { name: 'Fan 6 speed', exact: true })).toHaveCount(0);
    await panel.getByText('Fans · 4', { exact: true }).click();
    await expect(panel.getByText('AMS 2 Pro 128', { exact: true })).toBeVisible();
    await expect(panel.getByText('Bambu Cloud', { exact: true })).toHaveCount(0);
    for (const [unit, tool] of [[255, 0], [254, 1]]) {
      const toolName = tool === 0 ? 'Right extruder' : 'Left extruder';
      const otherToolName = tool === 0 ? 'Left extruder' : 'Right extruder';
      const holder = panel.getByRole('heading', { name: `External holder ${unit}`, exact: true }).locator('..');
      await expect(holder.getByRole('button', { name: `Load to ${toolName}`, exact: true })).toBeVisible();
      await expect(holder.getByText('No available tool path reported.', { exact: true })).toHaveCount(0);
      await expect(holder.getByRole('button', { name: `Load to ${otherToolName}`, exact: true })).toHaveCount(0);
      await holder.getByText('Details', { exact: true }).click();
      await expect(holder.getByText('Remaining: Not reported', { exact: true })).toBeVisible();
      await holder.getByText('Details', { exact: true }).click();
    }
    await expect(panel.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
    const printActions = panel.locator('.printer-print-progress-row');
    const pauseControl = printActions.getByRole('button', { name: 'Pause', exact: true });
    const cancelControl = printActions.getByRole('button', { name: 'Cancel print', exact: true });
    await expect(printActions.getByRole('button')).toHaveCount(2);
    await expect(pauseControl).toHaveText('');
    await expect(cancelControl).toHaveText('');
    const barBounds = await printActions.getByRole('progressbar').boundingBox();
    const pauseBounds = await pauseControl.boundingBox();
    const cancelBounds = await cancelControl.boundingBox();
    expect(barBounds).not.toBeNull(); expect(pauseBounds).not.toBeNull(); expect(cancelBounds).not.toBeNull();
    expect(barBounds!.width).toBeGreaterThan(0);
    expect(pauseBounds!.x).toBeGreaterThanOrEqual(barBounds!.x + barBounds!.width);
    expect(cancelBounds!.x).toBeGreaterThanOrEqual(pauseBounds!.x + pauseBounds!.width);
    expect(Math.abs(barBounds!.y + barBounds!.height / 2 - pauseBounds!.y - pauseBounds!.height / 2)).toBeLessThan(1);
    const commands = () => app.evaluate(() => globalThis.bambuControlFixture.commands);
    const tokens = () => app.evaluate(() => globalThis.bambuControlFixture.tokens);
    await expect.poll(tokens).toHaveLength(1); const originalTokens = await tokens();
    await expect(panel.getByRole('spinbutton', { name: 'Left nozzle target', exact: true })).toBeVisible();
    const temperature = panel.getByRole('spinbutton', { name: 'Right nozzle target', exact: true });
    const leftBounds = await panel.getByRole('spinbutton', { name: 'Left nozzle target', exact: true }).boundingBox();
    const rightBounds = await temperature.boundingBox();
    expect(leftBounds!.y).toBeLessThan(rightBounds!.y);
    const leftToolBounds = await panel.getByRole('button', { name: 'Select Left extruder', exact: true }).boundingBox();
    const rightToolBounds = await panel.getByRole('button', { name: 'Select Right extruder', exact: true }).boundingBox();
    expect(leftToolBounds!.y).toBeLessThan(rightToolBounds!.y);
    await temperature.fill('235'); await temperature.press('Enter');
    await expect.poll(commands).toHaveLength(1);
    expect((await commands())[0]).toMatchObject({ target: { printerId: 'bambu:a' }, command: { type: 'thermal.setTarget', params: { heaterId: 'nozzle:0', targetC: 235 } } });
    await panel.getByRole('button', { name: 'Cancel print', exact: true }).click();
    await publishControlSnapshot(app, 'a', 'Replacement task');
    await expect(panel.getByText('Replacement task', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
    expect(await commands()).toHaveLength(1);
    await expect(panel.getByText('The active task changed. Review it before cancelling.')).toBeVisible();
    await page.locator('#app-tab-home').click();
    await publishControlSnapshot(app, 'a', 'Hidden task');
    expect(await tokens()).toEqual(originalTokens);
    await page.getByTestId('tab-device').click();
    await expect(panel.getByText('Hidden task', { exact: true })).toBeVisible();
    await publishControlSnapshot(app, 'a', 'Hidden task', false);
    await expect(panel.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
    await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Workshop B', exact: true }).click();
    await expect(panel.getByText('Second task', { exact: true })).toBeVisible();
    await expect.poll(tokens).toHaveLength(1); expect(await tokens()).not.toEqual(originalTokens);
    await panel.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(commands).toHaveLength(2);
    expect((await commands())[1]).toMatchObject({ target: { printerId: 'bambu:b' }, command: { type: 'jobs.pause' } });
    await expect(panel.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
    await expect(page.getByRole('option', { name: 'Workshop B', exact: true })).toBeHidden();
    await expect(panel.locator('label').filter({ has: page.getByRole('combobox', { name: 'Print speed', exact: true }) })).toContainText('Print speed');
    const lightingBounds = await panel.getByRole('heading', { name: 'Fans and lighting', exact: true }).locator('..').boundingBox();
    const speedBounds = await panel.getByRole('combobox', { name: 'Print speed', exact: true }).boundingBox();
    expect(lightingBounds).not.toBeNull(); expect(speedBounds).not.toBeNull();
    expect(speedBounds!.y).toBeGreaterThanOrEqual(lightingBounds!.y + lightingBounds!.height);
    await expect(panel.getByRole('progressbar', { name: 'Print progress' })).toHaveAttribute('aria-valuenow', '42');
    const moveRight = panel.getByRole('button', { name: 'Move X positive', exact: true });
    const pad = await moveRight.boundingBox();
    await moveRight.click({ position: { x: pad!.width * 0.85, y: pad!.height / 2 } });
    await expect.poll(commands).toHaveLength(3);
    expect((await commands())[2]).toMatchObject({ target: { printerId: 'bambu:b' }, command: { type: 'motion.jog', params: { axis: 'x', direction: 'positive', stepId: 'small' } } });
    await expect(moveRight).toBeEnabled();
    await expect(panel.getByText('Printer accepted the command.', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('Printer acknowledged the command. Waiting for completion.', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
    const previewBounds = await panel.getByLabel('Print preview', { exact: true }).boundingBox();
    const progressBounds = await panel.getByRole('progressbar', { name: 'Print progress' }).boundingBox();
    expect(previewBounds!.x + previewBounds!.width).toBeLessThan(progressBounds!.x);
    expect(progressBounds!.y).toBeGreaterThanOrEqual(previewBounds!.y);
    expect(progressBounds!.y).toBeLessThan(previewBounds!.y + previewBounds!.height);
    const controlBounds = await panel.getByRole('heading', { name: 'Control', exact: true }).boundingBox();
    expect(controlBounds!.x).toBeGreaterThan(previewBounds!.x + previewBounds!.width);
    await page.screenshot({ path: '/tmp/orca-bambu-control.png' });
    await page.setViewportSize({ width: 820, height: 900 });
    await expect.poll(() => panel.getByTestId('device-monitor').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/orca-bambu-control-narrow.png' });
    await validateRequests();
  } finally { await app.close(); }
});

test('Bambu error dialogs invoke opaque actions, stay dismissed across refreshes and respect visibility and stale state', async () => {
  const app = await _electron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1' } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    await installControlFixture(app);
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Workshop A', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
    const publish = async (episode: string, fresh = true) => app.evaluate(({ BrowserWindow }, { channel, episode, fresh }) => {
      const data = globalThis.bambuControlFixture.data['bambu:a'];
      const ref = { ...data.snapshot.target, configurationRevision: data.description.configurationRevision };
      const action = (label: string): D.PrinterAction => ({ actionRef: { ...ref, token: `${episode}:${label}` as D.Id<'action-context'> }, label, description: null, expiresAtMs: null, availability: { kind: 'available' } });
      data.snapshot.values.alerts = { kind: 'known', freshness: fresh ? 'fresh' : 'stale', observedAtMs: null, receivedAtMs: Date.now(), sourceRouteId: ref.routeId, value: [{
        id: episode as D.Id<'alert'>, severity: 'warning', code: '0500808F', message: 'Nozzle camera lens is dirty.',
        actions: [action('Problem Solved and Resume'), action('Ignore this and Resume')],
        dialog: { title: 'Warning', dismissible: true, dismissAction: action('Close') },
      }] };
      if (data.snapshot.values.status?.kind === 'known') data.snapshot.values.status.freshness = fresh ? 'fresh' : 'stale';
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, 'control');
    }, { channel: Ipc.bambuChanged, episode, fresh });
    const dialog = page.getByRole('dialog', { name: 'Workshop A: Warning' });
    await publish('episode-1');
    await expect(dialog).toContainText('Nozzle camera lens is dirty.');
    await dialog.getByRole('button', { name: 'Ignore this and Resume', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => app.evaluate(() => globalThis.bambuControlFixture.commands.at(-1)?.command)).toMatchObject({ type: 'actions.invoke', params: { actionRef: { token: 'episode-1:Ignore this and Resume' } } });
    await expect(page.getByRole('button', { name: 'View error details' })).toBeEnabled();
    await publish('episode-1'); await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'View error details' }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.bambuControlFixture.commands.at(-1)?.command)).toMatchObject({ params: { actionRef: { token: 'episode-1:Close' } } });
    await publish('episode-2', false);
    await expect(dialog.getByRole('button', { name: 'Problem Solved and Resume', exact: true })).toBeDisabled();
    await page.locator('#app-tab-prepare').click(); await expect(dialog).toBeHidden();
    await publish('episode-3'); await expect(dialog).toBeHidden();
    await page.locator('#app-tab-device').click();
    await expect(dialog.getByRole('button', { name: 'Problem Solved and Resume', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Problem Solved and Resume', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.bambuControlFixture.commands.at(-1)?.command)).toMatchObject({ params: { actionRef: { token: 'episode-3:Problem Solved and Resume' } } });
  } finally { await app.close(); }
});
