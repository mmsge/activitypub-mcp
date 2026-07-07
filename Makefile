SERVER_IP = 157.180.66.111
SSH_KEY   = ~/.ssh/ap-mcp

.PHONY: deploy build run stop restart logs status ssh

# Pull latest code, rebuild app image, restart
deploy:
	git pull --ff-only
	docker compose up -d --build app

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
	cd /srv/msge && exec $$SHELL

markescence:
	cd /srv/markescence && exec $$SHELL

skjenelangs:
	cd /srv/skjenelangs && exec $$SHELL

daggerheart:
	cd /srv/rpg && exec $$SHELL

hetzner:
	cd /root/hetzner-server && exec $$SHELL
