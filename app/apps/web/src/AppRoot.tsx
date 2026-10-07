import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { RecordCompanionOwnerHub } from "./components/recordCompanion/RecordCompanionOwnerHub";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI. The Record companion owner hub
 * likewise sits outside the router: it owns the route-independent record read
 * scopes and the companion handoff, so a detached companion survives thread
 * navigation and the docked surfaces project hub-owned state.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RecordCompanionOwnerHub>
        <RouterProvider router={router} />
      </RecordCompanionOwnerHub>
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
