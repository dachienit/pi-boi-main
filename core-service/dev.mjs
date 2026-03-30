import { spawn } from "child_process";
import "./local-proxy.mjs"; // starts the proxy!

// Ensure local traffic bypasses corporate proxies (Critical for SAP BAS)
process.env.NO_PROXY = "localhost,127.0.0.1," + (process.env.NO_PROXY || "");

console.log("Starting backend server...");
const server = spawn("npm", ["run", "build"], { stdio: "inherit", shell: true });
server.on("close", () => {
    spawn("node", ["dist/main.js", "--http", "../workspace"], { stdio: "inherit", shell: true });
});
