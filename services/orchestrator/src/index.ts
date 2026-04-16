import { SupermanApp } from "./app.js";
import { createHttpServer } from "./server.js";

const port = Number(process.env.SUPERMAN_ORCHESTRATOR_PORT ?? 4317);

const app = new SupermanApp();
await app.start();

const server = createHttpServer(app, port);
await server.listen();

process.on("SIGINT", async () => {
  await app.shutdown();
  await server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await app.shutdown();
  await server.close();
  process.exit(0);
});
