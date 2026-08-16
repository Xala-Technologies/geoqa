import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
// Thrown rather than silently no-op'd: a blank page with no error is the hardest kind of
// failure to diagnose, and this can only happen if index.html was edited.
if (root === null) throw new Error("no #root element — index.html and main.tsx disagree");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
