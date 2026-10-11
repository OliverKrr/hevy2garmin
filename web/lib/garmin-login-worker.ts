/**
 * The Garmin direct-login Worker client lives in garmin-auth (sso-worker):
 * Garmin blocks the login and token exchange from cloud IPs, so the web sends
 * the user's credentials to the Worker on Cloudflare's edge and stores the DI
 * tokens it returns. This module only picks the Worker URL for this deploy
 * (GARMIN_LOGIN_WORKER_URL, else the ecosystem's shared deploy) and keeps the
 * names the two login routes call.
 *
 * With H2G_DIRECT_GARMIN_LOGIN on, the same client runs the Worker's own code in this process
 * instead (garmin-auth/sso-local), so the email, password and code go only to Garmin, and no
 * Worker URL is used, GARMIN_LOGIN_WORKER_URL included (#685).
 */
import { createSsoWorkerClient, tokensFromResult, DEFAULT_SSO_WORKER_URL, type SsoFetch, type SsoWorkerClient, type WorkerLoginResult } from "garmin-auth/sso-worker";
import { createLocalSsoClient } from "garmin-auth/sso-local";
import { directGarminLogin } from "./direct-login-flag";

export { tokensFromResult };
export type { WorkerLoginResult, WorkerLoginStatus, GarminDiTokens } from "garmin-auth/sso-worker";
export type FetchImpl = SsoFetch;
export const DEFAULT_GARMIN_LOGIN_WORKER_URL = DEFAULT_SSO_WORKER_URL;

// One per process: its in-memory session store carries a pending MFA step from the password
// step to the code step.
let localClient: SsoWorkerClient | null = null;

/** The in-process sign-in client, for the login routes and the manual ticket exchange. */
export function localGarminLogin(): SsoWorkerClient {
  localClient ??= createLocalSsoClient();
  return localClient;
}

function client(fetchImpl?: FetchImpl) {
  if (directGarminLogin()) return localGarminLogin();
  return createSsoWorkerClient({ workerUrl: process.env.GARMIN_LOGIN_WORKER_URL, fetchImpl });
}

/** Step 1: submit email + password. */
export function workerLogin(email: string, password: string, fetchImpl?: FetchImpl): Promise<WorkerLoginResult> {
  return client(fetchImpl).login(email, password);
}

/** Step 2 (only when step 1 returned needs_mfa): submit the verification code. */
export function workerLoginMfa(sessionId: string, mfaCode: string, fetchImpl?: FetchImpl): Promise<WorkerLoginResult> {
  return client(fetchImpl).loginMfa(sessionId, mfaCode);
}
