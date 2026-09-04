/**
 * Talking to the HUD.
 *
 * The HUD is a separate process holding a floating panel. Anything that can
 * write Bob Lines to a Unix socket can draw on your screen: this module, a shell
 * pipeline, or an agent that never imported this package.
 *
 * That is the point of using the wire format for this rather than inventing an
 * RPC. The stream a model produces goes straight to the screen with nothing in
 * between translating it, so the panel assembles at exactly the rate the model
 * writes and there is no buffering step where the whole thing waits.
 */

import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export function hudSocketPath(): string {
  return process.env["BOB_HUD_SOCKET"] ?? join(homedir(), ".bob", "hud.sock");
}

export class HudUnavailableError extends Error {
  constructor(readonly path: string) {
    super(
      `The HUD is not running, so there is nowhere to draw.\n` +
        `Start it with: open -a BobHUD    (or: bob hud --install)\n` +
        `Socket: ${path}`,
    );
    this.name = "HudUnavailableError";
  }
}

/**
 * An open connection to the panel.
 *
 * Closing it is what tells the HUD the surface is finished, so a caller that
 * streams must close rather than leaving the socket open: the panel keeps
 * showing a half-built interface otherwise.
 */
export class HudConnection {
  private constructor(private readonly socket: Socket) {}

  static async open(path = hudSocketPath()): Promise<HudConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      socket.once("connect", () => resolve(new HudConnection(socket)));
      socket.once("error", (err: NodeJS.ErrnoException) => {
        // ENOENT means nothing is listening; anything else is a real problem
        // worth reporting as itself.
        reject(
          err.code === "ENOENT" || err.code === "ECONNREFUSED"
            ? new HudUnavailableError(path)
            : err,
        );
      });
    });
  }

  /** Write a chunk of Bob Lines. Partial lines are fine: the HUD buffers them. */
  write(chunk: string): void {
    this.socket.write(chunk);
  }

  /** Stream everything from an async iterable, then close. */
  async pipe(source: AsyncIterable<string>): Promise<void> {
    try {
      for await (const chunk of source) this.write(chunk);
    } finally {
      this.close();
    }
  }

  close(): void {
    this.socket.end();
  }
}

/** True if a HUD is listening. Cheap enough to check before offering to draw. */
export async function hudIsRunning(path = hudSocketPath()): Promise<boolean> {
  try {
    const connection = await HudConnection.open(path);
    connection.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a complete surface and close.
 *
 * For a caller that already has the whole thing. Streaming is better when the
 * source is a model, because the panel then fills in as the model writes rather
 * than appearing all at once at the end.
 */
export async function showOnHud(lines: string, path = hudSocketPath()): Promise<void> {
  const connection = await HudConnection.open(path);
  connection.write(lines.endsWith("\n") ? lines : lines + "\n");
  connection.close();
}
