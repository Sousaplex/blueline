// Dark by default; the user's explicit choice persists in localStorage.
export type Theme = "dark" | "light";

export function currentTheme(): Theme {
  return localStorage.getItem("presscheck-theme") === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  localStorage.setItem("presscheck-theme", theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
}
