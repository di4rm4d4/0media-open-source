/** Stop one caller's wait without cancelling work shared by other callers. */
export function waitForAbort<T>(pending: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    void pending.then(value => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) {
        discard?.(value);
        reject(signal.reason);
      } else resolve(value);
    }, error => {
      signal.removeEventListener("abort", stop);
      reject(signal.aborted ? signal.reason : error);
    });
    if (signal.aborted) stop();
  });
}
