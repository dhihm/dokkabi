/**
 * Entry of the restricted Record companion window (Dokkabi R6).
 *
 * Deliberately minimal: the shared stylesheet (same tailwind theme base and
 * token declarations as the main window) and the companion window component.
 * No AppRoot, no router, no authentication, no providers, no queued-message
 * sender, no browser host — the restricted preload exposes only
 * `window.recordCompanion`, and the shell's CSP denies network egress. No
 * StrictMode: the IPC handshake (bootstrap → ready → activated) is a
 * stateful machine conversation with exactly-once semantics that a dev
 * double-mount would turn into a protocol violation; the component itself
 * guards ready with a per-companion acknowledgement latch.
 */
import ReactDOM from "react-dom/client";

import "../index.css";

import { RecordCompanionWindow } from "./RecordCompanionWindow";

const container = document.getElementById("root") as HTMLElement;
ReactDOM.createRoot(container).render(<RecordCompanionWindow />);
