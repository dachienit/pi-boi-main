import { spawn } from "child_process";
import "./local-proxy.mjs"; // starts the proxy!

console.log("Starting backend server...");
const server = spawn("npm", ["run", "build"], { stdio: "inherit", shell: true });
server.on("close", () => {
    spawn("node", ["dist/main.js", "--http", "../workspace"], { stdio: "inherit", shell: true });
});
