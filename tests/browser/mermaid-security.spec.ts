import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";

interface DiagramElement {
  id: string;
  type: string;
  isDeleted: boolean;
  text?: string;
  link?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface DiagramProject {
  activeSceneId: string;
  scenes: Record<string, { elements: DiagramElement[] }>;
}

async function downloadedElements(page: Page): Promise<DiagramElement[]> {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const file = await (await event).path();
  if (!file) throw new Error("Project download has no local bytes.");
  const project = JSON.parse(strFromU8(unzipSync(await readFile(file))["project.json"])) as DiagramProject;
  return project.scenes[project.activeSceneId].elements.filter(element => !element.isDeleted);
}

test("previews editable Mermaid diagrams, rejects unsafe input, and persists inserted vectors", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("Mermaid coverage requires the configured local app URL.");
  const origin = new URL(baseURL).origin;
  const failures: string[] = [];
  const externalRequests: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("request", request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) {
      externalRequests.push(request.url());
    }
  });
  await page.goto("./");
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible();
  await expect(page.getByTestId("scene-hydration-input-guard")).toHaveCount(0);
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  await page.getByRole("menuitem", { name: /Diagram/ }).click();
  const dialog = page.getByRole("dialog", { name: "Insert Mermaid diagram", exact: true });
  const source = dialog.getByLabel("Mermaid source", { exact: true });
  const preview = dialog.getByRole("button", { name: "Preview", exact: true });
  const insert = dialog.getByRole("button", { name: "Insert diagram", exact: true });

  for (const definition of [
    "flowchart LR\nA[Start] --> B[Finish]",
    "sequenceDiagram\nStudent->>Teacher: Question",
  ]) {
    await source.fill(definition);
    await preview.click();
    await expect(dialog.getByAltText("Preview of the Mermaid diagram")).toBeVisible();
    await expect(insert).toBeEnabled();
  }

  for (const [definition, error] of [
    ["%%{init: {'securityLevel': 'loose'}}%%\nflowchart LR\nA-->B", /configuration directives/],
    ["flowchart LR\nA-->B\nclick A href https://example.test", /links and callbacks/],
    ["flowchart LR\nA[<img onerror=alert(1)>]", /HTML/],
    ["flowchart LR\nclassDef bad fill:url(https://example.test)", /style directives/],
  ] as const) {
    await source.fill(definition);
    await expect(insert).toBeDisabled();
    await preview.click();
    await expect(dialog.locator(".preview-error")).toContainText(error);
    await expect(insert).toBeDisabled();
  }

  await source.fill("flowchart LR\nA[Start] --> B[Finish]");
  await preview.click();
  await expect(insert).toBeEnabled();
  await insert.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  const elements = await downloadedElements(page);
  expect(elements.length).toBeGreaterThan(2);
  expect(elements.some(element => element.text === "Start")).toBe(true);
  expect(elements.some(element => element.text === "Finish")).toBe(true);
  expect(elements.every(element => ["arrow", "diamond", "ellipse", "line", "rectangle", "text"].includes(element.type))).toBe(true);
  expect(elements.every(element => !element.link)).toBe(true);
  const content = (items: DiagramElement[]) => items.map(({ id, type, text, x, y, width, height }) => ({ id, type, text, x, y, width, height }));
  await page.reload();
  await expect(page.getByTestId("scene-hydration-input-guard")).toHaveCount(0);
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  expect(content(await downloadedElements(page))).toEqual(content(elements));
  expect(failures).toEqual([]);
  expect(externalRequests).toEqual([]);
});
