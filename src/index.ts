/**
 * Entry Desktop Sidecar Entrypoint (`entry-agent-sidecar.exe`)
 * Can be spawned by `entry-desktop.exe` or invoked directly via CLI.
 */
import { startSidecarServer } from "./server/server";

if (import.meta.main) {
  const portArgIndex = process.argv.indexOf("--port");
  const port =
    portArgIndex !== -1 && process.argv[portArgIndex + 1]
      ? Number(process.argv[portArgIndex + 1])
      : Number(process.env.ENTRY_SIDECAR_PORT ?? 4096);

  const srv = startSidecarServer({ port });
  console.log(
    JSON.stringify({
      event: "entry-sidecar-ready",
      url: srv.url,
      port: srv.port,
      dbPath: srv.db.dbPath,
    }),
  );

  process.on("SIGINT", () => {
    srv.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    srv.stop();
    process.exit(0);
  });
}

export { startSidecarServer, type RunningSidecarServer } from "./server/server";
