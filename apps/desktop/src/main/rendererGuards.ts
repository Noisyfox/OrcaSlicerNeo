export interface RendererContents {
  isDestroyed(): boolean;
}

export interface RendererWindow {
  isDestroyed(): boolean;
  webContents: RendererContents;
}

/** Accept IPC only from the active window's renderer contents. */
export function isCurrentRendererSender(
  sender: RendererContents,
  currentWindow: RendererWindow | null,
): boolean {
  return Boolean(
    currentWindow &&
    !currentWindow.isDestroyed() &&
    !sender.isDestroyed() &&
    sender === currentWindow.webContents,
  );
}
