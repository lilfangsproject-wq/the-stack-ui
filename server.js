const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const ROOT_DIR = __dirname;

const BLOCKED_PREFIXES = [
  "/server.js",
  "/package.json",
  "/package-lock.json",
  "/node_modules",
  "/wrangler.toml",
  "/cf-ci-stub-worker.js",
  "/_headers",
];

app.use((req, res, next) => {
  const reqPath = req.path.toLowerCase();
  if (
    reqPath.startsWith("/.") ||
    BLOCKED_PREFIXES.some((prefix) => reqPath === prefix || reqPath.startsWith(prefix + "/"))
  ) {
    return res.status(404).send("Not Found");
  }
  next();
});

app.use(
  express.static(ROOT_DIR, {
    dotfiles: "ignore",
    index: "index.html",
  })
);

app.get("*", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`The Stack static server running at http://${HOST}:${PORT}`);
});
