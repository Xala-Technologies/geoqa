import { useLayoutEffect, useState, type JSX } from "react";
import { IconMoon, IconSun } from "./icons.tsx";
import { applyTheme, readTheme, type Theme } from "./theme.ts";

export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>("dark");

  useLayoutEffect(() => {
    const current = readTheme();
    applyTheme(current);
    setTheme(current);
  }, []);

  const next = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? IconSun : IconMoon;

  return (
    <button
      type="button"
      className="tool tool-accent"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        const value = readTheme() === "light" ? "dark" : "light";
        applyTheme(value);
        setTheme(value);
      }}
    >
      <Icon className="icon" />
    </button>
  );
}
