export function containedWorkspacePath(path: string): string {
  if (
    !path.startsWith("/workspace/") ||
    path.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("Harness input must be a contained workspace path");
  }
  return path;
}
