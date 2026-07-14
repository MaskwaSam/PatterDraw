import { createRoot } from "react-dom/client";
import { installLocalExcalidrawAssets, installOfflineNetworkGuard } from "./lib/offline-network";

installOfflineNetworkGuard();
installLocalExcalidrawAssets();

const { default: App } = await import("./App");

createRoot(document.getElementById("root")!).render(
  <App />,
);
