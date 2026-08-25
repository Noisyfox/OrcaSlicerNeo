import type {
  MenuCommandId,
  MenuItem,
  MenuModel,
  MenuStateSnapshot,
  PlatformChrome,
} from '@orca/platform-contract';
import {
  Menubar,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/components/ui/menubar';
import { cn } from '@/lib/utils';

export interface TitleBarProps {
  chrome: PlatformChrome;
  model: MenuModel;
  state: MenuStateSnapshot;
  onCommand: (command: MenuCommandId) => void;
}

function MenuItems({
  items,
  state,
  onCommand,
}: {
  items: readonly MenuItem[];
  state: MenuStateSnapshot;
  onCommand: (command: MenuCommandId) => void;
}) {
  return (
    <>
      {items.map((item) => {
        if (item.separator) return <MenubarSeparator key={item.testId} data-testid={item.testId} />;

        if (item.submenu) {
          return (
            <MenubarSub key={item.testId}>
              <MenubarSubTrigger data-testid={item.testId}>{item.label}</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarGroup>
                  <MenuItems items={item.submenu} state={state} onCommand={onCommand} />
                </MenubarGroup>
              </MenubarSubContent>
            </MenubarSub>
          );
        }

        if (!item.command) return null;
        const itemState = state.items[item.command];
        const enabled = itemState?.enabled ?? false;
        return (
          <MenubarItem
            key={item.testId}
            data-testid={item.testId}
            data-command={item.command}
            data-checked={itemState?.checked ? 'true' : undefined}
            disabled={!enabled}
            className="[-webkit-app-region:no-drag]"
            onClick={() => {
              if (enabled) onCommand(item.command!);
            }}
          >
            {item.label}
          </MenubarItem>
        );
      })}
    </>
  );
}

/**
 * Shared renderer titlebar. Native macOS menus intentionally leave this
 * surface empty; the same startup/ready state is still synchronized by App.
 */
export function TitleBar({ chrome, model, state, onCommand }: TitleBarProps) {
  const native = model.menuMode === 'native' || chrome.menuMode === 'native';
  return (
    <header
      data-testid="titlebar"
      aria-label="Application title bar"
      className={cn(
        'flex h-8 shrink-0 items-center bg-background select-none',
        chrome.dragRegion && '[-webkit-app-region:drag]',
        chrome.macSafeInset && 'pl-20',
      )}
    >
      {!native && (
        <Menubar
          data-testid="titlebar-menu"
          aria-label="Application menu"
          className="h-8 rounded-none border-0 p-0 [-webkit-app-region:no-drag]"
        >
          {model.menus.map((menu) => (
            <MenubarMenu key={menu.testId}>
              <MenubarTrigger data-testid={`${menu.testId}-trigger`} className="px-2.5 py-0.5 [-webkit-app-region:no-drag]">
                {menu.label}
              </MenubarTrigger>
              <MenubarContent>
                <MenubarGroup>
                  <MenuItems items={menu.items} state={state} onCommand={onCommand} />
                </MenubarGroup>
              </MenubarContent>
            </MenubarMenu>
          ))}
        </Menubar>
      )}
    </header>
  );
}
