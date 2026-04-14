import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	resolve: {
		dedupe: ["@mariozechner/mini-lit", "lit"],
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
