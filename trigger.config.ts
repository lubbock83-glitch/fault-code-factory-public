import { defineConfig } from "@trigger.dev/sdk";

const projectRef = process.env.TRIGGER_PROJECT_REF;
if (!projectRef) {
  throw new Error(
    "TRIGGER_PROJECT_REF is not set. Copy .env.example to .env and fill it in.",
  );
}

export default defineConfig({
  project: projectRef,
  runtime: "node",
  logLevel: "log",
  // A research-and-generate pass over hundreds of codes is long-running.
  maxDuration: 3600,
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      factor: 2,
      randomize: true,
    },
  },
});
