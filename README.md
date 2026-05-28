# grafana-ruler-proxy

Brings the Grafana alert rule editor UI to plain **Prometheus** — no Mimir required.

Grafana’s rule editing UI is only enabled when the datasource advertises Mimir’s Ruler API. This proxy sits between Grafana and Prometheus, intercepts the ruler endpoints to read/write a local rules YAML file, fires a Prometheus reload on every change, and transparently proxies everything else.

Rewrite of [lhns/grafana-ruler-proxy](https://github.com/lhns/grafana-ruler-proxy) in Node.js.

-----

## How it works

```
Grafana  ──►  grafana-ruler-proxy  ──►  Prometheus  (all metric queries)
                      │
                      ▼
                 rules.yml  (CRUD on rule groups)
                      │
                      ▼
              POST /-/reload  (on every write)
```

1. **`/api/v1/status/buildinfo`** — response is patched to set `ruler_config_api: true`, which is the flag Grafana checks before showing the rule editor
1. **`/config/v1/rules/...`** — ruler CRUD is handled locally; each group is upserted into a single YAML file by name
1. **Everything else** — proxied straight to Prometheus unchanged

## Improvements over the original

|              |Original (Scala)            |This version (Node.js)                        |
|--------------|----------------------------|----------------------------------------------|
|Runtime       |JVM                         |Node.js                                       |
|Dependencies  |~20 (cats, http4s, circe, …)|2 (`yaml`, `http-proxy-middleware`)           |
|Config        |JSON blob in env var        |Individual env vars                           |
|Reload trigger|Every write + every 5 min   |Every write only                              |
|Alertmanager  |Supported                   |Omitted (no practical benefit for most setups)|
|Image size    |~300 MB                     |~80 MB                                        |
|Lines of code |~730                        |~200                                          |

## Requirements

- Node.js 18+
- Prometheus must have `--web.enable-lifecycle` flag set (enables `/-/reload`)

## Setup

```bash
npm install
```

## Configuration

|Env var          |Required|Default     |Description                                 |
|-----------------|--------|------------|--------------------------------------------|
|`PROMETHEUS_URL` |✅       |—           |Prometheus base URL                         |
|`RULES_FILE`     |✅       |—           |Path to rules YAML file (created if missing)|
|`RULES_NAMESPACE`|        |`prometheus`|Namespace shown in Grafana                  |
|`PORT`           |        |`8080`      |Port to listen on                           |

## Running

```bash
PROMETHEUS_URL=http://prometheus:9090 \
RULES_FILE=/etc/prometheus/rules.yml \
RULES_NAMESPACE=prometheus \
node grafana-ruler-proxy.js
```

## Grafana datasource setup

Point your Prometheus datasource URL at the proxy instead of Prometheus directly:

```
http://grafana-ruler-proxy:8080
```

Everything else (dashboards, queries, alerts) works as before. The rule editor will now appear under **Alerting → Alert rules**.

## Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY grafana-ruler-proxy.js .
EXPOSE 8080
CMD ["node", "grafana-ruler-proxy.js"]
```

```bash
docker run \
  -e PROMETHEUS_URL=http://prometheus:9090 \
  -e RULES_FILE=/rules/rules.yml \
  -v ./rules:/rules \
  -p 8080:8080 \
  grafana-ruler-proxy
```

## Docker Compose example

```yaml
services:
  grafana-ruler-proxy:
    build: .
    environment:
      PROMETHEUS_URL: http://prometheus:9090
      RULES_FILE: /rules/rules.yml
      RULES_NAMESPACE: prometheus
    volumes:
      - ./rules:/rules          # shared with prometheus rules_files
    ports:
      - "8080:8080"

  prometheus:
    image: prom/prometheus
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --web.enable-lifecycle     # required for /-/reload
    volumes:
      - ./rules:/rules
```

Point Grafana at `http://grafana-ruler-proxy:8080` as the Prometheus datasource URL.

## Rules file format

Standard Prometheus rules YAML — no custom format:

```yaml
groups:
  - name: example
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: High error rate detected
```

Grafana manages groups by name. Groups edited outside Grafana are preserved as long as their names don’t collide.

## License

Apache 2.0
