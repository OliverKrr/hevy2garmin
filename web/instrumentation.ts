/**
 * Next.js runs register() once when the server starts. Fork: installs the
 * Worker ban while H2G_DIRECT_GARMIN_LOGIN is on (lib/worker-block.ts).
 */
export async function register() {
  const { installWorkerBlock } = await import("./lib/worker-block");
  if (installWorkerBlock()) {
    console.log(`[h2g] worker block active (${process.env.NEXT_RUNTIME ?? "nodejs"}): no request to *.workers.dev leaves this server`);
  }
}
