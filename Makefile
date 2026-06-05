SERVER_IP = 157.180.66.111
SSH_KEY   = ~/.ssh/ap-mcp

.PHONY: deploy build run stop restart logs status ssh

# Pull latest code, rebuild app image, restart.
# Note: `up -d --build` (no service arg) so the db service also picks up the
# pgvector image when it changes — `... app` alone would leave the old db
# container running and the `CREATE EXTENSION vector` migration would fail.
deploy:
	git pull --ff-only
	docker compose up -d --build

build:
	docker compose build app

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
	cd /var/www/msge-no && exec $$SHELL

markescence:
	cd /var/www/markescence && exec $$SHELL

skjenelangs:
	cd /var/www/skjenelangs.no && exec $$SHELL

daggerheart:
	cd /var/www/daggerheart-app/river-sky && exec $$SHELL

hetzner:
	cd /root/hetzner-server && exec $$SHELL
