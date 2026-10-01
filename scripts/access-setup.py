"""Create the Cloudflare Access application that guards the Agent Room page.

Run once, by Kameron, on a machine that has CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
in the environment or in /etc/ai-company/cloudflare.env. Safe to run again: it reuses an
application with the same name. It prints names and ids, never the token. The last line is
the audience tag to put in wrangler.toml as ACCESS_AUD.

    python3 scripts/access-setup.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
HOST = "room.kamerongreen.dev"
APP_NAME = "Agent Room UI"
# /health and /p/* stay outside Access. The worker checks the Access header itself as well.
PATHS = ["/ui", "/ui/*", "/h/*"]
# The allow policy to reuse: the one named "me" on the application with this name.
POLICY_FROM_APP = "Mind Window"
ENV_FILE = "/etc/ai-company/cloudflare.env"


def load_settings() -> tuple[str, str]:
    values = {k: os.environ[k] for k in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID") if os.environ.get(k)}
    if len(values) < 2 and os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    values.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    try:
        return values["CLOUDFLARE_API_TOKEN"], values["CLOUDFLARE_ACCOUNT_ID"]
    except KeyError as missing:
        sys.exit(f"access-setup: {missing} is not set in the environment or in {ENV_FILE}")


def call(token: str, method: str, path: str, body: dict | None = None) -> object:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 - fixed https API host
            res = json.loads(r.read())
    except urllib.error.HTTPError as e:
        res = json.loads(e.read() or b"{}")
        res["success"] = False
    except (urllib.error.URLError, TimeoutError) as e:
        sys.exit(f"access-setup: {method} {path} could not reach Cloudflare: {type(e).__name__}")
    if not res.get("success"):
        messages = [x.get("message") for x in res.get("errors") or []]
        sys.exit(f"access-setup: {method} {path} failed: {messages}")
    return res["result"]


def list_all(token: str, path: str) -> list:
    """Every item of a paginated list endpoint, 50 at a time."""
    items: list = []
    page = 1
    while True:
        batch = call(token, "GET", f"{path}?page={page}&per_page=50")
        assert isinstance(batch, list)
        items.extend(batch)
        if len(batch) < 50:
            return items
        page += 1


def main() -> None:
    token, account = load_settings()
    apps = list_all(token, f"/accounts/{account}/access/apps")

    app = next((a for a in apps if a["name"] == APP_NAME), None)
    if app is None:
        source = next((a for a in apps if a["name"] == POLICY_FROM_APP), None)
        if source is None:
            sys.exit(f"access-setup: no Access application named {POLICY_FROM_APP!r} to copy the allow policy from")
        detail = call(token, "GET", f"/accounts/{account}/access/apps/{source['id']}")
        assert isinstance(detail, dict)
        policies = detail.get("policies", [])
        allow = next((p for p in policies if p.get("decision") == "allow" and p.get("name") == "me"), None)
        if allow is None:
            found = ", ".join(f"{p.get('name')!r} ({p.get('decision')})" for p in policies) or "none"
            sys.exit(f"access-setup: {POLICY_FROM_APP!r} has no allow policy named 'me'; policies found: {found}")
        print("reusing allow policy", allow["name"], allow["id"])
        app = call(token, "POST", f"/accounts/{account}/access/apps", {
            "name": APP_NAME,
            "type": "self_hosted",
            "domain": HOST + PATHS[0],
            "destinations": [{"type": "public", "uri": HOST + p} for p in PATHS],
            "session_duration": "24h",
            "policies": [{"id": allow["id"], "precedence": 1}],
        })
        assert isinstance(app, dict)
        print("created Access application", app["name"], app["id"])
    else:
        print("reused Access application", app["name"], app["id"])

    print("paths:", ", ".join(d.get("uri", "") for d in app.get("destinations") or []))
    print(f"ACCESS_AUD={app['aud']}")


if __name__ == "__main__":
    main()
