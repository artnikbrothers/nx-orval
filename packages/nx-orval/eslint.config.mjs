import baseConfig from "../../eslint.config.mjs";

export default [
    ...baseConfig,
    {
        files: [
            "**/*.json"
        ],
        rules: {
            "@nx/dependency-checks": [
                "error",
                {
                    ignoredFiles: [
                        "{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}"
                    ],
                    // nx and orval are host-workspace peers resolved at runtime
                    ignoredDependencies: ["nx", "orval"],
                    // @nx/devkit is pinned to the oldest major that peers the whole supported Nx range,
                    // while the workspace itself develops against a newer one
                    checkVersionMismatches: false
                }
            ]
        },
        languageOptions: {
            parser: await import("jsonc-eslint-parser")
        }
    },
    {
        files: [
      "**/package.json",
      "**/generators.json",
      "**/executors.json"
    ],
        rules: {
            "@nx/nx-plugin-checks": "error"
        },
        languageOptions: {
      "parser": (await import('jsonc-eslint-parser'))
    }
    }
];
