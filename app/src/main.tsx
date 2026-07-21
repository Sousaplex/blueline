import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Normal-tool behavior: follow the OS theme.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", media.matches);
applyTheme();
media.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
