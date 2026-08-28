import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlideRotationDialog } from "./SlideRotationDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function mount() {
  const onCancel = vi.fn();
  const onSubmit = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(SlideRotationDialog, {
    slideTitle: "Crooked example",
    onCancel,
    onSubmit,
  })));
  return { container, onCancel, onSubmit };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function changeNumber(input: HTMLInputElement | null, value: string): void {
  if (!input) throw new Error("Rotation input was not rendered.");
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!valueSetter) throw new Error("HTML input value setter is unavailable.");
  act(() => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
});

describe("SlideRotationDialog", () => {
  it("turns a 33 degree right lean left without requiring signed-number guessing", () => {
    const { container, onSubmit } = mount();
    const input = container.querySelector<HTMLInputElement>("#slide-rotation-degrees");
    expect(input).toBeTruthy();

    changeNumber(input, "33");
    act(() => container.querySelector<HTMLFormElement>("form")?.requestSubmit());

    expect(onSubmit).toHaveBeenCalledWith(-33);
  });

  it("supports explicit right turns, fractional amounts, and common presets", () => {
    const { container, onSubmit } = mount();
    act(() => button(container, "Turn right ↻").click());
    act(() => button(container, "15°").click());
    act(() => container.querySelector<HTMLFormElement>("form")?.requestSubmit());
    expect(onSubmit).toHaveBeenLastCalledWith(15);

    const input = container.querySelector<HTMLInputElement>("#slide-rotation-degrees");
    changeNumber(input, "33.5");
    act(() => container.querySelector<HTMLFormElement>("form")?.requestSubmit());
    expect(onSubmit).toHaveBeenLastCalledWith(33.5);
  });

  it("blocks zero, non-numeric, and out-of-range submissions", () => {
    const { container, onSubmit } = mount();
    const input = container.querySelector<HTMLInputElement>("#slide-rotation-degrees");
    const submit = () => container.querySelector<HTMLFormElement>("form")?.requestSubmit();

    for (const value of ["0", "181", ""]) {
      changeNumber(input, value);
      expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
      act(submit);
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
