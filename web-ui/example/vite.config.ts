import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

function stubNodeModules(): Plugin {
	const nodeModules = [
		"stream",
		"http",
		"https",
		"crypto",
		"os",
		"path",
		"fs",
		"net",
		"tls",
		"zlib",
		"events",
		"buffer",
		"util",
		"url",
		"querystring",
		"child_process",
		"worker_threads",
		"assert",
		"dns",
		"http2",
		"tty",
		"dgram",
		"readline",
	];

	const stubCode = `
		export default {};
		export const Readable = class {};
		export const Writable = class {};
		export const Stream = class {};
		export const Agent = class {};
		export const request = () => {};
		export const get = () => {};
		export const createServer = () => {};
		export const Server = class {};
		export const connect = () => {};
	`;

	return {
		name: "stub-node-modules",
		enforce: "pre",
		resolveId(id) {
			if (nodeModules.includes(id) || id.startsWith("node:")) {
				return `\0stub:${id}`;
			}
			if (id.includes("@smithy/node-http-handler") || 
				id.includes("@aws-sdk/credential-provider")) {
				return `\0stub:${id}`;
			}
			return null;
		},
		load(id) {
			if (id.startsWith("\0stub:")) {
				return stubCode;
			}
			return null;
		},
	};
}

export default defineConfig({
	plugins: [stubNodeModules(), tailwindcss()],
	resolve: {
		dedupe: ["@mariozechner/mini-lit", "lit"],
	},
	build: {
		rollupOptions: {
			onwarn(warning, warn) {
				if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
				warn(warning);
			},
		},
	},
	server: {
		proxy: {
			"/chat": "http://localhost:3030",
			"/stop": "http://localhost:3030",
			"/status": "http://localhost:3030",
			"/sessions": "http://localhost:3030",
			"/messages": "http://localhost:3030",
			"/file": "http://localhost:3030",
			"/artifact-url": "http://localhost:3030",
			"/artifacts": "http://localhost:3030",
		},
	},
});
