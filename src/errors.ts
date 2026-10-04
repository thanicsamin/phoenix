export interface AppError extends Error { code?: string; status?: number }
export function errorOf(value: unknown): AppError {
  return value instanceof Error ? value : new Error(String(value));
}
