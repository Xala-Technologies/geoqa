/** Turn an unknown thrown value into one line an operator can read. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() !== "" ? error.message : error.name;
  }
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}
