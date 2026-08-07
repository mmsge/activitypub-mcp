SERVER_IP = 157.180.66.111
SSH_KEY   = ~/.ssh/ap-mcp

PORT      = 3000

.PHONY: deploy build run stop restart logs status ssh verify

# Pull latest code, rebuild app image, restart.
#
# build-info runs BEFORE the build on purpose: it reads the checkout's git HEAD and
# the Dockerfile bakes the result into the image, so a `git pull` that is never
# followed by a rebuild leaves /version reporting the old sha — which is exactly the
# drift a checkout-based deploy badge cannot see. See naustet-server ADR 0022.
deploy:
	git pull --ff-only
	./scripts/generate-build-info.sh || echo "WARN: build info not regenerated — /version will report source=unknown"
	docker compose up -d --build app

build:
	./scripts/generate-build-info.sh || echo "WARN: build info not regenerated — /version will report source=unknown"
	docker compose build app

# Boot and check the box's ops contract against BOTH hosts this one container serves.
#
# Two apps sit behind a Host-header dispatcher on this single port (ADR 0018), so a
# check against one host proves nothing about the other — and the no-Host case is a
# third distinct path, because that is the one the container healthcheck itself takes.
#
# The wait loop is not padding. main() runs blocking startup syncs before serve()
# binds the port, which is why docker-compose.yml gives the probe start_period: 180s;
# a fixed `sleep` short enough to be tolerable is too short to be true.
verify:
	./scripts/generate-build-info.sh || echo "WARN: build info not regenerated — /version will report source=unknown"
	docker compose up -d --build app
	@printf 'waiting for the port to bind'
	@i=0; until curl -fsS -o /dev/null http://127.0.0.1:$(PORT)/healthz 2>/dev/null; do \
	   i=$$((i+1)); [ $$i -ge 90 ] && { echo " gave up after 180s"; exit 1; }; \
	   printf '.'; sleep 2; \
	 done; echo " up"
	@# Status alone is not enough: a catch-all that answers 200 with an HTML shell would
	@# pass it while the box's probe reads the endpoint as ABSENT. Assert the media type
	@# on the two JSON endpoints, and that the body really is the ops payload.
	@fail=0; \
	 for host in "" bot.skvip.lol meg.msge.no; do \
	   label=$${host:-'<no Host>'}; \
	   for path in /healthz /version /health; do \
	     if [ -z "$$host" ]; then hdr=""; else hdr="Host: $$host"; fi; \
	     code=$$(curl -sS -o /tmp/ops-body -D /tmp/ops-head -w '%{http_code}' \
	             $${hdr:+-H "$$hdr"} http://127.0.0.1:$(PORT)$$path); \
	     ok=1; \
	     case "$$code" in 200) ;; *) ok=0 ;; esac; \
	     grep -qi '^cache-control: *no-store' /tmp/ops-head || ok=0; \
	     if [ "$$path" != /healthz ]; then \
	       grep -qi '^content-type: *application/json' /tmp/ops-head || ok=0; \
	       grep -q '"service"' /tmp/ops-body || ok=0; \
	     fi; \
	     if [ $$ok -eq 1 ]; then echo "  OK      $$label $$path ($$code)"; \
	     else echo "  FAILED  $$label $$path ($$code)"; fail=1; fi; \
	   done; \
	 done; \
	 [ $$fail -eq 0 ] || exit 1
	@# The Compose probe byte-compares this, so check the BYTES, not just the status.
	@# `wc -c` is the part that matters: command substitution eats a trailing newline,
	@# so a string compare alone would pass on a three-byte "ok\n".
	@body=$$(curl -fsS http://127.0.0.1:$(PORT)/healthz); \
	 n=$$(curl -fsS http://127.0.0.1:$(PORT)/healthz | wc -c | tr -d ' '); \
	 if [ "$$body" = "ok" ] && [ "$$n" = "2" ]; then echo "  OK      /healthz body is exactly 'ok' (2 bytes)"; \
	 else echo "  FAILED  /healthz body is NOT exactly 'ok' ($$n bytes)"; exit 1; fi
	@rm -f /tmp/ops-body /tmp/ops-head

run:
	docker compose up -d app db

stop:
	docker compose down

restart:
	docker compose restart app

logs:
	docker compose logs -f app

status:
	docker compose ps

ssh:
	ssh -i $(SSH_KEY) root@$(SERVER_IP)

# ── Jump to a service (run on the server) ─────────────────────────────────────
.PHONY: msge markescence skjenelangs daggerheart hetzner

msge:
	cd /srv/msge && exec $$SHELL

markescence:
	cd /srv/markescence && exec $$SHELL

skjenelangs:
	cd /srv/skjenelangs && exec $$SHELL

daggerheart:
	cd /srv/rpg && exec $$SHELL

hetzner:
	cd /root/hetzner-server && exec $$SHELL
