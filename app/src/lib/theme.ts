// Light (day) by default; the user's explicit choice persists in localStorage.
export type Theme = "dark" | "light";

export function currentTheme(): Theme {
  return localStorage.getItem("blueline-theme") === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  localStorage.setItem("blueline-theme", theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
}
