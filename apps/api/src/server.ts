import { app } from "./app.js";
import { startAnalyticsRollup } from "./analytics/rollup.js";
import { startJobWorker } from "./lib/jobs/queue.js";

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`infralift api listening on :${port}`);
  startAnalyticsRollup();
  void startJobWorker().catch((err) => console.error("job worker failed to start:", err));
});
