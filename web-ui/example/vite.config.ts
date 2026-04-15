import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
	plugins: [
		tailwindcss(),
		nodePolyfills({
			include: ["stream", "buffer", "crypto", "http", "https", "os", "path", "process", "util"],
			globals: {
				Buffer: true,
				global: true,
				process: true,
			},
		}),
	],
	resolve: {
		dedupe: ["@mariozechner/mini-lit", "lit"],
	},
	build: {
		commonjsOptions: {
			transformMixedEsModules: true,
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
