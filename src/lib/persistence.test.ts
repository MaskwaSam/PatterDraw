import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject } from "../types";

const { delMock, getMock, setMock } = vi.hoisted(() => ({
  delMock: vi.fn(),
  getMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock("idb-keyval", () => ({ del: delMock, get: getMock, set: setMock }));

import { clearAutosave, loadAutosave, saveAutosave } from "./persistence";

describe("PatterDraw autosave persistence", () => {
  beforeEach(() => {
    delMock.mockReset();
    getMock.mockReset();
    setMock.mockReset();
  });

  it("writes new autosaves under the PatterDraw storage key", async () => {
    const project = createBlankProject();
    await saveAutosave(project, {});
    expect(setMock).toHaveBeenCalledWith("patterdraw:autosave:project:v1", expect.objectContaining({
      id: project.id,
    }));
  });

  it("loads a legacy Canvas Classroom autosave", async () => {
    const project = createBlankProject();
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(project);
    await expect(loadAutosave()).resolves.toMatchObject({ project: { id: project.id }, pdfBytes: {} });
    expect(getMock).toHaveBeenNthCalledWith(1, "patterdraw:autosave:project:v1");
    expect(getMock).toHaveBeenNthCalledWith(2, "excalidraw-classroom:autosave:project:v1");
  });

  it("clears both current and legacy autosave keys", async () => {
    await clearAutosave();
    expect(delMock).toHaveBeenCalledWith("patterdraw:autosave:project:v1");
    expect(delMock).toHaveBeenCalledWith("excalidraw-classroom:autosave:project:v1");
  });
});
