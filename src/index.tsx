import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>homekeeper</title>
      </head>
      <body>
        <h1>homekeeper</h1>
        <p>Hello! The skeleton is up.</p>
      </body>
    </html>,
  ),
);

export default app;
