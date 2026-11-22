# Demo dashboard (not part of the app)

Start: `API_PORT=3100 docker compose -f docker-compose.yml -f demo-ui/compose.demo.yml up --build`, then open http://localhost:3200 (`DASHBOARD_PORT` changes it).
Shows every scan row (status, progress, lease owner and seconds left, fencing token, deliveries, runAfter, stop flag, error) with stop/resume buttons, the last 20 findings, and the logs of the api and each worker side by side, all refreshed every second.
The database volume is mounted read-only and opened read-only; starting, stopping and resuming go through the app's own API.
Logs come from the Docker Engine API over the mounted `/var/run/docker.sock` (read-only), filtered to this compose project.
Plain Node (`node:http`, `node:sqlite`), no packages: `server.mjs` serves `index.html`, `/state`, `/logs` and proxies `POST /scans…`.
