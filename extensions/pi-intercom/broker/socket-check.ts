import net from "net";

/**
 * Check whether a broker is currently accepting connections on the given
 * socket path (Unix socket, or named pipe on Windows).
 *
 * Resolves true only if a connection is established within the timeout.
 */
export function checkSocketConnectable(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const finish = (isConnected: boolean) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      resolve(isConnected);
    };
    const onConnect = () => {
      socket.end();
      finish(true);
    };
    const onError = () => {
      socket.destroy();
      finish(false);
    };
    socket.on("connect", onConnect);
    socket.on("error", onError);
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, timeoutMs);
  });
}
