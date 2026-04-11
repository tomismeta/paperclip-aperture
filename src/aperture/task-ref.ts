export type TaskRefKind = string;

export type TaskRef = {
  kind: TaskRefKind;
  id: string;
};

function normalizeComponent(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function decodeComponent(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim().length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function createTaskId(kind: TaskRefKind, id: string): string {
  const normalizedKind = normalizeComponent(kind, "task kind");
  const normalizedId = normalizeComponent(id, "task id");
  return `${encodeURIComponent(normalizedKind)}:${encodeURIComponent(normalizedId)}`;
}

export function parseTaskId(taskId: unknown): TaskRef | null {
  if (typeof taskId !== "string") return null;
  const separatorIndex = taskId.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= taskId.length - 1) return null;

  const kind = decodeComponent(taskId.slice(0, separatorIndex));
  const id = decodeComponent(taskId.slice(separatorIndex + 1));
  if (!kind || !id) return null;
  return { kind, id };
}

export function taskKind(taskId: unknown): string | null {
  return parseTaskId(taskId)?.kind ?? null;
}

export function taskEntityId(taskId: unknown): string | null {
  return parseTaskId(taskId)?.id ?? null;
}

export function taskIdMatchesKind(taskId: unknown, expectedKind: string): boolean {
  return parseTaskId(taskId)?.kind === expectedKind;
}

export function createInteractionId(taskId: string, step: string): string {
  const normalizedStep = normalizeComponent(step, "interaction step");
  return `${taskId}:${encodeURIComponent(normalizedStep)}`;
}
