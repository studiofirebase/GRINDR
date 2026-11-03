import { sveltekit } from "@opengrind/config/eslint/svelte";
import { defineConfig } from "eslint/config";
import ts from "typescript-eslint";

import svelteConfig from "./svelte.config.js";

export default defineConfig(
	...sveltekit({
		svelteConfig,
		tailwindEntry: "src/layout.css",
		vendoredGlob: "src/lib/components/ui/**",
		ignores: [
			"src-tauri/",
			"reverse/",
			"docs/",
			"contrib/",
			"static/",
			"scripts/",
			"ci/",
			"e2e/updater/",
			"web-server/",
			"**/target/**",
		],
	}),
	{ files: ["src/service-worker.ts"], ...ts.configs.disableTypeChecked },
	{
		rules: {
			"@typescript-eslint/no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "phosphor-svelte",
							allowTypeImports: true,
							message:
								'Import each icon from "phosphor-svelte/lib/<Name>".',
						},
					],
				},
			],
		},
	},
);
