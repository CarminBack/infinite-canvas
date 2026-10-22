/** Same-origin application path, including a configured deployment subdirectory. */
export const appPath = (path: string) => `${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`;
