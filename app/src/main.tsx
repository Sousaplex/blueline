import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Dark by default; explicit user choice (theme toggle) persists.
import { applyTheme, currentTheme } from "./lib/theme";
applyTheme(currentTheme());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
