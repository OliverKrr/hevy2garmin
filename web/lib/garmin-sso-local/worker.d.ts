/** The vendored Worker's fetch handler and the one binding it reads. */
export interface LocalWorkerKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
declare const worker: {
  fetch(request: Request, env: { MFA_SESSIONS?: LocalWorkerKv }): Promise<Response>;
};
export default worker;
