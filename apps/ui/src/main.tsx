import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { GlobalErrorRoot } from "./GlobalErrorRoot.tsx";
import { describeError } from "./describe-error.ts";
import { reportFatal } from "./fatal-error.ts";
import { ErrorScreen } from "./ErrorScreen.tsx";
import "./styles.css";

const root = document.getElementById("root");
// Thrown rather than silently no-op'd: a blank page with no error is the hardest kind of
// failure to diagnose, and this can only happen if index.html was edited.
if (root === null) throw new Error("no #root element — index.html and main.tsx disagree");

const reactRoot = createRoot(root);
try {
  reactRoot.render(
    <StrictMode>
      <GlobalErrorRoot>
        <App />
      </GlobalErrorRoot>
    </StrictMode>,
  );
} catch (error) {
  reportFatal({
    source: "boot",
    message: describeError(error),
    detail: error instanceof Error ? (error.stack ?? null) : null,
  });
  reactRoot.render(
    <ErrorScreen
      source="boot"
      message={describeError(error)}
      detail={error instanceof Error ? (error.stack ?? null) : null}
      onRetry={() => window.location.reload()}
    />,
  );
}
