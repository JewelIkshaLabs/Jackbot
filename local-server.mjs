import http from "http";
import dotenv from "dotenv";
import { handler } from "./lambda.mjs";

// Load environment variables from .env file
dotenv.config();

const server = http.createServer(async (req, res) => {
  let body = "";

  req.on("data", chunk => (body += chunk));
  req.on("end", async () => {
    const response = await handler({
      body,
    });

    res.writeHead(response.statusCode || 200, {
      "Content-Type": "application/json",
      ...(response.headers || {})
    });

    res.end(response.body || "");
  });
});

server.listen(3000, () => {
  console.log("Local server running on http://localhost:3000");
});
