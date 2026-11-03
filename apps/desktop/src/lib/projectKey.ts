/** A project folder as the sidebar keys it: trimmed, without a trailing slash. */
export const projectKey = (path: string) => path.trim().replace(/[\\/]+$/, "") || path;
