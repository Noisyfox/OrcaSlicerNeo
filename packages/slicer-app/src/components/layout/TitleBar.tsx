import type {
  MenuCommandId,
  MenuItem,
  MenuModel,
  MenuStateSnapshot,
  PlatformChrome,
} from '@orca/platform-contract';
import { MenuIcon, SaveIcon, HouseIcon, BoxIcon, LayersIcon, ComputerIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipFor } from '@/components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { HistoryNavigation } from './HistoryNavigation';
import { isAppTab, type AppTab } from './appTabs';
import type { HistoryRestoreCoordinator } from '@/history/restoreCoordinator';
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
import { cn } from 'cn';

export interface TitleBarProps {
  chrome: PlatformChrome;
  model: MenuModel;
  state: MenuStateSnapshot;
  onCommand: (command: MenuCommandId) => void;
  activeTab?: AppTab;
  onTabChange?: (tab: AppTab) => void;
  historyRestoreCoordinator?: HistoryRestoreCoordinator | null;
  projectName?: string;
  projectDirty?: boolean;
  navigationDisabled?: boolean;
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
 * Shared navigation and quick actions; macOS keeps its native menu surface.
 */
export function TitleBar({ chrome, model, state, onCommand, activeTab = 'home', onTabChange, historyRestoreCoordinator, projectName = 'Untitled', projectDirty = false, navigationDisabled = false }: TitleBarProps) {
  const native = model.menuMode === 'native' || chrome.menuMode === 'native';
  return (
    <header
      data-testid="titlebar"
      aria-label="Application title bar"
      className={cn(
        'titlebar flex h-8 min-w-0 shrink-0 items-center bg-titlebar select-none',
        chrome.dragRegion && '[-webkit-app-region:drag]',
        chrome.macSafeInset && 'pl-20',
        chrome.kind === 'desktop' && !chrome.macSafeInset && 'titlebar-window-inset',
      )}
    >
      {!native && (
        <Menubar
          data-testid="titlebar-menu"
          aria-label="Application menu"
          className="ml-2 h-8 shrink-0 rounded-none border-0 p-0 [-webkit-app-region:no-drag]"
        >
          <MenubarMenu>
            <MenubarTrigger data-testid="titlebar-menu-trigger" aria-label="Application menu" className="titlebar-action size-7 justify-center p-0 [-webkit-app-region:no-drag]">
              <MenuIcon className="size-4" />
            </MenubarTrigger>
            <MenubarContent>
              <MenubarGroup>
                {model.menus.map((menu) => (
                  <MenubarSub key={menu.testId}>
                    <MenubarSubTrigger data-testid={`${menu.testId}-trigger`}>{menu.label}</MenubarSubTrigger>
                    <MenubarSubContent>
                      <MenubarGroup><MenuItems items={menu.items} state={state} onCommand={onCommand} /></MenubarGroup>
                    </MenubarSubContent>
                  </MenubarSub>
                ))}
              </MenubarGroup>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
      )}
      {!native && <Separator orientation="vertical" className="mx-1 h-5 self-center" />}
      <TooltipFor content="Save Project" disabled={!state.items['save-project']?.enabled}>
        <Button size="icon" variant="ghost" className="titlebar-action [-webkit-app-region:no-drag]" aria-label="Save Project" data-testid="titlebar-save-project" disabled={!state.items['save-project']?.enabled} onClick={() => onCommand('save-project')}>
          <SaveIcon />
        </Button>
      </TooltipFor>
      <HistoryNavigation activeTab={activeTab} coordinator={historyRestoreCoordinator} />
      <Separator orientation="vertical" className={cn('ml-2 mr-0 h-5 self-center', activeTab === 'home' && 'invisible')} />
      <Tabs value={activeTab} className="titlebar-tabs no-scrollbar min-w-0 shrink self-end overflow-x-auto [-webkit-app-region:no-drag]" onValueChange={(value) => { if (isAppTab(value)) onTabChange?.(value); }}>
        <TabsList aria-label="Main pages" className="titlebar-tabs-list">
          <TabsTrigger className="titlebar-tab" value="home" id="app-tab-home" aria-label="Home" aria-controls="app-panel-home" disabled={navigationDisabled}><HouseIcon /></TabsTrigger>
          <TabsTrigger className="titlebar-tab" value="prepare" id="app-tab-prepare" aria-controls="app-panel-workspace" disabled={navigationDisabled}><BoxIcon />Prepare</TabsTrigger>
          <TabsTrigger className="titlebar-tab" value="preview" id="app-tab-preview" aria-controls="app-panel-workspace" disabled={navigationDisabled}><LayersIcon />Preview</TabsTrigger>
          <TabsTrigger className="titlebar-tab" value="device" id="app-tab-device" aria-controls="app-panel-device" data-testid="tab-device" disabled={navigationDisabled}><ComputerIcon />Device</TabsTrigger>
        </TabsList>
      </Tabs>
      <Separator orientation="vertical" className={cn('ml-0 mr-3 h-5 self-center', activeTab === 'device' && 'invisible')} />
      <span className="titlebar-project-label min-w-0 truncate pr-3 text-[13px] leading-5 text-muted-foreground" title={projectName} data-testid="titlebar-project-name">{projectName === 'Untitled' ? 'Untitled Project' : projectName}{projectDirty ? ' *' : ''}</span>
    </header>
  );
}
