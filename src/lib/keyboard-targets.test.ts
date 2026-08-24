import { describe, expect, it } from "vitest";
import { isEditableKeyboardTarget } from "./keyboard-targets";

function element(markup: string, selector = "*"): Element {
  const host = document.createElement("div");
  host.innerHTML = markup;
  const match = host.querySelector(selector);
  if (!match) throw new Error(`Fixture did not render ${selector}.`);
  return match;
}

describe("editable keyboard targets", () => {
  it.each([
    ["input", '<input value="Lesson">', "input"],
    ["textarea", "<textarea>Lesson</textarea>", "textarea"],
    ["select", "<select><option>Lesson</option></select>", "select"],
    ["textbox role", '<div role="textbox"></div>', '[role="textbox"]'],
    ["contenteditable true", '<div contenteditable="true"></div>', "[contenteditable]"],
    ["empty contenteditable", '<div contenteditable></div>', "[contenteditable]"],
    ["plaintext-only contenteditable", '<div contenteditable="plaintext-only"></div>', "[contenteditable]"],
  ])("recognizes %s", (_label, markup, selector) => {
    expect(isEditableKeyboardTarget(element(markup, selector))).toBe(true);
  });

  it.each([
    ["select", '<select><option data-child>Lesson</option></select>', "[data-child]"],
    ["textbox role", '<div role="textbox"><span data-child></span></div>', "[data-child]"],
    ["contenteditable", '<div contenteditable="true"><span data-child></span></div>', "[data-child]"],
  ])("recognizes descendants of %s", (_label, markup, selector) => {
    expect(isEditableKeyboardTarget(element(markup, selector))).toBe(true);
  });

  it("does not classify plain or explicitly non-editable content", () => {
    expect(isEditableKeyboardTarget(element("<div><span></span></div>", "span"))).toBe(false);
    expect(isEditableKeyboardTarget(element('<div contenteditable="false"><span></span></div>', "span"))).toBe(false);
    expect(isEditableKeyboardTarget(element('<div contenteditable="FALSE"><span></span></div>', "span"))).toBe(false);
    expect(isEditableKeyboardTarget(null)).toBe(false);
  });

  it("honours the nearest contenteditable declaration", () => {
    const disabledIsland = element(
      '<div role="textbox" contenteditable="true"><div contenteditable="false"><span></span></div></div>',
      "span",
    );
    expect(isEditableKeyboardTarget(disabledIsland)).toBe(false);
  });
});
