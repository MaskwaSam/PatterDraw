import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export interface LassoSelection {
  selectedElementIds: Record<string, true>;
  selectedGroupIds: Record<string, true>;
}

export interface ResolveLassoSelectionOptions {
  additive?: boolean;
  editingGroupId?: string | null;
  hitElementIds: readonly string[];
  previousSelectedElementIds?: Readonly<Record<string, boolean>>;
}

function outermostSelectableGroup(
  element: ExcalidrawElement,
  editingGroupId: string | null,
): string | null {
  let groupIds = element.groupIds || [];
  if (editingGroupId) {
    const editingIndex = groupIds.indexOf(editingGroupId);
    if (editingIndex >= 0) groupIds = groupIds.slice(0, editingIndex);
  }
  return groupIds[groupIds.length - 1] || null;
}

export function resolveLassoSelection(
  elements: readonly ExcalidrawElement[],
  options: ResolveLassoSelectionOptions,
): LassoSelection {
  const elementsMap = new Map(elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]));
  const selected = new Set(options.hitElementIds.filter((id) => elementsMap.has(id)));
  if (options.additive) {
    for (const [id, isSelected] of Object.entries(options.previousSelectedElementIds || {})) {
      if (isSelected && elementsMap.has(id)) selected.add(id);
    }
  }

  for (const id of [...selected]) {
    const element = elementsMap.get(id);
    if (element?.type === "text" && element.containerId && elementsMap.has(element.containerId)) {
      selected.delete(id);
      selected.add(element.containerId);
    }
  }

  const selectedFrames = new Set([...selected].filter((id) => {
    const element = elementsMap.get(id);
    return element?.type === "frame" || element?.type === "magicframe";
  }));
  if (selectedFrames.size) {
    for (const element of elementsMap.values()) {
      if (element.frameId && selectedFrames.has(element.frameId)) selected.delete(element.id);
    }
  }

  const editingGroupId = options.editingGroupId || null;
  const selectedGroups = new Set<string>();
  for (const id of selected) {
    const element = elementsMap.get(id);
    if (!element) continue;
    const groupId = outermostSelectableGroup(element, editingGroupId);
    if (groupId) selectedGroups.add(groupId);
  }
  for (const groupId of [...selectedGroups]) {
    const members = [...elementsMap.values()].filter((element) => element.groupIds?.includes(groupId));
    if (members.length < 2) {
      selectedGroups.delete(groupId);
      continue;
    }
    for (const member of members) selected.add(member.id);
  }

  return {
    selectedElementIds: Object.fromEntries([...selected].map((id) => [id, true])),
    selectedGroupIds: Object.fromEntries([...selectedGroups].map((id) => [id, true])),
  };
}
