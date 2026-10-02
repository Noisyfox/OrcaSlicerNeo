import { readSliceReceipts } from './runtime-receipts';
import { expect, type ElectronApplication, type Page } from '@playwright/test';

/** Exercise the actual host File menu, preserving macOS native chrome. */
async function projectMenu(page: Page, app: ElectronApplication, command: 'file-open-project' | 'file-new-project'): Promise<void> {
  if (process.platform === 'darwin') {
    await expect.poll(() => app.evaluate(({ Menu }, command) => Menu.getApplicationMenu()?.getMenuItemById(command)?.enabled, command)).toBe(true);
    await app.evaluate(({ Menu, BrowserWindow }, command) => {
      const item=Menu.getApplicationMenu()?.getMenuItemById(command);
      if (!item?.enabled) throw new Error(`native ${command} unavailable`);
      item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {} as Electron.KeyboardEvent);
    }, command);
  } else {
    if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
      await page.getByTestId('menu-file-trigger').waitFor({state:'detached'});
      await page.getByTestId('titlebar-menu-trigger').click();
    }
    await page.getByTestId('menu-file-trigger').hover();
    await page.locator('[data-slot="menubar-sub-content"]').hover({position:{x:8,y:8}});
    await page.getByTestId(command).click();
  }
}

export const openProjectMenu = (page: Page, app: ElectronApplication) => projectMenu(page, app, 'file-open-project');
export async function newProjectMenu(page: Page, app: ElectronApplication): Promise<void> {
  const boundary = (await readSliceReceipts(page)).length;
  await projectMenu(page, app, 'file-new-project');
  // Dispatching a native MenuItem does not await the shared async New action.
  // Its native clean history baseline must complete before the next model edit.
  await expect.poll(async () => {
    const receipts = (await readSliceReceipts(page) as Array<{direction:string;id:number;op:string;ok?:boolean;result?:{canUndo?:boolean;canRedo?:boolean;dirty?:boolean}}>).slice(boundary);
    const request = receipts.find(receipt => receipt.direction === 'request' && receipt.op === 'resetHistory');
    return request !== undefined && receipts.some(receipt => receipt.direction === 'response' && receipt.op === 'resetHistory'
      && receipt.id === request.id && receipt.ok === true && receipt.result?.canUndo === false
      && receipt.result.canRedo === false && receipt.result.dirty === false);
  }).toBe(true);
  await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0);
}
