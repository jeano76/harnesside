import { access, constants, stat } from "node:fs/promises";

/** True when `path` exists and is executable by this user.
 *
 *  On Windows there is no exec bit: `X_OK` is meaningless and `.exe`
 *  checks must be existence checks. A `llama-server.exe` that exists
 *  is runnable; a missing one is not. */
export async function executableExists(path: string): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      const st = await stat(path);
      return st.isFile();
    } catch {
      return false;
    }
  }
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
