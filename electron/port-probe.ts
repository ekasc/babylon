import { connect } from "node:net";

/** TCP liveness probe for localhost dev servers. True when something accepts. */
export function probePort(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (open: boolean) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
      resolve(open);
    };
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.once("timeout", () => finish(false));
  });
}
