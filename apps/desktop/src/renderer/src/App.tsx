import { AppShell } from './components/layout/AppShell';
import { Toolbar } from './components/toolbar/Toolbar';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { Viewport } from './components/viewport/Viewport';
import { StatusBar } from './components/status/StatusBar';

export default function App() {
  return (
    <AppShell
      toolbar={<Toolbar />}
      settings={<SettingsPanel />}
      viewport={<Viewport />}
      status={<StatusBar />}
    />
  );
}
