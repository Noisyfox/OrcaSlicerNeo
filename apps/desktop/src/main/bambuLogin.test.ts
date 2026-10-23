import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: vi.fn(), ipcMain: {}, shell: {} }));
import { BambuLogin, type BambuLoginView, type LoginViewFactory } from './bambuLogin';
import type { BambuUtility } from './bambuUtility';
let login: BambuLogin | null = null;
afterEach(() => { login?.dispose(); login = null; });
function fixture() {
  const callbacks: Parameters<LoginViewFactory>[1][] = []; const posts: Record<string, any>[] = []; const order: string[] = [];
  const views: BambuLoginView[] = [];
  const host = vi.fn(async (method: string, input: unknown): Promise<unknown> => {
    order.push(method);
    if (method === 'login.begin') return { attempt: 1, url: 'https://bambulab.com/en-US/sign-in' };
    if (method === 'login.command') return '{"command":"studio_userlogin","data":{}}';
    return { ok: true, value: undefined };
  });
  const external = vi.fn(async (_url: string) => {});
  login = new BambuLogin({ host } as unknown as Pick<BambuUtility, 'host'>, (_url, cb) => {
    callbacks.push(cb);
    const view = { focus: vi.fn(), close: vi.fn(() => { order.push('close'); cb.closed(); }), post: (message: unknown) => { posts.push(message as Record<string, any>); } };
    views.push(view); return view;
  }, external);
  return { login, callbacks, posts, order, host, views, external };
}
it('reuses an open login page and closes it between preparation and change_user', async () => {
  const f = fixture(); await Promise.all([f.login.open(), f.login.open()]); await f.login.open();
  expect(f.callbacks).toHaveLength(1); expect(f.views[0].focus).toHaveBeenCalledOnce();
  f.callbacks[0].message(JSON.stringify({ command: 'user_ticket_login', data: { ticket: 'private' } }));
  await vi.waitFor(() => expect(f.order).toContain('login.complete'));
  expect(f.order).toEqual(['login.begin', 'login.prepare', 'close', 'login.complete']);
  expect(f.host).not.toHaveBeenCalledWith('login.cancel', expect.anything());
});
it('keeps the real loopback alive after browser handoff and embedded window closure', async () => {
  const f = fixture(); await f.login.open();
  f.callbacks[0].message(JSON.stringify({ command: 'get_localhost_url', sequence_id: '17' }));
  await vi.waitFor(() => expect(f.posts).toHaveLength(1));
  const base = f.posts[0].response.base_url as string;
  f.callbacks[0].message(JSON.stringify({ command: 'thirdparty_login', data: { url: 'https://bambulab.com/oauth?redirect=http%3A%2F%2Flocalhost%3A13618' } }));
  await vi.waitFor(() => expect(f.external).toHaveBeenCalledOnce());
  expect(f.external.mock.calls[0][0]).toContain(new URL(base).port);
  f.views[0].close();
  const response = await fetch(base.replace('localhost', '127.0.0.1') + '/?ticket=private&redirect_url=' + encodeURIComponent('https://bambulab.com/en-US/sign-in'), { redirect: 'manual' });
  expect(response.status).toBe(302); expect(response.headers.get('location')).toContain('result=success');
  expect(f.order).toContain('login.complete'); expect(f.order).not.toContain('login.cancel');
});
it('cancels an ordinary window close and rejects non-HTTPS handoffs', async () => {
  const f = fixture(); await f.login.open();
  f.callbacks[0].message(JSON.stringify({ command: 'new_webpage', data: { url: 'file:///private' } }));
  await vi.waitFor(() => expect(f.order).toContain('login.fail'));
  expect(f.external).not.toHaveBeenCalled(); f.views[0].close();
  await vi.waitFor(() => expect(f.order).toContain('login.cancel'));
});
it('does not recreate a window after an in-flight open was invalidated by a region/logout action', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.host.mockImplementationOnce(() => new Promise(resolveValue => { resolve = resolveValue; }));
  const opening = f.login.open(); f.login.dispose(); resolve({ attempt: 1, url: 'https://bambulab.com/en-US/sign-in' });
  expect(await opening).toMatchObject({ ok: false }); expect(f.callbacks).toHaveLength(0);
});

it('routes popup requests through browser handoff without replacing or closing the embedded view', async () => {
  const f = fixture(); await f.login.open();
  f.callbacks[0].external('https://bambulab.com/oauth?redirect=http%3A%2F%2Flocalhost%3A13618');
  await vi.waitFor(() => expect(f.external).toHaveBeenCalledOnce());
  expect(f.views[0].close).not.toHaveBeenCalled(); expect(f.order).not.toContain('login.cancel');
  f.views[0].close(); expect(f.order).not.toContain('login.cancel');
});
