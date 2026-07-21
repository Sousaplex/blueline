import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { applyTheme, currentTheme } from "@/lib/theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState(currentTheme());
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" title="Toggle light/dark" onClick={flip}>
      {theme === "dark" ? <Sun /> : <Moon />}
    </Button>
  );
}
