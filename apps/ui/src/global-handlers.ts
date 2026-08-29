import { describeError } from "./describe-error.ts";
import { reportFatal } from "./fatal-error.ts";

const IGNORED_PROTOCOLS = ["chrome-extension:", "moz-extension:", "safari-extension:"];

/** Extension scripts throw into the page; they are not geoqa defects. */
const isIgnoredScript = (filename: string | undefined): boolean => {
  if (filename === undefined || filename === "") return false;
  return IGNORED_PROTOCOLS.some((protocol) => filename.startsWith(protocol));
};

/**
 * Catch errors the React tree never sees — event handlers, async gaps, third-party scripts.
 * Returns a teardown for tests.
 */
export function installGlobalErrorHandlers(): () => void {
  const onError = (event: ErrorEvent): void => {
    if (isIgnoredScript(event.filename)) return;
    const detail =
      event.filename !== undefined && event.filename !== ""
        ? `${event.filename}${event.lineno > 0 ? `:${event.lineno}` : ""}`
        : null;
    reportFatal({
      source: "window",
      message: event.message.trim() !== "" ? event.message : "Uncaught error",
      detail,
    });
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    reportFatal({
      source: "promise",
      message: describeError(event.reason),
      detail: null,
    });
    // We render our own screen; suppress the browser's duplicate "Uncaught (in promise)" overlay.
    event.preventDefault();
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
