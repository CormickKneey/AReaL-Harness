import { createRoot } from 'react-dom/client';
// Stylesheets load before the app module so SettingsWorkspace.css (imported through App)
// is emitted after workbench.css and wins over the legacy `.settings-*` rules still there.
import './styles.css';
import './workbench.css';
import { TooltipProvider } from './components/ui/tooltip.js';
import { App } from './App.js';
import { createDesktopServices, type DesktopBridge } from './desktop-services.js';
// This is the only module allowed to access the desktop preload object.
const bridge = (window as unknown as {
    arealDesktop: DesktopBridge;
}).arealDesktop;
if (!bridge)
    document.getElementById('root')!.textContent = '请通过 AReaL Harness 桌面入口打开此界面。';
else
    createRoot(document.getElementById('root')!).render(<TooltipProvider><App services={createDesktopServices(bridge)}/></TooltipProvider>);
