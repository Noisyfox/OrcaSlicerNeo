// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './button';
import { TooltipFor, TooltipProvider, TOOLTIP_DELAY_MS } from './tooltip';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function renderButton({ disabled, pressed }: { disabled: boolean; pressed: boolean }) {
  if (!container) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(
    <TooltipProvider>
      <TooltipFor content="Move" disabled={disabled}>
        <Button disabled={disabled} aria-pressed={pressed} data-testid="mutable-button">Move</Button>
      </TooltipFor>
    </TooltipProvider>,
  ));
}

async function expectTooltipAfterHover() {
  const trigger = container!.querySelector<HTMLElement>('[data-base-ui-tooltip-trigger]')!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: 10, clientY: 10 }));
    trigger.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_DELAY_MS + 50));
  });
  expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain('Move');
}

describe('button tooltips', () => {
  it('continues opening after the button state changes', async () => {
    await renderButton({ disabled: false, pressed: false });
    await renderButton({ disabled: false, pressed: true });

    await expectTooltipAfterHover();
  });

  it('continues opening when a button becomes enabled after an update', async () => {
    await renderButton({ disabled: true, pressed: false });
    await renderButton({ disabled: false, pressed: false });

    await expectTooltipAfterHover();
  });

  it('continues opening when a button becomes disabled after an update', async () => {
    await renderButton({ disabled: false, pressed: false });
    await renderButton({ disabled: true, pressed: false });

    await expectTooltipAfterHover();
  });
});
