import { writeFileSync } from "node:fs";
import { snapshotWorkerCustodyForTest } from "./worker.js";

const snapshotPath = process.env.OPENCLAW_TEST_BROKER_SNAPSHOT;
if (!snapshotPath) throw new Error("Missing fixture snapshot path");
process.on("SIGUSR2", () => {
  writeFileSync(snapshotPath, JSON.stringify(snapshotWorkerCustodyForTest()));
});
