import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ThemeToggle from "@/components/ThemeToggle";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeToggle", () => {
  it("offers light / dark / system and applies the chosen theme", () => {
    render(<ThemeToggle />);
    // Labels are i18n keys; the default test language (en) renders them capitalized.
    const dark = screen.getByRole("radio", { name: "Dark" });
    expect(screen.getByRole("radio", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "System" })).toBeInTheDocument();

    fireEvent.click(dark);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(dark).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("balance-theme")).toBe("dark");
  });

  it("keeps multiple theme controls synchronized", () => {
    render(<><ThemeToggle /><ThemeToggle /></>);
    const dark = screen.getAllByRole("radio", { name: "Dark" });
    const system = screen.getAllByRole("radio", { name: "System" });

    fireEvent.click(dark[0]);

    expect(dark[0]).toHaveAttribute("aria-checked", "true");
    expect(dark[1]).toHaveAttribute("aria-checked", "true");
    expect(system[0]).toHaveAttribute("aria-checked", "false");
    expect(system[1]).toHaveAttribute("aria-checked", "false");
  });
});
