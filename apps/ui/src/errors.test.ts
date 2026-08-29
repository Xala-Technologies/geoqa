import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError } from "./describe-error.ts";
import { clearFatalError, readFatalError, reportFatal, subscribeFatalError } from "./fatal-error.ts";
import { installGlobalErrorHandlers } from "./global-handlers.ts";

describe("describeError", () => {
  it("uses the message from an Error", () => {
    expect(describeError(new Error("matrix refused"))).toBe("matrix refused");
  });

  it("falls back to the name when the message is empty", () => {
    expect(describeError(new TypeError(""))).toBe("TypeError");
  });
});

describe("fatal-error store", () => {
  afterEach(() => clearFatalError());

  it("notifies subscribers when a fatal error is reported", () => {
    const seen: string[] = [];
    const off = subscribeFatalError(() => {
      const current = readFatalError();
      if (current !== null) seen.push(current.message);
    });
    reportFatal({ source: "promise", message: "boom", detail: null });
    off();
    expect(seen).toEqual(["boom"]);
  });
});

describe("installGlobalErrorHandlers", () => {
  afterEach(() => {
    clearFatalError();
    vi.unstubAllGlobals();
  });

  const stubWindow = (): Record<string, EventListener> => {
    const listeners: Record<string, EventListener> = {};
    vi.stubGlobal("window", {
      addEventListener: (type: string, handler: EventListener) => {
        listeners[type] = handler;
      },
      removeEventListener: () => undefined,
    });
    return listeners;
  };

  const errorEvent = (init: { message: string; filename: string; lineno: number }): ErrorEvent =>
    ({ message: init.message, filename: init.filename, lineno: init.lineno }) as ErrorEvent;

  it("reports uncaught window errors", () => {
    const listeners = stubWindow();
    const off = installGlobalErrorHandlers();
    listeners.error?.(errorEvent({ message: "script died", filename: "https://geoqa.xala.no/app.js", lineno: 12 }));
    off();
    expect(readFatalError()?.message).toBe("script died");
    expect(readFatalError()?.source).toBe("window");
  });

  it("ignores browser-extension scripts", () => {
    const listeners = stubWindow();
    const off = installGlobalErrorHandlers();
    listeners.error?.(errorEvent({ message: "extension noise", filename: "chrome-extension://abc/content.js", lineno: 1 }));
    off();
    expect(readFatalError()).toBeNull();
  });

  it("reports unhandled promise rejections", () => {
    const listeners = stubWindow();
    const off = installGlobalErrorHandlers();
    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", { value: new Error("fetch blew up") });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    listeners.unhandledrejection?.(event);
    off();
    expect(readFatalError()?.message).toBe("fetch blew up");
    expect(readFatalError()?.source).toBe("promise");
  });
});
