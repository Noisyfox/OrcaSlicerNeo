import { _electron, desktopLaunchOptions } from './electron-fixture';
import { expect, test } from '@playwright/test';
const startupTimeout = process.env.ORCA_E2E_REAL === '1' ? 300_000 : 30_000;

test('Home owns the Bambu entry and an isolated reusable login window cancels cleanly', async () => {
  const app = await _electron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1' } });
  try {
    // The real plugin supplies the URL; page content is deterministic and does not authenticate.
    await app.context().route('https://bambulab.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Official login fixture</title><input aria-label="Email"><script>window.addEventListener("message", e => window.loginReply = e.data);</script>' }));
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: startupTimeout });
    await page.locator('#app-tab-home').click();
    const signIn = page.getByRole('button', { name: 'Sign in to Bambu Lab' });
    await expect(signIn).toBeEnabled({ timeout: 30_000 });
    const opened = app.waitForEvent('window'); await signIn.click(); const login = await opened;
    await expect(login.getByRole('textbox', { name: 'Email' })).toBeVisible();
    await login.getByRole('textbox', { name: 'Email' }).fill('preserved-input');
    expect(await login.evaluate(() => ({ app: typeof (window as any).orca, bridge: typeof (window as any).wx?.postMessage, node: typeof (window as any).require }))).toEqual({ app: 'undefined', bridge: 'function', node: 'undefined' });
    await page.getByRole('button', { name: 'Show login' }).click();
    expect(app.windows()).toHaveLength(2); await expect(login.getByRole('textbox', { name: 'Email' })).toHaveValue('preserved-input');
    await login.evaluate(() => (window as any).wx.postMessage(JSON.stringify({ command: 'get_login_cmd' })));
    await expect.poll(() => login.evaluate(() => (window as any).loginReply?.command)).toBe('studio_userlogin');
    await login.close(); await expect(signIn).toBeEnabled();
    await page.getByTestId('tab-device').click(); await expect(signIn).toBeHidden();
  } finally { await app.close(); }
});

test('third-party login opens the system browser and preserves the embedded form and loopback', async () => {
  const app = await _electron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1' } });
  try {
    await app.evaluate(({ shell }) => {
      (globalThis as typeof globalThis & { bambuExternal: string[] }).bambuExternal = [];
      shell.openExternal = async url => { (globalThis as typeof globalThis & { bambuExternal: string[] }).bambuExternal.push(url); };
    });
    const external = () => app.evaluate(() => (globalThis as typeof globalThis & { bambuExternal: string[] }).bambuExternal);
    // The live official page gates thirdparty_login on this version parser. A UA
    // ending directly after the version falls back to an ordinary browser popup.
    await app.context().route('https://bambulab.com/**', route => route.fulfill({ contentType: 'text/html', body: String.raw`
      <title>Official login fixture</title><input aria-label="Email">
      <button id="social">Third-party login</button><button id="popup">Popup login</button>
      <script>
        document.getElementById('social').onclick = () => {
          if (!/BBL-Slicer\/v(.+?) /.exec(navigator.userAgent)) { window.open('https://bambulab.com/oauth/ordinary'); return; }
          const reply = event => {
            if (event.data.command !== 'get_localhost_url' || event.data.sequence_id !== 'social') return;
            window.removeEventListener('message', reply);
            window.callbackBase = event.data.response.base_url;
            wx.postMessage(JSON.stringify({ command: 'thirdparty_login', data: { url: 'https://bambulab.com/oauth/studio?redirect_url=' + encodeURIComponent(window.callbackBase) } }));
          };
          window.addEventListener('message', reply);
          wx.postMessage(JSON.stringify({ command: 'get_localhost_url', sequence_id: 'social' }));
        };
        document.getElementById('popup').onclick = () => window.open('https://bambulab.com/oauth/popup');
      </script>` }));
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: startupTimeout });
    await page.locator('#app-tab-home').click();
    const opened = app.waitForEvent('window'); await page.getByRole('button', { name: 'Sign in to Bambu Lab' }).click(); const login = await opened;
    await login.getByRole('textbox', { name: 'Email' }).fill('preserved-input');
    const originalUrl = login.url();
    await login.getByRole('button', { name: 'Third-party login', exact: true }).click();
    await expect.poll(external).toHaveLength(1);
    expect(new URL((await external())[0]).pathname).toBe('/oauth/studio');
    const callbackBase = new URL((await external())[0]).searchParams.get('redirect_url')!;
    expect(new URL(callbackBase).port).not.toBe('');
    await expect(login.getByRole('textbox', { name: 'Email' })).toHaveValue('preserved-input'); expect(login.url()).toBe(originalUrl);
    await login.getByRole('button', { name: 'Popup login', exact: true }).click();
    await expect.poll(external).toHaveLength(2); expect(new URL((await external())[1]).pathname).toBe('/oauth/popup');
    await expect(login.getByRole('textbox', { name: 'Email' })).toHaveValue('preserved-input'); expect(app.windows()).toHaveLength(2);
    await login.close();
    expect((await fetch(callbackBase.replace('localhost', '127.0.0.1') + '/?invalid')).status).toBe(400);
    await expect(page.getByRole('button', { name: 'Show login' })).toBeEnabled();
  } finally { await app.close(); }
});
