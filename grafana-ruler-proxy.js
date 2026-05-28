#!/usr/bin/env node
// grafana-ruler-proxy — Node.js rewrite
//
// ENV VARS:
//   PORT               (default: 8080)
//   PROMETHEUS_URL     e.g. http://prometheus:9090   (required)
//   RULES_FILE         path to rules YAML file       (required)
//   RULES_NAMESPACE    namespace shown in Grafana     (default: "prometheus")
//
// npm install http-proxy-middleware yaml

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { createProxyMiddleware } = require("http-proxy-middleware");
const YAML = require("yaml");

// ── Config ────────────────────────────────────────────────────────────────────

const PORT           = parseInt(process.env.PORT || "8080", 10);
const PROMETHEUS_URL = process.env.PROMETHEUS_URL;
const RULES_FILE     = process.env.RULES_FILE;
const NAMESPACE      = process.env.RULES_NAMESPACE || "prometheus";

if (!PROMETHEUS_URL) throw new Error("PROMETHEUS_URL is required");
if (!RULES_FILE)     throw new Error("RULES_FILE is required");

// ── YAML file helpers ─────────────────────────────────────────────────────────

function readGroups() {
  if (!fs.existsSync(RULES_FILE)) return [];
  const raw = fs.readFileSync(RULES_FILE, "utf8");
  const doc = YAML.parse(raw) || {};
  return doc.groups || [];
}

function writeGroups(groups) {
  const dir = path.dirname(RULES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(RULES_FILE, YAML.stringify({ groups }), "utf8");
}

// ── Prometheus reload ─────────────────────────────────────────────────────────

function reloadPrometheus() {
  const url = new URL("/-/reload", PROMETHEUS_URL);
  const lib = url.protocol === "https:" ? https : http;
  const req = lib.request(url, { method: "POST" }, (res) => {
    console.log(`[reload] Prometheus responded ${res.statusCode}`);
  });
  req.on("error", (e) => console.error("[reload] failed:", e.message));
  req.end();
}

// ── Request body helper ───────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, contentType = "application/json") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": contentType });
  res.end(payload);
}

// ── Ruler API handlers ────────────────────────────────────────────────────────

// GET /config/v1/rules
// → { <namespace>: [<group>, ...] }  as YAML
function handleListNamespaces(req, res) {
  const groups = readGroups();
  send(res, 200, YAML.stringify({ [NAMESPACE]: groups }), "text/yaml");
}

// GET /config/v1/rules/:namespace
// → [<group>, ...]  as YAML
function handleListGroups(req, res, namespace) {
  if (namespace !== NAMESPACE) return send(res, 200, YAML.stringify([]), "text/yaml");
  send(res, 200, YAML.stringify(readGroups()), "text/yaml");
}

// GET /config/v1/rules/:namespace/:groupName
// → <group>  as YAML
function handleGetGroup(req, res, namespace, groupName) {
  const groups = readGroups();
  const group = groups.find((g) => g.name === groupName)
    || { name: groupName, rules: [] };
  send(res, 200, YAML.stringify(group), "text/yaml");
}

// POST /config/v1/rules/:namespace
async function handleSetGroup(req, res, namespace) {
  if (namespace !== NAMESPACE) return send(res, 202, {});
  const body = await readBody(req);
  const incoming = YAML.parse(body);
  if (!incoming?.name) return send(res, 400, { error: "missing group name" });

  const groups = readGroups();
  const idx = groups.findIndex((g) => g.name === incoming.name);
  if (idx >= 0) groups[idx] = incoming;
  else groups.push(incoming);
  writeGroups(groups);

  reloadPrometheus();
  send(res, 202, {});
}

// DELETE /config/v1/rules/:namespace/:groupName
function handleDeleteGroup(req, res, namespace, groupName) {
  if (namespace === NAMESPACE) {
    writeGroups(readGroups().filter((g) => g.name !== groupName));
    reloadPrometheus();
  }
  send(res, 202, {});
}

// DELETE /config/v1/rules/:namespace
function handleDeleteNamespace(req, res, namespace) {
  if (namespace === NAMESPACE) {
    writeGroups([]);
    reloadPrometheus();
  }
  send(res, 202, {});
}

// ── buildinfo patch — tells Grafana ruler UI is available ─────────────────────

const proxy = createProxyMiddleware({
  target: PROMETHEUS_URL,
  changeOrigin: true,
  selfHandleResponse: false,
  on: {
    proxyRes(proxyRes, req, res) {
      if (req.url !== "/api/v1/status/buildinfo") return; // handled below
    },
  },
});

// We need a custom intercept just for buildinfo, rest is plain proxy
async function patchBuildinfo(req, res) {
  const url = new URL("/api/v1/status/buildinfo", PROMETHEUS_URL);
  const lib = url.protocol === "https:" ? https : http;
  lib.get(url, (upstream) => {
    let raw = "";
    upstream.on("data", (c) => (raw += c));
    upstream.on("end", () => {
      let json = {};
      try { json = JSON.parse(raw); } catch (_) { json = { status: "success" }; }
      json.data = json.data || {};
      json.data.features = json.data.features || {};
      json.data.features.ruler_config_api = "true";
      json.data.features.alertmanager_config_api = "false";
      send(res, 200, json);
    });
  }).on("error", () => {
    send(res, 200, {
      status: "success",
      data: { features: { ruler_config_api: "true", alertmanager_config_api: "false" } },
    });
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

const RULER_RE = /^\/config\/v1\/rules(\/([^/]*)(?:\/([^/]*))?)?$/;

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // buildinfo — patch response to advertise ruler support
  if (method === "GET" && url === "/api/v1/status/buildinfo") {
    return patchBuildinfo(req, res);
  }

  // ruler API
  const m = url.match(RULER_RE);
  if (m) {
    const namespace = m[2];
    const groupName = m[3];
    try {
      if (method === "GET" && !namespace)              return handleListNamespaces(req, res);
      if (method === "GET" && namespace && !groupName) return handleListGroups(req, res, namespace);
      if (method === "GET" && namespace && groupName)  return handleGetGroup(req, res, namespace, groupName);
      if (method === "POST" && namespace && !groupName) return await handleSetGroup(req, res, namespace);
      if (method === "DELETE" && namespace && groupName) return handleDeleteGroup(req, res, namespace, groupName);
      if (method === "DELETE" && namespace && !groupName) return handleDeleteNamespace(req, res, namespace);
    } catch (err) {
      console.error("[ruler]", err);
      return send(res, 500, { error: err.message });
    }
  }

  // everything else → proxy straight to Prometheus
  proxy(req, res, (err) => {
    if (err) {
      console.error("[proxy]", err.message);
      send(res, 502, { error: "upstream error" });
    }
  });
});

server.listen(PORT, () => {
  console.log(`grafana-ruler-proxy listening on :${PORT}`);
  console.log(`  → Prometheus:  ${PROMETHEUS_URL}`);
  console.log(`  → Rules file:  ${RULES_FILE}`);
  console.log(`  → Namespace:   ${NAMESPACE}`);
});
